import { WEAPONS } from './weapons.js';

/** Applies shared HP/armour/hit response. Returns null for ignored damage.
 * The host owns context.time (seconds), and confirms death separately. */
export function applyDamageState(context, victim, attacker, amount, part, weaponId, direction) {
  if (!victim.alive || victim.protectT > 0) return null;
  if (attacker && attacker !== victim && attacker.team === victim.team) return null;
  let hpDamage = amount;
  if (victim.armor > 0 && part !== 'leg') {
    const penetration = WEAPONS[weaponId]?.armorPen ?? 0.75;
    hpDamage = amount * penetration;
    victim.armor = Math.max(0, victim.armor - amount * (1 - penetration) * 1.4);
  }
  victim.hp -= hpDamage;
  victim.soldier.flinch(direction, part, hpDamage);
  victim.lastAttacker = attacker;
  victim.lastHurt = context.time;
  if (attacker && attacker !== victim) attacker.stats.hits++;
  if (victim.controlType === 'human' || victim.isPlayer) {
    victim.aimPunch += Math.min(0.05, hpDamage * 0.0012);
    victim.damageResponse.hit(hpDamage, direction, victim.yaw, part === 'head');
  }
  return { hpDamage, killed: victim.hp <= 0 };
}

/** Commits the existing death/statistics transition; host handles feedback and
 * match settlement. Must be called once for a confirmed living victim. */
export function applyDeathState(context, victim, attacker, headshot, direction) {
  victim.alive = false;
  victim.hp = 0;
  victim.deadT = 0;
  victim.respawnT = 4;
  victim.stats.d++;
  victim.scoped = 0;
  victim.ads = 0;
  victim.soldier.die(direction.x, direction.z, headshot);
  if (attacker && attacker !== victim) {
    attacker.stats.k++;
    if (headshot) attacker.stats.hs++;
    if (context.mode !== 'relay') context.score[attacker.team]++;
    attacker.multi = context.time - attacker.lastKillT < 5 ? attacker.multi + 1 : 1;
    attacker.lastKillT = context.time;
    attacker.streak++;
  }
}
