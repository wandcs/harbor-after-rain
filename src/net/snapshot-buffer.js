import { sampleActors } from '../sim/pose-sample.js';

/** Only actual received endpoints can be cited by a shot. No extrapolated
 * render pose is advertised as an authoritative historical sample. */
export class SnapshotBuffer {
  constructor(limit = 32) {
    this.limit = limit;
    this.samples = [];
  }
  add(snapshot) {
    if (this.samples.at(-1)?.stageId !== snapshot.stageId) this.samples = [];
    if (this.samples.at(-1)?.snapshotSeq >= snapshot.snapshotSeq) return;
    this.samples.push(snapshot);
    while (this.samples.length > this.limit) this.samples.shift();
  }
  sample(timeMs) {
    if (!this.samples.length) return null;
    let a = this.samples[0],
      b = a;
    for (const next of this.samples) {
      b = next;
      if (next.nowMs >= timeMs) break;
      a = next;
    }
    const alpha = a === b ? 0 : Math.max(0, Math.min(1, (timeMs - a.nowMs) / (b.nowMs - a.nowMs)));
    return {
      actors: sampleActors(a, b, alpha),
      display: { a: a.snapshotSeq, b: b.snapshotSeq, alpha },
    };
  }
  clear() {
    this.samples = [];
  }
}
