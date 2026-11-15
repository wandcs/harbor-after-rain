import { WebSocket } from 'ws';
import { performance } from 'node:perf_hooks';
import { OnlineSession } from '../../src/net/session.js';
import { INPUT_FLAGS } from '../../src/protocol/messages.js';

export const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
export async function until(check, label, timeout = 5000) {
  const end = performance.now() + timeout;
  while (!check()) {
    if (performance.now() >= end) throw new Error('Timeout: ' + label);
    await sleep(5);
  }
}
/** Real session/frame/display algorithms; no renderer or predicted physics.
 * The generator and authority run in different processes during measurements. */
export async function connectPeer(url) {
  const peer = {
    controls: [],
    snapshots: 0,
    inputs: 0,
    bytesIn: 0,
    bytesOut: 0,
    bytesByType: {},
    own: null,
    closed: null,
  };
  const push = (type, value) => {
    peer.controls.push({ type, ...value });
    if (peer.controls.length > 64) peer.controls.shift();
  };
  const session = (peer.session = new OnlineSession({
    onStatus() {},
    onRooms: (rooms) => push('rooms', { rooms }),
    onJoined: (value) => {
      peer.own = null;
      push('joined', value);
    },
    onRejected: (code) => push('rejected', { code }),
    onLeft: () => {
      peer.own = null;
      push('left');
    },
    onResult: (result) => {
      peer.own = null;
      push('result', { result });
    },
    onSnapshot: (snapshot, own) => {
      const now = performance.now();
      if (peer.joinStarted !== undefined) {
        (peer.joinMs ||= []).push(now - peer.joinStarted);
        delete peer.joinStarted;
      }
      if (
        peer.measure &&
        snapshot.phase === 'running' &&
        snapshot.snapshotSeq !== peer.measure.seq &&
        snapshot.tick !== peer.measure.tick &&
        snapshot.tick % (60 / session.config.snapshotHz) === 0
      ) {
        const m = peer.measure;
        if (m.ages.length >= 10000) throw new Error('quality sample bound');
        m.ages.push(session.serverNow() - snapshot.nowMs);
        m.gaps.push(now - m.lastAt);
        m.lastAt = now;
        m.seq = snapshot.snapshotSeq;
        m.tick = snapshot.tick;
        const bucket = Math.floor((now - m.started) / 10000);
        const shots = own.state.stats.shots;
        m.shots[bucket] = (m.shots[bucket] || 0) + Math.max(0, shots - m.lastShots);
        m.lastShots = shots;
      }
      peer.snapshots++;
      peer.maxBases = Math.max(peer.maxBases || 0, session.bases?.size || 0);
      peer.maxBaseBytes = Math.max(
        peer.maxBaseBytes || 0,
        [...(session.bases?.values() || [])].reduce((n, b) => n + b.length, 0),
      );
      peer.own = own;
      peer.latest = snapshot;
    },
    onEvent(event) {
      if (peer.measure && event.type === 'reload' && event.actorId === session.actorId)
        peer.measure.reloads++;
    },
    onClose: (reason) => {
      peer.closed = reason;
      peer.closedAt = performance.now();
      push('closed', { reason });
    },
  }));
  const receive = session.receive.bind(session);
  session.receive = (message, ...args) => {
    peer.wireType =
      message.type === 'event'
        ? `event:${message.event.type}`
        : message.type === 'snapshot'
          ? `snapshot:${args[1]?.publicBasis?.baseSeq ? 'delta' : 'full'}`
          : message.type;
    return receive(message, ...args);
  };
  const descriptors = new Map(
    ['WebSocket', 'location'].map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]),
  );
  try {
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      value: class extends WebSocket {
        constructor() {
          super(url, { handshakeTimeout: 3000 });
        }
      },
    });
    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      value: { protocol: 'http:', host: new URL(url).host },
    });
    session.connect();
  } finally {
    for (const [key, d] of descriptors) {
      if (d) Object.defineProperty(globalThis, key, d);
      else delete globalThis[key];
    }
  }
  const socket = session.socket,
    send = socket.send.bind(socket);
  socket.send = (wire) => {
    peer.bytesOut += Buffer.byteLength(wire);
    return send(wire);
  };
  socket.addEventListener('message', (e) => {
    const bytes = Buffer.byteLength(e.data);
    peer.bytesIn += bytes;
    peer.maxMessageBytes = Math.max(peer.maxMessageBytes || 0, bytes);
    peer.bytesByType[peer.wireType] = (peer.bytesByType[peer.wireType] || 0) + bytes;
  });
  peer.send = (value) => session.send(value);
  peer.take = async (type, predicate = () => true) => {
    const matches = (m) => m.type === type && predicate(m);
    await until(() => peer.controls.some(matches) || !!peer.closed, type);
    const index = peer.controls.findIndex(matches);
    if (index < 0) throw new Error('Closed before ' + type + ': ' + peer.closed);
    return peer.controls.splice(index, 1)[0];
  };
  peer.request = async (message, type = 'joined') => {
    if (['create', 'join'].includes(message.type)) peer.joinStarted = performance.now();
    peer.send(message);
    return peer.take(type);
  };
  peer.step = () => {
    const snapshot = session.snapshot;
    if (!snapshot || snapshot.phase !== 'running' || !peer.own) return;
    session.sample();
    const angle =
      snapshot.tick / (peer.sustained ? 16 : 120) + (peer.sustained ? session.actorId * 0.71 : 0);
    let moveX = Math.sin(angle) * 0.5,
      moveZ = Math.cos(angle) * 0.5;
    if (peer.sustained) {
      const own = peer.own.state;
      if (peer.anchorLife !== own.fields.lifeId) {
        peer.anchor = [...own.pos];
        peer.anchorLife = own.fields.lifeId;
      }
      moveX = Math.max(-0.7, Math.min(0.7, peer.anchor[0] + Math.sin(angle) - own.pos[0]));
      moveZ = Math.max(-0.7, Math.min(0.7, peer.anchor[2] + Math.cos(angle) - own.pos[2]));
      const weapon = own.weapons[0],
        at = performance.now();
      if (weapon.reserve === 0 && weapon.mag < 3 && at - (peer.lastLoadout || 0) > 1000) {
        peer.send({ type: 'loadout', primary: 'm4a1' });
        peer.lastLoadout = at;
      }
    }
    const input = {
      yaw: peer.own.state.fields.yaw,
      pitch: -0.1,
      moveX,
      moveZ,
      ...Object.fromEntries(INPUT_FLAGS.map((k) => [k, false])),
      fire: true,
    };
    const frame = session.frame(input);
    if (frame && session.send(frame)) peer.inputs++;
  };
  peer.close = async () => {
    session.close();
    try {
      await until(() => socket.readyState === 3, 'socket cleanup', 2000);
    } finally {
      clearInterval(session.clockTimer);
      socket.terminate();
    }
  };
  try {
    await until(() => (session.ready && session.offsetMs !== null) || !!peer.closed, 'hello/clock');
    if (peer.closed) throw new Error(peer.closed);
    return peer;
  } catch (e) {
    await peer.close();
    throw e;
  }
}
