import { PROTOCOL_VERSION } from './src/protocol/messages.js';
import * as esbuild from 'esbuild';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { npmCli } from './scripts/npm-cli.mjs';
import { readConfig } from './server/config.js';

const root = fileURLToPath(new URL('./', import.meta.url));
process.chdir(root);
const args = process.argv.slice(2);
if (args.some((arg) => !['--dev', '--release'].includes(arg) && !arg.startsWith('--target=')))
  throw new Error('Unknown build option');
const target = args.find((arg) => arg.startsWith('--target='))?.slice(9) || 'all';
if (!['all', 'online', 'offline', 'server'].includes(target))
  throw new Error('Unknown build target');
const releaseSource = args.includes('--release');
if (releaseSource && (args.includes('--dev') || target !== 'all'))
  throw new Error('Release source requires a full production build');
const configuration = {
  browser: {
    target: ['es2020'],
    format: 'iife',
    minify: !args.includes('--dev'),
    sourcemap: false,
  },
  server: { target: ['node24'], format: 'esm', external: ['ws'], minify: false },
  nodeEnv: 'production',
};
const product = JSON.parse(await readFile('package.json', 'utf8'));
const sourceLockBytes = await readFile('package-lock.json');
const sourceLock = JSON.parse(sourceLockBytes);
const runtimeBytes = await readFile('packaging/runtime/package.json');
const runtime = JSON.parse(runtimeBytes);
const runtimeLockBytes = await readFile('packaging/runtime/package-lock.json');
const runtimeLock = JSON.parse(runtimeLockBytes);
if (
  sourceLock.name !== product.name ||
  sourceLock.version !== product.version ||
  JSON.stringify(sourceLock.packages[''].dependencies) !== JSON.stringify(product.dependencies)
)
  throw new Error('SOURCE_LOCK_MISMATCH: update package.json and its npm lock together');
if (
  runtime.name !== product.name ||
  runtime.version !== product.version ||
  JSON.stringify(runtime.engines) !== JSON.stringify(product.engines) ||
  runtimeLock.name !== runtime.name ||
  runtimeLock.version !== runtime.version ||
  JSON.stringify(runtimeLock.packages[''].dependencies) !== JSON.stringify(runtime.dependencies) ||
  Object.keys(runtime.dependencies).join() !== 'ws' ||
  runtime.dependencies.ws !== product.dependencies.ws ||
  runtimeLock.packages['node_modules/ws'].version !==
    sourceLock.packages['node_modules/ws'].version ||
  runtimeLock.packages['node_modules/ws'].integrity !==
    sourceLock.packages['node_modules/ws'].integrity
)
  throw new Error('RUNTIME_LOCK_MISMATCH: update the runtime package and npm lock together');
const npmVersion = execFileSync(process.execPath, [npmCli(), '--version'], {
  encoding: 'utf8',
  windowsHide: true,
}).trim();
if (!process.version.startsWith('v24.') || !npmVersion.startsWith('11.'))
  throw new Error('TOOLCHAIN_MISMATCH: Node.js 24 and npm 11 are required');

const hash = (value) => createHash('sha256').update(value).digest('hex');
async function files(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await files(path)));
    else result.push(path);
  }
  return result.sort();
}
const sources = [
  ...(await files('src')),
  ...(await files('server')),
  resolve('build.mjs'),
  resolve('package-lock.json'),
  ...[
    'package.json',
    'scripts/npm-cli.mjs',
    'scripts/package-release.mjs',
    'packaging/runtime/package.json',
    'packaging/runtime/package-lock.json',
    'packaging/RUNNING.md',
    'packaging/verify.mjs',
  ].map((path) => resolve(path)),
];
const fingerprint = async (list) =>
  hash(
    Buffer.concat(
      await Promise.all(
        list.map(async (path) =>
          Buffer.concat([
            Buffer.from(relative('.', path).replaceAll('\\', '/')),
            await readFile(path),
          ]),
        ),
      ),
    ),
  );
const inputs = await Promise.all(
  sources.map(async (path) => {
    const body = await readFile(path);
    return {
      path: relative(root, path).replaceAll('\\', '/'),
      bytes: body.length,
      sha256: hash(body),
    };
  }),
);
let commit = null,
  dirty = null,
  localChangesSha256 = null;
try {
  const git = (args) =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  commit = git(['rev-parse', 'HEAD']).trim();
  dirty = !!git(['status', '--porcelain=v1', '--untracked-files=all']).trim();
  if (dirty)
    localChangesSha256 = hash(
      JSON.stringify({
        trackedBuildDiff: git([
          'diff',
          '--binary',
          'HEAD',
          '--',
          ...inputs.map((input) => input.path),
        ]),
        inputs,
      }),
    );
} catch (error) {
  commit = null;
  dirty = null;
}
if (releaseSource && (dirty !== false || !commit))
  throw new Error(
    'RELEASE_SOURCE_NOT_CLEAN: commit the intended source before creating a release-source package',
  );
const identity = {
  protocol: PROTOCOL_VERSION,
  build: hash(JSON.stringify({ source: await fingerprint(sources), configuration })),
  rules: await fingerprint(await files('src/sim')),
};
const dependency = async (name) => {
  const pkg = JSON.parse(await readFile(`node_modules/${name}/package.json`, 'utf8'));
  if (pkg.version !== sourceLock.packages[`node_modules/${name}`].version)
    throw new Error(`SOURCE_DEPENDENCY_MISMATCH: run npm ci for ${name}`);
  return { version: pkg.version, license: pkg.license };
};
const metadata = {
  schemaVersion: 1,
  product: { name: product.name, version: product.version },
  source: { commit, dirty, localChangesSha256, scope: 'build-inputs', inputs },
  build: {
    kind: releaseSource ? 'release' : 'local',
    createdAt: new Date().toISOString(),
    configuration,
    configurationSha256: hash(JSON.stringify(configuration)),
  },
  toolchain: {
    node: process.version,
    npm: npmVersion,
    platform: process.platform,
    arch: process.arch,
    required: product.engines,
    esbuild: (await dependency('esbuild')).version,
  },
  locks: {
    source: { path: 'package-lock.json', sha256: hash(sourceLockBytes) },
    runtime: { path: 'package-lock.json', sha256: hash(runtimeLockBytes) },
  },
  dependencies: {
    runtime: {
      ws: {
        ...(await dependency('ws')),
        integrity: runtimeLock.packages['node_modules/ws'].integrity,
      },
    },
    bundled: { three: await dependency('three'), fflate: await dependency('fflate') },
  },
  configuration: {
    defaults: readConfig({}),
    environment: ['HOST', 'PORT', 'SNAPSHOT_HZ', 'MAX_ROOMS', 'MAX_CONNECTIONS'],
  },
};
const define = {
  'process.env.NODE_ENV': '"production"',
  HARBOR_BUILD_ID: JSON.stringify(identity.build),
  HARBOR_RULES_ID: JSON.stringify(identity.rules),
};
const outputs = [];
async function output(path, body) {
  await mkdir(resolve(path, '..'), { recursive: true });
  await writeFile(path, body);
  outputs.push({
    path: relative('dist', path).replaceAll('\\', '/'),
    bytes: Buffer.byteLength(body),
    sha256: hash(body),
  });
  console.log(`built ${path} (${Buffer.byteLength(body)} bytes)`);
}
async function page(entry, online) {
  const result = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: 'iife',
    minify: configuration.browser.minify,
    sourcemap: false,
    target: configuration.browser.target,
    write: false,
    legalComments: 'none',
    define,
  });
  const template = await readFile('src/index.html', 'utf8');
  const css =
    (await readFile('src/style.css', 'utf8')) +
    '\n' +
    (await readFile('src/lab/lab.css', 'utf8')) +
    (online
      ? '\n.online-sample .mode-grid{grid-template-columns:1fr}.online-sample #modeHint{display:none}'
      : '');
  const license = await readFile('node_modules/three/LICENSE', 'utf8');
  const compressionLicense = online
    ? '\nfflate license\n' + (await readFile('node_modules/fflate/LICENSE', 'utf8'))
    : '';
  return template
    .replace(
      '<head>',
      () =>
        '<head>\n<!-- Three.js license\n' +
        (license + compressionLicense).replace(/-->/g, '-- >') +
        '\n-->',
    )
    .replace('/*__CSS__*/', () => css)
    .replace('/*__JS__*/', () => result.outputFiles[0].text.replace(/<\/script>/g, '<\\/script>'));
}
if (target === 'all' || target === 'offline') {
  const html = await page('src/client/entries/offline.js', false);
  await output('dist/offline/harbor-after-rain.html', html);
  await output('dist/index.html', html);
}
if (target === 'all' || target === 'online')
  await output('dist/online/index.html', await page('src/client/entries/online.js', true));
if (target === 'all' || target === 'server') {
  const result = await esbuild.build({
    entryPoints: ['server/main.js'],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: configuration.server.target,
    external: configuration.server.external,
    write: false,
    define,
    legalComments: 'none',
  });
  await output('dist/server/main.js', result.outputFiles[0].text);
  await output('dist/licenses/three.txt', await readFile('node_modules/three/LICENSE', 'utf8'));
  await output('dist/licenses/ws.txt', await readFile('node_modules/ws/LICENSE', 'utf8'));
  await output('dist/licenses/fflate.txt', await readFile('node_modules/fflate/LICENSE', 'utf8'));
}
// A target manifest never claims that other targets were rebuilt.
const builtFiles = outputs.slice();
for (const builtTarget of target === 'all' ? ['offline', 'online', 'server'] : [target]) {
  const files = builtFiles.filter(
    ({ path }) =>
      path.startsWith(`${builtTarget}/`) ||
      (builtTarget === 'offline' && path === 'index.html') ||
      (builtTarget === 'server' && path.startsWith('licenses/')),
  );
  await output(
    `dist/${builtTarget}-manifest.json`,
    JSON.stringify({ identity, target: builtTarget, files }, null, 2) + '\n',
  );
}
if (target === 'all') {
  await output('dist/package.json', runtimeBytes);
  await output('dist/package-lock.json', runtimeLockBytes);
  await output('dist/RUNNING.md', await readFile('packaging/RUNNING.md', 'utf8'));
  await output('dist/verify.mjs', await readFile('packaging/verify.mjs', 'utf8'));
  await output(
    'dist/release.json',
    JSON.stringify({ ...metadata, identity, target, files: outputs.slice() }, null, 2) + '\n',
  );
}
