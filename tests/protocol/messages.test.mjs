import test from 'node:test';
import assert from 'node:assert/strict';
import { CombatMatch } from '../../src/sim/combat-match.js';
import { saveActor } from '../../src/sim/actor-state.js';
import { compressBlock, decompressBlock } from '../../src/protocol/blocks.js';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import {
  encodeCompact,
  decodeCompact,
  encodePublicState,
  encodePublicFragment,
  encodeSnapshot,
} from '../../src/protocol/compact.js';
import {
  validateClient,
  decodeMessage,
  encodeMessage,
  compatible,
  IDENTITY,
  INPUT_FLAGS,
} from '../../src/protocol/messages.js';

export const input = (changes = {}) => ({
  yaw: 0,
  pitch: 0,
  moveX: 0,
  moveZ: 0,
  ...Object.fromEntries(INPUT_FLAGS.map((key) => [key, false])),
  ...changes,
});
export const frame = (changes = {}) => ({
  type: 'input',
  seq: 1,
  tick: 1,
  lifeId: 1,
  stageId: 1,
  createdAtMs: 0,
  display: null,
  input: input(),
  ...changes,
});

test('protocol accepts bounded inputs and rejects forged identity, extra actions and non-finite fields', () => {
  assert.equal(validateClient(frame()), null);
  for (const value of [
    frame({ actorId: 3 }),
    frame({ seq: -1 }),
    frame({ input: input({ moveX: Infinity }) }),
    frame({ input: input({ sw: 4 }) }),
    frame({ display: { a: 2, b: 1, alpha: 0.5 } }),
    frame({ input: input({ fire: 1 }) }),
  ])
    assert.ok(validateClient(value));
  for (const message of [
    { type: 'list' },
    { type: 'create', name: '', mode: 'relay', teamSize: 8, password: 'secret', primary: 'awm' },
    { type: 'join', name: 'A', roomId: 1 },
    { type: 'loadout', primary: 'mp5' },
    frame({ input: input({ sw: 2, altPressed: true }) }),
  ])
    assert.equal(validateClient(message), null);
  for (const message of [
    { type: 'create', name: '', mode: 'other', teamSize: 4 },
    { type: 'create', name: '', mode: 'tdm', teamSize: 6 },
    { type: 'join', name: 'A', roomId: 0 },
    { type: 'join', name: 'A', roomId: 1, password: 'x'.repeat(33) },
    { type: 'loadout', primary: 'he' },
    frame({ input: input({ altPressed: 1 }) }),
  ])
    assert.ok(validateClient(message));
  assert.ok(compatible(IDENTITY));
  for (const key of ['protocol', 'build', 'rules'])
    assert.equal(
      compatible({ ...IDENTITY, [key]: key === 'protocol' ? IDENTITY.protocol + 1 : 'other' }),
      false,
      key,
    );
});
test('complete codec preserves exact private/input state and bounded public state while rejecting malformed messages', () => {
  const precise = frame({
    seq: 1e9,
    tick: 1e9,
    createdAtMs: 1e12,
    display: { a: 10, b: 11, alpha: 0.3 },
    input: input({ yaw: -0, pitch: 0.3, moveX: -0.3, sw: null, altPressed: false }),
  });
  assert.ok(
    encodeMessage(precise) instanceof Uint8Array,
    'high-frequency input uses owned binary bytes',
  );
  for (const value of [frame(), precise, frame({ input: input({ sw: 0, altPressed: true }) })]) {
    assert.deepEqual(decodeMessage(encodeMessage(value)), value);
    assert.equal(validateClient(decodeMessage(encodeMessage(value))), null);
  }
  for (const mode of ['tdm', 'relay']) {
    const match = new CombatMatch({ teamSize: 8, mode, seed: 4207 }),
      actor = match.join('完整状态\uD800'),
      target = match.actors.find((value) => value.team !== actor.team);
    let seq = 0;
    const packets = [];
    const capture = () => {
      const snapshotSeq = ++seq;
      packets.push({
        type: 'snapshot',
        public: {
          ...match.publicState(snapshotSeq, (match.tick * 1000) / 60),
          rosterVersion: match.nextId,
        },
        own: {
          snapshotSeq,
          actorId: actor.id,
          ackSeq: seq,
          activeInput: actor.activeInput,
          state: saveActor(actor),
        },
      });
    };
    capture(); // Initial poses include exact negative zero and zero-dt samples.
    for (let tick = 1; tick <= 24; tick++)
      match.step(
        1 / 60,
        (tick * 1000) / 60,
        new Map([
          [
            actor.id,
            frame({
              tick,
              seq: tick,
              lifeId: actor.lifeId,
              input: input({ moveX: 0.3, fire: true }),
            }),
          ],
        ]),
      );
    capture();
    target.protectT = 0;
    match.damage(target, actor, 1000, 'head', 'm4a1', target.pos.clone().set(1, 0, 0), false);
    capture();
    match.pause(actor.id);
    capture();
    match.resume(actor.id, 1000);
    capture();
    assert.ok(packets.some((p) => p.public.actors.some((a) => a.corpse)));
    const shot = {
      type: 'event',
      roomId: 1,
      event: match.events.find((value) => value.type === 'shot'),
    };
    assert.ok(shot.event);
    assert.ok(encodeMessage(shot) instanceof Uint8Array);
    assert.deepEqual(
      decodeMessage(encodeMessage(shot)),
      shot,
      'shot origin, direction and diagnostics remain exact',
    );
    let previousBasis = null;
    for (const packet of packets) {
      const original = structuredClone(packet),
        bytes = encodeMessage(packet),
        retained = bytes.slice();
      const canonical = decodeMessage(bytes);
      if (previousBasis) {
        const raw = encodePublicState(packet.public),
          retainedBase = previousBasis.bytes.slice();
        const wire = encodeSnapshot(
            encodePublicFragment(raw, { base: previousBasis, offer: true }),
            packet.own,
          ),
          meta = {};
        assert.deepEqual(
          decodeMessage(wire, 131072, {
            bases: new Map([[previousBasis.seq, previousBasis.bytes]]),
            meta,
          }),
          canonical,
          'actual full 8v8 state reconstructs from an acknowledged base',
        );
        assert.deepEqual(previousBasis.bytes, retainedBase);
        assert.equal(meta.publicBasis.offer, true);
        assert.throws(
          () => decodeMessage(wire, 131072, { clientOnly: true }),
          /BAD_CLIENT_MESSAGE/,
        );
      }
      previousBasis = { seq: packet.public.snapshotSeq, bytes: encodePublicState(packet.public) };
      assert.deepEqual(
        decodeCompact(encodeCompact(packet, { lossless: true })),
        original,
        'lossless contract remains strict',
      );
      assert.deepEqual(canonical.own, original.own, 'prediction correction is never quantized');
      const { actors: actualActors, ...actualPublic } = canonical.public;
      const { actors: expectedActors, ...expectedPublic } = original.public;
      assert.deepEqual(actualPublic, expectedPublic);
      for (let i = 0; i < actualActors.length; i++) {
        const actual = actualActors[i],
          expected = expectedActors[i];
        assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort());
        for (const key of ['id', 'lifeId', 'alive', 'hp', 'armor', 'protectT', 'radarT', 'stats'])
          assert.deepEqual(actual[key], expected[key]);
        for (const key of ['speed', 'fwd'])
          assert.equal(actual.pose.input[key], expected.pose.input[key]);
        assert.equal(actual.pose.state.crouchK, expected.pose.state.crouchK);
        assert.equal(actual.pose.dt, expected.pose.dt);
        for (let axis = 0; axis < 3; axis++)
          assert.ok(Math.abs(actual.pos[axis] - expected.pos[axis]) <= 0.0005);
      }
      assert.deepEqual(packet, original, 'encoding never mutates authority state');
      encodeMessage(packets.at(-1));
      assert.deepEqual(bytes, retained, 'later packets do not reuse in-flight storage');
      const decoded = decodeMessage(bytes);
      assert.deepEqual(
        decodeMessage(
          encodeSnapshot(encodePublicFragment(encodePublicState(packet.public)), packet.own),
        ),
        canonical,
        'shared public fragment and standalone complete encoder agree',
      );
      decoded.public.actors[0].pos[0] += 1;
      assert.deepEqual(
        decodeMessage(bytes),
        canonical,
        'decoded snapshots own their nested values',
      );
      for (const end of [0, 2, bytes.length - 1])
        assert.throws(() => decodeMessage(bytes.subarray(0, end)));
      assert.throws(() => decodeMessage(new Uint8Array([...bytes, 0])));
      assert.throws(() => decodeMessage(bytes, bytes.length - 1));
      const badVersion = bytes.slice();
      badVersion[1] = 255;
      assert.throws(() => decodeMessage(badVersion));
    }
    match.end('codec-test');
  }
  for (const text of [
    '{"x":1e999}',
    '{"__proto__":{}}',
    '['.repeat(22) + '0' + ']'.repeat(22),
    'x'.repeat(131073),
  ])
    assert.throws(() => decodeMessage(text));
  assert.throws(() => encodeMessage(frame({ input: input({ injected: true }) })));
  assert.throws(() => encodeMessage(frame({ input: input({ yaw: Infinity }) })));
  const invalidReference = encodeMessage({ type: 'snapshot', public: { roomId: 1 / 7 }, own: {} });
  invalidReference[5] = 4;
  assert.throws(() => decodeMessage(invalidReference), /BAD_BASE_FLAGS/);
  const baseline = encodePublicState({
      snapshotSeq: 42,
      roomId: 1,
      actors: [{ id: 1, pos: [1, 2, 3] }],
    }),
    preserved = baseline.slice();
  for (const publicValue of [
    { snapshotSeq: 43, roomId: 1, actors: [{ id: 1, pos: [1.1, 2, 3] }] },
    {
      snapshotSeq: 44,
      roomId: 1,
      actors: [
        { id: 1, pos: [9, 2, 3] },
        { id: 2, pos: [0, 0, 0] },
      ],
    },
    { snapshotSeq: 45, roomId: 1, actors: [] },
  ]) {
    const raw = encodePublicState(publicValue),
      own = { snapshotSeq: publicValue.snapshotSeq },
      delta = encodeSnapshot(
        encodePublicFragment(raw, { base: { seq: 42, bytes: baseline } }),
        own,
      ),
      meta = {};
    assert.throws(() => decodeMessage(delta), /MISSING_BASE/);
    assert.deepEqual(
      decodeMessage(delta, 131072, { bases: new Map([[42, baseline]]), meta }),
      decodeMessage(encodeSnapshot(encodePublicFragment(raw), own)),
    );
    assert.equal(meta.publicBasis.baseSeq, 42);
    assert.deepEqual(meta.publicBasis.bytes, raw);
    assert.deepEqual(baseline, preserved, 'delta never overwrites its base');
  }
  for (const size of [0, 1, 5, 12, 13, 15, 255, 1024, 2048]) {
    for (const pattern of [1, 7, 251]) {
      const raw = Uint8Array.from({ length: size }, (_, i) => i % pattern);
      assert.deepEqual(decompressBlock(compressBlock(raw), size), raw);
      assert.deepEqual(
        new Uint8Array(inflateRawSync(compressBlock(raw))),
        raw,
        'independent zlib decodes our block',
      );
      assert.deepEqual(
        decompressBlock(deflateRawSync(raw), size),
        raw,
        'independent zlib block decodes',
      );
    }
  }
  for (const bad of [[0], [0xf0, 255], [0, 0, 0], [0x10, 65, 2, 0], [0x1f, 65, 1, 0, 255]])
    assert.throws(() => decompressBlock(Uint8Array.from(bad), 20));
  assert.throws(() => decompressBlock(Uint8Array.of(0), 131073));
  assert.throws(() => decompressBlock(Uint8Array.of(0), -1));
  const multiBlock = {
    type: 'snapshot',
    public: { actors: [{ name: 'large'.repeat(2000) }] },
    own: {},
  };
  assert.deepEqual(decodeMessage(encodeMessage(multiBlock)), multiBlock);
  assert.throws(() =>
    encodeMessage({ ...multiBlock, public: { actors: [{ name: 'x'.repeat(131073) }] } }),
  );
  assert.throws(
    () => decompressBlock(deflateRawSync(new Uint8Array(1000000)), 64),
    /BAD_COMPRESSED_BLOCK/,
  );
});
