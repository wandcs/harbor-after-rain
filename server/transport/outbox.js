/** A single replaceable logical snapshot; important messages stay ordered and
 * bounded. TCP bytes already sent are deliberately not considered cancellable. */
export class Outbox {
  constructor(socket, config, now) {
    this.socket = socket;
    this.config = config;
    this.now = now;
    this.important = [];
    this.bytes = 0;
    this.snapshot = null;
    this.blockedAt = null;
    // Keep the first limit cause until the owning connection's close handler.
    this.failureReason = null;
  }
  add(text) {
    const bytes = Buffer.byteLength(text);
    if (
      this.bytes + bytes > this.config.maxQueueBytes ||
      this.important.length >= this.config.maxQueueCount
    ) {
      this.failureReason ??=
        this.bytes + bytes > this.config.maxQueueBytes
          ? 'IMPORTANT_QUEUE_BYTES_LIMIT'
          : 'IMPORTANT_QUEUE_COUNT_LIMIT';
      this.socket.terminate();
      return false;
    }
    this.important.push(text);
    this.bytes += bytes;
    this.flush();
    return true;
  }
  latest(text, onSent) {
    this.snapshot = { text, onSent };
    this.flush();
  }
  flush() {
    if (this.socket.readyState !== 1) return;
    if (this.socket.bufferedAmount > this.config.maxBufferedBytes) {
      this.blockedAt ??= this.now();
      if (this.now() - this.blockedAt > this.config.maxBacklogMs) {
        this.failureReason ??= 'SEND_BACKLOG_TIMEOUT';
        this.socket.terminate();
      }
      return;
    }
    this.blockedAt = null;
    while (this.important.length && this.socket.bufferedAmount <= this.config.maxBufferedBytes) {
      const text = this.important.shift();
      this.bytes -= Buffer.byteLength(text);
      this.socket.send(text);
    }
    if (
      !this.important.length &&
      this.snapshot &&
      this.socket.bufferedAmount <= this.config.maxBufferedBytes
    ) {
      const { text, onSent } = this.snapshot;
      this.snapshot = null;
      this.socket.send(text);
      onSent();
    }
  }
  clear() {
    this.important = [];
    this.snapshot = null;
    this.bytes = 0;
  }
}
