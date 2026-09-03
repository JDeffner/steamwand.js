/**
 * Binding generator: reads the Steamworks SDK's steam_api.json and emits
 * src/generated/ (enums, consts, struct layouts, callback map, one class per
 * flat interface). The SDK itself is never committed; the emitted TS is.
 *
 * Run: pnpm generate   (SDK path: $STEAMWORKS_SDK or ./sdk)
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import koffi from 'koffi';

// ---------------------------------------------------------------------------
// steam_api.json shapes (the subset we consume)

interface JEnumValue {
  name: string;
  value: string;
}
interface JEnum {
  enumname: string;
  values: JEnumValue[];
}
interface JConst {
  constname: string;
  consttype: string;
  constval: string;
}
interface JTypedef {
  typedef: string;
  type: string;
}
interface JField {
  fieldname: string;
  fieldtype: string;
}
interface JStruct {
  struct: string;
  fields: JField[];
  enums?: JEnum[];
}
interface JParam {
  paramname: string;
  paramtype: string;
}
interface JMethod {
  methodname: string;
  methodname_flat: string;
  params: JParam[];
  returntype: string;
  callresult?: string;
  callback?: string;
}
interface JAccessor {
  kind: string;
  name: string;
  name_flat: string;
}
interface JInterface {
  classname: string;
  accessors?: JAccessor[];
  methods: JMethod[];
  enums?: JEnum[];
}
interface JCallbackStruct extends JStruct {
  callback_id: number;
}
interface ApiJson {
  callback_structs: JCallbackStruct[];
  consts: JConst[];
  enums: JEnum[];
  interfaces: JInterface[];
  structs: JStruct[];
  typedefs: JTypedef[];
}

// ---------------------------------------------------------------------------
// Load and verify SDK input

const repoRoot = path.join(__dirname, '..');
const sdkRoot = process.env.STEAMWORKS_SDK ?? path.join(repoRoot, 'sdk');
const jsonPath = path.join(sdkRoot, 'public', 'steam', 'steam_api.json');
if (!fs.existsSync(jsonPath)) {
  console.error(`steam_api.json not found at ${jsonPath}. Set STEAMWORKS_SDK or place the SDK in ./sdk.`);
  process.exit(1);
}
const raw = fs.readFileSync(jsonPath);
const lock = JSON.parse(fs.readFileSync(path.join(repoRoot, 'sdk.lock.json'), 'utf8')) as {
  sdkVersion: string;
  steamApiJsonSha256: string;
};
const hash = crypto.createHash('sha256').update(raw).digest('hex');
if (hash !== lock.steamApiJsonSha256) {
  console.warn(
    `WARNING: steam_api.json hash differs from sdk.lock.json (SDK ${lock.sdkVersion}).\n` +
      `  lock:   ${lock.steamApiJsonSha256}\n  actual: ${hash}\n` +
      `Update sdk.lock.json if this SDK bump is intentional, then review the generated diff.`,
  );
}
const api = JSON.parse(raw.toString('utf8')) as ApiJson;

// ---------------------------------------------------------------------------
// Type tables

const typedefs = new Map<string, string>(api.typedefs.map((t) => [t.typedef, t.type]));
const enumNames = new Set<string>(api.enums.map((e) => e.enumname));
for (const i of api.interfaces) for (const e of i.enums ?? []) enumNames.add(e.enumname);
for (const s of [...api.structs, ...api.callback_structs]) for (const e of s.enums ?? []) enumNames.add(e.enumname);
const structByName = new Map<string, JStruct>();
for (const s of api.structs) structByName.set(s.struct, s);
for (const s of api.callback_structs) structByName.set(s.struct, s);

type Scalar =
  | { kind: 'prim'; koffi: string; size: number; align: number; ts: string; big?: boolean }
  | { kind: 'unsupported'; reason: string };

const PRIMS: Record<string, { koffi: string; size: number; align: number; ts: string; big?: boolean }> = {
  bool: { koffi: 'bool', size: 1, align: 1, ts: 'boolean' },
  char: { koffi: 'int8', size: 1, align: 1, ts: 'number' },
  'signed char': { koffi: 'int8', size: 1, align: 1, ts: 'number' },
  'unsigned char': { koffi: 'uint8', size: 1, align: 1, ts: 'number' },
  short: { koffi: 'int16', size: 2, align: 2, ts: 'number' },
  'unsigned short': { koffi: 'uint16', size: 2, align: 2, ts: 'number' },
  int: { koffi: 'int32', size: 4, align: 4, ts: 'number' },
  'unsigned int': { koffi: 'uint32', size: 4, align: 4, ts: 'number' },
  'long long': { koffi: 'int64', size: 8, align: 8, ts: 'bigint', big: true },
  'unsigned long long': { koffi: 'uint64', size: 8, align: 8, ts: 'bigint', big: true },
  float: { koffi: 'float', size: 4, align: 4, ts: 'number' },
  double: { koffi: 'double', size: 8, align: 8, ts: 'number' },
  size_t: { koffi: 'uint64', size: 8, align: 8, ts: 'bigint', big: true },
  intptr_t: { koffi: 'int64', size: 8, align: 8, ts: 'bigint', big: true },
  uint8: { koffi: 'uint8', size: 1, align: 1, ts: 'number' },
  int8: { koffi: 'int8', size: 1, align: 1, ts: 'number' },
  uint16: { koffi: 'uint16', size: 2, align: 2, ts: 'number' },
  int16: { koffi: 'int16', size: 2, align: 2, ts: 'number' },
  uint32: { koffi: 'uint32', size: 4, align: 4, ts: 'number' },
  int32: { koffi: 'int32', size: 4, align: 4, ts: 'number' },
  uint64: { koffi: 'uint64', size: 8, align: 8, ts: 'bigint', big: true },
  int64: { koffi: 'int64', size: 8, align: 8, ts: 'bigint', big: true },
  lint64: { koffi: 'int64', size: 8, align: 8, ts: 'bigint', big: true },
  ulint64: { koffi: 'uint64', size: 8, align: 8, ts: 'bigint', big: true },
  int64_t: { koffi: 'int64', size: 8, align: 8, ts: 'bigint', big: true },
  uint64_t: { koffi: 'uint64', size: 8, align: 8, ts: 'bigint', big: true },
};

/** Opaque pointer-sized handle typedefs missing from steam_api.json's typedef list. */
const OPAQUE_HANDLES = new Set(['HServerListRequest']);

/**
 * Structs declared under their own #pragma pack instead of the callback pack.
 * Verified against the SDK headers (isteaminput.h / isteamcontroller.h use
 * pack(1) for the *Data_t structs).
 */
const FORCED_PACK: Record<string, number> = {
  InputAnalogActionData_t: 1,
  InputDigitalActionData_t: 1,
  InputMotionData_t: 1,
  ControllerAnalogActionData_t: 1,
  ControllerDigitalActionData_t: 1,
  ControllerMotionData_t: 1,
};

/**
 * Structs allowed to cross the ABI by value, as a koffi struct type rather
 * than a pointer. Only the `#pragma pack(1)` action-data structs qualify:
 * their layout is the same on every platform, and every field still lands on
 * its natural offset, so the register/memory class koffi computes for the
 * return value is the one the compiler that built steam_api used.
 *
 * A struct under the callback pack must never be added. On Linux and macOS
 * that packing puts a `uint64` at offset 4, and the System V ABI sends an
 * aggregate with an unaligned field through memory, a rule koffi does not
 * implement; the call would return garbage with nothing to warn you. That is
 * why `SteamAPI_ISteamParties_GetBeaconLocationData` stays skipped.
 * `SteamIPAddress_t` stays skipped for the union reason below.
 *
 * `valueStructOf` re-checks both conditions against koffi at generation time.
 */
const BY_VALUE_STRUCTS = ['InputDigitalActionData_t', 'InputAnalogActionData_t', 'InputMotionData_t'];

/**
 * Structs containing C unions, which steam_api.json cannot express; a layout
 * computed from its field list would be silently wrong. Excluded, along with
 * every struct that embeds them.
 */
const UNION_STRUCTS = new Set([
  'SteamNetworkingIdentity',
  'SteamNetworkingIPAddr',
  'SteamNetworkingMessage_t',
  'SteamInputActionEvent_t',
]);

/** Resolve a non-pointer scalar C type to a primitive, through typedefs/enums. */
function resolveScalar(t: string): Scalar {
  let clean = t.replace(/\bconst\b/g, '').trim();
  if (clean.includes('::')) clean = clean.slice(clean.lastIndexOf('::') + 2);
  if (PRIMS[clean]) return { kind: 'prim', ...PRIMS[clean] };
  if (clean === 'CSteamID' || clean === 'CGameID') return { kind: 'prim', ...PRIMS.uint64 };
  if (enumNames.has(clean)) return { kind: 'prim', ...PRIMS.int32 };
  const td = typedefs.get(clean);
  if (td) return resolveScalar(td);
  return { kind: 'unsupported', reason: `unknown scalar type '${t}'` };
}

// ---------------------------------------------------------------------------
// Struct layout computation (per callback pack: 8 = win64, 4 = linux/macOS)

interface GFieldLayout {
  name: string;
  offset: number;
  type: string; // serialized FieldType expression
  ts: string;
}
interface GLayout {
  size: number;
  align: number;
  fields: GFieldLayout[];
}

const layoutFailures = new Map<string, string>();

function alignUp(n: number, a: number): number {
  return Math.ceil(n / a) * a;
}

interface FieldInfo {
  size: number;
  align: number;
  type: string;
  ts: string;
}

function fieldInfo(t: string, pack: number, stack: string[]): FieldInfo | string {
  const arr = /^(.+?)\s*\[(\d+)\]$/.exec(t.trim());
  if (arr) {
    const elemT = arr[1].trim();
    const count = Number(arr[2]);
    if (elemT === 'char') {
      return { size: count, align: 1, type: `{ cstring: ${count} }`, ts: 'string' };
    }
    const elem = fieldInfo(elemT, pack, stack);
    if (typeof elem === 'string') return elem;
    const stride = alignUp(elem.size, elem.align);
    return { size: stride * count, align: elem.align, type: `{ bytes: ${stride * count} }`, ts: 'Buffer' };
  }
  if (t.includes('*') || t.includes('&')) {
    return { size: 8, align: 8, type: `'uint64'`, ts: 'bigint' };
  }
  const cleanName = t.replace(/\bconst\b/g, '').trim();
  // CSteamID/CGameID are declared under #pragma pack(push, 1) in
  // steamclientpublic.h: 8 bytes with alignment 1, NOT a normal uint64.
  if (cleanName === 'CSteamID' || cleanName === 'CGameID') {
    return { size: 8, align: 1, type: `'uint64'`, ts: 'bigint' };
  }
  if (UNION_STRUCTS.has(cleanName)) return `union struct ${cleanName} (layout not computable from steam_api.json)`;
  const scalar = resolveScalar(t);
  if (scalar.kind === 'prim') {
    return {
      size: scalar.size,
      align: scalar.align,
      type: `'${scalar.koffi === 'bool' ? 'bool' : scalar.koffi}'`,
      ts: scalar.ts,
    };
  }
  const clean = t.replace(/\bconst\b/g, '').trim();
  const sub = structByName.get(clean);
  if (sub) {
    if (stack.includes(clean)) return `recursive struct ${clean}`;
    const l = computeLayout(sub, pack, [...stack, clean]);
    if (typeof l === 'string') return l;
    return { size: l.size, align: l.align, type: `{ bytes: ${l.size} }`, ts: 'Buffer' };
  }
  return `unknown field type '${t}'`;
}

function computeLayout(s: JStruct, pack: number, stack: string[] = []): GLayout | string {
  if (UNION_STRUCTS.has(s.struct)) return `union struct ${s.struct} (layout not computable from steam_api.json)`;
  if (FORCED_PACK[s.struct] !== undefined) pack = FORCED_PACK[s.struct];
  let offset = 0;
  let maxAlign = 1;
  const fields: GFieldLayout[] = [];
  for (const f of s.fields ?? []) {
    const info = fieldInfo(f.fieldtype, pack, stack);
    if (typeof info === 'string') return `${s.struct}.${f.fieldname}: ${info}`;
    const a = Math.min(info.align, pack);
    maxAlign = Math.max(maxAlign, a);
    offset = alignUp(offset, a);
    fields.push({ name: f.fieldname, offset, type: info.type, ts: info.ts });
    offset += info.size;
  }
  return { size: Math.max(alignUp(offset, maxAlign), 1), align: maxAlign, fields };
}

function emitLayout(l: GLayout): string {
  const fields = l.fields.map((f) => `{ name: '${f.name}', offset: ${f.offset}, type: ${f.type} }`).join(', ');
  return `{ size: ${l.size}, fields: [${fields}] }`;
}

// ---------------------------------------------------------------------------
// By-value struct types, checked against koffi before anything is emitted.

interface ValueStruct {
  name: string;
  size: number;
  members: { name: string; koffi: string; offset: number }[];
}

function abort(why: string): never {
  console.error(`by-value struct check failed: ${why}`);
  process.exit(1);
}

/**
 * Builds the koffi member list for a by-value struct and proves it is safe to
 * pass through the ABI: the layout must be platform independent, packed, made
 * only of primitives, and every field must sit on its natural offset. Then the
 * type koffi actually builds is compared field by field against our own table.
 */
function valueStructOf(name: string): ValueStruct {
  const s = structByName.get(name);
  if (!s) abort(`${name} is not in steam_api.json`);
  const win64 = computeLayout(s, 8);
  const posix = computeLayout(s, 4);
  if (typeof win64 === 'string') abort(win64);
  if (typeof posix === 'string') abort(posix);
  if (JSON.stringify(win64) !== JSON.stringify(posix)) abort(`${name} is not pack(1): its layout differs by platform`);
  if (win64.align !== 1) abort(`${name} is not pack(1): alignment ${win64.align}`);

  const members = win64.fields.map((f) => {
    const prim = /^'(\w+)'$/.exec(f.type);
    if (!prim) abort(`${name}.${f.name}: only primitive fields can cross the ABI by value`);
    return { name: f.name, koffi: prim[1], offset: f.offset };
  });

  const type = koffi.pack(Object.fromEntries(members.map((m) => [m.name, m.koffi])));
  if (koffi.sizeof(type) !== win64.size) abort(`${name}: koffi size ${koffi.sizeof(type)}, ours ${win64.size}`);
  for (const m of members) {
    const natural = koffi.alignof(m.koffi);
    if (m.offset % natural !== 0) {
      abort(`${name}.${m.name}: offset ${m.offset} is not ${natural}-byte aligned, so its ABI class is not koffi's`);
    }
    const got = koffi.offsetof(type, m.name);
    if (got !== m.offset) abort(`${name}.${m.name}: koffi offset ${got}, ours ${m.offset}`);
  }
  return { name, size: win64.size, members };
}

/** koffi type identifier emitted for a by-value struct, e.g. `InputMotionData_tValue`. */
function valueTypeName(name: string): string {
  return `${name}Value`;
}

function emitValueStructs(structs: ValueStruct[]): string {
  const out: string[] = [
    HEADER,
    `/*`,
    ` * koffi types for the SDK structs that cross the ABI by value.`,
    ` *`,
    ` * These are the #pragma pack(1) action-data structs of the Steam Input API,`,
    ` * the only Steamworks structs a flat function returns whole instead of`,
    ` * writing through a pointer. koffi.pack reproduces that packing, so koffi`,
    ` * hands the call the same registers or hidden pointer the C compiler did.`,
    ` * The generator checks every size and offset below against its own layout`,
    ` * table before writing this file.`,
    ` */`,
    '',
    `import koffi from 'koffi';`,
  ];
  for (const s of structs) {
    out.push(
      '',
      `/** \`${s.name}\` by value: ${s.size} bytes, pack(1). Decodes to the \`${s.name}\` interface in \`./structs\`. */`,
      `export const ${valueTypeName(s.name)} = koffi.pack({`,
      ...s.members.map((m) => `  ${m.name}: '${m.koffi}',`),
      `});`,
    );
  }
  out.push('');
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Doc comments. Built only from steam_api.json metadata (names, types, callback
// ids); the SDK headers and their comments are not redistributable.

const DOCS = 'https://partner.steamgames.com/doc/api';
const callbackIdByStruct = new Map<string, number>(api.callback_structs.map((c) => [c.struct, c.callback_id]));
/** Structs that got a generated layout. Filled before the interfaces are emitted. */
const layoutNames = new Set<string>();

function stripConst(t: string): string {
  return t.replace(/\bconst\b/g, '').trim();
}

/** The type a pointer/reference parameter points at. */
function pointee(t: string): string {
  return stripConst(t).replace(/[*&]/g, '').trim();
}

/** Follow typedefs until an enum name appears, if one ever does. */
function enumNameOf(t: string): string | undefined {
  let clean = stripConst(t);
  if (clean.includes('::')) clean = clean.slice(clean.lastIndexOf('::') + 2);
  for (let i = 0; i < 8; i++) {
    if (enumNames.has(clean)) return clean;
    const td = typedefs.get(clean);
    if (!td) return undefined;
    clean = stripConst(td);
  }
  return undefined;
}

/** A parameter as written in the C declaration: `SteamUGCDetails_t *pDetails`. */
function cParam(p: JParam): string {
  const t = p.paramtype.trim();
  return /[*&]$/.test(t) ? `${t}${p.paramname}` : `${t} ${p.paramname}`;
}

/** What the TypeScript type hides about a parameter, if anything. */
function paramDoc(p: JParam, mapped: MappedParam): string | undefined {
  const t = p.paramtype.trim();
  if (mapped.ts === 'SteamParamStringArrayJs') return `\`${t}\`. Pass \`stringArray(['a', 'b'])\`.`;
  if (mapped.ts === 'Buffer | null') {
    const pe = pointee(t);
    if (pe === 'char') {
      return `Char buffer you allocate and size yourself; read it back with \`buf.toString('utf8', 0, buf.indexOf(0))\`.`;
    }
    if (layoutNames.has(pe)) return `Buffer you allocate for \`${t}\`: \`Buffer.alloc(layoutOf('${pe}').size)\`.`;
    const s = resolveScalar(pe);
    if (s.kind === 'prim') return `Buffer you allocate for \`${t}\`: \`Buffer.alloc(${s.size})\` per element.`;
    return `Buffer you allocate for \`${t}\`.`;
  }
  if (mapped.ts === 'bigint') return `\`${t}\`, 64-bit: pass a \`bigint\`, for example \`123n\`.`;
  const e = enumNameOf(t);
  if (e) return `${t === e ? '' : `\`${t}\` is `}enum \`${e}\`; values on \`flat.${e}\`.`;
  return undefined;
}

/** TSDoc block for one interface method, indented for a class body. */
function methodDoc(cls: string, m: JMethod, mapped: MappedParam[]): string {
  const lines = [
    ` * \`${m.returntype} ${m.methodname}(${m.params.map(cParam).join(', ')})\``,
    ` *`,
    ` * Flat symbol: \`${m.methodname_flat}\``,
  ];
  if (m.callresult) {
    if (layoutNames.has(m.callresult)) {
      const id = callbackIdByStruct.get(m.callresult);
      const manual = `\`steam.dispatch.callResultStruct<${m.callresult}>(handle, layoutOf('${m.callresult}')${id === undefined ? '' : `, callbackIdByName.${m.callresult}`})\``;
      // Same condition emitAsync's companion is built on: a generated wrapper exists.
      if (m.returntype === 'SteamAPICall_t') {
        const short = m.methodname_flat.replace(`SteamAPI_${cls}_`, '');
        lines.push(
          ` * @remarks Returns an API call handle. The easy path is \`steam.async.${getterName(cls)}.${short}(...)\`, which awaits and decodes \`${m.callresult}\`.`,
          ` * To await the handle yourself: ${manual}.`,
        );
      } else {
        lines.push(` * @remarks Returns an API call handle. Await it with ${manual}.`);
      }
    } else {
      lines.push(` * @remarks Returns an API call handle for \`${m.callresult}\`.`);
    }
  } else if (m.callback) {
    lines.push(
      layoutNames.has(m.callback)
        ? ` * @remarks Fires the \`${m.callback}\` callback: \`steam.on('${m.callback}', cb)\`.`
        : ` * @remarks Fires the \`${m.callback}\` callback.`,
    );
  }
  m.params.forEach((p, i) => {
    const d = paramDoc(p, mapped[i]);
    if (d) lines.push(` * @param ${mapped[i].name} ${d}`);
  });
  lines.push(` * @see ${DOCS}/${cls}#${m.methodname}`);
  return ['  /**', ...lines.map((l) => `  ${l}`), '   */', ''].join('\n');
}

// ---------------------------------------------------------------------------
// Emit enums.ts

const HEADER = `// GENERATED by scripts/generate.ts from steam_api.json (SDK ${lock.sdkVersion}) - do not edit.\n/* eslint-disable */\n`;

function emitEnums(): string {
  const out: string[] = [HEADER];
  const seen = new Set<string>();
  const all: JEnum[] = [...api.enums];
  for (const i of api.interfaces) all.push(...(i.enums ?? []));
  for (const s of [...api.structs, ...api.callback_structs]) all.push(...(s.enums ?? []));
  for (const e of all) {
    if (seen.has(e.enumname)) continue;
    seen.add(e.enumname);
    out.push(`export const ${e.enumname} = {`);
    const seenKeys = new Set<string>();
    for (const v of e.values) {
      if (seenKeys.has(v.name)) continue;
      seenKeys.add(v.name);
      out.push(`  ${v.name}: ${v.value},`);
    }
    out.push(`} as const;`);
    out.push('');
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Emit consts.ts

function emitConsts(): string {
  const out: string[] = [HEADER];
  const skipped: string[] = [];
  const known = new Map<string, string>(); // name -> plain numeric expression
  for (const c of api.consts) {
    const scalar = resolveScalar(c.consttype);
    const isBig = scalar.kind === 'prim' && scalar.big === true;
    const isFloat = scalar.kind === 'prim' && (scalar.koffi === 'float' || scalar.koffi === 'double');
    let expr = c.constval;
    expr = expr.replace(/\(\s*\w+\s*\)/g, ' '); // drop C casts
    expr = expr.replace(/(\d)\.f\b/g, '$1'); // 600.f -> 600
    expr = expr.replace(/\b(0x[0-9a-fA-F]+|\d+)(ull|ll|ul|u|f)\b/gi, '$1'); // literal suffixes
    expr = expr.replace(/\b[A-Za-z_]\w*\b/g, (name) => known.get(name) ?? name);
    let value: string | undefined;
    if (/^[\s\d+\-*/|&~()<>xXa-fA-F.]+$/.test(expr) && !/[a-wyzA-WYZ_]/.test(expr.replace(/0x[0-9a-fA-F]+/g, '0'))) {
      try {
        if (isBig) {
          const bigExpr = expr.replace(/\b(0x[0-9a-fA-F]+|\d+)\b/g, '$1n');
          let v = Function(`"use strict"; return (${bigExpr});`)() as bigint;
          if (scalar.kind === 'prim' && scalar.koffi === 'uint64') v &= 0xffffffffffffffffn;
          value = `${v}n`;
        } else {
          let v = Function(`"use strict"; return (${expr});`)() as number;
          if (!isFloat) v |= 0; // C int semantics for ~0 etc.
          if (scalar.kind === 'prim' && scalar.koffi === 'uint32') v >>>= 0;
          value = String(v);
        }
      } catch {
        value = undefined;
      }
    }
    if (value === undefined) {
      skipped.push(`${c.constname} = ${c.constval}`);
      continue;
    }
    known.set(c.constname, value.endsWith('n') ? value.slice(0, -1) : value);
    out.push(`export const ${c.constname} = ${value};`);
  }
  if (skipped.length > 0) {
    console.warn(`consts skipped (unparseable values):\n  ${skipped.join('\n  ')}`);
    out.push('', `// Skipped (unparseable in steam_api.json): ${skipped.join('; ')}`);
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Emit structs.ts and callbacks.ts

interface EmittedStruct {
  name: string;
  win64: GLayout;
  posix: GLayout;
}

function layoutBoth(s: JStruct): EmittedStruct | undefined {
  const win64 = computeLayout(s, 8);
  const posix = computeLayout(s, 4);
  if (typeof win64 === 'string' || typeof posix === 'string') {
    layoutFailures.set(s.struct, typeof win64 === 'string' ? win64 : (posix as string));
    return undefined;
  }
  return { name: s.struct, win64, posix };
}

function tsInterface(name: string, l: GLayout): string {
  const id = callbackIdByStruct.get(name);
  const what = id === undefined ? 'Steamworks struct' : `Steam callback, id ${id}`;
  const lines = [
    `/** \`${name}\` (${what}). Layout: \`layoutOf('${name}')\`. */`,
    `export interface ${name} {`,
  ];
  for (const f of l.fields) lines.push(`  ${f.name}: ${f.ts};`);
  lines.push('}');
  return lines.join('\n');
}

function emitStructs(structs: EmittedStruct[]): string {
  const out: string[] = [HEADER, `import type { StructLayout } from '../runtime/struct';`, ''];
  for (const s of structs) out.push(tsInterface(s.name, s.win64), '');
  out.push(`export const structLayouts: Record<string, { win64: StructLayout; posix: StructLayout }> = {`);
  for (const s of structs) {
    out.push(`  ${s.name}: { win64: ${emitLayout(s.win64)}, posix: ${emitLayout(s.posix)} },`);
  }
  out.push(`};`, '');
  out.push(`const posix = process.platform !== 'win32';`);
  out.push(`/** The layout of a struct for the current platform. */`);
  out.push(`export function layoutOf(name: string): StructLayout {`);
  out.push(`  const l = structLayouts[name];`);
  out.push(`  if (!l) throw new Error(\`steamwand: no generated layout for struct \${name}\`);`);
  out.push(`  return posix ? l.posix : l.win64;`);
  out.push(`}`);
  return out.join('\n');
}

function emitCallbacks(cbs: { def: JCallbackStruct; layout: EmittedStruct }[]): string {
  const out: string[] = [HEADER, `import type { StructLayout } from '../runtime/struct';`];
  out.push(`import type {`, ...cbs.map(({ def }) => `  ${def.struct},`), `} from './structs';`, '');
  out.push(`export interface CallbackDef { id: number; name: string; win64: StructLayout; posix: StructLayout }`, '');
  out.push(`export const callbacksById: Record<number, CallbackDef> = {`);
  for (const { def, layout } of cbs) {
    out.push(
      `  ${def.callback_id}: { id: ${def.callback_id}, name: '${def.struct}', win64: ${emitLayout(layout.win64)}, posix: ${emitLayout(layout.posix)} },`,
    );
  }
  out.push(`};`, '');
  out.push(`export const callbackId = {`);
  for (const { def } of cbs) {
    out.push(`  /** \`${def.struct}\` callback id. Subscribe with \`steam.on('${def.struct}', cb)\`. */`);
    out.push(`  ${def.struct}: ${def.callback_id},`);
  }
  out.push(`} as const;`, '');
  out.push(`/**`);
  out.push(` * The same ids, indexable by a name that is only known at runtime.`);
  out.push(` *`);
  out.push(` * Handwritten code pins a call result to its struct with this:`);
  out.push(` * \`dispatch.callResultStruct(call, layoutOf(n), callbackIdByName[n])\`.`);
  out.push(` */`);
  out.push(`export const callbackIdByName: Readonly<Record<string, number>> = callbackId;`, '');
  out.push(`/**`);
  out.push(` * Every subscribable callback name, mapped to the struct its listener gets.`);
  out.push(` *`);
  out.push(` * \`Steam.on\` is keyed on this, so the callback name is checked at compile time`);
  out.push(` * and the listener argument is typed for you.`);
  out.push(` */`);
  out.push(`export interface SteamCallbackMap {`);
  for (const { def } of cbs) out.push(`  ${def.struct}: ${def.struct};`);
  out.push(`}`);
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Emit interface classes

interface MappedParam {
  name: string;
  koffi: string; // expression: quoted string or identifier
  ts: string;
}

const RESERVED = new Set(['function', 'default', 'delete', 'new', 'var', 'class', 'in', 'this']);

const skippedMethods: string[] = [];

function mapParam(p: JParam): MappedParam | undefined {
  const t = p.paramtype.trim();
  const name = RESERVED.has(p.paramname) ? `${p.paramname}_` : p.paramname;
  if (/^const\s+SteamParamStringArray_t\s*\*$/.test(t) || t === 'SteamParamStringArray_t *') {
    return { name, koffi: 'SteamParamStringArrayPtr', ts: 'SteamParamStringArrayJs' };
  }
  if (t === 'const char *') return { name, koffi: `'str'`, ts: 'string' };
  if (OPAQUE_HANDLES.has(t)) return { name, koffi: `'void *'`, ts: 'unknown' };
  if (t.includes('*') || t.includes('&')) {
    return { name, koffi: `'void *'`, ts: 'Buffer | null' };
  }
  const scalar = resolveScalar(t);
  if (scalar.kind === 'unsupported') return undefined;
  return { name, koffi: `'${scalar.koffi}'`, ts: scalar.ts };
}

function mapReturn(
  t: string,
): { koffi: string; ts: string; wrap: 'big' | 'str' | 'none'; struct?: string } | undefined {
  if (t === 'void') return { koffi: `'void'`, ts: 'void', wrap: 'none' };
  if (t === 'const char *') return { koffi: `'str'`, ts: 'string', wrap: 'str' };
  const byValue = stripConst(t);
  if (BY_VALUE_STRUCTS.includes(byValue)) {
    return { koffi: valueTypeName(byValue), ts: byValue, wrap: 'none', struct: byValue };
  }
  if (OPAQUE_HANDLES.has(t) || t.includes('*') || t.includes('&'))
    return { koffi: `'void *'`, ts: 'unknown', wrap: 'none' };
  const scalar = resolveScalar(t);
  if (scalar.kind === 'unsupported') return undefined;
  if (scalar.big) return { koffi: `'${scalar.koffi}'`, ts: 'bigint', wrap: 'big' };
  return { koffi: `'${scalar.koffi}'`, ts: scalar.ts, wrap: 'none' };
}

/** One flat method that returns a call handle and has a decodable result struct. */
interface AsyncMethod {
  /** Method name on the interface class, e.g. `FindLeaderboard`. */
  short: string;
  /** Mapped parameter list, e.g. `pchLeaderboardName: string`. */
  sig: string;
  /** Argument names to forward, e.g. `pchLeaderboardName`. */
  args: string;
  /** Result struct name, e.g. `LeaderboardFindResult_t`. */
  result: string;
  /** Callback id of the result struct, pinned so a mismatched completion rejects. */
  resultId: number | undefined;
  /** TSDoc block, indented for a class body. */
  doc: string;
  /** True if a parameter takes a `SteamParamStringArray_t *`. */
  usesStringArray: boolean;
}

function emitInterface(
  iface: JInterface,
  accessor: JAccessor,
): { code: string; asyncMethods: AsyncMethod[] } | undefined {
  const cls = iface.classname;
  const methods: string[] = [];
  const asyncMethods: AsyncMethod[] = [];
  const valueStructs = new Set<string>();
  let usesStringArray = false;

  for (const m of iface.methods) {
    const short = m.methodname_flat.replace(`SteamAPI_${cls}_`, '');
    const ret = mapReturn(m.returntype);
    if (!ret) {
      skippedMethods.push(`${m.methodname_flat} (return ${m.returntype})`);
      continue;
    }
    if (ret.struct) valueStructs.add(ret.struct);
    const params: MappedParam[] = [];
    let bad: string | undefined;
    for (const p of m.params) {
      const mp = mapParam(p);
      if (!mp) {
        bad = p.paramtype;
        break;
      }
      if (mp.koffi === 'SteamParamStringArrayPtr') usesStringArray = true;
      params.push(mp);
    }
    if (bad) {
      skippedMethods.push(`${m.methodname_flat} (param ${bad})`);
      continue;
    }
    const doc = methodDoc(cls, m, params);
    const sig = params.map((p) => `${p.name}: ${p.ts}`).join(', ');
    const koffiParams = [`'void *'`, ...params.map((p) => p.koffi)].join(', ');
    const args = ['this.ptr', ...params.map((p) => p.name)].join(', ');
    const call = `this.nat.func('${m.methodname_flat}', ${ret.koffi}, [${koffiParams}])(${args})`;
    let body: string;
    if (ret.wrap === 'big') body = `    return BigInt(${call} as number | bigint);`;
    else if (ret.ts === 'void') body = `    ${call};`;
    else body = `    return ${call} as ${ret.ts};`;
    methods.push(`${doc}  ${short}(${sig}): ${ret.ts} {\n${body}\n  }`);

    if (m.callresult && m.returntype === 'SteamAPICall_t' && layoutNames.has(m.callresult)) {
      asyncMethods.push({
        short,
        sig,
        args: params.map((p) => p.name).join(', '),
        result: m.callresult,
        resultId: callbackIdByStruct.get(m.callresult),
        doc: asyncMethodDoc(cls, m),
        usesStringArray: params.some((p) => p.koffi === 'SteamParamStringArrayPtr'),
      });
    }
  }

  const imports = [`import type { SteamNative } from '../../runtime/native';`];
  if (valueStructs.size > 0) {
    const names = [...valueStructs].sort();
    imports.push(`import { ${names.map(valueTypeName).join(', ')} } from '../valuestructs';`);
    imports.push(`import type { ${names.join(', ')} } from '../structs';`);
  }
  if (usesStringArray) {
    imports.push(
      `import { SteamParamStringArrayPtr, type SteamParamStringArrayJs } from '../../runtime/types';`,
    );
  }
  const code = [
    HEADER,
    ...imports,
    '',
    `/**`,
    ` * ${cls} (accessor ${accessor.name_flat})`,
    ` * @see ${DOCS}/${cls}`,
    ` */`,
    `export class ${cls} {`,
    `  readonly ptr: unknown;`,
    `  constructor(private readonly nat: SteamNative) {`,
    `    this.ptr = nat.func('${accessor.name_flat}', 'void *', [])();`,
    `    if (this.ptr === null) throw new Error('steamwand: ${accessor.name_flat} returned null (is Steam initialized?)');`,
    `  }`,
    '',
    methods.join('\n\n'),
    `}`,
    '',
  ].join('\n');
  return { code, asyncMethods };
}

// ---------------------------------------------------------------------------
// Emit accessors.ts: one lazy getter per interface, for Steam to extend.

/**
 * Getter name for an interface class: drop the `ISteam` prefix, then camelize.
 * A leading acronym goes lowercase, except its last letter when a word follows
 * it: `ISteamUGC` -> `ugc`, `ISteamHTMLSurface` -> `htmlSurface`.
 */
function getterName(cls: string): string {
  const base = cls.replace(/^ISteam/, '');
  const run = /^[A-Z]+/.exec(base)?.[0] ?? '';
  const rest = base.slice(run.length);
  const keep = rest.length > 0 && run.length > 1 ? 1 : 0;
  return run.slice(0, run.length - keep).toLowerCase() + run.slice(run.length - keep) + rest;
}

/** One-line summary per interface, for the generated getters. */
const IFACE_DOCS: Record<string, string> = {
  ISteamApps: 'ISteamApps: ownership, install state, DLC, and beta branch.',
  ISteamController: 'ISteamController: the superseded controller API; new code uses ISteamInput.',
  ISteamFriends: 'ISteamFriends: friend list, personas, avatars, and overlay calls.',
  ISteamHTMLSurface: 'ISteamHTMLSurface: an offscreen browser surface, its input, and its events.',
  ISteamHTTP: "ISteamHTTP: HTTP requests through Steam's client networking.",
  ISteamInput: 'ISteamInput: controller handles, action sets, and action data.',
  ISteamInventory: 'ISteamInventory: the Steam Inventory Service: items, definitions, and grants.',
  ISteamMatchmaking: 'ISteamMatchmaking: lobbies, lobby data, and favorite servers.',
  ISteamMatchmakingServers: 'ISteamMatchmakingServers: server browser queries and server rules.',
  ISteamMusic: 'ISteamMusic: the Steam music player: play, pause, and volume.',
  ISteamNetworking: 'ISteamNetworking: the superseded P2P networking API.',
  ISteamNetworkingMessages: 'ISteamNetworkingMessages: connectionless messages to a peer identity.',
  ISteamNetworkingSockets: 'ISteamNetworkingSockets: connections, listen sockets, and poll groups.',
  ISteamNetworkingUtils: 'ISteamNetworkingUtils: ping locations, relay network status, and config values.',
  ISteamParentalSettings: 'ISteamParentalSettings: which features Steam family view allows.',
  ISteamParties: 'ISteamParties: public party beacons that players can join.',
  ISteamRemotePlay: 'ISteamRemotePlay: Remote Play sessions and Remote Play Together invites.',
  ISteamRemoteStorage: 'ISteamRemoteStorage: Steam Cloud files, quota, and sync state.',
  ISteamScreenshots: 'ISteamScreenshots: writing screenshots into the Steam screenshot library.',
  ISteamTimeline: 'ISteamTimeline: timeline events and phases for Steam game recording.',
  ISteamUGC: 'ISteamUGC: the raw workshop interface. Prefer {@link Steam.workshop} for the common tasks.',
  ISteamUser: 'ISteamUser: the logged in account, its Steam id, and auth tickets.',
  ISteamUserStats: 'ISteamUserStats: stats, achievements, and leaderboards.',
  ISteamUtils: 'ISteamUtils: app state, language, images, and API call bookkeeping.',
  ISteamVideo: 'ISteamVideo: video URLs and Steam broadcast state.',
};

function ifaceDoc(cls: string): string {
  return IFACE_DOCS[cls] ?? `${cls}: the generated flat interface.`;
}

function emitAccessors(ifaces: string[]): string {
  const out: string[] = [HEADER, `import type { SteamNative } from '../runtime/native';`];
  for (const n of ifaces) out.push(`import { ${n} } from './interfaces/${n}';`);
  out.push(
    '',
    `/**`,
    ` * Lazy, cached accessors for every generated interface class.`,
    ` *`,
    ` * \`Steam\` extends this, so reach them as \`steam.user\`, \`steam.ugc\`, and so on.`,
    ` * Each interface is created on first use and cached for the rest of the session.`,
    ` */`,
    `export class SteamInterfaces {`,
    `  private readonly ifaceCache = new Map<string, unknown>();`,
    '',
    `  /**`,
    `   * @param native - The loaded library and the core flat exports. Steam must already be initialized.`,
    `   */`,
    `  constructor(readonly native: SteamNative) {}`,
    '',
    `  /** Returns the cached interface instance for \`ctor\`, creating it on first use. */`,
    `  protected iface<T>(ctor: new (nat: SteamNative) => T): T {`,
    `    let v = this.ifaceCache.get(ctor.name) as T | undefined;`,
    `    if (!v) {`,
    `      v = new ctor(this.native);`,
    `      this.ifaceCache.set(ctor.name, v);`,
    `    }`,
    `    return v;`,
    `  }`,
  );
  for (const n of ifaces) {
    out.push('', `  /** ${ifaceDoc(n)} */`, `  get ${getterName(n)}(): ${n} {`, `    return this.iface(${n});`, `  }`);
  }
  out.push(`}`, '');
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Emit async.ts: promise wrappers for every flat call that returns a handle.

/** TSDoc block for one async companion method, indented for a class body. */
function asyncMethodDoc(cls: string, m: JMethod): string {
  const lines = [
    ` * \`${m.returntype} ${m.methodname}(${m.params.map(cParam).join(', ')})\``,
    ` *`,
    ` * Resolves with \`${m.callresult}\`.`,
    ` * @see ${DOCS}/${cls}#${m.methodname}`,
  ];
  return ['  /**', ...lines.map((l) => `  ${l}`), '   */', ''].join('\n');
}

function emitAsync(entries: { cls: string; methods: AsyncMethod[] }[]): string {
  const structs = new Set<string>();
  let usesStringArray = false;
  for (const e of entries) {
    for (const m of e.methods) {
      structs.add(m.result);
      if (m.usesStringArray) usesStringArray = true;
    }
  }
  const out: string[] = [
    HEADER,
    `import type { SteamDispatch } from '../runtime/dispatch';`,
    `import type { SteamInterfaces } from './accessors';`,
    `import { layoutOf } from './structs';`,
  ];
  if (usesStringArray) out.push(`import type { SteamParamStringArrayJs } from '../runtime/types';`);
  out.push(`import type {`, ...[...structs].sort().map((s) => `  ${s},`), `} from './structs';`);
  for (const e of entries) out.push(`import type { ${e.cls} } from './interfaces/${e.cls}';`);

  for (const e of entries) {
    out.push(
      '',
      `/**`,
      ` * Promise wrappers for the ${e.cls} calls that return a \`SteamAPICall_t\`.`,
      ` *`,
      ` * Each method starts the call and resolves with its decoded result struct.`,
      ` * Reach it as \`steam.async.${getterName(e.cls)}\`.`,
      ` */`,
      `export class ${e.cls}Async {`,
      `  /**`,
      `   * @param iface - The flat interface whose calls these wrap.`,
      `   * @param dispatch - Running pump that resolves the call results.`,
      `   */`,
      `  constructor(`,
      `    private readonly iface: ${e.cls},`,
      `    private readonly dispatch: SteamDispatch,`,
      `  ) {}`,
    );
    for (const m of e.methods) {
      out.push(
        '',
        m.doc.replace(/\n$/, ''),
        `  ${m.short}(${m.sig}): Promise<${m.result}> {`,
        `    return this.dispatch.callResultStruct<${m.result}>(`,
        `      this.iface.${m.short}(${m.args}),`,
        `      layoutOf('${m.result}'),`,
        ...(m.resultId === undefined ? [] : [`      ${m.resultId},`]),
        `    );`,
        `  }`,
      );
    }
    out.push(`}`);
  }

  out.push(
    '',
    `/**`,
    ` * Every async flat call, grouped by interface, as promises.`,
    ` *`,
    ` * Reach it as \`steam.async\`. Each companion is created on first use and cached.`,
    ` */`,
    `export class SteamAsync {`,
    `  private readonly asyncCache = new Map<string, unknown>();`,
    '',
    `  /**`,
    `   * @param ifaces - The interface accessors these calls run against.`,
    `   * @param dispatch - Running pump that resolves the call results.`,
    `   */`,
    `  constructor(`,
    `    private readonly ifaces: SteamInterfaces,`,
    `    private readonly dispatch: SteamDispatch,`,
    `  ) {}`,
    '',
    `  /** Returns the cached companion for \`key\`, creating it on first use. */`,
    `  private wrap<T>(key: string, make: () => T): T {`,
    `    let v = this.asyncCache.get(key) as T | undefined;`,
    `    if (!v) {`,
    `      v = make();`,
    `      this.asyncCache.set(key, v);`,
    `    }`,
    `    return v;`,
    `  }`,
  );
  for (const e of entries) {
    const g = getterName(e.cls);
    out.push(
      '',
      `  /** ${e.cls} calls that return a \`SteamAPICall_t\`, as promises. */`,
      `  get ${g}(): ${e.cls}Async {`,
      `    return this.wrap('${g}', () => new ${e.cls}Async(this.ifaces.${g}, this.dispatch));`,
      `  }`,
    );
  }
  out.push(`}`, '');
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Write everything

const genDir = path.join(repoRoot, 'src', 'generated');
const ifaceDir = path.join(genDir, 'interfaces');
fs.rmSync(genDir, { recursive: true, force: true });
fs.mkdirSync(ifaceDir, { recursive: true });

fs.writeFileSync(path.join(genDir, 'enums.ts'), emitEnums());
fs.writeFileSync(path.join(genDir, 'consts.ts'), emitConsts());

const emittedStructs: EmittedStruct[] = [];
for (const s of [...api.structs, ...api.callback_structs]) {
  const e = layoutBoth(s);
  if (e) emittedStructs.push(e);
}
for (const e of emittedStructs) layoutNames.add(e.name);
fs.writeFileSync(path.join(genDir, 'structs.ts'), emitStructs(emittedStructs));

const valueStructs = BY_VALUE_STRUCTS.map(valueStructOf);
fs.writeFileSync(path.join(genDir, 'valuestructs.ts'), emitValueStructs(valueStructs));

const cbs: { def: JCallbackStruct; layout: EmittedStruct }[] = [];
const seenCbIds = new Set<number>();
for (const def of api.callback_structs) {
  // A couple of gameserver structs alias a user callback id (e.g. 1108
  // UserStatsUnloaded_t / GSStatsUnloaded_t); first (user) definition wins.
  if (seenCbIds.has(def.callback_id)) continue;
  const layout = emittedStructs.find((e) => e.name === def.struct);
  if (layout) {
    seenCbIds.add(def.callback_id);
    cbs.push({ def, layout });
  }
}
fs.writeFileSync(path.join(genDir, 'callbacks.ts'), emitCallbacks(cbs));

const emittedIfaces: string[] = [];
const asyncEntries: { cls: string; methods: AsyncMethod[] }[] = [];
for (const iface of api.interfaces) {
  const accessor =
    (iface.accessors ?? []).find((a) => a.kind === 'user') ??
    (iface.accessors ?? []).find((a) => a.kind === 'global');
  if (!accessor) continue;
  const emitted = emitInterface(iface, accessor);
  if (emitted) {
    fs.writeFileSync(path.join(ifaceDir, `${iface.classname}.ts`), emitted.code);
    emittedIfaces.push(iface.classname);
    if (emitted.asyncMethods.length > 0) {
      asyncEntries.push({ cls: iface.classname, methods: emitted.asyncMethods });
    }
  }
}

fs.writeFileSync(path.join(genDir, 'accessors.ts'), emitAccessors(emittedIfaces));
fs.writeFileSync(path.join(genDir, 'async.ts'), emitAsync(asyncEntries));

const index = [
  HEADER,
  `export * from './enums';`,
  `export * from './consts';`,
  `export * from './structs';`,
  `export * from './callbacks';`,
  ...emittedIfaces.map((n) => `export { ${n} } from './interfaces/${n}';`),
  `export { SteamInterfaces } from './accessors';`,
  `export * from './async';`,
  '',
].join('\n');
fs.writeFileSync(path.join(genDir, 'index.ts'), index);

// ---------------------------------------------------------------------------
// Report

const asyncCount = asyncEntries.reduce((n, e) => n + e.methods.length, 0);
console.log(
  `generated: ${emittedIfaces.length} interfaces, ${emittedStructs.length} struct layouts, ` +
    `${valueStructs.length} by-value struct types, ${cbs.length} callbacks, ` +
    `${asyncCount} async wrappers over ${asyncEntries.length} interfaces`,
);
if (layoutFailures.size > 0) {
  console.warn(`structs without layouts (${layoutFailures.size}):`);
  for (const [name, why] of layoutFailures) console.warn(`  ${name}: ${why}`);
}
if (skippedMethods.length > 0) {
  console.warn(`methods skipped (${skippedMethods.length}):`);
  for (const m of skippedMethods) console.warn(`  ${m}`);
}
