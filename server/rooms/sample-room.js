import { CombatMatch } from '../../src/sim/combat-match.js';
import { saveActor } from '../../src/sim/actor-state.js';
import { encodeMessage } from '../../src/protocol/messages.js';
import {
  encodePublicState,
  decodePublicState,
  encodeSnapshot,
  encodePublicFragment,
} from '../../src/protocol/compact.js';
import { InputQueue } from '../sync/input-queue.js';
import { SnapshotHistory } from '../sync/history.js';
import { deflateBlock } from '../transport/deflate.js';

export class SampleRoom {
  constructor(config, now, { id = 1, mode = 'tdm', teamSize = 4, password = '' } = {}) {
    this.id = id;
    this.password = password;
    this.capacity = teamSize * 2;
    this.config = config;
    this.now = now;
    this.connections = new Map();
    this.activity = {
      createdAtMs: now(),
      humanJoins: 0,
      humanLeaves: 0,
      peakHumans: 0,
      abnormalDisconnects: 0,
    };
    this.summaryLogged = false;
    this.snapshotSeq = 0;
    this.history = new SnapshotHistory(config);
    this.lastStage = 1;
    this.nextFullAt = 0;
    this.match = new CombatMatch({
      roomId: id,
      mode,
      teamSize,
      onEvent: (event) => this.broadcast({ type: 'event', event }),
      resolveTargets: (actor, input) =>
        this.history.select(this.match, actor, input, this.now(), this.connections.get(actor.id)),
    });
  }
  broadcast(message) {
    if (message.type === 'event' && message.event.type === 'shot') {
      const event = { ...message.event };
      // Core events retain rewind diagnostics; presentation consumes the resolved ray.
      for (const key of ['inputSeq', 'display', 'reused', 'path', 'reason']) delete event[key];
      message = { ...message, event };
    }
    const text = encodeMessage({ ...message, roomId: this.id }, { compress: deflateBlock });
    for (const connection of this.connections.values()) connection.outbox.add(text);
  }
  roster(connection) {
    if (connection.rosterVersion === this.match.nextId) return;
    connection.rosterVersion = this.match.nextId;
    connection.outbox.add(
      encodeMessage({
        type: 'roster',
        version: connection.rosterVersion,
        actors: this.match.actors.map(({ id, name, team, controlType }) => ({
          id,
          name,
          team,
          controlType,
        })),
      }),
    );
  }
  join(connection, name, primary) {
    const actor = this.match.join(name, primary);
    connection.actorId = actor.id;
    connection.roomId = this.id;
    connection.inputs = new InputQueue(this.config);
    connection.sentSnapshotSeq = 0;
    connection.rosterVersion = null;
    connection.sentSnapshots = new Set();
    this.resetBases(connection);
    connection.resyncs = 0;
    this.connections.set(actor.id, connection);
    this.activity.humanJoins++;
    this.activity.peakHumans = Math.max(this.activity.peakHumans, this.connections.size);
    connection.outbox.add(
      encodeMessage({
        type: 'joined',
        actorId: actor.id,
        roomId: this.id,
        config: {
          snapshotHz: this.config.snapshotHz,
          bufferMs: this.config.bufferMs,
          inputFreshMs: this.config.inputFreshMs,
        },
      }),
    );
    this.publish();
  }
  leave(connection) {
    if (!this.connections.delete(connection.actorId)) return;
    this.activity.humanLeaves++;
    this.match.leave(connection.actorId);
    connection.actorId = null;
    connection.roomId = null;
    connection.inputs.clear();
    connection.sentSnapshots.clear();
    this.resetBases(connection);
    connection.outbox.clear();
    this.publish();
  }
  step(dt, nowMs) {
    const inputs = new Map();
    for (const [id, connection] of this.connections) {
      const actor = this.match.actors.find((value) => value.id === id);
      inputs.set(
        id,
        connection.inputs.consume(actor, this.match.stageId, this.match.tick + 1, nowMs),
      );
    }
    this.match.step(dt, nowMs, inputs);
    if (this.match.stageId !== this.lastStage) {
      this.lastStage = this.match.stageId;
      this.history.clear();
      for (const connection of this.connections.values()) connection.inputs.clear();
    }
    if (this.match.tick % (60 / this.config.snapshotHz) === 0 || this.match.phase !== 'running')
      this.publish();
  }
  publish() {
    if (!this.connections.size) return;
    const state = this.match.publicState(++this.snapshotSeq, this.now());
    const publicWire = {
      ...state,
      rosterVersion: this.match.nextId,
      actors: state.actors.map(({ name, team, controlType, ...actor }) => {
        void name;
        void team;
        void controlType;
        return actor;
      }),
    };
    // Encode common state once; combine it with each private correction without
    // reserializing all public actors for every recipient.
    const shared = encodePublicState(publicWire);
    const decoded = decodePublicState(shared);
    this.history.add({
      ...decoded,
      actors: decoded.actors.map((actor, i) => ({ ...state.actors[i], ...actor })),
    });
    const boundary = `${state.stageId}:${this.match.nextId}`;
    const lifeStamp = state.actors.map((a) => `${a.id}/${a.lifeId}/${a.alive}`).join(',');
    const lifeChanged = lifeStamp !== this.lifeStamp;
    this.lifeStamp = lifeStamp;
    if (boundary !== this.baseBoundary) {
      this.baseBoundary = boundary;
      for (const c of this.connections.values()) this.resetBases(c);
    }
    const fullDue = state.nowMs >= this.nextFullAt;
    if (fullDue) this.nextFullAt = state.nowMs + 500;
    const fragments = new Map();
    for (const [id, connection] of this.connections) {
      this.roster(connection);
      const actor = this.match.actors.find((value) => value.id === id);
      const own = {
        snapshotSeq: state.snapshotSeq,
        actorId: id,
        ackSeq: connection.inputs.ackSeq,
        activeInput: actor.activeInput,
        state: saveActor(actor),
      };
      const offer = !connection.offeredBase,
        reset = offer && connection.resetBase,
        base = fullDue || lifeChanged || connection.resetBase ? null : connection.activeBase,
        key = `${base?.seq || 0}/${offer}/${reset}`;
      if (!fragments.has(key))
        fragments.set(
          key,
          encodePublicFragment(shared, { base, offer, reset, compress: deflateBlock }),
        );
      connection.outbox.latest(
        encodeSnapshot(fragments.get(key), own, { compress: deflateBlock }),
        () => {
          if (connection.roomId !== this.id) return;
          if (offer) {
            connection.offeredBase = { seq: state.snapshotSeq, bytes: shared };
            connection.resetBase = false;
          }
          connection.sentSnapshotSeq = state.snapshotSeq;
          connection.sentSnapshots.add(state.snapshotSeq);
          while (connection.sentSnapshots.size > this.config.maxHistory)
            connection.sentSnapshots.delete(connection.sentSnapshots.values().next().value);
        },
      );
    }
  }
  resetBases(connection) {
    connection.activeBase = null;
    connection.offeredBase = null;
    connection.resetBase = true;
  }
  acknowledgeBase(connection, seq) {
    if (seq && connection.offeredBase?.seq === seq) {
      connection.activeBase = connection.offeredBase;
      connection.offeredBase = null;
    }
  }
  close() {
    this.history.clear();
    for (const c of this.connections.values()) this.resetBases(c);
    this.connections.clear();
    this.match.end('closed');
    this.match.actors = [];
    this.match.timers = [];
    this.match.nades = [];
  }
}
