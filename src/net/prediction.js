import * as THREE from 'three';
import { HumanActor } from '../sim/human-actor.js';
import { saveActor, restoreActor } from '../sim/actor-state.js';
import { prepareShot } from '../sim/shot.js';
import { createRandom } from '../sim/random.js';
import { releaseInputEdges, validInputAt, MAX_FUTURE_TICKS } from '../sim/input.js';

const dt = 1 / 60;

/** Replays the real human movement/weapon chain. Collision samples are explicit
 * authority samples saved with each input, never the smoothed display actors. */
export class Prediction {
  constructor(world, onEffect = () => {}) {
    this.onEffect = onEffect;
    this.pending = [];
    this.effects = new Set();
    this.correction = 0;
    this.host = {
      world,
      actors: [],
      time: 0,
      random: createRandom(1),
      shake: 0,
      fireWeapon: (actor, weapon, spread) => {
        const shot = prepareShot(actor, spread);
        this.effect('shot', actor, { shot, weapon });
      },
      onReloadStart: (actor) => this.effect('reload', actor, { empty: actor.weapon.mag === 0 }),
      onJump: (actor) => this.effect('jump', actor),
      onLand: (actor) => this.effect('land', actor),
      onFootstep: (actor) => this.effect('step', actor),
      onScope() {},
      onDryFire() {},
      onReloadDone() {},
      onSwitch: (actor) => this.effect('switch', actor),
      onGrenadeStart: (actor) => this.effect('grenadeStart', actor),
      throwGrenade: (actor) => this.effect('grenade', actor),
      melee: (actor, heavy) => this.effect('melee', actor, { heavy }),
    };
  }
  effect(type, actor, data = {}) {
    if (this.replaying) return;
    const key =
      type === 'shot'
        ? `${actor.lifeId}:shot:${data.shot.shotSeq}`
        : `${actor.lifeId}:${type === 'reload' || type === 'jump' ? this.activeInputSeq : this.tick}:${type}`;
    if (this.effects.has(key)) return;
    this.effects.add(key);
    this.onEffect({ type, actor, ...data });
    while (this.effects.size > 512) this.effects.delete(this.effects.values().next().value);
  }
  reconcile(snapshot, own) {
    if (snapshot.snapshotSeq !== own.snapshotSeq) throw new Error('UNPAIRED_SNAPSHOT');
    const sample = snapshot.actors.find((value) => value.id === own.actorId);
    if (!sample) throw new Error('OWN_ACTOR_MISSING');
    const changed =
      !this.actor ||
      this.actor.id !== own.actorId ||
      this.actor.lifeId !== sample.lifeId ||
      this.stageId !== snapshot.stageId;
    const before = this.actor?.pos.clone();
    if (!this.actor || this.actor.id !== own.actorId)
      this.actor = new HumanActor(this.host, sample);
    if (changed) {
      this.pending = [];
      this.effects.clear();
    }
    this.pending = this.pending.filter(
      (frame) => frame.seq > own.ackSeq && frame.tick > snapshot.tick,
    );
    restoreActor(this.actor, own.state);
    this.stageId = snapshot.stageId;
    this.phase = snapshot.phase;
    this.base = snapshot;
    this.tick = snapshot.tick;
    this.host.time = snapshot.time;
    this.held = own.activeInput || null;
    if (snapshot.phase !== 'running' || !this.actor.alive) this.pending = [];
    const end = this.pending.at(-1)?.tick ?? snapshot.tick;
    this.replaying = true;
    try {
      this.advance(end);
    } finally {
      this.replaying = false;
    }
    this.correction = before && !changed ? before.distanceTo(this.actor.pos) : 0;
    return changed;
  }
  submit(frame) {
    if (!this.actor || this.phase !== 'running' || !this.actor.alive) return;
    if (this.pending.length >= 128 || frame.tick - this.base.tick > MAX_FUTURE_TICKS)
      throw new Error('PREDICTION_OVERFLOW');
    this.pending.push({ ...frame, collision: this.base.actors });
    this.advance(frame.tick);
  }
  advance(targetTick) {
    while (this.tick < targetTick) {
      this.tick++;
      this.host.time += dt;
      const frame = this.pending.find((value) => value.tick === this.tick);
      if (frame) this.held = frame;
      const held = this.held;
      const nowMs = this.base.nowMs + ((this.tick - this.base.tick) * 1000) / 60;
      const usable = validInputAt(held, this.actor.lifeId, this.stageId, nowMs);
      this.activeInputSeq = usable ? held.seq : null;
      const collision = frame?.collision || this.base.actors;
      this.host.actors = [
        this.actor,
        ...collision
          .filter((value) => value.id !== this.actor.id)
          .map((value) => ({
            id: value.id,
            alive: value.alive,
            radius: 0.36,
            pos: new THREE.Vector3(...value.pos),
          })),
      ];
      this.actor.update(dt, usable ? (frame ? held.input : releaseInputEdges(held.input)) : {});
      this.actor.protectT = Math.max(0, this.actor.protectT - dt);
      this.actor.radarT = Math.max(0, this.actor.radarT - dt);
    }
  }
  state() {
    return saveActor(this.actor);
  }
  clear() {
    this.pending = [];
    this.held = null;
  }
}
