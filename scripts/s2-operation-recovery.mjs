import assert from 'node:assert/strict';

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(check, label, ms = 5000) {
  const deadline = performance.now() + ms;
  while (!(await check())) {
    if (performance.now() > deadline) throw new Error(`Recovery observation timeout: ${label}`);
    await sleep(20);
  }
}
async function clockMap(page) {
  const samples = [];
  for (let i = 0; i < 5; i++) {
    const before = performance.now(),
      client = await page.evaluate(() => performance.now()),
      after = performance.now();
    samples.push({ offsetMs: (before + after) / 2 - client, uncertaintyMs: (after - before) / 2 });
  }
  return samples.sort((a, b) => a.uncertaintyMs - b.uncertaintyMs)[0];
}

async function installStageDiagnostics(page) {
  await page.evaluate(() => {
    const g = window.__game,
      s = g.session;
    const d = (window.__operationDiagnostics = {
      wires: [],
      work: [],
      longTasks: [],
      states: [],
      environment: {},
    });
    let recording = true,
      current = null,
      observer;
    const add = (rows, value, max = 2000) => {
      if (!recording) return;
      if (rows.length >= max) throw new Error('Browser diagnostic bound');
      rows.push(value);
    };
    const state = () =>
      add(
        d.states,
        {
          atMs: performance.now(),
          visibility: document.visibilityState,
          focus: document.hasFocus(),
        },
        64,
      );
    state();
    document.addEventListener('visibilitychange', state);
    window.addEventListener('focus', state);
    window.addEventListener('blur', state);
    const gl = document.getElementById('c').getContext('webgl2');
    const debug = gl?.getExtension('WEBGL_debug_renderer_info');
    d.environment = {
      timeOrigin: performance.timeOrigin,
      userAgent: navigator.userAgent,
      hardwareConcurrency: navigator.hardwareConcurrency,
      devicePixelRatio: window.devicePixelRatio,
      webglRenderer: debug
        ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)
        : gl?.getParameter(gl.RENDERER),
      webglVendor: debug
        ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL)
        : gl?.getParameter(gl.VENDOR),
      longTaskSupported: PerformanceObserver.supportedEntryTypes.includes('longtask'),
    };
    if (d.environment.longTaskSupported) {
      observer = new PerformanceObserver((list) => {
        for (const e of list.getEntries())
          add(d.longTasks, { atMs: e.startTime, durationMs: e.duration, name: e.name }, 128);
      });
      observer.observe({ type: 'longtask', buffered: false });
    }
    const wire = s.receiveWire.bind(s),
      receive = s.receive.bind(s),
      snapshot = g.receiveSnapshot.bind(g);
    s.receiveWire = (...args) => {
      if (!recording) return wire(...args);
      const previous = current;
      const row = {
        id: d.wires.length + 1,
        atMs: performance.now(),
        bytes: args[0].byteLength ?? args[0].length,
      };
      add(d.wires, row);
      current = row;
      try {
        return wire(...args);
      } finally {
        row.endMs = performance.now();
        current = previous;
      }
    };
    s.receive = (message, ...args) => {
      if (current) {
        current.decodedAtMs = performance.now();
        current.type = message.type;
        current.seq = message.public?.snapshotSeq;
      }
      return receive(message, ...args);
    };
    g.receiveSnapshot = (...args) => {
      if (current) current.handlerAtMs = performance.now();
      try {
        return snapshot(...args);
      } finally {
        if (current) current.appliedAtMs = performance.now();
      }
    };
    for (const name of ['simulate', 'renderFrame']) {
      const original = g[name].bind(g);
      g[name] = (...args) => {
        if (!recording) return original(...args);
        const atMs = performance.now();
        try {
          return original(...args);
        } finally {
          add(d.work, { name, atMs, endMs: performance.now() });
        }
      };
    }
    const reconcile = g.prediction.reconcile.bind(g.prediction);
    g.prediction.reconcile = (...args) => {
      const atMs = performance.now();
      try {
        return reconcile(...args);
      } finally {
        if (current) current.reconcileMs = performance.now() - atMs;
      }
    };
    window.__stopOperationDiagnostics = () => {
      d.stoppedAtMs = performance.now();
      recording = false;
      observer?.disconnect();
      document.removeEventListener('visibilitychange', state);
      window.removeEventListener('focus', state);
      window.removeEventListener('blur', state);
    };
  });
}

/** Optional fault segment of S2-I1. Chrome's native network emulation retains
 * the WebSocket and queues traffic; this is not Linux packet loss or RTO proof. */
export async function observeOperationRecovery({
  app,
  pages,
  contexts,
  report,
  diagnostic = false,
  emulateOffline = true,
}) {
  assert.ok(emulateOffline || diagnostic, 'Online control requires stage diagnostics');
  const [page, healthy] = pages,
    room = app.room,
    match = room.match;
  const actor = match.actors.find((a) => a.id === report.joined[0].id);
  const connection = [...room.connections.values()].find((c) => c.actorId === actor.id);
  const healthyConnection = [...room.connections.values()].find((c) => c.actorId !== actor.id);
  const healthyLatest = healthyConnection.outbox.latest.bind(healthyConnection.outbox);
  const cdp = await contexts[0].newCDPSession(page);
  const observation = (report.operationRecovery = {
    kind: emulateOffline
      ? 'Chrome CDP 900ms offline emulation; native WebSocket traffic queued, no kernel packet-loss claim'
      : 'Chrome CDP online control with the same 900ms segment; no outage or recovery claim',
    faultInjected: emulateOffline,
    received: [],
    executed: [],
    shots: [],
    healthyPublications: [],
    diagnostic,
    endpoints: {
      impairedClientPort: connection.socket._socket.remotePort,
      healthyClientPort: healthyConnection.socket._socket.remotePort,
      serverPort: connection.socket._socket.localPort,
    },
  });
  const push = connection.inputs.push.bind(connection.inputs);
  const update = actor.update.bind(actor),
    onEvent = match.onEvent;
  let offline = false;
  try {
    await page.bringToFront();
    if (await page.evaluate(() => window.__game.localInterrupted))
      await page.locator('#btnResume').click();
    await page.locator('#btnOnlinePause').click();
    await Promise.all(
      pages.map((p) => p.waitForFunction(() => window.__game.netPhase === 'paused')),
    );
    // Prepare a fresh life away from the other human; normal input, simulation,
    // transport and weapon code run unchanged throughout the measured segment.
    for (const a of match.actors) {
      match.spawnActor(a);
      const spawn = match.map.spawns[a.team][a.id % 10];
      a.pos.set(spawn.x, 0, spawn.z);
      if (a.controlType === 'bot') for (const w of a.inv) w.mag = w.reserve = 0;
    }
    actor.pos.set(-3, 0, 6.8);
    actor.vel.set(0, 0, 0);
    actor.yaw = 0;
    actor.pitch = -0.1;
    room.publish();
    await page.waitForFunction((life) => window.__game.player.lifeId === life, actor.lifeId);
    observation.lifeId = actor.lifeId;
    observation.roomId = room.id;
    for (const p of pages)
      await p.evaluate(() => {
        const g = window.__game,
          s = g.session;
        const trace = (window.__operationRecovery = {
          frames: [],
          sends: [],
          snapshots: [],
          maxPending: 0,
          maxBuffered: 0,
        });
        const frame = s.frame.bind(s),
          send = s.send.bind(s),
          receive = g.receiveSnapshot.bind(g);
        s.frame = (...args) => {
          const value = frame(...args);
          if (value) {
            if (trace.frames.length >= 1500) throw new Error('Recovery frame bound');
            trace.frames.push({
              atMs: performance.now(),
              seq: value.seq,
              tick: value.tick,
              lifeId: value.lifeId,
              stageId: value.stageId,
              input: { ...value.input },
            });
          }
          trace.maxPending = Math.max(trace.maxPending, g.prediction.pending.length);
          trace.maxBuffered = Math.max(trace.maxBuffered, s.socket.bufferedAmount);
          return value;
        };
        s.send = (value) => {
          const sent = send(value);
          if (sent && value.type === 'input')
            trace.sends.push({ seq: value.seq, atMs: performance.now() });
          return sent;
        };
        g.receiveSnapshot = (snapshot, own) => {
          const result = receive(snapshot, own);
          if (trace.snapshots.length >= 1500) throw new Error('Recovery snapshot bound');
          trace.snapshots.push({
            atMs: performance.now(),
            seq: snapshot.snapshotSeq,
            tick: snapshot.tick,
            stageId: snapshot.stageId,
            lifeId: own.state.fields.lifeId,
            ackSeq: own.ackSeq,
          });
          return result;
        };
      });
    if (diagnostic) for (const p of pages) await installStageDiagnostics(p);
    connection.inputs.push = (...args) => {
      const result = push(...args),
        frame = args[0];
      assert.ok(observation.received.length < 1500);
      observation.received.push({
        atMs: performance.now(),
        seq: frame.seq,
        tick: frame.tick,
        currentTick: args[3],
        createdAtMs: frame.createdAtMs,
        reason: result,
        invalid: connection.inputs.queue.at(-1)?.invalid === true,
      });
      return result;
    };
    healthyConnection.outbox.latest = (data, onSent) => {
      const state = room.history.samples.at(-1);
      assert.ok(observation.healthyPublications.length < 1500);
      const row = { seq: state.snapshotSeq, atMs: performance.now() };
      observation.healthyPublications.push(row);
      return healthyLatest(data, () => {
        row.sentAtMs = performance.now();
        onSent?.();
      });
    };
    actor.update = (...args) => {
      const frame = actor.activeInput,
        result = update(...args);
      if (frame) {
        assert.ok(observation.executed.length < 1500);
        observation.executed.push({
          atMs: performance.now(),
          seq: frame.seq,
          tick: match.tick,
          lifeId: actor.lifeId,
          stageId: match.stageId,
          createdAtMs: frame.createdAtMs,
          reused: !!frame.reused,
          input: { ...frame.input },
          position: actor.pos.toArray(),
        });
      }
      return result;
    };
    match.onEvent = (event) => {
      if (event.type === 'shot' && event.actorId === actor.id)
        observation.shots.push({
          atMs: performance.now(),
          tick: event.tick,
          shotSeq: event.shotSeq,
          inputSeq: event.inputSeq,
          lifeId: event.lifeId,
        });
      onEvent(event);
    };
    await page.locator('#btnResume').click();
    await page.waitForFunction(() => window.__game.netPhase === 'running');
    if (diagnostic) {
      await healthy.waitForFunction(() => window.__game.netPhase === 'running');
      observation.stableRunningAtMs = performance.now();
      await sleep(1000);
      observation.stableRunningWarmupMs = performance.now() - observation.stableRunningAtMs;
    }
    observation.clockBefore = await clockMap(page);
    observation.healthyClock = await clockMap(healthy);
    await page.keyboard.down('KeyW');
    await page.mouse.down();
    await sleep(250);
    observation.before = await page.evaluate(() => ({
      socket: window.__game.session.socket.readyState,
      seq: window.__game.session.seq,
      room: window.__game.session.roomId,
      life: window.__game.player.lifeId,
    }));
    await cdp.send('Network.enable');
    observation.faultBeforeMs = performance.now();
    await cdp.send('Network.emulateNetworkConditions', {
      offline: emulateOffline,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });
    offline = emulateOffline;
    observation.faultAppliedMs = performance.now();
    await sleep(350);
    await page.keyboard.up('KeyW');
    await page.mouse.up();
    await sleep(Math.max(0, observation.faultAppliedMs + 900 - performance.now()));
    observation.restoreBeforeMs = performance.now();
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });
    offline = false;
    observation.restoreAfterMs = performance.now();
    observation.newActionBrowserMs = await page.evaluate(() => performance.now());
    observation.newActionHostMs = performance.now();
    observation.positionBeforeNewAction = actor.pos.toArray();
    await page.keyboard.down('KeyD');
    await sleep(350);
    await page.keyboard.up('KeyD');
    await until(
      () =>
        observation.executed.some(
          (e) => e.atMs >= observation.restoreAfterMs && !e.reused && e.input.moveX > 0,
        ),
      'new keyboard input executes',
    );
    observation.positionAfterNewAction = actor.pos.toArray();
    await page.mouse.down();
    await sleep(250);
    await page.mouse.up();
    await until(
      () => observation.shots.some((s) => s.atMs >= observation.newActionHostMs),
      'new mouse input fires',
    );
    await sleep(200);
    observation.measurementEndHostMs = performance.now();
    observation.clockAfter = await clockMap(page);
    if (diagnostic) {
      observation.healthyClockAfter = await clockMap(healthy);
      for (const p of pages) await p.evaluate(() => window.__stopOperationDiagnostics());
    }
    observation.client = await page.evaluate(() => ({
      ...window.__operationRecovery,
      socket: window.__game.session.socket.readyState,
      roomId: window.__game.session.roomId,
      lifeId: window.__game.player.lifeId,
      closed: !!window.__game.session.closed,
      resyncs: window.__game.session.recoveries,
      diagnostics: window.__operationDiagnostics,
    }));
    observation.healthy = await healthy.evaluate(() => ({
      ...window.__operationRecovery,
      diagnostics: window.__operationDiagnostics,
    }));
    const sendSeqs = new Set(observation.client.sends.map((s) => s.seq));
    const newFrames = observation.client.frames.filter(
      (f) => f.atMs >= observation.newActionBrowserMs && f.input.moveX > 0 && sendSeqs.has(f.seq),
    );
    const newSeqs = new Set(newFrames.map((f) => f.seq));
    const executed = observation.executed.find((e) => !e.reused && newSeqs.has(e.seq));
    assert.ok(executed, 'new browser input, not a reused hold or discard ACK, actually executes');
    const confirmed = observation.client.snapshots.find(
      (s) =>
        s.ackSeq >= executed.seq && s.lifeId === executed.lifeId && s.stageId === executed.stageId,
    );
    assert.ok(confirmed, 'paired authoritative state confirms the executed input');
    const first = observation.client.sends.find((s) => newSeqs.has(s.seq));
    observation.summary = {
      actualEmulatedBlackoutMs: emulateOffline
        ? observation.restoreBeforeMs - observation.faultAppliedMs
        : null,
      comparisonWindowMs: observation.restoreBeforeMs - observation.faultAppliedMs,
      firstNewInputSendMs:
        first.atMs + observation.clockBefore.offsetMs - observation.restoreAfterMs,
      firstNewInputExecutionMs: executed.atMs - observation.restoreAfterMs,
      executedInputConfirmationMs:
        confirmed.atMs + observation.clockBefore.offsetMs - observation.restoreAfterMs,
      executedSeq: executed.seq,
      executedTick: executed.tick,
      clockOffsetDriftMs: observation.clockAfter.offsetMs - observation.clockBefore.offsetMs,
      healthySnapshotsDuringFault: observation.healthy.snapshots.filter(
        (s) =>
          s.atMs + observation.healthyClock.offsetMs >= observation.faultAppliedMs &&
          s.atMs + observation.healthyClock.offsetMs < observation.restoreBeforeMs,
      ).length,
      delayedInputsDiscarded: observation.received.filter(
        (r) => r.atMs >= observation.restoreBeforeMs && r.invalid,
      ).length,
    };
    assert.equal(observation.client.socket, 1);
    assert.equal(observation.client.roomId, observation.before.room);
    assert.equal(observation.client.lifeId, observation.before.life);
    assert.equal(observation.client.closed, false);
    assert.ok(observation.client.maxPending <= 128 && observation.client.maxBuffered <= 65536);
    assert.ok(
      Math.hypot(
        ...observation.positionAfterNewAction.map(
          (v, i) => v - observation.positionBeforeNewAction[i],
        ),
      ) > 0.2,
      'authority moves from new key input',
    );
    const duringSegment = (row) =>
      row.atMs > observation.faultAppliedMs + 100 && row.atMs < observation.restoreBeforeMs;
    observation.offlineAssertionsApplied = emulateOffline;
    if (emulateOffline)
      assert.equal(
        observation.received.filter(duringSegment).length,
        0,
        'native-browser offline period blocks new input delivery',
      );
    else {
      assert.ok(observation.received.some(duringSegment), 'online control keeps delivering input');
      assert.ok(
        observation.executed.some((e) => duringSegment(e) && !e.reused),
        'online control keeps executing new input',
      );
    }
    assert.equal(
      observation.shots.filter(
        (s) => s.atMs > observation.faultAppliedMs + 450 && s.atMs < observation.restoreBeforeMs,
      ).length,
      0,
      'input silence stops automatic fire',
    );
    for (let i = 1; i < observation.shots.length; i++)
      assert.ok(
        observation.shots[i].tick - observation.shots[i - 1].tick >= 6,
        'no catchup fire burst',
      );
    const healthySteady = observation.healthy.snapshots.filter(
      (s) => s.atMs + observation.healthyClock.offsetMs >= observation.faultAppliedMs - 100,
    );
    observation.summary.healthyMaxSnapshotIntervalMs = Math.max(
      0,
      ...healthySteady.slice(1).map((s, i) => s.atMs - healthySteady[i].atMs),
    );
    const publications = observation.healthyPublications.filter(
      (p) => p.atMs >= observation.faultAppliedMs - 100,
    );
    observation.summary.healthyMaxPublicationIntervalMs = Math.max(
      0,
      ...publications.slice(1).map((p, i) => p.atMs - publications[i].atMs),
    );
    observation.functionalPassed = true;
    assert.ok(
      observation.summary.healthyMaxSnapshotIntervalMs <= 150,
      'original healthy-connection interval bound',
    );
    observation.passed = true;
  } finally {
    if (offline)
      await cdp
        .send('Network.emulateNetworkConditions', {
          offline: false,
          latency: 0,
          downloadThroughput: -1,
          uploadThroughput: -1,
        })
        .catch(() => {});
    connection.inputs.push = push;
    healthyConnection.outbox.latest = healthyLatest;
    actor.update = update;
    match.onEvent = onEvent;
    await page.keyboard.up('KeyW').catch(() => {});
    await page.keyboard.up('KeyD').catch(() => {});
    await page.mouse.up().catch(() => {});
    await cdp.detach();
  }
}
