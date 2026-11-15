import * as THREE from 'three';
import { jitterDir } from './weapons.js';

/** Common preparation consumes the same per-actor RNG in authority and replay. */
export function prepareShot(actor, spread) {
  const origin =
    actor.controlType === 'human'
      ? actor.shotOrigin(new THREE.Vector3())
      : actor.eye(new THREE.Vector3());
  const direction = actor.forward(new THREE.Vector3());
  jitterDir(direction, spread, () => actor.random());
  actor.shotSeq = (actor.shotSeq || 0) + 1;
  actor.radarT = 1.6;
  return { origin, direction, shotSeq: actor.shotSeq };
}
