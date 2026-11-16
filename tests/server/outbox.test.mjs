import test from 'node:test';
import assert from 'node:assert/strict';
import { Outbox } from '../../server/transport/outbox.js';
import { readConfig } from '../../server/config.js';
import { SampleRoom } from '../../server/rooms/sample-room.js';
import { decodeMessage } from '../../src/protocol/messages.js';

test('one slow peer replaces complete paired snapshots, preserves important order and terminates sustained backlog', () => {
  let now = 0;
  const config = readConfig({}),
    room = new SampleRoom(config, () => now);
  const connect = (blocked) => {
    const sent = [],
      wires = [],
      bases = new Map(),
      metadata = [];
    const socket = {
      readyState: 1,
      bufferedAmount: blocked ? config.maxBufferedBytes + 1 : 0,
      terminated: 0,
      send: (text) => {
        wires.push(text);
        const meta = {},
          message = decodeMessage(text, 131072, { bases, meta });
        sent.push(message);
        metadata.push(meta);
        if (meta.publicBasis?.reset) bases.clear();
        if (meta.publicBasis?.offer) bases.set(message.public.snapshotSeq, meta.publicBasis.bytes);
      },
      terminate() {
        this.terminated++;
        this.readyState = 3;
      },
    };
    const connection = {
      socket,
      sent,
      wires,
      bases,
      metadata,
      outbox: new Outbox(socket, config, () => now),
    };
    room.join(connection, blocked ? 'slow' : 'fast');
    return connection;
  };
  const fast = connect(false),
    slow = connect(true),
    missed = room.snapshotSeq + 1;
  const retainedWire = fast.wires.find((wire) => wire instanceof Uint8Array),
    retainedBytes = retainedWire.slice();
  let seq = 0;
  const step = (time) => {
    now = time;
    const actor = room.match.actors.find((value) => value.id === fast.actorId);
    assert.equal(
      fast.inputs.push(
        {
          seq: ++seq,
          tick: room.match.tick + 1,
          lifeId: actor.lifeId,
          stageId: room.match.stageId,
          createdAtMs: now,
          input: { fire: false },
        },
        actor,
        room.match.stageId,
        room.match.tick,
        now,
      ),
      null,
    );
    room.step(1 / 60, now);
    const latest = fast.sent.filter((value) => value.type === 'snapshot').at(-1);
    assert.equal(latest.public.snapshotSeq, latest.own.snapshotSeq);
    assert.equal(latest.own.ackSeq, seq);
    const historical = room.history.samples.at(-1);
    assert.deepEqual(
      latest.public.actors,
      historical.actors.map(({ name, team, controlType, ...value }) => value),
      'history stores the same decoded public values as the client',
    );
    assert.equal(
      historical.actors.find((value) => value.id === actor.id).team,
      actor.team,
      'history retains roster metadata for friendly-fire rules',
    );
  };
  try {
    for (let i = 1; i <= 10; i++) step(i * 17);
    const latest = room.snapshotSeq;
    assert.equal(slow.sent.length, 0);
    assert.equal(decodeMessage(slow.outbox.snapshot.text).own.snapshotSeq, latest);
    assert.deepEqual(
      retainedWire,
      retainedBytes,
      'later recipients and snapshots cannot overwrite in-flight bytes',
    );
    slow.socket.bufferedAmount = 0;
    slow.outbox.flush();
    assert.deepEqual(
      slow.sent.map((value) => value.type),
      ['joined', 'roster', 'snapshot'],
    );
    assert.equal(slow.sent.at(-1).own.snapshotSeq, latest);
    assert.equal(slow.sentSnapshotSeq, latest);
    assert.equal(slow.sentSnapshots.has(missed), false);
    assert.equal(
      room.history.select(
        room.match,
        room.match.actors.find((actor) => actor.id === fast.actorId),
        { display: { a: missed, b: latest, alpha: 0.5 } },
        now,
        slow,
      ).reason,
      'unsent-sample',
    );
    const blockedAt = now;
    slow.socket.bufferedAmount = config.maxBufferedBytes + 1;
    room.publish();
    for (let i = 1; i <= 100; i++) step(blockedAt + i * 20);
    assert.equal(slow.socket.terminated, 0);
    now = blockedAt + config.maxBacklogMs + 1;
    slow.outbox.flush();
    assert.equal(slow.socket.terminated, 1);
    assert.equal(slow.outbox.failureReason, 'SEND_BACKLOG_TIMEOUT');
    assert.equal(fast.socket.readyState, 1);
    assert.equal(room.match.phase, 'running');
    room.leave(slow);
    step(now + 20);
    assert.equal(room.connections.size, 1);
    assert.equal(slow.outbox.bytes, 0);
    assert.equal(slow.outbox.snapshot, null);
    const shooter = room.match.actors.find((actor) => actor.id === fast.actorId);
    shooter.weaponUpdate(1 / 60, { fire: true });
    const authoritativeShot = room.match.events.findLast((event) => event.type === 'shot'),
      presentedShot = fast.sent.findLast((message) => message.event?.type === 'shot').event;
    for (const key of ['inputSeq', 'display', 'reused', 'path', 'reason']) {
      assert.ok(Object.hasOwn(authoritativeShot, key), 'core retains ' + key);
      assert.equal(Object.hasOwn(presentedShot, key), false, 'broadcast omits ' + key);
    }
    const expectedShot = { ...authoritativeShot };
    for (const key of ['inputSeq', 'display', 'reused', 'path', 'reason']) delete expectedShot[key];
    assert.deepEqual(
      presentedShot,
      expectedShot,
      'resolved effects and stable identities stay exact',
    );
    room.match.pause(fast.actorId);
    room.publish();
    const seed = fast.offeredBase,
      preserved = seed.bytes.slice();
    room.publish();
    assert.equal(
      fast.metadata.at(-1).publicBasis.baseSeq,
      0,
      'unconfirmed offer cannot become a delta base',
    );
    room.acknowledgeBase(fast, seed.seq + 10000);
    assert.equal(fast.activeBase, null, 'unknown acknowledgements do not create bases');
    room.acknowledgeBase(fast, seed.seq);
    room.publish();
    assert.equal(fast.metadata.at(-1).publicBasis.baseSeq, seed.seq);
    const candidate = fast.offeredBase;
    fast.socket.bufferedAmount = config.maxBufferedBytes + 1;
    room.publish();
    room.publish();
    const meta = {},
      queued = decodeMessage(fast.outbox.snapshot.text, 131072, { bases: fast.bases, meta });
    assert.equal(
      meta.publicBasis.baseSeq,
      seed.seq,
      'replacement is relative to acknowledged base',
    );
    assert.equal(queued.public.snapshotSeq, queued.own.snapshotSeq);
    assert.equal(fast.offeredBase, candidate, 'unsent replacements do not change an offered base');
    fast.socket.bufferedAmount = 0;
    fast.outbox.flush();
    room.acknowledgeBase(fast, candidate.seq);
    room.publish();
    assert.equal(fast.metadata.at(-1).publicBasis.baseSeq, candidate.seq);
    room.acknowledgeBase(fast, seed.seq);
    assert.equal(
      fast.activeBase.seq,
      candidate.seq,
      'late acknowledgement cannot roll back the base',
    );
    assert.deepEqual(seed.bytes, preserved, 'retained baselines are immutable');
    room.leave(fast);
    assert.equal(fast.activeBase, null);
    assert.equal(fast.offeredBase, null);
  } finally {
    room.close();
    fast.outbox.clear();
    slow.outbox.clear();
  }
});
test('important queue count and byte bounds disconnect only its owning socket', () => {
  for (const config of [
    { ...readConfig({}), maxQueueCount: 1 },
    { ...readConfig({}), maxQueueBytes: 1 },
  ]) {
    let terminated = false;
    const box = new Outbox(
      {
        readyState: 1,
        bufferedAmount: Infinity,
        terminate() {
          terminated = true;
        },
      },
      config,
      () => 0,
    );
    box.add('a');
    box.add('b');
    assert.equal(terminated, true);
    assert.equal(
      box.failureReason,
      config.maxQueueBytes === 1 ? 'IMPORTANT_QUEUE_BYTES_LIMIT' : 'IMPORTANT_QUEUE_COUNT_LIMIT',
    );
    assert.ok(box.important.length <= 1);
  }
});
