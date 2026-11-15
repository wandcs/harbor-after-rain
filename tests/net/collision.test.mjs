import test from 'node:test';
import assert from 'node:assert/strict';
import { CombatMatch } from '../../src/sim/combat-match.js';
import { saveActor } from '../../src/sim/actor-state.js';
import { Prediction } from '../../src/net/prediction.js';
import { INPUT_FLAGS } from '../../src/protocol/messages.js';

for (const scene of ['head-on', 'channel', 'cover-edge'])
  test(`two moving human actors reconcile ${scene} without predicting the other actor's intent`, () => {
    const match = new CombatMatch({ teamSize: 1 }),
      a = match.join('a'),
      b = match.join('b');
    a.pos.set(-1.1, 0, 6.8);
    b.pos.set(1.1, 0, 6.8);
    if (scene !== 'head-on') {
      match.world.add({ x: 0, y: 1, z: 7.5, sx: 5, sy: 2, sz: 0.3 });
      if (scene === 'channel') match.world.add({ x: 0, y: 1, z: 6.1, sx: 5, sy: 2, sz: 0.3 });
      match.world.build();
    }
    const p = new Prediction(match.world);
    let maxCorrection = 0;
    const reconcile = (tick, seq) => {
      p.reconcile(match.publicState(seq, (tick * 1000) / 60), {
        snapshotSeq: seq,
        actorId: a.id,
        ackSeq: tick,
        state: saveActor(a),
      });
      maxCorrection = Math.max(maxCorrection, p.correction);
    };
    reconcile(0, 1);
    for (let tick = 1; tick <= 90; tick++) {
      const base = { seq: tick, tick, lifeId: 1, stageId: 1, createdAtMs: (tick * 1000) / 60 };
      const input = (moveX) => ({
        ...Object.fromEntries(INPUT_FLAGS.map((key) => [key, false])),
        yaw: 0,
        pitch: 0,
        moveX,
        moveZ: 0,
      });
      const fa = { ...base, input: input(1) },
        fb = { ...base, input: input(-1) };
      p.submit(fa);
      match.step(
        1 / 60,
        (tick * 1000) / 60,
        new Map([
          [a.id, fa],
          [b.id, fb],
        ]),
      );
      if (tick % 3 === 0) reconcile(tick, tick + 1);
    }
    assert.deepEqual(p.state(), saveActor(a));
    assert.ok(maxCorrection > 0);
    assert.ok(a.pos.distanceTo(b.pos) > 0.5);
    assert.equal(
      match.world.blocked(a.pos.x, a.pos.y + 0.05, a.pos.z, a.radius * 0.9, a.height - 0.1),
      false,
    );
  });
