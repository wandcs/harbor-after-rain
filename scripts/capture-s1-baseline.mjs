// Historical oracle generator. Pass an unmodified source checkout of commit 3fb8741.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as THREE from 'three';

if (!process.argv[2]) throw new Error('Pass the original source directory explicitly.');
const root = path.resolve(process.argv[2]);
const expectedHashes = {
  'actor.js': '1671646fe9dbc068ef745568c1ad84f73d67e465f6c95d37f7e4f088fad7d292',
  'character.js': '83503089c79c339a1915e6e5f2ae21933c29be221ceb7f4ee8650a77015e1874',
  'map.js': '54df3010fd7fea8d291b2fb0686608299e0db8917449ba4ca605671daa4c8c56',
};
for (const [name, expected] of Object.entries(expectedHashes)) {
  const source = fs.readFileSync(path.join(root, name), 'utf8').replaceAll('\r\n', '\n');
  if (createHash('sha256').update(source).digest('hex') !== expected)
    throw new Error(`Not the original S1 source: ${name}`);
}
const load = (name) => import(pathToFileURL(path.join(root, name)));
globalThis.document = {
  createElement() {
    const context = new Proxy(
      { createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }) },
      { get: (t, k) => (k in t ? t[k] : () => {}) },
    );
    return { width: 1, height: 1, getContext: () => context };
  },
};
function seeded(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
Math.random = seeded(4207);
const { buildMap } = await load('map.js');
const { World } = await load('physics.js');
const { Soldier } = await load('character.js');
const { Actor } = await load('actor.js');
const { Player } = await load('player.js');
const { DamageResponse } = await load('combat-feedback.js');
const tex = { map: null, normalMap: null, roughnessMap: null, emissiveMap: null };
const T = Object.fromEntries(
  [
    'deck',
    'bulkhead',
    'darkSteel',
    'yellowSteel',
    'redSteel',
    'greenSteel',
    'superWall',
    'hull',
  ].map((k) => [k, { ...tex }]),
);
T.containers = Array.from({ length: 8 }, () => ({
  color: { rgb: [90, 110, 120] },
  side20: null,
  side40: null,
  n20: null,
  n40: null,
  door: null,
  doorN: null,
  roof: null,
  roofN: null,
}));
T.crates = Array.from({ length: 6 }, (_, i) => ({ ...tex, kind: i < 4 ? 'wood' : 'metal' }));
Object.assign(T, { fence: null, grating: null, signs: null });
const world = new World();
const map = buildMap(new THREE.Scene(), T, world, { skipAO: true });
const fields = [
  'x',
  'y',
  'z',
  'hx',
  'hy',
  'hz',
  'yaw',
  'mat',
  'solid',
  'bullet',
  'sight',
  'surface',
  'tag',
  'navSurface',
];
const result = {
  source: {
    commit: '3fb8741a42c09d66372b2fc08190747f1422a44d',
    normalizedSHA256: expectedHashes,
    posePhase: 0.75,
    weaponPatternSeed: '0.5 + slot * 0.2',
  },
  seed: 4207,
  colliders: world.colliders.map((c) => Object.fromEntries(fields.map((k) => [k, c[k]]))),
  metadata: Object.fromEntries(
    [
      'spawns',
      'bounds',
      'navBounds',
      'spawnBounds',
      'relayPoints',
      'navigationChecks',
      'routeChecks',
      'lanes',
    ].map((k) => [k, map[k]]),
  ),
  poses: {},
  movement: [],
  weapons: [],
  player: [],
};
for (const id of ['m4a1', 'ak47', 'mp5', 'awm', 'deagle', 'knife', 'he']) {
  Math.random = seeded(4207);
  const s = new Soldier('BL');
  s.setWeapon(id);
  s.phase = 0.75;
  s.root.position.set(2, 0.02, 3);
  s.root.rotation.y = 0.4;
  result.poses[id] = [];
  for (let tick = 0; tick < 180; tick++) {
    if (tick === 40) s.kick();
    if (tick === 70) s.flinch({ x: 1, z: -0.5 }, 'head', 35);
    s.update(1 / 60, {
      speed: tick < 100 ? 4 : 0,
      fwd: tick < 50 ? 1 : -1,
      crouch: tick >= 60 && tick < 110,
      pitch: 0.3,
      onGround: tick < 120 || tick > 145,
      reloading: tick >= 20 && tick < 50,
    });
    s.root.updateMatrixWorld(true);
    if ([0, 30, 41, 71, 100, 130, 179].includes(tick))
      result.poses[id].push(s.bones.map((b) => b.matrixWorld.toArray()));
  }
}
const game = {
  time: 0,
  world,
  actors: [],
  renderer: { scene: new THREE.Scene() },
  onJump() {},
  onLand() {},
  onFootstep() {},
  onReloadStart() {},
  onReloadDone() {},
  onScope() {},
  onSwitch() {},
  fireWeapon() {},
};
Math.random = seeded(4207);
const a = new Actor(game, { id: 1, team: 'BL', isPlayer: true });
a.primary = 'm4a1';
a.spawn({ x: -32, z: -15.7, yaw: -Math.PI / 2 });
game.actors = [a];
a.inv.forEach((weapon, index) => (weapon.patternSeed = 0.5 + index * 0.2));
Math.random = seeded(4207);
for (let tick = 0; tick < 240; tick++) {
  game.time += 1 / 60;
  a.move(1 / 60, 1, 0, tick === 30, tick >= 80 && tick < 130, tick >= 180);
  a.weaponUpdate(1 / 60, {
    fire: tick < 70,
    firePressed: tick === 0,
    reload: tick === 80,
    sw: tick === 200 ? 1 : null,
  });
  if (tick % 20 === 0) {
    result.movement.push([...a.pos.toArray(), ...a.vel.toArray(), a.eyeH, a.height, a.onGround]);
    result.weapons.push([
      a.slot,
      a.weapon.mag,
      a.weapon.reserve,
      a.weapon.nextFire,
      a.weapon.reloadUntil,
      a.punchP,
      a.punchY,
    ]);
  }
}
const p = Object.create(Player.prototype),
  camera = new THREE.PerspectiveCamera(78, 1.6, 0.05, 100);
Object.assign(p, {
  game: { renderer: { camera }, opts: { fov: 78 }, fx: { shake: 0.2 } },
  alive: true,
  pos: new THREE.Vector3(5, 0, 2),
  eyeH: 1.62,
  pitch: 0.1,
  yaw: 0.3,
  punchP: 0.04,
  punchY: 0.01,
  aimPunch: 0.02,
  speed: 4,
  onGround: true,
  ads: 0.4,
  scoped: 0,
  bobT: 0,
  land: 0,
  keys: new Set(['KeyA']),
  camRoll: 0,
  explosionOffset: new THREE.Vector2(),
  damageResponse: new DamageResponse(),
  inv: [{ def: { type: 'rifle' } }],
  slot: 0,
});
Math.random = seeded(4207);
p.damageResponse.hit(30, { x: 1, z: 0 }, p.yaw);
for (let tick = 0; tick < 60; tick++) {
  p.pos.x += 0.03;
  p.updateCamera(1 / 60);
  if (tick % 10 === 0)
    result.player.push({
      origin: p.shotOrigin(new THREE.Vector3()).toArray(),
      direction: p.forward(new THREE.Vector3()).toArray(),
      rotation: camera.rotation.toArray().slice(0, 3),
      spring: p.damageResponse.time,
    });
}
fs.mkdirSync('tests/fixtures', { recursive: true });
fs.writeFileSync('tests/fixtures/s1-original.json', JSON.stringify(result));
console.log({
  colliders: result.colliders.length,
  poses: Object.keys(result.poses),
  bytes: fs.statSync('tests/fixtures/s1-original.json').size,
});
