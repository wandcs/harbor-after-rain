import test from 'node:test';
import assert from 'node:assert/strict';
import { CombatMatch } from '../../src/sim/combat-match.js';
import { advanceActorPose } from '../../src/sim/pose-sample.js';
import { WEAPONS } from '../../src/sim/weapons.js';
import { World } from '../../src/sim/physics.js';
import { Vector3 } from 'three';
import { relayCounts } from '../../src/sim/modes/relay.js';
import { MATCH_RULES } from '../../src/sim/match-rules.js';
import { DIFF } from '../../src/sim/bots.js';

test('S4-M1 full armory and detached grenades use shared authority actions', () => {
  for (const primary of ['m4a1', 'ak47', 'mp5', 'awm']) {
    const m = new CombatMatch({ teamSize: 1 }),
      a = m.join('A', primary),
      b = m.join('B');
    a.pos.set(-1, 0, 6.8);
    b.pos.set(1, 0, 6.8);
    a.yaw = -Math.PI / 2;
    a.pitch = -0.1;
    a.readyAt = 0;
    b.protectT = 0;
    for (const actor of m.actors) advanceActorPose(actor, 0);
    m.step(1 / 60, 0, new Map([[a.id, { seq: 1, input: { fire: true, firePressed: true } }]]));
    assert.equal(a.inv[0].mag, WEAPONS[primary].mag - 1, primary);
    assert.equal(m.events.find((e) => e.type === 'shot').weaponId, primary);
    assert.ok(b.hp < 100, primary);
    a.slot = 1;
    a.readyAt = 0;
    m.step(1 / 60, 17, new Map([[a.id, { seq: 2, input: { fire: true, firePressed: true } }]]));
    const mag = a.weapon.mag;
    for (let i = 0; i < 30; i++)
      m.step(1 / 60, 34 + i * 17, new Map([[a.id, { input: { fire: true } }]]));
    assert.equal(a.weapon.mag, mag, 'semiautomatic held fire must not invent edges');
  }
  const m = new CombatMatch({ teamSize: 1 }),
    a = m.join('A'),
    b = m.join('B');
  a.pos.set(-1, 0, 6.8);
  b.pos.set(0.5, 0, 6.8);
  a.yaw = -Math.PI / 2;
  a.pitch = -0.1;
  a.slot = 2;
  a.readyAt = 0;
  b.protectT = 0;
  for (const actor of m.actors) advanceActorPose(actor, 0);
  m.step(1 / 60, 0, new Map([[a.id, { input: { alt: true } }]]));
  for (let i = 1; i <= 21; i++) m.step(1 / 60, i * 17);
  assert.ok(m.events.some((e) => e.type === 'damage' && e.actorId === b.id));
  a.slot = 3;
  a.readyAt = 0;
  m.step(1 / 60, 400, new Map([[a.id, { input: { firePressed: true } }]]));
  for (let i = 1; i <= 33; i++) m.step(1 / 60, 400 + i * 17);
  assert.equal(m.nades.length, 1);
  assert.equal(a.inv[3].mag, 0);
  const nade = m.nades[0],
    ownerId = a.id;
  m.leave(a.id);
  assert.notEqual(nade.owner, a);
  assert.equal(nade.owner.id, ownerId);
  assert.equal(nade.owner.controlType, 'human');
  assert.equal(nade.owner.game, undefined);
  // A thrown grenade remains live after departure; position is just the impact fixture.
  if (!b.alive) m.spawnActor(b);
  b.protectT = 0;
  b.hp = 1;
  b.armor = 0;
  b.pos.set(0, 0, 6.8);
  advanceActorPose(b, 0);
  nade.pos.set(0, 1, 6.8);
  nade.vel.set(0, 0, 0);
  const beforeScore = m.score[nade.owner.team];
  for (let i = 0; i < 190; i++) m.step(1 / 60, 1000 + i * 17);
  assert.equal(m.nades.length, 0);
  assert.ok(m.events.some((e) => e.type === 'death' && e.attackerId === ownerId));
  assert.equal(
    m.events.find((e) => e.type === 'death' && e.attackerId === ownerId).attacker.controlType,
    'human',
    'departed grenade owner retains its identity in the death event',
  );
  assert.equal(m.score[nade.owner.team], beforeScore + 1);
  assert.ok(m.actors.every((actor) => actor.id !== ownerId));
  const current = m.actors.find((actor) => actor.controlType === 'human');
  if (!current.alive) m.spawnActor(current);
  current.pos.x = current.team === 'BL' ? -30 : 30;
  m.loadout(current.id, 'mp5');
  assert.equal(current.weapon.id, 'mp5');
  current.pos.x = 0;
  m.loadout(current.id, 'awm');
  assert.equal(current.nextPrimary, 'awm');
  assert.equal(current.weapon.id, 'mp5');
  m.spawnActor(current);
  assert.equal(current.weapon.id, 'awm');
});

test('S4-M2 relay capture pause rotation and match boundaries settle once', () => {
  assert.deepEqual(MATCH_RULES, { durationSeconds: 180, scoreLimit: 50, botDifficulty: 'normal' });
  assert.ok(Object.isFrozen(MATCH_RULES));
  const m = new CombatMatch({ teamSize: 1, mode: 'relay' }),
    a = m.join('A'),
    b = m.join('B');
  a.protectT = 0;
  a.pos.copy(m.objective.position);
  b.pos.set(30, 0, 6.8);
  a.protectT = 1;
  assert.equal(relayCounts(m, m.objective.position)[a.team], 0);
  a.protectT = 0;
  b.protectT = 0;
  b.pos.copy(a.pos);
  assert.deepEqual(relayCounts(m, m.objective.position), { BL: 1, GR: 1 });
  b.pos.set(30, 0, 6.8);
  const wallWorld = new World();
  wallWorld.add({ x: 0, y: 1.5, z: 0, sx: 0.6, sy: 3, sz: 12 });
  wallWorld.build();
  const covered = {
    world: wallWorld,
    actors: [{ alive: true, protectT: 0, team: 'BL', pos: new Vector3(1.5, 0, 0) }],
  };
  assert.deepEqual(relayCounts(covered, new Vector3(-1.5, 0, 0)), { BL: 0, GR: 0 });
  const step = () => m.step(1 / 60, (m.tick * 1000) / 60);
  for (let i = 0; i < 420; i++) step();
  assert.equal(m.objective.rules.owner, a.team);
  assert.equal(m.score[a.team], 0);
  for (let i = 0; i < 60; i++) step();
  assert.equal(m.score[a.team], 1);
  m.pause(a.id);
  const before = JSON.stringify([m.time, m.score, m.objective.state()]);
  for (let i = 0; i < 30; i++) step();
  assert.equal(JSON.stringify([m.time, m.score, m.objective.state()]), before);
  m.resume(b.id, 10000);
  m.resume(a.id, 11000);
  assert.equal(m.resumeAtMs, 13000);
  m.step(1 / 60, 12999);
  assert.equal(m.phase, 'countdown');
  m.step(1 / 60, 13000);
  assert.equal(m.phase, 'running');
  m.objective.rules.elapsed = 75 - 1 / 60;
  step();
  assert.equal(m.objective.rules.index, 1);
  assert.equal(m.objective.rules.owner, null);
  m.objective.rules.owner = a.team;
  m.objective.rules.progress = a.team === 'BL' ? -1 : 1;
  m.objective.rules.score[a.team] = 49;
  m.objective.rules.tick = 1 - 1 / 60;
  a.pos.copy(m.objective.position);
  step();
  assert.equal(m.phase, 'ended');
  assert.equal(m.result.winner, a.team);
  assert.equal(m.score[a.team], 50);
  m.end('again');
  assert.equal(m.events.filter((e) => e.type === 'end').length, 1);
  for (const mode of ['tdm', 'relay']) {
    const full = new CombatMatch({ teamSize: 1, mode });
    assert.equal(full.goal, 50);
    for (const bot of full.actors) assert.equal(bot.diff, DIFF.normal);
    full.join('full-match');
    for (let step = 0; step <= 10800 && full.phase !== 'ended'; step++)
      full.step(1 / 60, (step * 1000) / 60);
    assert.equal(full.phase, 'ended', mode);
    assert.ok(['score', 'time'].includes(full.result.reason));
    assert.equal(full.result.actors.length, 2);
    assert.equal(full.events.filter((e) => e.type === 'end').length, 1);
    const timed = new CombatMatch({ teamSize: 1, mode });
    timed.join('A');
    timed.time = 180 - 1 / 60;
    timed.step(1 / 60, 0);
    assert.deepEqual(
      [timed.phase, timed.result.winner, timed.events.filter((e) => e.type === 'shot').length],
      ['ended', null, 0],
    );
  }
});
