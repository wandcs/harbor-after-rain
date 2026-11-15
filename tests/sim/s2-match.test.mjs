import test from 'node:test';
import assert from 'node:assert/strict';
import { CombatMatch } from '../../src/sim/combat-match.js';
import { advanceActorPose } from '../../src/sim/pose-sample.js';

test('S2-N1 winning shot stops later actors in the same tick', () => {
  const match = new CombatMatch({ seed: 4207, teamSize: 2 });
  const a = match.join('A'),
    b = match.join('B'),
    c = match.join('C');
  match.actors = [a, b, c];
  a.pos.set(-1, 0, 6.8);
  b.pos.set(1, 0, 6.8);
  c.pos.set(-4, 0, 0);
  a.yaw = -Math.PI / 2;
  a.pitch = -0.1;
  for (const actor of match.actors) {
    actor.readyAt = 0;
    actor.protectT = 0;
    advanceActorPose(actor, 1 / 60);
  }
  assert.equal(a.team, 'BL');
  assert.equal(b.team, 'GR');
  match.score.BL = 49;
  b.hp = 1;
  const input = (actor) => ({
    seq: 1,
    tick: 1,
    stageId: match.stageId,
    lifeId: actor.lifeId,
    createdAtMs: 1000,
    input: { fire: true },
  });
  match.time = 1;
  match.step(
    1 / 60,
    1000,
    new Map([
      [a.id, input(a)],
      [c.id, input(c)],
    ]),
  );
  assert.deepEqual(
    [match.score.BL, a.weapon.mag, a.stats.k, b.stats.d, c.weapon.mag, c.shotSeq],
    [50, 29, 1, 1, 30, 0],
    JSON.stringify(match.events),
  );
  assert.equal(match.phase, 'ended');
  assert.equal(match.events.filter((event) => event.type === 'shot').length, 1);
  assert.equal(match.events.filter((event) => event.type === 'death').length, 1);
  const before = {
    time: match.time,
    score: { ...match.score },
    stats: match.actors.map((actor) => ({ ...actor.stats })),
  };
  for (let i = 0; i < 3; i++) {
    match.step(1 / 60, 2000 + i * 17);
    match.end('again');
  }
  assert.deepEqual(
    { time: match.time, score: match.score, stats: match.actors.map((actor) => actor.stats) },
    before,
  );
  assert.deepEqual(
    match.events.filter((event) => event.type === 'end').map((event) => event.reason),
    ['score'],
  );
});
