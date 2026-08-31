/**
 * Struct decoding over raw callback bytes.
 *
 * Manual dispatch hands us a raw byte buffer for every callback/call result,
 * so structs are decoded with per-platform offset tables (emitted by the
 * generator) instead of koffi struct types. koffi has no #pragma pack(4)
 * equivalent; explicit offsets are both simpler and exactly correct.
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

export interface FieldLayout {
  name: string;
  offset: number;
  type: FieldType;
}

export interface StructLayout {
  size: number;
  fields: FieldLayout[];
}

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
