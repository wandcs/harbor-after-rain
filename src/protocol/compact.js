// Complete, packet-independent schemas. No simulation imports or mutable bases.
import { BLOCK_BYTES, compressBlock, decompressBlock } from './blocks.js';
export const WIRE_VERSION = 9;
const MAGIC = 72;
const MAX_BYTES = 131072;
const encoder = new globalThis.TextEncoder();
const decoder = new globalThis.TextDecoder('utf-8', { fatal: true });
// Exact protocol literals, not a per-packet dictionary or rounded game rules.
const literals = [
  1 / 60,
  0.1,
  -0.1,
  0.2,
  0.3,
  -0.3,
  0.36,
  0.42,
  1.8,
  1.62,
  Math.PI / 2,
  -Math.PI / 2,
];
const literalIds = new Map(literals.map((value, i) => [value, i]));
const fail = (code) => {
  throw new Error(code);
};
const record = (definitions) => {
  let bools = 0;
  const fields = Object.entries(definitions).map(([name, type], i) => ({
    name,
    type,
    word: Math.floor(i / 30),
    bit: 2 ** (i % 30),
    bool: type === 'b' ? 2 ** bools++ : 0,
  }));
  return { kind: 'record', fields, names: new Set(Object.keys(definitions)), bools };
};
const numbers = (names) => Object.fromEntries(names.split(' ').map((name) => [name, 'n']));
const doubles = (names) => Object.fromEntries(names.split(' ').map((name) => [name, 'd']));
const tuple = (...items) => ({ kind: 'tuple', items });
const list = (item, max) => ({ kind: 'list', item, max });
const nullable = (item) => ({ kind: 'nullable', item });
const enumeration = (...values) => ({ kind: 'enum', values });
const vec3 = tuple('n', 'n', 'n');
const publicVec3 = tuple('f', 'f', 'f');
const publicQuat = tuple('f', 'f', 'f', 'f');
const team = enumeration('BL', 'GR');
const weapon = enumeration('ak47', 'm4a1', 'awm', 'mp5', 'deagle', 'knife', 'he');
const stats = record(numbers('k d hs shots hits'));
const publicScore = record(doubles('BL GR'));
const input = record({
  ...numbers('yaw pitch moveX moveZ'),
  fire: 'b',
  firePressed: 'b',
  alt: 'b',
  jump: 'b',
  crouch: 'b',
  walk: 'b',
  left: 'b',
  right: 'b',
  reload: 'b',
  sw: nullable('n'),
  altPressed: 'b',
});
const frame = record({
  type: enumeration('input'),
  ...numbers('seq tick lifeId stageId createdAtMs'),
  display: nullable(record(numbers('a b alpha'))),
  input,
  reused: 'b',
  baseAck: 'n',
});
const pose = record({
  dt: 'd',
  state: record({
    ...Object.fromEntries(
      'amp reloadPhase recoilK flinchPitch flinchRoll flinchHead'
        .split(' ')
        .map((name) => [name, 'f']),
    ),
    phase: 'f',
    crouchK: 'd',
  }),
  input: record({ speed: 'd', fwd: 'd', crouch: 'b', pitch: 'f', onGround: 'b', reloading: 'b' }),
});
const actor = record({
  ...doubles('id lifeId'),
  name: 's',
  team,
  controlType: enumeration('human', 'bot'),
  alive: 'b',
  ...doubles('hp armor protectT radarT'),
  pos: publicVec3,
  vel: publicVec3,
  yaw: 'f',
  pitch: 'f',
  weaponId: weapon,
  mag: 'd',
  reloading: 'b',
  stats: record(doubles('k d hs shots hits')),
  pose,
  corpse: nullable(record({ body: publicQuat, bones: list(tuple(publicVec3, publicQuat), 19) })),
});
const ownState = record({
  primary: weapon,
  nextPrimary: nullable(weapon),
  fields: record({
    ...numbers('yaw pitch radius height stepHeight'),
    onGround: 'b',
    crouch: 'b',
    ...numbers('eyeH punchP punchY aimPunch hp armor'),
    alive: 'b',
    ...numbers('deadT respawnT protectT slot lastSlot readyAt stepDist speed ads scoped'),
    scopeReady: 'b',
    ...numbers('scopeT reScope pendingThrow autoSwitchAt jumpCD'),
    landed: 'b',
    landSpeed: 'n',
    walk: 'b',
    ...numbers('bobT land camRoll radarT lastHurt shotSeq lifeId'),
  }),
  pos: vec3,
  vel: vec3,
  weapons: list(
    record({
      id: weapon,
      ...numbers(
        'mag reserve nextFire reloadUntil shotsFired spreadAcc lastShot boltUntil patternSeed',
      ),
    }),
    4,
  ),
  randomState: 'n',
  stats,
  damage: nullable(
    record({
      ...numbers('pitch yaw roll vp vy vr trauma time side front'),
      offset: record(numbers('pitch yaw roll x y')),
    }),
  ),
  explosionOffset: tuple('n', 'n'),
});
const publicRecord = record({
  roomId: 'd',
  mode: enumeration('tdm', 'relay'),
  objective: nullable(
    record({
      ...doubles('captureSeconds rotationSeconds index elapsed progress'),
      owner: nullable(team),
      contested: 'b',
      tick: 'd',
      score: publicScore,
      position: tuple('d', 'd', 'd'),
    }),
  ),
  nades: list(record({ id: 'd', pos: tuple('d', 'd', 'd') }), 1024),
  ...doubles('snapshotSeq tick nowMs time remainingMs stageId'),
  phase: enumeration('running', 'paused', 'countdown', 'ended'),
  resumeAtMs: nullable('d'),
  pausedBy: nullable('d'),
  score: publicScore,
  eventSeq: 'd',
  actors: list(actor, 16),
  rosterVersion: 'd',
});
const publicState = { kind: 'public', item: publicRecord };
const ownRecord = record({
  ...numbers('snapshotSeq actorId ackSeq'),
  activeInput: nullable(frame),
  state: ownState,
});
const own = { kind: 'packed', item: ownRecord };
const snapshot = record({ public: publicState, own });
const shotEvent = {
  kind: 'packed',
  item: record({
    roomId: 'n',
    event: record({
      type: enumeration('shot'),
      ...numbers('eventSeq tick stageId actorId lifeId shotSeq'),
      weaponId: weapon,
      inputSeq: nullable('n'),
      display: nullable(record(numbers('a b alpha'))),
      reused: 'b',
      path: enumeration('history', 'current'),
      reason: nullable('s'),
      origin: vec3,
      direction: vec3,
      end: vec3,
      impacts: list(record({ point: vec3, normal: vec3, surface: 's' }), 1024),
    }),
  }),
};
export const isCompactMessage = (message) =>
  ['input', 'snapshot'].includes(message.type) ||
  (message.type === 'event' && message.event?.type === 'shot');
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const uint = (value) => Number.isInteger(value) && value >= 0 && value <= 0xffffffff;

class BinaryWriter {
  constructor(lossless = false, compress = compressBlock) {
    this.lossless = lossless;
    this.compress = compress;
    this.bytes = new Uint8Array(2048);
    this.view = new DataView(this.bytes.buffer);
    this.at = 0;
    this.expanded = 0;
  }
  reserve(length) {
    const size = this.at + length;
    if (size > MAX_BYTES) fail('MESSAGE_TOO_LARGE');
    if (size <= this.bytes.length) return;
    const next = new Uint8Array(Math.min(MAX_BYTES, Math.max(size, this.bytes.length * 2)));
    next.set(this.bytes);
    this.bytes = next;
    this.view = new DataView(next.buffer);
  }
  byte(value) {
    this.reserve(1);
    this.bytes[this.at++] = value;
  }
  u(value) {
    if (!uint(value)) fail('BAD_UINT');
    while (value >= 128) {
      this.byte((value % 128) + 128);
      value = Math.floor(value / 128);
    }
    this.byte(value);
  }
  n(value) {
    if (!finite(value)) fail('NON_FINITE');
    if (value === 0 && !Object.is(value, -0)) this.byte(0);
    else if (Object.is(value, -0)) this.byte(6);
    else if (literalIds.has(value)) {
      this.byte(5);
      this.u(literalIds.get(value));
    } else if (value > 0 && uint(value)) {
      this.byte(1);
      this.u(value);
    } else if (Number.isInteger(value) && value < 0 && value >= -0xffffffff) {
      this.byte(2);
      this.u(-value);
    } else {
      this.byte(3);
      this.reserve(8);
      this.view.setFloat64(this.at, value, true);
      this.at += 8;
    }
  }
  f(value) {
    if (!finite(value)) fail('NON_FINITE');
    if (this.lossless) return this.n(value);
    const fixed = Math.round(value * 65536);
    if (!Object.is(value, -0) && fixed >= -2147483648 && fixed <= 2147483647) {
      this.byte(8);
      this.reserve(4);
      this.view.setInt32(this.at, fixed, true);
      this.at += 4;
      return;
    }
    const compact = Math.fround(value);
    if (!Number.isFinite(compact) || Math.abs(compact - value) > 0.00001) return this.n(value);
    this.byte(4);
    this.reserve(4);
    this.view.setFloat32(this.at, compact, true);
    this.at += 4;
  }
  d(value) {
    if (!finite(value)) fail('NON_FINITE');
    this.reserve(8);
    this.view.setFloat64(this.at, value, true);
    this.at += 8;
  }
  s(value) {
    if (typeof value !== 'string') fail('BAD_STRING');
    // JSON string literals preserve lone UTF-16 surrogates accepted by JSON controls.
    const bytes = encoder.encode(JSON.stringify(value));
    this.u(bytes.length);
    this.raw(bytes);
  }
  raw(bytes) {
    this.reserve(bytes.length);
    this.bytes.set(bytes, this.at);
    this.at += bytes.length;
  }
  finish() {
    return this.bytes.slice(0, this.at);
  }
}
class BinaryReader {
  constructor(data, maxBytes) {
    this.bytes =
      data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : ArrayBuffer.isView(data)
          ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
          : fail('BAD_BINARY');
    if (this.bytes.length > maxBytes) fail('MESSAGE_TOO_LARGE');
    this.view = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
    this.at = 0;
    this.expanded = 0;
  }
  require(length) {
    if (this.at + length > this.bytes.length) fail('TRUNCATED_MESSAGE');
  }
  byte() {
    this.require(1);
    return this.bytes[this.at++];
  }
  u() {
    let value = 0;
    for (let i = 0; i < 5; i++) {
      const b = this.byte();
      if (i === 4 && b > 15) fail('BAD_UINT');
      value += (b & 127) * 2 ** (i * 7);
      if (b < 128) {
        if (i && !b) fail('BAD_UINT');
        return value;
      }
    }
    return fail('BAD_UINT');
  }
  n() {
    const kind = this.byte();
    if (kind === 0) return 0;
    if (kind === 6) return -0;
    if (kind === 5) return literals[this.u()] ?? fail('BAD_LITERAL');
    if (kind === 1 || kind === 2) {
      const n = this.u();
      if (!n) fail('BAD_NUMBER');
      return kind === 1 ? n : -n;
    }
    if (kind !== 3 && kind !== 4 && kind !== 8) fail('BAD_NUMBER');
    this.require(kind === 3 ? 8 : 4);
    const value =
      kind === 3
        ? this.view.getFloat64(this.at, true)
        : kind === 8
          ? this.view.getInt32(this.at, true) / 65536
          : this.view.getFloat32(this.at, true);
    this.at += kind === 3 ? 8 : 4;
    if (!finite(value)) fail('NON_FINITE');
    return value;
  }
  s() {
    const size = this.u();
    this.require(size);
    const value = JSON.parse(decoder.decode(this.bytes.subarray(this.at, this.at + size)));
    this.at += size;
    if (typeof value !== 'string') fail('BAD_STRING');
    return value;
  }
  d() {
    this.require(8);
    const value = this.view.getFloat64(this.at, true);
    this.at += 8;
    if (!finite(value)) fail('NON_FINITE');
    return value;
  }
  done() {
    if (this.at !== this.bytes.length) fail('TRAILING_MESSAGE');
  }
}
class JsonWriter {
  constructor() {
    this.values = [];
  }
  u(value) {
    if (!uint(value)) fail('BAD_UINT');
    this.values.push(value);
  }
  n(value) {
    if (!finite(value)) fail('NON_FINITE');
    this.values.push(value);
  }
  s(value) {
    if (typeof value !== 'string') fail('BAD_STRING');
    this.values.push(value);
  }
}
class JsonReader {
  constructor(values) {
    this.values = values;
    this.at = 0;
  }
  u() {
    const value = this.values[this.at++];
    if (!uint(value)) fail('BAD_UINT');
    return value;
  }
  n() {
    const value = this.values[this.at++];
    if (!finite(value)) fail('NON_FINITE');
    return value;
  }
  s() {
    const value = this.values[this.at++];
    if (typeof value !== 'string') fail('BAD_STRING');
    return value;
  }
  done() {
    if (this.at !== this.values.length) fail('TRAILING_MESSAGE');
  }
}

function write(writer, schema, value) {
  if (schema.kind === 'public') {
    if (!(writer instanceof BinaryWriter)) return write(writer, schema.item, value);
    const body = new BinaryWriter(writer.lossless, writer.compress);
    write(body, schema.item, value);
    writer.expanded += body.at;
    if (writer.expanded > MAX_BYTES) fail('MESSAGE_TOO_LARGE');
    writer.raw(encodePublicFragment(body.finish(), { compress: writer.compress }));
    return;
  }
  if (schema.kind === 'packed') {
    if (!(writer instanceof BinaryWriter)) return write(writer, schema.item, value);
    const body = new BinaryWriter(writer.lossless, writer.compress);
    write(body, schema.item, value);
    const raw = body.finish();
    writer.expanded += raw.length;
    if (writer.expanded > MAX_BYTES) fail('MESSAGE_TOO_LARGE');
    writer.u(raw.length);
    for (let at = 0; at < raw.length; at += BLOCK_BYTES) {
      const chunk = raw.subarray(at, at + BLOCK_BYTES),
        compressed = writer.compress(chunk),
        packed = compressed.length < chunk.length ? compressed : chunk;
      writer.u(packed.length);
      writer.raw(packed);
    }
    return;
  }
  if (schema === 'n') return writer.n(value);
  if (schema === 'd') return writer.d ? writer.d(value) : writer.n(value);
  if (schema === 'f') return writer.f ? writer.f(value) : writer.n(value);
  if (schema === 's') return writer.s(value);
  if (schema.kind === 'nullable') {
    writer.u(value === null ? 0 : 1);
    if (value !== null) write(writer, schema.item, value);
  } else if (schema.kind === 'enum') {
    const index = schema.values.indexOf(value);
    if (index < 0) fail('BAD_ENUM');
    writer.u(index);
  } else if (schema.kind === 'tuple' || schema.kind === 'list') {
    if (!Array.isArray(value)) fail('BAD_ARRAY');
    if (schema.kind === 'tuple') {
      if (value.length !== schema.items.length) fail('BAD_ARRAY_LENGTH');
    } else {
      if (value.length > schema.max) fail('ARRAY_TOO_LARGE');
      writer.u(value.length);
    }
    for (let i = 0; i < value.length; i++) write(writer, schema.item || schema.items[i], value[i]);
  } else {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('BAD_RECORD');
    for (const key of Object.keys(value)) if (!schema.names.has(key)) fail(`UNKNOWN_FIELD:${key}`);
    const masks = Array(Math.ceil(schema.fields.length / 30)).fill(0);
    let bools = 0;
    for (const field of schema.fields) {
      if (!Object.hasOwn(value, field.name) || value[field.name] === undefined) continue;
      masks[field.word] += field.bit;
      if (field.bool) {
        if (typeof value[field.name] !== 'boolean') fail('BAD_BOOLEAN');
        if (value[field.name]) bools += field.bool;
      }
    }
    // Zero denotes a complete word; an absent word remains distinguishable (1).
    for (let i = 0; i < masks.length; i++)
      writer.u(
        masks[i] === 2 ** Math.min(30, schema.fields.length - i * 30) - 1 ? 0 : masks[i] + 1,
      );
    if (schema.bools) writer.u(bools);
    for (const field of schema.fields)
      if (!field.bool && masks[field.word] & field.bit)
        write(writer, field.type, value[field.name]);
  }
}
function read(reader, schema) {
  if (schema.kind === 'public') {
    if (!(reader instanceof BinaryReader)) return read(reader, schema.item);
    const baseSeq = reader.u(),
      flags = reader.u();
    if (flags > 3 || (flags & 2 && (!(flags & 1) || baseSeq))) fail('BAD_BASE_FLAGS');
    const raw = read(reader, { kind: 'packed', item: null });
    if (baseSeq) {
      const base = reader.options?.bases?.get(baseSeq);
      if (!base) fail('MISSING_BASE');
      for (let i = 0; i < raw.length; i++) raw[i] ^= base[i] || 0;
    }
    const body = new BinaryReader(raw, MAX_BYTES),
      value = read(body, schema.item);
    body.done();
    if (reader.options?.meta)
      reader.options.meta.publicBasis = {
        bytes: raw,
        baseSeq,
        offer: !!(flags & 1),
        reset: !!(flags & 2),
      };
    return value;
  }
  if (schema.kind === 'packed') {
    if (!(reader instanceof BinaryReader)) return read(reader, schema.item);
    const size = reader.u();
    reader.expanded += size;
    if (reader.expanded > MAX_BYTES) fail('BAD_BLOCK_SIZE');
    const raw = new Uint8Array(size);
    for (let at = 0; at < size; at += BLOCK_BYTES) {
      const length = Math.min(BLOCK_BYTES, size - at),
        stored = reader.u();
      if (stored > length || !stored) fail('BAD_BLOCK_SIZE');
      reader.require(stored);
      const packed = reader.bytes.subarray(reader.at, reader.at + stored);
      reader.at += stored;
      raw.set(stored === length ? packed : decompressBlock(packed, length), at);
    }
    if (!schema.item) return raw;
    const body = new BinaryReader(raw, MAX_BYTES);
    const value = read(body, schema.item);
    body.done();
    return value;
  }
  if (schema === 'n' || schema === 'f') return reader.n();
  if (schema === 'd') return reader.d ? reader.d() : reader.n();
  if (schema === 's') return reader.s();
  if (schema.kind === 'nullable') {
    const flag = reader.u();
    if (flag > 1) fail('BAD_NULL_FLAG');
    return flag ? read(reader, schema.item) : null;
  }
  if (schema.kind === 'enum') return schema.values[reader.u()] ?? fail('BAD_ENUM');
  if (schema.kind === 'tuple' || schema.kind === 'list') {
    const count = schema.items ? schema.items.length : reader.u();
    if (schema.max !== undefined && count > schema.max) fail('ARRAY_TOO_LARGE');
    return Array.from({ length: count }, (_, i) => read(reader, schema.item || schema.items[i]));
  }
  const masks = [];
  for (let i = 0; i < schema.fields.length; i += 30) {
    const encoded = reader.u(),
      maximum = 2 ** Math.min(30, schema.fields.length - i) - 1,
      mask = encoded === 0 ? maximum : encoded - 1;
    if (mask > maximum) fail('BAD_FIELD_MASK');
    masks.push(mask);
  }
  const bools = schema.bools ? reader.u() : 0;
  if (bools >= 2 ** schema.bools) fail('BAD_BOOLEAN_MASK');
  const result = {};
  for (const field of schema.fields) {
    if (masks[field.word] & field.bit)
      result[field.name] = field.bool ? !!(bools & field.bool) : read(reader, field.type);
    else if (field.bool && bools & field.bool) fail('BAD_BOOLEAN_MASK');
  }
  return result;
}
function writeMessage(writer, message) {
  const type =
    message.type === 'input'
      ? 1
      : message.type === 'snapshot'
        ? 2
        : message.type === 'event' && message.event?.type === 'shot'
          ? 3
          : fail('BAD_COMPACT_TYPE');
  writer.u(MAGIC);
  writer.u(WIRE_VERSION);
  writer.u(type);
  if (type === 1) write(writer, frame, message);
  else {
    for (const key of Object.keys(message))
      if (!(type === 2 ? ['type', 'public', 'own'] : ['type', 'roomId', 'event']).includes(key))
        fail(`UNKNOWN_FIELD:${key}`);
    const { type: ignored, ...body } = message;
    void ignored;
    write(writer, type === 2 ? snapshot : shotEvent, body);
  }
}
function readMessage(reader) {
  if (reader.u() !== MAGIC || reader.u() !== WIRE_VERSION) fail('BAD_CODEC_VERSION');
  const type = reader.u();
  if (![1, 2, 3].includes(type)) fail('BAD_COMPACT_TYPE');
  if (reader.options?.clientOnly && type !== 1) fail('BAD_CLIENT_MESSAGE');
  const value = read(reader, type === 1 ? frame : type === 2 ? snapshot : shotEvent);
  reader.done();
  if (type === 1 && value.type !== 'input') fail('BAD_COMPACT_TYPE');
  return type === 1 ? value : { type: type === 2 ? 'snapshot' : 'event', ...value };
}

/** Fresh owned bytes; only declared public geometry uses bounded quantization. */
export function encodeCompact(message, { lossless = false, compress = compressBlock } = {}) {
  const writer = new BinaryWriter(lossless, compress);
  writeMessage(writer, message);
  return writer.finish();
}
export function decodeCompact(data, maxBytes = MAX_BYTES, options = {}) {
  const reader = new BinaryReader(data, maxBytes);
  reader.options = options;
  return readMessage(reader);
}
/** Offline comparison only; never a second negotiated live high-frequency format. */
export function encodeCompactJson(message) {
  const writer = new JsonWriter();
  writeMessage(writer, message);
  return JSON.stringify(writer.values);
}
export function decodeCompactJson(text) {
  const values = JSON.parse(text);
  if (!Array.isArray(values) || values.length > 20000) fail('BAD_COMPACT_JSON');
  return readMessage(new JsonReader(values));
}
/** Reusable immutable public fragment; combining always copies into fresh bytes. */
export function encodePublicState(state) {
  const writer = new BinaryWriter();
  write(writer, publicRecord, state);
  return writer.finish();
}
export function decodePublicState(bytes) {
  const reader = new BinaryReader(bytes, MAX_BYTES),
    value = read(reader, publicRecord);
  reader.done();
  return value;
}
export function encodeSnapshot(publicBytes, correction, { compress = compressBlock } = {}) {
  const writer = new BinaryWriter(false, compress);
  const header = new BinaryReader(publicBytes, MAX_BYTES);
  header.u();
  header.u();
  writer.expanded = header.u();
  writer.u(MAGIC);
  writer.u(WIRE_VERSION);
  writer.u(2);
  writer.u(0);
  writer.raw(publicBytes);
  write(writer, own, correction);
  return writer.finish();
}

/** Full bytes or an XOR against an explicitly acknowledged immutable base.
 * Each result is independent of any earlier unacknowledged/sent snapshot. */
export function encodePublicFragment(
  raw,
  { base = null, offer = false, reset = false, compress = compressBlock } = {},
) {
  if (!(raw instanceof Uint8Array) || raw.length > MAX_BYTES) fail('BAD_BINARY');
  if (
    (reset && (!offer || base)) ||
    (base &&
      (!uint(base.seq) ||
        !base.seq ||
        !(base.bytes instanceof Uint8Array) ||
        base.bytes.length > MAX_BYTES))
  )
    fail('BAD_BASE_FLAGS');
  const writer = new BinaryWriter();
  writer.u(base?.seq || 0);
  writer.u((offer ? 1 : 0) + (reset ? 2 : 0));
  const delta = base ? raw.map((v, i) => v ^ (base.bytes[i] || 0)) : raw;
  writer.u(delta.length);
  for (let at = 0; at < delta.length; at += BLOCK_BYTES) {
    const chunk = delta.subarray(at, at + BLOCK_BYTES),
      compressed = compress(chunk),
      packed = compressed.length < chunk.length ? compressed : chunk;
    writer.u(packed.length);
    writer.raw(packed);
  }
  return writer.finish();
}
