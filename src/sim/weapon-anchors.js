import { freezeData } from './readonly.js';
// Weapon attachment points used by both CPU hit poses and visible models.
export const WEAPON_ANCHORS = freezeData({
  m4a1: {
    grip: [0, -0.04, 0.034],
    fore: [-0.003, 0.025, -0.275],
    magwell: [0, -0.0555, -0.075],
    muzzle: [0, 0.051, -0.628],
  },
  ak47: {
    grip: [0, -0.035, 0.03],
    fore: [0, 0, -0.29],
    magwell: [0, -0.02, -0.1],
    muzzle: [0, 0.042, -0.66],
  },
  mp5: {
    grip: [0, -0.035, 0.03],
    fore: [0, 0, -0.3],
    magwell: [0, -0.028, -0.13],
    muzzle: [0, 0.046, -0.46],
  },
  awm: {
    grip: [0, -0.05, 0.075],
    fore: [0, -0.02, -0.3],
    magwell: [0, -0.052, -0.07],
    muzzle: [0, 0.05, -0.84],
  },
  deagle: {
    grip: [0, -0.04, 0.03],
    fore: [-0.02, -0.05, 0.02],
    magwell: [0, -0.094132, 0.004304],
    muzzle: [0, 0.062, -0.21],
  },
  knife: { grip: [0, 0, 0.03], muzzle: [0, 0, -0.23] },
  he: { grip: [0, 0, 0], muzzle: [0, 0, -0.04] },
});
