import assert from 'node:assert/strict';
import { readFile, writeFile, copyFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { WebSocket } from 'ws';
import {
  bounded,
  runtimeEnv,
  readRuntime,
  prepareRuntime,
  verifyRuntime,
  launchProcess,
  stopProcess,
  roomCheck,
  connectPeer,
  hash,
} from './runtime-check-support.mjs';

export async function rehearseRuntime({ root, scratch, current, options, report, owned }) {
  assert.notEqual(
    process.platform,
    'win32',
    'Use WSL/Linux for real SIGINT/SIGTERM rehearsal; Windows child.kill is forced termination',
  );
  const previous = await readRuntime(root, options['rollback-package']);
  assert.notEqual(
    previous.release.identity.build,
    current.release.identity.build,
    'Two distinct archived builds are required',
  );
  const archiveHashes = await Promise.all(
    [options.package, options['rollback-package']].map(async (path) => ({
      path,
      sha256: hash(await readFile(path)),
    })),
  );
  const oldDir = resolve(scratch, 'previous'),
    newDir = resolve(scratch, 'candidate');
  report.dependencies = {
    previous: await prepareRuntime(
      previous,
      oldDir,
      resolve(scratch, 'npm-cache'),
      resolve(options.out, 'previous-install'),
    ),
    candidate: await prepareRuntime(
      current,
      newDir,
      resolve(scratch, 'npm-cache'),
      resolve(options.out, 'candidate-install'),
    ),
  };
  const oldConfig = { PORT: '0', SNAPSHOT_HZ: '60' },
    newConfig = { PORT: '0', SNAPSHOT_HZ: '30' };
  const peers = [];
  report.stages = [];
  report.stops = [];
  const start = async (directory, input, config, label) => {
    const runner = launchProcess(
      directory,
      ['server/main.js'],
      runtimeEnv(input.release, config),
      label,
      owned,
    );
    await runner.ready;
    const checked = await roomCheck(runner.url, input.release, {
      hz: Number(config.SNAPSHOT_HZ),
      operate: true,
    });
    peers.push(checked.peer);
    if (input === current)
      assert.deepEqual(checked.observation.health.product, current.release.product);
    report.stages.push({
      label,
      pid: runner.child.pid,
      url: runner.url,
      directory,
      config: { ...config },
      identity: input.release.identity,
      ...checked.observation,
    });
    return { process: runner, ...checked };
  };
  const stop = async (running, signal) => {
    const stopped = await stopProcess(running.process, signal, true);
    const connection = await bounded(running.peer.closed, 2000, 'active connection close');
    report.stops.push({ ...stopped, activeConnectionClosed: connection });
  };
  const mismatch = async (url, identity) => {
    const peer = await connectPeer(url);
    try {
      peer.send({ type: 'hello', identity });
      const closed = await bounded(peer.closed, 3000, 'version mismatch');
      assert.equal(closed.code, 1008);
      assert.equal(closed.reason, 'VERSION_MISMATCH');
      return closed;
    } finally {
      peer.socket.terminate();
    }
  };
  try {
    let active = await start(oldDir, previous, oldConfig, 'previous-start');
    const port = new URL(active.process.url).port;
    oldConfig.PORT = port;
    newConfig.PORT = port;
    await stop(active, 'SIGTERM');
    active = await start(oldDir, previous, oldConfig, 'same-version-restart');
    const onlinePath = resolve(newDir, 'online/index.html'),
      original = await readFile(onlinePath);
    try {
      await writeFile(
        onlinePath,
        Buffer.concat([original, Buffer.from('\nfailed preparation probe')]),
      );
      const rejected = verifyRuntime(newDir, runtimeEnv(current.release, newConfig));
      assert.notEqual(rejected.status, 0);
      assert.match(rejected.stderr, /online\/index\.html (bytes|hash)/);
      await writeFile(
        resolve(options.out, 'preflight-rejection.log'),
        rejected.stdout + rejected.stderr,
      );
      active.peer.send({ type: 'clock', id: 900, clientMs: 0 });
      await active.peer.next('clock', (m) => m.id === 900);
      const health = await (
        await fetch(active.process.url + '/health', { signal: AbortSignal.timeout(3000) })
      ).json();
      assert.deepEqual(health.identity, previous.release.identity);
      report.failedPreparationKeptOriginal = true;
    } finally {
      await writeFile(onlinePath, original);
    }
    assert.equal(verifyRuntime(newDir, runtimeEnv(current.release, newConfig)).status, 0);
    const invalid = launchProcess(
      newDir,
      ['server/main.js'],
      runtimeEnv(current.release, { PORT: '0', SNAPSHOT_HZ: '45' }),
      'invalid-config',
      owned,
    );
    await assert.rejects(invalid.ready, /SNAPSHOT_HZ must be 30 or 60/);
    const invalidExit = await bounded(invalid.exited, 3000, 'invalid configuration exit');
    assert.notEqual(invalidExit.code, 0);
    active.peer.send({ type: 'clock', id: 901, clientMs: 0 });
    await active.peer.next('clock', (m) => m.id === 901);
    report.invalidConfigKeptOriginal = true;
    await stop(active, 'SIGINT');
    active = await start(newDir, current, newConfig, 'candidate-switch');
    report.oldClientRejected = await mismatch(active.process.url, previous.release.identity);
    await stop(active, 'SIGTERM');
    assert.equal(verifyRuntime(oldDir, runtimeEnv(previous.release, oldConfig)).status, 0);
    active = await start(oldDir, previous, oldConfig, 'previous-rollback');
    report.newClientRejectedAfterRollback = await mismatch(
      active.process.url,
      current.release.identity,
    );
    await stop(active, 'SIGTERM');
    const staticDir = resolve(scratch, 'static');
    await mkdir(staticDir, { recursive: true });
    const html = await readFile(options['static-file']);
    await writeFile(resolve(staticDir, 'index.html'), html);
    await copyFile(resolve(root, 'scripts/serve.mjs'), resolve(staticDir, 'serve.mjs'));
    const preview = launchProcess(
      staticDir,
      ['serve.mjs', '--file=index.html'],
      runtimeEnv(current.release, { PORT: port }),
      'static-rollback',
      owned,
    );
    await preview.ready;
    const served = Buffer.from(
      await (await fetch(preview.url, { signal: AbortSignal.timeout(3000) })).arrayBuffer(),
    );
    assert.equal(hash(served), hash(html));
    assert.equal(
      (await fetch(preview.url + '/health', { signal: AbortSignal.timeout(3000) })).status,
      404,
    );
    assert.equal(
      (await fetch(preview.url + '/ws', { signal: AbortSignal.timeout(3000) })).status,
      404,
    );
    const socket = new WebSocket(preview.url.replace('http:', 'ws:') + '/ws');
    try {
      await bounded(
        new Promise((done, fail) => {
          socket.once('open', () =>
            fail(new Error('Static rollback unexpectedly provided WebSocket')),
          );
          socket.once('error', done);
        }),
        3000,
        'static WebSocket rejection',
      );
    } finally {
      socket.terminate();
    }
    report.staticRollback = {
      source: options['static-file'],
      sha256: hash(html),
      bytes: html.length,
      url: preview.url,
      onlineHealthStatus: 404,
      websocketAvailable: false,
      mode: 'offline-only',
    };
    report.stops.push(await stopProcess(preview, 'SIGINT', true));
    await writeFile(
      resolve(options.out, 'version-configurations.json'),
      JSON.stringify(
        {
          previous: oldConfig,
          candidate: newConfig,
          previousIdentity: previous.release.identity,
          candidateIdentity: current.release.identity,
        },
        null,
        2,
      ) + '\n',
    );
    for (const input of [previous, current]) {
      const directory = input === previous ? oldDir : newDir;
      assert.equal(verifyRuntime(directory, runtimeEnv(input.release)).status, 0);
    }
    for (const item of archiveHashes) assert.equal(hash(await readFile(item.path)), item.sha256);
    report.archivesUnchanged = archiveHashes;
    report.passed = true;
  } finally {
    for (const peer of peers) peer.socket.terminate();
  }
}
