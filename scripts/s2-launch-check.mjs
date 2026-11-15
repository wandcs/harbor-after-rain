import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir, mkdtemp, rm, realpath } from 'node:fs/promises';
import { resolve, relative, dirname, basename, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { readConfig } from '../server/config.js';
import {
  bounded,
  hash,
  runtimeEnv,
  readRuntime,
  prepareRuntime,
  verifyRuntime,
  launchProcess,
  stopProcess,
  roomCheck,
} from './runtime-check-support.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const options = {
  out: resolve(root, `artifacts/test-runs/launch-${Date.now()}`),
  package: null,
  lifecycle: false,
};
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--lifecycle') {
    options.lifecycle = true;
    continue;
  }
  const match = args[i].match(/^--(out|package|rollback-package|static-file)(?:=(.*))?$/);
  if (!match) throw new Error('Unknown launch-check option: ' + args[i]);
  const value = match[2] ?? args[++i];
  if (!value || value.startsWith('--')) throw new Error('Missing --' + match[1]);
  options[match[1]] = resolve(value);
}
if (options.lifecycle) {
  assert.notEqual(process.platform, 'win32', 'Run --lifecycle in WSL/Linux to test real signals');
  for (const key of ['package', 'rollback-package', 'static-file'])
    assert.ok(options[key], `--lifecycle requires --${key}`);
} else
  assert.ok(
    !options['rollback-package'] && !options['static-file'],
    'Rollback options require --lifecycle',
  );
const out = options.out;
await mkdir(out, { recursive: true });
const input = await readRuntime(root, options.package),
  release = input.release;
const product = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
assert.deepEqual(release.product, { name: product.name, version: product.version });
assert.deepEqual(release.configuration.defaults, readConfig({}));
assert.equal(release.locks.source.sha256, hash(await readFile(resolve(root, 'package-lock.json'))));
assert.equal(
  release.source.commit,
  execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  }).trim(),
);
for (const item of release.source.inputs) {
  const path = resolve(root, item.path),
    rel = relative(root, path);
  assert.ok(rel && !rel.startsWith('..' + sep) && !isAbsolute(rel));
  assert.equal(hash(await readFile(path)), item.sha256, `Source input: ${item.path}`);
}
const base = await realpath(tmpdir()),
  baseFromRepo = relative(root, base);
assert.ok(
  baseFromRepo.startsWith('..' + sep) || isAbsolute(baseFromRepo),
  'Temporary base must be outside the repository',
);
const scratch = await mkdtemp(resolve(base, 'harbor-release-'));
const directory = resolve(scratch, 'package'),
  owned = [];
const report = {
  identity: release.identity,
  package: options.package,
  isolatedDirectory: directory,
  outsideRepository: true,
  sourceKind: release.build.kind,
  mode: options.lifecycle ? 'lifecycle' : 'launch',
  negativeChecks: [],
  runtime: { node: process.version, platform: process.platform, arch: process.arch },
};
let peer;
try {
  if (options.lifecycle) {
    const { rehearseRuntime } = await import('./local-runtime-check.mjs');
    await rehearseRuntime({ root, scratch, current: input, options, report, owned });
  } else {
    const env = runtimeEnv(release);
    report.installedDependency = await prepareRuntime(
      input,
      directory,
      resolve(scratch, 'npm-cache'),
      out,
    );
    const path = resolve(directory, 'online/index.html'),
      original = await readFile(path);
    try {
      await writeFile(path, Buffer.concat([original, Buffer.from('\ncorruption probe')]));
      const corrupt = verifyRuntime(directory, env);
      assert.notEqual(corrupt.status, 0);
      assert.match(corrupt.stderr, /online\/index\.html (bytes|hash)/);
      report.negativeChecks.push('corrupt-file-rejected');
      await writeFile(resolve(out, 'corrupt.log'), corrupt.stdout + corrupt.stderr);
      await rm(path);
      const missing = verifyRuntime(directory, env);
      assert.notEqual(missing.status, 0);
      assert.match(missing.stderr, /ENOENT/);
      report.negativeChecks.push('missing-file-rejected');
      await writeFile(resolve(out, 'missing.log'), missing.stdout + missing.stderr);
    } finally {
      await writeFile(path, original);
    }
    const server = launchProcess(directory, ['server/main.js'], env, 'launch', owned);
    await server.ready;
    const checked = await roomCheck(server.url, release);
    peer = checked.peer;
    assert.deepEqual(checked.observation.health.product, release.product);
    report.observation = checked.observation;
    peer.send({ type: 'leave' });
    await peer.next('left');
    peer.socket.close();
    await bounded(peer.closed, 3000, 'client close');
    report.stop = await stopProcess(server, 'SIGTERM', process.platform !== 'win32');
    report.passed = true;
  }
  console.log(`Isolated ${report.mode} check passed; all operations stayed local.`);
} catch (error) {
  report.failure = error.stack;
  throw error;
} finally {
  peer?.socket.terminate();
  let forcedCleanup = false;
  for (const record of owned) {
    if (!record.result) {
      record.child.kill('SIGTERM');
      try {
        await bounded(record.exited, 8000, 'cleanup');
      } catch {
        forcedCleanup = true;
        record.child.kill('SIGKILL');
        await bounded(record.exited, 3000, 'forced cleanup');
      }
    }
    await writeFile(resolve(out, `${record.label}.log`), record.stdout + record.stderr);
  }
  const finalScratch = await realpath(scratch);
  assert.equal(dirname(finalScratch), base);
  assert.ok(basename(finalScratch).startsWith('harbor-release-'));
  await rm(finalScratch, { recursive: true, force: true, maxRetries: 2 });
  report.cleanup = {
    processExited: owned.every((p) => p.result !== null),
    temporaryDirectoryRemoved: true,
    forcedCleanup,
  };
  await writeFile(resolve(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
}
