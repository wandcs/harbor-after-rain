import { CharacterPose } from '../../src/sim/character-pose.js';
import { sampleActors, applyPoseSample } from '../../src/sim/pose-sample.js';

/** Bounded history of exact public samples, with per-room query rigs. */
export class SnapshotHistory {
  constructor(config) {
    this.config = config;
    this.samples = [];
    this.rigs = new Map();
  }
  add(snapshot) {
    this.samples.push(snapshot);
    while (this.samples.length > this.config.maxHistory) this.samples.shift();
  }
  clear() {
    this.samples = [];
    this.rigs.clear();
  }
  select(match, source, frame, nowMs, connection) {
    const current = (reason) => ({ actors: match.actors, path: 'current', reason });
    if (!frame?.display) return current('unsynchronized');
    const { a: aSeq, b: bSeq, alpha } = frame.display;
    const a = this.samples.find((sample) => sample.snapshotSeq === aSeq),
      b = this.samples.find((sample) => sample.snapshotSeq === bSeq);
    if (!a || !b) return current('sample-missing');
    if (
      a.stageId !== match.stageId ||
      b.stageId !== match.stageId ||
      a.phase !== 'running' ||
      b.phase !== 'running'
    )
      return current('stage-boundary');
    if (!connection.sentSnapshots.has(aSeq) || !connection.sentSnapshots.has(bSeq))
      return current('unsent-sample');
    const time = a.nowMs + (b.nowMs - a.nowMs) * alpha,
      age = nowMs - time;
    if (age < 0 || age > this.config.rewindMs) return current('outside-window');
    if (age > this.config.bufferMs + connection.rttMs + 1000 / 30 + 50)
      return current('connection-window');
    const actors = sampleActors(a, b, alpha);
    if (
      actors.some((actor) => {
        const live = match.actors.find((value) => value.id === actor.id);
        return !live || live.lifeId !== actor.lifeId || live.alive !== actor.alive;
      })
    )
      return current('life-boundary');
    const result = actors.map((actor) => {
      let pose = this.rigs.get(actor.id);
      if (!pose) {
        pose = new CharacterPose({ random: () => 0.5 });
        this.rigs.set(actor.id, pose);
      }
      applyPoseSample(pose, actor);
      return { ...actor, soldier: pose };
    });
    for (const id of this.rigs.keys())
      if (!match.actors.some((actor) => actor.id === id)) this.rigs.delete(id);
    // Shooter is excluded by identity as well as object reference in traceShot.
    return {
      actors: result.filter((actor) => actor.id !== source.id),
      path: 'history',
      reason: null,
    };
  }
}
