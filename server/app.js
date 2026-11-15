import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { performance } from 'node:perf_hooks';
import {
  IDENTITY,
  compatible,
  decodeMessage,
  encodeMessage,
  validateClient,
} from '../src/protocol/messages.js';
import { readConfig } from './config.js';
import { Outbox } from './transport/outbox.js';
import { SampleRoom } from './rooms/sample-room.js';
import { MATCH_RULES } from '../src/sim/match-rules.js';

/** Creates no listener or timer until start(). Every resource belongs to app;
 * close() is bounded and idempotent. now() is injectable monotonic milliseconds. */
export function createApp({
  config = readConfig(),
  identity = IDENTITY,
  product = null,
  staticRoot = fileURLToPath(new URL('../dist/online/', import.meta.url)),
  offlineFile = fileURLToPath(new URL('../dist/offline/harbor-after-rain.html', import.meta.url)),
  now = () => performance.now(),
  autoTick = true,
} = {}) {
  const publicProduct = product ? { name: product.name, version: product.version } : null;
  const clients = new Set();
  const rooms = new Map();
  let nextRoomId = 0,
    timer = null,
    closing = null,
    started = false,
    lastPulse = 0,
    accumulator = 0;
  const send = (connection, message) => connection.outbox.add(encodeMessage(message));
  const list = () =>
    [...rooms.values()]
      .filter((r) => r.match.phase !== 'ended')
      .map((r) => ({
        id: r.id,
        mode: r.match.mode,
        humans: r.connections.size,
        capacity: r.capacity,
        remainingMs: Math.max(
          0,
          MATCH_RULES.durationSeconds * 1000 -
            Math.max(r.match.activeElapsedMs, r.match.time * 1000),
        ),
        phase: r.match.phase,
        passwordRequired: !!r.password,
      }));
  const sendList = (connection) => send(connection, { type: 'rooms', rooms: list() });
  function removeRoom(room) {
    rooms.delete(room.id);
    for (const c of room.connections.values()) {
      c.outbox.snapshot = null;
      if (room.match.result?.reason !== 'empty')
        send(c, { type: 'result', result: room.match.result });
      c.actorId = null;
      c.roomId = null;
      c.inputs?.clear();
      c.sentSnapshots?.clear();
    }
    room.close();
  }
  function leave(connection) {
    const room = rooms.get(connection.roomId);
    if (!room) return;
    room.leave(connection);
    if (!room.connections.size) removeRoom(room);
  }

  const server = http.createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      if (pathname === '/health') {
        response.writeHead(started ? 200 : 503, { 'Content-Type': 'application/json' });
        response.end(encodeMessage({ ready: started, identity, product: publicProduct }));
        return;
      }
      const file =
        pathname === '/offline.html'
          ? offlineFile
          : resolve(staticRoot, '.' + (pathname === '/' ? '/index.html' : pathname));
      const inside = relative(staticRoot, file);
      if (
        pathname !== '/offline.html' &&
        (isAbsolute(inside) || inside === '..' || inside.startsWith('..' + sep))
      ) {
        response.writeHead(403);
        response.end();
        return;
      }
      const body = await readFile(file);
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      response.end(body);
    } catch {
      response.writeHead(404);
      response.end('Not found');
    }
  });
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: config.maxPayload,
    perMessageDeflate: false,
    clientTracking: true,
  });
  server.on('upgrade', (request, socket, head) => {
    if (!started || request.url !== '/ws' || clients.size >= config.maxConnections) {
      socket.end('HTTP/1.1 503 Service Unavailable\r\n\r\n');
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws));
  });
  wss.on('connection', (socket) => {
    const connection = {
      socket,
      ready: false,
      actorId: null,
      lastPongMs: now(),
      lastPingMs: now(),
      pingId: 0,
      pendingPings: new Map(),
      rttMs: 0,
      rateAtMs: now(),
      messages: 0,
      sentSnapshotSeq: 0,
    };
    connection.outbox = new Outbox(socket, config, now);
    clients.add(connection);
    socket.on('error', () => {});
    socket.on('pong', (payload) => {
      if (payload.length !== 4) return;
      const id = payload.readUInt32BE(),
        sent = connection.pendingPings.get(id),
        received = now();
      if (sent === undefined) return;
      connection.pendingPings.delete(id);
      if (received - sent > config.connectionTimeoutMs) return;
      connection.lastPongMs = received;
      connection.rttMs = Math.max(0, received - sent);
    });
    socket.on('close', () => {
      clients.delete(connection);
      leave(connection);
      connection.outbox.clear();
      connection.pendingPings.clear();
    });
    socket.on('message', (data, binary) => {
      try {
        if (now() - connection.rateAtMs >= 1000) {
          connection.rateAtMs = now();
          connection.messages = 0;
        }
        if (++connection.messages > config.maxMessagesPerSecond) throw new Error('RATE_LIMIT');
        const message = decodeMessage(binary ? data : data.toString(), config.maxPayload, {
            clientOnly: true,
          }),
          error = validateClient(message);
        if (error) throw new Error(error);
        if (message.type === 'hello') {
          if (!compatible(message.identity, identity)) {
            send(connection, { type: 'error', code: 'VERSION_MISMATCH' });
            socket.close(1008, 'VERSION_MISMATCH');
            return;
          }
          connection.ready = true;
          send(connection, { type: 'hello', identity });
          return;
        }
        if (!connection.ready) throw new Error('HELLO_REQUIRED');
        if (message.type === 'clock') {
          rooms.get(connection.roomId)?.acknowledgeBase(connection, message.baseAck);
          send(connection, {
            type: 'clock',
            id: message.id,
            clientMs: message.clientMs,
            nowMs: now(),
            tick: rooms.get(connection.roomId)?.match.tick || 0,
          });
          return;
        }
        if (message.type === 'list') {
          sendList(connection);
          return;
        }
        if (message.type === 'create' || message.type === 'join') {
          try {
            if (connection.actorId !== null) throw new Error('ALREADY_JOINED');
            let room;
            if (message.type === 'create') {
              if (rooms.size >= config.maxRooms) throw new Error('SERVER_FULL');
              room = new SampleRoom(config, now, {
                id: ++nextRoomId,
                mode: message.mode,
                teamSize: message.teamSize,
                password: message.password || '',
              });
              rooms.set(room.id, room);
            } else {
              room = rooms.get(message.roomId);
              if (!room)
                throw new Error(message.roomId <= nextRoomId ? 'ROOM_ENDED' : 'ROOM_NOT_FOUND');
              if (room.password !== (message.password || '')) throw new Error('WRONG_PASSWORD');
            }
            room.join(connection, message.name.trim() || '玩家', message.primary || 'm4a1');
          } catch (error) {
            send(connection, { type: 'rejected', code: error.message });
            sendList(connection);
          }
          return;
        }
        if (message.type === 'leave') {
          leave(connection);
          send(connection, { type: 'left' });
          sendList(connection);
          return;
        }
        const room = rooms.get(connection.roomId);
        // Gameplay already in flight may arrive after settlement released the
        // room. It must not close the lobby transport or affect another room.
        if (!room || connection.actorId === null) return;
        if (message.type === 'resync') {
          if (++connection.resyncs > 2) throw new Error('RESYNC_LIMIT');
          room.resetBases(connection);
          room.publish();
          return;
        }
        if (message.type === 'loadout') {
          room.match.loadout(connection.actorId, message.primary);
          connection.inputs.clear();
          room.publish();
          return;
        }
        if (message.type === 'input') {
          room.acknowledgeBase(connection, message.baseAck);
          const actor = room.match.actors.find((value) => value.id === connection.actorId);
          const failure = connection.inputs.push(
            message,
            actor,
            room.match.stageId,
            room.match.tick,
            now(),
          );
          if (failure && failure !== 'OLD_INPUT') throw new Error(failure);
          return;
        }
        if (message.type === 'interrupt') {
          connection.inputs.clear();
          room.match.actors.find((value) => value.id === connection.actorId).activeInput = null;
          room.publish();
          return;
        }
        if (message.type === 'pause') room.match.pause(connection.actorId);
        if (message.type === 'resume') room.match.resume(connection.actorId, now());
        room.publish();
      } catch (error) {
        send(connection, { type: 'error', code: error.message });
        socket.close(1008, error.message.slice(0, 100));
      }
    });
  });
  function pulse(timeMs = now()) {
    const elapsed = Math.max(0, timeMs - lastPulse);
    lastPulse = timeMs;
    accumulator += elapsed;
    let steps = 0;
    while (accumulator >= 1000 / 60 && steps++ < 3) {
      for (const room of rooms.values()) {
        room.step(1 / 60, timeMs);
        if (room.match.phase === 'ended') removeRoom(room);
      }
      accumulator -= 1000 / 60;
    }
    if (accumulator > 1000 / 20) accumulator = 1000 / 20;
    for (const connection of clients) {
      for (const [id, sent] of connection.pendingPings)
        if (timeMs - sent > config.connectionTimeoutMs) connection.pendingPings.delete(id);
      if (timeMs - connection.lastPongMs > config.connectionTimeoutMs) {
        connection.socket.terminate();
        continue;
      }
      if (timeMs - connection.lastPingMs >= config.heartbeatMs) {
        connection.lastPingMs = timeMs;
        const payload = Buffer.alloc(4),
          id = (connection.pingId = (connection.pingId + 1) >>> 0);
        payload.writeUInt32BE(id);
        connection.pendingPings.set(id, timeMs);
        if (connection.pendingPings.size > 8)
          connection.pendingPings.delete(connection.pendingPings.keys().next().value);
        connection.socket.ping(payload);
      }
      connection.outbox.flush();
    }
  }
  return {
    server,
    clients,
    rooms,
    get room() {
      return rooms.values().next().value || null;
    },
    pulse,
    async start() {
      if (started) return server.address();
      if (closing) throw new Error('APP_CLOSED');
      try {
        await stat(resolve(staticRoot, 'index.html'));
      } catch (cause) {
        throw new Error('ONLINE_PAGE_MISSING: run npm run build', { cause });
      }
      await new Promise((done, fail) => {
        server.once('error', fail);
        server.listen(config.port, config.host, () => {
          server.off('error', fail);
          done();
        });
      });
      started = true;
      lastPulse = now();
      if (autoTick) timer = setInterval(() => pulse(), 4);
      return server.address();
    },
    close() {
      closing ||= (async () => {
        started = false;
        clearInterval(timer);
        for (const room of rooms.values()) room.close();
        rooms.clear();
        for (const client of clients) {
          client.outbox.clear();
          client.pendingPings.clear();
          client.socket.terminate();
        }
        clients.clear();
        await new Promise((done) => wss.close(() => done()));
        if (server.listening)
          await new Promise((done) => {
            server.close(done);
            server.closeAllConnections();
          });
      })();
      return closing;
    },
  };
}
