import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { WebSocket } from 'ws';
import { spawnSync } from 'node:child_process';
import { readConfig } from '../../server/config.js';
import { Prediction } from '../../src/net/prediction.js';
import { World } from '../../src/sim/physics.js';
import { createShipLayout, SEA_Y } from '../../src/sim/maps/ship-layout.js';
import { builtIdentity } from './source.mjs';

const identity = await builtIdentity();
globalThis.HARBOR_BUILD_ID = identity.build;
globalThis.HARBOR_RULES_ID = identity.rules;
const [{ createApp }, { OnlineSession }, { INPUT_FLAGS }] = await Promise.all([
  import('../../server/app.js'),
  import('../../src/net/session.js'),
  import('../../src/protocol/messages.js'),
]);

const option = (name) =>
  process.argv.find((s) => s.startsWith(`--${name}=`))?.slice(name.length + 3);
const out = resolve(option('out')),
  hz = Number(option('hz')),
  profile = option('profile');
const traceTcp = option('trace') === 'tcp';
const tcpTuning = option('tcp-tuning') || 'none';
assert.equal(process.versions.node.split('.')[0], '24');
assert.notEqual(process.getuid(), 0, 'Application is not a root process');
await mkdir(out, { recursive: true });
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(check, label, timeout = 7000) {
  const end = performance.now() + timeout;
  while (!(await check())) {
    if (performance.now() > end) throw new Error('Timed out: ' + label);
    await pause(20);
  }
}
function statistics(values) {
  if (!values.length) return null;
  const sorted = values.toSorted((a, b) => a - b);
  return {
    count: values.length,
    mean: values.reduce((a, b) => a + b, 0) / values.length,
    p50: sorted[Math.floor(sorted.length * 0.5)],
    p95: sorted[Math.floor(sorted.length * 0.95)],
    p99: sorted[Math.floor(sorted.length * 0.99)],
    max: sorted.at(-1),
  };
}
function world() {
  const result = new World();
  for (const collider of createShipLayout().colliders) result.add(collider);
  result.build();
  result.setWaterLevel(SEA_Y);
  return result;
}
const report = {
  id: 'S3-E2',
  identity,
  profile,
  hz,
  seed: 4207,
  faultSeed: Number(option('seed') || 4207),
  topology: option('topology') || 'loopback',
  node: process.version,
  uid: process.getuid(),
  errors: [],
  shots: [],
  steps: [],
  pulses: [],
  max: {
    inputQueue: 0,
    importantCount: 0,
    importantBytes: 0,
    socketBuffered: 0,
    history: 0,
    rss: 0,
    predictionPending: 0,
  },
  notes: [
    'Headless real client logic, not rendered gameplay or device acceptance',
    'TCP socket bytes exclude IP/link headers and retransmissions; kernel counters are separate',
  ],
};
const app = createApp({
  config: readConfig({ PORT: '0', SNAPSHOT_HZ: String(hz) }),
  autoTick: false,
});
const peers = [],
  loopDelay = monitorEventLoopDelay({ resolution: 10 });
const previous = { WebSocket: globalThis.WebSocket, location: globalThis.location };
let loop,
  authorityTimer,
  started = null,
  lastLoop = performance.now(),
  accumulator = 0,
  port = 45931;
try {
  const address = await app.start();
  globalThis.location = { protocol: 'http:', host: `127.0.0.1:${address.port}` };
  globalThis.WebSocket = class extends WebSocket {
    constructor(url) {
      super(url, { localPort: port++, family: 4 });
    }
  };
  for (let i = 0; i < 2; i++) {
    const peer = {
      index: i,
      intervals: [],
      ages: [],
      corrections: [],
      rtts: [],
      wireOut: 0,
      wireIn: 0,
      snapshots: 0,
      acks: [],
      effects: [],
      positions: [],
      observations: [],
      displayObservations: [],
      sentFrames: [],
      displaySamples: { total: 0, held: 0, maxAgeMs: 0 },
      sampled: [],
      lastSnapshotAt: null,
      closed: null,
    };
    const prediction = (peer.prediction = new Prediction(world(), (event) => {
      if (event.type === 'shot') peer.effects.push(`${event.actor.lifeId}:${event.shot.shotSeq}`);
    }));
    const session = (peer.session = new OnlineSession({
      onStatus: (status) => {
        peer.status = status;
        if (status === '时钟同步超时，请重新加入')
          peer.clockFailure = {
            outstanding: session.clocks.size,
            oldestAgeMs: performance.now() - Math.min(...session.clocks.values()),
          };
      },
      onJoined() {},
      onClose: (reason) => {
        peer.closed = reason;
        peer.closedAtMs = started === null ? null : performance.now() - started;
        peer.closedStateAgeMs = session.snapshot
          ? session.serverNow() - session.snapshot.nowMs
          : null;
        peer.closedReceiveAgeMs =
          session.receivedAt === undefined ? null : performance.now() - session.receivedAt;
      },
      onEvent() {},
      onSnapshot: (snapshot, own) => {
        const committedAt = performance.now();
        const changed = prediction.reconcile(snapshot, own);
        if (changed) {
          prediction.clear();
          session.clear();
        }
        if (started !== null) {
          const now = performance.now();
          assert.ok(peer.observations.length < 2000, 'observation bound');
          peer.observations.push({
            seq: snapshot.snapshotSeq,
            tick: snapshot.tick,
            stageId: snapshot.stageId,
            phase: snapshot.phase,
            nowMs: snapshot.nowMs,
            ackSeq: own.ackSeq,
            arrivedAtMs: peer.wireAt - started,
            decodedAtMs: peer.decodedAt - started,
            committedAtMs: committedAt - started,
            appliedAtMs: now - started,
            actualArrivalAgeMs: peer.wireAt - snapshot.nowMs,
            actualAppliedAgeMs: now - snapshot.nowMs,
            estimatedAgeMs: session.serverNow() - snapshot.nowMs,
            offsetErrorMs: session.serverNow() - performance.now(),
            decodeMs: peer.decodedAt - peer.wireAt,
            commitMs: committedAt - peer.decodedAt,
            predictionMs: now - committedAt,
            regularTick: snapshot.tick % (60 / session.config.snapshotHz) === 0,
          });
          if (peer.lastSnapshotAt !== null) peer.intervals.push(now - peer.lastSnapshotAt);
          peer.lastSnapshotAt = now;
          peer.snapshots++;
          peer.ages.push(session.serverNow() - snapshot.nowMs);
          peer.corrections.push(prediction.correction);
          peer.positions.push(own.state.pos);
          peer.rtts.push(session.rttMs);
          const previousAck = peer.acks.at(-1)?.ack ?? 0;
          assert.ok(own.ackSeq >= previousAck, 'ack frontier must not go backwards');
          assert.equal(snapshot.snapshotSeq, own.snapshotSeq);
          peer.acks.push({
            tick: snapshot.tick,
            ack: own.ackSeq,
            life: own.state.fields.lifeId,
            stage: snapshot.stageId,
            at: now - started,
          });
        }
      },
    }));
    const receive = session.receive.bind(session);
    session.receive = (...args) => {
      peer.decodedAt = performance.now();
      return receive(...args);
    };
    peers.push(peer);
    session.connect(`实验${i}`);
    // Both the original JSON client and binary client share this transport
    // entry. Observe before either client's own message listener decodes it.
    session.socket.prependListener('message', () => {
      peer.wireAt = performance.now();
    });
    await until(() => session.ready, 'lobby ready');
    session.send(
      i === 0
        ? { type: 'create', name: `实验${i}`, mode: 'tdm', teamSize: profile === 'backlog' ? 8 : 4 }
        : { type: 'join', name: `实验${i}`, roomId: app.room.id },
    );
    await until(() => session.snapshot && session.offsetMs !== null, 'peer joins');
    const send = session.socket.send.bind(session.socket);
    session.socket.send = (wire) => {
      if (started !== null) peer.wireOut += Buffer.byteLength(wire);
      return send(wire);
    };
    session.socket.on('message', (wire) => {
      if (started !== null) peer.wireIn += wire.length;
    });
  }
  const room = app.room,
    match = room.match,
    connections = [...room.connections.values()];
  if (tcpTuning !== 'none') {
    assert.ok(
      hz === 30 && profile === 'interruption' && traceTcp && option('topology') === 'ingress',
    );
    const fds = [
      connections[0].socket,
      connections[1].socket,
      peers[0].session.socket,
      peers[1].session.socket,
    ].map((s) => s._socket._handle.fd);
    const tuned = spawnSync('python3', [resolve('scripts/s3/tcp_options.py'), tcpTuning], {
      stdio: ['ignore', 'pipe', 'pipe', ...fds],
      encoding: 'utf8',
      timeout: 3000,
    });
    assert.equal(tuned.status, 0, tuned.stderr);
    report.tcpOptions = JSON.parse(tuned.stdout);
    assert.equal(report.tcpOptions.mode, tcpTuning);
    assert.equal(report.tcpOptions.scopeVerified, true);
    assert.ok(
      Object.values(report.tcpOptions.before).every(
        (s) => s.rtoMinUs === 200000 && s.delackMaxUs === 200000 && s.rtoMaxMs === 120000,
      ),
      'Baseline socket defaults differ from the registered experiment',
    );
  }
  report.initialPositions = [];
  for (const [i, connection] of connections.entries()) {
    const actor = match.actors.find((actor) => actor.id === connection.actorId);
    actor.pos.set(-3, 0, i === 0 ? 6.8 : -6.8);
    actor.vel.set(0, 0, 0);
    actor.yaw = -Math.PI / 2;
    actor.pitch = -0.1;
    report.initialPositions.push({ id: actor.id, pos: actor.pos.toArray() });
    connection.socket.once('close', () => {
      report.serverCloses ||= [];
      report.serverCloses.push({
        peer: i,
        at: started === null ? null : performance.now() - started,
        pongAgeMs: performance.now() - connection.lastPongMs,
        blockedAt: connection.outbox.blockedAt,
        blockedDurationMs:
          connection.outbox.blockedAt === null
            ? null
            : performance.now() - connection.outbox.blockedAt,
        cleanup: report.cleanupStartedAtMs !== undefined,
      });
    });
  }
  if (profile === 'backlog') {
    // Only this duplicated test socket is changed; no host/namespace sysctl.
    // Small optimized packets otherwise fit in the kernel buffer until the
    // independent heartbeat policy closes it, never reaching the Outbox.
    const tuned = spawnSync(
      'python3',
      [
        '-c',
        'import socket,json; s=socket.socket(fileno=3); s.setsockopt(socket.SOL_SOCKET,socket.SO_SNDBUF,16384); print(json.dumps({"requested":16384,"actual":s.getsockopt(socket.SOL_SOCKET,socket.SO_SNDBUF)}))',
      ],
      {
        stdio: ['ignore', 'pipe', 'pipe', connections[0].socket._socket._handle.fd],
        encoding: 'utf8',
        timeout: 3000,
      },
    );
    assert.equal(tuned.status, 0, tuned.stderr);
    report.transportFixture = {
      scope: 'impaired server TCP socket only',
      sendBuffer: JSON.parse(tuned.stdout),
    };
    for (const actor of match.actors.filter((actor) => actor.controlType === 'bot')) {
      const attacker = match.actors.find(
        (other) => other.controlType === 'human' && other.team !== actor.team,
      );
      actor.protectT = 0;
      match.damage(
        actor,
        attacker,
        10000,
        'chest',
        'm4a1',
        attacker.vel.clone().set(1, 0, 0),
        false,
      );
    }
    report.loadFixture =
      '14 real bot deaths in an 8v8 room; normal corpse simulation and respawn timers unchanged';
  }
  room.publish();
  report.authorityMovement = [0, 0];
  report.inputConsumption = connections.map(() => ({
    fresh: 0,
    reused: 0,
    empty: 0,
    discarded: 0,
    maxAgeMs: 0,
  }));
  for (const [i, connection] of connections.entries()) {
    const consume = connection.inputs.consume.bind(connection.inputs);
    connection.inputs.consume = (...args) => {
      const beforeDiscard = connection.inputs.discarded,
        frame = consume(...args);
      if (started !== null) {
        const metric = report.inputConsumption[i];
        metric[frame ? (frame.reused ? 'reused' : 'fresh') : 'empty']++;
        metric.discarded += connection.inputs.discarded - beforeDiscard;
        if (frame) metric.maxAgeMs = Math.max(metric.maxAgeMs, args[3] - frame.createdAtMs);
      }
      return frame;
    };
  }
  const events = match.onEvent;
  report.inputExecutions = [];
  for (const connection of connections) {
    const actor = match.actors.find((value) => value.id === connection.actorId),
      update = actor.update.bind(actor);
    actor.update = (...args) => {
      const result = update(...args);
      if (started !== null && actor.activeInput && !actor.activeInput.reused) {
        assert.ok(report.inputExecutions.length < 2000, 'input execution bound');
        report.inputExecutions.push({
          actorId: actor.id,
          seq: actor.activeInput.seq,
          tick: match.tick,
          atMs: performance.now() - started,
          lifeId: actor.lifeId,
        });
      }
      return result;
    };
  }
  report.queries = [];
  const resolveTargets = match.resolveTargets;
  match.resolveTargets = (actor, frame) => {
    const selected = resolveTargets(actor, frame),
      ref = frame?.display;
    const a = ref && room.history.samples.find((sample) => sample.snapshotSeq === ref.a);
    const b = ref && room.history.samples.find((sample) => sample.snapshotSeq === ref.b);
    if (started !== null)
      report.queries.push({
        actorId: actor.id,
        life: actor.lifeId,
        shotSeq: actor.shotSeq,
        path: selected.path,
        reason: selected.reason,
        ageMs: a && b ? performance.now() - (a.nowMs + (b.nowMs - a.nowMs) * ref.alpha) : null,
      });
    return selected;
  };
  match.onEvent = (event) => {
    if (started !== null && event.type === 'shot')
      report.shots.push({ ...event, at: performance.now() - started });
    return events(event);
  };
  const step = match.step.bind(match);
  match.step = (dt, now, inputs) => {
    const before = performance.now();
    const positions = connections.map((connection) => {
      const actor = match.actors.find((actor) => actor.id === connection.actorId);
      return actor && { pos: actor.pos.clone(), life: actor.lifeId, alive: actor.alive };
    });
    for (const frame of inputs.values())
      if (frame?.input.fire && now - frame.createdAtMs > 250 + 0.001)
        report.errors.push({
          reason: 'stale held fire',
          tick: match.tick + 1,
          ageMs: now - frame.createdAtMs,
        });
    const result = step(dt, now, inputs);
    if (started !== null)
      for (const [i, connection] of connections.entries()) {
        const actor = match.actors.find((actor) => actor.id === connection.actorId),
          previous = positions[i],
          input = inputs.get(connection.actorId)?.input;
        if (
          actor?.alive &&
          previous?.alive &&
          actor.lifeId === previous.life &&
          (input?.moveX || input?.moveZ)
        )
          report.authorityMovement[i] += Math.hypot(
            actor.pos.x - previous.pos.x,
            actor.pos.z - previous.pos.z,
          );
      }
    if (started !== null)
      report.steps.push({ tick: match.tick, ms: performance.now() - before, at: before - started });
    return result;
  };
  const rawSockets = connections.map((c) => c.socket._socket);
  if (traceTcp) {
    report.tcpWrites = [];
    const connection = connections[0],
      ws = connection.socket,
      raw = rawSockets[0],
      send = ws.send.bind(ws),
      latest = connection.outbox.latest.bind(connection.outbox),
      metadata = new WeakMap();
    report.tcpFlow = { serverPort: raw.localPort, clientPort: raw.remotePort };
    connection.outbox.latest = (data, onSent) => {
      const state = room.history.samples.at(-1);
      assert.ok(ArrayBuffer.isView(data));
      metadata.set(data, {
        snapshotSeq: state.snapshotSeq,
        tick: state.tick,
        nowMs: state.nowMs,
        queuedAtMs: performance.now(),
      });
      return latest(data, onSent);
    };
    ws.send = (data, ...args) => {
      const before = raw.bytesWritten,
        at = performance.now(),
        result = send(data, ...args),
        size = Buffer.byteLength(data),
        end = raw.bytesWritten;
      assert.equal(
        end - before,
        size + (size < 126 ? 2 : size < 65536 ? 4 : 10),
        'trace requires one unmasked, uncompressed WebSocket frame per send',
      );
      assert.ok(report.tcpWrites.length < 12000, 'TCP write trace bound');
      report.tcpWrites.push({
        startByte: before,
        endByte: end,
        sendAtMs: at,
        afterSendAtMs: performance.now(),
        bufferedAmount: ws.bufferedAmount,
        ...(metadata.get(data) || {}),
      });
      return result;
    };
  }
  await writeFile(resolve(out, 'ready.json'), '{}');
  await until(async () => {
    try {
      await readFile(resolve(out, 'network-ready.json'));
      return true;
    } catch {
      return false;
    }
  }, 'kernel injection ready');
  authorityTimer = setInterval(() => {
    const at = performance.now();
    app.pulse();
    if (started !== null) report.pulses.push(performance.now() - at);
  }, 4);
  loop = setInterval(() => {
    const now = performance.now();
    accumulator += Math.min(50, now - lastLoop);
    lastLoop = now;
    while (accumulator >= 1000 / 60) {
      accumulator -= 1000 / 60;
      for (const peer of peers) {
        const s = peer.session,
          p = peer.prediction,
          elapsed = started === null ? -1 : now - started;
        if (peer.closed || s.snapshot?.phase !== 'running' || !p.actor?.alive) continue;
        const sample = s.sample();
        if (started !== null && sample) {
          peer.displaySamples.total++;
          if (sample.display.a === sample.display.b) peer.displaySamples.held++;
          const endpoint = s.buffer.samples.find(
            (snapshot) => snapshot.snapshotSeq === sample.display.a,
          );
          if (endpoint)
            peer.displaySamples.maxAgeMs = Math.max(
              peer.displaySamples.maxAgeMs,
              s.serverNow() - endpoint.nowMs,
            );
          const a = s.buffer.samples.find((value) => value.snapshotSeq === sample.display.a),
            b = s.buffer.samples.find((value) => value.snapshotSeq === sample.display.b);
          if (a && b) {
            assert.ok(peer.displayObservations.length < 2000, 'display observation bound');
            const sampleTimeMs = a.nowMs + (b.nowMs - a.nowMs) * sample.display.alpha;
            peer.displayObservations.push({
              atMs: performance.now() - started,
              ...sample.display,
              sampleTimeMs,
              stageId: a.stageId,
              actualAgeMs: performance.now() - sampleTimeMs,
            });
          }
        }
        if (profile === 'interruption' && peer.index === 0 && elapsed >= 800 && elapsed < 1350)
          continue;
        const active = elapsed >= 0 && elapsed < 4000;
        const input = {
          yaw: p.actor.yaw,
          pitch: -0.1,
          moveX: active ? 0.25 : 0,
          moveZ: 0,
          ...Object.fromEntries(INPUT_FLAGS.map((flag) => [flag, false])),
          fire: active && elapsed >= 300,
          reload: elapsed >= 4300 && !peer.reloadRequested,
        };
        if (input.reload) peer.reloadRequested = true;
        const frame = s.frame(input);
        if (frame) {
          try {
            p.submit(frame);
            const sent = s.send(frame);
            if (started !== null && sent) {
              assert.ok(peer.sentFrames.length < 2000, 'sent frame observation bound');
              peer.sentFrames.push({ seq: frame.seq, atMs: performance.now() - started });
            }
          } catch (error) {
            s.fail(error.message);
          }
        }
        report.max.predictionPending = Math.max(report.max.predictionPending, p.pending.length);
      }
    }
    if (started !== null)
      for (const connection of app.clients) {
        report.max.inputQueue = Math.max(
          report.max.inputQueue,
          connection.inputs?.queue.length || 0,
        );
        report.max.importantCount = Math.max(
          report.max.importantCount,
          connection.outbox.important.length,
        );
        report.max.importantBytes = Math.max(report.max.importantBytes, connection.outbox.bytes);
        report.max.socketBuffered = Math.max(
          report.max.socketBuffered,
          connection.socket.bufferedAmount,
        );
        report.max.history = Math.max(report.max.history, room.history.samples.length);
        report.max.rss = Math.max(report.max.rss, process.memoryUsage().rss);
      }
  }, 4);
  await pause(2000);
  const socketStarts = rawSockets.map((socket) => ({
    out: socket.bytesWritten,
    in: socket.bytesRead,
  }));
  started = performance.now();
  report.startedAtMs = started;
  const monotonicAt = Number(process.hrtime.bigint()) / 1e6;
  report.monotonicStartMs = monotonicAt - (performance.now() - started);
  for (const peer of peers) peer.initialNowMs = peer.session.snapshot.nowMs;
  loopDelay.enable();
  const uptime = Number((await readFile('/proc/uptime', 'utf8')).split(' ')[0]) * 1000;
  await writeFile(
    resolve(out, 'sampling.tmp'),
    JSON.stringify({
      uptimeMs: uptime,
      monotonicMs: report.monotonicStartMs,
    }),
  );
  await rename(resolve(out, 'sampling.tmp'), resolve(out, 'sampling.json'));
  await pause(['slow', 'backlog'].includes(profile) ? 9000 : 8000);
  clearInterval(loop);
  loopDelay.disable();
  report.durationMs = performance.now() - started;
  report.peers = peers.map((peer, i) => ({
    index: i,
    actorId: peer.session.actorId,
    closed: peer.closed,
    status: peer.status,
    closedAtMs: peer.closedAtMs,
    closedReceiveAgeMs: peer.closedReceiveAgeMs,
    clockFailure: peer.clockFailure,
    closedStateAgeMs: peer.closedStateAgeMs,
    displaySamples: peer.displaySamples,
    stateAgeMs: peer.session.snapshot
      ? peer.session.serverNow() - peer.session.snapshot.nowMs
      : null,
    snapshots: peer.snapshots,
    inputSeq: peer.session.seq,
    ackStart: peer.acks[0],
    ackEnd: peer.acks.at(-1),
    acks: peer.acks,
    initialNowMs: peer.initialNowMs,
    observations: peer.observations,
    displayObservations: peer.displayObservations,
    sentFrames: peer.sentFrames,
    receiveIntervalMs: statistics(peer.intervals),
    stateAgeDistributionMs: statistics(peer.ages),
    correctionMetres: statistics(peer.corrections),
    rttMs: statistics(peer.rtts),
    appBytes: { out: peer.wireOut, in: peer.wireIn },
    serverSocketBytes: {
      out: rawSockets[i].bytesWritten - socketStarts[i].out,
      in: rawSockets[i].bytesRead - socketStarts[i].in,
    },
    localShotEffects: peer.effects.length,
    uniqueLocalShotEffects: new Set(peer.effects).size,
    maxPositionChange: Math.max(
      0,
      ...peer.positions.map((pos) =>
        Math.hypot(...pos.map((value, j) => value - peer.positions[0][j])),
      ),
    ),
  }));
  for (const peer of report.peers) {
    if (profile !== 'backlog' || peer.index === 1) assert.ok(peer.snapshots > 0);
    assert.equal(peer.localShotEffects, peer.uniqueLocalShotEffects, 'feedback deduplication');
  }
  const healthy = report.peers[1];
  assert.equal(healthy.closed, null, 'healthy peer remains connected');
  assert.ok(healthy.ackEnd.tick - healthy.ackStart.tick >= 400, 'healthy authority progresses');
  assert.ok(healthy.inputSeq > 100, 'healthy input continues');
  assert.ok(report.authorityMovement[1] > 0.2, 'actual movement occurred');
  assert.ok(
    report.shots.some((shot) => shot.actorId === healthy.actorId),
    'actual authority fire occurred',
  );
  if (profile === 'slow' || profile === 'backlog') {
    await until(() => app.clients.size === 1, 'sustained slow peer removed');
    assert.equal(room.match.actors.length, profile === 'backlog' ? 16 : 8);
    assert.equal(room.connections.size, 1);
    if (profile === 'slow') {
      const peer = report.peers[0];
      assert.ok(report.serverCloses?.some((c) => c.peer === 0 && !c.cleanup && c.at <= 6150));
      if (peer.closed === '时钟同步超时，请重新加入') {
        assert.equal(peer.clockFailure.outstanding, 8);
        assert.ok(peer.clockFailure.oldestAgeMs >= 7900 && peer.clockFailure.oldestAgeMs <= 8150);
        assert.ok(peer.closedStateAgeMs <= 6150 && peer.closedReceiveAgeMs <= 6150);
      } else {
        assert.equal(peer.closed, '状态同步超时，请重新加入');
        assert.ok(Math.max(peer.closedStateAgeMs, peer.closedReceiveAgeMs) >= 6000);
        assert.ok(Math.max(peer.closedStateAgeMs, peer.closedReceiveAgeMs) <= 6150);
      }
    }
    if (profile === 'backlog') {
      assert.ok(
        report.max.socketBuffered > app.room.config.maxBufferedBytes,
        'actual transport backlog exceeds configured threshold',
      );
      assert.ok(
        report.serverCloses?.some(
          (close) =>
            close.peer === 0 &&
            close.blockedDurationMs > room.config.maxBacklogMs &&
            !close.cleanup,
        ),
        'server closes sustained backlog',
      );
    }
  } else {
    assert.equal(report.peers[0].closed, null, 'impaired peer remains connected');
    assert.ok(report.authorityMovement[0] > 0.2, 'impaired peer actually moves');
    assert.ok(
      report.shots.some((shot) => shot.actorId === report.peers[0].actorId),
      'impaired peer actually fires',
    );
  }
  assert.ok(
    report.max.inputQueue <= 64 &&
      report.max.importantCount <= 128 &&
      report.max.importantBytes <= 65536 &&
      report.max.history <= 32 &&
      report.max.predictionPending <= 128,
  );
  const byLife = new Map();
  for (const shot of report.shots.filter((s) =>
    peers.some((p) => p.session.actorId === s.actorId),
  )) {
    const key = `${shot.actorId}:${shot.lifeId}`,
      previousShot = byLife.get(key);
    if (previousShot) assert.ok(shot.tick - previousShot.tick >= 6, 'no catchup fire burst');
    byLife.set(key, shot);
  }
  if (profile === 'interruption') {
    const impairedId = report.peers[0].actorId;
    assert.equal(
      report.shots.filter(
        (shot) => shot.actorId === impairedId && shot.at >= 1150 && shot.at <= 1300,
      ).length,
      0,
      'input silence stops automatic fire',
    );
  }
  report.shotPaths = Object.fromEntries(
    ['history', 'current'].map((path) => [
      path,
      report.shots.filter((shot) => shot.path === path).length,
    ]),
  );
  report.fallbackReasons = {};
  for (const shot of report.shots.filter((shot) => shot.reason))
    report.fallbackReasons[shot.reason] = (report.fallbackReasons[shot.reason] || 0) + 1;
  report.stepTimeMs = statistics(report.steps.map((s) => s.ms));
  report.pulseTimeMs = statistics(report.pulses);
  const first = report.steps[0];
  report.scheduleLatenessMs = statistics(
    report.steps.map((step) =>
      Math.max(0, step.at - first.at - ((step.tick - first.tick) * 1000) / 60),
    ),
  );
  assert.deepEqual(report.errors, []);
  report.eventLoopMs = {
    mean: loopDelay.mean / 1e6,
    p95: loopDelay.percentile(95) / 1e6,
    max: loopDelay.max / 1e6,
  };
  const ageLimits = {
    rtt0: [50, 100, 150],
    rtt50: [100, 150, 200],
    rtt100: [150, 250, 350],
    rtt150: [200, 300, 400],
    jitter: [250, 500, 750],
    loss: [500, 1500, 2000],
    interruption: [1500, 2000, 3000],
  };
  report.qualityLimits = {
    profile: ageLimits[profile] || null,
    healthy: ageLimits.rtt0,
    source:
      'registered before formal weak-network measurement; delay presets and existing 3s recovery/6s exit bounds',
  };
  report.qualityPassed = report.peers.every((p, i) => {
    if (i === 0 && ['slow', 'backlog'].includes(profile))
      return !!p.closed && (profile === 'slow' || p.closedAtMs === null || p.closedAtMs <= 6150);
    const limit = i === 0 ? ageLimits[profile] : ageLimits.rtt0;
    return (
      !p.closed &&
      p.stateAgeDistributionMs?.p95 <= limit[0] &&
      p.stateAgeDistributionMs.p99 <= limit[1] &&
      p.receiveIntervalMs?.max <= limit[2]
    );
  });
  assert.ok(
    report.qualityPassed,
    'weak-network state age or healthy-connection stall exceeds registered bounds',
  );
  report.passed = true;
} catch (error) {
  report.failure = error.stack;
  throw error;
} finally {
  clearInterval(loop);
  clearInterval(authorityTimer);
  report.cleanupStartedAtMs = started === null ? null : performance.now() - started;
  loopDelay.disable();
  for (const peer of peers) {
    peer.session.close();
    peer.session.socket?.terminate();
  }
  await app.close();
  report.cleanup = {
    clients: app.clients.size,
    roomReleased: app.room === null,
    listening: app.server.listening,
  };
  globalThis.WebSocket = previous.WebSocket;
  if (previous.location === undefined) delete globalThis.location;
  else globalThis.location = previous.location;
  await writeFile(resolve(out, 'report.json'), JSON.stringify(report, null, 2));
}
console.log(
  JSON.stringify({
    profile,
    hz,
    passed: report.passed,
    rtt: report.peers.map((p) => p.rttMs?.p50),
    correctionP95: report.peers.map((p) => p.correctionMetres?.p95),
    maxBuffered: report.max.socketBuffered,
  }),
);
