import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises';
import { resolve, dirname, basename, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createServer } from 'node:net';
import { unzipSync } from 'fflate';
import { WebSocket } from 'ws';
import { decodeMessage, encodeMessage, INPUT_FLAGS } from '../src/protocol/messages.js';
import { npmCli } from './npm-cli.mjs';

export const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const expected = [
  'offline/harbor-after-rain.html',
  'index.html',
  'online/index.html',
  'server/main.js',
  'licenses/three.txt',
  'licenses/ws.txt',
  'licenses/fflate.txt',
  'offline-manifest.json',
  'online-manifest.json',
  'server-manifest.json',
  'package.json',
  'package-lock.json',
  'RUNNING.md',
  'verify.mjs',
];
export async function bounded(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, fail) => {
        timer = setTimeout(() => fail(new Error(label + ' timeout')), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
export function runtimeEnv(release, config = {}) {
  const defaults = release.configuration.defaults;
  const env = {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: '0',
    SNAPSHOT_HZ: String(defaults.snapshotHz),
    MAX_ROOMS: String(defaults.maxRooms),
    MAX_CONNECTIONS: String(defaults.maxConnections),
    ...config,
  };
  delete env.NODE_PATH;
  delete env.NODE_OPTIONS;
  return env;
}
export async function readRuntime(root, archivePath = null) {
  const payload = new Map();
  if (archivePath) {
    const bytes = await readFile(archivePath);
    const manifestBytes = await readFile(resolve(dirname(archivePath), 'release.json'));
    const sums = new Map(
      (await readFile(resolve(dirname(archivePath), 'SHA256SUMS'), 'utf8'))
        .trim()
        .split('\n')
        .map((line) =>
          line
            .trim()
            .split(/\s{2,}/)
            .reverse(),
        ),
    );
    assert.equal(sums.get(basename(archivePath)), hash(bytes), 'Archive checksum');
    assert.equal(sums.get('release.json'), hash(manifestBytes), 'Manifest checksum');
    const entries = unzipSync(new Uint8Array(bytes));
    const manifests = Object.keys(entries).filter((path) => path.endsWith('/release.json'));
    assert.equal(manifests.length, 1);
    const prefix = manifests[0].slice(0, -'release.json'.length);
    assert.match(prefix, /^[a-z0-9._-]+\/$/);
    assert.deepEqual(
      Object.keys(entries).sort(),
      [...expected, 'release.json'].map((path) => prefix + path).sort(),
      'Archive allowlist',
    );
    for (const path of [...expected, 'release.json']) payload.set(path, entries[prefix + path]);
    assert.deepEqual(Buffer.from(payload.get('release.json')), manifestBytes);
  } else {
    const manifest = JSON.parse(await readFile(resolve(root, 'dist/release.json'), 'utf8'));
    assert.equal(manifest.schemaVersion, 1, 'Complete release manifest is required');
    for (const path of [...expected, 'release.json'])
      payload.set(path, await readFile(resolve(root, 'dist', path)));
  }
  const release = JSON.parse(Buffer.from(payload.get('release.json')).toString());
  assert.equal(release.schemaVersion, 1);
  assert.deepEqual(release.files.map((file) => file.path).sort(), [...expected].sort());
  return { release, payload, archivePath };
}
export function verifyRuntime(directory, env) {
  return spawnSync(process.execPath, ['verify.mjs'], {
    cwd: directory,
    env,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10000,
  });
}
export async function prepareRuntime(input, directory, cache, out) {
  await mkdir(out, { recursive: true });
  const env = runtimeEnv(input.release);
  for (const [path, bytes] of input.payload) {
    await mkdir(dirname(resolve(directory, path)), { recursive: true });
    await writeFile(resolve(directory, path), bytes);
  }
  const before = verifyRuntime(directory, env);
  assert.ifError(before.error);
  assert.equal(before.status, 0, before.stderr);
  await writeFile(resolve(out, 'verify.log'), before.stdout + before.stderr);
  const installed = spawnSync(
    process.execPath,
    [
      npmCli(),
      'ci',
      '--omit=dev',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--fetch-retries=0',
      '--fetch-timeout=20000',
      '--cache=' + cache,
    ],
    { cwd: directory, env, encoding: 'utf8', windowsHide: true, timeout: 45000 },
  );
  await writeFile(resolve(out, 'npm-ci.log'), (installed.stdout || '') + (installed.stderr || ''));
  assert.ifError(installed.error);
  assert.equal(installed.status, 0, installed.stderr);
  const probe = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', 'console.log(import.meta.resolve("ws"))'],
    { cwd: directory, env, encoding: 'utf8', windowsHide: true, timeout: 10000 },
  );
  assert.ifError(probe.error);
  assert.equal(probe.status, 0, probe.stderr);
  const modulePath = await realpath(fileURLToPath(probe.stdout.trim()));
  assert.ok(modulePath.startsWith((await realpath(resolve(directory, 'node_modules'))) + sep));
  const ws = JSON.parse(await readFile(resolve(directory, 'node_modules/ws/package.json'), 'utf8'));
  assert.equal(ws.version, input.release.dependencies.runtime.ws.version);
  const after = verifyRuntime(directory, env);
  assert.equal(after.status, 0, after.stderr);
  return { name: 'ws', version: ws.version, resolved: modulePath };
}
export function launchProcess(directory, args, env, label, owned) {
  const child = spawn(process.execPath, args, {
    cwd: directory,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const record = { child, label, stdout: '', stderr: '', result: null };
  owned.push(record);
  record.exited = new Promise((done) => {
    child.once('exit', (code, signal) => {
      record.result = { code, signal };
      done(record.result);
    });
    child.once('error', (error) => {
      record.result = { code: null, signal: null, error: error.message };
      done(record.result);
    });
  });
  child.stdout.on('data', (chunk) => {
    record.stdout = (record.stdout + chunk).slice(-65536);
  });
  child.stderr.on('data', (chunk) => {
    record.stderr = (record.stderr + chunk).slice(-65536);
  });
  record.ready = (async () => {
    const deadline = performance.now() + 10000;
    while (performance.now() < deadline) {
      const match = record.stdout.match(/(?:Online|Local): (http:\/\/[^\s]+)/);
      if (match) {
        record.url = match[1];
        return record.url;
      }
      if (record.result) throw new Error(`Startup failed: ${label}: ${record.stderr}`);
      await new Promise((done) => setTimeout(done, 10));
    }
    throw new Error('Startup timeout: ' + label);
  })();
  return record;
}
export async function assertPortReleased(port) {
  const server = createServer();
  try {
    await bounded(
      new Promise((done, fail) => {
        server.once('error', fail);
        server.listen(port, '127.0.0.1', done);
      }),
      3000,
      'port release',
    );
  } finally {
    if (server.listening) await new Promise((done) => server.close(done));
  }
}
export async function stopProcess(record, signal = 'SIGTERM', graceful = true) {
  assert.equal(record.result, null, 'Process exited before requested stop');
  const start = performance.now();
  assert.equal(record.child.kill(signal), true);
  const result = await bounded(record.exited, 8000, 'process stop');
  const elapsedMs = performance.now() - start;
  if (graceful) {
    assert.deepEqual(result, { code: 0, signal: null }, 'A forced exit is not graceful shutdown');
    assert.ok(elapsedMs < 5000, 'Graceful stop exceeded the existing 5s deadline');
  }
  const port = Number(new URL(record.url).port);
  await assertPortReleased(port);
  return {
    label: record.label,
    pid: record.child.pid,
    requestedSignal: signal,
    ...result,
    elapsedMs,
    port,
    portReleased: true,
  };
}
export async function roomCheck(
  url,
  release,
  { hz = release.configuration.defaults.snapshotHz, operate = false } = {},
) {
  const health = await (await fetch(url + '/health', { signal: AbortSignal.timeout(3000) })).json();
  assert.deepEqual(health.identity, release.identity);
  if (health.product) assert.deepEqual(health.product, release.product);
  assert.equal((await fetch(url, { signal: AbortSignal.timeout(3000) })).status, 200);
  assert.equal(
    (await fetch(url + '/offline.html', { signal: AbortSignal.timeout(3000) })).status,
    200,
  );
  const peer = await connectPeer(url);
  try {
    peer.send({ type: 'hello', identity: release.identity });
    await peer.next('hello');
    peer.send({ type: 'list' });
    const rooms = await peer.next('rooms');
    assert.equal(rooms.rooms.length, 0, 'Restart must not restore an in-memory room');
    peer.send({ type: 'create', name: 'runtime-check', mode: 'relay', teamSize: 4 });
    const joined = await peer.next('joined');
    assert.equal(joined.config.snapshotHz, hz, 'Release configuration was mixed');
    let frame = await peer.next('snapshot');
    assert.equal(frame.public.roomId, joined.roomId);
    assert.equal(frame.public.mode, 'relay');
    const observation = { health, joined, emptyLobby: true };
    if (operate) {
      frame = await peer.next('snapshot', (m) => m.public.time >= m.own.state.fields.readyAt);
      const origin = frame.own.state.pos,
        shots = frame.own.state.stats.shots;
      peer.send({
        type: 'input',
        seq: 1,
        tick: frame.public.tick + 3,
        lifeId: frame.own.state.fields.lifeId,
        stageId: frame.public.stageId,
        createdAtMs: frame.public.nowMs,
        display: null,
        baseAck: 0,
        input: {
          ...Object.fromEntries(INPUT_FLAGS.map((flag) => [flag, false])),
          yaw: 0,
          pitch: 0,
          moveX: 1,
          moveZ: 0,
          fire: true,
          firePressed: true,
        },
      });
      const ack = await peer.next(
        'snapshot',
        (m) =>
          m.own.ackSeq >= 1 &&
          m.own.state.stats.shots > shots &&
          Math.hypot(...m.own.state.pos.map((v, i) => v - origin[i])) > 0.001,
      );
      assert.equal(ack.public.snapshotSeq, ack.own.snapshotSeq);
      peer.send({ type: 'pause' });
      const paused = await peer.next('snapshot', (m) => m.public.phase === 'paused');
      observation.action = {
        ackSeq: ack.own.ackSeq,
        beforeShots: shots,
        afterShots: ack.own.state.stats.shots,
        beforePosition: origin,
        afterPosition: ack.own.state.pos,
        phase: paused.public.phase,
      };
    }
    return { peer, observation };
  } catch (error) {
    peer.socket.terminate();
    throw error;
  }
}
export async function connectPeer(url) {
  const socket = new WebSocket(url.replace('http:', 'ws:') + '/ws');
  const messages = [];
  let failure = null,
    closed = null;
  socket.on('error', (error) => {
    failure = error;
  });
  const closedPromise = new Promise((done) =>
    socket.on('close', (code, reason) => {
      closed = { code, reason: reason.toString() };
      done(closed);
    }),
  );
  socket.on('message', (wire, binary) => {
    try {
      messages.push(decodeMessage(binary ? wire : wire.toString()));
      while (messages.length > 256) messages.shift();
    } catch (error) {
      failure = error;
    }
  });
  await bounded(
    new Promise((done, fail) => {
      socket.once('open', done);
      socket.once('error', fail);
    }),
    3000,
    'WebSocket open',
  );
  return {
    socket,
    closed: closedPromise,
    send: (message) => socket.send(encodeMessage(message)),
    next: async (type, predicate = () => true) => {
      const deadline = performance.now() + 3000;
      while (performance.now() < deadline) {
        const index = messages.findIndex((m) => m.type === type && predicate(m));
        if (index >= 0) return messages.splice(index, 1)[0];
        if (failure) throw failure;
        if (closed) throw new Error('Connection closed: ' + JSON.stringify(closed));
        await new Promise((done) => setTimeout(done, 10));
      }
      throw new Error('Missing message: ' + type);
    },
  };
}
