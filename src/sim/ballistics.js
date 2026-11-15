import * as THREE from 'three';

/** Runs the existing ordered surface/actor ray query. Mutates only the host's
 * query frame counter. Returned impacts are presentation data; damage is applied
 * separately by the host exactly once. All distances are metres. */
export function traceShot(context, shooter, origin, direction, weapon) {
  const range = weapon.range;
  const hits = context.world.raycastAll(
    origin.x,
    origin.y,
    origin.z,
    direction.x,
    direction.y,
    direction.z,
    range,
  );
  const impacts = [];
  let power = weapon.pen,
    multiplier = 1,
    wall = false,
    from = 0;
  context.frame++;
  for (let i = 0; i <= hits.length; i++) {
    const surfaceHit = hits[i];
    const limit = surfaceHit ? surfaceHit.t : range;
    let target = null,
      distance = limit,
      part = null;
    for (const actor of context.actors) {
      if (!actor.alive || actor === shooter || actor.team === shooter.team) continue;
      const hit = actor.soldier.hitTest(origin, direction, distance, context.frame);
      if (hit && hit.t > from - 0.01 && hit.t < distance) {
        target = actor;
        distance = hit.t;
        part = hit.part;
      }
    }
    if (target) {
      const end = origin.clone().addScaledVector(direction, distance);
      const partMultiplier =
        part === 'head' ? weapon.headMul : part === 'arm' || part === 'leg' ? weapon.limbMul : 1;
      const amount =
        weapon.dmg * multiplier * Math.pow(weapon.falloff, distance / 10) * partMultiplier;
      const surface =
        target.armor > 0 && ['head', 'chest', 'body'].includes(part) ? 'armor' : 'flesh';
      impacts.push({ point: end, normal: direction.clone().negate(), surface });
      return { end, impacts, hit: { target, part, amount, wall } };
    }
    if (!surfaceHit) break;
    const end = origin.clone().addScaledVector(direction, surfaceHit.t);
    const surface = surfaceHit.collider.mat;
    impacts.push({
      point: end,
      normal: new THREE.Vector3(surfaceHit.nx, surfaceHit.ny, surfaceHit.nz),
      surface,
    });
    if (surfaceHit.collider.bullet === 'pen') {
      const cost = (surfaceHit.exit - surfaceHit.t) * (surface === 'wood' ? 1 : 1.9);
      if (power > cost) {
        power -= cost;
        multiplier *= 0.6;
        wall = true;
        from = surfaceHit.exit;
        impacts.push({
          point: origin.clone().addScaledVector(direction, surfaceHit.exit),
          normal: direction.clone(),
          surface,
          exit: true,
        });
        continue;
      }
    } else {
      impacts.at(-1).ricochet = surface === 'metal';
    }
    return { end, impacts, hit: null };
  }
  return { end: origin.clone().addScaledVector(direction, range), impacts, hit: null };
}
