import assert from 'node:assert/strict';

const distribution = (values) => {
  if (!values.length) return null;
  const a = values.toSorted((x, y) => x - y);
  return {
    count: a.length,
    p50: a[Math.floor(a.length * 0.5)],
    p95: a[Math.floor(a.length * 0.95)],
    p99: a[Math.floor(a.length * 0.99)],
    max: a.at(-1),
  };
};

/** Integrate the latest applied state's linearly growing age over wall time.
 * Unlike packet percentiles, a delivery burst cannot multiply its weight. */
function timeWeightedAge(peer, started, duration) {
  const fullDuration = duration;
  duration = Math.min(duration, peer.closedAtMs ?? duration);
  const segments = [];
  let at = 0,
    source = peer.initialNowMs;
  for (const row of peer.observations) {
    const end = Math.min(duration, row.appliedAtMs);
    if (end > at) segments.push({ length: end - at, age: started + at - source });
    at = end;
    source = row.nowMs;
  }
  if (duration > at) segments.push({ length: duration - at, age: started + at - source });
  const minimum = Math.min(...segments.map((s) => s.age)),
    maximum = Math.max(...segments.map((s) => s.age + s.length));
  const percentile = (q) => {
    let low = minimum,
      high = maximum;
    for (let i = 0; i < 48; i++) {
      const mid = (low + high) / 2;
      const time = segments.reduce(
        (sum, s) => sum + Math.max(0, Math.min(s.length, mid - s.age)),
        0,
      );
      if (time >= duration * q) high = mid;
      else low = mid;
    }
    return high;
  };
  return {
    durationMs: duration,
    excludedAfterCloseMs: fullDuration - duration,
    p95: percentile(0.95),
    p99: percentile(0.99),
    max: maximum,
  };
}

export function summarizeObservations(report, kernel) {
  const interrupted = kernel.transitions.find((t) => t.loss === 100),
    restored = kernel.transitions.find((t) => t.loss === 0),
    faultAt = interrupted?.appliedAtMs ?? interrupted?.atMs,
    restoredAt = restored?.appliedAtMs ?? restored?.atMs;
  const phases = interrupted
    ? [
        ['before-fault', 0, faultAt],
        ['fault', faultAt, restoredAt],
        ['after-restoration', restoredAt, report.durationMs],
      ]
    : [['steady', 0, report.durationMs]];
  return {
    identity: report.identity,
    topology: kernel.topology,
    seed: kernel.seed,
    metricChangesDoNotReplaceExistingGates: true,
    peers: report.peers.map((peer) => {
      const rows = peer.observations;
      const ticks = new Set(),
        regular = rows.filter((r) => {
          const key = `${r.stageId}:${r.tick}`;
          if (!r.regularTick || ticks.has(key)) return false;
          ticks.add(key);
          return true;
        });
      assert.ok(rows.length > 0 && rows.length <= 2000);
      for (const row of rows) {
        assert.ok(
          row.arrivedAtMs <= row.decodedAtMs &&
            row.decodedAtMs <= row.committedAtMs &&
            row.committedAtMs <= row.appliedAtMs,
          'measurement stages must be ordered',
        );
        assert.ok(
          Math.abs(row.actualAppliedAgeMs - (report.startedAtMs + row.appliedAtMs - row.nowMs)) <
            1e-6,
        );
      }
      let lastDisplay = null,
        heldSince = null,
        maxHeldMs = 0,
        backwards = 0;
      for (const d of peer.displayObservations) {
        if (
          lastDisplay &&
          d.stageId === lastDisplay.stageId &&
          d.sampleTimeMs < lastDisplay.sampleTimeMs - 1e-6
        )
          backwards++;
        if (
          lastDisplay &&
          d.a === d.b &&
          d.a === lastDisplay.a &&
          lastDisplay.a === lastDisplay.b
        ) {
          heldSince ??= lastDisplay.atMs;
          maxHeldMs = Math.max(maxHeldMs, d.atMs - heldSince);
        } else heldSince = null;
        lastDisplay = d;
      }
      const fresh =
        restoredAt === undefined
          ? null
          : regular.findIndex((row, i) => {
              const next = regular.slice(i, i + 3);
              return (
                row.appliedAtMs >= restoredAt &&
                next.length === 3 &&
                next.every((r) => r.actualAppliedAgeMs <= 50 && r.stageId === row.stageId) &&
                new Set(next.map((r) => r.tick)).size === 3
              );
            });
      const sent = new Map(peer.sentFrames.map((f) => [f.seq, f.atMs]));
      const executed =
        restoredAt === undefined
          ? null
          : report.inputExecutions.find(
              (e) => e.actorId === peer.actorId && sent.has(e.seq) && sent.get(e.seq) >= restoredAt,
            );
      const acknowledged =
        executed && rows.find((r) => r.ackSeq >= executed.seq && r.appliedAtMs >= executed.atMs);
      return {
        index: peer.index,
        packetCount: rows.length,
        regularDistinctTicks: regular.length,
        additionalPublications: rows.length - regular.length,
        consecutiveDeliveriesWithin1ms: rows.filter(
          (r, i) => i > 0 && r.arrivedAtMs - rows[i - 1].arrivedAtMs < 1,
        ).length,
        applicationAgeTimeWeightedMs: timeWeightedAge(peer, report.startedAtMs, report.durationMs),
        phases: phases.map(([name, start, end]) => {
          const selected = rows.filter((r) => r.appliedAtMs >= start && r.appliedAtMs < end);
          return {
            name,
            regularCount: regular.filter((r) => r.appliedAtMs >= start && r.appliedAtMs < end)
              .length,
            allPublicationCount: selected.length,
            startMs: start,
            endMs: end,
            arrivalAgeMs: distribution(selected.map((r) => r.actualArrivalAgeMs)),
            appliedAgeMs: distribution(selected.map((r) => r.actualAppliedAgeMs)),
            estimatedAgeMs: distribution(selected.map((r) => r.estimatedAgeMs)),
            clockErrorMs: distribution(selected.map((r) => r.offsetErrorMs)),
            absoluteClockErrorMs: distribution(selected.map((r) => Math.abs(r.offsetErrorMs))),
            decodeMs: distribution(selected.map((r) => r.decodeMs)),
            commitMs: distribution(selected.map((r) => r.commitMs)),
            predictionMs: distribution(selected.map((r) => r.predictionMs)),
          };
        }),
        display: {
          samples: peer.displayObservations.length,
          backwards,
          longestUnchangedHeldMs: maxHeldMs,
        },
        recovery:
          restoredAt === undefined
            ? null
            : {
                restoredAtMs: restoredAt,
                freshStateMs:
                  fresh !== null && fresh >= 0 ? regular[fresh + 2].appliedAtMs - restoredAt : null,
                executedNewInputMs: executed ? executed.atMs - restoredAt : null,
                acknowledgedExecutedInputMs: acknowledged
                  ? acknowledged.appliedAtMs - restoredAt
                  : null,
              },
      };
    }),
  };
}
