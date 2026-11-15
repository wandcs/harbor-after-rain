import { IDENTITY, compatible, decodeMessage, encodeMessage } from '../protocol/messages.js';
import { SnapshotBuffer } from './snapshot-buffer.js';
import { MAX_FUTURE_TICKS } from '../sim/input.js';
import { ClockEstimate } from './clock-estimate.js';

export class OnlineSession {
  constructor({
    onSnapshot,
    onEvent,
    onStatus,
    onJoined,
    onClose,
    onRooms,
    onResult,
    onLeft,
    onRejected,
    now = () => performance.now(),
  }) {
    Object.assign(this, {
      onSnapshot,
      onEvent,
      onStatus,
      onJoined,
      onClose,
      onRooms,
      onResult,
      onLeft,
      onRejected,
      now,
    });
    this.buffer = new SnapshotBuffer();
    this.seq = 0;
    this.clockId = 0;
    this.clocks = new Map();
    this.clockEstimate = new ClockEstimate();
    this.offsetMs = null;
    this.rttMs = 0;
    this.inputRttMs = null;
    this.displayRttMs = null;
    this.renderTimeMs = null;
    this.rosters = new Map();
    this.lastEventSeq = 0;
    this.display = null;
    this.actorId = null;
    this.snapshot = null;
    this.lastTarget = 0;
    this.bases = new Map();
    this.baseAck = 0;
    this.offeredBase = 0;
    this.recoveries = 0;
    this.recoveryAt = null;
  }
  connect(name = '玩家') {
    this.onStatus('正在连接…');
    this.socket = new WebSocket(
      `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`,
    );
    this.socket.binaryType = 'arraybuffer';
    this.socket.addEventListener('open', () => this.send({ type: 'hello', identity: IDENTITY }));
    this.socket.addEventListener('message', (event) => {
      this.receiveWire(event.data, name);
    });
    this.socket.addEventListener('close', (event) => {
      this.finish(this.failure || event.reason || '连接已关闭');
    });
    this.socket.addEventListener('error', () => {
      if (!this.closed) this.onStatus('连接失败，请检查服务地址');
    });
  }
  send(message) {
    if (this.socket?.readyState !== 1) return false;
    if (this.socket.bufferedAmount > 65536) {
      this.fail('上行持续积压，请重新加入');
      return false;
    }
    this.socket.send(encodeMessage(message));
    return true;
  }
  receiveWire(data, name) {
    if (this.closed) return;
    const meta = {};
    try {
      this.receive(decodeMessage(data, 131072, { bases: this.bases, meta }), name, meta);
    } catch (error) {
      if (error.message === 'MISSING_BASE') this.recoverSnapshot();
      else this.fail(error.message);
    }
  }
  receive(message, name, meta = {}) {
    if (this.closed) return;
    if (message.type === 'hello') {
      if (!compatible(message.identity)) throw new Error('版本不匹配，请刷新页面');
      if (this.ready) return;
      this.clock();
      if (this.closed) return;
      this.clockTimer = setInterval(() => this.clock(), 1000);
      this.healthTimer = setInterval(() => this.checkFreshness(), 100);
      this.ready = true;
      this.send({ type: 'list' });
    } else if (message.type === 'clock') {
      const sent = this.clocks.get(message.id);
      if (sent === undefined) return;
      this.clocks.delete(message.id);
      if (this.clockEstimate.observe(message.id, sent, this.now(), message.nowMs)) {
        this.rttMs = this.clockEstimate.rawRttMs;
        this.offsetMs = this.clockEstimate.offsetMs;
        this.inputRttMs = this.clockEstimate.inputRttMs;
        this.displayRttMs = this.clockEstimate.displayRttMs;
      }
    } else if (message.type === 'joined') {
      this.resetRound();
      this.actorId = message.actorId;
      this.roomId = message.roomId;
      this.config = message.config;
      this.onJoined(message);
    } else if (message.type === 'rooms') {
      this.onRooms?.(message.rooms);
    } else if (message.type === 'rejected') {
      this.onRejected?.(message.code);
    } else if (message.type === 'left') {
      this.resetRound();
      this.onLeft?.();
    } else if (message.type === 'result') {
      this.resetRound();
      this.onResult?.(message.result);
    } else if (message.type === 'roster') {
      this.rosters.set(message.version, message.actors);
      while (this.rosters.size > 4) this.rosters.delete(this.rosters.keys().next().value);
    } else if (message.type === 'snapshot') {
      if (this.actorId === null || (this.roomId && message.public.roomId !== this.roomId)) return;
      if (
        message.public.snapshotSeq !== message.own.snapshotSeq ||
        message.own.actorId !== this.actorId
      )
        throw new Error('UNPAIRED_SNAPSHOT');
      const roster = this.rosters.get(message.public.rosterVersion);
      if (!roster) throw new Error('ROSTER_MISSING');
      const snapshot = {
        ...message.public,
        actors: message.public.actors.map((actor) => ({
          ...roster.find((value) => value.id === actor.id),
          ...actor,
        })),
      };
      if (this.recoveryAt !== null && meta.publicBasis && !meta.publicBasis.baseSeq) {
        this.buffer.clear();
        this.display = null;
        this.renderTimeMs = null;
      }
      this.snapshot = snapshot;
      this.receivedAt = this.now();
      this.buffer.add(snapshot);
      this.commitBasis(meta.publicBasis, snapshot.snapshotSeq);
      this.onSnapshot(snapshot, message.own);
    } else if (message.type === 'event') {
      if (
        this.actorId === null ||
        (message.roomId && message.roomId !== this.roomId) ||
        message.event.eventSeq <= this.lastEventSeq
      )
        return;
      this.lastEventSeq = message.event.eventSeq;
      this.onEvent(message.event);
    } else if (message.type === 'error') {
      this.fail(message.code === 'VERSION_MISMATCH' ? '版本不匹配，请刷新页面' : message.code);
    }
  }
  resetRound() {
    this.resetBases();
    this.recoveryAt = null;
    this.recoveries = 0;
    clearTimeout(this.recoveryTimer);
    this.actorId = null;
    this.roomId = null;
    this.snapshot = null;
    this.seq = 0;
    this.lastTarget = 0;
    this.lastEventSeq = 0;
    this.display = null;
    this.renderTimeMs = null;
    this.buffer.clear();
    this.rosters.clear();
  }
  clock() {
    if (this.closed) return;
    if (this.clocks.size >= 8) {
      this.fail('时钟同步超时，请重新加入');
      return;
    }
    const id = ++this.clockId,
      clientMs = this.now();
    this.clocks.set(id, clientMs);
    this.send({ type: 'clock', id, clientMs, baseAck: this.baseAck });
    if (this.ready && this.actorId === null) this.send({ type: 'list' });
  }
  serverNow() {
    return this.offsetMs === null ? (this.snapshot?.nowMs ?? 0) : this.now() + this.offsetMs;
  }
  checkFreshness() {
    if (this.closed) return false;
    if (this.recoveryAt !== null) {
      if (this.now() - this.recoveryAt > 3000) this.fail('状态恢复超时，请重新加入');
      return false;
    }
    if (!this.snapshot || this.actorId === null) return true;
    if (this.now() - this.receivedAt > 6000 || this.serverNow() - this.snapshot.nowMs > 6000) {
      this.fail('状态同步超时，请重新加入');
      return false;
    }
    return true;
  }
  frame(input) {
    if (this.closed || !this.snapshot || this.offsetMs === null) return null;
    if (!this.checkFreshness()) return null;
    // Reach the assigned step after one-way transit, with one scheduling step.
    // Preserve the original minimum lead and the existing future-window bound.
    const lead = Math.max(3, Math.ceil(((this.inputRttMs ?? this.rttMs) * 60) / 2000 + 1));
    const tick = Math.max(
      this.lastTarget + 1,
      this.snapshot.tick +
        Math.floor(((this.serverNow() - this.snapshot.nowMs) * 60) / 1000) +
        lead,
    );
    if (tick > this.snapshot.tick + MAX_FUTURE_TICKS) {
      // A busy/returning page can briefly process its render callback before
      // queued snapshots. Stop predicting rather than sending future inputs
      // or treating that scheduling order as a failed connection.
      this.skippedInputs = (this.skippedInputs || 0) + 1;
      return null;
    }
    this.lastTarget = tick;
    return {
      type: 'input',
      seq: ++this.seq,
      tick,
      lifeId: this.snapshot.actors.find((actor) => actor.id === this.actorId).lifeId,
      stageId: this.snapshot.stageId,
      createdAtMs: Math.max(0, this.serverNow()),
      display: this.display ? { ...this.display } : null,
      baseAck: this.baseAck,
      input,
    };
  }
  sample() {
    this.checkFreshness();
    if (this.closed) return null;
    const at = this.now(),
      stage = this.buffer.samples.at(-1)?.stageId,
      target =
        this.serverNow() -
        (this.displayRttMs ?? this.rttMs) / 2 -
        (this.config?.bufferMs || 1000 / 30);
    if (this.renderTimeMs === null || stage !== this.renderStage) this.renderTimeMs = target;
    else {
      const elapsed = Math.max(0, at - this.renderAtMs),
        next = this.renderTimeMs + elapsed,
        correction = Math.max(-elapsed * 0.1, Math.min(elapsed * 0.1, target - next));
      this.renderTimeMs = next + correction;
    }
    this.renderStage = stage;
    this.renderAtMs = at;
    const result = this.buffer.sample(this.renderTimeMs);
    this.display = result?.display || null;
    return result;
  }
  clear() {
    this.display = null;
    this.renderTimeMs = null;
    this.lastTarget = this.snapshot?.tick || 0;
  }
  resetBases() {
    this.bases.clear();
    this.baseAck = 0;
    this.offeredBase = 0;
  }
  commitBasis(basis, seq) {
    if (!basis) return;
    if (basis.reset) this.resetBases();
    if (basis.offer) {
      if (this.offeredBase)
        for (const key of this.bases.keys()) if (key !== this.offeredBase) this.bases.delete(key);
      this.offeredBase = seq;
      this.baseAck = seq;
      this.bases.set(seq, basis.bytes);
    } else if (basis.baseSeq === this.offeredBase && this.offeredBase) {
      this.offeredBase = 0;
      for (const key of this.bases.keys()) if (key !== basis.baseSeq) this.bases.delete(key);
    }
    if (!basis.baseSeq && this.recoveryAt !== null) {
      this.recoveryAt = null;
      clearTimeout(this.recoveryTimer);
    }
  }
  recoverSnapshot() {
    if (this.closed || this.recoveryAt !== null) return;
    if (this.recoveries >= 2) {
      this.fail('状态恢复失败，请重新加入');
      return;
    }
    this.recoveries++;
    this.recoveryAt = this.now();
    this.resetBases();
    this.send({ type: 'resync' });
    if (this.closed) return;
    this.recoveryTimer = setTimeout(() => this.fail('状态恢复超时，请重新加入'), 3000);
  }
  fail(reason) {
    if (this.closed) return;
    this.failure = reason;
    this.onStatus(reason);
    this.close();
    this.finish(reason);
  }
  finish(reason) {
    if (this.closed) return;
    this.closed = true;
    this.resetBases();
    clearTimeout(this.recoveryTimer);
    clearInterval(this.clockTimer);
    clearInterval(this.healthTimer);
    this.buffer.clear();
    this.clocks.clear();
    this.clockEstimate.clear();
    this.onClose?.(reason);
  }
  close() {
    this.resetBases();
    clearTimeout(this.recoveryTimer);
    clearInterval(this.clockTimer);
    clearInterval(this.healthTimer);
    this.clocks.clear();
    this.clockEstimate.clear();
    this.socket?.close();
  }
}
