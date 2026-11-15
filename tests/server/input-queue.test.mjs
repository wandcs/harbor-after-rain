import test from 'node:test';
import assert from 'node:assert/strict';
import { InputQueue } from '../../server/sync/input-queue.js';
import { readConfig } from '../../server/config.js';
import { INPUT_FLAGS } from '../../src/protocol/messages.js';
const actor = { lifeId: 1 };
const frame = (seq, tick, extra = {}) => ({
  seq,
  tick,
  lifeId: 1,
  stageId: 1,
  createdAtMs: 0,
  input: Object.fromEntries(INPUT_FLAGS.map((key) => [key, true])),
  ...extra,
});
test('arrival never moves time; one input per step and discard frontier advances only on consumption', () => {
  const q = new InputQueue(readConfig({}));
  q.push(frame(1, 2), actor, 1, 0, 0);
  q.push(frame(2, 2), actor, 1, 0, 0);
  assert.equal(q.ackSeq, 0);
  assert.equal(q.consume(actor, 1, 1, 16), null);
  assert.equal(q.consume(actor, 1, 2, 33).seq, 1);
  assert.equal(q.ackSeq, 2);
  assert.equal(q.discarded, 1);
  const reused = q.consume(actor, 1, 3, 50);
  assert.ok(reused.reused);
  assert.ok(reused.input.fire);
  for (const key of ['firePressed', 'jump', 'reload']) assert.equal(reused.input[key], false);
  assert.equal(q.consume(actor, 1, 20, 251), null);
  for (const age of [249, 250, 251]) {
    const boundary = new InputQueue(readConfig({}));
    boundary.push(frame(1, 1), actor, 1, 0, 0);
    boundary.consume(actor, 1, 1, 1);
    const value = boundary.consume(actor, 1, 2, age);
    assert.equal(!!value, age <= 250, `age=${age}`);
    if (value)
      assert.deepEqual(
        [value.input.fire, value.input.firePressed, value.input.jump, value.input.reload],
        [true, false, false, false],
      );
  }
});
test('late, wrong-life/stage and future frames are acknowledged as discarded without executing or reviving held edges', () => {
  const q = new InputQueue(readConfig({}));
  const invalid = [
    { tick: 0 },
    { lifeId: 0 },
    { stageId: 0 },
    { tick: 100 },
    { createdAtMs: -500 },
  ];
  invalid.forEach((value, i) => q.push(frame(i + 1, 1, value), actor, 1, 0, 0));
  assert.equal(q.consume(actor, 1, 1, 16), null);
  assert.equal(q.ackSeq, 5);
  assert.equal(q.push(frame(7, 2), actor, 1, 1, 16), 'INPUT_SEQUENCE');
  q.push(frame(6, 2), actor, 1, 1, 16);
  q.clear();
  assert.equal(q.ackSeq, 6);
  assert.equal(q.consume(actor, 2, 2, 33), null);
});
test('input queues have finite admission and config only accepts the two sync presets', () => {
  assert.deepEqual([readConfig({}).maxRooms, readConfig({}).maxConnections], [2, 32]);
  for (const [hz, bufferMs, rewindMs] of [
    [60, 1000 / 30, 225],
    [30, 1000 / 15, 250],
  ]) {
    const config = readConfig({ SNAPSHOT_HZ: String(hz) });
    assert.deepEqual(
      [config.snapshotHz, config.bufferMs, config.rewindMs],
      [hz, bufferMs, rewindMs],
    );
  }
  const c = readConfig({ SNAPSHOT_HZ: '30' });
  assert.throws(() => readConfig({ SNAPSHOT_HZ: '45' }));
  assert.throws(() => readConfig({ PORT: 'NaN' }));
  const q = new InputQueue({ ...c, maxInputQueue: 1 });
  q.push(frame(1, 2), actor, 1, 0, 0);
  assert.equal(q.push(frame(2, 3), actor, 1, 0, 0), 'INPUT_OVERFLOW');
});
