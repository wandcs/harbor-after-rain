import test from 'node:test';
import assert from 'node:assert/strict';
import { collectInput } from '../../src/client/input/online-input.js';
import { Player } from '../../src/player.js';
import { validateClient } from '../../src/protocol/messages.js';

test('S2-N2 online input normalizes movement and consumes edges once', () => {
  const player = {
    keys: new Set(['KeyW', 'KeyD']),
    pressed: new Set(['Space', 'KeyR', 'Digit3']),
    mouse: { l: true, lp: true, r: false, dx: 0, dy: 0, wheel: 0 },
    touch: {
      mx: 0,
      mz: 0,
      fire: false,
      firePressed: false,
      jump: false,
      crouch: false,
      aim: false,
    },
    touchLook: { x: 0, y: 0 },
    ads: 0,
    consumePressed: Player.prototype.consumePressed,
    pos: [1, 0, 2],
    mag: 30,
    score: 0,
  };
  const game = { opts: { sens: 1, fov: 78 }, renderer: { camera: { fov: 78 } } },
    aim = { yaw: 0, pitch: 0 };
  const before = { pos: [...player.pos], mag: player.mag, score: player.score };
  const sample = () => {
    const value = collectInput(player, game, aim);
    assert.equal(
      validateClient({
        type: 'input',
        seq: 1,
        tick: 1,
        lifeId: 1,
        stageId: 1,
        createdAtMs: 0,
        display: null,
        input: value,
      }),
      null,
    );
    assert.ok(
      Math.abs(value.moveX - Math.SQRT1_2) < 1e-9 && Math.abs(value.moveZ + Math.SQRT1_2) < 1e-9,
    );
    return value;
  };
  const first = sample(),
    second = sample();
  assert.deepEqual(
    [first.fire, first.firePressed, first.jump, first.reload],
    [true, true, true, true],
  );
  assert.deepEqual(
    [second.fire, second.firePressed, second.jump, second.reload],
    [true, false, false, false],
  );
  assert.equal(first.sw, 2);
  assert.equal(second.sw, null);
  player.mouse.rp = true;
  const alt = sample();
  assert.equal(alt.altPressed, true);
  assert.equal(sample().altPressed, false);
  player.keys.clear();
  player.mouse.l = false;
  Object.assign(player.touch, { mx: 1, mz: 1, fire: true, firePressed: true, jump: true });
  const third = sample();
  player.mouse.dy = -1000;
  const fourth = sample();
  assert.deepEqual(
    [third.fire, third.firePressed, third.jump, third.reload],
    [true, true, true, false],
  );
  assert.deepEqual(
    [fourth.fire, fourth.firePressed, fourth.jump, fourth.reload],
    [true, false, false, false],
  );
  assert.equal(fourth.pitch, 1.5);
  assert.equal(player.mouse.dy, 0);
  assert.deepEqual(player.touchLook, { x: 0, y: 0 });
  assert.deepEqual({ pos: player.pos, mag: player.mag, score: player.score }, before);
});
