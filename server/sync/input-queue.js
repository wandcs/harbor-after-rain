import { releaseInputEdges, validInputAt } from '../../src/sim/input.js';

/** Ordered execution/discard frontier. Arrival never advances simulation time. */
export class InputQueue {
  constructor(config) {
    this.config = config;
    this.queue = [];
    this.receivedSeq = 0;
    this.ackSeq = 0;
    this.held = null;
    this.discarded = 0;
  }
  push(frame, actor, stageId, tick, nowMs) {
    if (frame.seq <= this.receivedSeq) return 'OLD_INPUT';
    if (frame.seq !== this.receivedSeq + 1) return 'INPUT_SEQUENCE';
    if (this.queue.length >= this.config.maxInputQueue) return 'INPUT_OVERFLOW';
    this.receivedSeq = frame.seq;
    if (
      !validInputAt(frame, actor.lifeId, stageId, nowMs, this.config.inputFreshMs) ||
      frame.tick <= tick ||
      frame.tick > tick + this.config.maxFutureTicks
    ) {
      this.queue.push({ ...frame, invalid: true });
      return null;
    }
    this.queue.push(frame);
    return null;
  }
  consume(actor, stageId, tick, nowMs) {
    let current = null;
    while (this.queue.length && (this.queue[0].invalid || this.queue[0].tick <= tick)) {
      const frame = this.queue.shift();
      this.ackSeq = frame.seq;
      if (
        !frame.invalid &&
        frame.tick === tick &&
        validInputAt(frame, actor.lifeId, stageId, nowMs, this.config.inputFreshMs) &&
        !current
      )
        current = frame;
      else this.discarded++;
    }
    if (current) this.held = current;
    const value = current || this.held;
    if (!validInputAt(value, actor.lifeId, stageId, nowMs, this.config.inputFreshMs)) {
      this.held = null;
      return null;
    }
    return current || { ...value, input: releaseInputEdges(value.input), reused: true };
  }
  clear() {
    if (this.queue.length) this.ackSeq = this.queue.at(-1).seq;
    this.queue = [];
    this.held = null;
  }
}
