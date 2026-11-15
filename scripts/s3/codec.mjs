// Experimental, self-contained lossless packet. Not enabled on the live wire.
// A packet-local key dictionary is included in its byte cost; no prior state.
const encoder = new globalThis.TextEncoder();
const decoder = new globalThis.TextDecoder('utf-8', { fatal: true });
const forbidden = new Set(['__proto__', 'constructor', 'prototype']);
export function encodeBinary(value) {
  const keys = new Map();
  function collect(item, depth = 0) {
    if (depth > 20) throw new Error('DEPTH');
    if (Array.isArray(item)) item.forEach((child) => collect(child, depth + 1));
    else if (item && typeof item === 'object')
      for (const [key, child] of Object.entries(item)) {
        if (forbidden.has(key)) throw new Error('KEY');
        if (!keys.has(key)) keys.set(key, keys.size);
        collect(child, depth + 1);
      }
  }
  collect(value);
  if (keys.size > 1024) throw new Error('KEYS');
  const buffer = new Uint8Array(131072),
    view = new DataView(buffer.buffer);
  let at = 0;
  const u8 = (n) => {
    view.setUint8(at, n);
    at++;
  };
  const u16 = (n) => {
    view.setUint16(at, n, true);
    at += 2;
  };
  function string(text) {
    const bytes = encoder.encode(text);
    view.setUint32(at, bytes.length, true);
    at += 4;
    if (at + bytes.length > buffer.length) throw new Error('SIZE');
    buffer.set(bytes, at);
    at += bytes.length;
  }
  u8(72);
  u8(51);
  u8(1);
  u16(keys.size);
  for (const key of keys.keys()) string(key);
  function write(item) {
    if (item === null) u8(0);
    else if (item === false) u8(1);
    else if (item === true) u8(2);
    else if (typeof item === 'number' && Number.isFinite(item)) {
      if (
        Number.isInteger(item) &&
        !Object.is(item, -0) &&
        item >= -2147483648 &&
        item <= 2147483647
      ) {
        u8(3);
        view.setInt32(at, item, true);
        at += 4;
      } else {
        u8(4);
        view.setFloat64(at, item, true);
        at += 8;
      }
    } else if (typeof item === 'string') {
      u8(5);
      string(item);
    } else if (Array.isArray(item) && item.length <= 1024) {
      u8(6);
      u16(item.length);
      item.forEach(write);
    } else if (item && typeof item === 'object') {
      const entries = Object.entries(item);
      u8(7);
      u16(entries.length);
      for (const [key, child] of entries) {
        u16(keys.get(key));
        write(child);
      }
    } else throw new Error('VALUE');
  }
  write(value);
  return buffer.slice(0, at);
}
export function decodeBinary(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length > 131072) throw new Error('SIZE');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  let at = 0,
    count = 0;
  const u8 = () => view.getUint8(at++);
  const u16 = () => {
    const n = view.getUint16(at, true);
    at += 2;
    return n;
  };
  function string() {
    const n = view.getUint32(at, true);
    at += 4;
    if (at + n > bytes.length) throw new Error('TRUNCATED');
    const text = decoder.decode(bytes.subarray(at, at + n));
    at += n;
    return text;
  }
  if (u8() !== 72 || u8() !== 51 || u8() !== 1) throw new Error('HEADER');
  const size = u16(),
    keys = [];
  if (size > 1024) throw new Error('KEYS');
  for (let i = 0; i < size; i++) {
    const key = string();
    if (forbidden.has(key) || keys.includes(key)) throw new Error('KEY');
    keys.push(key);
  }
  function read(depth = 0) {
    if (++count > 20000 || depth > 20) throw new Error('COMPLEXITY');
    const tag = u8();
    if (tag <= 2) return [null, false, true][tag];
    if (tag === 3) {
      const n = view.getInt32(at, true);
      at += 4;
      return n;
    }
    if (tag === 4) {
      const n = view.getFloat64(at, true);
      at += 8;
      if (!Number.isFinite(n)) throw new Error('FINITE');
      return n;
    }
    if (tag === 5) return string();
    if (tag === 6 || tag === 7) {
      const length = u16();
      if (length > 1024) throw new Error('LENGTH');
      if (tag === 6) return Array.from({ length }, () => read(depth + 1));
      const result = {};
      for (let i = 0; i < length; i++) {
        const key = keys[u16()];
        if (key === undefined || Object.hasOwn(result, key)) throw new Error('KEY');
        result[key] = read(depth + 1);
      }
      return result;
    }
    throw new Error('TAG');
  }
  const result = read();
  if (at !== bytes.length) throw new Error('TRAILING');
  return result;
}
