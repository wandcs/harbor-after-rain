/** Bounded clock observations. Minimum transit selects the offset; a recent
 * median follows sustained RTT changes without promoting one retransmission. */
export class ClockEstimate {
  constructor() {
    this.clear();
  }
  clear() {
    this.samples = [];
    this.lastId = 0;
    this.displayRttMs = null;
  }
  observe(id, sent, received, serverMs) {
    if (id <= this.lastId || received < sent || received - sent > 8000) return false;
    this.lastId = id;
    this.rawRttMs = received - sent;
    this.samples = this.samples.filter((s) => received - s.sent <= 8000);
    this.samples.push({ sent, rtt: this.rawRttMs, offset: serverMs - (sent + received) / 2 });
    if (this.samples.length > 8) this.samples.shift();
    const best = this.samples.reduce((a, b) => (b.rtt <= a.rtt ? b : a));
    this.offsetMs = best.offset;
    const recent = this.samples
      .slice(-3)
      .map((s) => s.rtt)
      .sort((a, b) => a - b);
    this.inputRttMs = recent[Math.floor((recent.length - 1) / 2)];
    this.displayRttMs =
      this.displayRttMs === null
        ? this.inputRttMs
        : this.displayRttMs + (this.inputRttMs - this.displayRttMs) / 4;
    return true;
  }
}
