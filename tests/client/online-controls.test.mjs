import test from 'node:test';
import assert from 'node:assert/strict';
import { URLSearchParams } from 'node:url';
import { OnlineGame } from '../../src/client/online-game.js';
import { OnlineSession } from '../../src/net/session.js';
import { Prediction } from '../../src/net/prediction.js';
import { CombatMatch } from '../../src/sim/combat-match.js';
import { saveActor } from '../../src/sim/actor-state.js';
import { decodeMessage, encodeMessage } from '../../src/protocol/messages.js';

test('S2-N3 local interruption and global pause keep separate request scopes', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { pointerLockElement: null },
  });
  const match = new CombatMatch({ teamSize: 1 }),
    actor = match.join('human'),
    sent = [],
    screens = [];
  const game = Object.create(OnlineGame.prototype);
  Object.assign(actor, {
    keys: new Set(),
    pressed: new Set(),
    mouse: {},
    touch: {},
    touchLook: { x: 0, y: 0 },
    updateCamera() {},
  });
  Object.assign(game, {
    player: actor,
    actors: match.actors,
    rosterVersion: match.nextId,
    playing: true,
    ended: false,
    paused: false,
    localInterrupted: false,
    netPhase: 'running',
    qs: new URLSearchParams('nolock=1'),
    touch: { reset() {}, sync() {} },
    landscape: { ensureLandscape: () => true },
    hud: { show: (value) => screens.push(value), slots() {} },
    vm: { equip() {} },
    prediction: new Prediction(match.world),
  });
  let now = 1000;
  const session = new OnlineSession({
    now: () => now,
    onSnapshot: (state, own) => game.receiveSnapshot(state, own),
  });
  session.actorId = actor.id;
  session.socket = {
    readyState: 1,
    bufferedAmount: 0,
    send: (text) => sent.push(decodeMessage(text)),
    close() {},
  };
  game.session = session;
  const roster = match.actors.map(({ id, name, team, controlType }) => ({
    id,
    name,
    team,
    controlType,
  }));
  session.receive({ type: 'roster', version: match.nextId, actors: roster });
  let sequence = 0;
  const deliver = (phase, stageId) => {
    const state = {
      ...match.publicState(++sequence, now),
      phase,
      stageId,
      rosterVersion: match.nextId,
      resumeAtMs: phase === 'countdown' ? 4000 : null,
    };
    const own = { snapshotSeq: sequence, actorId: actor.id, ackSeq: 0, state: saveActor(actor) };
    session.receive(decodeMessage(encodeMessage({ type: 'snapshot', public: state, own })));
  };
  const hold = () => {
    actor.keys.add('KeyW');
    actor.pressed.add('KeyR');
    Object.assign(actor.mouse, { l: true, lp: true, dx: 12 });
    Object.assign(actor.touch, { fire: true, firePressed: true, mx: 1, mz: 1, jump: true });
    game.prediction.submit({
      seq: 1,
      tick: game.prediction.tick + 1,
      stageId: game.prediction.stageId,
      lifeId: actor.lifeId,
      createdAtMs: now,
      input: { fire: true },
    });
  };
  const quiet = () => {
    assert.equal(actor.keys.size, 0);
    assert.equal(actor.pressed.size, 0);
    assert.equal(actor.mouse.l, false);
    assert.equal(actor.touch.fire, false);
    assert.equal(actor.touch.mx, 0);
    assert.equal(game.prediction.pending.length, 0);
    assert.equal(game.prediction.held, null);
  };
  try {
    deliver('running', 1);
    hold();
    game.pause('input-interruption');
    quiet();
    assert.deepEqual(
      sent.map((value) => value.type),
      ['interrupt'],
    );
    assert.equal(game.localInterrupted, true);
    game.resume();
    quiet();
    assert.equal(game.paused, false);
    assert.equal(sent.length, 1);
    hold();
    game.pause('user');
    quiet();
    assert.deepEqual(
      sent.map((value) => value.type),
      ['interrupt', 'interrupt', 'pause'],
    );
    deliver('paused', 2);
    game.resume();
    assert.equal(game.paused, true);
    assert.equal(sent.at(-1).type, 'resume');
    deliver('countdown', 3);
    const count = sent.length;
    game.resume();
    assert.equal(sent.length, count);
    assert.equal(game.paused, true);
    now = 3999;
    assert.equal(game.paused, true);
    now = 4000;
    deliver('running', 4);
    quiet();
    assert.equal(game.paused, false);
    assert.equal(screens.at(-1), null);
  } finally {
    session.close();
    if (previous) Object.defineProperty(globalThis, 'document', previous);
    else delete globalThis.document;
  }
});
