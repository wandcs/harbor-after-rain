import test from 'node:test';
import assert from 'node:assert/strict';
import { CombatMatch } from '../../src/sim/combat-match.js';
import { saveActor, restoreActor } from '../../src/sim/actor-state.js';
import { Prediction } from '../../src/net/prediction.js';
import { INPUT_FLAGS } from '../../src/protocol/messages.js';
import { OnlineSession } from '../../src/net/session.js';

// Independent contract projection: do not derive these keys from saveActor.
function observable(a) {
  return {
    motion: [
      ...a.pos.toArray(),
      ...a.vel.toArray(),
      a.yaw,
      a.pitch,
      a.height,
      a.eyeH,
      a.onGround,
      a.crouch,
      a.speed,
      a.jumpCD,
      a.landed,
      a.landSpeed,
      a.stepDist,
    ],
    life: [a.hp, a.armor, a.alive, a.lifeId, a.shotSeq, a.protectT, a.deadT, a.respawnT],
    aim: [
      a.punchP,
      a.punchY,
      a.aimPunch,
      a.ads,
      a.scoped,
      a.readyAt,
      a.bobT,
      a.land,
      a.camRoll,
      a.radarT,
      a.lastHurt,
    ],
    weapons: a.inv.map((w) => [
      w.id,
      w.mag,
      w.reserve,
      w.nextFire,
      w.reloadUntil,
      w.shotsFired,
      w.spreadAcc,
      w.lastShot,
      w.boltUntil,
      w.patternSeed,
    ]),
    random: a.ruleRandom.getState(),
    stats: [a.stats.k, a.stats.d, a.stats.shots, a.stats.hits],
    damage: [
      a.damageResponse.pitch,
      a.damageResponse.yaw,
      a.damageResponse.roll,
      a.damageResponse.vp,
      a.damageResponse.vy,
      a.damageResponse.vr,
      a.damageResponse.time,
      a.damageResponse.trauma,
      { ...a.damageResponse.offset },
    ],
    explosion: a.explosionOffset.toArray(),
  };
}
const input = (extra) => ({
  yaw: 0.2,
  pitch: -0.1,
  moveX: 0,
  moveZ: 0,
  ...Object.fromEntries(INPUT_FLAGS.map((key) => [key, false])),
  ...extra,
});
function setup() {
  const match = new CombatMatch({ teamSize: 1 });
  const actor = match.join('human');
  match.actors = [actor];
  return { match, actor };
}
test('full save/restore and real M4 replay preserve RNG, recoil, ammo and hit-response state without repeated effects', () => {
  const { match, actor } = setup();
  const effects = [];
  const prediction = new Prediction(match.world, (event) => effects.push(event.type));
  let snap = match.publicState(1, 0),
    own = { snapshotSeq: 1, actorId: actor.id, ackSeq: 0, state: saveActor(actor) };
  prediction.reconcile(snap, own);
  actor.damageResponse.hit(12, { x: 1, y: 0, z: 0 }, actor.yaw, false);
  const damaged = saveActor(actor);
  restoreActor(prediction.actor, damaged);
  own.state = damaged;
  for (let tick = 1; tick <= 240; tick++) {
    const f = {
      seq: tick,
      tick,
      lifeId: actor.lifeId,
      stageId: 1,
      createdAtMs: (tick * 1000) / 60,
      input: input({
        fire: tick === 30 || tick === 60,
        reload: tick === 90,
        moveX: tick < 20 ? 0.5 : 0,
        crouch: tick >= 90 && tick < 120,
      }),
    };
    prediction.submit(f);
    match.step(1 / 60, (tick * 1000) / 60, new Map([[actor.id, f]]));
    assert.deepEqual(
      observable(prediction.actor),
      observable(actor),
      `before correction tick=${tick}`,
    );
    if (tick === 60 || tick === 220)
      assert.deepEqual(
        [actor.weapon.mag, actor.weapon.reserve, actor.stats.shots, actor.shotSeq],
        [28, 90, 2, 2],
      );
    if (tick === 220) assert.equal(actor.weapon.reloading, true);
    if (tick % 10 === 0) {
      assert.deepEqual(prediction.state(), saveActor(actor));
      const count = effects.length;
      prediction.reconcile(snap, own);
      assert.deepEqual(prediction.state(), saveActor(actor));
      assert.equal(effects.length, count);
      snap = match.publicState(tick + 1, (tick * 1000) / 60);
      own = { snapshotSeq: tick + 1, actorId: actor.id, ackSeq: tick, state: saveActor(actor) };
      prediction.reconcile(snap, own);
    }
  }
  assert.deepEqual(prediction.state(), saveActor(actor));
  assert.deepEqual(
    [actor.weapon.mag, actor.weapon.reserve, actor.stats.shots, actor.shotSeq],
    [30, 88, 2, 2],
  );
  assert.equal(actor.weapon.reloading, false);
  assert.equal(effects.filter((type) => type === 'shot').length, 2);
  assert.equal(effects.filter((type) => type === 'reload').length, 1);
  const count = effects.length;
  prediction.reconcile(snap, own);
  assert.deepEqual(prediction.state(), saveActor(actor));
  assert.equal(effects.length, count);
  prediction.reconcile(match.publicState(242, 4000), {
    snapshotSeq: 242,
    actorId: actor.id,
    ackSeq: 240,
    state: saveActor(actor),
  });
  assert.equal(prediction.pending.length, 0);
});
test('unpaired corrections fail, and stage/life transitions discard pending actions', () => {
  const { match, actor } = setup(),
    p = new Prediction(match.world);
  const own = { snapshotSeq: 1, actorId: actor.id, ackSeq: 0, state: saveActor(actor) };
  assert.throws(() => p.reconcile(match.publicState(2, 0), own), /UNPAIRED/);
  const session = new OnlineSession({
    now: () => 0,
    onSnapshot: (state, correction) => p.reconcile(state, correction),
  });
  session.actorId = actor.id;
  session.receive({
    type: 'roster',
    version: 1,
    actors: match.actors.map(({ id, name, team, controlType }) => ({
      id,
      name,
      team,
      controlType,
    })),
  });
  const deliver = (seq, now, ack = 0) =>
    session.receive({
      type: 'snapshot',
      public: { ...match.publicState(seq, now), rosterVersion: 1 },
      own: { snapshotSeq: seq, actorId: actor.id, ackSeq: ack, state: saveActor(actor) },
    });
  deliver(1, 0);
  const baseline = session.snapshot,
    state = p.state();
  for (const correction of [
    { ...own, snapshotSeq: 9 },
    { ...own, actorId: actor.id + 99 },
  ]) {
    assert.throws(
      () => session.receive({ type: 'snapshot', public: { ...baseline }, own: correction }),
      /UNPAIRED/,
    );
    assert.equal(session.snapshot, baseline);
    assert.deepEqual(p.state(), state);
  }
  p.submit({
    seq: 1,
    tick: 1,
    lifeId: 1,
    stageId: 1,
    createdAtMs: 0,
    input: input({ fire: true }),
  });
  match.pause(actor.id);
  deliver(2, 16);
  assert.equal(p.pending.length, 0);
  assert.equal(p.phase, 'paused');
  match.resume(actor.id, 16);
  match.step(1 / 60, 3016);
  deliver(3, 3016);
  p.submit({
    seq: 2,
    tick: match.tick + 1,
    lifeId: actor.lifeId,
    stageId: match.stageId,
    createdAtMs: 3016,
    input: input({ fire: true }),
  });
  actor.protectT = 0;
  match.damage(actor, null, 200, 'leg', 'm4a1', { x: 1, y: 0, z: 0 }, false);
  deliver(4, 3016, 2);
  assert.equal(p.actor.alive, false);
  assert.equal(p.pending.length, 0);
  for (let i = 1; i <= 241; i++) match.step(1 / 60, 3016 + (i * 1000) / 60);
  deliver(5, 3016 + (241 * 1000) / 60, 2);
  assert.equal(actor.lifeId, 2);
  assert.equal(p.actor.alive, true);
  assert.equal(p.actor.lifeId, 2);
  assert.deepEqual([p.actor.weapon.mag, p.actor.shotSeq, p.pending.length], [30, 0, 0]);
  p.submit({
    seq: 3,
    tick: match.tick + 1,
    lifeId: 1,
    stageId: match.stageId,
    createdAtMs: 3016 + (241 * 1000) / 60,
    input: input({ fire: true }),
  });
  assert.deepEqual([p.actor.weapon.mag, p.actor.shotSeq], [30, 0]);
});
for (const [name, start, wall] of [
  ['head-on', 0.65, false],
  ['narrow-channel', 0.4, false],
  ['cover-edge', 0.65, true],
]) {
  test(`authority correction resolves ${name} using immutable authority collisions rather than display actors`, () => {
    const { match, actor } = setup();
    actor.pos.set(0, 0.02, 0);
    actor.yaw = 0;
    const other = {
      id: 99,
      alive: true,
      radius: 0.36,
      pos: actor.pos.clone().set(start, 0.02, 0),
      vel: actor.vel.clone(),
    };
    if (wall) {
      match.world.add({ x: 0.8, y: 1, z: 0, sx: 0.4, sy: 2, sz: 4, mat: 'metal' });
      match.world.build();
    }
    // Keep the real ship world and collision code. A fixed collision target
    // isolates replay; other actors' future intent is never predicted.
    const snapshot = match.publicState(1, 0);
    snapshot.actors.push({ id: 99, alive: true, pos: other.pos.toArray(), vel: [0, 0, 0] });
    const p = new Prediction(match.world);
    p.reconcile(snapshot, {
      snapshotSeq: 1,
      actorId: actor.id,
      ackSeq: 0,
      state: saveActor(actor),
    });
    for (let tick = 1; tick <= 15; tick++) {
      const f = {
        seq: tick,
        tick,
        lifeId: actor.lifeId,
        stageId: 1,
        createdAtMs: (tick * 1000) / 60,
        input: input({ moveX: 1 }),
      };
      p.submit(f);
      match.actors = [actor, other];
      match.time += 1 / 60;
      actor.update(1 / 60, f.input);
      actor.protectT -= 1 / 60;
      actor.radarT = Math.max(0, actor.radarT - 1 / 60);
    }
    assert.deepEqual(p.state(), saveActor(actor));
    p.actor.pos.x += 0.3;
    const corrected = { ...snapshot, tick: 15, time: match.time, snapshotSeq: 2 };
    p.reconcile(corrected, {
      snapshotSeq: 2,
      actorId: actor.id,
      ackSeq: 15,
      state: saveActor(actor),
    });
    assert.ok(p.correction > 0.29);
    assert.deepEqual(p.state(), saveActor(actor));
  });
}
