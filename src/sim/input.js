export const INPUT_FRESH_MS = 250;
export const MAX_FUTURE_TICKS = 30;

/** Shared eligibility and one-shot edge policy for authority and replay. */
export function validInputAt(frame, lifeId, stageId, nowMs, freshMs = INPUT_FRESH_MS) {
  return (
    frame &&
    frame.lifeId === lifeId &&
    frame.stageId === stageId &&
    nowMs - frame.createdAtMs <= freshMs &&
    frame.createdAtMs <= nowMs + 100
  );
}
export function releaseInputEdges(input) {
  return { ...input, firePressed: false, altPressed: false, sw: null, jump: false, reload: false };
}
