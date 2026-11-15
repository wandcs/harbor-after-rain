/** Host-created rule random source. State is an unsigned 32-bit integer;
 * getState()/setState() support deterministic replay without visual RNG use. */
export function createRandom(initialState) {
  let state = initialState >>> 0;
  const random = () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
  random.getState = () => state >>> 0;
  random.setState = (value) => {
    state = value >>> 0;
  };
  return random;
}
