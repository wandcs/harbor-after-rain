import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import * as prettier from 'prettier';
import { checkModules, sourceFiles } from './module-check.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const governed = [
  ...(await sourceFiles(resolve(root, 'src/sim'))),
  ...(await sourceFiles(resolve(root, 'src/protocol'))),
  ...(await sourceFiles(resolve(root, 'src/net'))),
  ...(await sourceFiles(resolve(root, 'src/client'))),
  ...(await sourceFiles(resolve(root, 'server'))),
  ...(await sourceFiles(resolve(root, 'tests/sim'))),
  ...(await sourceFiles(resolve(root, 'tests/tooling'))),
  ...(await sourceFiles(resolve(root, 'tests/net'))),
  ...(await sourceFiles(resolve(root, 'tests/client'))),
  ...(await sourceFiles(resolve(root, 'tests/protocol'))),
  ...(await sourceFiles(resolve(root, 'tests/server'))),
  ...(await sourceFiles(resolve(root, 'scripts/s3'))),
  ...(await sourceFiles(resolve(root, 'scripts/s5'))),
  ...[
    'src/actor.js',
    'src/actor-view.js',
    'src/bots.js',
    'src/physics.js',
    'src/weapons.js',
    'src/combat-feedback.js',
    'src/tactics.js',
    'scripts/run-tests.mjs',
    'scripts/test-report.mjs',
    'scripts/browser-config.mjs',
    'scripts/s1-browser-check.mjs',
    'scripts/s1-preview-check.mjs',
    'scripts/s2-browser-check.mjs',
    'scripts/s2-operation-recovery.mjs',
    'scripts/s2-launch-check.mjs',
    'scripts/runtime-check-support.mjs',
    'scripts/local-runtime-check.mjs',
    'scripts/npm-cli.mjs',
    'scripts/package-release.mjs',
    'packaging/verify.mjs',
    'scripts/s4-browser-check.mjs',
    'build.mjs',
    'scripts/capture-s1-baseline.mjs',
    'scripts/check.mjs',
    'scripts/module-check.mjs',
    'eslint.config.mjs',
    'prettier.config.mjs',
  ].map((file) => resolve(root, file)),
];
const errors = [];
for (const file of governed) {
  const options = await prettier.resolveConfig(file);
  if (!(await prettier.check(await readFile(file, 'utf8'), { ...options, filepath: file })))
    errors.push(`Formatting: ${file}`);
}
const eslint = new ESLint({ cwd: root });
const results = await eslint.lintFiles(governed);
const formatter = await eslint.loadFormatter('stylish');
const lintOutput = formatter.format(results);
if (lintOutput) console.log(lintOutput);
const modules = await checkModules(root);
errors.push(...modules.errors);
for (const error of errors) console.error(error);
const lintErrors = results.reduce((count, result) => count + result.errorCount, 0);
console.log(
  `Checked ${governed.length} formatted/static-rule files; ${modules.files} runtime modules for syntax, cycles and boundaries.`,
);
if (errors.length || lintErrors) process.exitCode = 1;
