import { Actor as SimActor } from './sim/actor.js';
import { attachActorView, actorViewMethods } from './actor-view.js';
export { STAND_H, CROUCH_H, EYE_STAND, EYE_CROUCH } from './sim/actor.js';

export class Actor extends SimActor {
  constructor(game, options) {
    super(game, options);
    attachActorView(this, game);
  }
}
Object.assign(Actor.prototype, actorViewMethods);
