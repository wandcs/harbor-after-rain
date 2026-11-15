import { deflateSync, inflateSync } from 'fflate/browser';

export const BLOCK_BYTES = 2048;
const invalid = () => {
  throw new Error('BAD_COMPRESSED_BLOCK');
};
export function compressBlock(input) {
  if (input.length > BLOCK_BYTES) invalid();
  return deflateSync(input, { level: 1, mem: 4 });
}
export function decompressBlock(input, size) {
  if (
    !input.length ||
    input.length > BLOCK_BYTES + 32 ||
    !Number.isInteger(size) ||
    size < 0 ||
    size > BLOCK_BYTES
  )
    invalid();
  // A spare byte makes oversized expansion observable even when writes are
  // clamped to the supplied buffer. Input and expansion work are block-bounded.
  const output = inflateSync(input, { out: new Uint8Array(size + 1) });
  if (output.length !== size) invalid();
  return output.slice();
}
