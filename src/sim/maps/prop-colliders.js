import { CH, CW, L20, L40 } from './dimensions.js';

/** Plain collision definitions shared by map layout and isolated prop galleries.
 * Dimensions are metres and yaw is radians; callers own the returned object. */
export function propCollider(kind, args, crateKinds) {
  if (kind === 'container') {
    const [x, z, yawDeg, length, , level = 0, options = {}] = args;
    if (options.collide === false) return null;
    return {
      x,
      y: level * CH + CH / 2,
      z,
      sx: length === 40 ? L40 : L20,
      sy: CH,
      sz: CW,
      yaw: (yawDeg * Math.PI) / 180,
      mat: 'metal',
      surface: 'container',
      tag: 'container',
    };
  }
  if (kind === 'crate') {
    const [x, z, sx, sy, sz, index, y = 0, yawDeg = 0] = args;
    const wood = crateKinds[index] === 'wood';
    return {
      x,
      y: y + sy / 2,
      z,
      sx,
      sy,
      sz,
      yaw: (yawDeg * Math.PI) / 180,
      mat: wood ? 'wood' : 'metal',
      bullet: wood ? 'pen' : 'block',
      surface: wood ? 'wood' : 'metal',
    };
  }
  if (kind === 'barrel') {
    const [x, z, , y = 0] = args;
    return { x, y: y + 0.45, z, sx: 0.56, sy: 0.9, sz: 0.56, yaw: 0, mat: 'metal', bullet: 'pen' };
  }
  if (kind === 'railing' || kind === 'fence') {
    const [x0, z0, x1, z1, y0 = 0] = args;
    const fence = kind === 'fence';
    const collide = args[7];
    if (collide === false) return null;
    const height = fence ? args[5] - y0 : 1.6;
    return {
      x: (x0 + x1) / 2,
      y: y0 + height / 2,
      z: (z0 + z1) / 2,
      sx: Math.hypot(x1 - x0, z1 - z0),
      sy: height,
      sz: fence ? 0.08 : 0.1,
      yaw: Math.atan2(-(z1 - z0), x1 - x0),
      bullet: 'pass',
      sight: false,
      mat: fence ? 'mesh' : 'metal',
    };
  }
  return null;
}
