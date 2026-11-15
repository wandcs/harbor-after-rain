import { Bot as SimBot } from './sim/bots.js';
import { attachActorView, actorViewMethods } from './actor-view.js';
export { DIFF, BOT_NAMES } from './sim/bots.js';

export class Bot extends SimBot {
  constructor(game, options) {
    super(game, options);
    attachActorView(this, game);
  }
}
Object.assign(Bot.prototype, actorViewMethods);
