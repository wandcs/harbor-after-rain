import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, relative } from 'node:path';
export async function builtIdentity() {
  const root = resolve('.');
  async function files(name) {
    const result = [];
    for (const entry of await readdir(name, { withFileTypes: true })) {
      const path = resolve(name, entry.name);
      if (entry.isDirectory()) result.push(...(await files(path)));
      else result.push(path);
    }
    return result.sort();
  }
  async function hash(paths) {
    const result = createHash('sha256');
    for (const path of paths) {
      result.update(relative(root, path).replaceAll('\\', '/'));
      result.update(await readFile(path));
    }
    return result.digest('hex');
  }
  const { identity } = JSON.parse(await readFile('dist/release.json', 'utf8'));
  const build = await hash([
    ...(await files('src')),
    ...(await files('server')),
    resolve('build.mjs'),
    resolve('package-lock.json'),
  ]);
  const rules = await hash(await files('src/sim'));
  if (identity.build !== build || identity.rules !== rules)
    throw new Error('Built identity differs from sources: run npm run build');
  return identity;
}
