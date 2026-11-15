import * as THREE from 'three';
import { WEAPONS } from './weapons.js';

/** Shared combat calculations. Hosts own time/timers/nades and presentation hooks. */
export function melee(game, actor, heavy) {
  const d = WEAPONS.knife,
    range = heavy ? d.rangeHeavy : d.rangeLight;
  const eye = actor.eye(new THREE.Vector3()),
    base = actor.forward(new THREE.Vector3());
  const lifeId = actor.lifeId;
  let hit = null;
  for (const off of [0, 0.12, -0.12, 0.24, -0.24]) {
    const dir = base.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), off);
    for (const target of game.actors) {
      if (!target.alive || target === actor || target.team === actor.team) continue;
      const r = target.soldier.hitTest(eye, dir, range, ++game.frame);
      const wall = game.world.raycast(eye.x, eye.y, eye.z, dir.x, dir.y, dir.z, range, 'bullet');
      if (r && (!wall || r.t < wall.t) && (!hit || r.t < hit.t))
        hit = { target, lifeId: target.lifeId, t: r.t, part: r.part, dir };
    }
    if (hit) break;
  }
  game.timers.push({
    t: game.time + (heavy ? 0.33 : 0.1),
    fn: () => {
      if (!actor.alive || actor.lifeId !== lifeId || !game.actors.includes(actor)) return;
      if (
        hit &&
        hit.target.alive &&
        hit.target.lifeId === hit.lifeId &&
        game.actors.includes(hit.target)
      ) {
        const vf = hit.target.forward(new THREE.Vector3()).setY(0).normalize();
        const back = vf.dot(hit.dir.clone().setY(0).normalize()) > 0.5;
        const amount =
          (heavy ? d.dmgHeavy : d.dmgLight) *
          (back ? (heavy ? 2 : 1.6) : 1) *
          (hit.part === 'head' ? 1.3 : 1);
        game.onMeleeImpact?.(actor, heavy, eye.clone().addScaledVector(hit.dir, hit.t), hit.dir);
        game.damage(hit.target, actor, amount, hit.part, 'knife', hit.dir, false, true);
      } else game.onMeleeMiss?.(actor, heavy, eye, base, range);
    },
  });
}
export function throwGrenade(game, actor) {
  const direction = actor.forward(new THREE.Vector3());
  const pos = actor
    .eye(new THREE.Vector3())
    .addScaledVector(direction, 0.5)
    .addScaledVector(new THREE.Vector3(Math.cos(actor.yaw), 0, -Math.sin(actor.yaw)), 0.12);
  const vel = direction
    .multiplyScalar(16)
    .add(new THREE.Vector3(0, 2.8, 0))
    .addScaledVector(actor.vel, 0.6);
  const nade = { id: ++game.nadeSeq, pos, vel, fuse: WEAPONS.he.fuse, owner: actor };
  game.nades.push(nade);
  for (const other of game.actors)
    if (other.hear && other.team !== actor.team && other.pos.distanceTo(pos) < 20)
      other.hear(pos, false);
  return nade;
}
/** Detach only ownership data, so an in-flight grenade cannot retain the actor/world. */
export function detachGrenades(game, actor) {
  for (const nade of game.nades)
    if (nade.owner === actor)
      nade.owner = {
        id: actor.id,
        team: actor.team,
        name: actor.name,
        pos: actor.pos.clone(),
        stats: { ...actor.stats },
        multi: actor.multi,
        lastKillT: actor.lastKillT,
        streak: actor.streak,
      };
}
export function updateNades(game, dt) {
  game.nades = game.nades.filter((nade) => {
    if (game.phase === 'ended' || game.ended) return false;
    nade.fuse -= dt;
    const h = dt / 3;
    for (let step = 0; step < 3; step++) {
      nade.vel.y -= 14 * h;
      const speed = nade.vel.length();
      if (speed < 1e-4) continue;
      const dir = nade.vel.clone().divideScalar(speed);
      const hit = game.world.raycast(
        nade.pos.x,
        nade.pos.y,
        nade.pos.z,
        dir.x,
        dir.y,
        dir.z,
        speed * h + 0.07,
        'move',
      );
      if (hit) {
        const normal = new THREE.Vector3(hit.nx, hit.ny, hit.nz),
          vn = nade.vel.dot(normal);
        nade.pos.addScaledVector(dir, Math.max(0, hit.t - 0.07));
        nade.vel.addScaledVector(normal, -1.45 * vn).multiplyScalar(0.55);
        if (Math.abs(vn) > 2) game.onGrenadeBounce?.(nade);
        if (normal.y > 0.7 && Math.abs(nade.vel.y) < 1.2) {
          nade.vel.y = 0;
          nade.vel.x *= 0.8;
          nade.vel.z *= 0.8;
        }
      } else nade.pos.addScaledVector(nade.vel, h);
    }
    game.onGrenadeMoved?.(nade, dt);
    if (nade.fuse <= 0) {
      game.explode(nade.pos.clone(), nade.owner);
      game.onGrenadeRemoved?.(nade);
      return false;
    }
    return true;
  });
}
export function explode(game, position, owner) {
  const d = WEAPONS.he;
  for (const actor of game.actors) {
    if (game.phase === 'ended' || game.ended) break;
    if (!actor.alive || (actor.team === owner.team && actor.id !== owner.id)) continue;
    const center = actor.soldier.chestWorld(new THREE.Vector3()),
      distance = center.distanceTo(position);
    if (distance > d.radius) continue;
    const dir = center.sub(position),
      length = dir.length();
    dir.divideScalar(length || 1);
    const blocked = game.world.raycast(
      position.x,
      position.y + 0.2,
      position.z,
      dir.x,
      dir.y,
      dir.z,
      Math.max(0, length - 0.3),
      'bullet',
    );
    const amount = d.dmg * Math.pow(1 - distance / d.radius, 1.1) * (blocked ? 0.2 : 1);
    if (amount > 1) game.damage(actor, owner, amount, 'chest', 'he', dir, false);
  }
  for (const other of game.actors)
    if (other.hear && other.pos.distanceTo(position) < 40) other.hear(position, true);
}
