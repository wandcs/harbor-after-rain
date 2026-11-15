import { setImmediate } from 'node:timers';
import { performance, monitorEventLoopDelay, PerformanceObserver } from 'node:perf_hooks';
import os from 'node:os';
import { createApp } from '../../server/app.js';
import { readConfig } from '../../server/config.js';
import { builtIdentity } from '../s3/source.mjs';

const options = JSON.parse(process.argv[2]);
const identity = await builtIdentity();
const config = readConfig({
  PORT: '0',
  SNAPSHOT_HZ: String(options.hz),
  ...(options.productionLimits ? {} : { MAX_ROOMS: '8', MAX_CONNECTIONS: '64' }),
});
const app = createApp({
  config,
  identity,
  autoTick: false,
});
const loopDelay = monitorEventLoopDelay({ resolution: 10 });
loopDelay.enable();
let active = null,
  currentGroups = null,
  forcedCalls = 0;
const creations = [],
  weak = [],
  tracked = new WeakSet(),
  gc = [];
const observer = new PerformanceObserver((list) => {
  for (const e of list.getEntries()) {
    gc.push({ at: e.startTime, ms: e.duration });
    if (gc.length > 4096) gc.shift();
  }
});
observer.observe({ entryTypes: ['gc'] });
const boundedPush = (array, value) => {
  if (array.length >= 50000) throw new Error('measurement sample bound exceeded');
  array.push(value);
};
const stats = (values) => {
  const a = [...values].sort((a, b) => a - b),
    at = (p) => (a.length ? a[Math.min(a.length - 1, Math.ceil(a.length * p) - 1)] : null);
  return {
    count: a.length,
    mean: a.length ? a.reduce((s, n) => s + n, 0) / a.length : null,
    p95: at(0.95),
    p99: at(0.99),
    max: a.at(-1) ?? null,
  };
};
function track(room) {
  if (tracked.has(room)) return;
  tracked.add(room);
  for (const object of [room, room.match, room.match.world, room.match.nav])
    weak.push(new WeakRef(object));
  if (weak.length > 1024) throw new Error('weak reference bound exceeded');
  const original = room.step.bind(room),
    id = room.id;
  const emit = room.match.emit.bind(room.match);
  room.match.emit = (type, data) => {
    if (active) active.events[type] = (active.events[type] || 0) + 1;
    return emit(type, data);
  };
  room.step = (...args) => {
    if (!active) return original(...args);
    const before = performance.now(),
      ordinal = currentGroups.counts.get(id) || 0;
    const result = original(...args),
      ms = performance.now() - before;
    currentGroups.counts.set(id, ordinal + 1);
    currentGroups.ms[ordinal] = (currentGroups.ms[ordinal] || 0) + ms;
    boundedPush((active.rooms[id] ||= []), ms);
    return result;
  };
}
app.server.on('upgrade', () => {
  for (const connection of app.clients) {
    if (connection.measured) continue;
    connection.measured = true;
    for (const original of connection.socket.listeners('message')) {
      connection.socket.off('message', original);
      connection.socket.on('message', (...args) => {
        const before = performance.now(),
          count = app.rooms.size;
        original(...args);
        if (app.rooms.size > count) {
          creations.push({ roomId: connection.roomId, ms: performance.now() - before, at: before });
          if (creations.length > 512) throw new Error('creation measurement bound exceeded');
        }
        const room = app.rooms.get(connection.roomId);
        if (room) track(room);
      });
    }
  }
});
function snapshot() {
  return {
    rooms: app.rooms.size,
    clients: app.clients.size,
    tick: app.room?.match.tick ?? null,
    queues: [...app.clients].map((c) => ({
      joined: c.actorId !== null,
      input: c.inputs?.queue.length || 0,
      held: !!c.inputs?.held,
      historyRefs: c.sentSnapshots?.size || 0,
      important: c.outbox.important.length,
      importantBytes: c.outbox.bytes,
      buffered: c.socket.bufferedAmount,
      latest: !!c.outbox.snapshot,
      bases: [c.activeBase, c.offeredBase].filter(Boolean).length,
      baseBytes: [c.activeBase, c.offeredBase].reduce((n, b) => n + (b?.bytes.length || 0), 0),
      blockedAgeMs: c.outbox.blockedAt === null ? 0 : performance.now() - c.outbox.blockedAt,
    })),
    history: [...app.rooms.values()].map((r) => r.history.samples.length),
    socketBytes: {
      out: [...app.clients].reduce((n, c) => n + c.socket._socket.bytesWritten, 0),
      in: [...app.clients].reduce((n, c) => n + c.socket._socket.bytesRead, 0),
    },
    connections: [...app.clients].map((c) => ({
      actorId: c.actorId,
      roomId: c.roomId,
      down: c.socket._socket.bytesWritten,
      up: c.socket._socket.bytesRead,
    })),
    phases: [...app.rooms.values()].map((r) => r.match.phase),
    memory: process.memoryUsage(),
    resources: process.getActiveResourcesInfo(),
  };
}
let lastPulse = performance.now();
const timer = setInterval(() => {
  const before = performance.now(),
    lag = Math.max(0, before - lastPulse - 4);
  lastPulse = before;
  currentGroups = { ms: [], counts: new Map() };
  app.pulse();
  if (active) {
    const ms = performance.now() - before,
      sum = currentGroups.ms.reduce((s, n) => s + n, 0);
    boundedPush(active.pulse, ms);
    boundedPush(active.timerLag, lag);
    for (const value of currentGroups.ms)
      boundedPush(active.totalSteps, value + Math.max(0, ms - sum) / currentGroups.ms.length);
    if (before - active.lastSample >= 50) {
      active.lastSample = before;
      const s = snapshot();
      active.max.rss = Math.max(active.max.rss, s.memory.rss);
      for (const q of s.queues)
        for (const key of [
          'input',
          'historyRefs',
          'important',
          'importantBytes',
          'buffered',
          'bases',
          'baseBytes',
          'blockedAgeMs',
          'latest',
        ])
          active.max[key] = Math.max(active.max[key] || 0, q[key]);
      active.max.history = Math.max(active.max.history || 0, ...s.history);
      if (before - active.windowAt >= 1000) {
        boundedPush(active.windows, {
          ms: before - active.windowAt,
          connections: s.connections.map((c) => {
            const base = active.windowBase.find(
              (v) => v.actorId === c.actorId && v.roomId === c.roomId,
            );
            return {
              actorId: c.actorId,
              roomId: c.roomId,
              downKBps: (c.down - (base?.down || 0)) / (before - active.windowAt),
              upKBps: (c.up - (base?.up || 0)) / (before - active.windowAt),
            };
          }),
        });
        active.windowAt = before;
        active.windowBase = s.connections;
      }
    }
  }
}, 4);
async function collect() {
  if (typeof globalThis.gc !== 'function') throw new Error('Worker requires --expose-gc');
  for (let i = 0; i < 3; i++) {
    await new Promise((done) => setImmediate(done));
    globalThis.gc();
    forcedCalls++;
  }
  await new Promise((done) => setImmediate(done));
  return {
    ...snapshot(),
    retainedObjects: weak.filter((r) => r.deref()).length,
    trackedObjects: weak.length,
    forcedCalls,
  };
}
const address = await app.start();
process.send({
  type: 'ready',
  url: `ws://127.0.0.1:${address.port}/ws`,
  identity,
  environment: {
    maxRooms: config.maxRooms,
    maxConnections: config.maxConnections,
    platform: os.platform(),
    release: os.release(),
    arch: os.arch(),
    node: process.version,
    cpu: os.cpus()[0]?.model,
    logicalCpus: os.cpus().length,
    memoryBytes: os.totalmem(),
  },
});
process.on('message', async (message) => {
  try {
    let value;
    if (message.type === 'begin') {
      loopDelay.reset();
      active = {
        started: performance.now(),
        cpu: process.cpuUsage(),
        start: snapshot(),
        rooms: {},
        events: {},
        windows: [],
        windowAt: performance.now(),
        windowBase: snapshot().connections,
        pulse: [],
        timerLag: [],
        totalSteps: [],
        lastSample: 0,
        max: { rss: process.memoryUsage().rss },
      };
      value = { started: active.started };
    } else if (message.type === 'finish') {
      const end = snapshot(),
        elapsedMs = performance.now() - active.started,
        cpu = process.cpuUsage(active.cpu);
      value = {
        elapsedMs,
        cpuCorePercent: (cpu.user + cpu.system) / elapsedMs / 10,
        stepHz: ((end.tick - active.start.tick) * 1000) / elapsedMs,
        totalStepMs: stats(active.totalSteps),
        pulseMs: stats(active.pulse),
        timerLagMs: stats(active.timerLag),
        roomStepMs: Object.fromEntries(
          Object.entries(active.rooms).map(([id, rows]) => [id, stats(rows)]),
        ),
        eventLoopDelayMs: {
          p95: loopDelay.percentile(95) / 1e6,
          p99: loopDelay.percentile(99) / 1e6,
          max: loopDelay.max / 1e6,
        },
        gc: stats(gc.filter((e) => e.at >= active.started).map((e) => e.ms)),
        events: active.events,
        windows: active.windows,
        max: active.max,
        start: active.start,
        end,
      };
      active = null;
    } else if (message.type === 'checkpoint') value = await collect();
    else if (message.type === 'state') value = { ...snapshot(), creations: [...creations] };
    else if (message.type === 'deadline') {
      for (const r of app.rooms.values()) r.match.time = 180 - 1 / 60;
      value = true;
    } else if (message.type === 'close') {
      clearInterval(timer);
      active = null;
      await app.close();
      loopDelay.disable();
      observer.disconnect();
      value = { ...(await collect()), listening: app.server.listening };
    } else throw new Error('Unknown worker command');
    process.send({ id: message.id, value });
    if (message.type === 'close') process.disconnect();
  } catch (e) {
    process.send({ id: message.id, error: e.stack });
  }
});
