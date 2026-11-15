import { WeaponState } from './weapons.js';
import { createRandom } from './random.js';

// One field definition for authority save/restore and client replay. Units follow
// Actor: metres, radians, seconds. IDs and sequence numbers are integers.
export const ACTOR_FIELDS = Object.freeze([
  'yaw',
  'pitch',
  'radius',
  'height',
  'stepHeight',
  'onGround',
  'crouch',
  'eyeH',
  'punchP',
  'punchY',
  'aimPunch',
  'hp',
  'armor',
  'alive',
  'deadT',
  'respawnT',
  'protectT',
  'slot',
  'lastSlot',
  'readyAt',
  'stepDist',
  'speed',
  'ads',
  'scoped',
  'scopeReady',
  'scopeT',
  'reScope',
  'pendingThrow',
  'autoSwitchAt',
  'jumpCD',
  'landed',
  'landSpeed',
  'walk',
  'bobT',
  'land',
  'camRoll',
  'radarT',
  'lastHurt',
  'shotSeq',
  'lifeId',
]);
export const WEAPON_FIELDS = Object.freeze([
  'mag',
  'reserve',
  'nextFire',
  'reloadUntil',
  'shotsFired',
  'spreadAcc',
  'lastShot',
  'boltUntil',
  'patternSeed',
]);

/** Plain complete human prediction state; never carries a host or math object. */
export function saveActor(actor) {
  return {
    primary: actor.primary,
    nextPrimary: actor.nextPrimary || null,
    fields: Object.fromEntries(ACTOR_FIELDS.map((key) => [key, actor[key] ?? 0])),
    pos: actor.pos.toArray(),
    vel: actor.vel.toArray(),
    weapons: actor.inv.map((weapon) => ({
      id: weapon.id,
      ...Object.fromEntries(WEAPON_FIELDS.map((key) => [key, weapon[key] ?? 0])),
    })),
    randomState: actor.ruleRandom.getState(),
    stats: { ...actor.stats },
    damage: actor.damageResponse
      ? { ...actor.damageResponse, offset: { ...actor.damageResponse.offset } }
      : null,
    explosionOffset: actor.explosionOffset?.toArray() || [0, 0],
  };
}

/** Restores owned fields in-place; static definitions and host references remain
 * local. Caller's clock and collision sample must be restored at the same edge. */
export function restoreActor(actor, state) {
  actor.primary = state.primary || state.weapons[0].id;
  actor.nextPrimary = state.nextPrimary;
  for (const key of ACTOR_FIELDS) actor[key] = state.fields[key];
  actor.pos.fromArray(state.pos);
  actor.vel.fromArray(state.vel);
  actor.inv = state.weapons.map((value) => {
    const weapon = new WeaponState(value.id);
    for (const key of WEAPON_FIELDS) weapon[key] = value[key];
    return weapon;
  });
  actor.ruleRandom ||= createRandom(0);
  actor.ruleRandom.setState(state.randomState);
  actor.stats = { ...state.stats };
  if (state.damage && actor.damageResponse) {
    for (const [key, value] of Object.entries(state.damage))
      if (key !== 'offset') actor.damageResponse[key] = value;
    Object.assign(actor.damageResponse.offset, state.damage.offset);
  }
  actor.explosionOffset?.fromArray(state.explosionOffset);
  actor.ground = null; // World.move recomputes the contact; only feedback reads it.
  actor.soldier.setWeapon(actor.weapon.id);
}
