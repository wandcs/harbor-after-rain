import { WeaponState, PRIMARIES, WEAPONS } from './weapons.js';
import { RelaySimulation } from './modes/relay.js';
import * as actions from './combat-actions.js';
import { World, NavGrid } from './physics.js';
import { createShipLayout, SEA_Y } from './maps/ship-layout.js';
import { createRandom } from './random.js';
import { HumanActor } from './human-actor.js';
import { Bot } from './bots.js';
import { prepareShot } from './shot.js';
import { traceShot } from './ballistics.js';
import { applyDamageState, applyDeathState } from './damage.js';
import { advanceActorPose, publicActor } from './pose-sample.js';
import { MATCH_RULES } from './match-rules.js';

/** Authority for room combat. Host supplies monotonic nowMs and inputs;
 * all score, life, match phases and rule time belong to this instance. */
export class CombatMatch {
  constructor({
    seed = 4207,
    teamSize = 4,
    mode = 'tdm',
    roomId = 1,
    resolveTargets = null,
    onEvent = () => {},
  } = {}) {
    this.random = createRandom(seed);
    this.time = 0;
    this.tick = 0;
    this.frame = 0;
    this.mode = mode;
    this.roomId = roomId;
    this.timers = [];
    this.nades = [];
    this.nadeSeq = 0;
    this.score = { BL: 0, GR: 0 };
    this.goal = MATCH_RULES.scoreLimit;
    this.phase = 'running';
    this.stageId = 1;
    this.resumeAtMs = null;
    this.pausedBy = null;
    this.activeElapsedMs = 0;
    this.lastNowMs = null;
    this.nextId = 1;
    this.events = [];
    this.eventSeq = 0;
    this.onEvent = onEvent;
    this.resolveTargets = resolveTargets;
    this.actors = [];
    this.map = createShipLayout();
    this.world = new World();
    for (const collider of this.map.colliders) this.world.add(collider);
    this.world.build();
    this.world.setWaterLevel(SEA_Y);
    const n = this.map.navBounds;
    this.nav = new NavGrid(this.world, n.x0, n.z0, n.x1, n.z1, 0.5, 0.42);
    this.objective = new RelaySimulation(this, mode === 'relay');
    for (const team of ['BL', 'GR']) for (let i = 0; i < teamSize; i++) this.addActor(team, 'bot');
  }
  emit(type, data = {}) {
    const event = {
      type,
      ...data,
      eventSeq: ++this.eventSeq,
      tick: this.tick,
      stageId: this.stageId,
    };
    this.events.push(event);
    if (this.events.length > 256) this.events.shift();
    this.onEvent(event);
  }
  addActor(team, controlType, name) {
    const id = this.nextId++;
    const Type = controlType === 'human' ? HumanActor : Bot;
    const actor = new Type(this, {
      id,
      team,
      name: name || `机器人 ${id}`,
      diff: MATCH_RULES.botDifficulty,
    });
    actor.ruleRandom = createRandom((id * 2654435761) >>> 0);
    actor.primary = 'm4a1';
    actor.lifeId = 0;
    actor.shotSeq = 0;
    this.actors.push(actor);
    this.spawnActor(actor);
    return actor;
  }
  spawnActor(actor) {
    let best = null,
      score = -Infinity;
    for (const point of this.map.spawns[actor.team]) {
      let value = this.random() * 3;
      for (const other of this.actors)
        if (other !== actor && other.alive) {
          const distance = Math.hypot(other.pos.x - point.x, other.pos.z - point.z);
          value +=
            other.team === actor.team ? -Math.max(0, 3 - distance) * 8 : Math.min(distance, 35);
        }
      if (value > score) {
        best = point;
        score = value;
      }
    }
    actor.lifeId++;
    actor.spawn(best);
    actor.shotSeq = 0;
    actor.activeInput = null;
    if (actor.onSpawn) actor.onSpawn();
    advanceActorPose(actor, 0);
  }
  join(name, primary = 'm4a1') {
    if (this.phase === 'ended') throw new Error('MATCH_ENDED');
    const teams = ['BL', 'GR'].sort(
      (a, b) =>
        this.actors.filter((p) => p.team === a && p.controlType === 'human').length -
        this.actors.filter((p) => p.team === b && p.controlType === 'human').length,
    );
    const bot = teams
      .map((team) =>
        this.actors.find((actor) => actor.team === team && actor.controlType === 'bot'),
      )
      .find(Boolean);
    if (!bot) throw new Error('ROOM_FULL');
    actions.detachGrenades(this, bot);
    this.actors.splice(this.actors.indexOf(bot), 1);
    const actor = this.addActor(bot.team, 'human', name);
    actor.primary = primary;
    actor.giveLoadout(primary);
    this.emit('member', { actorId: actor.id, replacedId: bot.id });
    return actor;
  }
  leave(actorId) {
    const actor = this.actors.find((value) => value.id === actorId);
    if (!actor) return;
    actions.detachGrenades(this, actor);
    this.actors.splice(this.actors.indexOf(actor), 1);
    if (this.actors.some((value) => value.controlType === 'human')) {
      const bot = this.addActor(actor.team, 'bot');
      this.emit('member', { actorId: bot.id, replacedId: actor.id });
    } else this.end('empty');
  }
  pause(actorId) {
    if (
      this.phase === 'ended' ||
      !this.actors.some((a) => a.id === actorId && a.controlType === 'human')
    )
      return;
    this.phase = 'paused';
    this.pausedBy = actorId;
    this.resumeAtMs = null;
    this.stageId++;
    this.clearInputs();
    this.emit('phase');
  }
  resume(actorId, nowMs) {
    if (
      this.phase !== 'paused' ||
      !this.actors.some((a) => a.id === actorId && a.controlType === 'human')
    )
      return;
    this.phase = 'countdown';
    this.resumeAtMs = nowMs + 3000;
    this.stageId++;
    this.clearInputs();
    this.emit('phase');
  }
  clearInputs() {
    for (const actor of this.actors) actor.activeInput = null;
  }
  end(reason) {
    if (this.phase !== 'ended') {
      this.phase = 'ended';
      this.stageId++;
      this.clearInputs();
      const winner =
        this.score.BL === this.score.GR ? null : this.score.BL > this.score.GR ? 'BL' : 'GR';
      this.result = {
        roomId: this.roomId,
        reason,
        mode: this.mode,
        score: { ...this.score },
        winner,
        actors: this.actors.map(({ id, name, team, stats }) => ({
          id,
          name,
          team,
          stats: { ...stats },
        })),
      };
      this.emit('end', this.result);
    }
  }
  step(dt, nowMs, inputs = new Map()) {
    const elapsed = this.lastNowMs === null ? 0 : Math.max(0, nowMs - this.lastNowMs);
    this.lastNowMs = nowMs;
    if (this.phase === 'countdown' && nowMs >= this.resumeAtMs) {
      this.phase = 'running';
      this.stageId++;
      this.clearInputs();
      this.emit('phase');
    } else if (this.phase === 'running') this.activeElapsedMs += elapsed;
    this.tick++;
    if (this.phase !== 'running') return;
    if (
      this.activeElapsedMs >= MATCH_RULES.durationSeconds * 1000 ||
      this.time + dt >= MATCH_RULES.durationSeconds - 1e-9
    ) {
      this.time = MATCH_RULES.durationSeconds;
      this.end('time');
      return;
    }
    this.time += dt;
    for (let i = this.timers.length - 1; i >= 0 && this.phase === 'running'; i--)
      if (this.time >= this.timers[i].t) {
        const timer = this.timers.splice(i, 1)[0];
        timer.fn();
      }
    for (const actor of this.actors) {
      if (this.phase !== 'running') break;
      if (!actor.alive) {
        actor.deadT += dt;
        actor.respawnT -= dt;
        actor.soldier.update(dt, {});
        if (actor.respawnT <= 0) this.spawnActor(actor);
        continue;
      }
      if (actor.controlType === 'human') {
        actor.activeInput = inputs.get(actor.id) || null;
        actor.update(dt, actor.activeInput?.input || {});
      } else actor.update(dt);
      actor.protectT = Math.max(0, actor.protectT - dt);
      actor.radarT = Math.max(0, actor.radarT - dt);
      if (actor.alive) advanceActorPose(actor, dt);
    }
    if (this.phase === 'running') actions.updateNades(this, dt);
    if (this.phase === 'running') this.objective.update(dt);
  }
  loadout(actorId, primary) {
    if (!PRIMARIES.includes(primary) || this.phase === 'ended') return;
    const actor = this.actors.find((a) => a.id === actorId);
    actor.nextPrimary = primary;
    const bounds = this.map.spawnBounds;
    const inside =
      actor.alive &&
      (actor.team === 'BL' ? actor.pos.x < bounds.BL.maxX : actor.pos.x > bounds.GR.minX);
    if (inside) {
      actor.primary = primary;
      actor.inv[0] = new WeaponState(primary);
      actor.inv[0].patternSeed = actor.random() * 6;
      actor.slot = 0;
      actor.ads = actor.scoped = actor.reScope = actor.scopeT = 0;
      actor.scopeReady = false;
      actor.readyAt = this.time + WEAPONS[primary].draw;
      actor.soldier.setWeapon(primary);
    }
  }
  fireWeapon(actor, weapon, spread) {
    const shot = prepareShot(actor, spread);
    const selection =
      actor.controlType === 'human' && this.resolveTargets
        ? this.resolveTargets(actor, actor.activeInput)
        : {
            actors: this.actors,
            path: 'current',
            reason: actor.controlType === 'bot' ? 'bot' : 'unsynchronized',
          };
    const result = traceShot(
      { world: this.world, actors: selection.actors, frame: ++this.frame },
      actor,
      shot.origin,
      shot.direction,
      weapon.def,
    );
    actor.soldier.kick();
    this.emit('shot', {
      actorId: actor.id,
      lifeId: actor.lifeId,
      shotSeq: shot.shotSeq,
      weaponId: weapon.id,
      inputSeq: actor.activeInput?.seq ?? null,
      display: actor.activeInput?.display || null,
      reused: !!actor.activeInput?.reused,
      path: selection.path,
      reason: selection.reason,
      origin: shot.origin.toArray(),
      direction: shot.direction.toArray(),
      end: result.end.toArray(),
      impacts: result.impacts.map((impact) => ({
        point: impact.point.toArray(),
        normal: impact.normal.toArray(),
        surface: impact.surface,
      })),
    });
    for (const other of this.actors)
      if (
        other !== actor &&
        other.hear &&
        other.team !== actor.team &&
        other.pos.distanceTo(actor.pos) < 45
      )
        other.hear(actor.pos, true);
    if (result.hit) {
      const { target: historical, amount, part, wall } = result.hit;
      const target = this.actors.find(
        (value) => value.id === historical.id && value.lifeId === historical.lifeId,
      );
      if (target && historical.protectT <= 0)
        this.damage(target, actor, amount, part, weapon.id, shot.direction, wall);
    }
  }
  damage(target, attacker, amount, part, weaponId, direction, wall) {
    const damage = applyDamageState(this, target, attacker, amount, part, weaponId, direction);
    if (!damage) return;
    if (target.onDamaged) target.onDamaged(attacker);
    this.emit('damage', {
      actorId: target.id,
      lifeId: target.lifeId,
      attackerId: attacker?.id ?? null,
      amount: damage.hpDamage,
      killed: damage.killed,
      part,
    });
    if (damage.killed) {
      applyDeathState(this, target, attacker, part === 'head', direction);
      this.emit('death', {
        actorId: target.id,
        lifeId: target.lifeId,
        attackerId: attacker?.id ?? null,
        wall,
        weaponId,
        headshot: part === 'head' && weaponId !== 'knife',
        attacker: attacker ? { id: attacker.id, name: attacker.name, team: attacker.team } : null,
      });
      if (this.mode !== 'relay' && (this.score.BL >= this.goal || this.score.GR >= this.goal))
        this.end('score');
    }
  }
  publicState(snapshotSeq, nowMs) {
    return {
      roomId: this.roomId,
      mode: this.mode,
      objective: this.objective.state(),
      nades: this.nades.map((n) => ({ id: n.id, pos: n.pos.toArray() })),
      snapshotSeq,
      tick: this.tick,
      nowMs,
      time: this.time,
      remainingMs: Math.max(
        0,
        MATCH_RULES.durationSeconds * 1000 - Math.max(this.activeElapsedMs, this.time * 1000),
      ),
      stageId: this.stageId,
      phase: this.phase,
      resumeAtMs: this.resumeAtMs,
      pausedBy: this.pausedBy,
      score: { ...this.score },
      eventSeq: this.eventSeq,
      actors: this.actors.map(publicActor),
    };
  }
  onJump() {}
  onLand() {}
  onFootstep() {}
  onScope() {}
  onDryFire() {}
  onReloadDone() {}
  onSwitch() {}
  onGrenadeStart() {}
  onReloadStart(actor) {
    this.emit('reload', { actorId: actor.id, lifeId: actor.lifeId });
  }
  melee(actor, heavy) {
    actions.melee(this, actor, heavy);
    this.emit('melee', { actorId: actor.id, heavy });
  }
  throwGrenade(actor) {
    const nade = actions.throwGrenade(this, actor);
    this.emit('grenade', { actorId: actor.id, id: nade.id });
  }
  explode(position, owner) {
    this.emit('explosion', { pos: position.toArray(), actorId: owner.id });
    actions.explode(this, position, owner);
  }
}
