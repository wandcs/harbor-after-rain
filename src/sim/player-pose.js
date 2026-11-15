import * as THREE from 'three';

/** Current human aim direction, including recoil and directional hit response. */
export function playerForward(actor, out) {
  const kick = actor.damageResponse?.offset;
  const pitch = actor.pitch + actor.punchP * 0.75 + actor.aimPunch + (kick?.pitch || 0);
  const yaw = actor.yaw + actor.punchY * 0.75 + (kick?.yaw || 0);
  return out.set(
    -Math.sin(yaw) * Math.cos(pitch),
    Math.sin(pitch),
    -Math.cos(yaw) * Math.cos(pitch),
  );
}

/** Advances camera-relevant simulation state in seconds. dt=0 only samples it.
 * Host supplies shake/random and strafe flags; output belongs to this call. */
export function updatePlayerPose(actor, dt, options) {
  const kick = actor.damageResponse.update(dt);
  const position = new THREE.Vector3(),
    rotation = new THREE.Euler(0, 0, 0, 'YXZ');
  // 晃动
  const sp = actor.onGround ? actor.speed : 0;
  actor.bobT += dt * (sp > 0.5 ? 6 + sp * 0.9 : 0);
  const bobK = Math.min(1, sp / 6) * (actor.scoped ? 0.2 : 1 - 0.82 * (actor.ads || 0));
  const by = Math.abs(Math.sin(actor.bobT)) * 0.028 * bobK,
    bx = Math.cos(actor.bobT) * 0.012 * bobK;
  if (dt > 0 && actor.landed && actor.landSpeed > 3)
    actor.land = Math.min(0.14, actor.landSpeed * 0.012);
  actor.land *= Math.exp(-dt * 7);
  const shake = options.shake * 0.06;
  if (dt > 0)
    actor.explosionOffset.set((options.random() - 0.5) * shake, (options.random() - 0.5) * shake);
  actor.eye(position);
  position.y += by - actor.land + actor.explosionOffset.y + kick.y;
  const sy = Math.sin(actor.yaw),
    cy = Math.cos(actor.yaw);
  position.x += cy * (bx + kick.x) + actor.explosionOffset.x;
  position.z += -sy * (bx + kick.x);
  actor.camRoll +=
    ((options.left ? 0.008 : 0) - (options.right ? 0.008 : 0) - actor.camRoll) *
    Math.min(1, dt * 6);
  rotation.set(
    actor.pitch + actor.punchP * 0.75 + actor.aimPunch + kick.pitch,
    actor.yaw + actor.punchY * 0.75 + kick.yaw,
    actor.camRoll + kick.roll,
  );
  return { position, rotation };
}
