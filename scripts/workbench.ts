/**
 * steamwand workbench: a local web UI to poke the whole binding by hand,
 * including destructive workshop actions. Run: pnpm workbench
 * Then open http://localhost:4879
 *
 * Needs the Steam client running and logged in. The page explains the workflow;
 * the per-method help it shows comes from `loadSignatures`.
 */
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { init, Steam, stringArray, flat } from '../src';
import { decodeStruct } from '../src/runtime/struct';

const PORT = Number(process.env.PORT) || 4879;

let steam: Steam | undefined;
let closedOnce = false;
const log: { time: string; kind: string; text: string }[] = [];
const watchers = new Map<string, () => void>();

function addLog(kind: string, text: string): void {
  log.push({ time: new Date().toISOString().slice(11, 19), kind, text });
  if (log.length > 500) log.splice(0, log.length - 500);
}

// bigint-safe JSON
const out = (v: unknown): string =>
  JSON.stringify(v, (_k, x) => {
    if (typeof x === 'bigint') return `${x}n`;
    // JSON.stringify applies Buffer.toJSON before the replacer runs.
    if (x && typeof x === 'object' && (x as { type?: string }).type === 'Buffer' && Array.isArray((x as { data?: unknown }).data)) {
      x = Buffer.from((x as { data: number[] }).data);
    }
    if (Buffer.isBuffer(x)) {
      const nul = x.indexOf(0);
      return { buffer: true, bytes: x.length, hex: x.subarray(0, 64).toString('hex'), text: x.toString('utf8', 0, nul === -1 ? Math.min(x.length, 200) : nul) };
    }
    return x;
  });

function reviveArg(a: unknown): unknown {
  if (typeof a === 'string' && /^-?\d+n$/.test(a)) return BigInt(a.slice(0, -1));
  if (Array.isArray(a) && a.every((x) => typeof x === 'string')) return stringArray(a as string[]);
  if (a && typeof a === 'object' && 'buf' in (a as object)) return Buffer.alloc(Number((a as { buf: number }).buf));
  return a;
}

const ifaceCache = new Map<string, object>();
function getIface(name: string): Record<string, (...args: unknown[]) => unknown> {
  if (!steam) throw new Error('not initialized');
  let inst = ifaceCache.get(name);
  if (!inst) {
    const Ctor = (flat as Record<string, unknown>)[name];
    if (typeof Ctor !== 'function') throw new Error(`unknown interface ${name}`);
    inst = new (Ctor as new (nat: unknown) => object)(steam.native);
    ifaceCache.set(name, inst);
  }
  return inst as Record<string, (...args: unknown[]) => unknown>;
}

/** What a raw call takes, lifted from the generated source so the UI can spell it out. */
interface MethodSig {
  /** The C declaration, e.g. `bool SetItemTitle(UGCUpdateHandle_t handle, const char *pchTitle)`. */
  c: string;
  params: { name: string; type: string; note?: string }[];
  returns: string;
  /** partner.steamgames.com page for this method. */
  doc?: string;
}

/** A JSDoc block plus the method declaration that follows it, in a generated interface. */
const SIG_RE = /\/\*\*\n((?:[ \t]*\*.*\n)+?)[ \t]*\*\/\n[ \t]*(\w+)\(([^\n]*?)\):\s*([^\n{]+?)\s*\{/g;

/**
 * Parses the generated interface sources for every method's C signature,
 * parameter names, and doc link. Without it the raw call panel is two dropdowns
 * and an empty args box, and you have to read the source to use it.
 */
function loadSignatures(): Record<string, Record<string, MethodSig>> {
  const dir = path.join(__dirname, '..', 'src', 'generated', 'interfaces');
  const all: Record<string, Record<string, MethodSig>> = {};
  for (const file of fs.readdirSync(dir)) {
    // Generated files check out with CRLF on Windows; normalize so SIG_RE sees plain lines.
    const src = fs.readFileSync(path.join(dir, file), 'utf8').replace(/\r\n/g, '\n');
    const methods: Record<string, MethodSig> = {};
    for (const [, doc, name, params, returns] of src.matchAll(SIG_RE)) {
      const notes = new Map<string, string>();
      for (const [, p, text] of doc.matchAll(/@param (\w+) (.+)/g)) notes.set(p, text.replace(/`/g, ''));
      methods[name] = {
        c: doc.match(/`([^`]+)`/)?.[1] ?? name,
        params: params
          ? params.split(', ').map((p) => {
              const [pName, pType] = p.split(': ');
              return { name: pName, type: pType, note: notes.get(pName) };
            })
          : [],
        returns,
        doc: doc.match(/@see (https:\S+)/)?.[1],
      };
    }
    all[path.basename(file, '.ts')] = methods;
  }
  return all;
}

const signatures = loadSignatures();

/**
 * Every callable interface method, with its signature attached where the parse
 * found one. Method names come from the prototype rather than the parse, so no
 * method can disappear from the UI if the generated format ever shifts.
 */
function listInterfaces(): Record<string, Record<string, MethodSig | null>> {
  const result: Record<string, Record<string, MethodSig | null>> = {};
  for (const [name, v] of Object.entries(flat)) {
    if (typeof v === 'function' && name.startsWith('ISteam')) {
      const methods: Record<string, MethodSig | null> = {};
      for (const m of Object.getOwnPropertyNames((v as { prototype: object }).prototype)) {
        if (m !== 'constructor') methods[m] = signatures[name]?.[m] ?? null;
      }
      result[name] = methods;
    }
  }
  return result;
}

async function handle(url: string, body: any): Promise<unknown> {
  switch (url) {
    case '/api/status':
      return { initialized: !!steam, appId: steam?.appId, log };
    case '/api/init': {
      if (steam) throw new Error('already initialized; close first (one app id per process)');
      if (closedOnce)
        throw new Error('Steam cannot re-initialize in the same process after close; restart the workbench (pnpm workbench)');
      const appId = Number(body.appId) || 480;
      try {
        steam = init({ appId });
      } catch (e) {
        throw new Error(
          `${(e as Error).message} - check that Steam is running, that you are logged in, and that your account owns app id ${appId}. App id 480 (Spacewar) works on any account.`,
        );
      }
      addLog('session', `initialized as appId ${steam.appId}, user ${steam.steamId()}`);
      return { ok: true, steamId: steam.steamId(), accountId: steam.accountId() };
    }
    case '/api/close': {
      steam?.close();
      steam = undefined;
      closedOnce = true;
      ifaceCache.clear();
      watchers.clear();
      addLog('session', 'closed (restart the workbench to re-init: Steam re-init in one process is unreliable)');
      return { ok: true };
    }
    case '/api/interfaces':
      // Callback and struct names ride along so their inputs can autocomplete.
      return {
        interfaces: listInterfaces(),
        callbacks: Object.keys(flat.callbackId).sort(),
        structs: Object.keys(flat.structLayouts).sort(),
      };
    case '/api/call': {
      const iface = getIface(body.iface);
      const fn = iface[body.method];
      if (typeof fn !== 'function') throw new Error(`no method ${body.method} on ${body.iface}`);
      const args = (body.args ?? []).map(reviveArg);
      const result = fn.apply(iface, args);
      addLog('call', `${body.iface}.${body.method}(${out(body.args ?? [])}) -> ${out(result)}`);
      // Hand buffers back so out-params are readable.
      return { result, outBuffers: args.filter(Buffer.isBuffer) };
    }
    case '/api/awaitResult': {
      if (!steam) throw new Error('not initialized');
      const call = BigInt(String(body.call).replace(/n$/, ''));
      const buf = await steam.dispatch.callResult(call);
      const structName = body.struct as string | undefined;
      const decoded = structName ? decodeStruct(buf, flat.layoutOf(structName)) : undefined;
      addLog('callresult', `call ${call} -> ${structName ? out(decoded) : `${buf.length} bytes`}`);
      return { raw: buf, decoded };
    }
    case '/api/watch': {
      if (!steam) throw new Error('not initialized');
      const name = String(body.callback);
      if (watchers.has(name)) return { ok: true, already: true };
      const off = steam.on(name, (data) => addLog('callback', `${name}: ${out(data)}`));
      watchers.set(name, off);
      addLog('session', `watching callback ${name}`);
      return { ok: true };
    }
    case '/api/workshop': {
      if (!steam) throw new Error('not initialized');
      const w = steam.workshop;
      const fileId = body.fileId ? BigInt(String(body.fileId).replace(/n$/, '')) : undefined;
      switch (body.op) {
        case 'createItem': {
          const r = await w.createItem();
          addLog('workshop', `created item ${r.fileId} (legal agreement required: ${r.legalAgreementRequired})`);
          return r;
        }
        case 'submitUpdate': {
          const u = body.update ?? {};
          for (const k of Object.keys(u)) if (u[k] === '' || u[k] === null) delete u[k];
          if (u.tags) u.tags = String(u.tags).split(',').map((t: string) => t.trim()).filter(Boolean);
          if (u.visibility !== undefined) u.visibility = Number(u.visibility);
          const r = await w.submitUpdate(fileId!, u, {
            onProgress: (p) => addLog('progress', `status ${p.status}: ${p.bytesProcessed}/${p.bytesTotal} bytes`),
          });
          addLog('workshop', `submitted update to ${fileId}: ${out(r)}`);
          return r;
        }
        case 'getItem': {
          const r = await w.getItem(fileId!, { language: body.language || undefined, longDescription: true });
          addLog('workshop', `getItem ${fileId} -> ${r ? r.title : 'null'}`);
          return r;
        }
        case 'getUserItems': {
          const r = await w.getUserItems(Number(body.page) || 1, steam.accountId(), {
            appId: body.appId ? Number(body.appId) : undefined,
          });
          addLog('workshop', `getUserItems -> ${r.totalResults} total`);
          return r;
        }
        case 'deleteItem': {
          await w.deleteItem(fileId!);
          addLog('workshop', `DELETED item ${fileId}`);
          return { ok: true };
        }
        default:
          throw new Error(`unknown workshop op ${body.op}`);
      }
    }
    default:
      throw new Error(`unknown endpoint ${url}`);
  }
}

const HTML_PATH = path.join(__dirname, 'workbench.html');

http
  .createServer(async (req, res) => {
    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
      // Read per request so editing the page only needs a browser refresh.
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(fs.readFileSync(HTML_PATH, 'utf8'));
      return;
    }
    if (req.url?.startsWith('/api/')) {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      let body: any = {};
      try {
        body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
      } catch {
        /* empty body is fine */
      }
      try {
        const result = await handle(req.url, body);
        res.writeHead(200, { 'content-type': 'application/json' }).end(out(result));
      } catch (e) {
        addLog('error', (e as Error).message);
        res.writeHead(400, { 'content-type': 'application/json' }).end(out({ error: (e as Error).message }));
      }
      return;
    }
    res.writeHead(404).end();
  })
  .on('error', (e: NodeJS.ErrnoException) => {
    if (e.code !== 'EADDRINUSE') throw e;
    console.error(
      `\n  Port ${PORT} is already in use, most likely by a workbench you left running.\n` +
        `  Close that one, or start this on another port:  npx cross-env PORT=${PORT + 1} pnpm workbench\n`,
    );
    process.exit(1);
  })
  .listen(PORT, '127.0.0.1', () => {
    console.log(`
  steamwand workbench   http://localhost:${PORT}

  Start Steam and log in before you press init. Nothing touches Steam until then.
  Workshop create, update, and delete write for real, under the app id you init with.
  Steam allows one init per process: after close, restart this script.
`);
  });
