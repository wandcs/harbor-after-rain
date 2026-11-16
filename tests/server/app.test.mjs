import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { WebSocket } from 'ws';
import { createApp } from '../../server/app.js';
import '../../server/main.js';
import { readConfig } from '../../server/config.js';
import {
  IDENTITY,
  INPUT_FLAGS,
  encodeMessage,
  decodeMessage,
} from '../../src/protocol/messages.js';

async function peer(service, url, options = {}) {
  const socket = new WebSocket(url, options);
  const messages = [];
  const waiters = new Set();
  socket.on('message', (data, binary) => {
    const message = decodeMessage(binary ? data : data.toString());
    messages.push(message);
    for (const wake of [...waiters]) wake();
  });
  await once(socket, 'open');
  const serverSocket = [...service.clients].at(-1).socket;
  const serverClosed = new Promise((done) => serverSocket.once('close', done));
  let closed = false,
    closeArgs;
  const closedPromise = new Promise((done) =>
    socket.once('close', (...args) => {
      closed = true;
      closeArgs = args;
      done(args);
      for (const wake of [...waiters]) wake();
    }),
  );
  return {
    socket,
    messages,
    send: (message) =>
      socket.send(
        encodeMessage(
          message.type === 'join' && message.roomId === undefined
            ? service.room
              ? { ...message, roomId: service.room.id }
              : { ...message, type: 'create', mode: 'tdm', teamSize: 4 }
            : message,
        ),
      ),
    async closed() {
      const args = closed ? closeArgs : await closedPromise;
      await serverClosed;
      return args;
    },
    next(type, predicate = () => true) {
      return new Promise((done, fail) => {
        const finish = () => {
          const index = messages.findIndex((value) => value.type === type && predicate(value));
          if (index < 0 && !closed) return;
          clearTimeout(timeout);
          waiters.delete(finish);
          if (index >= 0) done(messages.splice(index, 1)[0]);
          else fail(new Error(`Closed before ${type}`));
        };
        const timeout = setTimeout(() => {
          waiters.delete(finish);
          fail(new Error(`Missing ${type}`));
        }, 3000);
        waiters.add(finish);
        finish();
      });
    },
  };
}
function app(options = {}) {
  return createApp({ config: readConfig({ PORT: '0' }), staticRoot: resolve('src'), ...options });
}

test(
  'S3-S1 application catchup stays bounded and expires queued fire',
  { timeout: 15000 },
  async () => {
    let clock = 0;
    const service = app({ now: () => clock, autoTick: false });
    try {
      const address = await service.start();
      const client = await peer(service, `ws://127.0.0.1:${address.port}/ws`);
      client.send({ type: 'hello', identity: IDENTITY });
      await client.next('hello');
      client.send({ type: 'join', name: 'scheduler' });
      const joined = await client.next('joined');
      await client.next('snapshot');
      const room = service.room,
        match = room.match;
      const actor = match.actors.find((value) => value.id === joined.actorId);
      actor.pos.set(-3, 0, 6.8);
      actor.vel.set(0, 0, 0);
      actor.readyAt = 0;
      const input = {
        yaw: -Math.PI / 2,
        pitch: -0.1,
        moveX: 0,
        moveZ: 0,
        ...Object.fromEntries(INPUT_FLAGS.map((flag) => [flag, false])),
        fire: true,
      };
      clock = 1000;
      for (let seq = 1; seq <= 12; seq++)
        client.send({
          type: 'input',
          seq,
          tick: seq,
          lifeId: actor.lifeId,
          stageId: match.stageId,
          createdAtMs: clock,
          display: null,
          input,
        });
      // FIFO clock reply proves all twelve preceding frames reached the real app.
      client.send({ type: 'clock', id: 1, clientMs: clock });
      await client.next('clock', (value) => value.id === 1);
      const queue = room.connections.get(actor.id).inputs;
      assert.deepEqual(
        [match.tick, match.time, actor.weapon.mag, queue.ackSeq, queue.queue.length],
        [0, 0, 30, 0, 12],
      );
      service.pulse(clock);
      assert.deepEqual(
        [match.tick, queue.ackSeq, actor.weapon.mag],
        [3, 3, 29],
        'one delayed pulse has a three-step ceiling',
      );
      for (let i = 0; i < 12; i++) {
        const previous = match.tick;
        service.pulse(clock);
        assert.ok(match.tick - previous <= 3);
      }
      assert.ok(match.tick <= 6, 'discard excessive backlog instead of replaying a whole second');
      const settled = match.tick;
      service.pulse(clock);
      assert.equal(match.tick, settled, 'unchanged clock cannot continue advancing');
      assert.equal(actor.weapon.mag, 29);
      clock += 20;
      service.pulse(clock);
      assert.equal(match.tick, 7);
      assert.ok(Math.abs(match.time - 7 / 60) < 1e-12);
      assert.equal(queue.ackSeq, 7);
      const shots = () =>
        match.events.filter((event) => event.type === 'shot' && event.actorId === actor.id);
      assert.deepEqual(
        shots().map((shot) => [shot.tick, shot.shotSeq, shot.inputSeq]),
        [
          [1, 1, 1],
          [7, 2, 7],
        ],
      );
      assert.equal(actor.weapon.mag, 28);
      clock += 251;
      for (let i = 0; i < 12; i++) service.pulse(clock);
      clock += 20;
      service.pulse(clock);
      assert.equal(match.tick, 14);
      assert.deepEqual(
        [queue.ackSeq, queue.discarded, queue.queue.length, queue.held],
        [12, 5, 0, null],
      );
      assert.deepEqual(
        shots().map((shot) => shot.tick),
        [1, 7],
        'expired queued/held fire never catches up',
      );
      assert.equal(actor.weapon.mag, 28);
      const snapshot = await client.next('snapshot', (value) => value.own.ackSeq === 12);
      assert.equal(snapshot.public.snapshotSeq, snapshot.own.snapshotSeq);
      assert.equal(snapshot.own.state.fields.shotSeq, 2);
      assert.equal(snapshot.own.state.weapons[0].mag, 28);
      client.send({ type: 'leave' });
      await client.next('left');
      client.socket.close();
      await client.closed();
      assert.equal(service.room, null);
    } finally {
      await service.close();
    }
    assert.equal(service.clients.size, 0);
    assert.equal(service.server.listening, false);
  },
);
test(
  'application import is inert and repeated close releases the actual HTTP/WebSocket room lifecycle',
  { timeout: 15000 },
  async () => {
    const a = app();
    assert.equal(a.server.listening, false);
    await a.close();
    await a.close();
    let clock = 0;
    const logs = [];
    const product = { name: 'harbor-after-rain', version: '1.4.9' };
    const service = app({
      now: () => clock,
      autoTick: false,
      product,
      log: (entry) => logs.push(entry),
    });
    try {
      const address = await service.start(),
        url = `http://127.0.0.1:${address.port}`;
      assert.equal((await fetch(url)).status, 200);
      const health = await (await fetch(url + '/health')).json();
      assert.deepEqual(health.identity, IDENTITY);
      assert.deepEqual(health.product, product);
      const join = async (name) => {
        const p = await peer(service, url.replace('http:', 'ws:') + '/ws');
        p.send({ type: 'hello', identity: IDENTITY });
        await p.next('hello');
        p.send({ type: 'join', name });
        const joined = await p.next('joined'),
          snap = await p.next('snapshot', (value) => value.own.actorId === joined.actorId);
        assert.equal(snap.public.snapshotSeq, snap.own.snapshotSeq);
        assert.equal(snap.public.actors.length, 8);
        assert.ok(snap.own.state.randomState);
        return { p, id: joined.actorId };
      };
      const first = await join('A'),
        second = await join('B'),
        room = service.room;
      assert.equal(room.connections.size, 2);
      const a = room.match.actors.find((actor) => actor.id === first.id),
        b = room.match.actors.find((actor) => actor.id === second.id);
      a.hp = 40;
      a.weapon.mag = 17;
      a.stats.k = 2;
      b.stats.k = 3;
      room.match.score[a.team] = 2;
      room.match.score[b.team] = 3;
      const input = {
        yaw: 0,
        pitch: 0,
        moveX: 0,
        moveZ: 0,
        fire: true,
        firePressed: true,
        alt: false,
        jump: false,
        crouch: false,
        walk: false,
        left: false,
        right: false,
        reload: false,
      };
      first.p.send({
        type: 'input',
        seq: 1,
        tick: 20,
        lifeId: a.lifeId,
        stageId: room.match.stageId,
        createdAtMs: clock,
        display: null,
        input,
      });
      first.p.send({ type: 'clock', id: 1, clientMs: 0 });
      await first.p.next('clock');
      assert.equal(room.connections.get(a.id).inputs.queue.length, 1);
      const departing = room.connections.get(a.id);
      for (let attempt = 1; attempt <= 2; attempt++) {
        const before = room.snapshotSeq;
        first.p.send({ type: 'resync' });
        await first.p.next('snapshot', (value) => value.public.snapshotSeq > before);
        assert.equal(departing.resyncs, attempt);
        assert.equal(departing.activeBase, null);
        assert.ok(departing.offeredBase);
        assert.equal(room.connections.size, 2, 'resync affects only its connection');
      }
      first.p.send({ type: 'leave' });
      await first.p.next('left');
      assert.equal(departing.inputs.queue.length, 0);
      assert.equal(departing.inputs.held, null);
      assert.equal(departing.sentSnapshots.size, 0);
      assert.equal(departing.activeBase, null);
      assert.equal(departing.offeredBase, null);
      assert.equal(room.match.actors.length, 8);
      assert.equal(room.connections.size, 1);
      assert.equal(
        room.match.actors.some((actor) => actor.id === a.id),
        false,
      );
      const replacement = room.match.actors.find(
        (actor) => actor.team === a.team && actor.controlType === 'bot' && actor.id > second.id,
      );
      assert.ok(replacement);
      assert.deepEqual([replacement.hp, replacement.weapon.mag, replacement.stats.k], [100, 30, 0]);
      clock = 20;
      service.pulse(clock);
      assert.equal(a.weapon.mag, 17);
      assert.equal(room.match.score[a.team], 2);
      first.p.socket.close();
      await first.p.closed();
      const rejoined = await join('A');
      assert.notEqual(rejoined.id, first.id);
      const newcomer = room.match.actors.find((actor) => actor.id === rejoined.id);
      assert.deepEqual(
        [newcomer.hp, newcomer.weapon.mag, newcomer.stats.k, newcomer.lifeId],
        [100, 30, 0, 1],
      );
      assert.equal(
        room.match.actors.find((actor) => actor.id === b.id),
        b,
      );
      assert.equal(b.stats.k, 3);
      assert.equal(room.match.score[b.team], 3);
      second.p.send({ type: 'pause' });
      await second.p.next('snapshot', (value) => value.public.phase === 'paused');
      rejoined.p.send({ type: 'resume' });
      await rejoined.p.next('snapshot', (value) => value.public.phase === 'countdown');
      assert.equal(room.match.resumeAtMs, clock + 3000);
      second.p.send({ type: 'leave' });
      await second.p.next('left');
      second.p.socket.close();
      await second.p.closed();
      assert.equal(service.room, room);
      rejoined.p.send({ type: 'leave' });
      await rejoined.p.next('left');
      rejoined.p.socket.close();
      await rejoined.p.closed();
      assert.equal(service.room, null);
      assert.equal(room.history.samples.length, 0);
      assert.equal(room.match.actors.length, 0);
      assert.equal(service.clients.size, 0);
      assert.equal(logs.length, 1, 'normal leaves and closes emit only the room summary');
      assert.deepEqual(
        [
          logs[0].event,
          logs[0].endReason,
          logs[0].humanJoins,
          logs[0].peakHumans,
          logs[0].humanLeaves,
          logs[0].abnormalDisconnects,
        ],
        ['match_summary', 'empty', 3, 2, 3, 0],
      );
      const heartbeat = await peer(service, url.replace('http:', 'ws:') + '/ws', {
        autoPong: false,
      });
      const connection = [...service.clients][0];
      const heartbeatStart = clock;
      const ping = async (at) => {
        clock = heartbeatStart + at;
        const received = once(heartbeat.socket, 'ping');
        service.pulse(clock);
        const [payload] = await received;
        assert.equal(payload.length, 4, 'heartbeat echoes an exact ping sequence');
        return payload;
      };
      const pong = async (payload) => {
        const received = once(connection.socket, 'pong');
        heartbeat.socket.pong(payload);
        await received;
      };
      const firstPing = await ping(1000);
      await ping(2000);
      clock = heartbeatStart + 2300;
      await pong(firstPing);
      assert.equal(connection.rttMs, 1300, 'a late pong is measured from its own ping');
      assert.equal(connection.lastPongMs, heartbeatStart + 2300);
      clock = heartbeatStart + 2350;
      await pong(firstPing);
      await pong(Buffer.from('xxxx'));
      assert.deepEqual([connection.rttMs, connection.lastPongMs], [1300, heartbeatStart + 2300]);
      for (let i = 3; i <= 12; i++) {
        const payload = await ping(i * 1000);
        if (i % 3 === 0) await pong(payload);
        assert.ok(connection.pendingPings.size <= 8);
        assert.ok([...connection.pendingPings.values()].every((at) => clock - at <= 6000));
      }
      service.pulse((clock = heartbeatStart + 18000));
      assert.equal(connection.socket.readyState, 1, 'six-second boundary is preserved');
      assert.equal(logs.length, 1, 'heartbeats and pulses do not emit routine logs');
      service.pulse((clock = heartbeatStart + 18001));
      await heartbeat.closed();
      assert.equal(connection.pendingPings.size, 0);
      assert.equal(service.clients.size, 0);
      assert.equal(logs.length, 2);
      assert.deepEqual(
        [logs[1].event, logs[1].reason, logs[1].roomId, logs[1].lastPongAgeMs],
        ['connection_abnormal_close', 'HEARTBEAT_TIMEOUT', null, 6001],
      );
    } finally {
      await service.close();
      await service.close();
    }
    assert.equal(service.server.listening, false);
  },
);
test(
  'version mismatch, invalid action, size and rate limits reject the offending real connection',
  { timeout: 15000 },
  async () => {
    let clock = 0;
    const logs = [];
    const service = app({ now: () => clock, autoTick: false, log: (entry) => logs.push(entry) });
    try {
      const address = await service.start(),
        url = `ws://127.0.0.1:${address.port}/ws`;
      const healthy = await peer(service, url);
      healthy.send({ type: 'hello', identity: IDENTITY });
      await healthy.next('hello');
      healthy.send({ type: 'join', name: 'healthy' });
      const joined = await healthy.next('joined');
      await healthy.next('snapshot');
      let seq = 0;
      const progress = async () => {
        const logCount = logs.length;
        const actor = service.room.match.actors.find((value) => value.id === joined.actorId);
        healthy.send({
          type: 'input',
          seq: ++seq,
          tick: service.room.match.tick + 1,
          lifeId: actor.lifeId,
          stageId: service.room.match.stageId,
          createdAtMs: clock,
          display: null,
          input: {
            yaw: 0,
            pitch: 0,
            moveX: 0,
            moveZ: 0,
            fire: false,
            firePressed: false,
            alt: false,
            jump: false,
            crouch: false,
            walk: false,
            left: false,
            right: false,
            reload: false,
          },
        });
        healthy.send({ type: 'clock', id: seq, clientMs: clock });
        assert.equal((await healthy.next('clock', (value) => value.id === seq)).id, seq);
        clock += 20;
        service.pulse(clock);
        const snapshot = await healthy.next('snapshot', (value) => value.own.ackSeq === seq);
        assert.equal(snapshot.own.actorId, joined.actorId);
        assert.equal(snapshot.public.snapshotSeq, snapshot.own.snapshotSeq);
        assert.equal(service.clients.size, 1);
        assert.equal(logs.length, logCount, 'input, clock and snapshot progress is not logged');
      };
      const wrong = await peer(service, url);
      wrong.send({ type: 'hello', identity: { ...IDENTITY, rules: 'wrong' } });
      assert.equal((await wrong.next('error')).code, 'VERSION_MISMATCH');
      await wrong.closed();
      await progress();
      const invalid = await peer(service, url);
      invalid.send({ type: 'input' });
      assert.equal((await invalid.next('error')).code, 'BAD_INPUT');
      await invalid.closed();
      await progress();
      const large = await peer(service, url);
      large.socket.send('x'.repeat(8193));
      const closed = await large.closed();
      assert.equal(closed[0], 1009);
      await progress();
      const rate = await peer(service, url);
      rate.send({ type: 'hello', identity: IDENTITY });
      await rate.next('hello');
      for (let id = 0; id < readConfig({}).maxMessagesPerSecond + 1; id++)
        rate.send({ type: 'clock', id, clientMs: 0 });
      assert.equal((await rate.next('error')).code, 'RATE_LIMIT');
      await rate.closed();
      await progress();
      const malformed = await peer(service, url);
      // V8 includes this entire invalid token in its parse error; raw errors
      // must not cross the logging boundary even when the wire is malformed.
      malformed.socket.send('private-wire-secret');
      await malformed.closed();
      await progress();
      const blocked = await peer(service, url);
      const serverBlocked = [...service.clients].at(-1);
      serverBlocked.outbox.add('x'.repeat(readConfig({}).maxQueueBytes + 1));
      await blocked.closed();
      await progress();
      assert.deepEqual(
        logs.map((entry) => entry.reason),
        [
          'VERSION_MISMATCH',
          'BAD_INPUT',
          'PAYLOAD_TOO_LARGE',
          'RATE_LIMIT',
          'INVALID_MESSAGE',
          'IMPORTANT_QUEUE_BYTES_LIMIT',
        ],
      );
      assert.equal(new Set(logs.map((entry) => entry.connectionId)).size, 6);
      assert.ok(
        logs.every(
          (entry) => entry.event === 'connection_abnormal_close' && entry.level === 'warn',
        ),
      );
      assert.equal(JSON.stringify(logs).includes('private-wire-secret'), false);
      healthy.send({ type: 'leave' });
      await healthy.next('left');
      healthy.socket.close();
      await healthy.closed();
      assert.equal(service.room, null);
      assert.equal(logs.length, 7);
      assert.equal(logs.at(-1).event, 'match_summary');
    } finally {
      await service.close();
    }
  },
);
