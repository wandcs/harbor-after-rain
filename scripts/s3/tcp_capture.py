"""Bounded outgoing TCP-header observations in the disposable test netns.

A sender tap does not prove receipt. Receiver-generated ACK/SACK establishes
progress independently; no captured application payload is retained.
"""
import json
import os
import socket
import struct
import threading
import time


def parse_header(data, packet_bytes, allow_loopback_gso=False):
    """Decode metadata only. MSG_TRUNC supplies full SKB size without its body."""
    if len(data) < 54 or data[12:14] != b'\x08\x00' or data[23] != 6:
        return None
    ip = 14
    ihl = (data[ip] & 15) * 4
    tcp = ip + ihl
    sport, dport, seq, ack = struct.unpack_from('!HHII', data, tcp)
    if 45931 not in (sport, dport):
        return None
    if struct.unpack_from('!H', data, ip + 6)[0] & 0x3fff:
        raise ValueError('Unexpected fragmented TCP packet')
    thl = (data[tcp + 12] >> 4) * 4
    if ihl < 20 or thl < 20 or tcp + thl > len(data):
        raise ValueError('TCP options truncated')
    ip_total = struct.unpack_from('!H', data, ip + 2)[0]
    if ip_total == 0:
        if not allow_loopback_gso or packet_bytes - ip <= 65535:
            raise ValueError('Unverified zero-length IP/GSO observation')
        ip_size = packet_bytes - ip
    else:
        ip_size = ip_total
        if ip_size > packet_bytes - ip or (allow_loopback_gso and packet_bytes - ip > 65535):
            raise ValueError('IP and SKB sizes disagree')
    if ip_size < ihl + thl:
        raise ValueError('Invalid TCP payload size')
    sacks = []
    pos = tcp + 20
    while pos < tcp + thl:
        kind = data[pos]
        if kind == 0:
            break
        if kind == 1:
            pos += 1
            continue
        length = data[pos + 1]
        if length < 2 or pos + length > tcp + thl:
            raise ValueError('Malformed TCP option')
        if kind == 5:
            if (length - 2) % 8:
                raise ValueError('Malformed SACK blocks')
            for start in range(pos + 2, pos + length, 8):
                sacks.append(list(struct.unpack_from('!II', data, start)))
        pos += length
    return {'sport': sport, 'dport': dport, 'seq': seq, 'ack': ack,
            'flags': data[tcp + 13], 'bytes': ip_size - ihl - thl, 'sacks': sacks,
            'skbBytes': packet_bytes, 'ipTotalBytes': ip_total,
            'zeroLengthGso': ip_total == 0}


class TcpCapture:
    def __init__(self, allow_loopback_gso=False):
        assert os.readlink('/proc/self/ns/net') != os.readlink('/proc/1/ns/net')
        self.socket = socket.socket(socket.AF_PACKET, socket.SOCK_RAW, socket.htons(0x0003))
        self.socket.bind(('lo', 0))
        # Linux x86_64 SO_TIMESTAMPNS; timeval consists of two native longs.
        self.socket.setsockopt(socket.SOL_SOCKET, 35, 1)
        self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 4 * 1024 * 1024)
        self.socket.settimeout(.05)
        self.rows = []
        self.errors = []
        self.allow_loopback_gso = allow_loopback_gso
        self.clocks = []
        self.calibrate()
        self.stop_event = threading.Event()
        self.thread = threading.Thread(target=self.receive, daemon=True)
        self.thread.start()

    def calibrate(self):
        before = time.monotonic_ns()
        realtime = time.time_ns()
        after = time.monotonic_ns()
        self.clocks.append({'monotonicNs': (before + after) // 2,
                            'offsetNs': (before + after) // 2 - realtime,
                            'uncertaintyNs': (after - before) // 2})

    def receive(self):
        header = bytearray(128)
        try:
            while not self.stop_event.is_set():
                try:
                    length, controls, _, address = self.socket.recvmsg_into(
                        [header], socket.CMSG_SPACE(16), socket.MSG_TRUNC)
                except socket.timeout:
                    continue
                if address[2] != socket.PACKET_OUTGOING:
                    continue
                row = parse_header(memoryview(header)[:min(length, len(header))], length,
                                   self.allow_loopback_gso)
                if row is None:
                    continue
                stamp = None
                for level, kind, value in controls:
                    if level == socket.SOL_SOCKET and kind == 35:
                        seconds, nanos = struct.unpack('@ll', value)
                        stamp = seconds * 1000000000 + nanos
                if stamp is None:
                    raise ValueError('Missing kernel nanosecond timestamp')
                if len(self.rows) >= 20000:
                    raise ValueError('TCP observation bound exceeded')
                self.rows.append({
                    'monotonicMs': (stamp + self.clocks[0]['offsetNs']) / 1000000,
                    **row,
                })
        except BaseException as error:
            self.errors.append(repr(error))

    def finish(self, path):
        self.stop_event.set()
        self.thread.join(timeout=1)
        assert not self.thread.is_alive(), 'Capture thread did not stop'
        self.calibrate()
        packets, drops = struct.unpack('II', self.socket.getsockopt(263, 6, 8))
        buffer_bytes = self.socket.getsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF)
        self.socket.close()
        drift = max(c['offsetNs'] for c in self.clocks) - min(c['offsetNs'] for c in self.clocks)
        result = {'interface': 'lo', 'port': 45931, 'tap': 'PACKET_OUTGOING only',
                  'units': 'SKB byte-sequence spans; offload aggregates are not Internet packets',
                  'allowLoopbackGso': self.allow_loopback_gso,
                  'payloadRetained': False, 'clockConversions': self.clocks,
                  'clockOffsetDriftMs': drift / 1000000, 'packetSocketPackets': packets,
                  'packetSocketDrops': drops, 'receiveBufferBytes': buffer_bytes,
                  'errors': self.errors, 'packets': self.rows}
        path.write_text(json.dumps(result, indent=2))
        assert not self.errors, self.errors
        assert drops == 0, 'Capture dropped packets; attribution is incomplete'
        assert drift <= 1000000, 'Realtime/monotonic conversion changed by over 1 ms'
        return {'packets': len(self.rows), 'drops': drops, 'clockOffsetDriftMs': drift / 1000000}
