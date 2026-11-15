import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import assert from 'node:assert/strict';

const options = {};
for (let i = 2; i < process.argv.length; i++) {
  const match = process.argv[i].match(/^--(out|file)(?:=(.*))?$/);
  if (!match) throw new Error('Unknown preview-check option');
  const value = match[2] ?? process.argv[++i];
  if (!value || value.startsWith('--')) throw new Error('Missing --' + match[1]);
  options[match[1]] = resolve(value);
}
const server = spawn(
  process.execPath,
  [
    fileURLToPath(new URL('./serve.mjs', import.meta.url)),
    ...(options.file ? ['--file', options.file] : []),
  ],
  {
    cwd: tmpdir(),
    env: { ...process.env, PORT: '0' },
    windowsHide: true,
  },
);
const exited = once(server, 'exit');
let errorOutput = '';
server.stderr.on('data', (chunk) => {
  errorOutput += chunk;
});
const selectedOut = options.out;
const out = selectedOut
  ? resolve(selectedOut, 'preview.json')
  : fileURLToPath(new URL('../artifacts/online-s1/preview.json', import.meta.url));
try {
  const address = await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Preview did not start: ${errorOutput}`)),
      10000,
    );
    server.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    server.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`Preview exited: ${code} ${errorOutput}`));
    });
    server.stdout.on('data', (chunk) => {
      const match = chunk.toString().match(/Local: (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) {
        clearTimeout(timeout);
        resolve(match[1]);
      }
    });
  });
  const response = await fetch(address, { signal: AbortSignal.timeout(10000) });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/html/);
  const html = Buffer.from(await response.arrayBuffer());
  const built = await readFile(options.file || new URL('../dist/index.html', import.meta.url));
  assert.equal(
    createHash('sha256').update(html).digest('hex'),
    createHash('sha256').update(built).digest('hex'),
  );
  const traversal = await fetch(`${address}/%2e%2e%5cpackage.json`, {
    signal: AbortSignal.timeout(10000),
  });
  assert.ok([403, 404].includes(traversal.status));
  await mkdir(dirname(out), { recursive: true });
  const result = {
    address,
    status: response.status,
    bytes: html.length,
    sha256: createHash('sha256').update(html).digest('hex'),
    traversalStatus: traversal.status,
    cwd: tmpdir(),
  };
  await writeFile(out, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  server.kill();
  await exited;
}
