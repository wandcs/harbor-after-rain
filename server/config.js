import { INPUT_FRESH_MS, MAX_FUTURE_TICKS } from '../src/sim/input.js';

/** Conservative local development limits; target-host capacity remains unverified. */
export function readConfig(env = process.env) {
  const number = (name, value, min, max) => {
    const parsed = env[name] === undefined ? value : Number(env[name]);
    if (!Number.isFinite(parsed) || parsed < min || parsed > max || !Number.isInteger(parsed))
      throw new Error(`Invalid ${name}`);
    return parsed;
  };
  const snapshotHz = number('SNAPSHOT_HZ', 60, 30, 60);
  if (![30, 60].includes(snapshotHz)) throw new Error('SNAPSHOT_HZ must be 30 or 60');
  return {
    host: env.HOST || '127.0.0.1',
    port: number('PORT', 4173, 0, 65535),
    snapshotHz,
    bufferMs: snapshotHz === 60 ? 1000 / 30 : 1000 / 15,
    rewindMs: snapshotHz === 60 ? 225 : 250,
    maxConnections: number('MAX_CONNECTIONS', 32, 1, 256),
    maxRooms: number('MAX_ROOMS', 2, 1, 32),
    maxPayload: 8192,
    maxMessagesPerSecond: 180,
    maxInputQueue: 64,
    inputFreshMs: INPUT_FRESH_MS,
    maxFutureTicks: MAX_FUTURE_TICKS,
    maxHistory: 32,
    maxBufferedBytes: 262144,
    maxQueueBytes: 65536,
    maxQueueCount: 128,
    maxBacklogMs: 2000,
    heartbeatMs: 1000,
    connectionTimeoutMs: 6000,
  };
}
