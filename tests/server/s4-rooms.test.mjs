import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { WebSocket } from 'ws';
import { createApp } from '../../server/app.js';
import { readConfig } from '../../server/config.js';
import { BOT_NAMES } from '../../src/sim/bots.js';
import {
  IDENTITY,
  INPUT_FLAGS,
  encodeMessage,
  decodeMessage,
} from '../../src/protocol/messages.js';

async function peer(address) {
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws`, { handshakeTimeout: 2000 }),
    messages = [],
    listeners = new Set();
  socket.on('message', (data, binary) => {
    messages.push(decodeMessage(binary ? data : data.toString()));
    for (const f of [...listeners]) f();
  });
  await once(socket, 'open');
  const next = (type, predicate = () => true) =>
    new Promise((done, fail) => {
      const check = () => {
        const i = messages.findIndex(
          (m) => (Array.isArray(type) ? type.includes(m.type) : m.type === type) && predicate(m),
        );
        if (i >= 0) {
          clearTimeout(timer);
          listeners.delete(check);
          done(messages.splice(i, 1)[0]);
        }
      };
      const timer = setTimeout(() => {
        listeners.delete(check);
        fail(new Error(`missing ${type}`));
      }, 2000);
      listeners.add(check);
      check();
    });
  const send = (message) => socket.send(encodeMessage(message));
  send({ type: 'hello', identity: IDENTITY });
  await next('hello');
  let clockId = 0;
  return {
    socket,
    next,
    send,
    messages,
    async request(m, type) {
      send(m);
      const id = ++clockId;
      send({ type: 'clock', id, clientMs: 0 });
      await next('clock', (value) => value.id === id);
      return next(type);
    },
  };
}
const create = (name, overrides = {}) => ({
  type: 'create',
  name,
  mode: 'tdm',
  teamSize: 4,
  ...overrides,
});

test(
  'S4-R1 room admission balances fresh actors and serializes the last seat',
  { timeout: 15000 },
  async () => {
    for (const teamSize of [4, 5, 8]) {
      const logs = [];
      const app = createApp({
        config: readConfig({ PORT: '0' }),
        staticRoot: resolve('src'),
        autoTick: false,
        log: (entry) => logs.push(entry),
      });
      try {
        const address = await app.start(),
          owner = await peer(address);
        const joined = await owner.request(
          create('creator', { teamSize, password: 'deck-secret' }),
          'joined',
        );
        const room = app.rooms.get(joined.roomId);
        const bots = room.match.actors.filter((actor) => actor.controlType === 'bot');
        assert.ok(bots.every((actor) => BOT_NAMES.includes(actor.name)));
        assert.equal(new Set(bots.map((actor) => actor.name)).size, bots.length);
        const botName = bots[0].name;
        room.match.spawnActor(bots[0]);
        assert.equal(bots[0].name, botName, 'respawning keeps the actor nickname');
        const observer = await peer(address);
        const listed = await observer.request({ type: 'list' }, 'rooms');
        assert.deepEqual(
          listed.rooms.map((r) => [r.id, r.humans, r.capacity, r.passwordRequired, r.phase]),
          [[room.id, 1, teamSize * 2, true, 'running']],
        );
        assert.equal(JSON.stringify(listed).includes('deck-secret'), false);
        const rejected = await observer.request(
          { type: 'join', name: 'wrong', roomId: room.id, password: 'bad' },
          'rejected',
        );
        assert.equal(rejected.code, 'WRONG_PASSWORD');
        assert.equal(observer.socket.readyState, 1);
        const humans = [owner];
        for (let i = 1; i < teamSize * 2 - 1; i++) {
          const p = await peer(address);
          humans.push(p);
          await p.request(
            {
              type: 'join',
              roomId: room.id,
              password: 'deck-secret',
              name: 'new',
              primary: 'ak47',
            },
            'joined',
          );
          const counts = ['BL', 'GR'].map(
            (team) =>
              room.match.actors.filter((a) => a.team === team && a.controlType === 'human').length,
          );
          assert.ok(Math.abs(counts[0] - counts[1]) <= 1);
        }
        const last = await peer(address);
        const results = await Promise.all(
          [observer, last].map((p) =>
            p.request({ type: 'join', roomId: room.id, password: 'deck-secret', name: 'racer' }, [
              'joined',
              'rejected',
            ]),
          ),
        );
        assert.equal(results.filter((r) => r.type === 'joined').length, 1);
        assert.equal(results.find((r) => r.type === 'rejected').code, 'ROOM_FULL');
        assert.equal(room.connections.size, teamSize * 2);
        assert.equal(
          room.match.actors.some((a) => a.controlType === 'bot'),
          false,
        );
        const original = room.match.actors.find((a) => a.id === joined.actorId);
        original.hp = 1;
        original.stats.k = 7;
        room.match.score[original.team] = 12;
        await owner.request({ type: 'leave' }, 'left');
        const replacement = room.match.actors.find(
          (a) => a.team === original.team && a.controlType === 'bot',
        );
        assert.deepEqual([replacement.hp, replacement.stats.k, replacement.lifeId], [100, 0, 1]);
        assert.notEqual(replacement.id, original.id);
        assert.ok(BOT_NAMES.includes(replacement.name));
        assert.equal(room.match.score[original.team], 12);
      } finally {
        await app.close();
      }
      assert.equal(app.clients.size, 0);
      assert.equal(app.rooms.size, 0);
      assert.equal(logs.length, 1, 'planned shutdown is one room summary, not client warnings');
      assert.deepEqual(
        [
          logs[0].event,
          logs[0].endReason,
          logs[0].peakHumans,
          logs[0].humanJoins,
          logs[0].completed,
        ],
        ['match_summary', 'server_shutdown', teamSize * 2, teamSize * 2, false],
      );
      for (const secret of ['deck-secret', 'creator', 'racer'])
        assert.equal(JSON.stringify(logs).includes(secret), false);
      assert.ok(Buffer.byteLength(JSON.stringify(logs[0])) < 4096, 'summary size stays bounded');
    }
  },
);

test(
  'S4-R2 rooms isolate pause membership and one-time settlement while retaining connections',
  { timeout: 15000 },
  async () => {
    let time = 0;
    const logs = [];
    const app = createApp({
      config: readConfig({ PORT: '0' }),
      staticRoot: resolve('src'),
      autoTick: false,
      now: () => time,
      log: (entry) => logs.push(entry),
    });
    try {
      const address = await app.start(),
        a = await peer(address),
        b = await peer(address),
        c = await peer(address);
      const aj = await a.request(create('A'), 'joined'),
        bj = await b.request(create('B', { mode: 'relay', teamSize: 5 }), 'joined');
      const ar = app.rooms.get(aj.roomId),
        br = app.rooms.get(bj.roomId);
      assert.notEqual(ar.match.world, br.match.world);
      assert.notEqual(ar.match.nav, br.match.nav);
      await a.request({ type: 'pause' }, 'snapshot');
      await c.request({ type: 'join', name: 'C', roomId: aj.roomId }, 'joined');
      assert.equal(ar.match.phase, 'paused');
      assert.equal(br.match.phase, 'running');
      await c.request({ type: 'resume' }, 'snapshot');
      const deadline = ar.match.resumeAtMs;
      time = 100;
      await a.request({ type: 'resume' }, 'snapshot');
      assert.equal(ar.match.resumeAtMs, deadline);
      await a.request({ type: 'pause' }, 'snapshot');
      assert.equal(ar.match.resumeAtMs, null);
      await a.request({ type: 'leave' }, 'left');
      assert.equal(app.rooms.get(aj.roomId), ar);
      assert.equal(ar.connections.size, 1);
      const serverPeer = [...app.clients].find((p) => p.actorId === [...ar.connections.keys()][0]);
      const closed = once(serverPeer.socket, 'close');
      c.socket.terminate();
      await closed;
      assert.equal(app.rooms.has(aj.roomId), false);
      assert.equal(ar.match.actors.length, 0);
      const abandoned = logs.find((entry) => entry.event === 'match_summary');
      assert.deepEqual(
        [
          abandoned.roomId,
          abandoned.endReason,
          abandoned.humanJoins,
          abandoned.peakHumans,
          abandoned.humanLeaves,
          abandoned.abnormalDisconnects,
        ],
        [aj.roomId, 'empty', 2, 2, 2, 1],
      );
      assert.deepEqual(
        [logs[0].event, logs[0].reason, logs[0].roomId, logs[0].actorId !== null],
        ['connection_abnormal_close', 'ABNORMAL_CLOSE', aj.roomId, true],
      );
      br.match.time = 180 - 1 / 60;
      time += 20;
      app.pulse(time);
      const result = await b.next('result');
      assert.deepEqual(
        [result.result.winner, result.result.actors.length, result.result.reason],
        [null, 10, 'time'],
      );
      assert.deepEqual(
        result.result.actors.map((actor) => actor.controlType),
        result.result.actors.map((actor) => (actor.id === bj.actorId ? 'human' : 'bot')),
        'settlement retains human/bot identity over the wire',
      );
      assert.equal(app.rooms.size, 0);
      assert.equal(br.history.samples.length, 0);
      assert.equal(b.socket.readyState, 1);
      const finished = logs.find((entry) => entry.roomId === bj.roomId);
      assert.deepEqual(
        [
          finished.event,
          finished.endReason,
          finished.completed,
          finished.score,
          finished.simulationMs,
        ],
        ['match_summary', 'time', true, result.result.score, 180000],
      );
      b.send({
        type: 'input',
        seq: 1,
        tick: 1,
        lifeId: 1,
        stageId: 1,
        createdAtMs: time,
        display: null,
        input: {
          yaw: 0,
          pitch: 0,
          moveX: 0,
          moveZ: 0,
          ...Object.fromEntries(INPUT_FLAGS.map((flag) => [flag, false])),
        },
      });
      assert.deepEqual((await b.request({ type: 'list' }, 'rooms')).rooms, []);
      app.pulse(time + 20);
      br.match.end('again');
      assert.equal(br.match.events.filter((e) => e.type === 'end').length, 1);
      assert.equal(
        (await b.request({ type: 'join', roomId: bj.roomId, name: 'late' }, 'rejected')).code,
        'ROOM_ENDED',
      );
      const again = await b.request(create('again'), 'joined');
      assert.ok(again.roomId > bj.roomId);
      await b.request({ type: 'leave' }, 'left');
      assert.equal(app.rooms.size, 0);
      b.messages.length = 0;
      const repeated = await b.request(create('same-size-again'), 'joined');
      const roster = await b.next('roster');
      const firstSnapshot = await b.next('snapshot');
      assert.equal(firstSnapshot.public.roomId, repeated.roomId);
      assert.ok(roster.actors.some((actor) => actor.id === repeated.actorId));
      assert.equal(roster.version, firstSnapshot.public.rosterVersion);
      assert.equal(logs.filter((entry) => entry.roomId === bj.roomId).length, 1);
    } finally {
      await app.close();
    }
    assert.equal(app.server.listening, false);
    const summaries = logs.filter((entry) => entry.event === 'match_summary');
    assert.equal(summaries.length, 4);
    assert.equal(new Set(summaries.map((entry) => entry.roomId)).size, 4);
    assert.equal(logs.filter((entry) => entry.event === 'connection_abnormal_close').length, 1);
  },
);
