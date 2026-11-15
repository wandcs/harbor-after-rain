import test from 'node:test';
import assert from 'node:assert/strict';
import { CombatMatch } from '../../src/sim/combat-match.js';
import { InputQueue } from '../../server/sync/input-queue.js';
import { readConfig } from '../../server/config.js';

test('held automatic fire gives each real bullet a fresh shot number with its original input/display reference', () => {
  const match = new CombatMatch({ teamSize: 1 }),
    actor = match.join('human'),
    queue = new InputQueue(readConfig({}));
  actor.readyAt = 0;
  match.actors = [actor];
  const frame = {
    seq: 1,
    tick: 1,
    createdAtMs: 0,
    lifeId: actor.lifeId,
    stageId: 1,
    display: { a: 1, b: 2, alpha: 0.5 },
    input: { fire: true, firePressed: true },
  };
  queue.push(frame, actor, 1, 0, 0);
  for (let tick = 1; tick <= 60; tick++)
    match.step(
      1 / 60,
      (tick * 1000) / 60,
      new Map([[actor.id, queue.consume(actor, 1, tick, (tick * 1000) / 60)]]),
    );
  const shots = match.events.filter((event) => event.type === 'shot');
  assert.equal(shots.length, 3);
  assert.deepEqual(
    shots.map((event) => event.tick),
    [1, 7, 13],
  );
  assert.deepEqual(
    shots.map((event) => event.shotSeq),
    shots.map((_, i) => i + 1),
  );
  assert.ok(shots.slice(1).every((event) => event.reused && event.inputSeq === 1));
  assert.ok(shots.every((event) => event.display.alpha === 0.5));
  assert.equal(actor.weapon.mag, 30 - shots.length);
});
test('pause freezes rules, repeated resume never extends countdown and a new pause cancels it', () => {
  const match = new CombatMatch({ teamSize: 1 }),
    actor = match.join('human');
  match.step(1 / 60, 0);
  const time = match.time;
  match.pause(actor.id);
  match.step(1 / 60, 1000);
  assert.equal(match.time, time);
  match.resume(actor.id, 1000);
  match.resume(actor.id, 2000);
  assert.equal(match.resumeAtMs, 4000);
  match.step(1 / 60, 3999);
  assert.equal(match.phase, 'countdown');
  assert.equal(match.time, time);
  match.pause(actor.id);
  assert.equal(match.resumeAtMs, null);
  match.resume(actor.id, 5000);
  match.step(1 / 60, 8000);
  assert.equal(match.phase, 'running');
  match.leave(actor.id);
  assert.equal(match.phase, 'ended');
  const endSeq = match.eventSeq;
  match.end('again');
  assert.equal(match.eventSeq, endSeq);
});
test('wall-clock deadline wins before catchup shots and bot fire uses current authority', () => {
  const match = new CombatMatch({ teamSize: 1 }),
    actor = match.join('human');
  actor.pos.set(-2, 0.02, 15.7);
  actor.protectT = 0;
  const bot = match.actors.find((value) => value.controlType === 'bot');
  bot.pos.set(2, 0.02, 15.7);
  bot.protectT = 0;
  for (let i = 0; i < 600; i++) match.step(1 / 60, (i * 1000) / 60);
  const botShots = match.events.filter((event) => event.type === 'shot' && event.reason === 'bot');
  assert.ok(botShots.length);
  assert.ok(botShots.every((event) => event.path === 'current' && event.display === null));
  const seq = match.eventSeq;
  match.step(1 / 60, 180001);
  assert.equal(match.phase, 'ended');
  assert.equal(match.time, 180);
  assert.equal(match.eventSeq, seq + 1);
});
