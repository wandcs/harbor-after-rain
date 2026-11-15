const POSE_FIELDS = [
  'phase',
  'crouchK',
  'amp',
  'reloadPhase',
  'recoilK',
  'flinchPitch',
  'flinchRoll',
  'flinchHead',
];
const lerp = (a, b, alpha) => a + (b - a) * alpha;
const mix = (a, b, alpha) =>
  Object.fromEntries(
    Object.keys(a).map((key) => [
      key,
      typeof a[key] === 'number' && typeof b[key] === 'number'
        ? lerp(a[key], b[key], alpha)
        : alpha < 1
          ? a[key]
          : b[key],
    ]),
  );

/** Records the exact inputs before the existing pose algorithm advances. */
export function advanceActorPose(actor, dt) {
  const pose = actor.soldier;
  const input = {
    speed: actor.speed || 0,
    fwd:
      (actor.vel.x * -Math.sin(actor.yaw) + actor.vel.z * -Math.cos(actor.yaw)) /
      Math.max(0.01, actor.speed || 0),
    crouch: !!actor.crouch,
    pitch: actor.pitch + actor.punchP,
    onGround: !!actor.onGround,
    reloading: actor.weapon.reloading,
  };
  actor.poseFrame = {
    dt,
    state: Object.fromEntries(POSE_FIELDS.map((key) => [key, pose[key] || 0])),
    input,
  };
  pose.root.position.copy(actor.pos);
  pose.root.rotation.y = actor.yaw;
  pose.update(dt, input);
}

export function publicActor(actor) {
  const pose = actor.soldier;
  return {
    id: actor.id,
    name: actor.name,
    team: actor.team,
    controlType: actor.controlType,
    lifeId: actor.lifeId,
    alive: actor.alive,
    hp: actor.hp,
    armor: actor.armor,
    protectT: actor.protectT,
    radarT: actor.radarT,
    pos: actor.pos.toArray(),
    vel: actor.vel.toArray(),
    yaw: actor.yaw,
    pitch: actor.pitch,
    weaponId: actor.weapon.id,
    mag: actor.weapon.mag,
    reloading: actor.weapon.reloading,
    stats: { ...actor.stats },
    pose: actor.poseFrame,
    corpse: actor.alive
      ? null
      : {
          body: pose.mesh.quaternion.toArray(),
          bones: pose.bones.map((bone) => [bone.position.toArray(), bone.quaternion.toArray()]),
        },
  };
}

/** Same endpoint selection and blending on both render and historical queries.
 * Discrete lifecycle changes occur only when the newer sample is displayed. */
export function interpolateActor(a, b, alpha) {
  if (!b || a.id !== b.id || a.lifeId !== b.lifeId || a.alive !== b.alive)
    return alpha < 1 || !b ? a : b;
  return {
    ...a,
    pos: a.pos.map((value, i) => lerp(value, b.pos[i], alpha)),
    vel: a.vel.map((value, i) => lerp(value, b.vel[i], alpha)),
    yaw: a.yaw + Math.atan2(Math.sin(b.yaw - a.yaw), Math.cos(b.yaw - a.yaw)) * alpha,
    pitch: lerp(a.pitch, b.pitch, alpha),
    pose: {
      dt: lerp(a.pose.dt, b.pose.dt, alpha),
      state: mix(a.pose.state, b.pose.state, alpha),
      input: mix(a.pose.input, b.pose.input, alpha),
    },
  };
}

/** Applies an absolute pose sample; events never kick/flinch a remote skeleton.
 * Repeated application is idempotent and does not advance another timeline. */
export function applyPoseSample(pose, sample) {
  pose.setWeapon(sample.weaponId);
  pose.root.position.fromArray(sample.pos);
  pose.root.rotation.set(0, sample.yaw, 0);
  pose.invFrame = -1;
  if (sample.alive) {
    pose.deadT = -1;
    pose.mesh.rotation.set(0, 0, 0);
    Object.assign(pose, sample.pose.state);
    pose.update(sample.pose.dt, sample.pose.input);
  } else if (sample.corpse) {
    pose.mesh.quaternion.fromArray(sample.corpse.body);
    sample.corpse.bones.forEach(([position, rotation], i) => {
      pose.bones[i].position.fromArray(position);
      pose.bones[i].quaternion.fromArray(rotation);
    });
  }
  pose.root.updateMatrixWorld(true);
}

export function sampleActors(a, b, alpha) {
  const next = new Map(b.actors.map((actor) => [actor.id, actor]));
  if (alpha >= 1) return b.actors;
  return a.actors.map((actor) => interpolateActor(actor, next.get(actor.id), alpha));
}
