import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// Invoke npm through Node on Windows too; no shell or command-string escaping.
export function npmCli() {
  for (const path of [
    process.env.npm_execpath,
    resolve(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    resolve(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js'),
  ])
    if (path && existsSync(path)) return path;
  throw new Error('NPM_CLI_MISSING: use npm run, with Node.js 24 and npm 11 installed');
}
