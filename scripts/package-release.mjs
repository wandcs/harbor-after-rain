import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { zipSync } from 'fflate';
import { verifyRelease } from '../packaging/verify.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
let out = null,
  release = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--release') release = true;
  else if (args[i] === '--out') out = args[++i];
  else if (args[i].startsWith('--out=')) out = args[i].slice(6);
  else throw new Error('Unknown package option: ' + args[i]);
  if (out !== null && (!out || out.startsWith('--'))) throw new Error('Missing --out directory');
}
const build = spawnSync(
  process.execPath,
  [resolve(root, 'build.mjs'), ...(release ? ['--release'] : [])],
  {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true,
    timeout: 60000,
  },
);
if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status || 1);
const dist = resolve(root, 'dist');
const manifest = await verifyRelease(dist);
const name = `${manifest.product.name}-v${manifest.product.version}-${manifest.identity.build.slice(0, 12)}${release ? '' : '-local'}`;
const directory = resolve(
  out ||
    resolve(root, 'artifacts/releases', `${Date.now()}-${manifest.identity.build.slice(0, 12)}`),
);
await mkdir(directory, { recursive: true });
const entries = {};
for (const path of [...manifest.files.map((file) => file.path), 'release.json'])
  entries[`${name}/${path}`] = new Uint8Array(await readFile(resolve(dist, path)));
const archive = zipSync(entries, { level: 6, mtime: new Date(manifest.build.createdAt) });
const manifestBytes = await readFile(resolve(dist, 'release.json'));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
await writeFile(resolve(directory, `${name}.zip`), archive, { flag: 'wx' });
await writeFile(resolve(directory, 'release.json'), manifestBytes, { flag: 'wx' });
await writeFile(
  resolve(directory, 'SHA256SUMS'),
  `${hash(archive)}  ${name}.zip\n${hash(manifestBytes)}  release.json\n`,
  { flag: 'wx' },
);
console.log(`Package: ${resolve(directory, `${name}.zip`)}`);
console.log(`Checksums: ${resolve(directory, 'SHA256SUMS')}`);
