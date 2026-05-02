import { describe, expect, it } from 'vitest';
import { MAX_FRAME_BYTES, parseFrame } from '../../src/runtime/ipc.js';

describe('IPC framing', () => {
  it('rejects inbound frames over the documented 1 MB cap', () => {
    const frame = parseFrame('x'.repeat(MAX_FRAME_BYTES + 1));

    expect(frame).toEqual({
      kind: 'error',
      message: `ipc: inbound frame ${MAX_FRAME_BYTES + 1}B exceeds ${MAX_FRAME_BYTES}B limit`,
    });
  });
});
