/**
 * steamwand workbench: a local web UI to poke the whole binding by hand,
 * including destructive workshop actions. Run: pnpm workbench
 * Then open http://localhost:4879
 */
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { init, Steam, stringArray, flat } from '../src';
import { decodeStruct } from '../src/runtime/struct';

const PORT = 4879;

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

function listInterfaces(): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const [name, v] of Object.entries(flat)) {
    if (typeof v === 'function' && name.startsWith('ISteam')) {
      result[name] = Object.getOwnPropertyNames((v as { prototype: object }).prototype).filter((m) => m !== 'constructor');
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
      steam = init({ appId: Number(body.appId) || 480 });
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
      return listInterfaces();
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

const html = fs.readFileSync(path.join(__dirname, 'workbench.html'), 'utf8');

http
  .createServer(async (req, res) => {
    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html);
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
  .listen(PORT, '127.0.0.1', () => {
    console.log(`steamwand workbench: http://localhost:${PORT}`);
  });
