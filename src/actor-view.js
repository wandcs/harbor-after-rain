import { Soldier } from './character.js';
import { Actor as SimActor } from './sim/actor.js';

export function attachActorView(actor, game) {
  game.renderer.scene.add(actor.soldier.root);
}

export const actorViewMethods = {
  spawn(...args) {
    SimActor.prototype.spawn.apply(this, args);
    this.soldier.root.visible = !this.isPlayer;
  },
  random() {
    return (this.game.random || Math.random)();
  },
  createPose(team) {
    return new Soldier(team, { random: () => this.random() });
  },
};
