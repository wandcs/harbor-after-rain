import { WIRE_VERSION, encodeCompact, decodeCompact, isCompactMessage } from './compact.js';

export const PROTOCOL_VERSION = WIRE_VERSION;
export const IDENTITY = Object.freeze({
  protocol: PROTOCOL_VERSION,
  build: typeof HARBOR_BUILD_ID === 'undefined' ? 'development' : HARBOR_BUILD_ID,
  rules: typeof HARBOR_RULES_ID === 'undefined' ? 's2-development' : HARBOR_RULES_ID,
});
export const INPUT_FLAGS = Object.freeze([
  'fire',
  'firePressed',
  'alt',
  'jump',
  'crouch',
  'walk',
  'left',
  'right',
  'reload',
]);
const integer = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 1e9;
const finite = (value, min, max) =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Validates untrusted client messages before they reach room or simulation. */
export function validateClient(message) {
  if (!object(message) || typeof message.type !== 'string') return 'BAD_MESSAGE';
  if (message.type === 'hello')
    return object(message.identity) &&
      integer(message.identity.protocol) &&
      ['build', 'rules'].every(
        (key) => typeof message.identity[key] === 'string' && message.identity[key].length <= 96,
      )
      ? null
      : 'BAD_HELLO';
  if (message.type === 'clock')
    return integer(message.id) &&
      finite(message.clientMs, 0, 1e12) &&
      (message.baseAck === undefined || integer(message.baseAck))
      ? null
      : 'BAD_CLOCK';
  if (message.type === 'list') return null;
  if (['create', 'join'].includes(message.type)) {
    if (typeof message.name !== 'string' || message.name.length > 24) return 'BAD_NAME';
    if (message.primary !== undefined && !['m4a1', 'ak47', 'mp5', 'awm'].includes(message.primary))
      return 'BAD_LOADOUT';
    if (
      message.password !== undefined &&
      (typeof message.password !== 'string' || message.password.length > 32)
    )
      return 'BAD_PASSWORD';
    if (message.type === 'join')
      return integer(message.roomId) && message.roomId > 0 ? null : 'BAD_ROOM';
    return ['tdm', 'relay'].includes(message.mode) && [4, 5, 8].includes(message.teamSize)
      ? null
      : 'BAD_ROOM';
  }
  if (message.type === 'loadout')
    return ['m4a1', 'ak47', 'mp5', 'awm'].includes(message.primary) ? null : 'BAD_LOADOUT';
  if (['pause', 'resume', 'leave', 'interrupt'].includes(message.type)) return null;
  if (message.type === 'resync') return Object.keys(message).length === 1 ? null : 'BAD_MESSAGE';
  if (message.type !== 'input') return 'UNKNOWN_MESSAGE';
  const keys = [
    'type',
    'seq',
    'tick',
    'lifeId',
    'stageId',
    'createdAtMs',
    'display',
    'input',
    'baseAck',
  ];
  if (
    Object.keys(message).some((key) => !keys.includes(key)) ||
    !['seq', 'tick', 'lifeId', 'stageId'].every((key) => integer(message[key])) ||
    !finite(message.createdAtMs, 0, 1e12) ||
    (message.baseAck !== undefined && !integer(message.baseAck))
  )
    return 'BAD_INPUT';
  const input = message.input;
  if (
    !object(input) ||
    Object.keys(input).some(
      (key) =>
        !['yaw', 'pitch', 'moveX', 'moveZ', 'sw', 'altPressed', ...INPUT_FLAGS].includes(key),
    )
  )
    return 'BAD_INPUT';
  if (
    !finite(input.yaw, -Math.PI, Math.PI) ||
    !finite(input.pitch, -1.5, 1.5) ||
    !['moveX', 'moveZ'].every((key) => finite(input[key], -1, 1)) ||
    !INPUT_FLAGS.every((key) => typeof input[key] === 'boolean')
  )
    return 'BAD_INPUT';
  if (
    (input.sw !== undefined && input.sw !== null && ![0, 1, 2, 3].includes(input.sw)) ||
    (input.altPressed !== undefined && typeof input.altPressed !== 'boolean')
  )
    return 'BAD_INPUT';
  const ref = message.display;
  if (
    ref !== null &&
    (!object(ref) ||
      Object.keys(ref).some((key) => !['a', 'b', 'alpha'].includes(key)) ||
      !integer(ref.a) ||
      !integer(ref.b) ||
      ref.b < ref.a ||
      !finite(ref.alpha, 0, 1))
  )
    return 'BAD_DISPLAY';
  return null;
}

/** Binary high-frequency messages; bounded JSON controls. Never coerces bytes to text. */
export function decodeMessage(text, maxBytes = 131072, options = {}) {
  if (typeof text !== 'string') return decodeCompact(text, maxBytes, options);
  if (text.length > maxBytes || new globalThis.TextEncoder().encode(text).length > maxBytes)
    throw new Error('MESSAGE_TOO_LARGE');
  const value = JSON.parse(text);
  let count = 0;
  function visit(item, depth) {
    if (++count > 20000 || depth > 20) throw new Error('MESSAGE_TOO_COMPLEX');
    if (typeof item === 'number' && !Number.isFinite(item)) throw new Error('NON_FINITE');
    if (Array.isArray(item)) {
      if (item.length > 1024) throw new Error('ARRAY_TOO_LARGE');
      item.forEach((child) => visit(child, depth + 1));
    } else if (object(item))
      for (const [key, child] of Object.entries(item)) {
        if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('BAD_KEY');
        visit(child, depth + 1);
      }
  }
  visit(value, 0);
  if (value && isCompactMessage(value)) throw new Error('BINARY_REQUIRED');
  return value;
}
export function encodeMessage(message, options = {}) {
  if (isCompactMessage(message)) return encodeCompact(message, options);
  return JSON.stringify(message);
}
export function compatible(a, b = IDENTITY) {
  return ['protocol', 'build', 'rules'].every((key) => a?.[key] === b[key]);
}
