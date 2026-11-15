import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createApp } from './app.js';
import { readConfig } from './config.js';
import { IDENTITY } from '../src/protocol/messages.js';

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const packaged = new URL('../online/index.html', import.meta.url);
  const base = existsSync(packaged)
    ? new URL('../', import.meta.url)
    : new URL('../dist/', import.meta.url);
  const manifest = existsSync(new URL('online-manifest.json', base))
    ? new URL('online-manifest.json', base)
    : new URL('release.json', base);
  const identity = existsSync(packaged)
    ? IDENTITY
    : existsSync(manifest)
      ? JSON.parse(readFileSync(manifest, 'utf8')).identity
      : IDENTITY;
  const { name, version } = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  );
  const app = createApp({
    config: readConfig(),
    identity,
    product: { name, version },
    staticRoot: fileURLToPath(new URL('online/', base)),
    offlineFile: fileURLToPath(new URL('offline/harbor-after-rain.html', base)),
  });
  const address = await app.start();
  console.log(`Online: http://${address.address}:${address.port}`);
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.on(signal, async () => {
      if (stopping) return;
      stopping = true;
      console.log(`Stopping: ${signal}`);
      const deadline = setTimeout(() => process.exit(1), 5000);
      deadline.unref();
      await app.close();
      clearTimeout(deadline);
      console.log(`Stopped: ${signal}`);
      process.exit(0);
    });
}
