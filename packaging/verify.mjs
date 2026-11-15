import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const targets = {
  offline: ['offline/harbor-after-rain.html', 'index.html'],
  online: ['online/index.html'],
  server: ['server/main.js', 'licenses/three.txt', 'licenses/ws.txt', 'licenses/fflate.txt'],
};
const runtimeFiles = ['package.json', 'package-lock.json', 'RUNNING.md', 'verify.mjs'];
const hash = (body) => createHash('sha256').update(body).digest('hex');
const sha256 = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

export async function verifyRelease(root = dirname(fileURLToPath(import.meta.url))) {
  assert.match(process.version, /^v24\./, 'Node.js 24 is required');
  const json = async (path) => JSON.parse(await readFile(resolve(root, path), 'utf8'));
  const manifest = await json('release.json');
  assert.equal(manifest.schemaVersion, 1, 'Complete release manifest is required');
  assert.equal(manifest.target, 'all');
  assert.match(manifest.product.name, /^[a-z0-9][a-z0-9._-]*$/);
  assert.match(manifest.product.version, /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/);
  assert.ok(Number.isInteger(manifest.identity.protocol));
  assert.ok(sha256(manifest.identity.build) && sha256(manifest.identity.rules));
  assert.ok(['local', 'release'].includes(manifest.build.kind));
  assert.equal(new Date(manifest.build.createdAt).toISOString(), manifest.build.createdAt);
  assert.equal(
    hash(JSON.stringify(manifest.build.configuration)),
    manifest.build.configurationSha256,
  );
  assert.match(manifest.toolchain.node, /^v24\./);
  assert.match(manifest.toolchain.npm, /^11\./);
  assert.ok(manifest.toolchain.platform && manifest.toolchain.arch && manifest.toolchain.esbuild);
  assert.ok(manifest.source.commit === null || /^[a-f0-9]{40,64}$/.test(manifest.source.commit));
  assert.ok([true, false, null].includes(manifest.source.dirty));
  if (manifest.source.dirty) assert.ok(sha256(manifest.source.localChangesSha256));
  if (manifest.build.kind === 'release') {
    assert.equal(manifest.source.dirty, false, 'Release source must be clean');
    assert.ok(manifest.source.commit);
  }
  assert.equal(manifest.source.scope, 'build-inputs');
  assert.ok(manifest.source.inputs.length > 0);
  for (const input of manifest.source.inputs) {
    assert.ok(
      !input.path.startsWith('/') &&
        !input.path.includes('\\') &&
        !input.path.split('/').includes('..'),
    );
    assert.ok(Number.isInteger(input.bytes) && input.bytes >= 0 && sha256(input.sha256));
  }
  assert.equal(
    manifest.source.inputs.find((input) => input.path === 'package-lock.json').sha256,
    manifest.locks.source.sha256,
  );
  assert.deepEqual(manifest.configuration.environment, [
    'HOST',
    'PORT',
    'SNAPSHOT_HZ',
    'MAX_ROOMS',
    'MAX_CONNECTIONS',
  ]);
  assert.ok([30, 60].includes(manifest.configuration.defaults.snapshotHz));
  assert.ok(
    manifest.configuration.defaults.maxRooms > 0 &&
      manifest.configuration.defaults.maxConnections > 0,
  );
  const expected = [
    ...Object.values(targets).flat(),
    ...Object.keys(targets).map((target) => `${target}-manifest.json`),
    ...runtimeFiles,
  ].sort();
  assert.deepEqual(
    manifest.files.map((file) => file.path).sort(),
    expected,
    'Delivery file allowlist',
  );
  for (const file of manifest.files) {
    const body = await readFile(resolve(root, file.path));
    assert.equal(body.length, file.bytes, `${file.path} bytes`);
    assert.equal(hash(body), file.sha256, `${file.path} hash`);
  }
  const actualFiles = [];
  async function walk(prefix = '') {
    for (const entry of await readdir(resolve(root, prefix), { withFileTypes: true })) {
      const path = prefix + entry.name;
      assert.equal(entry.isSymbolicLink(), false, `Unexpected symbolic link: ${path}`);
      if (path === 'node_modules' && entry.isDirectory()) continue;
      if (entry.isDirectory()) await walk(path + '/');
      else actualFiles.push(path);
    }
  }
  await walk();
  assert.deepEqual(
    actualFiles.sort(),
    [...expected, 'release.json'].sort(),
    'Unexpected delivery files',
  );
  for (const [target, paths] of Object.entries(targets)) {
    const part = await json(`${target}-manifest.json`);
    assert.equal(part.target, target);
    assert.deepEqual(part.identity, manifest.identity);
    assert.deepEqual(part.files.map((file) => file.path).sort(), [...paths].sort());
    for (const file of part.files)
      assert.deepEqual(
        file,
        manifest.files.find((item) => item.path === file.path),
      );
  }
  const pkg = await json('package.json'),
    lock = await json('package-lock.json');
  assert.equal(pkg.name, manifest.product.name);
  assert.equal(pkg.version, manifest.product.version);
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.private, true);
  assert.deepEqual(pkg.scripts, { start: 'node server/main.js', verify: 'node verify.mjs' });
  assert.deepEqual(pkg.engines, manifest.toolchain.required);
  assert.deepEqual(pkg.engines, { node: '24.x', npm: '11.x' });
  assert.deepEqual(Object.keys(pkg.dependencies), ['ws']);
  assert.deepEqual(lock.packages[''].dependencies, pkg.dependencies);
  assert.equal(lock.name, pkg.name);
  assert.equal(lock.version, pkg.version);
  const ws = lock.packages['node_modules/ws'];
  assert.equal(pkg.dependencies.ws, ws.version);
  assert.equal(manifest.dependencies.runtime.ws.version, ws.version);
  assert.equal(manifest.dependencies.runtime.ws.integrity, ws.integrity);
  assert.equal(
    hash(await readFile(resolve(root, 'package-lock.json'))),
    manifest.locks.runtime.sha256,
  );
  assert.deepEqual(Object.keys(lock.packages).sort(), ['', 'node_modules/ws']);
  assert.deepEqual(Object.keys(manifest.dependencies.bundled).sort(), ['fflate', 'three']);
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const manifest = await verifyRelease();
  console.log(
    `Verified ${manifest.product.name} ${manifest.product.version}: ${manifest.files.length} files, ${manifest.build.kind} source.`,
  );
}
