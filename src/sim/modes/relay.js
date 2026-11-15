import * as THREE from 'three';
import { RelayState } from './relay-state.js';

export function relayPoints(game) {
  return (game.map.relayPoints || []).map(({ x, z, y = 0 }) => {
    const k = game.nav.nearestFree(game.nav.idx(x, z));
    const p = k >= 0 ? game.nav.center(k) : [x, z];
    return new THREE.Vector3(p[0], game.nav.heightAt?.(...p) ?? y, p[1]);
  });
}
export function relayCounts(game, position, radius = 4.25) {
  const counts = { BL: 0, GR: 0 };
  for (const a of game.actors) {
    if (!a.alive || a.protectT > 0 || Math.abs(a.pos.y - position.y) > 0.85) continue;
    const d = position.clone().sub(a.pos),
      len = d.length();
    if (Math.hypot(d.x, d.z) > radius) continue;
    d.divideScalar(len || 1);
    if (
      len > 0.2 &&
      game.world.raycast(a.pos.x, a.pos.y + 0.8, a.pos.z, d.x, d.y, d.z, len - 0.15, 'sight')
    )
      continue;
    counts[a.team]++;
  }
  return counts;
}
export class RelaySimulation {
  constructor(game, active) {
    this.game = game;
    this.active = active;
    this.rules = new RelayState();
    this.points = relayPoints(game);
    this.position = this.points[0].clone();
    this.radius = 4.25;
  }
  update(dt) {
    if (!this.active) return;
    this.rules.update(dt, relayCounts(this.game, this.position));
    this.position.copy(this.points[this.rules.index % this.points.length]);
    Object.assign(this.game.score, this.rules.score);
    if (Math.max(...Object.values(this.game.score)) >= this.game.goal) this.game.end('score');
  }
  state() {
    return this.active ? { ...this.rules, position: this.position.toArray() } : null;
  }
}
