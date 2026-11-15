import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { CombatMatch } from '../../src/sim/combat-match.js';
import { advanceActorPose } from '../../src/sim/pose-sample.js';
import { SnapshotHistory } from '../../server/sync/history.js';
import { readConfig } from '../../server/config.js';

function range() {
  const history = new SnapshotHistory(readConfig({}));
  let now = 100;
  const match = new CombatMatch({
    teamSize: 1,
    resolveTargets: (actor, frame) =>
      history.select(match, actor, frame, now, { sentSnapshots: new Set([1, 2]), rttMs: 20 }),
  });
  const shooter = match.join('shooter'),
    target = match.join('target');
  shooter.pos.set(-1, 0, 6.8);
  target.pos.set(1, 0, 6.8);
  shooter.protectT = target.protectT = 0;
  shooter.readyAt = 0;
  shooter.yaw = -Math.PI / 2;
  shooter.pitch = -0.1;
  for (const actor of match.actors) advanceActorPose(actor, 1 / 60);
  history.add(match.publicState(1, 100));
  now = 117;
  history.add(match.publicState(2, now));
  return {
    match,
    shooter,
    target,
    history,
    setNow(value) {
      now = value;
    },
  };
}
test('valid history reconstructs an actual hit; expired/missing references fall back to exactly one current shot', () => {
  for (const [display, now, expected] of [
    [{ a: 1, b: 2, alpha: 0.5 }, 150, 'history'],
    [{ a: 0, b: 0, alpha: 0 }, 150, 'current'],
    [{ a: 1, b: 2, alpha: 0 }, 500, 'current'],
    [null, 150, 'current'],
  ]) {
    const { match, shooter, target, setNow } = range();
    target.pos.z += 2;
    advanceActorPose(target, 1 / 60);
    setNow(now);
    shooter.activeInput = { seq: 1, display, input: { fire: true } };
    match.time = 0.5;
    shooter.weaponUpdate(1 / 60, { fire: true });
    const shots = match.events.filter((event) => event.type === 'shot');
    assert.equal(shots.length, 1);
    assert.equal(shots[0].path, expected);
    assert.equal(shooter.weapon.mag, 29);
    assert.equal(target.hp < 100, expected === 'history');
    assert.equal(
      match.events.filter((event) => event.type === 'damage').length,
      expected === 'history' ? 1 : 0,
    );
  }
});
test('new life rejects old history, and historical or current spawn protection prevents damage', () => {
  const { match, shooter, target, history } = range();
  const ref = { display: { a: 1, b: 2, alpha: 0.5 } };
  target.lifeId++;
  assert.equal(
    history.select(match, shooter, ref, 150, { sentSnapshots: new Set([1, 2]), rttMs: 20 }).reason,
    'life-boundary',
  );
  target.protectT = 3;
  match.damage(target, shooter, 300, 'head', 'm4a1', new THREE.Vector3(1, 0, 0), false);
  assert.equal(target.hp, 100);
  assert.equal(target.stats.d, 0);
  target.protectT = 0;
  match.damage(target, shooter, 300, 'head', 'm4a1', new THREE.Vector3(1, 0, 0), false);
  assert.equal(target.alive, false);
  assert.equal(target.stats.d, 1);
  match.damage(target, shooter, 300, 'head', 'm4a1', new THREE.Vector3(1, 0, 0), false);
  assert.equal(target.stats.d, 1);
  assert.equal(match.score[shooter.team], 1);
});
test('a historically protected target remains protected for that displayed sample after the current protection expires', () => {
  const { match, shooter, target, history, setNow } = range();
  for (const snapshot of history.samples)
    snapshot.actors.find((actor) => actor.id === target.id).protectT = 3;
  setNow(150);
  shooter.activeInput = { seq: 1, display: { a: 1, b: 2, alpha: 0.5 } };
  match.time = 0.5;
  shooter.weaponUpdate(1 / 60, { fire: true });
  assert.equal(match.events.find((event) => event.type === 'shot').path, 'history');
  assert.equal(shooter.weapon.mag, 29);
  assert.equal(target.hp, 100);
});
