import * as THREE from 'three';
import { Actor } from './actor.js';
import { DamageResponse } from './combat-feedback.js';
import { playerForward, updatePlayerPose } from './player-pose.js';

/** Human actor driven by host inputs; no keyboard, browser camera or renderer.
 * update() consumes one fixed step in seconds; the host advances game.time. */
export class HumanActor extends Actor {
  constructor(game, options) {
    super(game, { ...options, controlType: 'human' });
    this.damageResponse = new DamageResponse();
    this.bobT = 0;
    this.land = 0;
    this.camRoll = 0;
    this.explosionOffset = new THREE.Vector2();
  }
  spawn(spawnPoint) {
    super.spawn(spawnPoint);
    this.damageResponse.reset();
    this.explosionOffset.set(0, 0);
    this.bobT = this.land = this.camRoll = 0;
  }
  forward(out) {
    return playerForward(this, out);
  }
  pose(dt, input = {}) {
    return updatePlayerPose(this, dt, {
      shake: this.game.shake || 0,
      random: () => this.random(),
      left: !!input.left,
      right: !!input.right,
    });
  }
  shotOrigin(out) {
    return out.copy(this.pose(0).position);
  }
  update(dt, input = {}) {
    if (!this.alive) return;
    if (Number.isFinite(input.yaw)) this.yaw = input.yaw;
    if (Number.isFinite(input.pitch)) this.pitch = input.pitch;
    this.move(dt, input.moveX || 0, input.moveZ || 0, !!input.jump, !!input.crouch, !!input.walk);
    this.pose(dt, input);
    this.weaponUpdate(dt, input);
  }
}
