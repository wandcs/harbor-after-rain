// 运输船地图构建
// 坐标：X 沿船长方向（-X 船尾/上层建筑/潜伏者出生点，+X 船头/保卫者出生点），Z 沿船宽，Y 向上，甲板 Y=0，海面 Y=-7.5
import * as THREE from 'three';
import {createSurfaceMaterials} from './surface-materials.js';
import {createPropBuilders} from './props.js';
import { SIGN_UV, mulberry32 } from './textures.js';

import {createShipLayout,CH,CW,L20,L40,MAP_BOUNDS} from './sim/maps/ship-layout.js';
export {CH,CW,L20,L40,SEA_Y,DECK_HALF_Z,H2,MAP_BOUNDS,NAV_BOUNDS} from './sim/maps/ship-layout.js';
const HULL_HALF_Z = 18.25;

const FACE = {
  px: { n: [1, 0, 0], u: [0, 0, -1], v: [0, 1, 0] },
  nx: { n: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0] },
  py: { n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, -1] },
  ny: { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
  pz: { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
  nz: { n: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0] },
};

// 按材质合批的几何缓冲
class Batch {
  constructor() { this.p = []; this.n = []; this.uv = []; this.idx = []; this.count = 0; }
  quad(v0, v1, v2, v3, nrm, uvs) {
    const b = this.count;
    this.p.push(...v0, ...v1, ...v2, ...v3);
    for (let i = 0; i < 4; i++) this.n.push(nrm[0], nrm[1], nrm[2]);
    this.uv.push(...uvs);
    this.idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
    this.count += 4;
  }
  geom(g, m4) {
    const gi = g.index ? g : g;
    const pos = gi.attributes.position, nor = gi.attributes.normal, uv = gi.attributes.uv;
    const b = this.count;
    const v = new THREE.Vector3(), nn = new THREE.Vector3();
    const nm = new THREE.Matrix3().getNormalMatrix(m4);
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m4);
      this.p.push(v.x, v.y, v.z);
      nn.fromBufferAttribute(nor, i).applyMatrix3(nm).normalize();
      this.n.push(nn.x, nn.y, nn.z);
      if (uv) this.uv.push(uv.getX(i), uv.getY(i)); else this.uv.push(0, 0);
    }
    if (gi.index) for (let i = 0; i < gi.index.count; i++) this.idx.push(b + gi.index.getX(i));
    else for (let i = 0; i < pos.count; i++) this.idx.push(b + i);
    this.count += pos.count;
  }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setIndex(this.count > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere(); g.computeBoundingBox();
    return g;
  }
}

export function buildMap(scene, T, world, opts = {}) {
  const rnd = mulberry32(2024);
  const batches = new Map();
  const matDefs = {};
  const footprints = []; // 用于烘焙甲板 AO
  const lampSpots = [];
  const anim = [];

  Object.assign(matDefs, createSurfaceMaterials(T));
  if (opts.materialsOnly) return { materials: matDefs };

  const batch = (key) => {
    let b = batches.get(key);
    if (!b) { b = new Batch(); batches.set(key, b); }
    return b;
  };

  // ---------- 几何工具 ----------
  // 盒子：faces 为 {px,nx,py,ny,pz,nz: matKey|null} 或单一 matKey
  function box(cx, cy, cz, sx, sy, sz, yaw, faces, uvOff) {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const half = [sx / 2, sy / 2, sz / 2], size = [sx, sy, sz];
    const off = uvOff ?? [rnd(), rnd()];
    for (const fk in FACE) {
      const key = typeof faces === 'string' ? faces : faces[fk];
      if (!key) continue;
      const F = FACE[fk], def = matDefs[key];
      const su = Math.abs(F.u[0] * size[0] + F.u[1] * size[1] + F.u[2] * size[2]);
      const sv = Math.abs(F.v[0] * size[0] + F.v[1] * size[1] + F.v[2] * size[2]);
      const ctr = [F.n[0] * half[0], F.n[1] * half[1], F.n[2] * half[2]];
      const corner = (a, b) => {
        const lx = ctr[0] + F.u[0] * su * a + F.v[0] * sv * b;
        const ly = ctr[1] + F.u[1] * su * a + F.v[1] * sv * b;
        const lz = ctr[2] + F.u[2] * su * a + F.v[2] * sv * b;
        return [cx + c * lx + s * lz, cy + ly, cz - s * lx + c * lz];
      };
      const n = [c * F.n[0] + s * F.n[2], F.n[1], -s * F.n[0] + c * F.n[2]];
      let u0 = 0, v0 = 0, u1 = 1, v1 = 1;
      if (def.uv !== 'unit' && def.uv !== 'custom') {
        const tu = Array.isArray(def.uv) ? def.uv[0] : def.uv, tv = Array.isArray(def.uv) ? def.uv[1] : def.uv;
        u0 = off[0]; v0 = Array.isArray(def.uv) ? 0 : off[1];
        u1 = u0 + su / tu; v1 = v0 + sv / tv;
      }
      batch(key).quad(corner(-0.5, -0.5), corner(0.5, -0.5), corner(0.5, 0.5), corner(-0.5, 0.5), n, [u0, v0, u1, v0, u1, v1, u0, v1]);
    }
  }
  let renderingLayout = false;
  function solid(cx, cy, cz, sx, sy, sz, yaw, props = {}) {
    if (renderingLayout) return;
    return world.add({ x: cx, y: cy, z: cz, sx, sy, sz, yaw, ...props });
  }
  function foot(cx, cz, sx, sz, yaw, dark = 0.6) { footprints.push({ cx, cz, sx, sz, yaw, dark }); }
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), vs = new THREE.Vector3(1, 1, 1);
  function geom(key, g, x, y, z, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
    e.set(rx, ry, rz); q.setFromEuler(e); vs.set(sx, sy, sz);
    m4.compose(new THREE.Vector3(x, y, z), q, vs);
    batch(key).geom(g, m4);
  }
  // 两点之间的圆柱
  const up = new THREE.Vector3(0, 1, 0);
  function rod(key, x0, y0, z0, x1, y1, z1, r) {
    const d = new THREE.Vector3(x1 - x0, y1 - y0, z1 - z0); const L = d.length(); d.normalize();
    q.setFromUnitVectors(up, d); vs.set(r, L, r);
    m4.compose(new THREE.Vector3((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2), q, vs);
    batch(key).geom(cylG8, m4);
  }
  // 自定义 UV 的矩形贴片（标识牌）
  function decal(key, cx, cy, cz, w, h, yaw, pitch, rect, texW = 1024) {
    const c = Math.cos(yaw), s = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
    // 局部：u 沿 +X，v 沿 +Y，法线 +Z；先绕 X 俯仰再绕 Y 偏航
    const tr = (lx, ly) => {
      const y1 = ly * cp, z1 = ly * sp;
      return [cx + c * lx + s * z1, cy + y1, cz - s * lx + c * z1];
    };
    const nz = [s * cp, -sp, c * cp];
    const [rx, ry, rw, rh] = rect;
    const u0 = rx / texW, u1 = (rx + rw) / texW, v1 = 1 - ry / texW, v0 = 1 - (ry + rh) / texW;
    batch(key).quad(tr(-w / 2, -h / 2), tr(w / 2, -h / 2), tr(w / 2, h / 2), tr(-w / 2, h / 2), nz, [u0, v0, u1, v0, u1, v1, u0, v1]);
  }

  // ---------- 预制件 ----------
  const cylG = new THREE.CylinderGeometry(1, 1, 1, 16, 1);
  const cylG8 = new THREE.CylinderGeometry(1, 1, 1, 8, 1);
  const sphG = new THREE.SphereGeometry(1, 10, 8);
  const torG = new THREE.TorusGeometry(0.32, 0.07, 8, 20);

  const {container,corrugatedWall,crate,barrel,railing,fence,lamp,lifeRing}=createPropBuilders({T,box,solid,foot,geom,rod,rnd,batch,matDefs,lampSpots,cylG,cylG8,sphG,torG,geometryDetail:opts.geometryDetail!==false});
  function finishBatches() {
    const meshes=[];
    for(const [key,b] of batches){if(!b.count)continue;const def=matDefs[key],mesh=new THREE.Mesh(b.build(),def.mat);mesh.castShadow=def.shadow!==false;mesh.receiveShadow=true;mesh.matrixAutoUpdate=false;mesh.updateMatrix();mesh.name=key;if(def.alpha)mesh.customDepthMaterial=new THREE.MeshDepthMaterial({depthPacking:THREE.RGBADepthPacking,map:def.mat.map,alphaTest:.5});scene.add(mesh);meshes.push(mesh);}
    // Batch owns copies; dispose the temporary primitive buffers.
    for(const geo of [cylG,cylG8,sphG,torG])geo.dispose();
    return meshes;
  }
  if(opts.showcase==='props'){
    box(0,-.2,0,34,.4,25,0,'deck');solid(0,-.2,0,34,.4,25,0,{mat:'deck',tag:'deck',navSurface:true});
    container(-5,-3,0,20,0);container(4,-3,0,20,3);
    crate(-7,3,1.2,1.1,1.1,1);crate(-5.5,3,1,1.5,1,2);
    barrel(-2,3,'red');barrel(-.9,3,'yellow');barrel(.2,3,'green');
    railing(3,3,7,3);fence(3,5,7,5,0,2);lamp(8,3,2,true);lifeRing(8,1.4,2,0);
    const meshes=finishBatches();world.build();
    return {materials:matDefs,meshes,lampSpots,update(){},galleryCount:10};
  }

  // ================== 甲板与边界 ==================
  // 甲板：按船体轮廓生成
  {
    const pts = [];
    for (let i = 0; i < 160; i++) { const [x, z] = hullContour(i / 160, 1, 1); pts.push(new THREE.Vector2(x, -z)); }
    const sg = new THREE.ShapeGeometry(new THREE.Shape(pts));
    sg.rotateX(-Math.PI / 2);
    const pos = sg.attributes.position, uv = sg.attributes.uv;
    const uv1 = new Float32Array(pos.count * 2);
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      uv.setXY(i, x / 4, -z / 4);
      uv1[i * 2] = (x - MAP_BOUNDS.minX) / 74; uv1[i * 2 + 1] = 1 - (z - MAP_BOUNDS.minZ) / 36.6;
    }
    sg.setAttribute('uv1', new THREE.BufferAttribute(uv1, 2));
    sg.computeVertexNormals();
    const deckMesh = new THREE.Mesh(sg, matDefs.deck.mat);
    deckMesh.receiveShadow = true; deckMesh.name = 'deck';
    scene.add(deckMesh);
  }
  const layout = createShipLayout({crateKinds:T.crates.map(crate => crate.kind),containerCount:T.containers.length});
  for (const collider of layout.colliders) world.add(collider);
  const primitives = {cylG,cylG8,sphG,torG};
  const draw = {box,foot,rod,container,corrugatedWall,crate,barrel,railing,fence,lamp,lifeRing,
    geom(key,primitive,...args) { geom(key,primitives[primitive],...args); },
    decal(...args) { if (typeof args[8] === 'string') args[8] = SIGN_UV[args[8]]; decal(...args); },
  };
  renderingLayout = true;
  for (const operation of layout.operations) draw[operation.kind](...operation.args);
  renderingLayout = false;

  // 前桅
  geom('white', cylG, 64, 8, 0, 0, 0, 0, 0.35, 16, 0.35);
  geom('white', cylG8, 64, 13, 0, 0, 0, Math.PI / 2, 0.08, 6, 0.08);
  geom('redLamp', sphG, 64, 16.3, 0, 0, 0, 0, 0.2, 0.2, 0.2);

  // ================== 上层建筑（潜伏者背后） ==================
  const sx0 = -56, sx1 = -36.7, sw = 11.2;
  for (let lvl = 0; lvl < 5; lvl++) {
    const y0 = lvl * 3, inset = lvl * 0.4;
    const x1 = sx1 - (lvl > 3 ? 1.5 : 0);
    const wz = sw - (lvl === 4 ? 0 : 0) + (lvl === 4 ? 3 : 0);
    box((sx0 + x1) / 2, y0 + 1.5, 0, x1 - sx0 - inset, 3, wz * 2, 0, { px: 'superWall', pz: 'superWall', nz: 'superWall', nx: 'superWall' }, [0, 0]);
    box((sx0 + x1) / 2, y0 + 3 - 0.08, 0, x1 - sx0 - inset + 0.6, 0.16, wz * 2 + 0.6, 0, 'white');
    if (lvl < 4) {
      // 每层前方走廊栏杆
      railing(x1 + 0.3, -wz, x1 + 0.3, wz, y0 + 3, 'railWhite', 1.0, false);
    }
  }
  box((sx0 + sx1) / 2, 15.1, 0, sx1 - sx0 - 1, 0.2, 29, 0, 'white');
  decal('signs', sx1 - 1.49, 13.3, 0, 12, 1.9, Math.PI / 2, 0, SIGN_UV.shipname);
  // 驾驶台窗户带（黑玻璃）
  box(sx1 - 1.52, 13.4, 0, 0.05, 1.3, 26, 0, 'black');
  // 烟囱
  const fx = -51;
  box(fx, 20, 0, 5, 10, 4.2, 0, { px: 'white', nx: 'white', pz: 'white', nz: 'white', py: 'black' });
  box(fx, 22.5, 0, 5.05, 1.6, 4.25, 0, { px: 'red', nx: 'red', pz: 'red', nz: 'red' });
  box(fx, 24.8, 0, 5.1, 0.6, 4.3, 0, 'black');
  const funnelTop = new THREE.Vector3(fx, 25.3, 0);
  // 雷达桅
  geom('white', cylG, -45, 18.5, 0, 0, 0, 0, 0.18, 7, 0.18);
  box(-45, 21.5, 0, 0.3, 0.3, 4, 0, 'white');
  const radar = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.18, 3.2), matDefs.white.mat);
  radar.position.set(-45, 22.4, 0); radar.castShadow = true; scene.add(radar);
  anim.push((dt) => { radar.rotation.y += dt * 1.6; });
  geom('redLamp', sphG, -45, 22.1, 1.9, 0, 0, 0, 0.12, 0.12, 0.12);
  geom('greenLamp', sphG, -45, 22.1, -1.9, 0, 0, 0, 0.12, 0.12, 0.12);
  // 救生艇（橙色）
  for (const sz of [-1, 1]) {
    const lb = new THREE.CapsuleGeometry(1.1, 5.2, 4, 12);
    geom('orange', lb, -46, 7.2, sz * 12.4, 0, 0, Math.PI / 2, 1, 1, 1);
    box(-46, 8.15, sz * 12.4, 6, 0.3, 1.6, 0, 'white');
    for (const dx of [-2.6, 2.6]) geom('white', cylG8, -46 + dx, 7.8, sz * 11.8, sz * 0.5, 0, 0, 0.08, 3, 0.08);
  }
  // 上层建筑前门
  for (const dz of [-6, 6]) box(sx1 + 0.02, 1.1, dz, 0.06, 2.2, 1.1, 0, 'darkSteel');

  // ================== 吊机 ==================
  function crane(px, pz, yawDeg, luff, jibLen, tipHook) {
    const yaw = yawDeg * Math.PI / 180;
    const g = new THREE.Group();
    g.position.set(px, 6, pz); g.rotation.y = yaw;
    const cab = new THREE.Mesh(new THREE.BoxGeometry(3.2, 2.6, 2.6), matDefs.yellow.mat); cab.position.set(-0.4, 1.3, 0);
    const win = new THREE.Mesh(new THREE.BoxGeometry(0.05, 1, 1.8), matDefs.black.mat); win.position.set(1.21, 1.6, 0);
    const jibPivot = new THREE.Group(); jibPivot.position.set(0.8, 1.8, 0); jibPivot.rotation.z = luff;
    const jibGeo = new THREE.BoxGeometry(jibLen, 0.7, 0.9); jibGeo.translate(jibLen / 2, 0, 0);
    const jib = new THREE.Mesh(jibGeo, matDefs.yellow.mat);
    const jib2Geo = new THREE.BoxGeometry(jibLen * 0.98, 0.12, 1.3); jib2Geo.translate(jibLen / 2, 0.4, 0);
    const jib2 = new THREE.Mesh(jib2Geo, matDefs.yellow.mat);
    jibPivot.add(jib, jib2);
    g.add(cab, win, jibPivot);
    g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    scene.add(g);
    g.updateMatrixWorld(true);
    const tip = new THREE.Vector3(jibLen, 0, 0);
    jibPivot.localToWorld(tip);
    return tip;
  }
  const tipA = crane(-33, -9.6, -12, 0.36, 30, true);
  crane(33, 9.6, 168, 0.95, 22, false);
  // 吊着的集装箱（随风轻摆）
  const hang = new THREE.Group();
  const hc = new THREE.Mesh(new THREE.BoxGeometry(L20, CH, CW), [
    matDefs.c5door.mat, matDefs.c5door.mat, matDefs.c5roof.mat, matDefs.c5roof.mat, matDefs.c5s20.mat, matDefs.c5s20.mat]);
  hc.castShadow = true; hc.receiveShadow = true;
  const cableLen = tipA.y - 12;
  hc.position.y = -cableLen - CH / 2 - 0.4;
  const spreader = new THREE.Mesh(new THREE.BoxGeometry(L20 - 0.2, 0.25, CW - 0.2), matDefs.yellow.mat);
  spreader.position.y = -cableLen - 0.2;
  const cableGeo = new THREE.CylinderGeometry(0.03, 0.03, cableLen, 4); cableGeo.translate(0, -cableLen / 2, 0);
  for (const dx of [-0.25, 0.25]) { const cb = new THREE.Mesh(cableGeo, matDefs.black.mat); cb.position.x = dx; hang.add(cb); }
  hang.add(hc, spreader);
  hang.position.copy(tipA);
  scene.add(hang);
  anim.push((dt, t) => {
    hang.rotation.z = Math.sin(t * 0.55) * 0.018;
    hang.rotation.x = Math.sin(t * 0.4 + 1) * 0.012;
    hc.rotation.y = Math.sin(t * 0.21) * 0.1;
  });

  // ================== 船体 ==================
  buildHull(scene, matDefs.hull.mat);

  // ================== 生成合批网格 ==================
  const meshes = finishBatches();
  // 甲板 AO 烘焙
  const ao = opts.skipAO ? null : bakeDeckAO(footprints);
  matDefs.deck.mat.aoMap = ao; matDefs.deck.mat.aoMapIntensity = 1; matDefs.deck.mat.lightMap = null;
  matDefs.deck.mat.needsUpdate = true;
  matDefs.paintY.mat.aoMap = null;

  world.build();

  const {operations,colliders,...metadata} = layout;
  void operations; void colliders;

  return {
    ...metadata, lampSpots, funnelTop, meshes, materials:matDefs,
    update(dt,t) { for (const f of anim) f(dt,t); },
  };
}

// 甲板环境光遮蔽：把所有落地物体的投影模糊后作为 aoMap
function bakeDeckAO(fps) {
  const W = 2048, H = 1014; // 74m x 36.6m
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
  const sx = W / 74, sz = H / 36.6;
  const draw = (blur, grow, alphaMul) => {
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,1)'; ctx.shadowBlur = blur; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0;
    for (const f of fps) {
      ctx.save();
      ctx.translate((f.cx + 37) * sx, (f.cz + 18.3) * sz);
      ctx.rotate(-f.yaw); // 画布 y 向下 = +Z
      ctx.fillStyle = `rgba(0,0,0,${f.dark * alphaMul})`;
      ctx.fillRect(-(f.sx / 2 + grow) * sx, -(f.sz / 2 + grow) * sz, (f.sx + grow * 2) * sx, (f.sz + grow * 2) * sz);
      ctx.restore();
    }
    ctx.restore();
  };
  draw(40, 0.1, 0.35);
  draw(12, 0.02, 0.45);
  // 管道内部较暗
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect((-29.5 + 37) * sx, (9.4 + 18.3) * sz, 36.6 * sx, 2.44 * sz);
  ctx.fillRect((29.5 - 36.6 + 37) * sx, (-11.84 + 18.3) * sz, 36.6 * sx, 2.44 * sz);
  const t = new THREE.CanvasTexture(c);
  t.channel = 1;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

// 船体轮廓：t∈[0,1) 沿边界一周；右舷(0..0.35) 船头(0.35..0.5) 左舷(0.5..0.85) 船尾(0.85..1)
export function hullContour(t, sc, bowK) {
  const halfW = HULL_HALF_Z * sc;
  const xs = -66, xb0 = 58, xb1 = 58 + 28 * bowK;
  if (t < 0.35) { const k = t / 0.35; return [xs + (xb0 - xs) * k, halfW]; }
  if (t < 0.5) {
    const a = ((t - 0.35) / 0.15) * Math.PI;
    return [xb0 + (xb1 - xb0) * Math.sin(a) ** 0.8, halfW * Math.cos(a) * (1 - 0.1 * Math.sin(a))];
  }
  if (t < 0.85) { const k = (t - 0.5) / 0.35; return [xb0 + (xs - xb0) * k, -halfW]; }
  const a = ((t - 0.85) / 0.15) * Math.PI;
  return [xs - 3 * Math.sin(a) * sc, -halfW * Math.cos(a)];
}

// 程序生成船体：多层轮廓环
function buildHull(scene, mat) {
  const rings = [
    { y: 0.12, s: 1.0, bow: 1.0 }, { y: -0.4, s: 1.0, bow: 1.0 }, { y: -2.5, s: 0.995, bow: 0.97 },
    { y: -5, s: 0.985, bow: 0.93 }, { y: -7.5, s: 0.965, bow: 0.88 }, { y: -9.5, s: 0.93, bow: 0.82 },
    { y: -12, s: 0.85, bow: 0.74 },
  ];
  const N = 120;
  const contour = hullContour;
  const pos = [], uv = [], idx = [];
  const lens = [];
  for (let r = 0; r < rings.length; r++) {
    const R = rings[r];
    let acc = 0, prev = null;
    for (let i = 0; i <= N; i++) {
      const [x, z] = contour((i % N) / N, R.s, R.bow);
      if (prev) acc += Math.hypot(x - prev[0], z - prev[1]);
      prev = [x, z];
      pos.push(x, R.y, z);
      uv.push(acc / 16, (R.y + 12) / 13.5);
    }
    lens.push(acc);
  }
  const row = N + 1;
  for (let r = 0; r < rings.length - 1; r++) for (let i = 0; i < N; i++) {
    const a = r * row + i, b = a + 1, c = a + row, d = c + 1;
    idx.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, mat);
  mat.side = THREE.DoubleSide;
  m.receiveShadow = true;
  scene.add(m);
  return m;
}
