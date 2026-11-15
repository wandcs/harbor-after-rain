import { chooseLane as chooseSimLane } from './sim/tactics.js';
export * from './sim/tactics.js';
export function chooseLane(actors, team, self, lanes, random = Math.random) {
  return chooseSimLane(actors, team, self, lanes, random);
}
