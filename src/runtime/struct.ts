/**
 * Struct decoding over raw callback bytes.
 *
 * Manual dispatch hands us a raw byte buffer for every callback/call result,
 * so structs are decoded with per-platform offset tables (emitted by the
 * generator) instead of koffi struct types. koffi has no #pragma pack(4)
 * equivalent; explicit offsets are both simpler and exactly correct.
 */

/**
 * Type of one decoded field.
 *
 * The scalar names decode to a JS `number`, except `bool` (a JS `boolean`) and
 * `int64` / `uint64` (a JS `bigint`, because the value does not fit a
 * `number`). `{ cstring: n }` decodes an inline `char[n]` to a `string`,
 * `{ bytes: n }` copies `n` raw bytes into a `Buffer`.
 */
export type FieldType =
  | 'bool'
  | 'int8'
  | 'uint8'
  | 'int16'
  | 'uint16'
  | 'int32'
  | 'uint32'
  | 'int64'
  | 'uint64'
  | 'float'
  | 'double'
  | { cstring: number } // fixed char array, NUL-terminated
  | { bytes: number }; // opaque fixed byte array

/** One field in a struct layout. */
export interface FieldLayout {
  /** Field name in the C struct. Becomes the key on the decoded object. */
  name: string;
  /** Byte offset of the field from the start of the struct. */
  offset: number;
  /** How to read the bytes at `offset`. */
  type: FieldType;
}

/**
 * Byte layout of one C struct on one platform.
 *
 * The generator emits a `win64` (pack 8) and a `posix` (pack 4) layout for
 * every callback struct. Get one with `layoutOf(name)` from the generated
 * structs module, or from a callback definition in `callbacksById`.
 *
 * @see decodeStruct
 * @see callbackPack
 */
export interface StructLayout {
  /** Size of the struct in bytes. `decodeStruct` rejects shorter buffers. */
  size: number;
  /** Every field, in declaration order. */
  fields: FieldLayout[];
}

/**
 * Reads one field out of a struct buffer.
 *
 * All numbers are little-endian, which is correct on every platform Steam
 * supports.
 *
 * @param buf - Struct bytes. Must be long enough for the field.
 * @param f - Layout of the field to read.
 * @returns A `boolean`, `number`, `bigint`, `string`, or `Buffer`, depending on `f.type`.
 * @throws RangeError if the field extends past the end of `buf`.
 * @see decodeStruct
 */
export function decodeField(buf: Buffer, f: FieldLayout): unknown {
  const t = f.type;
  if (typeof t === 'object') {
    if ('cstring' in t) {
      const raw = buf.subarray(f.offset, f.offset + t.cstring);
      const nul = raw.indexOf(0);
      return raw.toString('utf8', 0, nul === -1 ? t.cstring : nul);
    }
    return Buffer.from(buf.subarray(f.offset, f.offset + t.bytes));
  }
  switch (t) {
    case 'bool':
      return buf.readUInt8(f.offset) !== 0;
    case 'int8':
      return buf.readInt8(f.offset);
    case 'uint8':
      return buf.readUInt8(f.offset);
    case 'int16':
      return buf.readInt16LE(f.offset);
    case 'uint16':
      return buf.readUInt16LE(f.offset);
    case 'int32':
      return buf.readInt32LE(f.offset);
    case 'uint32':
      return buf.readUInt32LE(f.offset);
    case 'int64':
      return buf.readBigInt64LE(f.offset);
    case 'uint64':
      return buf.readBigUInt64LE(f.offset);
    case 'float':
      return buf.readFloatLE(f.offset);
    case 'double':
      return buf.readDoubleLE(f.offset);
  }
}

/**
 * Decodes a whole struct out of raw callback bytes.
 *
 * Every field in `layout` becomes a key on the returned object. 64-bit fields
 * arrive as `bigint`, so a published file id or a Steam id keeps full
 * precision.
 *
 * @param buf - Struct bytes, as handed out by the dispatch.
 * @param layout - Offset table for this platform, from `layoutOf(name)`.
 * @typeParam T - Generated struct interface to type the result as. Not checked against `layout`.
 * @returns The decoded fields.
 * @throws Error if `buf` is shorter than `layout.size`.
 * @example
 * ```ts
 * import { decodeStruct, flat } from 'steamwand.js';
 *
 * const layout = flat.layoutOf('CreateItemResult_t');
 * const bytes = Buffer.alloc(layout.size); // in practice: from the dispatch
 * const r = decodeStruct<flat.CreateItemResult_t>(bytes, layout);
 * console.log(r.m_nPublishedFileId); // bigint
 * ```
 * @see SteamDispatch.callResultStruct
 */
export function decodeStruct<T = Record<string, unknown>>(buf: Buffer, layout: StructLayout): T {
  if (buf.length < layout.size) {
    throw new Error(`steamwand: buffer too small for struct (${buf.length} < ${layout.size})`);
  }
  const out: Record<string, unknown> = {};
  for (const f of layout.fields) {
    out[f.name] = decodeField(buf, f);
  }
  return out as T;
}
