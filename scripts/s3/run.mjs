import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { summarizeObservations } from './observations.mjs';
import { attributeTransport } from './transport-attribution.mjs';

const options = {
  case: 'all',
  hz: null,
  profile: null,
  topology: 'loopback',
  seed: '4207',
  trace: 'none',
  'tcp-tuning': 'none',
  out: `artifacts/online-s3/run-${Date.now()}`,
  user: process.env.USERNAME || process.env.USER,
};
for (let i = 2; i < process.argv.length; i++) {
  const match = process.argv[i].match(
    /^--(case|hz|profile|out|user|topology|seed|trace|tcp-tuning)(?:=(.*))?$/,
  );
  if (!match) throw new Error('Unknown option: ' + process.argv[i]);
  const value = match[2] ?? process.argv[++i];
  if (!value || value.startsWith('--')) throw new Error('Missing option');
  options[match[1]] = value;
}
const profiles = [
  'rtt0',
  'rtt50',
  'rtt100',
  'rtt150',
  'jitter',
  'loss',
  'interruption',
  'slow',
  'backlog',
];
assert.ok(['all', 'S3-E1', 'S3-E2'].includes(options.case), 'No selected S3 experiment');
assert.ok(options.hz === null || ['60', '30'].includes(options.hz));
assert.ok(options.profile === null || profiles.includes(options.profile));
assert.ok(['loopback', 'ingress'].includes(options.topology));
assert.ok(/^\d+$/.test(options.seed) && Number(options.seed) <= 0xffffffff);
assert.ok(['none', 'tcp', 'tcp-loopback'].includes(options.trace));
assert.ok(['none', 'baseline', 'server-rto100', 'client-ack10'].includes(options['tcp-tuning']));
if (options['tcp-tuning'] !== 'none')
  assert.ok(
    options.case === 'S3-E2' &&
      options.hz === '30' &&
      options.profile === 'interruption' &&
      options.topology === 'ingress' &&
      options.trace === 'tcp',
    'Socket tuning is restricted to explicit 30Hz ingress interruption with TCP tracing',
  );
if (options.trace === 'tcp')
  assert.ok(
    options.topology === 'ingress' &&
      options.case === 'S3-E2' &&
      options.hz &&
      ['rtt0', 'loss', 'interruption'].includes(options.profile),
    'TCP attribution requires an explicit ingress S3-E2 rtt0/loss/interruption configuration',
  );
if (options.trace === 'tcp-loopback')
  assert.ok(
    options.case === 'S3-E2' &&
      options.hz === '60' &&
      options.profile === 'interruption' &&
      options.topology === 'loopback' &&
      options['tcp-tuning'] === 'none',
    'Loopback diagnosis requires explicit S3-E2 60Hz interruption without tuning',
  );
if (
  options.case === 'S3-E1' &&
  (options.hz || options.profile || options.topology !== 'loopback' || options.seed !== '4207')
)
  throw new Error('Network selectors apply to S3-E2');
if (options.hz === '30' && options.profile === 'backlog')
  throw new Error(
    'The shared outbox backlog branch is measured at 60 Hz; use slow for 30 Hz isolation',
  );
const out = resolve(options.out);
await mkdir(out, { recursive: true });
const linux = (path) =>
  path.replace(/^([A-Z]):/i, (_, drive) => '/mnt/' + drive.toLowerCase()).replaceAll('\\', '/');
const results = [];
async function child(command, args) {
  const processChild = spawn(command, args, { stdio: 'inherit', windowsHide: true });
  const timer = setTimeout(() => processChild.kill(), 40000);
  try {
    await new Promise((done, fail) => {
      processChild.once('error', fail);
      processChild.once('exit', (code) =>
        code === 0 ? done() : fail(new Error('Experiment exited ' + code)),
      );
    });
  } finally {
    clearTimeout(timer);
  }
}
try {
  if (options.case !== 'S3-E2') {
    const directory = resolve(out, 'S3-E1');
    await child(process.execPath, ['scripts/s3/encoding.mjs', '--out=' + directory]);
    results.push({ case: 'S3-E1', passed: true, directory });
  }
  if (options.case !== 'S3-E1')
    for (const hz of options.hz ? [options.hz] : ['60', '30'])
      for (const profile of options.profile ? [options.profile] : profiles) {
        if (profile === 'backlog' && hz === '30') continue;
        const directory = resolve(out, `S3-E2-${hz}-${profile}`);
        await mkdir(directory, { recursive: true });
        const node = resolve('artifacts/toolchains/node-v24.18.0-linux-x64/bin/node');
        const args = [
          '--node',
          linux(node),
          '--user',
          options.user,
          '--out',
          linux(directory),
          '--hz',
          hz,
          '--profile',
          profile,
          '--topology',
          options.topology,
          '--seed',
          options.seed,
          '--trace',
          options.trace,
          '--tcp-tuning',
          options['tcp-tuning'],
        ];
        assert.equal(
          process.platform,
          'win32',
          'This entry currently orchestrates WSL; see the Linux command in the S3 plan',
        );
        await child('wsl.exe', [
          '-d',
          'Ubuntu-26.04',
          '-u',
          'root',
          '--',
          'unshare',
          '--net',
          '--',
          'python3',
          linux(resolve('scripts/s3/netem.py')),
          ...args,
        ]);
        const kernel = JSON.parse(await readFile(resolve(directory, 'kernel.json'), 'utf8'));
        if (profile === 'loss') {
          assert.ok(
            kernel.tcpDelta.RetransSegs > 0,
            'No TCP retransmissions observed; loss evidence insufficient',
          );
          assert.ok(
            kernel.finalQdisc.some((q) => q.drops > 0),
            'No kernel drops observed',
          );
        }
        if (profile === 'interruption') {
          assert.equal(kernel.transitions.length, 2, 'blackout and recovery both executed');
          assert.ok(
            (kernel.blackoutQdisc ?? []).some((q) => q.kind === 'netem' && q.drops > 0),
            'mid-blackout snapshot must prove actual dropped packets',
          );
        }
        const observed = JSON.parse(await readFile(resolve(directory, 'report.json'), 'utf8'));
        assert.deepEqual(observed.cleanup, { clients: 0, roomReleased: true, listening: false });
        await writeFile(
          resolve(directory, 'observations.json'),
          JSON.stringify(summarizeObservations(observed, kernel), null, 2),
        );
        if (options.trace === 'tcp') {
          const capture = JSON.parse(
            await readFile(resolve(directory, 'tcp-headers.json'), 'utf8'),
          );
          await writeFile(
            resolve(directory, 'transport-attribution.json'),
            JSON.stringify(attributeTransport(observed, kernel, capture), null, 2),
          );
        }
        results.push({ case: 'S3-E2', hz: Number(hz), profile, passed: true, directory });
      }
} finally {
  await writeFile(resolve(out, 'summary.json'), JSON.stringify(results, null, 2));
}
