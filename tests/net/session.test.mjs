import test from 'node:test';
import assert from 'node:assert/strict';
import { OnlineSession } from '../../src/net/session.js';
import {
  INPUT_FLAGS,
  IDENTITY,
  encodeMessage,
  decodeMessage,
} from '../../src/protocol/messages.js';
const input = Object.fromEntries(INPUT_FLAGS.map((key) => [key, false]));
test('a busy render callback waits within bounded prediction; only persistent snapshot loss closes the session', () => {
  let time = 0,
    closed = false;
  const s = new OnlineSession({ now: () => time, onStatus() {} });
  s.close = () => {
    closed = true;
  };
  s.offsetMs = 0;
  s.receivedAt = 0;
  s.actorId = 1;
  s.snapshot = { tick: 0, nowMs: 0, stageId: 1, actors: [{ id: 1, lifeId: 1 }] };
  time = 600;
  assert.equal(s.frame(input), null);
  assert.equal(closed, false);
  assert.equal(s.seq, 0);
  s.receivedAt = time;
  s.snapshot = { ...s.snapshot, tick: 36, nowMs: time };
  assert.equal(s.frame(input).tick, 39);
  assert.equal(s.seq, 1);
  time += 6001;
  assert.equal(s.frame(input), null);
  assert.equal(closed, true);
  // Receiving another old packet is not progress. Keep the existing busy-page
  // tolerance at the boundary, but reject persistently stale authority state.
  for (const source of ['arrival', 'authority'])
    for (const age of [5999, 6000, 6001]) {
      let staleClosed = false,
        notified = 0;
      const delayed = new OnlineSession({
        now: () => time,
        onStatus() {},
        onClose() {
          notified++;
        },
      });
      delayed.close = () => {
        staleClosed = true;
      };
      delayed.offsetMs = 0;
      delayed.receivedAt = source === 'arrival' ? time - age : time;
      delayed.actorId = 1;
      delayed.snapshot = {
        tick: 0,
        nowMs: source === 'authority' ? time - age : time,
        stageId: 1,
        actors: [{ id: 1, lifeId: 1 }],
      };
      assert.equal(delayed.checkFreshness(), age <= 6000, 'watchdog works without an input frame');
      assert.equal(!!delayed.frame(input), source === 'arrival' && age <= 6000);
      assert.equal(staleClosed, age > 6000, `${source} age=${age}`);
      assert.equal(
        notified,
        age > 6000 ? 1 : 0,
        'local failure notification does not wait for TCP close',
      );
      if (notified) {
        delayed.fail('again');
        assert.equal(notified, 1);
        assert.doesNotThrow(() => delayed.receive({ type: 'snapshot' }));
      }
    }
  let boundedNow = 0;
  const bounded = new OnlineSession({ now: () => boundedNow });
  bounded.offsetMs = 0;
  bounded.receivedAt = 0;
  bounded.actorId = 1;
  bounded.snapshot = { tick: 0, nowMs: 0, stageId: 1, actors: [{ id: 1, lifeId: 1 }] };
  for (let seq = 1; seq <= 28; seq++) {
    const frame = bounded.frame(input);
    assert.deepEqual([frame.seq, frame.tick], [seq, seq + 2]);
  }
  assert.equal(bounded.lastTarget, 30);
  assert.equal(bounded.frame(input), null);
  assert.deepEqual([bounded.seq, bounded.lastTarget, !!bounded.closed], [28, 30, false]);
  boundedNow = 500;
  bounded.receivedAt = 500;
  bounded.snapshot = { ...bounded.snapshot, tick: 30, nowMs: 500 };
  assert.deepEqual([bounded.frame(input).seq, bounded.lastTarget], [29, 33]);
  bounded.snapshot.phase = 'paused';
  bounded.snapshot.actors[0].dead = true;
  boundedNow += 5000;
  bounded.snapshot = { ...bounded.snapshot, nowMs: boundedNow };
  bounded.receivedAt = boundedNow;
  assert.equal(bounded.checkFreshness(), true, 'fresh paused/dead state remains legal');
  boundedNow += 6001;
  bounded.onStatus = () => {};
  assert.equal(
    bounded.checkFreshness(),
    false,
    'paused/dead state still detects a lost connection',
  );
});
test('display citations use the last actual render sample and cannot fabricate a fresh reference for held fire', () => {
  let time = 100;
  const s = new OnlineSession({ now: () => time });
  s.offsetMs = 0;
  s.receivedAt = time;
  s.actorId = 1;
  s.snapshot = { tick: 6, nowMs: time, stageId: 1, actors: [{ id: 1, lifeId: 1 }] };
  s.display = { a: 2, b: 3, alpha: 0.5 };
  const a = s.frame(input);
  time += 17;
  const b = s.frame(input);
  assert.deepEqual(a.display, b.display);
  assert.notEqual(a.tick, b.tick);
  s.clear();
  assert.equal(s.frame(input).display, null);
  for (const [rtt, lead] of [
    [0, 3],
    [50, 3],
    [100, 4],
    [150, 6],
  ]) {
    const scheduled = new OnlineSession({ now: () => time });
    scheduled.offsetMs = 0;
    scheduled.receivedAt = time;
    scheduled.actorId = 1;
    scheduled.rttMs = rtt;
    scheduled.snapshot = { tick: 6, nowMs: time, stageId: 1, actors: [{ id: 1, lifeId: 1 }] };
    assert.equal(
      scheduled.frame(input).tick,
      6 + lead,
      `RTT ${rtt}: leave one-way transit plus a scheduling step`,
    );
  }
  let clock = 100;
  const timed = new OnlineSession({ now: () => clock });
  const sent = [];
  timed.socket = {
    readyState: 1,
    bufferedAmount: 0,
    send: (text) => sent.push(decodeMessage(text)),
    close() {},
  };
  timed.clock();
  assert.deepEqual(sent, [{ type: 'clock', id: 1, clientMs: 100, baseAck: 0 }]);
  clock = 250;
  timed.receive({ type: 'clock', id: 99, nowMs: 9999 });
  assert.deepEqual([timed.rttMs, timed.offsetMs, timed.clocks.size], [0, null, 1]);
  timed.receive({ type: 'clock', id: 1, nowMs: 5000 });
  assert.deepEqual(
    [timed.rttMs, timed.offsetMs, timed.serverNow(), timed.clocks.size],
    [150, 4825, 5075, 0],
  );
  timed.receive({ type: 'clock', id: 1, nowMs: 1 });
  assert.deepEqual([timed.rttMs, timed.offsetMs], [150, 4825]);
  timed.actorId = 1;
  timed.receivedAt = 250;
  timed.snapshot = { tick: 300, nowMs: 5075, stageId: 1, actors: [{ id: 1, lifeId: 1 }] };
  assert.deepEqual([timed.frame(input).tick, timed.lastTarget], [306, 306]);
  const filtered = new OnlineSession({ now: () => clock });
  filtered.socket = timed.socket;
  const sync = (rtt, offset = 500, gap = 1000) => {
    clock += gap;
    const start = clock;
    filtered.clock();
    clock += rtt;
    filtered.receive({ type: 'clock', id: filtered.clockId, nowMs: start + rtt / 2 + offset });
  };
  for (let i = 0; i < 3; i++) sync(100);
  sync(2000, 1450);
  assert.equal(filtered.rttMs, 2000, 'raw spike remains available for diagnostics');
  assert.deepEqual(
    [filtered.offsetMs, filtered.inputRttMs, filtered.displayRttMs],
    [500, 100, 100],
    'one delayed clock reply cannot shift the clock, input lead or display delay',
  );
  sync(300);
  sync(300);
  assert.equal(filtered.inputRttMs, 300, 'sustained transit increase reaches input scheduling');
  assert.ok(filtered.displayRttMs > 100 && filtered.displayRttMs <= 300);
  sync(300, 650, 8001);
  assert.equal(filtered.offsetMs, 650, 'expired minimum-delay samples do not pin the clock');
  for (let i = 0; i < 12; i++) sync(300, 650, 1);
  assert.ok(filtered.clockEstimate.samples.length <= 8);
  filtered.clock();
  const oldId = filtered.clockId;
  clock += 10;
  filtered.clock();
  clock += 300;
  filtered.receive({ type: 'clock', id: filtered.clockId, nowMs: clock - 150 + 650 });
  const latest = [filtered.offsetMs, filtered.rttMs, filtered.inputRttMs];
  filtered.receive({ type: 'clock', id: oldId, nowMs: 999999 });
  filtered.receive({ type: 'clock', id: oldId, nowMs: 1 });
  filtered.receive({ type: 'clock', id: 999999, nowMs: 1 });
  assert.deepEqual([filtered.offsetMs, filtered.rttMs, filtered.inputRttMs], latest);
  assert.equal(filtered.clocks.size, 0);
  filtered.close();
  assert.equal(filtered.clockEstimate.samples.length, 0);
  for (const age of [7999, 8000, 8001]) {
    clock = 0;
    const expiring = new OnlineSession({ now: () => clock });
    expiring.socket = timed.socket;
    expiring.clock();
    expiring.receive({ type: 'clock', id: 1, nowMs: 100 });
    clock = age - 100;
    expiring.clock();
    clock = age;
    expiring.receive({ type: 'clock', id: 2, nowMs: age - 50 + 200 });
    assert.equal(expiring.offsetMs, age <= 8000 ? 100 : 200, `sample expiry age=${age}`);
    expiring.close();
  }
  const unanswered = new OnlineSession({ now: () => clock, onStatus() {} });
  unanswered.socket = { ...timed.socket, close() {} };
  for (let i = 0; i < 8; i++) unanswered.clock();
  assert.equal(unanswered.clocks.size, 8);
  unanswered.clock();
  assert.equal(unanswered.closed, true);
  assert.equal(unanswered.clocks.size, 0);
  for (const [hz, bufferMs, alpha] of [
    [60, 1000 / 30, 2 / 3],
    [30, 1000 / 15, 1 / 3],
  ]) {
    let displayClock = 250;
    const displayed = new OnlineSession({ now: () => displayClock });
    displayed.offsetMs = 4825;
    displayed.rttMs = 150;
    displayed.config = { snapshotHz: hz, bufferMs };
    displayed.buffer.add({ snapshotSeq: 1, stageId: 1, nowMs: 4900, actors: [] });
    displayed.buffer.add({ snapshotSeq: 2, stageId: 1, nowMs: 5000, actors: [] });
    const sample = displayed.sample();
    assert.deepEqual([sample.display.a, sample.display.b], [1, 2], `hz=${hz}`);
    assert.ok(Math.abs(sample.display.alpha - alpha) < 1e-9, `hz=${hz}`);
    const sampledTime = (value) => 4900 + 100 * value.display.alpha;
    const firstTime = sampledTime(sample);
    displayClock += 16;
    displayed.offsetMs -= 100;
    const nextTime = sampledTime(displayed.sample());
    assert.ok(nextTime >= firstTime, 'display time does not run backwards after clock correction');
    assert.ok(nextTime - firstTime <= 16 * 1.1 + 1e-8, 'display correction is bounded');
    displayed.offsetMs += 200;
    displayClock += 16;
    assert.ok(sampledTime(displayed.sample()) - nextTime <= 16 * 1.1 + 1e-8);
    displayed.buffer.add({ snapshotSeq: 3, stageId: 2, nowMs: 5200, actors: [] });
    assert.deepEqual(displayed.sample().display, { a: 3, b: 3, alpha: 0 });
  }
});

test('S3-C1 upstream backlog ends once and isolates delayed transport events', () => {
  const keys = ['WebSocket', 'location', 'clearInterval'];
  const descriptors = new Map(
    keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  const nativeClear = globalThis.clearInterval,
    cleared = [],
    sockets = [],
    statuses = [],
    closed = [];
  class Socket extends globalThis.EventTarget {
    constructor(url) {
      super();
      this.url = url;
      this.readyState = 0;
      this.bufferedAmount = 0;
      this.sent = [];
      this.closeCalls = 0;
      sockets.push(this);
    }
    send(text) {
      this.sent.push(text);
    }
    close() {
      this.closeCalls++;
      this.readyState = 2;
    }
    deliver(type, fields = {}) {
      if (type === 'open') this.readyState = 1;
      if (type === 'close') this.readyState = 3;
      this.dispatchEvent(Object.assign(new globalThis.Event(type), fields));
    }
  }
  let session;
  try {
    Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: Socket });
    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      value: { protocol: 'http:', host: 'fixture.invalid' },
    });
    Object.defineProperty(globalThis, 'clearInterval', {
      configurable: true,
      value: (timer) => {
        cleared.push(timer);
        nativeClear(timer);
      },
    });
    session = new OnlineSession({
      now: () => 100,
      onStatus: (status) => statuses.push(status),
      onClose: (reason) => closed.push(reason),
    });
    session.connect('测试');
    const socket = sockets[0];
    assert.equal(socket.url, 'ws://fixture.invalid/ws');
    socket.deliver('open');
    socket.deliver('message', { data: encodeMessage({ type: 'hello', identity: IDENTITY }) });
    assert.ok(session.clockTimer);
    assert.ok(session.healthTimer);
    const timers = [session.clockTimer, session.healthTimer];
    socket.deliver('message', { data: encodeMessage({ type: 'hello', identity: IDENTITY }) });
    assert.deepEqual(
      [session.clockTimer, session.healthTimer],
      timers,
      'one timer pair per connection',
    );
    assert.equal(session.clocks.size, 1);
    session.buffer.add({ snapshotSeq: 1, stageId: 1, nowMs: 100, actors: [] });
    socket.bufferedAmount = 65536;
    assert.equal(session.send({ type: 'interrupt' }), true);
    assert.deepEqual(decodeMessage(socket.sent.at(-1)), { type: 'interrupt' });
    const sentBefore = socket.sent.length;
    socket.bufferedAmount = 65537;
    assert.equal(session.send({ type: 'interrupt' }), false);
    assert.equal(socket.sent.length, sentBefore);
    assert.deepEqual(closed, ['上行持续积压，请重新加入']);
    assert.equal(socket.closeCalls, 1);
    assert.equal(session.closed, true);
    assert.equal(session.clocks.size, 0);
    assert.equal(session.buffer.samples.length, 0);
    assert.ok(cleared.includes(session.clockTimer));
    assert.ok(cleared.includes(session.healthTimer));
    const terminalStatuses = statuses.slice();
    socket.deliver('error');
    socket.deliver('message', { data: encodeMessage({ type: 'snapshot' }) });
    socket.deliver('close', { reason: 'delayed TCP close' });
    session.fail('repeat failure');
    assert.deepEqual(
      statuses,
      terminalStatuses,
      'ended session must not notify a later connection error',
    );
    assert.deepEqual(closed, ['上行持续积压，请重新加入']);
    assert.equal(session.send({ type: 'interrupt' }), false);
    assert.equal(socket.sent.length, sentBefore);
  } finally {
    nativeClear(session?.clockTimer);
    session?.close();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});
