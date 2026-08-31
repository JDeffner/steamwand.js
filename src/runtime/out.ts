/**
 * Typed out-parameter buffers for the flat API.
 *
 * Around 221 generated methods take a `Buffer` the caller must allocate at the
 * right size and decode by hand afterwards. These factories do both: each one
 * returns a correctly sized `buffer` to pass to the call and a `value` getter
 * that decodes whatever the call wrote into it.
 *
 * @example
 * ```ts
 * import { init, out } from 'steamwand.js';
 *
 * const steam = init({ appId: 480 });
 * const achieved = out.bool();
 * steam.userStats.GetAchievement('ACH_WIN', achieved.buffer);
 * console.log(achieved.value); // boolean
 * ```
 */
import { decodeStruct, type StructLayout } from './struct';

/**
 * One allocated out parameter.
 *
 * @typeParam T - What the buffer decodes to.
 */
export interface OutParam<T> {
  /** Buffer to pass to the flat call. Already the right size. */
  readonly buffer: Buffer;
  /** The current buffer contents, decoded. Read it after the call returns. */
  readonly value: T;
}

/** Allocates `size` bytes and decodes them with `read` on every `value` read. */
function param<T>(size: number, read: (b: Buffer) => T): OutParam<T> {
  const buffer = Buffer.alloc(size);
  return {
    buffer,
    get value() {
      return read(buffer);
    },
  };
}

/**
 * Factories for the out-parameter buffers the flat API expects.
 *
 * Numbers are little-endian, which is correct on every platform Steam
 * supports. 64-bit values decode to `bigint`.
 */
export const out = {
  /** One byte, non-zero meaning true. For `bool *` out params. */
  bool: (): OutParam<boolean> => param(1, (b) => b.readUInt8(0) !== 0),
  /** Four bytes, signed. */
  int32: (): OutParam<number> => param(4, (b) => b.readInt32LE(0)),
  /** Four bytes, unsigned. */
  uint32: (): OutParam<number> => param(4, (b) => b.readUInt32LE(0)),
  /** Eight bytes, signed, as a `bigint`. */
  int64: (): OutParam<bigint> => param(8, (b) => b.readBigInt64LE(0)),
  /** Eight bytes, unsigned, as a `bigint`. For Steam ids, file ids, UGC handles. */
  uint64: (): OutParam<bigint> => param(8, (b) => b.readBigUInt64LE(0)),
  /** Four bytes, IEEE 754 single. */
  float: (): OutParam<number> => param(4, (b) => b.readFloatLE(0)),
  /** Eight bytes, IEEE 754 double. */
  double: (): OutParam<number> => param(8, (b) => b.readDoubleLE(0)),

  /**
   * A `char[maxBytes]` buffer, decoded as UTF-8 up to the first NUL.
   *
   * @param maxBytes - Buffer size, including room for the terminator. Pass whatever the call documents.
   */
  string: (maxBytes: number): OutParam<string> =>
    param(maxBytes, (b) => {
      const nul = b.indexOf(0);
      return b.toString('utf8', 0, nul === -1 ? b.length : nul);
    }),

  /**
   * A struct buffer, decoded with an offset table.
   *
   * @param layout - Layout for this platform, from `layoutOf(name)`.
   * @typeParam T - Generated struct interface to type the value as.
   */
  struct: <T = Record<string, unknown>>(layout: StructLayout): OutParam<T> =>
    param(layout.size, (b) => decodeStruct<T>(b, layout)),
};
