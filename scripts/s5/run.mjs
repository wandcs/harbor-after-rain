import { fork } from 'node:child_process';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { builtIdentity } from '../s3/source.mjs';

const opts = {
  case: 'all',
  hz: null,
  load: null,
  rooms: null,
  'humans-per-room': null,
  'sample-ms': '6000',
  'warmup-ms': '2000',
  out: `artifacts/online-s5/run-${Date.now()}`,
};
for (let i = 2; i < process.argv.length; i++) {
  const m = process.argv[i].match(
    /^--(case|hz|load|rooms|humans-per-room|out|sample-ms|warmup-ms)(?:=(.*))?$/,
  );
  if (!m) throw new Error('Unknown option');
  const value = m[2] ?? process.argv[++i];
  if (!value || value.startsWith('--')) throw new Error('Missing option');
  opts[m[1]] = value;
}
const explicitHumanCounts = opts['humans-per-room']?.split(',').map(Number) || null;
if (explicitHumanCounts) {
  assert.equal(opts.case, 'S5-E1', 'Explicit human counts belong to S5-E1');
  assert.ok(explicitHumanCounts.length >= 1 && explicitHumanCounts.length <= 2);
  assert.ok(explicitHumanCounts.every((n) => Number.isInteger(n) && n >= 1 && n <= 10));
  assert.ok(
    explicitHumanCounts.reduce((sum, n) => sum + n, 0) <= 10,
    'Guaranteed scope is ten humans total',
  );
  assert.ok(
    !opts.rooms || Number(opts.rooms) === explicitHumanCounts.length,
    'Room count disagrees with human counts',
  );
  assert.ok(!opts.load || opts.load === 'mixed', 'Explicit human counts include bot replacement');
  opts.rooms = String(explicitHumanCounts.length);
  opts.load = 'mixed';
}
assert.ok(['all', 'S5-E1', 'S5-E2'].includes(opts.case), 'No selected S5 case');
assert.ok(opts.hz === null || ['60', '30'].includes(opts.hz));
assert.ok(opts.load === null || ['bots', 'humans', 'mixed'].includes(opts.load));
assert.ok(!opts.rooms || ['1', '2', '4', '8'].includes(opts.rooms));
assert.ok(opts.case !== 'S5-E2' || (!opts.load && !opts.rooms), 'Load selectors belong to S5-E1');
assert.ok(
  opts.rooms !== '8' || ['bots', 'mixed'].includes(opts.load),
  '8 rooms requires bots or mixed; full-human profile is bounded to 64 connections',
);
const out = resolve(opts.out);
const sampleMs = Number(opts['sample-ms']),
  warmupMs = Number(opts['warmup-ms']);
assert.ok(Number.isInteger(sampleMs) && sampleMs >= 6000 && sampleMs <= 65000);
assert.ok(Number.isInteger(warmupMs) && warmupMs >= 2000 && warmupMs <= 10000);
assert.ok(
  sampleMs < 20000 || opts.rooms || (!opts.load && opts.case !== 'S5-E2'),
  'Long samples require selected rooms or the default ten-human matrix',
);
await mkdir(out, { recursive: true });
const identity = await builtIdentity();
globalThis.HARBOR_BUILD_ID = identity.build;
globalThis.HARBOR_RULES_ID = identity.rules;
const { connectPeer, sleep, until } = await import('./peer.mjs');
const results = [];
async function run(id, hz, load, humanCounts = explicitHumanCounts) {
  const directory = resolve(
    out,
    id === 'S5-E1'
      ? `${id}-${hz}-${load}${humanCounts ? '-' + humanCounts.join('-') : ''}`
      : `${id}-${hz}`,
  );
  await mkdir(directory, { recursive: true });
  const report = {
    id,
    hz,
    load,
    identity,
    humanCounts,
    passed: false,
    limits: [
      'Local-machine engineering screening, not target-host capacity or physical-device acceptance',
      'Generator uses actual session frame/display but no renderer or predicted physics',
      'Forced GC occurs only at checkpoints; short sample does not prove long-term stability',
    ],
  };
  const child = fork(
    new URL('./worker.mjs', import.meta.url),
    [JSON.stringify({ hz, productionLimits: !!humanCounts })],
    {
      execArgv: ['--expose-gc'],
      silent: true,
      windowsHide: true,
    },
  );
  const watchdog = setTimeout(() => child.kill(), 120000);
  let log = '',
    serial = 0,
    ready,
    stopped = false,
    drive = null,
    timedOut;
  const pending = new Map(),
    peers = [];
  const workerReady = new Promise((done, fail) => {
    ready = { done, fail };
  });
  child.stdout.on('data', (x) => {
    log = (log + x).slice(-65536);
  });
  child.stderr.on('data', (x) => {
    log = (log + x).slice(-65536);
  });
  child.on('message', (m) => {
    if (m.type === 'ready') {
      report.environment = m.environment;
      ready.done(m);
    } else {
      const p = pending.get(m.id);
      if (p) {
        pending.delete(m.id);
        clearTimeout(p.timer);
        m.error ? p.fail(new Error(m.error)) : p.done(m.value);
      }
    }
  });
  child.on('exit', (code) => {
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.fail(new Error('worker exit ' + code));
    }
    pending.clear();
    ready.fail(new Error('worker exit before ready ' + code));
  });
  const rpc = (type) =>
    new Promise((done, fail) => {
      const id = ++serial,
        timer = setTimeout(() => {
          pending.delete(id);
          fail(new Error('worker timeout ' + type));
        }, 10000);
      pending.set(id, { done, fail, timer });
      child.send({ id, type });
    });
  let failure;
  try {
    const info = await Promise.race([
      workerReady,
      new Promise((_, fail) => {
        timedOut = setTimeout(() => fail(new Error('worker startup timeout')), 15000);
      }),
    ]);
    clearTimeout(timedOut);
    assert.deepEqual(info.identity, identity);
    const connect = async () => {
      const p = await connectPeer(info.url);
      p.sustained = sampleMs >= 20000;
      peers.push(p);
      return p;
    };
    const create = async (index, size = 8, mode = index % 2 ? 'relay' : 'tdm', p = null) => {
      p ||= await connect();
      await p.request({ type: 'create', name: 'load', mode, teamSize: size });
      await until(() => p.session.snapshot, 'initial snapshot');
      return p;
    };
    if (id === 'S5-E1') {
      const delay = monitorEventLoopDelay({ resolution: 10 });
      delay.enable();
      let lastDrive = performance.now(),
        late = 0,
        driveCalls = 0,
        accumulator = 0;
      drive = setInterval(() => {
        const now = performance.now(),
          elapsed = now - lastDrive;
        if (elapsed > 33.34) late++;
        accumulator += elapsed;
        lastDrive = now;
        driveCalls++;
        let steps = 0;
        while (accumulator >= 1000 / 60 && steps++ < 3) {
          accumulator -= 1000 / 60;
          for (const p of peers) p.step();
        }
        accumulator = Math.min(accumulator, 50);
      }, 4);
      const levels = humanCounts
        ? [humanCounts.length]
        : opts.rooms
          ? [Number(opts.rooms)]
          : load === 'bots'
            ? [1, 2, 4, 8]
            : load === 'mixed'
              ? [8]
              : [1, 2, 4];
      report.levels = [];
      let count = 0;
      try {
        for (const rooms of levels) {
          const roomHumans = Array.from(
            { length: rooms },
            (_, index) => humanCounts?.[index] ?? (load === 'bots' ? 1 : load === 'mixed' ? 8 : 16),
          );
          const before = await rpc('state');
          await rpc('begin');
          const start = performance.now();
          for (; count < rooms; count++) {
            const p = await create(count);
            if (roomHumans[count] > 1)
              for (let i = 1; i < roomHumans[count]; i++) {
                const q = await connect();
                await q.request({ type: 'join', name: 'load', roomId: p.session.roomId });
                await until(() => q.session.snapshot, 'join snapshot');
              }
          }
          const createWallMs = performance.now() - start;
          if (sampleMs >= 60000) await sleep(Math.max(0, 1100 - createWallMs));
          const creationWindow = await rpc('finish');
          await sleep(warmupMs);
          delay.reset();
          late = 0;
          driveCalls = 0;
          const base = peers.map((p) => ({
              inputs: p.inputs,
              snapshots: p.snapshots,
              bytesIn: p.bytesIn,
              bytesOut: p.bytesOut,
              bytesByType: { ...p.bytesByType },
            })),
            cpu = process.cpuUsage();
          await rpc('begin');
          const at = performance.now();
          for (const p of peers)
            p.measure = {
              started: at,
              lastAt: at,
              ages: [],
              gaps: [],
              shots: [],
              lastShots: p.own.state.stats.shots,
              seq: p.latest.snapshotSeq,
              tick: p.latest.tick,
              reloads: 0,
            };
          await sleep(sampleMs);
          const server = await rpc('finish'),
            elapsed = performance.now() - at,
            usage = process.cpuUsage(cpu);
          const quantile = (a, q) =>
            a.toSorted((x, y) => x - y)[Math.max(0, Math.ceil(a.length * q) - 1)] ?? null;
          const quality = peers.map((p) => {
            const m = p.measure;
            delete p.measure;
            return {
              actorId: p.session.actorId,
              roomId: p.session.roomId,
              hz: (m.ages.length * 1000) / elapsed,
              ageP95Ms: quantile(m.ages, 0.95),
              ageP99Ms: quantile(m.ages, 0.99),
              maxGapMs: Math.max(...m.gaps, performance.now() - m.lastAt),
              shotsPer10Seconds: m.shots.slice(0, Math.floor(sampleMs / 10000)),
              joinMs: p.joinMs,
              reloads: m.reloads,
              maxMessageBytes: p.maxMessageBytes,
              extensions: p.session.socket.extensions,
              maxBases: p.maxBases,
              maxBaseBytes: p.maxBaseBytes,
            };
          });
          const bandwidth = server.end.connections.map((c) => {
            const b = server.start.connections.find(
              (v) => v.actorId === c.actorId && v.roomId === c.roomId,
            );
            const windows = server.windows.map((w) =>
              w.connections.find((v) => v.actorId === c.actorId && v.roomId === c.roomId),
            );
            return {
              actorId: c.actorId,
              roomId: c.roomId,
              meanDownKBps: (c.down - b.down) / server.elapsedMs,
              meanUpKBps: (c.up - b.up) / server.elapsedMs,
              p95DownKBps: quantile(
                windows.map((w) => w.downKBps),
                0.95,
              ),
              p95UpKBps: quantile(
                windows.map((w) => w.upKBps),
                0.95,
              ),
              maxDownKBps: Math.max(...windows.map((w) => w.downKBps)),
            };
          });
          const bandwidthPassed = bandwidth.every(
            (b) =>
              Math.max(b.meanDownKBps, b.p95DownKBps) <= (hz === 60 ? 125 : 75) &&
              Math.max(b.meanUpKBps, b.p95UpKBps) <= 10,
          );
          const peakPassed =
            bandwidth.every((b) => b.maxDownKBps <= (hz === 60 ? 250 : 150)) &&
            quality.every((q) => q.maxMessageBytes <= 131072);
          const creationPeakPassed =
            sampleMs < 60000 ||
            creationWindow.end.connections.every((c) => c.down <= (hz === 60 ? 250000 : 150000));
          const qualityPassed = quality.every(
            (q) =>
              q.hz >= (hz === 60 ? 59 : 29.5) &&
              q.ageP95Ms <= 50 &&
              q.ageP99Ms <= 100 &&
              q.maxGapMs <= 150 &&
              q.maxBases <= 2 &&
              q.maxBaseBytes <= 262144 &&
              q.joinMs.every((n) => n <= 3000),
          );
          const validActivity =
            sampleMs < 20000 ||
            (quality.every(
              (q) =>
                q.shotsPer10Seconds.length === Math.floor(sampleMs / 10000) &&
                q.shotsPer10Seconds.every((n) => n >= 10),
            ) &&
              quality.every((q) => q.reloads >= 2));
          const generated = peers.map((p, i) => ({
            inputs: p.inputs - base[i].inputs,
            snapshots: p.snapshots - base[i].snapshots,
            bytesIn: p.bytesIn - base[i].bytesIn,
            bytesOut: p.bytesOut - base[i].bytesOut,
            bytesByType: Object.fromEntries(
              Object.entries(p.bytesByType).map(([type, bytes]) => [
                type,
                bytes - (base[i].bytesByType[type] || 0),
              ]),
            ),
            closed: p.closed,
          }));
          const offered =
            (generated.reduce((n, p) => n + p.inputs, 0) * 1000) / elapsed / peers.length;
          const generator = {
            cpuCorePercent: (usage.user + usage.system) / elapsed / 10,
            eventLoopP99Ms: delay.percentile(99) / 1e6,
            lateCallbacks: late,
            callbacks: driveCalls,
            inputHzPerPeer: offered,
          };
          const validGenerator =
            generator.eventLoopP99Ms <= 33.34 &&
            late / Math.max(1, driveCalls) < 0.02 &&
            offered >= 55 &&
            server.end.rooms === rooms &&
            validActivity &&
            server.end.phases.every((p) => p === 'running');
          const budget =
            server.totalStepMs.p95 <= 12.5 &&
            server.totalStepMs.p99 <= 1000 / 60 &&
            server.stepHz >= 59 &&
            server.eventLoopDelayMs.p99 <= 1000 / 30;
          const after = await rpc('state');
          const level = {
            rooms,
            roomHumans,
            humans: peers.length,
            bots: rooms * 16 - peers.length,
            createWallMs,
            creationWindow,
            creationMs: after.creations.slice(before.creations.length).map((x) => x.ms),
            server,
            generator,
            generated,
            sampleMs,
            warmupMs,
            quality,
            bandwidth,
            bandwidthPassed,
            qualityPassed,
            validActivity,
            peakPassed,
            creationPeakPassed,
            accepted:
              validGenerator &&
              budget &&
              bandwidthPassed &&
              qualityPassed &&
              peakPassed &&
              creationPeakPassed,
            status: !validGenerator
              ? 'generator-insufficient'
              : budget
                ? 'within-local-budget'
                : 'over-local-budget',
          };
          report.levels.push(level);
          assert.ok(
            generated.every((p) => !p.closed && p.snapshots > 0 && p.inputs > 0),
            'load missing or connection failed',
          );
          assert.ok(
            server.max.input <= 64 &&
              server.max.history <= 32 &&
              server.max.historyRefs <= 32 &&
              server.max.important <= 128 &&
              server.max.importantBytes <= 65536 &&
              server.max.bases <= 2 &&
              server.max.baseBytes <= 262144,
            'queue bounds',
          );
          console.log(
            JSON.stringify({
              id,
              hz,
              load,
              rooms,
              status: level.status,
              stepP95: server.totalStepMs.p95,
              stepHz: server.stepHz,
            }),
          );
          if (
            sampleMs >= 60000 &&
            level.accepted &&
            peers[0].session.bases &&
            rooms === 1 &&
            (load === 'humans' || humanCounts)
          ) {
            const p = peers[0],
              attempts = p.session.recoveries,
              sequence = p.latest.snapshotSeq,
              started = performance.now();
            p.session.recoverSnapshot();
            await until(
              () =>
                p.session.recoveries > attempts &&
                p.session.recoveryAt === null &&
                p.latest.snapshotSeq > sequence,
              'full-state recovery',
              3000,
            );
            report.recoveryProbe = {
              elapsedMs: performance.now() - started,
              requests: p.session.recoveries - attempts,
              accepted: !p.closed && p.session.recoveries - attempts === 1,
            };
            assert.ok(report.recoveryProbe.accepted);
          }
          if (
            sampleMs >= 60000 &&
            level.accepted &&
            peers[0].session.bases &&
            rooms === 2 &&
            load === 'mixed'
          ) {
            // Measure isolation in fresh matches: a legitimate score settlement
            // after the 60s window must not look like a transport-induced stall.
            for (const p of peers) await p.request({ type: 'leave' }, 'left');
            for (let index = 0; index < rooms; index++) {
              const offset = roomHumans.slice(0, index).reduce((sum, n) => sum + n, 0),
                group = peers.slice(offset, offset + roomHumans[index]),
                owner = await create(index, 8, index % 2 ? 'relay' : 'tdm', group[0]);
              for (const p of group.slice(1)) {
                await p.request({ type: 'join', name: 'load', roomId: owner.session.roomId });
                await until(() => p.session.snapshot, 'isolation initial snapshot');
              }
            }
            await sleep(warmupMs);
            const slow = peers[0],
              healthy = peers.slice(1),
              started = performance.now();
            for (const p of healthy)
              p.measure = {
                started,
                lastAt: started,
                ages: [],
                gaps: [],
                shots: [],
                lastShots: p.own.state.stats.shots,
                seq: p.latest.snapshotSeq,
                tick: p.latest.tick,
                reloads: 0,
              };
            await rpc('begin');
            slow.session.socket._socket.pause();
            await sleep(8500);
            const pressured = await rpc('finish'),
              elapsed = performance.now() - started;
            const quality = healthy.map((p) => {
              const m = p.measure;
              delete p.measure;
              return {
                hz: (m.ages.length * 1000) / elapsed,
                ageP99Ms: quantile(m.ages, 0.99),
                maxGapMs: Math.max(...m.gaps, performance.now() - m.lastAt),
                closed: p.closed,
              };
            });
            const boundedExit = !!slow.closed && slow.closedAt - started <= 6150;
            slow.session.socket.terminate();
            let after;
            for (let tries = 0; tries < 100; tries++) {
              after = await rpc('state');
              if (after.clients === peers.length - 1) break;
              await sleep(10);
            }
            const ticks = healthy.map((p) => p.latest.snapshotSeq);
            await sleep(500);
            report.slowIsolation = {
              expectedRoomsAfterRelease: rooms - (roomHumans[0] === 1 ? 1 : 0),
              elapsedMs: elapsed,
              boundedExit,
              reason: slow.closed,
              results: healthy.flatMap((p) => p.controls.filter((c) => c.type === 'result')),
              exitMs: slow.closedAt - started,
              quality,
              server: pressured,
              afterRelease: after,
              accepted:
                boundedExit &&
                after.clients === peers.length - 1 &&
                after.rooms === rooms - (roomHumans[0] === 1 ? 1 : 0) &&
                healthy.every((p, i) => !p.closed && p.latest.snapshotSeq > ticks[i]) &&
                quality.every(
                  (q) =>
                    !q.closed &&
                    q.hz >= (hz === 60 ? 59 : 29.5) &&
                    q.ageP99Ms <= 100 &&
                    q.maxGapMs <= 150,
                ) &&
                pressured.totalStepMs.p95 <= 12.5 &&
                pressured.totalStepMs.p99 <= 1000 / 60 &&
                pressured.eventLoopDelayMs.p99 <= 1000 / 30 &&
                pressured.max.blockedAgeMs <= 2017 &&
                pressured.max.buffered <= 393230,
            };
            assert.ok(
              report.slowIsolation.accepted,
              'slow receiver affects healthy rooms or fails bounded cleanup',
            );
          }
          if (level.status !== 'within-local-budget') break;
        }
      } finally {
        delay.disable();
      }
      report.localScreenedRooms = Math.max(
        0,
        ...report.levels.filter((x) => x.status === 'within-local-budget').map((x) => x.rooms),
      );
      report.targetVerified = false;
      report.optimizationAccepted =
        report.levels.every((l) => l.accepted) &&
        (!report.slowIsolation || report.slowIsolation.accepted) &&
        (!report.recoveryProbe || report.recoveryProbe.accepted);
    } else {
      let p = await connect();
      report.baseline = await rpc('checkpoint');
      report.checkpoints = [];
      for (let cycle = 0; cycle < 24; cycle++) {
        const action = ['leave', 'disconnect', 'result'][Math.floor(cycle / 6) % 3];
        await create(
          cycle,
          [4, 5, 8][Math.floor(cycle / 2) % 3],
          Math.floor(cycle / 6) % 2 ? 'relay' : 'tdm',
          p,
        );
        for (let i = 0; i < 5; i++) {
          p.step();
          await sleep(17);
        }
        if (action === 'leave') await p.request({ type: 'leave' }, 'left');
        if (action === 'result') {
          await rpc('deadline');
          await p.take('result');
        }
        if (action === 'disconnect') {
          await p.close();
          p = null;
        }
        let state;
        for (let tries = 0; tries < 100; tries++) {
          state = await rpc('state');
          if (state.rooms === 0 && state.clients === (p ? 1 : 0)) break;
          await sleep(10);
        }
        assert.equal(state.rooms, 0);
        assert.equal(state.clients, p ? 1 : 0);
        assert.ok(
          state.queues.every(
            (q) =>
              !q.joined &&
              q.input === 0 &&
              !q.held &&
              q.historyRefs === 0 &&
              !q.latest &&
              q.bases === 0 &&
              q.baseBytes === 0,
          ),
        );
        if (!p) p = await connect();
        if ((cycle + 1) % 6 === 0) {
          const point = { cycle: cycle + 1, ...(await rpc('checkpoint')) };
          report.checkpoints.push(point);
          assert.equal(point.retainedObjects, 0, 'old room/world/nav still reachable');
        }
      }
      const heaps = report.checkpoints.slice(1).map((p) => p.memory.heapUsed),
        spread = Math.max(...heaps) - Math.min(...heaps);
      report.heapSpreadBytes = spread;
      report.heapSpreadBudgetBytes = Math.max(
        8 * 1024 * 1024,
        report.baseline.memory.heapUsed * 0.25,
      );
      assert.ok(spread <= report.heapSpreadBudgetBytes, 'post-warmup heap has not stabilized');
    }
    report.passed = true;
  } catch (e) {
    failure = e;
    report.failure = e.stack;
  } finally {
    clearTimeout(timedOut);
    clearTimeout(watchdog);
    clearInterval(drive);
    await Promise.all(
      peers.map((p) =>
        p.close().catch((e) => {
          report.cleanupError = e.message;
        }),
      ),
    );
    try {
      if (child.connected) {
        report.cleanup = await rpc('close');
        stopped = true;
        assert.equal(report.cleanup.rooms, 0);
        assert.equal(report.cleanup.clients, 0);
        assert.equal(report.cleanup.listening, false);
      } else if (!failure) throw new Error('Worker disconnected before cleanup evidence');
    } catch (e) {
      failure ||= e;
      report.cleanupError = e.stack;
      report.passed = false;
    }
    if (!stopped) child.kill();
    await writeFile(resolve(directory, 'worker.log'), log);
    await writeFile(resolve(directory, 'report.json'), JSON.stringify(report, null, 2));
  }
  if (failure) throw failure;
  results.push({
    id,
    hz,
    load,
    humanCounts,
    passed: report.passed,
    localScreenedRooms: report.localScreenedRooms,
    optimizationAccepted: report.optimizationAccepted,
    directory,
  });
}
try {
  if (opts.case !== 'S5-E2')
    for (const hz of opts.hz ? [Number(opts.hz)] : [60, 30]) {
      if (!opts.load && !opts.rooms && !explicitHumanCounts)
        for (const counts of [[10], [5, 5], [1, 9], [1, 1]])
          await run('S5-E1', hz, 'mixed', counts);
      else
        for (const load of opts.load ? [opts.load] : ['bots', 'humans', 'mixed'])
          await run('S5-E1', hz, load);
    }
  if (opts.case !== 'S5-E1')
    for (const hz of opts.hz ? [Number(opts.hz)] : [60, 30]) await run('S5-E2', hz, null);
} finally {
  await writeFile(resolve(out, 'summary.json'), JSON.stringify(results, null, 2));
}
