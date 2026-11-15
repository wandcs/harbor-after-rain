import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createApp } from '../../server/app.js';
import { readConfig } from '../../server/config.js';
import { connectPeer } from '../../scripts/s5/peer.mjs';

test(
  'S5-R1 global admission limits isolate running rooms and release their own capacity',
  { timeout: 15000 },
  async () => {
    let now = 0;
    const app = createApp({
      config: readConfig({ PORT: '0', MAX_ROOMS: '2', MAX_CONNECTIONS: '3' }),
      staticRoot: resolve('src'),
      now: () => now,
      autoTick: false,
    });
    const peers = [];
    try {
      const address = await app.start(),
        url = `ws://127.0.0.1:${address.port}/ws`;
      for (let i = 0; i < 3; i++) peers.push(await connectPeer(url));
      const [a, b, c] = peers,
        create = (mode) => ({ type: 'create', name: 'test', mode, teamSize: 4 });
      const aj = await a.request(create('tdm')),
        bj = await b.request(create('relay'));
      const ar = app.rooms.get(aj.roomId),
        br = app.rooms.get(bj.roomId);
      assert.equal((await c.request(create('tdm'), 'rejected')).code, 'SERVER_FULL');
      const extra = new WebSocket(url, { handshakeTimeout: 2000 });
      const rejected = await new Promise((done, fail) => {
        extra.once('unexpected-response', (_, res) => {
          done(res.statusCode);
          res.resume();
          extra.terminate();
        });
        extra.once('open', () => fail(new Error('connection limit bypassed')));
        extra.on('error', fail);
      });
      assert.equal(rejected, 503);
      assert.equal(app.clients.size, 3);
      for (const key of ['open', 'g', 'f', 'parent', 'seen', 'closed'])
        assert.notEqual(ar.match.nav[key], br.match.nav[key], key);
      a.send({ type: 'pause' });
      await a.take('rooms', () => true); // FIFO barrier below confirms processing.
      a.send({ type: 'list' });
      await a.take('rooms', (rooms) => rooms.rooms.some((r) => r.phase === 'paused'));
      for (let i = 0; i < 60; i++) {
        now += 1000 / 60;
        app.pulse(now);
      }
      assert.equal(ar.match.time, 0);
      assert.ok(br.match.time > 0.9);
      assert.equal(br.match.phase, 'running');
      await a.request({ type: 'leave' }, 'left');
      assert.equal(ar.history.samples.length, 0);
      assert.equal(ar.match.actors.length, 0);
      assert.equal(app.rooms.size, 1);
      assert.equal(br.connections.size, 1);
      const cj = await c.request(create('tdm'));
      assert.ok(cj.roomId > bj.roomId);
      const serverA = [...app.clients].find(
        (x) => x.socket._socket.remotePort === a.session.socket._socket.localPort,
      );
      const closed = once(serverA.socket, 'close');
      await a.close();
      await closed;
      const d = await connectPeer(url);
      peers.push(d);
      assert.equal(app.clients.size, 3);
      assert.equal(br.match.phase, 'running');
    } finally {
      await Promise.all(peers.map((p) => p.close()));
      await app.close();
    }
    assert.equal(app.rooms.size, 0);
    assert.equal(app.clients.size, 0);
    assert.equal(app.server.listening, false);
  },
);
