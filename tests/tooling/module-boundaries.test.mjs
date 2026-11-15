import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname, sep } from 'node:path';
import { checkModules } from '../../scripts/module-check.mjs';
import { ESLint } from 'eslint';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

async function fixture(files, run) {
  const base = resolve(tmpdir());
  const root = await mkdtemp(resolve(base, 'harbor-boundary-'));
  try {
    for (const [file, source] of Object.entries(files)) {
      const target = resolve(root, file);
      assert.ok(target.startsWith(root + sep));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, source);
    }
    await run(await checkModules(root));
  } finally {
    assert.ok(root.startsWith(base + sep + 'harbor-boundary-'));
    await rm(root, { recursive: true, force: true });
  }
}

test('architecture accepts shared CPU modules and legal host dependencies', async () => {
  await fixture(
    {
      'src/sim/actor.js': 'export const move = () => 1;',
      'src/client/view.js': "import { move } from '../sim/actor.js'; move();",
      'server/app.js': "import { move } from '../src/sim/actor.js'; move();",
      'src/protocol/blocks.js': "import { deflateSync } from 'fflate/browser'; void deflateSync;",
    },
    (result) => assert.deepEqual(result.errors, []),
  );
});

test('architecture rejects sim imports through legacy bridges and runtime reverse imports', async () => {
  await fixture(
    {
      'src/sim/actor.js': "import '../view.js';",
      'src/view.js': "import './client/model.js';",
      'src/client/model.js': "import '../../server/app.js';",
      'server/app.js': 'export const start = () => {};',
      'src/protocol/other.js': "import 'fflate/browser';",
    },
    (result) => {
      assert.ok(result.errors.some((error) => error.includes('sim -> legacy')));
      assert.ok(result.errors.some((error) => error.includes('client -> server')));
      assert.ok(result.errors.some((error) => error.includes('protocol external dependency')));
    },
  );
});

test('architecture rejects device APIs, rule global random, missing imports and cycles', async () => {
  await fixture(
    {
      'src/sim/a.js': "import './b.js'; document.createElement('canvas'); Math.random();",
      'src/sim/b.js': "export * from './a.js'; export * from './missing.js';",
    },
    (result) => {
      for (const pattern of ['Device/time API', 'random source', 'Unresolved', 'Import cycle']) {
        assert.ok(
          result.errors.some((error) => error.includes(pattern)),
          pattern,
        );
      }
    },
  );
});

test('architecture rejects GPU constructors through namespace aliases and named imports', async () => {
  await fixture(
    {
      'src/sim/model.js':
        "import * as View from 'three'; import { Mesh } from 'three'; new View.Mesh(); new Mesh();",
    },
    (result) => {
      assert.ok(result.errors.some((error) => error.includes('Non-CPU three API')));
      assert.ok(result.errors.some((error) => error.includes('Non-CPU import')));
    },
  );
});

test('locked checkers reject static violations and unmatched or failing test selections', async () => {
  const eslint = new ESLint({ cwd: fileURLToPath(new URL('../../', import.meta.url)) });
  const [core] = await eslint.lintText('const unused = 1;\n', { filePath: 'src/sim/probe.js' });
  assert.ok(core.messages.some((message) => message.ruleId === 'no-unused-vars'));
  const [browser] = await eslint.lintText('export const read = () => window.__game;\n', {
    filePath: 'scripts/s1-browser-check.mjs',
  });
  assert.deepEqual(browser.messages, []);
  const base = resolve(tmpdir()),
    probe = await mkdtemp(resolve(base, 'harbor-runner-'));
  const file = resolve(probe, 'nested', 'probe.test.mjs'),
    runner = fileURLToPath(new URL('../../scripts/run-tests.mjs', import.meta.url));
  await mkdir(dirname(file), { recursive: true });
  const run = (selected) =>
    new Promise((done, fail) => {
      const child = spawn(
        process.execPath,
        [runner, '--file', file, '--case', selected, '--out', resolve(probe, selected)],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let output = '';
      child.stdout.on('data', (data) => {
        output += data;
      });
      child.stderr.on('data', (data) => {
        output += data;
      });
      child.on('error', fail);
      child.on('exit', (code) => done({ code, output }));
    });
  try {
    await writeFile(
      file,
      "import test from 'node:test'; import assert from 'node:assert/strict'; test('probe',()=>assert.equal(1,1));\n",
    );
    const valid = await run('probe');
    assert.equal(valid.code, 0, valid.output);
    const missing = await run('missing');
    assert.notEqual(missing.code, 0, missing.output);
    assert.match(missing.output, /No selected tests executed/);
    await writeFile(
      file,
      "import test from 'node:test'; import assert from 'node:assert/strict'; test('probe',()=>assert.equal(1,2));\n",
    );
    const failure = await run('probe');
    assert.notEqual(failure.code, 0, failure.output);
  } finally {
    assert.ok(probe.startsWith(base + sep + 'harbor-runner-'));
    await rm(probe, { recursive: true, force: true });
  }
});
