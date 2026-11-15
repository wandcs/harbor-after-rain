// 第三人称士兵：刚性蒙皮 + 程序动画 + 骨骼命中盒
import * as THREE from 'three';
import { buildGunMerged } from './guns.js';
import { fbm, normalFromHeight } from './textures.js';
import { CharacterPose, BONES } from './sim/character-pose.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

let ATLAS = null, ATLAS_ROUGH = null, ATLAS_METAL = null, ATLAS_NORMAL = null;
function atlas() {
  if (ATLAS) return ATLAS;
  const W = 512, H = 128;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  const n = fbm(W, H, 16, 4, 4, 91);
  const img = ctx.createImageData(W, H), d = img.data;
  const camo = fbm(W, H, 8, 2, 3, 92), camo2 = fbm(W, H, 8, 2, 3, 93);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    let v;
    if (x < 128) { // 布料纹理
      const weave = ((x + y) % 3 === 0 ? 0.92 : 1) * ((x - y + 300) % 4 === 0 ? 0.94 : 1);
      v = (0.82 + n[i] * 0.3) * weave;
    } else if (x < 256) { // 数码迷彩
      const qx = Math.floor(x / 4) * 4, qy = Math.floor(y / 4) * 4, qi = qy * W + qx;
      const a = camo[qi], b = camo2[qi];
      v = a > 0.56 ? 0.55 : b > 0.58 ? 1.25 : a < 0.42 ? 0.8 : 1.0;
      v *= 0.92 + n[i] * 0.15;
    } else v = 0.93 + n[i] * 0.12;
    const g = Math.min(255, v * 200);
    d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = g; d[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  const roughData = new Uint8Array(W*H*4), metalData = new Uint8Array(W*H*4);
  for(let y=0;y<H;y++)for(let x=0;x<W;x++){
    const i=y*W+x, kind=x<256?'cloth':x<320?'polymer':x<384?'metal':x<448?'glass':'skin';
    const rough=kind==='cloth'?.92:kind==='polymer'?.66:kind==='metal'?.35:kind==='glass'?.15:.75;
    const metal=kind==='metal'?.82:kind==='glass'?.48:.025;
    const r=Math.round(Math.max(.08,Math.min(1,rough+(n[i]-.5)*.11))*255),m=Math.round(metal*255);
    roughData.set([r,r,r,255],i*4);metalData.set([m,m,m,255],i*4);
  }
  ATLAS_ROUGH=new THREE.DataTexture(roughData,W,H);ATLAS_ROUGH.needsUpdate=true;
  ATLAS_METAL=new THREE.DataTexture(metalData,W,H);ATLAS_METAL.needsUpdate=true;
  ATLAS_NORMAL=new THREE.CanvasTexture(normalFromHeight(n,W,H,.7));
  for(const texture of[ATLAS_ROUGH,ATLAS_METAL,ATLAS_NORMAL]){texture.minFilter=THREE.LinearMipmapLinearFilter;texture.magFilter=THREE.LinearFilter;texture.generateMipmaps=true;}
  ATLAS = t;
  return t;
}

const OUTFIT = {
  BL: {
    pants: [0x2c2d31, 'fab'], jacket: [0x1f2124, 'fab'], vest: [0x2e3128, 'fab'], pouch: [0x3a3d30, 'fab'],
    boots: [0x141414, 'plain'], gloves: [0x18181a, 'plain'], skin: [0xb88c6c, 'skin'], mask: [0x151618, 'fab'],
    head: [0x151618, 'fab'], band: [0xa3161a, 'plain'], armband: [0xb01c1c, 'plain'], goggles: [0x1a1a1a, 'plain'], lens: [0x744c30, 'glass'],
    pads: [0x30383a, 'plain'], metal: [0x5f6869, 'metal'], stitch: [0x656a5e, 'fab'],
  },
  GR: {
    pants: [0x5e6b7c, 'camo'], jacket: [0x566478, 'camo'], vest: [0x27344a, 'fab'], pouch: [0x2e3c52, 'fab'],
    boots: [0x16161a, 'plain'], gloves: [0x1c1d20, 'plain'], skin: [0xc49a7a, 'skin'], mask: [0x202328, 'fab'],
    head: [0x33404f, 'plain'], band: [0x1a1a1a, 'plain'], armband: [0x1f62c8, 'plain'], goggles: [0x151515, 'plain'], lens: [0x597b88, 'glass'],
    pads: [0x354751, 'plain'], metal: [0x65747a, 'metal'], stitch: [0x86918f, 'fab'],
  },
};

const BI = Object.fromEntries(BONES.map((b, i) => [b[0], i]));

function bindPositions() {
  const out = [];
  for (const [, p, x, y, z] of BONES) {
    const v = new THREE.Vector3(x, y, z);
    if (p >= 0) v.add(out[p]);
    out.push(v);
  }
  return out;
}

// 构建带蒙皮属性的合并几何
const GEO_CACHE = {};
function buildGeometry(team, low = false) {
  const key = `${team}:${low ? 'low' : 'high'}`;
  if (GEO_CACHE[key]) return GEO_CACHE[key];
  const O = OUTFIT[team];
  const bp = bindPositions();
  const parts = [];
  const add = (geo, bone, colorKey, x, y, z, rx = 0, ry = 0, rz = 0) => {
    const g = geo.clone();
    const m = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(1, 1, 1));
    g.applyMatrix4(m);
    const [col, kind] = O[colorKey];
    const n = g.attributes.position.count;
    const color = new THREE.Color(col);
    const cols = new Float32Array(n * 3), si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
    const uvs = new Float32Array(n * 2);
    const ranges = {fab:[.015,.23],camo:[.26,.23],plain:[.51,.105],metal:[.635,.105],glass:[.76,.105],skin:[.885,.105]};
    const [u0,uw] = ranges[kind] || ranges.plain;
    const src = g.attributes.uv;
    for (let i = 0; i < n; i++) {
      cols[i * 3] = color.r; cols[i * 3 + 1] = color.g; cols[i * 3 + 2] = color.b;
      si[i * 4] = BI[bone]; sw[i * 4] = 1;
      const su = src ? src.getX(i) : 0.5, sv = src ? src.getY(i) : 0.5;
      uvs[i * 2] = u0 + THREE.MathUtils.clamp(su,0,1) * uw; uvs[i * 2 + 1] = 0.05 + THREE.MathUtils.clamp(sv,0,1) * 0.9;
    }
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', g.attributes.position);
    out.setAttribute('normal', g.attributes.normal);
    out.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    out.setAttribute('color', new THREE.BufferAttribute(cols, 3));
    out.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
    out.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
    if (g.index) out.setIndex(g.index);
    parts.push(out.index ? out.toNonIndexed() : out);
  };
  const cap = (r, l) => new THREE.CapsuleGeometry(r, l, low ? 2 : 3, low ? 6 : 10);
  const box = (w, h, d) => low ? new THREE.BoxGeometry(w, h, d) : new RoundedBoxGeometry(w, h, d, 1, Math.min(.014,Math.min(w,h,d)*.16));
  const sph = (r) => new THREE.SphereGeometry(r, low ? 8 : 14, low ? 6 : 10);
  const P = (name) => bp[BI[name]];
  // 腿
  for (const s of ['R', 'L']) {
    const sx = s === 'R' ? 1 : -1;
    const th = P('thigh' + s), sh = P('shin' + s), ft = P('foot' + s);
    add(cap(0.085, 0.3), 'thigh' + s, 'pants', th.x, th.y - 0.2, th.z);
    add(cap(0.068, 0.32), 'shin' + s, 'pants', sh.x, sh.y - 0.2, sh.z);
    add(box(0.12, 0.14, 0.1), 'shin' + s, 'pads', sh.x, sh.y - 0.02, sh.z - 0.06);
    add(box(0.12, 0.13, 0.27), 'foot' + s, 'boots', ft.x, ft.y + 0.03, ft.z - 0.05);
    add(box(0.11, 0.1, 0.14), 'shin' + s, 'boots', sh.x, sh.y - 0.38, sh.z);
    add(box(0.07, 0.1, 0.1), 'thigh' + s, 'pouch', th.x + sx * 0.08, th.y - 0.18, th.z);
  }
  // 躯干
  const hp = P('hips'), sp = P('spine'), ch = P('chest');
  add(box(0.36, 0.22, 0.24), 'hips', 'pants', hp.x, hp.y - 0.02, hp.z);
  add(box(0.38, 0.06, 0.26), 'hips', 'band', hp.x, hp.y + 0.08, hp.z);
  add(box(0.33, 0.22, 0.22), 'spine', 'jacket', sp.x, sp.y + 0.1, sp.z);
  add(box(0.4, 0.3, 0.25), 'chest', 'jacket', ch.x, ch.y + 0.1, ch.z);
  add(box(0.42, 0.34, 0.29), 'chest', 'vest', ch.x, ch.y + 0.06, ch.z);
  for (let i = 0; i < 3; i++) add(box(0.085, 0.11, 0.05), 'chest', 'pouch', ch.x - 0.1 + i * 0.1, ch.y - 0.02, ch.z - 0.16);
  add(box(0.3, 0.34, 0.12), 'chest', 'pouch', ch.x, ch.y + 0.05, ch.z + 0.19); // 背包
  add(box(0.03, 0.25, 0.03), 'chest', 'goggles', ch.x + 0.1, ch.y + 0.32, ch.z + 0.2); // 天线
  // 头
  const nk = P('neck'), hd = P('head');
  add(cap(0.055, 0.06), 'neck', 'skin', nk.x, nk.y + 0.04, nk.z);
  const headG = sph(0.108); headG.scale(0.95, 1.12, 1.02);
  add(headG, 'head', 'skin', hd.x, hd.y + 0.09, hd.z);
  if (team === 'GR') {
    const helm = new THREE.SphereGeometry(0.128, low ? 10 : 16, low ? 6 : 10, 0, Math.PI * 2, 0, Math.PI * 0.55); helm.scale(1, 0.95, 1.08);
    add(helm, 'head', 'head', hd.x, hd.y + 0.12, hd.z + 0.005);
    add(box(0.23, 0.05, 0.05), 'head', 'goggles', hd.x, hd.y + 0.155, hd.z - 0.1);
    add(box(0.18, 0.035, 0.02), 'head', 'lens', hd.x, hd.y + 0.155, hd.z - 0.125);
    const mask = sph(0.1); mask.scale(1, 0.62, 1.05);
    add(mask, 'head', 'mask', hd.x, hd.y + 0.035, hd.z - 0.02);
  } else {
    const hood = sph(0.114); hood.scale(0.98, 1.1, 1.05);
    add(hood, 'head', 'mask', hd.x, hd.y + 0.1, hd.z + 0.008);
    add(box(0.16, 0.035, 0.03), 'head', 'skin', hd.x, hd.y + 0.12, hd.z - 0.105);
    add(box(0.24, 0.035, 0.235), 'head', 'band', hd.x, hd.y + 0.185, hd.z);
    add(box(0.07, 0.022, 0.02), 'head', 'goggles', hd.x - 0.04, hd.y + 0.12, hd.z - 0.118);
    add(box(0.07, 0.022, 0.02), 'head', 'goggles', hd.x + 0.04, hd.y + 0.12, hd.z - 0.118);
  }
  // 手臂
  for (const s of ['R', 'L']) {
    const ua = P('upperArm' + s), fa = P('forearm' + s), hn = P('hand' + s);
    add(sph(0.085), 'upperArm' + s, 'jacket', ua.x, ua.y - 0.02, ua.z);
    add(cap(0.062, 0.2), 'upperArm' + s, 'jacket', ua.x, ua.y - 0.15, ua.z);
    add(cap(0.066, 0.05), 'upperArm' + s, 'armband', ua.x, ua.y - 0.12, ua.z);
    add(cap(0.052, 0.19), 'forearm' + s, 'jacket', fa.x, fa.y - 0.13, fa.z);
    add(box(0.075, 0.1, 0.05), 'hand' + s, 'gloves', hn.x, hn.y - 0.04, hn.z);
  }
  // Equipment shares the same skinned geometry and atlas: no per-pouch draw calls.
  for (const side of [-1, 1]) {
    // Padded shoulder straps and adjustment buckles.
    add(box(.062,.31,.024),'chest','pouch',ch.x+side*.143,ch.y+.11,ch.z-.148,0,0,side*-.08);
    add(box(.058,.032,.032),'chest','metal',ch.x+side*.143,ch.y+.16,ch.z-.167);
    add(box(.029,.017,.034),'chest','pads',ch.x+side*.143,ch.y+.16,ch.z-.173);
    add(box(.064,.035,.19),'chest','vest',ch.x+side*.145,ch.y+.275,ch.z-.005,.18);
    // Radio carrier, belt bags and retention straps.
    add(box(.055,.13,.055),'chest','pads',ch.x+side*.184,ch.y+.13,ch.z-.13,0,side*.12);
    add(box(.06,.028,.058),'chest','band',ch.x+side*.184,ch.y+.145,ch.z-.133);
    add(box(.07,.085,.07),'hips','pouch',hp.x+side*.192,hp.y-.02,hp.z+.03);
    // Integrated ear protection and headset band.
    add(box(.04,.076,.072),'head','goggles',hd.x+side*.12,hd.y+.095,hd.z+.008,0,0,side*.13);
    add(box(.012,.055,.05),'head','metal',hd.x+side*.142,hd.y+.097,hd.z+.01);
    add(box(.014,.085,.015),'head','band',hd.x+side*.107,hd.y+.171,hd.z+.006,0,0,side*-.22);
  }
  // Front plate pocket, MOLLE webbing, lower retention tabs and fasteners.
  add(box(.247,.178,.025),'chest','vest',ch.x,ch.y+.115,ch.z-.161);
  for(let row=0;row<4;row++){
    add(box(.24,.012,.008),'chest','pouch',ch.x,ch.y+.17-row*.039,ch.z-.178);
    for(let col=0;col<5;col++)add(box(.004,.018,.009),'chest','stitch',ch.x-.104+col*.052,ch.y+.17-row*.039,ch.z-.18);
  }
  for(let i=0;i<3;i++){
    const x=ch.x-.10+i*.10;
    add(box(.087,.028,.053),'chest','vest',x,ch.y+.027,ch.z-.167);
    add(box(.019,.042,.008),'chest','band',x,ch.y+.006,ch.z-.192);
    add(box(.018,.012,.01),'chest','metal',x,ch.y-.014,ch.z-.196);
  }
  // Flat identity patch: a colored stitched tab, no floating label geometry.
  add(box(.082,.035,.008),'chest','pads',ch.x-.035,ch.y+.234,ch.z-.165);
  add(box(.067,.007,.009),'chest','stitch',ch.x-.035,ch.y+.238,ch.z-.17);
  add(box(.04,.004,.009),'chest','stitch',ch.x-.046,ch.y+.228,ch.z-.17);
  // Backpack lid, compression straps and two external seams.
  add(box(.29,.045,.13),'chest','vest',ch.x,ch.y+.232,ch.z+.196);
  for(const side of[-1,1]){
    add(box(.026,.28,.013),'chest','band',ch.x+side*.105,ch.y+.065,ch.z+.259);
    add(box(.036,.025,.018),'chest','metal',ch.x+side*.105,ch.y+.105,ch.z+.267);
    add(box(.012,.29,.014),'chest','stitch',ch.x+side*.138,ch.y+.07,ch.z+.247);
  }
  add(box(.1,.024,.025),'chest','band',ch.x,ch.y+.29,ch.z+.2);
  add(box(.042,.015,.032),'hips','metal',hp.x,hp.y+.082,hp.z-.141);
  // Rigid hard shells over fabric knee pads; stitched boots and segmented soles.
  for(const side of ['R','L']){
    const sign=side==='R'?1:-1,sh=P('shin'+side),ft=P('foot'+side),fa=P('forearm'+side),hn=P('hand'+side);
    add(box(.106,.109,.025),'shin'+side,'pads',sh.x,sh.y-.02,sh.z-.119,.08);
    add(box(.07,.071,.018),'shin'+side,'metal',sh.x,sh.y-.018,sh.z-.135,.08);
    for(const dy of[-.065,.028])add(box(.14,.018,.107),'shin'+side,'band',sh.x,sh.y+dy,sh.z-.03);
    add(box(.128,.024,.28),'foot'+side,'boots',ft.x,ft.y-.037,ft.z-.052);
    for(let i=0;i<6;i++)add(box(.13,.014,.018),'foot'+side,'pads',ft.x,ft.y-.051,ft.z-.167+i*.043);
    add(box(.11,.035,.11),'foot'+side,'pads',ft.x,ft.y+.088,ft.z-.12,.12);
    for(let i=0;i<4;i++)add(box(.07,.005,.009),'foot'+side,'stitch',ft.x,ft.y+.102-i*.004,ft.z-.117+i*.027,0,0,i%2?.1:-.1);
    add(box(.055,.079,.038),'forearm'+side,'pads',fa.x+sign*.037,fa.y-.019,fa.z+.017);
    add(box(.061,.023,.055),'hand'+side,'band',hn.x,hn.y+.006,hn.z);
    for(let i=0;i<3;i++)add(box(.014,.022,.01),'hand'+side,'pads',hn.x-.02+i*.02,hn.y-.023,hn.z-.028);
  }
  // Throat mic and short flexible boom are bound to the head/neck.
  add(box(.063,.014,.013),'head','goggles',hd.x-.079,hd.y+.038,hd.z-.074,0,-.6,-.2);
  add(box(.025,.017,.02),'head','pads',hd.x-.054,hd.y+.029,hd.z-.099);

  const geo = mergeAll(parts);
  for (const part of parts) part.dispose();
  geo.computeBoundingSphere();
  GEO_CACHE[key] = geo;
  return geo;
}

function mergeAll(list) {
  let n = 0; for (const g of list) n += g.attributes.position.count;
  const out = new THREE.BufferGeometry();
  const names = ['position', 'normal', 'uv', 'color', 'skinIndex', 'skinWeight'];
  for (const name of names) {
    const s = list[0].attributes[name];
    const Arr = s.array.constructor, isz = s.itemSize;
    const arr = new Arr(n * isz);
    let o = 0;
    for (const g of list) { arr.set(g.attributes[name].array, o); o += g.attributes[name].array.length; }
    out.setAttribute(name, name === 'skinIndex' ? new THREE.Uint16BufferAttribute(arr, isz) : new THREE.BufferAttribute(arr, isz));
  }
  return out;
}


export class Soldier extends CharacterPose {
  constructor(team, {random = Math.random} = {}) {
    super({random});
    this.team = team;
    this.highDetail = true;
    const oldBody = this.mesh;
    this.material = new THREE.MeshStandardMaterial({vertexColors:true,map:atlas(),roughness:.98,metalness:1,roughnessMap:ATLAS_ROUGH,metalnessMap:ATLAS_METAL,normalMap:ATLAS_NORMAL,normalScale:new THREE.Vector2(.22,.22)});
    this.mesh = new THREE.SkinnedMesh(buildGeometry(team),this.material);
    this.mesh.castShadow = true; this.mesh.receiveShadow = true; this.mesh.frustumCulled = false;
    this.mesh.add(this.bones[0]);
    this.root.remove(oldBody); this.root.add(this.mesh);
    this.mesh.updateMatrixWorld(true);
    this.mesh.bind(new THREE.Skeleton(this.bones));
    this.flashT = 0;
  }
  // Both levels use identical bind positions and rigid skin indices. Cached
  // geometry is shared by the whole team; changing LOD never rebinds a skeleton.
  setDetail(high) {
    high = !!high;
    if (this.highDetail === high) return;
    this.mesh.geometry = buildGeometry(this.team, !high);
    this.highDetail = high;
  }
  setWeapon(id) {
    if (this.gunId === id) return;
    if (this.gun) this.B.chest.remove(this.gun);
    this.gunId = id;
    this.gun = buildGunMerged(id);
    // 枪挂在胸骨上，保证瞄准方向稳定
    this.B.chest.add(this.gun);
    this.gunType = id;
  }

  die(...args) {
    super.die(...args);
    this.material.transparent = false; this.material.opacity = 1;
  }
  updateDeath(dt) {
    super.updateDeath(dt);
    if (this.gun) this.gun.visible = this.deadT < 0.25;
    if (this.deadT > 4.5) { this.material.transparent = true; this.material.opacity = this.opacity; }
  }
  reset() {
    super.reset();
    if (this.gun) this.gun.visible = true;
    this.material.transparent = false; this.material.opacity = 1;
  }
}
