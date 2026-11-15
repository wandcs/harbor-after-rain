import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { SampleRoom } from '../../server/rooms/sample-room.js';
import { Outbox } from '../../server/transport/outbox.js';
import { readConfig } from '../../server/config.js';
import { INPUT_FLAGS, decodeMessage } from '../../src/protocol/messages.js';
import { encodeBinary, decodeBinary } from './codec.mjs';
import {
  encodeCompact,
  decodeCompact,
  encodeCompactJson,
  decodeCompactJson,
  isCompactMessage,
} from '../../src/protocol/compact.js';
import { deflateRawSync } from 'node:zlib';
import { builtIdentity } from './source.mjs';

const out = resolve(
  process.argv.find((s) => s.startsWith('--out='))?.slice(6) ||
    `artifacts/online-s3/encoding-${Date.now()}`,
);
const teamSize = Number(process.argv.find((s) => s.startsWith('--team-size='))?.slice(12) || 4);
assert.ok([4, 8].includes(teamSize), 'Encoding corpus uses 4v4 or 8v8');
await mkdir(out, { recursive: true });
const stats = (values) => {
  const sorted = values.toSorted((a, b) => a - b);
  return {
    mean: values.reduce((a, b) => a + b, 0) / values.length,
    p95: sorted[Math.floor(sorted.length * 0.95)],
    max: sorted.at(-1),
  };
};
const report = {
  id: 'S3-E1',
  identity: await builtIdentity(),
  node: process.version,
  seed: 4207,
  teamSize,
  candidate:
    'same complete corpus: legacy dictionary and schema codecs; quantization/compression recorded per candidate',
  runs: [],
};
for (const hz of [60, 30]) {
  let now = 0;
  const messages = [],
    inputs = [],
    config = readConfig({ SNAPSHOT_HZ: String(hz) }),
    room = new SampleRoom(config, () => now, { teamSize });
  const join = () => {
    const socket = {
      readyState: 1,
      bufferedAmount: 0,
      send: (text) => {
        const message = decodeMessage(text);
        if (message.type === 'snapshot') {
          const raw = room.match.publicState(message.public.snapshotSeq, message.public.nowMs);
          message.public = JSON.parse(
            JSON.stringify({
              ...message.public,
              ...raw,
              actors: raw.actors.map(({ name, team, controlType, ...actor }) => actor),
            }),
          );
        }
        messages.push(message);
      },
      terminate() {
        throw new Error('UNEXPECTED_TERMINATE');
      },
    };
    const connection = { socket, outbox: new Outbox(socket, config, () => now) };
    room.join(connection, '实验玩家');
    return connection;
  };
  const a = join(),
    b = join(),
    actor = room.match.actors.find((p) => p.id === a.actorId),
    target = room.match.actors.find((p) => p.id === b.actorId);
  actor.pos.set(-1, 0, 6.8);
  actor.yaw = -Math.PI / 2;
  actor.pitch = -0.1;
  target.pos.set(1, 0, 6.8);
  target.hp = 1;
  target.protectT = 0;
  try {
    for (let tick = 1; tick <= 480; tick++) {
      now += 1000 / 60;
      const input = {
        yaw: actor.yaw,
        pitch: -0.1,
        moveX: 0,
        moveZ: 0,
        ...Object.fromEntries(INPUT_FLAGS.map((key) => [key, false])),
        fire: tick >= 30 && tick <= 60,
        reload: tick === 90,
      };
      const frame = {
        type: 'input',
        seq: tick,
        tick: room.match.tick + 1,
        lifeId: actor.lifeId,
        stageId: room.match.stageId,
        createdAtMs: now,
        display: null,
        input,
      };
      assert.equal(a.inputs.push(frame, actor, room.match.stageId, room.match.tick, now), null);
      inputs.push(frame);
      const other = {
        ...frame,
        lifeId: target.lifeId,
        input: { ...input, yaw: target.yaw, fire: false, reload: false },
      };
      assert.equal(b.inputs.push(other, target, room.match.stageId, room.match.tick, now), null);
      inputs.push(other);
      room.step(1 / 60, now);
      if (tick === 240) {
        room.match.pause(actor.id);
        room.publish();
        room.match.resume(actor.id, now);
        room.publish();
      }
    }
    room.match.end('encoding-fixture');
    room.publish();
    const controls = [
      { type: 'list' },
      {
        type: 'rooms',
        rooms: [
          {
            id: room.id,
            mode: room.match.mode,
            humans: 2,
            capacity: 8,
            passwordRequired: false,
            phase: 'running',
            remainingMs: 180000,
          },
        ],
      },
      { type: 'create', name: 'A', mode: 'tdm', teamSize: 4, primary: 'm4a1', password: '' },
      { type: 'join', name: 'B', roomId: room.id, password: '' },
      { type: 'loadout', primary: 'awm' },
      { type: 'result', result: room.match.result },
      { type: 'hello', identity: report.identity },
      { type: 'hello', identity: report.identity },
      { type: 'hello', identity: report.identity },
      { type: 'hello', identity: report.identity },
    ];
    for (let second = 0; second < 8; second++)
      for (let peer = 0; peer < 2; peer++) {
        controls.push({ type: 'clock', id: second + 1, clientMs: second * 1000 });
        controls.push({
          type: 'clock',
          id: second + 1,
          clientMs: second * 1000,
          nowMs: second * 1000,
          tick: second * 60,
        });
      }
    const packets = [...messages, ...inputs, ...controls],
      corpus = [
        ...messages.filter((p, i) => p.type !== 'snapshot' || i % 30 === 0),
        ...inputs.filter((p, i) => i % 60 === 0 || p.input.reload),
        ...controls,
      ].slice(0, 128);
    assert.ok(messages.some((p) => p.type === 'event' && p.event.type === 'death'));
    assert.ok(
      messages.some((p) => p.type === 'snapshot' && p.public.actors.some((actor) => actor.corpse)),
    );
    assert.ok(messages.some((p) => p.type === 'snapshot' && p.public.phase === 'countdown'));
    let jsonBytes = 0,
      binaryBytes = 0;
    for (const packet of packets) {
      const normalized = JSON.parse(JSON.stringify(packet)),
        bytes = encodeBinary(normalized);
      assert.deepEqual(decodeBinary(bytes), normalized);
      jsonBytes += Buffer.byteLength(JSON.stringify(normalized));
      binaryBytes += bytes.length;
    }
    const timings = {};
    for (const [name, encode, decode] of [
      ['json', JSON.stringify, JSON.parse],
      ['binary', encodeBinary, decodeBinary],
    ]) {
      const encodeUs = [],
        decodeUs = [];
      for (let round = 0; round < 9; round++)
        for (const packet of corpus) {
          const t0 = performance.now(),
            wire = encode(packet),
            t1 = performance.now();
          decode(wire);
          const t2 = performance.now();
          if (round) {
            encodeUs.push((t1 - t0) * 1000);
            decodeUs.push((t2 - t1) * 1000);
          }
        }
      timings[name] = { encodeUs: stats(encodeUs), decodeUs: stats(decodeUs) };
    }
    const probe = encodeBinary(corpus.find((p) => p.type === 'snapshot'));
    for (const end of [0, 3, 5, Math.floor(probe.length / 2), probe.length - 1])
      assert.throws(() => decodeBinary(probe.slice(0, end)));
    assert.throws(() => decodeBinary(new Uint8Array([...probe, 0])));
    assert.throws(() => encodeBinary({ bad: Infinity }));
    const result = {
      hz,
      packets: packets.length,
      sampledPackets: corpus.length,
      jsonBytes,
      binaryBytes,
      binaryRatio: binaryBytes / jsonBytes,
      exactRoundTrip: true,
      maxNumericError: 0,
      timings,
      corpusHash: createHash('sha256').update(JSON.stringify(corpus)).digest('hex'),
    };
    const high = isCompactMessage;
    const candidates = {
      compactJson: [
        (p) => (high(p) ? encodeCompactJson(p) : JSON.stringify(p)),
        (wire) => (wire.startsWith('[') ? decodeCompactJson(wire) : JSON.parse(wire)),
      ],
      compactBinary: [
        (p) => (high(p) ? encodeCompact(p, { lossless: true }) : JSON.stringify(p)),
        (wire) => (typeof wire === 'string' ? JSON.parse(wire) : decodeCompact(wire)),
      ],
      quantizedBinary: [
        (p) => (high(p) ? encodeCompact(p) : JSON.stringify(p)),
        (wire) => (typeof wire === 'string' ? JSON.parse(wire) : decodeCompact(wire)),
      ],
    };
    result.candidates = {};
    for (const [name, [encode, decode]] of Object.entries(candidates)) {
      let bytes = 0,
        deflatedBytes = 0,
        maxPublicNumericError = 0;
      const compare = (a, b) => {
        if (typeof a === 'number' && typeof b === 'number') {
          maxPublicNumericError = Math.max(maxPublicNumericError, Math.abs(a - b));
          return;
        }
        if (a && b && typeof a === 'object' && typeof b === 'object') {
          assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort());
          for (const key of Object.keys(a)) compare(a[key], b[key]);
        } else assert.deepEqual(a, b);
      };
      const encodeUs = [],
        decodeUs = [];
      for (const packet of packets) {
        const value = JSON.parse(JSON.stringify(packet)),
          wire = encode(value);
        const decoded = decode(wire);
        if (name === 'quantizedBinary' && value.type === 'snapshot') {
          assert.deepEqual(decoded.own, value.own);
          compare(decoded.public, value.public);
          assert.ok(maxPublicNumericError <= 0.00001);
        } else assert.deepEqual(decoded, value);
        const data = typeof wire === 'string' ? Buffer.from(wire) : wire;
        bytes += data.length;
        deflatedBytes += deflateRawSync(data, { level: 3 }).length;
      }
      for (let round = 0; round < 5; round++)
        for (const packet of corpus) {
          const start = performance.now(),
            wire = encode(packet),
            encoded = performance.now();
          decode(wire);
          const decoded = performance.now();
          if (round) {
            encodeUs.push((encoded - start) * 1000);
            decodeUs.push((decoded - encoded) * 1000);
          }
        }
      result.candidates[name] = {
        bytes,
        ratioToJson: bytes / jsonBytes,
        noContextDeflateLevel3Bytes: deflatedBytes,
        exactToJsonCorpus: name !== 'quantizedBinary',
        maxPublicNumericError,
        encodeUs: stats(encodeUs),
        decodeUs: stats(decodeUs),
        note: 'Offline byte/CPU comparison; deflate is not live WebSocket latency or memory evidence',
      };
    }
    report.runs.push(result);
    await writeFile(resolve(out, `corpus-${hz}.json`), JSON.stringify(corpus));
  } finally {
    room.close();
    a.outbox.clear();
    b.outbox.clear();
  }
}
report.passed = true;
await writeFile(resolve(out, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
