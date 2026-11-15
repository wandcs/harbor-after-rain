/** Makes shared authored data immutable. Instance state and query buffers must
 * stay outside these tables and belong to their simulation/pose owner. */
export function freezeData(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeData(child);
    Object.freeze(value);
  }
  return value;
}
