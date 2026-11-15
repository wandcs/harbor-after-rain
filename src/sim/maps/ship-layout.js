import { propCollider } from './prop-colliders.js';

import { CH, CW, L20, L40, H2, MAP_BOUNDS, NAV_BOUNDS } from './dimensions.js';
export { CH, CW, L20, L40, SEA_Y, DECK_HALF_Z, H2, MAP_BOUNDS, NAV_BOUNDS } from './dimensions.js';

/** Creates fresh map data, never geometry, materials or a mutable shared world.
 * operations describe placements for the browser; colliders are simulation data.
 * crateKinds/containerCount describe the authored asset variants, not textures. */
export function createShipLayout({
  crateKinds = ['wood', 'wood', 'wood', 'wood', 'metal', 'metal'],
  containerCount = 8,
} = {}) {
  const operations = [],
    colliders = [],
    navigationChecks = [];
  const record =
    (kind) =>
    (...args) => {
      operations.push({ kind, args });
      const collider = propCollider(kind, args, crateKinds);
      if (collider) colliders.push(collider);
    };
  const box = record('box'),
    foot = record('foot'),
    geom = record('geom'),
    rod = record('rod'),
    decal = record('decal');
  const container = record('container'),
    corrugatedWall = record('corrugatedWall'),
    crate = record('crate');
  const barrel = record('barrel'),
    railing = record('railing'),
    fence = record('fence'),
    lamp = record('lamp'),
    lifeRing = record('lifeRing');
  const solid = (x, y, z, sx, sy, sz, yaw, props = {}) =>
    colliders.push({ x, y, z, sx, sy, sz, yaw, ...props });
  solid(0, -0.5, 0, 74, 1, 36.3, 0, {
    mat: 'deck',
    surface: 'metal',
    tag: 'deck',
    navSurface: true,
  });
  // 舷侧看不见的墙（防止跳海）与两端
  for (const sz of [-1, 1])
    solid(0, 4, sz * 18.15, 80, 8, 0.1, 0, { bullet: 'pass', sight: false, tag: 'boundary' });
  solid(-36.6, 6, 0, 0.4, 12, 36.6, 0, { mat: 'metal', tag: 'boundary' });
  solid(36.6, 6, 0, 0.4, 12, 36.6, 0, { mat: 'metal', tag: 'boundary' });

  // 舷边栏杆（整船）
  for (const sz of [-1, 1]) {
    for (let x = -64; x < 56; x += 10)
      railing(x, sz * 18.05, Math.min(x + 10, 56), sz * 18.05, 0, 'railYellow', 1.1, false);
    box(-4, 0.08, sz * 18.12, 120, 0.16, 0.06, 0, 'yellow');
  }

  // ================== 对称结构（s=+1 潜伏者一侧；s=-1 旋转 180° 为保卫者一侧） ==================
  const sideColors = { 1: [1, 3, 7, 1, 3], [-1]: [0, 5, 4, 0, 5] };
  for (const s of [1, -1]) {
    const X = (x) => x * s,
      Z = (z) => z * s,
      YAW = (deg) => deg + (s < 0 ? 180 : 0);
    const R = (deg) => (YAW(deg) * Math.PI) / 180;
    const col = sideColors[s];

    // ---- 出生点舱壁（带两扇门）----
    const wallX = X(-28.15),
      wallTh = 0.3,
      wallH = 4.5,
      doorH = 2.5;
    const doors = [
      [-16.8, -13.8],
      [-4.6, -1.8],
      [2.8, 5.4],
      [13.8, 16.8],
    ];
    // The existing upper-container approach at 6.8..12.3 remains open above head height.
    const segs = [
      [-18.1, -16.8],
      [-13.8, -4.6],
      [-1.8, 2.8],
      [5.4, 6.8],
      [12.3, 13.8],
      [16.8, 18.1],
    ];
    for (const [z0, z1] of segs) {
      const zc = Z((z0 + z1) / 2),
        L = z1 - z0;
      box(wallX, wallH / 2, zc, wallTh, wallH, L, 0, 'bulkhead');
      solid(wallX, wallH / 2, zc, wallTh, wallH, L, 0, { mat: 'metal' });
      foot(wallX, zc, wallTh, L, 0, 0.5);
    }
    for (const [z0, z1] of doors) {
      const zc = Z((z0 + z1) / 2),
        L = z1 - z0;
      box(wallX, doorH + (wallH - doorH) / 2, zc, wallTh, wallH - doorH, L, 0, 'bulkhead');
      solid(wallX, doorH + (wallH - doorH) / 2, zc, wallTh, wallH - doorH, L, 0, { mat: 'metal' });
      // 门框警示条
      for (const face of [-1, 1]) {
        const fx = wallX + face * (wallTh / 2 + 0.005);
        decal('signs', fx, doorH + 0.12, zc, L + 0.3, 0.24, (face * Math.PI) / 2, 0, 'hazard');
        for (const zz of [z0, z1])
          decal(
            'signs',
            fx,
            doorH / 2,
            Z(zz) + (zz === z0 ? 0.12 : -0.12) * s,
            0.24,
            doorH,
            (face * Math.PI) / 2,
            0,
            [0, 0, 128, 128],
          );
      }
      // 门槛
      box(wallX, 0.05, zc, wallTh + 0.2, 0.1, L, 0, 'darkSteel');
    }
    // 舱壁标识
    for (const face of [-1, 1]) {
      const fx = wallX + face * (wallTh / 2 + 0.006);
      decal('signs', fx, 3.4, Z(-8.2), 3.2, 0.8, (face * Math.PI) / 2, 0, 'hold');
      decal('signs', fx, 3.3, Z(0.5), 2.4, 0.84, (face * Math.PI) / 2, 0, s > 0 ? 'bl' : 'gr');
      decal('signs', fx, 1.6, Z(-6.2), 0.6, 0.6, (face * Math.PI) / 2, 0, 'nosmoke');
    }
    lamp(wallX + s * 0.35, 3.0, Z(-3.2), false);
    lamp(wallX + s * 0.35, 3.0, Z(4.1), false);
    lamp(wallX - s * 0.35, 3.0, Z(-3.2), false);
    // 消防箱
    box(wallX - s * 0.3, 1.3, Z(-9.8), 0.25, 0.8, 0.6, 0, 'red');
    decal(
      'signs',
      wallX - s * 0.43,
      2.05,
      Z(-9.8),
      0.5,
      0.5,
      s > 0 ? -Math.PI / 2 : Math.PI / 2,
      0,
      'hydrant',
    );

    // ---- 出生点内：吊机底座、楼梯、平台 ----
    // 吊机底座
    const cx = X(-33),
      cz = Z(-9.6);
    geom('yellow', 'cylG', cx, 3, cz, 0, 0, 0, 1.15, 6, 1.15);
    geom('darkSteel', 'cylG', cx, 0.15, cz, 0, 0, 0, 1.45, 0.3, 1.45);
    solid(cx, 3, cz, 2.2, 6, 2.2, R(45), { mat: 'metal' });
    solid(cx, 3, cz, 2.2, 6, 2.2, 0, { mat: 'metal' });
    foot(cx, cz, 2.6, 2.6, 0, 0.6);
    // 楼梯（上二楼）
    const nSteps = 10,
      stepH = H2 / nSteps,
      sx0 = -34,
      sx1 = -29.5,
      tread = (sx1 - sx0) / nSteps;
    const stz0 = 6.9,
      stz1 = 8.5;
    for (let i = 0; i < nSteps; i++) {
      const x0 = sx0 + i * tread;
      const cxs = X((x0 + sx1) / 2),
        h = (i + 1) * stepH;
      box(cxs, h / 2, Z((stz0 + stz1) / 2), sx1 - x0, h, stz1 - stz0, 0, {
        py: 'grating',
        px: 'darkSteel',
        nx: 'darkSteel',
        pz: 'darkSteel',
        nz: 'darkSteel',
      });
      box(X(x0 + 0.03), h - 0.02, Z((stz0 + stz1) / 2), 0.06, 0.04, stz1 - stz0, 0, 'railYellow');
      solid(cxs, h / 2, Z((stz0 + stz1) / 2), sx1 - x0, h, stz1 - stz0, 0, {
        mat: 'metal',
        surface: 'grate',
      });
    }
    foot(X((sx0 + sx1) / 2), Z((stz0 + stz1) / 2), sx1 - sx0, stz1 - stz0, 0, 0.5);
    // 楼梯斜扶手
    rod('railYellow', X(sx0), 1.0, Z(stz0), X(sx1), H2 + 1.0, Z(stz0), 0.03);
    rod('railYellow', X(sx0), 0.55, Z(stz0), X(sx1), H2 + 0.55, Z(stz0), 0.025);
    for (let i = 0; i <= 4; i++) {
      const t = i / 4;
      const hx = sx0 + (sx1 - sx0) * t,
        hy = H2 * t;
      rod('railYellow', X(hx), hy, Z(stz0), X(hx), hy + 1.0, Z(stz0), 0.03);
    }
    // 平台支撑块
    box(X(-28.75), H2 / 2, Z(8.1), 1.5, H2, 2.6, 0, {
      py: 'grating',
      px: 'darkSteel',
      nx: 'darkSteel',
      pz: 'darkSteel',
      nz: 'darkSteel',
    });
    solid(X(-28.75), H2 / 2, Z(8.1), 1.5, H2, 2.6, 0, { mat: 'metal', surface: 'grate' });
    foot(X(-28.75), Z(8.1), 1.5, 2.6, 0, 0.6);
    railing(X(-29.5), Z(6.8), X(-28.0), Z(6.8), H2, 'railYellow', 1.1, true);

    // 出生点杂物
    crate(X(-29.6), Z(-6.6), 1.3, 1.3, 1.3, 4, 0, 10);
    crate(X(-29.5), Z(-5.3), 1.0, 0.9, 1.0, 5, 0, -5);
    crate(X(-35.6), Z(4.2), 1.4, 1.4, 1.4, 4, 0, 0);
    for (const bz of [-11.3, 11.3]) {
      // 系缆桩
      const bx = X(-35.3),
        bzz = Z(bz);
      geom('black', 'cylG', bx - 0.35, 0.35, bzz, 0, 0, 0, 0.2, 0.7, 0.2);
      geom('black', 'cylG', bx + 0.35, 0.35, bzz, 0, 0, 0, 0.2, 0.7, 0.2);
      box(bx, 0.05, bzz, 1.3, 0.1, 0.55, 0, 'black');
      solid(bx, 0.35, bzz, 1.2, 0.7, 0.45, 0, { mat: 'metal' });
    }
    lifeRing(X(-31.5), 0.85, Z(11.98), s > 0 ? 0 : Math.PI);
    lifeRing(X(-34.5), 0.85, Z(-11.98), s > 0 ? Math.PI : 0);
    // 蘑菇通风筒
    for (const [vx, vz] of [
      [-35.4, -7.8],
      [-35.4, 0.3],
    ]) {
      geom('white', 'cylG', X(vx), 0.6, Z(vz), 0, 0, 0, 0.18, 1.2, 0.18);
      geom('white', 'sphG', X(vx), 1.25, Z(vz), 0, 0, 0, 0.36, 0.2, 0.36);
      solid(X(vx), 0.7, Z(vz), 0.5, 1.4, 0.5, 0, { mat: 'metal' });
    }

    // ---- 集装箱管道（单向小道）+ 二楼 ----
    const tz0 = 9.4,
      tz1 = 9.4 + CW,
      tzc = (tz0 + tz1) / 2; // 9.4 .. 11.84
    const tx0 = -29.5;
    const segCols = [col[0], col[1], col[2]];
    const wT = 0.08;
    for (let k = 0; k < 3; k++) {
      const x0 = tx0 + k * L40,
        x1 = x0 + L40,
        xc = (x0 + x1) / 2;
      const ci = segCols[k] % containerCount;
      // Paired side hatches turn the old long tube into a route with regular escape/crossfire choices.
      const door0 = xc - 1.15,
        door1 = xc + 1.15,
        hatchH = 2.25;
      const panel = (a, b, z, faces) => {
        for (const [lo, hi] of [
          [a, Math.min(b, door0)],
          [Math.max(a, door1), b],
        ]) {
          if (hi <= lo) continue;
          corrugatedWall(X((lo + hi) / 2), CH / 2, Z(z), hi - lo, CH, wT, R(0), faces, {
            u0: (lo - x0) / L40,
            u1: (hi - x0) / L40,
          });
          solid(X((lo + hi) / 2), CH / 2, Z(z), hi - lo, CH, wT, 0, {
            mat: 'metal',
            tag: 'corridor-wall',
          });
        }
        const lo = Math.max(a, door0),
          hi = Math.min(b, door1);
        if (hi > lo) {
          corrugatedWall(
            X((lo + hi) / 2),
            (hatchH + CH) / 2,
            Z(z),
            hi - lo,
            CH - hatchH,
            wT,
            R(0),
            faces,
            { u0: (lo - x0) / L40, u1: (hi - x0) / L40, v0: hatchH / CH, v1: 1 },
          );
          solid(X((lo + hi) / 2), (hatchH + CH) / 2, Z(z), hi - lo, CH - hatchH, wT, 0, {
            mat: 'metal',
            tag: 'corridor-header',
          });
        }
      };
      // 面向甲板的内墙
      panel(x0, x1, tz0 + wT / 2, { nz: `c${ci}s40`, pz: 'interior' });
      // 外墙：实墙 + 铁丝网窗
      const win = [x0 + 3.2, x0 + 8.4];
      let cur = x0;
      for (const wx of win) {
        const a = cur,
          b2 = wx;
        panel(a, b2, tz1 - wT / 2, { pz: `c${ci}s40`, nz: 'interior' });
        // 网窗 1.6m
        const f0 = wx,
          f1 = wx + 1.6;
        fence(X(f0), Z(tz1 - wT / 2), X(f1), Z(tz1 - wT / 2), 0.9, 2.2, 'railYellow', false);
        corrugatedWall(
          X((f0 + f1) / 2),
          0.45,
          Z(tz1 - wT / 2),
          1.6,
          0.9,
          wT,
          R(0),
          { pz: `c${ci}s40`, nz: 'interior' },
          { u0: (f0 - x0) / L40, u1: (f1 - x0) / L40, v0: 0, v1: 0.9 / CH },
        );
        corrugatedWall(
          X((f0 + f1) / 2),
          (2.2 + CH) / 2,
          Z(tz1 - wT / 2),
          1.6,
          CH - 2.2,
          wT,
          R(0),
          { pz: `c${ci}s40`, nz: 'interior' },
          { u0: (f0 - x0) / L40, u1: (f1 - x0) / L40, v0: 2.2 / CH, v1: 1 },
        );
        solid(X((f0 + f1) / 2), CH / 2, Z(tz1 - wT / 2), 1.6, CH, wT, 0, {
          mat: 'metal',
          bullet: 'pass',
          sight: false,
        });
        cur = f1;
      }
      panel(cur, x1, tz1 - wT / 2, { pz: `c${ci}s40`, nz: 'interior' });
      // 顶板（二楼地面）与内顶
      box(X(xc), CH - 0.07, Z(tzc), L40, 0.14, CW + 0.001, R(0), {
        py: `c${ci}roof`,
        ny: 'interior',
      });
      solid(X(xc), CH - 0.07, Z(tzc), L40, 0.14, CW, 0, { mat: 'metal', surface: 'container' });
      // 角柱
      for (const px of [x0, x1])
        for (const pz of [tz0, tz1]) box(X(px), CH / 2, Z(pz), 0.16, CH, 0.16, 0, 'darkSteel');
      // 管道内灯
      lamp(X(xc - 3), CH - 0.25, Z(tzc), k !== 1);
      lamp(X(xc + 3), CH - 0.25, Z(tzc), false);
      // 外侧管线
      for (const [lo, hi] of [
        [x0, door0],
        [door1, x1],
      ]) {
        geom(
          'darkSteel',
          'cylG',
          X((lo + hi) / 2),
          0.35,
          Z(tz1 - 0.3),
          0,
          0,
          Math.PI / 2,
          0.16,
          hi - lo,
          0.16,
        );
        geom(
          'red',
          'cylG',
          X((lo + hi) / 2),
          0.75,
          Z(tz1 - 0.28),
          0,
          0,
          Math.PI / 2,
          0.08,
          hi - lo,
          0.08,
        );
        solid(X((lo + hi) / 2), 0.4, Z(tz1 - 0.3), hi - lo, 0.8, 0.36, 0, {
          mat: 'metal',
          bullet: 'pass',
        });
      }
      for (const pz of [tz0, tz1]) {
        for (const dx of [door0, door1])
          box(X(dx), hatchH / 2, Z(pz), 0.09, hatchH, 0.12, 0, 'railYellow');
        box(X(xc), hatchH, Z(pz), 2.4, 0.09, 0.12, 0, 'railYellow');
      }
      navigationChecks.push({ name: `横舱门 ${s}:${k}`, x: X(xc), z: Z(tzc), y: 0 });
    }
    const tEnd = tx0 + 3 * L40; // ≈7.07
    // 入口处敞开并贴在箱壁上的箱门
    for (const [ex, dir] of [
      [tx0, 1],
      [tEnd, -1],
    ]) {
      const ciD = segCols[dir > 0 ? 0 : 2] % containerCount;
      box(X(ex + dir * 0.62), CH / 2, Z(tz0 - 0.05), 1.2, CH - 0.12, 0.06, R(0), {
        nz: `c${ciD}door`,
        pz: `c${ciD}door`,
      });
      box(X(ex + dir * 0.62), CH / 2, Z(tz1 + 0.05), 1.2, CH - 0.12, 0.06, R(0), {
        nz: `c${ciD}door`,
        pz: `c${ciD}door`,
      });
    }
    // 管道内掩体
    crate(X(-18.5), Z(9.9), 0.8, 0.8, 0.8, 1, 0, 0);
    crate(X(-4.0), Z(9.95), 0.9, 1.0, 0.9, 5, 0, 0);
    // 管道尽头：20尺集装箱（可上）+ 40尺双层（挡住二楼）
    container(X(11.83), Z(tzc), YAW(0), 20, col[3]);
    container(X(21.05), Z(tzc), YAW(0), 40, col[4]);
    container(X(21.05), Z(tzc), YAW(0), 40, col[0] + 2, 1);
    // 二楼栏杆（外侧）与内侧局部栏杆
    railing(X(tx0), Z(11.8), X(14.86), Z(11.8), H2, 'railYellow', 1.1, true);
    railing(X(-24), Z(9.45), X(-16), Z(9.45), H2, 'railYellow', 1.1, true);
    railing(X(-8), Z(9.45), X(-2), Z(9.45), H2, 'railYellow', 1.1, true);
    // 管道出口外的箱子（可跳上二楼）
    for (let i = 0; i < 5; i++)
      crate(X(8.8 + 0.59 + i * 1.18), Z(8.85), 1.16, 0.9, 1.1, i % 2 ? 1 : 3, 0, 0);
    crate(X(11.5), Z(8.85), 1.2, 0.95, 1.2, 0, 0.9, 5);
    crate(X(11.3), Z(7.5), 1.6, 1.6, 1.6, 2, 0, -6);

    // ---- 主甲板障碍（半场）----
    container(X(-21.5), Z(-1.8), YAW(90), 20, col[1]); // A
    container(X(-12.8), Z(0.9), YAW(90), 20, col[2]); // B1
    container(X(-13.6), Z(5.15), YAW(0), 20, col[0]); // B2
    container(X(-13.6), Z(5.15), YAW(0), 20, col[3] + 1, 1); // B2 上层
    crate(X(-14.65), Z(2.3), 1.2, 1.8, 1.2, 4, 0, 0); // 上 B1 的台阶
    crate(X(-15.8), Z(2.3), 1.0, 0.9, 1.0, 1, 0, 8);
    crate(X(-26.9), Z(0.4), 1.6, 1.6, 1.6, 4, 0, 0); // 出生点门前掩体
    crate(X(-26.6), Z(2.1), 1.2, 1.2, 1.2, 5, 0, 15);
    crate(X(-6.4), Z(8.3), 1.4, 1.4, 1.4, s > 0 ? 0 : 2, 0, 4);
    barrel(X(-19.2), Z(-8.3), 'red');
    barrel(X(-18.5), Z(-8.7), 'red');
    barrel(X(-18.8), Z(-7.7), 'green');
    barrel(X(-9.6), Z(8.7), 'green');
    barrel(X(-9.0), Z(8.95), 'red');
    // 甲板黄线（通道标线）
    for (const lz of [-7.2, 7.4]) box(X(-17), 0.004, Z(lz), 16, 0.001, 0.12, 0, { py: 'paintY' });
    decal(
      'signs',
      X(-24.5),
      0.006,
      Z(-6.5),
      1.2,
      1.2,
      s > 0 ? -Math.PI / 2 : Math.PI / 2,
      -Math.PI / 2,
      'arrow',
    );
  }

  // ---- 中路：V 形斜放集装箱 + 木箱 ----
  container(-1.1, -4.4, -39, 20, 2);
  container(0.9, 4.0, 33, 20, 6);
  crate(-6.9, 1.3, 1.6, 1.6, 1.6, 0, 0, 3);
  crate(-5.2, 1.4, 1.2, 1.2, 1.2, 2, 0, -8);
  crate(-6.9, 1.3, 1.0, 0.8, 1.0, 1, 1.6, 20);

  // ================== 新增侧舷：贯通维护舱、观察甲板和地面旁路 ==================
  // Inspired by the reference's yard / workshop / quay connections: every enclosed
  // room has two end doors and a lateral hatch, and every high route has two stairs.
  const routeChecks = [];
  for (const side of [-1, 1]) {
    const z = 15.7 * side,
      inner = 13.5 * side,
      outer = 17.9 * side;
    for (const x of [-21, 21]) {
      const length = 8,
        height = 3.15,
        thickness = 0.16,
        doorWidth = 2.4,
        doorH = 2.5;
      const wall = (cx, cy, cz, sx, sy, sz, key = 'bulkhead') => {
        box(cx, cy, cz, sx, sy, sz, 0, key);
        solid(cx, cy, cz, sx, sy, sz, 0, { mat: 'metal', tag: 'maintenance-room' });
      };
      // Outside wall; inside wall has a transverse shortcut to the container hatches.
      wall(x, height / 2, outer, length, height, thickness);
      for (const dx of [-1, 1])
        wall(
          x + (dx * (length + doorWidth)) / 4,
          height / 2,
          inner,
          (length - doorWidth) / 2,
          height,
          thickness,
        );
      wall(x, (doorH + height) / 2, inner, doorWidth, height - doorH, thickness);
      // Broad end doors keep the side route open in both directions.
      const width = Math.abs(outer - inner);
      for (const end of [-1, 1]) {
        for (const dz of [-1, 1])
          wall(
            x + (end * length) / 2,
            height / 2,
            z + (dz * (width + doorWidth)) / 4,
            thickness,
            height,
            (width - doorWidth) / 2,
          );
        wall(x + (end * length) / 2, (doorH + height) / 2, z, thickness, height - doorH, doorWidth);
        decal(
          'signs',
          x + end * (length / 2 + 0.09),
          2.78,
          z,
          2.6,
          0.28,
          (end * Math.PI) / 2,
          0,
          'hazard',
        );
        lamp(x + end * 3.4, 2.78, z, false);
      }
      // A real roof collider is used by rain, lighting, bullets, and head clearance.
      box(x, height + 0.06, z, length + 0.2, 0.12, width + 0.2, 0, {
        py: 'darkSteel',
        ny: 'interior',
        px: 'darkSteel',
        nx: 'darkSteel',
        pz: 'darkSteel',
        nz: 'darkSteel',
      });
      solid(x, height + 0.06, z, length + 0.2, 0.12, width + 0.2, 0, {
        mat: 'metal',
        tag: 'maintenance-roof',
      });
      foot(x, z, length, width, 0, 0.28);
      // Equipment is offset from the centreline: cover without blocking the through route.
      crate(x - 1.7, z + side * 1.25, 1.35, 1.25, 0.8, 4);
      crate(x + 1.7, z - side * 1.25, 1.35, 0.95, 0.8, 1);
      for (const dx of [-2.6, 0, 2.6]) box(x + dx, 2.95, z, 1.1, 0.04, 0.12, 0, 'lamp');
      box(x, 2.4, outer - side * 0.15, 5.8, 0.1, 0.1, 0, 'red');
      decal(
        'signs',
        x + 1.7,
        1.6,
        inner - side * 0.09,
        0.55,
        0.55,
        side > 0 ? Math.PI : 0,
        0,
        'nosmoke',
      );
      navigationChecks.push({ name: `维护舱 ${x}:${side}`, x, z, y: 0 });
      routeChecks.push({ name: `设备舱贯通 ${x}:${side}`, from: [x - 5, 0, z], to: [x + 5, 0, z] });
    }
    // Solid machinery plinth under the observation deck. The lower shortcut runs
    // beside it (z=12.7), so navigation never confuses two floors at one grid cell.
    const platformZ = side * 16.05,
      platformW = 3.6,
      platformL = 12;
    box(0, H2 / 2, platformZ, platformL, H2, platformW, 0, {
      py: 'grating',
      px: 'darkSteel',
      nx: 'darkSteel',
      pz: 'bulkhead',
      nz: 'bulkhead',
    });
    solid(0, H2 / 2, platformZ, platformL, H2, platformW, 0, {
      mat: 'metal',
      surface: 'grate',
      navSurface: true,
      tag: 'observation-platform',
    });
    foot(0, platformZ, platformL, platformW, 0, 0.4);
    for (const end of [-1, 1]) {
      const steps = 14,
        run = 6.5,
        tread = run / steps;
      for (let i = 0; i < steps; i++) {
        const height = ((i + 1) * H2) / steps,
          xx = end * (12.5 - (i + 0.5) * tread);
        box(xx, height / 2, platformZ, tread + 0.002, height, platformW, 0, {
          py: 'grating',
          px: 'darkSteel',
          nx: 'darkSteel',
          pz: 'darkSteel',
          nz: 'darkSteel',
        });
        solid(xx, height / 2, platformZ, tread + 0.002, height, platformW, 0, {
          mat: 'metal',
          surface: 'grate',
          navSurface: true,
          tag: 'observation-stair',
        });
        box(
          xx + end * (tread / 2 - 0.025),
          height + 0.006,
          platformZ,
          0.05,
          0.014,
          platformW,
          0,
          'railYellow',
        );
        for (const railZ of [platformZ - platformW / 2, platformZ + platformW / 2]) {
          solid(xx, height + 0.65, railZ, tread, 1.3, 0.07, 0, {
            mat: 'metal',
            bullet: 'pass',
            sight: false,
            tag: 'stair-rail',
          });
        }
      }
      for (const railZ of [platformZ - platformW / 2, platformZ + platformW / 2]) {
        rod('railYellow', end * 12.5, 1.1, railZ, end * 6, H2 + 1.1, railZ, 0.035);
        rod('railYellow', end * 12.5, 0.55, railZ, end * 6, H2 + 0.55, railZ, 0.025);
        for (let i = 0; i <= 5; i++) {
          const k = i / 5;
          rod(
            'railYellow',
            end * (12.5 - k * 6.5),
            k * H2,
            railZ,
            end * (12.5 - k * 6.5),
            k * H2 + 1.1,
            railZ,
            0.025,
          );
        }
      }
      navigationChecks.push({ name: `平台梯脚 ${end}:${side}`, x: end * 13.2, z: platformZ, y: 0 });
    }
    railing(-6, platformZ + platformW / 2, 6, platformZ + platformW / 2, H2);
    railing(-6, platformZ - platformW / 2, 6, platformZ - platformW / 2, H2);
    // Two low machine boxes break a single uninterrupted firing line along the upper lane.
    for (const x of [-3.6, 3.6]) {
      box(x, H2 + 0.45, platformZ + side * 0.75, 1.5, 0.9, 0.8, 0, 'darkSteel');
      solid(x, H2 + 0.45, platformZ + side * 0.75, 1.5, 0.9, 0.8, 0, {
        mat: 'metal',
        tag: 'platform-cover',
      });
      box(x, H2 + 0.92, platformZ + side * 0.75, 1.56, 0.04, 0.86, 0, 'yellow');
    }
    navigationChecks.push({
      name: side > 0 ? '右舷观察甲板' : '左舷观察甲板',
      x: 0,
      z: platformZ,
      y: H2,
    });
    navigationChecks.push({ name: `平台下侧旁路 ${side}`, x: 0, z: side * 12.8, y: 0 });
    routeChecks.push({
      name: `双楼梯平台 ${side}`,
      from: [-13.2, 0, platformZ],
      via: [0, H2, platformZ],
      to: [13.2, 0, platformZ],
    });
    routeChecks.push({
      name: `全长侧路 ${side}`,
      from: [-32, 0, side * 15.7],
      to: [32, 0, side * 15.7],
    });
    for (const x of [-33, 33]) {
      // Spawn-side screens prevent a direct end-to-end sightline through all four doors.
      crate(x, side * 12.6, 2, 1.25, 1.2, side > 0 ? 4 : 1);
      box(Math.sign(x) * 36.35, 1.75, side * 15.1, 0.2, 3.5, 6.1, 0, 'bulkhead');
      lifeRing(x, 0.85, side * 18.0, side > 0 ? 0 : Math.PI);
    }
    for (const x of [-29.7, -14.4, 14.4, 29.7]) {
      decal(
        'signs',
        x,
        0.008,
        side * 15.7,
        1.3,
        1.3,
        x < 0 ? -Math.PI / 2 : Math.PI / 2,
        -Math.PI / 2,
        'arrow',
      );
      box(x, 0.006, side * 13.0, 2.6, 0.006, 0.1, 0, { py: 'paintY' });
    }
  }

  // ================== 保卫者背后：集装箱墙与船头 ==================
  const stackCols = [0, 5, 4, 1, 2, 6, 3, 7];
  for (let tier = 0; tier < 3; tier++)
    for (let i = 0; i < 4; i++) {
      container(37.6, -9.09 + i * L20, 90, 20, stackCols[(i + tier * 3) % 8], tier, {
        collide: tier === 0,
      });
    }
  solid(37.6, 6, 0, CW, 12, 24.4, 0, { mat: 'metal' });
  // 更远处的堆场
  for (let row = 0; row < 3; row++)
    for (let bay = 0; bay < 8; bay++) {
      const h = 2 + ((row * 7 + bay * 3) % 3);
      for (let tier = 0; tier < h; tier++)
        container(41 + row * 7, -10.6 + bay * 3.03, 0, 20, (bay + row * 3 + tier * 5) % 8, tier, {
          collide: false,
          noEnds: tier < h - 1 && false,
        });
    }
  // ================== 出生点 ==================
  const spawns = { BL: [], GR: [] };
  for (let i = 0; i < 10; i++) {
    const zz = -6.6 + (i % 5) * 3.0,
      xx = -34.0 + Math.floor(i / 5) * 2.8;
    spawns.BL.push({ x: xx, z: zz, yaw: -Math.PI / 2 });
    spawns.GR.push({ x: -xx, z: -zz, yaw: Math.PI / 2 });
  }
  for (const x of [-34, -31.2])
    for (const z of [-15.7, 15.7]) {
      spawns.BL.push({ x, z, yaw: -Math.PI / 2 });
      spawns.GR.push({ x: -x, z: -z, yaw: Math.PI / 2 });
    }

  const relayPoints = [
    { x: 0, y: 0, z: -6.8, label: '左舷货道' },
    { x: 0, y: H2, z: 16.05, label: '右舷观察甲板' },
    { x: -2.5, y: 0, z: 0, label: '中央甲板' },
    { x: 0, y: H2, z: -16.05, label: '左舷观察甲板' },
    { x: 0, y: 0, z: 6.8, label: '右舷货道' },
  ];

  return {
    operations,
    colliders,
    spawns,
    bounds: { ...MAP_BOUNDS },
    navBounds: { ...NAV_BOUNDS },
    spawnBounds: { BL: { maxX: -28.3 }, GR: { minX: 28.3 } },
    relayPoints,
    navigationChecks,
    routeChecks,
    lanes: [-16.05, -6.8, -0.4, 6.8, 16.05],
  };
}
