import { freezeData } from './readonly.js';
import * as THREE from 'three';
import { WEAPON_ANCHORS } from './weapon-anchors.js';

export const BONES = freezeData([
  // name, parent, x, y, z
  ['hips', -1, 0, 0.98, 0],
  ['spine', 0, 0, 0.12, 0],
  ['chest', 1, 0, 0.2, 0],
  ['neck', 2, 0, 0.2, 0],
  ['head', 3, 0, 0.08, 0],
  ['shoulderR', 2, 0.17, 0.13, 0],
  ['upperArmR', 5, 0.04, 0, 0],
  ['forearmR', 6, 0, -0.29, 0],
  ['handR', 7, 0, -0.26, 0],
  ['shoulderL', 2, -0.17, 0.13, 0],
  ['upperArmL', 9, -0.04, 0, 0],
  ['forearmL', 10, 0, -0.29, 0],
  ['handL', 11, 0, -0.26, 0],
  ['thighR', 0, 0.1, -0.05, 0],
  ['shinR', 13, 0, -0.44, 0],
  ['footR', 14, 0, -0.44, 0],
  ['thighL', 0, -0.1, -0.05, 0],
  ['shinL', 16, 0, -0.44, 0],
  ['footL', 17, 0, -0.44, 0],
]);
export const HITBOXES = freezeData([
  // bone, cx, cy, cz, hx, hy, hz, part
  ['head', 0, 0.1, 0, 0.1, 0.12, 0.11, 'head'],
  ['chest', 0, 0.1, 0, 0.21, 0.18, 0.145, 'chest'],
  ['spine', 0, 0.09, 0, 0.17, 0.12, 0.12, 'stomach'],
  ['hips', 0, -0.02, 0, 0.18, 0.11, 0.13, 'stomach'],
  ['upperArmR', 0, -0.14, 0, 0.065, 0.16, 0.065, 'arm'],
  ['upperArmL', 0, -0.14, 0, 0.065, 0.16, 0.065, 'arm'],
  ['forearmR', 0, -0.13, 0, 0.055, 0.15, 0.055, 'arm'],
  ['forearmL', 0, -0.13, 0, 0.055, 0.15, 0.055, 'arm'],
  ['thighR', 0, -0.21, 0, 0.09, 0.24, 0.09, 'leg'],
  ['thighL', 0, -0.21, 0, 0.09, 0.24, 0.09, 'leg'],
  ['shinR', 0, -0.22, 0, 0.07, 0.24, 0.075, 'leg'],
  ['shinL', 0, -0.22, 0, 0.07, 0.24, 0.075, 'leg'],
]);

/** CPU skeleton, weapon attachment transforms and hit boxes. Owns all mutable
 * pose/query state. The host supplies random(); construction uses no renderer. */
export class CharacterPose {
  constructor({ random }) {
    if (typeof random !== 'function') throw new TypeError('CharacterPose requires random().');
    this.random = random;
    this.root = new THREE.Object3D();
    this.mesh = new THREE.Object3D();
    this.bones = BONES.map(([name]) => {
      const bone = new THREE.Bone();
      bone.name = name;
      return bone;
    });
    BONES.forEach(([, parent, x, y, z], i) => {
      this.bones[i].position.set(x, y, z);
      (parent < 0 ? this.mesh : this.bones[parent]).add(this.bones[i]);
    });
    this.root.add(this.mesh);
    this.B = Object.fromEntries(this.bones.map((bone) => [bone.name, bone]));
    this.phase = random() * 10;
    this.crouchK = 0;
    this.deadT = -1;
    this.fallDir = 1;
    this.fallSide = 0;
    this.recoilK = 0;
    this.flinchPitch = 0;
    this.flinchRoll = 0;
    this.flinchHead = 0;
    this.flinchV = 0;
    this.gun = null;
    this.gunId = null;
    this.invs = HITBOXES.map(() => new THREE.Matrix4());
    this.invFrame = -1;
    this.opacity = 1;
    this.scratch = {
      _v: new THREE.Vector3(),
      _v2: new THREE.Vector3(),
      _q: new THREE.Quaternion(),
      _q2: new THREE.Quaternion(),
      DOWN: new THREE.Vector3(0, -1, 0),
    };
  }
  setWeapon(id) {
    if (this.gunId === id) return;
    const anchors = WEAPON_ANCHORS[id];
    if (!anchors) throw new RangeError(`Unknown pose weapon: ${id}`);
    if (this.gun) this.B.chest.remove(this.gun);
    this.gunId = this.gunType = id;
    this.gun = new THREE.Object3D();
    this.gun.userData.anchors = Object.fromEntries(
      Object.entries(anchors).map(([key, value]) => [key, new THREE.Vector3(...value)]),
    );
    this.B.chest.add(this.gun);
  }
  // 两骨骼 IK：让手到达胸骨坐标系下的目标点
  solveArm(side, targetWorld, poleWorld) {
    const { _v, _v2, _q, _q2, DOWN } = this.scratch;
    const up = this.B['upperArm' + side],
      fore = this.B['forearm' + side];
    const S = up.getWorldPosition(new THREE.Vector3());
    const a = 0.29,
      b = 0.28;
    const toT = _v.copy(targetWorld).sub(S);
    let d = toT.length();
    d = Math.min(d, a + b - 0.001);
    const dir = toT.normalize();
    const cosA = (a * a + d * d - b * b) / (2 * a * d);
    const ang = Math.acos(THREE.MathUtils.clamp(cosA, -1, 1));
    // 肘部方向：朝向 pole 在垂直于 dir 平面上的投影
    const pole = _v2.copy(poleWorld).sub(S);
    pole.addScaledVector(dir, -pole.dot(dir)).normalize();
    const elbowDir = dir
      .clone()
      .multiplyScalar(Math.cos(ang))
      .addScaledVector(pole, Math.sin(ang))
      .normalize();
    const E = S.clone().addScaledVector(elbowDir, a);
    // 上臂
    const parentQ = up.parent.getWorldQuaternion(_q);
    const wq = _q2.setFromUnitVectors(DOWN, elbowDir);
    up.quaternion.copy(parentQ.invert().multiply(wq));
    up.updateMatrixWorld(true);
    const T2 = S.clone().addScaledVector(dir, d);
    const fdir = T2.sub(E).normalize();
    const pq = up.getWorldQuaternion(new THREE.Quaternion());
    fore.quaternion.copy(
      pq.invert().multiply(new THREE.Quaternion().setFromUnitVectors(DOWN, fdir)),
    );
  }
  // st: {speed, fwd, side, crouch, pitch, onGround, dead, t}
  update(dt, st) {
    const { _v } = this.scratch;
    const B = this.B;
    if (this.deadT >= 0) {
      this.updateDeath(dt);
      return;
    }
    this.crouchK += ((st.crouch ? 1 : 0) - this.crouchK) * Math.min(1, dt * 10);
    const ck = this.crouchK;
    const sp = st.speed;
    const moving = sp > 0.3 && st.onGround;
    this.phase += dt * (moving ? 2.2 + sp * 1.15 : 0) * (ck > 0.5 ? 0.7 : 1);
    const amp = moving ? Math.min(1, sp / 5) : 0;
    this.amp = (this.amp || 0) + (amp - (this.amp || 0)) * Math.min(1, dt * 8);
    const A = this.amp;
    this.reloadPhase = st.reloading ? (this.reloadPhase || 0) + dt : 0;
    const ph = this.phase;
    const back = st.fwd < -0.3 ? -1 : 1;
    // 腿
    const swing = Math.sin(ph) * 0.62 * A * back;
    const bendR = Math.max(0, Math.sin(ph + Math.PI * 0.5 * back)) * 1.0 * A;
    const bendL = Math.max(0, Math.sin(ph + Math.PI + Math.PI * 0.5 * back)) * 1.0 * A;
    let thR = swing,
      thL = -swing,
      shR = -bendR,
      shL = -bendL;
    // 下蹲
    thR = thR * (1 - ck) + (1.25 + swing * 0.3) * ck;
    thL = thL * (1 - ck) + (0.55 - swing * 0.3) * ck;
    shR = shR * (1 - ck) + -1.9 * ck;
    shL = shL * (1 - ck) + (-1.2 + Math.min(0, -swing)) * ck;
    if (!st.onGround) {
      thR = 0.7;
      thL = 0.25;
      shR = -1.1;
      shL = -0.6;
    }
    B.thighR.rotation.set(thR, 0, 0.02);
    B.thighL.rotation.set(thL, 0, -0.02);
    B.shinR.rotation.set(shR, 0, 0);
    B.shinL.rotation.set(shL, 0, 0);
    B.footR.rotation.set(-thR - shR - 0.0, 0, 0);
    B.footL.rotation.set(-thL - shL, 0, 0);
    if (ck > 0.01) {
      B.footL.rotation.x = 0.5 * ck + B.footL.rotation.x * (1 - ck);
    }
    // 髋部高度
    const bob = moving ? Math.abs(Math.cos(ph)) * 0.035 * A : 0;
    B.hips.position.y = 0.98 - ck * 0.38 - bob + (st.onGround ? 0 : 0.02);
    B.hips.position.z = ck * 0.08;
    B.hips.rotation.y = Math.sin(ph) * 0.08 * A;
    // 上身跟随俯仰
    const pitch = THREE.MathUtils.clamp(st.pitch, -1.2, 1.2);
    B.spine.rotation.set(pitch * 0.3 + ck * 0.15, -B.hips.rotation.y - 0.25, 0);
    B.chest.rotation.set(pitch * 0.45 - this.recoilK * 0.08, -0.12, 0);
    B.neck.rotation.set(pitch * 0.2, 0.3, 0);
    B.head.rotation.set(0, 0.05, 0);
    B.chest.rotation.x += this.flinchPitch;
    B.chest.rotation.z += this.flinchRoll;
    B.head.rotation.x += this.flinchHead;
    B.hips.position.y -= Math.abs(this.flinchPitch) * 0.08;
    this.flinchPitch *= Math.exp(-dt * 11);
    this.flinchRoll *= Math.exp(-dt * 10);
    this.flinchHead *= Math.exp(-dt * 13);
    this.recoilK *= Math.exp(-dt * 12);
    // 枪相对胸骨
    if (this.gun) {
      const sniper = this.gunType === 'awm',
        pistol = this.gunType === 'deagle',
        knife = this.gunType === 'knife' || this.gunType === 'he';
      const gx = pistol ? 0.03 : 0.1,
        gy = pistol ? 0.14 : 0.1,
        gz = pistol ? -0.42 : -0.3;
      this.gun.position.set(gx, gy + (st.reloading ? -0.08 : 0), gz + this.recoilK * 0.05);
      this.gun.rotation.set(st.reloading ? -0.5 : 0, 0.37, st.reloading ? 0.4 : 0);
      if (knife) {
        this.gun.position.set(0.18, 0.02, -0.28);
        this.gun.rotation.set(-0.3, 0.37, 0);
      }
      void sniper;
      this.mesh.updateMatrixWorld(true);
      const an = this.gun.userData.anchors;
      const grip = this.gun.localToWorld(_v.copy(an.grip || new THREE.Vector3()));
      const gW = grip.clone();
      const poleR = this.B.chest.localToWorld(new THREE.Vector3(0.6, -0.5, 0.1));
      this.solveArm('R', gW, poleR);
      if (an.fore && !knife) {
        const leftAnchor = st.reloading && an.magwell ? an.magwell : an.fore;
        const fw = this.gun.localToWorld(_v.copy(leftAnchor));
        if (st.reloading) fw.y -= 0.08 + Math.sin(this.reloadPhase * 4) * 0.06;
        const poleL = this.B.chest.localToWorld(new THREE.Vector3(-0.5, -0.6, 0.0));
        this.solveArm('L', fw, poleL);
      } else {
        B.upperArmL.rotation.set(0.3, 0, -0.15);
        B.forearmL.rotation.set(0.6, 0, 0);
      }
    }
    B.handR.rotation.set(0, 0, 0);
    B.handL.rotation.set(0, 0, 0);
  }
  kick() {
    this.recoilK = 1;
  }
  flinch(dir, part, amount = 20) {
    if (this.deadT >= 0) return;
    const yaw = this.root.rotation.y,
      strength = Math.min(0.24, Math.max(0.035, amount / 260));
    const fx = -Math.sin(yaw),
      fz = -Math.cos(yaw);
    const front = dir.x * fx + dir.z * fz,
      side = dir.x * Math.cos(yaw) - dir.z * Math.sin(yaw);
    this.flinchPitch = THREE.MathUtils.clamp(this.flinchPitch + front * strength, -0.28, 0.28);
    this.flinchRoll = THREE.MathUtils.clamp(this.flinchRoll - side * strength * 0.7, -0.2, 0.2);
    if (part === 'head')
      this.flinchHead = THREE.MathUtils.clamp(this.flinchHead - strength * 1.5, -0.38, 0.38);
    this.invFrame = -1;
  }
  die(dirX, dirZ, headshot) {
    this.deadT = 0;
    // 倒地方向：沿子弹方向
    const fwd = new THREE.Vector3(
      -Math.sin(this.root.rotation.y),
      0,
      -Math.cos(this.root.rotation.y),
    );
    const dot = fwd.x * dirX + fwd.z * dirZ;
    this.fallDir = dot > 0 ? 1 : -1; // 被从背后打 -> 向前倒
    this.fallSide = (this.random() - 0.5) * 0.8;
    this.fallSpeed = headshot ? 1.4 : 1;
    this.limbR = [this.random(), this.random(), this.random(), this.random()];
    this.opacity = 1;
  }
  updateDeath(dt) {
    const B = this.B;
    this.deadT += dt;
    const t = Math.min(1, this.deadT * 1.6 * this.fallSpeed);
    const e = t * t; // 重力加速
    const ang = e * Math.PI * 0.5 * 0.96;
    this.mesh.rotation.x = -this.fallDir * ang;
    this.mesh.rotation.z = this.fallSide * e;
    B.hips.position.y = 0.98 - Math.sin(t * Math.PI) * 0.25 - t * 0.3;
    const r = this.limbR;
    const k = Math.min(1, this.deadT * 3);
    B.upperArmR.rotation.x += ((r[0] * 2 - 1) * 1.5 - B.upperArmR.rotation.x) * k * 0.2;
    B.upperArmL.rotation.x += ((r[1] * 2 - 1) * 1.5 - B.upperArmL.rotation.x) * k * 0.2;
    B.forearmR.rotation.set(0.3 * r[2], 0, 0);
    B.forearmL.rotation.set(0.4 * r[3], 0, 0);
    B.thighR.rotation.x *= 0.9;
    B.thighL.rotation.x += (0.4 * r[2] - B.thighL.rotation.x) * 0.1;
    B.shinR.rotation.x *= 0.9;
    B.shinL.rotation.x *= 0.9;
    B.spine.rotation.x *= 0.9;
    B.chest.rotation.x *= 0.9;
    B.neck.rotation.x += (0.3 * this.fallDir - B.neck.rotation.x) * 0.1;
    if (this.deadT > 4.5) {
      this.opacity = Math.max(0, 1 - (this.deadT - 4.5) / 1.2);
      this.root.position.y -= dt * 0.15;
    }
  }
  reset() {
    this.deadT = -1;
    this.mesh.rotation.set(0, 0, 0);
    this.flinchPitch = this.flinchRoll = this.flinchHead = this.recoilK = 0;
    this.opacity = 1;
  }
  // 射线命中测试，返回 {t, part}
  hitTest(o, d, maxT, frame) {
    const { _v } = this.scratch;
    // 粗检：到髋部的距离
    const hp = this.B.hips.getWorldPosition(_v);
    const wx = hp.x - o.x,
      wy = hp.y + 0.3 - o.y,
      wz = hp.z - o.z;
    const tc = wx * d.x + wy * d.y + wz * d.z;
    if (tc < -1.5 || tc > maxT + 1.5) return null;
    const px = wx - d.x * tc,
      py = wy - d.y * tc,
      pz = wz - d.z * tc;
    if (px * px + py * py + pz * pz > 1.6) return null;
    if (this.invFrame !== frame) {
      this.mesh.updateMatrixWorld(true);
      HITBOXES.forEach((h, i) => this.invs[i].copy(this.B[h[0]].matrixWorld).invert());
      this.invFrame = frame;
    }
    let best = maxT,
      part = null;
    const lo = new THREE.Vector3(),
      ld = new THREE.Vector3();
    for (let i = 0; i < HITBOXES.length; i++) {
      const [, cx, cy, cz, hx, hy, hz, name] = HITBOXES[i];
      lo.copy(o).applyMatrix4(this.invs[i]);
      ld.copy(d).transformDirection(this.invs[i]);
      const ox = lo.x - cx,
        oy = lo.y - cy,
        oz = lo.z - cz;
      let tmin = 0,
        tmax = best;
      const slab = (oo, dd, h) => {
        if (Math.abs(dd) < 1e-9) return oo >= -h && oo <= h;
        let t1 = (-h - oo) / dd,
          t2 = (h - oo) / dd;
        if (t1 > t2) {
          const tt = t1;
          t1 = t2;
          t2 = tt;
        }
        tmin = Math.max(tmin, t1);
        tmax = Math.min(tmax, t2);
        return tmin <= tmax;
      };
      if (slab(ox, ld.x, hx) && slab(oy, ld.y, hy) && slab(oz, ld.z, hz) && tmin < best) {
        best = tmin;
        part = name;
      }
    }
    return part ? { t: best, part } : null;
  }
  muzzleWorld(out) {
    const { _v } = this.scratch;
    if (!this.gun) return this.B.head.getWorldPosition(out);
    return this.gun.localToWorld(out.copy(this.gun.userData.anchors.muzzle || _v.set(0, 0, -0.5)));
  }
  headWorld(out) {
    return this.B.head.localToWorld(out.set(0, 0.1, 0));
  }
  chestWorld(out) {
    return this.B.chest.localToWorld(out.set(0, 0.1, 0));
  }
}
