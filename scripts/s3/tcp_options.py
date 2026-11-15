"""Single-socket test tuning via already-duplicated descriptors, never sysctl."""
import argparse
import gzip
import json
import os
from pathlib import Path
import re
import socket

parser = argparse.ArgumentParser()
parser.add_argument('mode', choices=['baseline', 'server-rto100', 'client-ack10'])
args = parser.parse_args()
assert os.geteuid() != 0, 'Application-side socket fixture must not run as root'
namespace = os.readlink('/proc/self/ns/net')
expected_namespace = os.environ.get('HARBOR_S3_TEST_NETNS')
host_namespace = os.environ.get('HARBOR_S3_HOST_NETNS')
assert expected_namespace and host_namespace and namespace == expected_namespace and namespace != host_namespace, 'Unverified test namespace'

# Linux 6.18 UAPI. Unsupported setters/readback fail explicitly.
options = {'rtoMinUs': 45, 'delackMaxUs': 46, 'rtoMaxMs': 44}
roles = ['impairedServer', 'healthyServer', 'impairedClient', 'healthyClient']
sockets = {name: socket.socket(fileno=fd) for name, fd in zip(roles, range(3, 7))}


def read():
    return {name: {key: s.getsockopt(socket.IPPROTO_TCP, opt) for key, opt in options.items()}
            for name, s in sockets.items()}


def defaults():
    return {name: Path('/proc/sys/net/ipv4', name).read_text().strip()
            for name in ['tcp_rto_min_us', 'tcp_rto_max_ms', 'tcp_recovery', 'tcp_early_retrans']}


try:
    endpoints = {name: {'local': s.getsockname(), 'peer': s.getpeername()}
                 for name, s in sockets.items()}
    assert endpoints['impairedServer']['peer'][1] == 45931
    assert endpoints['healthyServer']['peer'][1] == 45932
    assert endpoints['impairedClient']['local'][1] == 45931
    assert endpoints['healthyClient']['local'][1] == 45932
    assert endpoints['impairedServer']['local'] == endpoints['impairedClient']['peer']
    assert endpoints['healthyServer']['local'] == endpoints['healthyClient']['peer']
    before = read()
    system_before = defaults()
    requested = None
    if args.mode == 'server-rto100':
        requested = {'role': 'impairedServer', 'option': 'rtoMinUs', 'value': 100000}
    elif args.mode == 'client-ack10':
        requested = {'role': 'impairedClient', 'option': 'delackMaxUs', 'value': 10000}
    kernel_timer_hz = None
    effective_expected = requested['value'] if requested else None
    if args.mode == 'client-ack10':
        # Linux stores this option in jiffies. HZ=250 rounds 10ms up to 12ms.
        # Derive the exact readback from kernel config, not from the result.
        config = gzip.decompress(Path('/proc/config.gz').read_bytes()).decode()
        kernel_timer_hz = int(re.search(r'^CONFIG_HZ=(\d+)$', config, re.M)[1])
        assert 1000000 % kernel_timer_hz == 0, 'Unsupported timer granularity'
        tick_us = 1000000 // kernel_timer_hz
        effective_expected = ((requested['value'] + tick_us - 1) // tick_us) * tick_us
    if requested:
        sockets[requested['role']].setsockopt(
            socket.IPPROTO_TCP, options[requested['option']], requested['value'])
    after = read()
    for role in roles:
        for key in options:
            expected = effective_expected if requested and role == requested['role'] and key == requested['option'] else before[role][key]
            assert after[role][key] == expected, (role, key, after[role][key], expected)
    system_after = defaults()
    assert system_before == system_after
    print(json.dumps({'mode': args.mode, 'uid': os.geteuid(), 'requested': requested,
                      'effectiveExpected': effective_expected, 'kernelTimerHz': kernel_timer_hz,
                      'before': before, 'after': after, 'sysctlBefore': system_before,
                      'sysctlAfter': system_after, 'endpoints': endpoints, 'scopeVerified': True,
                      'namespace': namespace, 'hostNamespace': host_namespace}))
finally:
    for s in sockets.values():
        s.close()
