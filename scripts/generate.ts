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
  const lines = [`export interface ${name} {`];
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
  const out: string[] = [HEADER, `import type { StructLayout } from '../runtime/struct';`, ''];
  out.push(`export interface CallbackDef { id: number; name: string; win64: StructLayout; posix: StructLayout }`, '');
  out.push(`export const callbacksById: Record<number, CallbackDef> = {`);
  for (const { def, layout } of cbs) {
    out.push(
      `  ${def.callback_id}: { id: ${def.callback_id}, name: '${def.struct}', win64: ${emitLayout(layout.win64)}, posix: ${emitLayout(layout.posix)} },`,
    );
  }
  out.push(`};`, '');
  out.push(`export const callbackId = {`);
  for (const { def } of cbs) out.push(`  ${def.struct}: ${def.callback_id},`);
  out.push(`} as const;`);
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
  return { name, koffi: `'${scalar.koffi}'`, ts: scalar.big ? 'bigint | number' : scalar.ts };
}

function mapReturn(t: string): { koffi: string; ts: string; wrap: 'big' | 'str' | 'none' } | undefined {
  if (t === 'void') return { koffi: `'void'`, ts: 'void', wrap: 'none' };
  if (t === 'const char *') return { koffi: `'str'`, ts: 'string', wrap: 'str' };
  if (OPAQUE_HANDLES.has(t) || t.includes('*') || t.includes('&'))
    return { koffi: `'void *'`, ts: 'unknown', wrap: 'none' };
  const scalar = resolveScalar(t);
  if (scalar.kind === 'unsupported') return undefined;
  if (scalar.big) return { koffi: `'${scalar.koffi}'`, ts: 'bigint', wrap: 'big' };
  return { koffi: `'${scalar.koffi}'`, ts: scalar.ts, wrap: 'none' };
}

function emitInterface(iface: JInterface, accessor: JAccessor): string | undefined {
  const cls = iface.classname;
  const methods: string[] = [];
  let usesStringArray = false;

  for (const m of iface.methods) {
    const short = m.methodname_flat.replace(`SteamAPI_${cls}_`, '');
    const ret = mapReturn(m.returntype);
    if (!ret) {
      skippedMethods.push(`${m.methodname_flat} (return ${m.returntype})`);
      continue;
    }
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
    const doc = m.callresult
      ? `  /** Call result: ${m.callresult} */\n`
      : m.callback
        ? `  /** Callback: ${m.callback} */\n`
        : '';
    const sig = params.map((p) => `${p.name}: ${p.ts}`).join(', ');
    const koffiParams = [`'void *'`, ...params.map((p) => p.koffi)].join(', ');
    const args = ['this.ptr', ...params.map((p) => p.name)].join(', ');
    const call = `this.nat.func('${m.methodname_flat}', ${ret.koffi}, [${koffiParams}])(${args})`;
    let body: string;
    if (ret.wrap === 'big') body = `    return BigInt(${call} as number | bigint);`;
    else if (ret.ts === 'void') body = `    ${call};`;
    else body = `    return ${call} as ${ret.ts};`;
    methods.push(`${doc}  ${short}(${sig}): ${ret.ts} {\n${body}\n  }`);
  }

  const imports = [`import type { SteamNative } from '../../runtime/native';`];
  if (usesStringArray) {
    imports.push(
      `import { SteamParamStringArrayPtr, type SteamParamStringArrayJs } from '../../runtime/types';`,
    );
  }
  return [
    HEADER,
    ...imports,
    '',
    `/** ${cls} (accessor ${accessor.name_flat}) */`,
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
fs.writeFileSync(path.join(genDir, 'structs.ts'), emitStructs(emittedStructs));

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
for (const iface of api.interfaces) {
  const accessor =
    (iface.accessors ?? []).find((a) => a.kind === 'user') ??
    (iface.accessors ?? []).find((a) => a.kind === 'global');
  if (!accessor) continue;
  const code = emitInterface(iface, accessor);
  if (code) {
    fs.writeFileSync(path.join(ifaceDir, `${iface.classname}.ts`), code);
    emittedIfaces.push(iface.classname);
  }
}

const index = [
  HEADER,
  `export * from './enums';`,
  `export * from './consts';`,
  `export * from './structs';`,
  `export * from './callbacks';`,
  ...emittedIfaces.map((n) => `export { ${n} } from './interfaces/${n}';`),
  '',
].join('\n');
fs.writeFileSync(path.join(genDir, 'index.ts'), index);

// ---------------------------------------------------------------------------
// Report

console.log(`generated: ${emittedIfaces.length} interfaces, ${emittedStructs.length} struct layouts, ${cbs.length} callbacks`);
if (layoutFailures.size > 0) {
  console.warn(`structs without layouts (${layoutFailures.size}):`);
  for (const [name, why] of layoutFailures) console.warn(`  ${name}: ${why}`);
}
if (skippedMethods.length > 0) {
  console.warn(`methods skipped (${skippedMethods.length}):`);
  for (const m of skippedMethods) console.warn(`  ${m}`);
}
