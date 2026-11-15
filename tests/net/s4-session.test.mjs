import test from 'node:test';
import assert from 'node:assert/strict';
import { OnlineSession } from '../../src/net/session.js';
import { IDENTITY, decodeMessage, encodeMessage } from '../../src/protocol/messages.js';
import { CombatMatch } from '../../src/sim/combat-match.js';
import { saveActor } from '../../src/sim/actor-state.js';
import { Prediction } from '../../src/net/prediction.js';

test('S4-C1 lobby rejection and settlement reuse transport with clean room state', () => {
  const sent = [],
    errors = [],
    results = [],
    events = [],
    snapshots = [];
  const s = new OnlineSession({
    now: () => 100,
    onStatus() {},
    onJoined() {},
    onRooms() {},
    onLeft() {},
    onResult: (r) => results.push(r),
    onRejected: (r) => errors.push(r),
    onEvent: (e) => events.push(e),
    onSnapshot: (x) => snapshots.push(x),
  });
  s.socket = {
    readyState: 1,
    bufferedAmount: 0,
    send: (wire) => sent.push(decodeMessage(wire)),
    close() {},
  };
  const socket = s.socket;
  try {
    s.receive({ type: 'hello', identity: IDENTITY });
    assert.ok(sent.some((m) => m.type === 'list'));
    assert.ok(!sent.some((m) => m.type === 'join'));
    s.receive({ type: 'rejected', code: 'WRONG_PASSWORD' });
    assert.deepEqual(errors, ['WRONG_PASSWORD']);
    assert.equal(!!s.closed, false);
    for (const roomId of [1, 2]) {
      s.receive({ type: 'joined', actorId: 9, roomId, config: {} });
      s.receive({ type: 'roster', version: 10, actors: [{ id: 9, team: 'BL' }] });
      const message = {
        type: 'snapshot',
        public: {
          roomId,
          snapshotSeq: 1,
          rosterVersion: 10,
          stageId: 1,
          tick: 0,
          nowMs: 100,
          actors: [{ id: 9, lifeId: 1 }],
        },
        own: { actorId: 9, snapshotSeq: 1 },
      };
      s.receive(message);
      assert.equal(s.snapshot.roomId, roomId);
      s.receive({ type: 'event', roomId, event: { eventSeq: 1, type: 'phase' } });
      s.seq = 100;
      s.lastTarget = 100;
      if (roomId === 1) s.receive({ type: 'left' });
      else s.receive({ type: 'result', result: { roomId, winner: null } });
      assert.deepEqual(
        [s.actorId, s.snapshot, s.seq, s.lastTarget, s.lastEventSeq, s.buffer.samples.length],
        [null, null, 0, 0, 0, 0],
      );
      s.receive(message);
      assert.equal(s.snapshot, null);
    }
    assert.equal(events.length, 2);
    assert.equal(snapshots.length, 2);
    assert.equal(results.length, 1);
    assert.equal(s.socket, socket);
    assert.equal(!!s.closed, false);
  } finally {
    s.close();
    clearInterval(s.clockTimer);
  }
});

test('S4-C2 full weapon replay restores state without duplicating melee and throw effects', () => {
  const reconcile = (prediction, publicState, ownState) => {
    const wire = decodeMessage(
      encodeMessage({ type: 'snapshot', public: publicState, own: ownState }),
    );
    prediction.reconcile(wire.public, wire.own);
  };
  for (const primary of ['m4a1', 'ak47', 'mp5', 'awm']) {
    const m = new CombatMatch({ teamSize: 1 }),
      a = m.join('A', primary);
    m.actors = [a];
    a.readyAt = 0;
    const p = new Prediction(m.world),
      effects = [];
    p.onEffect = (e) => effects.push(e.type);
    const base = m.publicState(1, 0),
      own = { snapshotSeq: 1, actorId: a.id, ackSeq: 0, state: saveActor(a), activeInput: null };
    reconcile(p, base, own);
    const frames = [];
    for (let tick = 1; tick <= 25; tick++) {
      const frame = {
        type: 'input',
        tick,
        seq: tick,
        lifeId: a.lifeId,
        stageId: m.stageId,
        createdAtMs: (tick * 1000) / 60,
        display: null,
        input: { yaw: a.yaw, pitch: 0, fire: true, firePressed: tick === 1 },
      };
      frames.push(frame);
      p.submit(frame);
      m.step(1 / 60, (tick * 1000) / 60, new Map([[a.id, frame]]));
    }
    const before = p.state(),
      count = effects.length;
    reconcile(p, base, own);
    assert.deepEqual(p.state(), before);
    assert.equal(effects.length, count);
    assert.deepEqual(p.state().weapons, saveActor(a).weapons, primary);
    let tick = 25,
      snapshotSeq = 1;
    for (const slot of [2, 3, 3, 3]) {
      const snap = m.publicState(++snapshotSeq, (tick * 1000) / 60);
      const correction = { snapshotSeq, actorId: a.id, ackSeq: tick, state: saveActor(a) };
      reconcile(p, snap, correction);
      const start = tick;
      for (; tick < start + 30;) {
        tick++;
        const frame = {
          ...frames[0],
          tick,
          seq: tick,
          createdAtMs: (tick * 1000) / 60,
          input: { sw: slot, alt: slot === 2, firePressed: slot === 3, fire: slot === 3 },
        };
        p.submit(frame);
        m.step(1 / 60, (tick * 1000) / 60, new Map([[a.id, frame]]));
      }
      const state = p.state(),
        n = effects.length;
      reconcile(p, snap, correction);
      assert.deepEqual(p.state(), state);
      assert.equal(effects.length, n);
      assert.deepEqual(p.state().weapons, saveActor(a).weapons);
    }
    assert.ok(effects.includes('melee'), primary);
    assert.equal(effects.filter((e) => e === 'grenade').length, 1, primary);
    assert.equal(a.inv[3].mag, 0);
  }
});
