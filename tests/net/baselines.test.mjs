import test from 'node:test';
import assert from 'node:assert/strict';
import { OnlineSession } from '../../src/net/session.js';
import { decodeMessage, INPUT_FLAGS } from '../../src/protocol/messages.js';
import {
  encodePublicState,
  encodePublicFragment,
  encodeSnapshot,
} from '../../src/protocol/compact.js';

test('O3-C1 confirmed bases stay pinned through switching; missing bases recover atomically with bounded retries', () => {
  let time = 100;
  const sessions = [];
  const create = () => {
    const applied = [],
      closed = [],
      sent = [];
    const s = new OnlineSession({
      now: () => time,
      onStatus() {},
      onSnapshot: (p, o) => applied.push({ p, o }),
      onClose: (r) => closed.push(r),
    });
    s.actorId = 1;
    s.roomId = 1;
    s.offsetMs = 0;
    s.config = { snapshotHz: 60 };
    s.rosters.set(1, [{ id: 1, name: 'P', team: 'BL', controlType: 'human' }]);
    s.socket = {
      readyState: 1,
      bufferedAmount: 0,
      send: (b) => sent.push(decodeMessage(b)),
      close() {
        this.readyState = 2;
      },
    };
    sessions.push(s);
    return { s, applied, closed, sent };
  };
  const packet = (seq, base = null, offer = true, reset = false, actorId = 1) => {
    const p = {
      roomId: 1,
      snapshotSeq: seq,
      tick: seq,
      nowMs: time,
      stageId: 1,
      phase: 'running',
      rosterVersion: 1,
      actors: [{ id: 1, lifeId: 1, alive: true, pos: [seq / 100, 0, 0] }],
    };
    const raw = encodePublicState(p);
    return {
      seq,
      bytes: raw,
      wire: encodeSnapshot(encodePublicFragment(raw, { base, offer, reset }), {
        snapshotSeq: seq,
        actorId,
        ackSeq: seq,
        state: {},
      }),
    };
  };
  const input = {
    yaw: 0,
    pitch: 0,
    moveX: 0,
    moveZ: 0,
    ...Object.fromEntries(INPUT_FLAGS.map((k) => [k, false])),
  };
  try {
    const { s, applied, closed, sent } = create();
    const a = packet(1, null, true, true);
    s.receiveWire(a.wire);
    const old = s.snapshot,
      original = a.bytes.slice();
    assert.equal(s.frame(input).baseAck, 1);
    s.receiveWire(packet(2, a, false).wire);
    const c = packet(3, a);
    s.receiveWire(c.wire);
    s.receiveWire(packet(4, a, false).wire);
    assert.deepEqual(
      [...s.bases.keys()],
      [1, 3],
      'old active remains while offer acknowledgement travels',
    );
    const e = packet(5, c);
    s.receiveWire(e.wire);
    assert.deepEqual(
      [...s.bases.keys()],
      [3, 5],
      'new base proves adoption and releases the old active',
    );
    assert.equal(s.frame(input).baseAck, 5);
    assert.deepEqual(a.bytes, original);
    assert.equal(old.snapshotSeq, 1);
    assert.ok(Math.abs(old.actors[0].pos[0] - 0.01) < 0.00001);
    s.bases.delete(3);
    const missing = packet(6, c, false);
    s.receiveWire(missing.wire);
    s.receiveWire(missing.wire);
    assert.equal(
      applied.length,
      5,
      'neither public state nor private correction applies without a base',
    );
    assert.equal(s.snapshot.snapshotSeq, 5);
    assert.equal(applied.at(-1).o.ackSeq, 5);
    assert.deepEqual(sent, [{ type: 'resync' }]);
    assert.equal(s.frame(input), null);
    const recovered = packet(7, null, true, true);
    s.receiveWire(recovered.wire);
    assert.equal(s.recoveryAt, null);
    assert.equal(s.buffer.samples.length, 1, 'recovery establishes a fresh interpolation boundary');
    assert.equal(s.display, null);
    assert.equal(s.frame(input).baseAck, 7);
    assert.deepEqual([...s.bases.keys()], [7]);
    s.bases.clear();
    s.receiveWire(packet(8, recovered, false).wire);
    const again = packet(9, null, true, true);
    s.receiveWire(again.wire);
    s.bases.clear();
    s.receiveWire(packet(10, again, false).wire);
    assert.equal(sent.length, 2);
    assert.equal(closed.length, 1);
    assert.equal(s.bases.size, 0);
    assert.equal(applied.at(-1).p.snapshotSeq, 9);
    const timeout = create();
    timeout.s.receiveWire(a.wire);
    timeout.s.recoverSnapshot();
    time += 3001;
    assert.equal(timeout.s.frame(input), null);
    assert.match(timeout.closed[0], /恢复超时/);
    const invalid = create();
    invalid.s.receiveWire(packet(11, null, true, true, 2).wire);
    assert.deepEqual(invalid.closed, ['UNPAIRED_SNAPSHOT']);
    assert.equal(invalid.applied.length, 0);
    assert.equal(invalid.s.bases.size, 0);
    assert.equal(invalid.s.buffer.samples.length, 0);
    const pinned = create();
    pinned.s.receiveWire(a.wire);
    for (let seq = 2; seq <= 40; seq++) pinned.s.receiveWire(packet(seq, a, false).wire);
    assert.equal(pinned.s.buffer.samples.length, 32);
    assert.ok(pinned.s.buffer.samples[0].snapshotSeq > 1);
    assert.deepEqual(
      [...pinned.s.bases.keys()],
      [1],
      'display FIFO cannot evict a server-pinned base',
    );
    assert.deepEqual(pinned.s.bases.get(1), original);
    const congested = create();
    congested.s.receiveWire(a.wire);
    congested.s.socket.bufferedAmount = 65537;
    congested.s.recoverSnapshot();
    assert.equal(congested.closed.length, 1, 'upstream backlog closes during recovery send');
    assert.equal(congested.s.bases.size, 0);
    assert.equal(congested.s.recoveryTimer, undefined, 'closed recovery owns no new timeout');
  } finally {
    for (const s of sessions) s.close();
  }
});
