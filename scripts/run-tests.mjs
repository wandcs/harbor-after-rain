import { readdir, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
async function discover(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) files.push(...(await discover(join(directory, entry.name))));
    else if (entry.isFile() && entry.name.endsWith('.test.mjs')) {
      files.push(join(directory, entry.name));
    }
  }
  return files.sort();
}
const options = { layer: 'all', case: null, file: null, out: null };
const nodeArgs = [];
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i],
    match = arg.match(/^--(layer|case|file|out)(?:=(.*))?$/);
  if (match) {
    const value = match[2] ?? process.argv[++i];
    if (!value || value.startsWith('--')) throw new Error(`Missing --${match[1]} value`);
    options[match[1]] = value;
  } else nodeArgs.push(arg);
}
const layers = new Set(['all', 'sim', 'protocol', 'server', 'client', 'tooling', 'legacy']);
if (!layers.has(options.layer)) throw new Error(`Unknown test layer: ${options.layer}`);
function layer(file) {
  const name = relative(root, file).replaceAll('\\', '/');
  if (name.startsWith('tests/sim/') || name === 'tests/server/combat.test.mjs') return 'sim';
  if (name.startsWith('tests/protocol/')) return 'protocol';
  if (name.startsWith('tests/server/')) return 'server';
  if (name.startsWith('tests/net/') || name.startsWith('tests/client/')) return 'client';
  if (name.startsWith('tests/tooling/')) return 'tooling';
  return 'legacy';
}
const files = options.file
  ? [resolve(root, options.file)]
  : (await discover(join(root, 'tests'))).filter(
      (file) => options.layer === 'all' || layer(file) === options.layer,
    );
if (!files.length) throw new Error('No tests found under tests/.');
if (options.file && options.layer !== 'all' && layer(files[0]) !== options.layer)
  throw new Error('Explicit file does not belong to the selected layer.');
if (options.case && nodeArgs.some((arg) => arg.startsWith('--test-name-pattern')))
  throw new Error('Choose --case or --test-name-pattern, not both.');
if (nodeArgs.some((arg) => arg.startsWith('--test-reporter')))
  throw new Error('Reporters are managed by this runner; use --out.');
if (options.case) {
  const escaped = options.case.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  nodeArgs.push(
    `--test-name-pattern=^${escaped}${/^(?:S[12345]|O3)-[A-Z]\d+$/.test(options.case) ? '(?: |$)' : '$'}`,
  );
}
const out = resolve(root, options.out || `artifacts/test-runs/${Date.now()}-${randomUUID()}`);
await mkdir(out, { recursive: true });
const eventsFile = join(out, 'events.jsonl');
const childEnv = { ...process.env };
delete childEnv.NODE_TEST_CONTEXT;
const child = spawn(
  process.execPath,
  [
    '--test',
    '--test-timeout=10000',
    '--test-reporter=spec',
    `--test-reporter=${new URL('./test-report.mjs', import.meta.url).href}`,
    '--test-reporter-destination=stdout',
    `--test-reporter-destination=${eventsFile}`,
    ...nodeArgs,
    ...files,
  ],
  {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true,
    env: childEnv,
  },
);
const deadline = setTimeout(() => child.kill(), 120000);
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill());
child.on('error', (error) => {
  clearTimeout(deadline);
  console.error(error);
  process.exitCode = 1;
});
child.on('exit', async (code) => {
  clearTimeout(deadline);
  try {
    const events = (await readFile(eventsFile, 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(JSON.parse);
    // Per-file summaries describe registered tests, while the outer summary
    // also counts empty-file placeholders. Structured paths need no TAP escaping.
    const summaries = events.filter((event) => event.type === 'test:summary' && event.data.file);
    const count = (key) => summaries.reduce((sum, event) => sum + event.data.counts[key], 0);
    const placeholders = summaries.filter((event) => !event.data.counts.tests).length;
    const summary = {
      layer: options.layer,
      case: options.case,
      files: files.map((file) => relative(root, file).replaceAll('\\', '/')),
      pass: count('passed'),
      fail: count('failed'),
      cancelled: count('cancelled'),
      skipped: count('skipped'),
      excludedFilePlaceholders: placeholders,
      exitCode: code ?? 1,
    };
    if (!summary.pass && !summary.fail && !summary.cancelled) {
      console.error('No selected tests executed.');
      summary.exitCode = 1;
    }
    await writeFile(join(out, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
    console.log(
      `Selected results: ${summary.pass} passed, ${summary.fail} failed; ${placeholders} empty-file placeholders excluded.`,
    );
    console.log(`Evidence: ${out}`);
    process.exitCode = summary.exitCode;
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
});
