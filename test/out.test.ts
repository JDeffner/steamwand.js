/**
 * Decoding tests for the out-parameter helpers. Writing into `buffer` stands in
 * for what the flat call would have written.
 */
import { describe, expect, test } from 'vitest';
import { out } from '../src/runtime/out';
import type { StructLayout } from '../src/runtime/struct';

describe('scalar out params', () => {
  test('each factory decodes what was written to its buffer', () => {
    const b = out.bool();
    b.buffer.writeUInt8(1);
    expect(b.value).toBe(true);

    const i32 = out.int32();
    i32.buffer.writeInt32LE(-7);
    expect(i32.value).toBe(-7);

    const u32 = out.uint32();
    u32.buffer.writeUInt32LE(4_000_000_000);
    expect(u32.value).toBe(4_000_000_000);

    const i64 = out.int64();
    i64.buffer.writeBigInt64LE(-9_007_199_254_740_993n);
    expect(i64.value).toBe(-9_007_199_254_740_993n);

    const u64 = out.uint64();
    u64.buffer.writeBigUInt64LE(76561198000000000n);
    expect(u64.value).toBe(76561198000000000n);

    const f = out.float();
    f.buffer.writeFloatLE(0.5);
    expect(f.value).toBe(0.5);

    const d = out.double();
    d.buffer.writeDoubleLE(0.1);
    expect(d.value).toBe(0.1);
  });

  test('an untouched buffer decodes to the zero value', () => {
    expect(out.bool().value).toBe(false);
    expect(out.uint64().value).toBe(0n);
  });
});

describe('string out params', () => {
  test('stops at the first NUL and ignores trailing garbage', () => {
    const s = out.string(32);
    s.buffer.write('ACH_WIN\0stale bytes');
    expect(s.buffer.length).toBe(32);
    expect(s.value).toBe('ACH_WIN');
  });

  test('reads the whole buffer when it is not NUL-terminated', () => {
    const s = out.string(4);
    s.buffer.write('abcd');
    expect(s.value).toBe('abcd');
  });
});

describe('struct out params', () => {
  test('decodes fields through the layout', () => {
    const layout: StructLayout = {
      size: 16,
      fields: [
        { name: 'm_eResult', offset: 0, type: 'int32' },
        { name: 'm_nPublishedFileId', offset: 8, type: 'uint64' },
      ],
    };
    const s = out.struct<{ m_eResult: number; m_nPublishedFileId: bigint }>(layout);
    expect(s.buffer.length).toBe(16);
    s.buffer.writeInt32LE(1, 0);
    s.buffer.writeBigUInt64LE(3_000_000_001n, 8);

    expect(s.value).toEqual({ m_eResult: 1, m_nPublishedFileId: 3_000_000_001n });
  });
});
