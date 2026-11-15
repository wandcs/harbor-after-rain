import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { CombatMatch } from '../../src/sim/combat-match.js';
import { CharacterPose, HITBOXES } from '../../src/sim/character-pose.js';
import {
  advanceActorPose,
  publicActor,
  applyPoseSample,
  sampleActors,
  interpolateActor,
} from '../../src/sim/pose-sample.js';
import { SnapshotHistory } from '../../server/sync/history.js';
import { SnapshotBuffer } from '../../src/net/snapshot-buffer.js';
import { readConfig } from '../../server/config.js';
import { encodeMessage, decodeMessage } from '../../src/protocol/messages.js';
import { saveActor } from '../../src/sim/actor-state.js';

function wirePublic(match, state) {
  const actor = match.actors.find((value) => value.controlType === 'human') || match.actors[0];
  return decodeMessage(
    encodeMessage({
      type: 'snapshot',
      public: state,
      own: {
        snapshotSeq: state.snapshotSeq,
        actorId: actor.id,
        ackSeq: 0,
        activeInput: actor.activeInput,
        state: saveActor(actor),
      },
    }),
  ).public;
}

function matrices(pose) {
  pose.root.updateMatrixWorld(true);
  return pose.bones.flatMap((bone) => bone.matrixWorld.toArray());
}
function equalPose(a, b) {
  const aa = matrices(a),
    bb = matrices(b);
  assert.ok(Math.max(...aa.map((value, i) => Math.abs(value - bb[i]))) < 1e-9);
}
function maxVertexError(a, b) {
  a.root.updateMatrixWorld(true);
  b.root.updateMatrixWorld(true);
  let error = 0;
  for (const [name, x, y, z, hx, hy, hz] of HITBOXES)
    for (const sx of [-1, 1])
      for (const sy of [-1, 1])
        for (const sz of [-1, 1]) {
          const local = new THREE.Vector3(x + sx * hx, y + sy * hy, z + sz * hz);
          error = Math.max(
            error,
            local
              .clone()
              .applyMatrix4(a.B[name].matrixWorld)
              .distanceTo(local.applyMatrix4(b.B[name].matrixWorld)),
          );
        }
  return error;
}
test('public recipes reproduce actual head/chest/limb pose across movement, crouch/jump, recoil, flinch and reload', (t) => {
  const match = new CombatMatch({ teamSize: 1 }),
    actor = match.join('human');
  const rig = new CharacterPose({ random: () => 0.99 }),
    wireRig = new CharacterPose({ random: () => 0.2 });
  let previous = null,
    maximumError = 0;
  const withinTolerance = (a, b, context) => {
    const error = maxVertexError(a, b);
    maximumError = Math.max(maximumError, error);
    assert.ok(error <= 0.002, `${context}: ${error} m`);
  };
  for (let i = 0; i < 80; i++) {
    if (i % 20 === 0) actor.giveLoadout(['m4a1', 'ak47', 'mp5', 'awm'][i / 20]);
    actor.yaw = i * 0.03;
    actor.pitch = Math.sin(i / 10);
    actor.speed = [0.3 - 1e-12, 0.3, 0.3 + 1e-12, 1, 3, 5][i % 6];
    const fwd = [-0.3 - 1e-12, -0.3, -0.3 + 1e-12][i % 3],
      side = Math.sqrt(1 - fwd * fwd);
    actor.vel.set(
      (-Math.sin(actor.yaw) * fwd + Math.cos(actor.yaw) * side) * actor.speed,
      0,
      (-Math.cos(actor.yaw) * fwd - Math.sin(actor.yaw) * side) * actor.speed,
    );
    actor.crouch = i > 30;
    actor.onGround = i < 50 || i > 65;
    const threshold = (i % 2 ? 0.5 : 0.01) + [-1e-12, 0, 1e-12][i % 3];
    const initialCrouch = (threshold - (actor.crouch ? 1 / 6 : 0)) / (5 / 6);
    if (initialCrouch >= 0 && initialCrouch <= 1) actor.soldier.crouchK = initialCrouch;
    if (i % 6 === 0) actor.soldier.kick();
    if (i === 10) actor.soldier.flinch(new THREE.Vector3(1, 0, 0), 'head', 30);
    actor.weapon.reloadUntil = i > 60 ? 100 : 0;
    advanceActorPose(actor, 1 / 60);
    const raw = publicActor(actor);
    const sample = wirePublic(match, {
      ...match.publicState(i + 1, (i * 1000) / 60),
      actors: [publicActor(actor)],
    }).actors[0];
    applyPoseSample(rig, raw);
    equalPose(actor.soldier, rig);
    applyPoseSample(wireRig, sample);
    withinTolerance(rig, wireRig, `wire pose error at sample ${i}`);
    for (const key of ['speed', 'fwd']) assert.equal(sample.pose.input[key], raw.pose.input[key]);
    assert.equal(sample.pose.state.crouchK, raw.pose.state.crouchK);
    assert.equal(sample.pose.dt, raw.pose.dt);
    if (previous)
      for (const alpha of [0.25, 0.5, 0.75]) {
        applyPoseSample(rig, interpolateActor(previous.raw, raw, alpha));
        applyPoseSample(wireRig, interpolateActor(previous.sample, sample, alpha));
        withinTolerance(rig, wireRig, `wire interpolation error at ${i}/${alpha}`);
      }
    previous = { raw, sample };
    // Re-rendering the same sample after independent events cannot advance it.
    rig.kick();
    rig.flinch(new THREE.Vector3(0, 0, 1), 'head', 80);
    applyPoseSample(rig, raw);
    equalPose(actor.soldier, rig);
  }
  actor.protectT = 0;
  const enemy = match.actors.find((value) => value.team !== actor.team);
  match.damage(actor, enemy, 1000, 'head', 'm4a1', new THREE.Vector3(1, 0, 0), false);
  for (let step = 0; step < 60; step++) {
    actor.soldier.update(1 / 60, {});
    const raw = publicActor(actor),
      sample = wirePublic(match, match.publicState(100 + step, 1500 + step)).actors.find(
        (value) => value.id === actor.id,
      );
    applyPoseSample(rig, raw);
    applyPoseSample(wireRig, sample);
    assert.ok(sample.corpse);
    withinTolerance(rig, wireRig, 'corpse geometry');
  }
  t.diagnostic(
    JSON.stringify({
      maximumHitboxVertexErrorMetres: maximumError,
      toleranceMetres: 0.002,
      sourceRuleEqualityTolerance: 1e-9,
    }),
  );
});
test('client display and history use exactly the same endpoints/alpha and finite fallback windows', () => {
  const match = new CombatMatch({ teamSize: 1 }),
    actor = match.join('human'),
    config = readConfig({});
  const h = new SnapshotHistory(config),
    buffer = new SnapshotBuffer();
  const a = wirePublic(match, match.publicState(1, 100));
  actor.pos.x += 1;
  advanceActorPose(actor, 1 / 60);
  const b = wirePublic(match, match.publicState(2, 116.6667));
  h.add(a);
  h.add(b);
  buffer.add(a);
  buffer.add(b);
  const display = buffer.sample(108.33335),
    conn = { sentSnapshots: new Set([1, 2]), rttMs: 20 };
  const selection = h.select(match, actor, { display: display.display }, 150, conn);
  assert.equal(selection.path, 'history');
  for (const target of selection.actors) {
    const sample = display.actors.find((value) => value.id === target.id),
      rig = new CharacterPose({ random: () => 0 });
    applyPoseSample(rig, sample);
    equalPose(rig, target.soldier);
  }
  assert.equal(h.select(match, actor, null, 150, conn).reason, 'unsynchronized');
  assert.equal(
    h.select(match, actor, { display: { a: 0, b: 0, alpha: 0 } }, 150, conn).reason,
    'sample-missing',
  );
  assert.equal(
    h.select(match, actor, { display: display.display }, 500, conn).reason,
    'outside-window',
  );
  assert.equal(
    h.select(match, actor, { display: display.display }, 150, {
      ...conn,
      sentSnapshots: new Set([1]),
    }).reason,
    'unsent-sample',
  );
  assert.equal(
    h.select(match, actor, { display: display.display }, 150, {
      ...conn,
      sentSnapshots: new Set([2]),
    }).reason,
    'unsent-sample',
  );
  for (const hz of [60, 30]) {
    const config = readConfig({ SNAPSHOT_HZ: String(hz) }),
      boundary = new SnapshotHistory(config);
    boundary.add({ ...a, nowMs: 0 });
    boundary.add({ ...b, nowMs: 20 });
    for (const age of [config.rewindMs - 1, config.rewindMs, config.rewindMs + 1]) {
      const selected = boundary.select(
        match,
        actor,
        { display: { a: 1, b: 2, alpha: 0.5 } },
        10 + age,
        { sentSnapshots: new Set([1, 2]), rttMs: 200 },
      );
      assert.equal(
        selected.path,
        age <= config.rewindMs ? 'history' : 'current',
        `${hz} Hz age=${age}`,
      );
      if (age > config.rewindMs) assert.equal(selected.reason, 'outside-window');
    }
  }
  actor.lifeId++;
  assert.equal(
    h.select(match, actor, { display: display.display }, 150, conn).reason,
    'life-boundary',
  );
  match.pause(actor.id);
  assert.equal(
    h.select(match, actor, { display: display.display }, 150, conn).reason,
    'stage-boundary',
  );
  for (let i = 0; i < 100; i++) h.add({ snapshotSeq: i });
  assert.equal(h.samples.length, config.maxHistory);
  h.clear();
  assert.equal(h.rigs.size, 0);
});
test('missing-next display holds an actual endpoint, and life changes never blend', () => {
  const match = new CombatMatch({ teamSize: 1 }),
    a = match.publicState(1, 0),
    b = structuredClone(a);
  b.snapshotSeq = 2;
  b.nowMs = 16;
  b.actors[0].lifeId++;
  b.actors[0].pos[0] += 30;
  assert.equal(sampleActors(a, b, 0.5)[0].lifeId, a.actors[0].lifeId);
  assert.equal(sampleActors(a, b, 1)[0].lifeId, b.actors[0].lifeId);
  const buffer = new SnapshotBuffer(2);
  buffer.add(a);
  buffer.add(b);
  assert.deepEqual(buffer.sample(1000).display, { a: 2, b: 2, alpha: 0 });
});
