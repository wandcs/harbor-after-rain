import { deflateRawSync } from 'node:zlib';
import { BLOCK_BYTES } from '../../src/protocol/blocks.js';

/** The server uses the native implementation of the same independent format. */
export function deflateBlock(data) {
  if (data.length > BLOCK_BYTES) throw new Error('BAD_COMPRESSED_BLOCK');
  return deflateRawSync(data, { level: 6, memLevel: 4 });
}
