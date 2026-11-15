import assert from 'node:assert/strict';

const relative = (value, base) => (value - base) >>> 0;
const maximum = (rows, key, initial = 0) => rows.reduce((n, r) => Math.max(n, r[key]), initial);
const stats = (values) => {
  const a = values.toSorted((x, y) => x - y);
  return {
    count: a.length,
    total: a.reduce((n, v) => n + v, 0),
    p95: a[Math.floor(a.length * 0.95)] ?? null,
    max: a.at(-1) ?? null,
  };
};

/** All times are observations, not counterfactual savings from a send window.
 * Outgoing ACKs originate at the receiver: unlike a data tap, they prove its
 * TCP progress. An ACK timestamp can lag app delivery (delayed/piggyback ACK). */
export function attributeTransport(report, kernel, capture) {
  assert.deepEqual(capture.errors, []);
  assert.equal(capture.packetSocketDrops, 0);
  assert.ok(capture.clockOffsetDriftMs <= 1);
  assert.equal(kernel.topology, 'ingress');
  const { serverPort, clientPort } = report.tcpFlow;
  assert.equal(clientPort, 45931);
  const raw = capture.packets.filter(
    (p) =>
      (p.sport === serverPort && p.dport === clientPort) ||
      (p.sport === clientPort && p.dport === serverPort),
  );
  const bases = Object.fromEntries(
    ['down', 'up'].map((direction) => {
      const syn = raw.find(
        (p) => !!(p.flags & 2) && (p.sport === serverPort) === (direction === 'down'),
      );
      assert.ok(syn, 'capture must include both SYNs');
      return [direction, (syn.seq + 1) >>> 0];
    }),
  );
  const packets = raw
    .map((p) => {
      const direction = p.sport === serverPort ? 'down' : 'up',
        opposite = direction === 'down' ? 'up' : 'down';
      return {
        atMs: p.monotonicMs - report.monotonicStartMs,
        direction,
        seq: relative(p.seq, bases[direction]),
        ack: relative(p.ack, bases[opposite]),
        bytes: p.bytes,
        flags: p.flags,
        sacks: p.sacks.map(([a, b]) => [
          relative(a, bases[opposite]),
          relative(b, bases[opposite]),
        ]),
      };
    })
    .sort((a, b) => a.atMs - b.atMs);
  const data = [],
    high = { down: 0, up: 0 };
  for (const p of packets.filter((p) => p.bytes > 0)) {
    assert.ok(p.bytes <= 1460, 'ingress calibration must retain MTU packetization');
    const end = p.seq + p.bytes,
      retransmittedBytes = Math.max(0, Math.min(end, high[p.direction]) - p.seq);
    data.push({ ...p, end, retransmittedBytes });
    high[p.direction] = Math.max(high[p.direction], end);
  }
  const down = data.filter((p) => p.direction === 'down'),
    receiver = packets.filter((p) => p.direction === 'up' && p.flags & 16),
    frames = report.tcpWrites.map((w) => ({
      ...w,
      sendAtMs: w.sendAtMs - report.startedAtMs,
      afterSendAtMs: w.afterSendAtMs - report.startedAtMs,
      queuedAtMs: w.queuedAtMs === undefined ? null : w.queuedAtMs - report.startedAtMs,
    })),
    snapshots = frames.filter((f) => f.snapshotSeq !== undefined),
    applied = report.peers[0].observations,
    writesBySeq = new Map(snapshots.map((f) => [f.snapshotSeq, f])),
    appliedBySeq = new Map(applied.map((r) => [r.seq, r])),
    firstEmit = (end) => down.find((p) => p.end >= end),
    firstAck = (end) => receiver.find((p) => p.ack >= end);
  for (const row of applied) {
    const frame = writesBySeq.get(row.seq);
    assert.ok(frame, 'every measured snapshot must map to an actual send interval');
    const emitted = firstEmit(frame.endByte),
      ack = firstAck(frame.endByte);
    assert.ok(emitted && ack, 'captured TCP must cover every applied frame');
    assert.ok(emitted.atMs <= row.arrivedAtMs + 1, 'app cannot receive unsent bytes');
    assert.ok(ack.atMs >= emitted.atMs - 1, 'ACK cannot precede sender emission');
  }
  const freshLimit = kernel.profile === 'loss' ? 100 : 50;
  const boundary = (at) => {
    const initialSeq =
      snapshots.find((f) => f.nowMs === report.peers[0].initialNowMs)?.snapshotSeq ??
      applied[0].seq - 1;
    const lastAppliedSeq = maximum(
      applied.filter((r) => r.appliedAtMs <= at),
      'seq',
      initialSeq,
    );
    const submitted = frames.filter((f) => f.afterSendAtMs <= at),
      sent = down.filter((p) => p.atMs <= at),
      acks = receiver.filter((p) => p.atMs <= at),
      pending = snapshots.filter((f) => f.afterSendAtMs <= at && f.snapshotSeq > lastAppliedSeq),
      submittedEnd = maximum(submitted, 'endByte'),
      emittedEnd = maximum(sent, 'end'),
      ackEnd = maximum(acks, 'ack'),
      stale = pending.filter((f) => report.startedAtMs + at - f.nowMs > freshLimit),
      lastPending = pending.at(-1),
      lastStale = stale.at(-1);
    return {
      atMs: at,
      submittedEndByte: submittedEnd,
      emittedEndByte: emittedEnd,
      receiverAckByte: ackEnd,
      submittedButNotEmittedBytes: Math.max(0, submittedEnd - emittedEnd),
      emittedUnconfirmedBytes: Math.max(0, emittedEnd - ackEnd),
      pendingSnapshots: pending.length,
      pendingSnapshotBytes: pending.reduce((n, f) => n + f.endByte - f.startByte, 0),
      stalePendingSnapshots: stale.length,
      stalePendingSnapshotBytes: stale.reduce((n, f) => n + f.endByte - f.startByte, 0),
      pendingLastSeq: lastPending?.snapshotSeq ?? null,
      pendingLastFirstEmittedAtMs: lastPending
        ? (firstEmit(lastPending.endByte)?.atMs ?? null)
        : null,
      pendingLastAckAtMs: lastPending ? (firstAck(lastPending.endByte)?.atMs ?? null) : null,
      pendingLastAppliedAtMs: appliedBySeq.get(lastPending?.snapshotSeq)?.appliedAtMs ?? null,
      staleLastSeq: lastStale?.snapshotSeq ?? null,
      staleLastAppliedAtMs: appliedBySeq.get(lastStale?.snapshotSeq)?.appliedAtMs ?? null,
      pendingApplicationWorkMs: pending.reduce((n, f) => {
        const r = appliedBySeq.get(f.snapshotSeq);
        return n + (r ? (r.decodeMs ?? 0) + (r.commitMs ?? 0) + (r.predictionMs ?? 0) : 0);
      }, 0),
    };
  };
  // Receiver SACK advertises a later range while its cumulative ACK is stuck.
  // Split on cumulative progress; consecutive missing ranges remain explicit.
  const gaps = [];
  let open = null,
    progress = 0,
    progressAt = null;
  for (const p of receiver) {
    if (open && p.ack > open.ackByte) {
      gaps.push({ ...open, releasedAtMs: p.atMs, releasedAckByte: p.ack });
      open = null;
    }
    if (p.ack > progress) {
      progress = p.ack;
      progressAt = p.atMs;
    }
    if (!open && p.sacks.some(([, end]) => end > p.ack))
      open = {
        firstSackAtMs: p.atMs,
        ackByte: p.ack,
        lastProgressAtMs: progressAt,
        sackEndByte: Math.max(...p.sacks.map(([, end]) => end)),
      };
  }
  const unionDuration = (intervals, from, to) => {
    let end = from,
      result = 0;
    for (const [a, b] of intervals.sort((x, y) => x[0] - y[0])) {
      const start = Math.max(from, a, end),
        stop = Math.min(to, b);
      if (stop > start) {
        result += stop - start;
        end = stop;
      }
    }
    return result;
  };
  const gapIntervals = gaps.map((g) => [g.firstSackAtMs, g.releasedAtMs]);
  const drain = (at) => {
    const b = boundary(at),
      until = b.pendingLastAppliedAtMs;
    return {
      ...b,
      drainUntilMs: until,
      backlogDrainWallMs: until === null ? null : Math.max(0, until - at),
      staleBacklogDrainWallMs:
        b.staleLastAppliedAtMs === null ? null : Math.max(0, b.staleLastAppliedAtMs - at),
      overlapsLaterSackGapMs: until === null ? null : unionDuration(gapIntervals, at, until),
    };
  };
  const episodes = gaps
    .filter((g) => g.firstSackAtMs >= 0 && g.releasedAtMs <= report.durationMs)
    .map((g) => ({
      ...g,
      receiverHoleMs: g.releasedAtMs - g.firstSackAtMs,
      retransmissions: down
        .filter(
          (p) =>
            p.retransmittedBytes > 0 &&
            p.atMs >= g.firstSackAtMs - 50 &&
            p.atMs <= g.releasedAtMs &&
            p.seq <= g.ackByte &&
            p.end > g.ackByte,
        )
        .map((p) => ({
          atMs: p.atMs,
          seq: p.seq,
          end: p.end,
          retransmittedBytes: p.retransmittedBytes,
        })),
      afterRelease: drain(g.releasedAtMs),
    }));
  const restored = kernel.transitions.find((t) => t.loss === 0)?.appliedAtMs;
  let interruption = null;
  if (restored !== undefined) {
    const atRestore = boundary(restored),
      ack = receiver.find((p) => p.atMs >= restored && p.ack > atRestore.receiverAckByte),
      first = applied.find((r) => r.arrivedAtMs >= restored),
      fresh = applied.findIndex(
        (r, i) =>
          r.arrivedAtMs >= restored &&
          applied.slice(i, i + 3).length === 3 &&
          applied
            .slice(i, i + 3)
            .every((v) => v.regularTick && v.actualAppliedAgeMs <= freshLimit) &&
          new Set(applied.slice(i, i + 3).map((v) => v.tick)).size === 3,
      );
    assert.ok(ack && first && fresh >= 0, 'recovery must actually progress');
    const missing = atRestore.receiverAckByte;
    const missingRetransmissions = down.filter(
      (p) => p.retransmittedBytes > 0 && p.seq <= missing && p.end > missing,
    );
    const retry = missingRetransmissions.find((p) => p.atMs >= restored);
    assert.ok(retry, 'recovery must correlate to a retransmitted missing byte');
    const atFirst = drain(first.appliedAtMs);
    interruption = {
      restoredAtMs: restored,
      atRestore,
      missingByteRetransmissions: missingRetransmissions.map((p) => ({
        atMs: p.atMs,
        seq: p.seq,
        end: p.end,
      })),
      restoreToMissingByteRetransmitMs: retry.atMs - restored,
      retransmitToFirstCompleteSnapshotMs: first.appliedAtMs - retry.atMs,
      firstReceiverAckProgressAtMs: ack.atMs,
      restoreToReceiverProgressMs: ack.atMs - restored,
      firstCompleteSnapshotAtMs: first.appliedAtMs,
      restoreToFirstCompleteSnapshotMs: first.appliedAtMs - restored,
      firstSnapshotSeq: first.seq,
      atFirstCompleteSnapshot: atFirst,
      firstSnapshotToFirstAckMs: Math.max(0, ack.atMs - first.appliedAtMs),
      firstAckToPendingDrainMs:
        atFirst.drainUntilMs === null ? null : Math.max(0, atFirst.drainUntilMs - ack.atMs),
      freshThirdAtMs: applied[fresh + 2].appliedAtMs,
      restoreToFreshThirdMs: applied[fresh + 2].appliedAtMs - restored,
    };
  }
  const inWindow = (p) => p.atMs >= 0 && p.atMs <= report.durationMs;
  const tcpRecoverySamples =
    kernel.tcpQueues?.flatMap((q) => {
      const lines = q.text.split('\n'),
        result = [];
      const local = new RegExp(`127\\.0\\.0\\.1:${serverPort}\\s+127\\.0\\.0\\.1:${clientPort}\\b`);
      for (let i = 0; i + 1 < lines.length; i++)
        if (local.test(lines[i]))
          result.push({
            atMs: q.atMs,
            fields: Object.fromEntries(
              [...lines[i + 1].matchAll(/\b(rto|backoff|cwnd|unacked|retrans):([^\s]+)/g)].map(
                (m) => [m[1], m[2]],
              ),
            ),
          });
      return result;
    }) ?? [];
  return {
    identity: report.identity,
    hz: report.hz,
    profile: kernel.profile,
    seed: kernel.seed,
    flow: report.tcpFlow,
    capture: {
      packets: raw.length,
      drops: capture.packetSocketDrops,
      clockOffsetDriftMs: capture.clockOffsetDriftMs,
    },
    mappedAppliedSnapshots: applied.length,
    freshnessDiagnosticLimitMs: freshLimit,
    ackDelayAfterAppMs: stats(
      applied.map((r) => firstAck(writesBySeq.get(r.seq).endByte).atMs - r.appliedAtMs),
    ),
    retransmittedPackets: Object.fromEntries(
      ['down', 'up'].map((d) => [
        d,
        data.filter((p) => p.direction === d && inWindow(p) && p.retransmittedBytes > 0).length,
      ]),
    ),
    senderFrames: { count: frames.length, maxBufferedAmount: maximum(frames, 'bufferedAmount') },
    receiverSackHoles: stats(episodes.map((e) => e.receiverHoleMs)),
    excludedSackHoles: gaps.length - episodes.length,
    unfinishedSackHole: open,
    postGapBacklogDrain: stats(
      episodes.map((e) => e.afterRelease.backlogDrainWallMs).filter((v) => v !== null),
    ),
    postGapStaleDrain: stats(
      episodes.map((e) => e.afterRelease.staleBacklogDrainWallMs).filter((v) => v !== null),
    ),
    tcpRecoverySamples,
    interruption,
    episodes,
    limits: [
      'Outgoing packet timestamps prove emission; ACK/SACK prove receiver progress, not application commit.',
      'ACK timestamps may lag application delivery; ACK-delay distribution is retained.',
      'Post-release drain includes normal transit, later retransmissions and app scheduling; it is not pure queue cost or guaranteed window savings.',
      'Warmup or unfinished SACK intervals are not included in complete measurement episodes.',
    ],
  };
}
