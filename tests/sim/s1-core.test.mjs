import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { createShipLayout } from '../../src/sim/maps/ship-layout.js';
import { World, NavGrid } from '../../src/sim/physics.js';
import { Actor } from '../../src/sim/actor.js';
import { Bot } from '../../src/sim/bots.js';
import { CharacterPose } from '../../src/sim/character-pose.js';
import { HumanActor } from '../../src/sim/human-actor.js';
import { WEAPONS, jitterDir } from '../../src/sim/weapons.js';
import { traceShot } from '../../src/sim/ballistics.js';
import { applyDamageState, applyDeathState } from '../../src/sim/damage.js';
import { createRandom } from '../../src/sim/random.js';

const original = JSON.parse(readFileSync(new URL('../fixtures/s1-original.json', import.meta.url)));
function seeded(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}
function close(actual, expected, label = '') {
  if (typeof expected === 'number')
    assert.ok(Math.abs(actual - expected) < 1e-9, `${label}: ${actual} != ${expected}`);
  else if (Array.isArray(expected)) {
    assert.equal(actual.length, expected.length, label);
    expected.forEach((value, index) => close(actual[index], value, `${label}[${index}]`));
  } else assert.deepEqual(actual, expected, label);
}
function host() {
  const map = createShipLayout(),
    world = new World();
  for (const collider of map.colliders) world.add(collider);
  world.build();
  world.setWaterLevel(-7.5);
  const bounds = map.navBounds;
  const game = {
    time: 0,
    frame: 0,
    random: seeded(4207),
    world,
    map,
    actors: [],
    mode: 'tdm',
    score: { BL: 0, GR: 0 },
    onJump() {},
    onLand() {},
    onFootstep() {},
    onReloadStart() {},
    onReloadDone() {},
    onScope() {},
    onSwitch() {},
  };
  game.nav = new NavGrid(world, bounds.x0, bounds.z0, bounds.x1, bounds.z1, 0.5, 0.42);
  game.fireWeapon = (actor, weapon, spread) => {
    const origin =
      actor.controlType === 'human'
        ? actor.shotOrigin(new THREE.Vector3())
        : actor.eye(new THREE.Vector3());
    const direction = actor.forward(new THREE.Vector3());
    jitterDir(direction, spread, game.random);
    const shot = traceShot(game, actor, origin, direction, weapon.def);
    actor.soldier.kick();
    actor.radarT = 1.6;
    if (shot.hit) {
      const { target, part, amount } = shot.hit;
      const damage = applyDamageState(game, target, actor, amount, part, weapon.id, direction);
      if (damage?.killed) applyDeathState(game, target, actor, part === 'head', direction);
    }
    return shot;
  };
  return game;
}

test('shared layout preserves all 447 original colliders and gameplay metadata', () => {
  const game = host(),
    fields = Object.keys(original.colliders[0]);
  assert.deepEqual(
    game.world.colliders.map((collider) =>
      Object.fromEntries(fields.map((key) => [key, collider[key]])),
    ),
    original.colliders,
  );
  for (const [key, value] of Object.entries(original.metadata))
    assert.deepEqual(game.map[key], value, key);
  const other = host();
  const otherStamps = other.world.colliders.map((collider) => collider.stamp);
  const route = other.nav.findPath(-32, -15.7, 32, -15.7);
  assert.ok(route?.length);
  const work = ['open', 'g', 'f', 'parent', 'seen', 'closed'];
  const search = { gen: other.nav.gen, arrays: work.map((key) => Array.from(other.nav[key])) };
  game.world.query(-34, -16, 34, 16);
  game.nav.findPath(-32, -15.7, 32, -15.7);
  assert.notEqual(game.world._cand, other.world._cand);
  for (const key of work) assert.notEqual(game.nav[key], other.nav[key], key);
  assert.equal(other.nav.gen, search.gen);
  assert.deepEqual(
    work.map((key) => Array.from(other.nav[key])),
    search.arrays,
  );
  assert.deepEqual(other.nav.findPath(-32, -15.7, 32, -15.7), route);
  assert.deepEqual(
    other.world.colliders.map((collider) => collider.stamp),
    otherStamps,
  );
});

test('CPU poses preserve original bone matrices for seven weapons and moving/crouched/hit states', () => {
  assert.equal(globalThis.document, undefined);
  for (const [id, samples] of Object.entries(original.poses)) {
    const pose = new CharacterPose({ random: seeded(4207) });
    pose.setWeapon(id);
    pose.phase = 0.75;
    pose.root.position.set(2, 0.02, 3);
    pose.root.rotation.y = 0.4;
    let index = 0;
    for (let tick = 0; tick < 180; tick++) {
      if (tick === 40) pose.kick();
      if (tick === 70) pose.flinch({ x: 1, z: -0.5 }, 'head', 35);
      pose.update(1 / 60, {
        speed: tick < 100 ? 4 : 0,
        fwd: tick < 50 ? 1 : -1,
        crouch: tick >= 60 && tick < 110,
        pitch: 0.3,
        onGround: tick < 120 || tick > 145,
        reloading: tick >= 20 && tick < 50,
      });
      pose.root.updateMatrixWorld(true);
      if ([0, 30, 41, 71, 100, 130, 179].includes(tick))
        close(
          pose.bones.map((bone) => bone.matrixWorld.toArray()),
          samples[index++],
          id,
        );
    }
    pose.root.traverse((object) => assert.ok(!object.isMesh, 'CPU pose creates no render mesh'));
  }
});

test('real shared movement and M4 state preserve original input sequence', () => {
  const game = host();
  game.fireWeapon = () => {};
  const actor = new Actor(game, { id: 1, team: 'BL', isPlayer: true });
  actor.primary = 'm4a1';
  actor.spawn({ x: -32, z: -15.7, yaw: -Math.PI / 2 });
  game.actors = [actor];
  actor.inv.forEach((weapon, index) => {
    weapon.patternSeed = 0.5 + index * 0.2;
  });
  game.random = seeded(4207);
  let sample = 0;
  for (let tick = 0; tick < 240; tick++) {
    game.time += 1 / 60;
    actor.move(1 / 60, 1, 0, tick === 30, tick >= 80 && tick < 130, tick >= 180);
    actor.weaponUpdate(1 / 60, {
      fire: tick < 70,
      firePressed: tick === 0,
      reload: tick === 80,
      sw: tick === 200 ? 1 : null,
    });
    if (tick % 20 === 0) {
      close(
        [...actor.pos.toArray(), ...actor.vel.toArray(), actor.eyeH, actor.height, actor.onGround],
        original.movement[sample],
      );
      close(
        [
          actor.slot,
          actor.weapon.mag,
          actor.weapon.reserve,
          actor.weapon.nextFire,
          actor.weapon.reloadUntil,
          actor.punchP,
          actor.punchY,
        ],
        original.weapons[sample++],
      );
    }
  }
});

test('Node host runs real AI movement and M4 fire with no DOM, renderer or sound device', () => {
  const game = host();
  for (const [id, team] of [
    [1, 'BL'],
    [2, 'GR'],
  ]) {
    const bot = new Bot(game, { id, team, diff: 'normal' });
    bot.primary = 'm4a1';
    game.actors.push(bot);
    bot.spawn(game.map.spawns[team][0]);
    bot.protectT = 0;
  }
  for (const bot of game.actors) bot.onSpawn();
  const before = game.actors.map((actor) => actor.pos.clone());
  for (let tick = 0; tick < 900; tick++) {
    game.time += 1 / 60;
    for (const bot of game.actors) {
      if (!bot.alive) continue;
      bot.update(1 / 60);
      bot.soldier.root.position.copy(bot.pos);
      bot.soldier.root.rotation.y = bot.yaw;
      bot.soldier.update(1 / 60, {
        speed: bot.speed || 0,
        fwd: 1,
        crouch: bot.crouch,
        pitch: bot.pitch + bot.punchP,
        onGround: bot.onGround,
      });
    }
  }
  assert.ok(game.actors.every((actor, index) => actor.pos.distanceTo(before[index]) > 1));
  assert.ok(game.actors.some((actor) => actor.stats.shots > 0));
  assert.equal(globalThis.window, undefined);
  // Third consecutive blocked-path recovery uses the host's rule random source,
  // just like initial lane selection. Exercise the real think/goal chain.
  const recovering = game.actors[0];
  game.actors = [recovering];
  recovering.spawn(game.map.spawns.BL[0]);
  recovering.onSpawn();
  recovering.path = [[recovering.pos.x + 1, recovering.pos.z]];
  recovering.pi = 0;
  recovering.stuckT = 1.01;
  recovering.stuckN = 2;
  recovering.lastCheck.copy(recovering.pos);
  const stage = recovering.stage;
  recovering.think();
  assert.equal(recovering.stage, stage + 1);
  assert.equal(recovering.stuckN, 0);
  assert.ok(game.map.lanes.includes(recovering.lane));
});

test('human shot origin/direction and hit springs match the original camera without a renderer', () => {
  const game = host();
  game.shake = 0.2;
  const actor = new HumanActor(game, { id: 1, team: 'BL' });
  actor.primary = 'm4a1';
  actor.spawn({ x: 5, z: 2, yaw: 0.3 });
  Object.assign(actor, {
    pitch: 0.1,
    punchP: 0.04,
    punchY: 0.01,
    aimPunch: 0.02,
    speed: 4,
    ads: 0.4,
  });
  actor.pos.y = 0;
  game.random = seeded(4207);
  actor.damageResponse.hit(30, { x: 1, z: 0 }, actor.yaw);
  let index = 0;
  for (let tick = 0; tick < 60; tick++) {
    actor.pos.x += 0.03;
    const pose = actor.pose(1 / 60, { left: true });
    if (tick % 10 === 0) {
      const expected = original.player[index++],
        time = actor.damageResponse.time;
      close(actor.shotOrigin(new THREE.Vector3()).toArray(), expected.origin);
      close(actor.forward(new THREE.Vector3()).toArray(), expected.direction);
      close(pose.rotation.toArray().slice(0, 3), expected.rotation);
      assert.equal(
        actor.damageResponse.time,
        time,
        'shot query does not advance hit springs twice',
      );
    }
  }
});

function shootingRange(obstacle) {
  const game = {
    time: 1,
    frame: 0,
    random: seeded(4207),
    world: new World(),
    actors: [],
    mode: 'tdm',
    score: { BL: 0, GR: 0 },
  };
  if (obstacle) game.world.add(obstacle);
  game.world.build();
  const attacker = new HumanActor(game, { id: 1, team: 'BL' });
  const target = new Actor(game, { id: 2, team: 'GR' });
  attacker.primary = target.primary = 'm4a1';
  attacker.spawn({ x: 0, z: 0, yaw: 0 });
  target.spawn({ x: 0, z: -6, yaw: 0 });
  attacker.protectT = target.protectT = 0;
  target.soldier.update(1 / 60, { speed: 0, fwd: 1, crouch: false, pitch: 0, onGround: true });
  game.actors = [attacker, target];
  return { game, attacker, target };
}

test('real skeleton ray tests resolve head, chest, arm and leg regions', () => {
  const { game, attacker, target } = shootingRange();
  for (const [bone, offset, from, expected] of [
    ['head', [0, 0.1, 0], [0, 0, 5], 'head'],
    ['chest', [0, 0.1, 0], [0, 0, 5], 'chest'],
    ['upperArmR', [0, -0.14, 0], [5, 0, 0], 'arm'],
    ['shinL', [0, -0.22, 0], [0, 0, 5], 'leg'],
  ]) {
    const center = target.soldier.B[bone].localToWorld(new THREE.Vector3(...offset));
    const origin = center.clone().add(new THREE.Vector3(...from));
    const direction = center.clone().sub(origin).normalize();
    assert.equal(
      traceShot(game, attacker, origin, direction, WEAPONS.m4a1).hit?.part,
      expected,
      bone,
    );
  }
});

test('shared ray query preserves blocking, penetration cost and body damage falloff', () => {
  const obstacle = { x: 0, y: 1.4, z: -3, sx: 4, sy: 3, sz: 0.3, mat: 'wood', bullet: 'pen' };
  for (const [wall, shouldHit] of [
    [null, true],
    [obstacle, true],
    [{ ...obstacle, sz: 2.5 }, false],
    [{ ...obstacle, mat: 'metal', bullet: 'block' }, false],
  ]) {
    const { game, attacker } = shootingRange(wall);
    const shot = traceShot(
      game,
      attacker,
      new THREE.Vector3(0, 1.4, 0),
      new THREE.Vector3(0, 0, -1),
      WEAPONS.m4a1,
    );
    assert.equal(!!shot.hit, shouldHit);
    if (shot.hit) {
      const multiplier = wall ? 0.6 : 1;
      close(
        shot.hit.amount,
        32 * multiplier * Math.pow(0.985, shot.end.distanceTo(new THREE.Vector3(0, 1.4, 0)) / 10),
      );
      assert.equal(shot.hit.wall, !!wall);
      if (wall) assert.equal(shot.impacts.length, 3);
    }
  }
});

test('shared damage enforces protection, team rules, armour and one death transition', () => {
  const { game, attacker, target } = shootingRange();
  const direction = new THREE.Vector3(0, 0, -1);
  target.protectT = 1;
  assert.equal(applyDamageState(game, target, attacker, 100, 'chest', 'm4a1', direction), null);
  assert.equal(target.hp, 100);
  target.protectT = 0;
  target.team = 'BL';
  assert.equal(applyDamageState(game, target, attacker, 100, 'chest', 'm4a1', direction), null);
  target.team = 'GR';
  const hit = applyDamageState(game, target, attacker, 100, 'chest', 'm4a1', direction);
  close(hit.hpDamage, 72);
  close(target.hp, 28);
  close(target.armor, 60.8);
  assert.equal(hit.killed, false);
  const lethal = applyDamageState(game, target, attacker, 40, 'leg', 'm4a1', direction);
  assert.equal(lethal.killed, true);
  applyDeathState(game, target, attacker, false, direction);
  assert.equal(target.alive, false);
  assert.equal(target.hp, 0);
  assert.deepEqual(
    [target.stats.d, attacker.stats.k, attacker.stats.hits, game.score.BL],
    [1, 1, 2, 1],
  );
  assert.equal(applyDamageState(game, target, attacker, 999, 'head', 'm4a1', direction), null);
  assert.equal(game.score.BL, 1);
});

test('rule random replay is independent of visual random calls', () => {
  const random = createRandom(4207),
    state = random.getState();
  const expected = Array.from({ length: 10 }, () => random());
  Array.from({ length: 100 }, () => Math.random());
  random.setState(state);
  assert.deepEqual(
    Array.from({ length: 10 }, () => random()),
    expected,
  );
});

test('shared authored rules reject mutation and a new human life clears delayed hit/input state', () => {
  assert.throws(() => {
    WEAPONS.m4a1.rpm = 1;
  }, TypeError);
  const { attacker } = shootingRange();
  attacker.damageResponse.hit(35, { x: 1, z: 0 }, 0);
  attacker.damageResponse.update(1 / 60);
  attacker.pendingThrow = 1;
  attacker.autoSwitchAt = 999;
  attacker.jumpCD = 1;
  attacker.spawn({ x: 0, z: 0, yaw: 0 });
  assert.equal(attacker.damageResponse.trauma, 0);
  assert.ok(Object.values(attacker.damageResponse.offset).every((value) => value === 0));
  assert.deepEqual([attacker.pendingThrow, attacker.autoSwitchAt, attacker.jumpCD], [0, 0, 0]);
});

test('headless fixed-step M4 chain consumes ammo, confirms real hits and scores one kill', () => {
  const game = host();
  game.world = new World();
  game.world.add({ x: 0, y: -0.5, z: 0, sx: 30, sy: 1, sz: 30 });
  game.world.build();
  const attacker = new HumanActor(game, { id: 1, team: 'BL' });
  const target = new Actor(game, { id: 2, team: 'GR' });
  attacker.primary = target.primary = 'm4a1';
  attacker.spawn({ x: 0, z: 0, yaw: 0 });
  target.spawn({ x: 0, z: -6, yaw: 0 });
  attacker.protectT = target.protectT = 0;
  target.soldier.update(1 / 60, { speed: 0, fwd: 1, crouch: false, pitch: 0, onGround: true });
  game.actors = [attacker, target];
  for (let tick = 0; tick < 120; tick++) {
    game.time += 1 / 60;
    attacker.update(1 / 60, { fire: true, firePressed: tick === 0 });
  }
  assert.ok(attacker.weapon.mag < 30 && attacker.stats.shots > 0);
  assert.ok(attacker.stats.hits > 0);
  assert.equal(target.alive, false);
  assert.deepEqual([attacker.stats.k, target.stats.d, game.score.BL], [1, 1, 1]);
});
