import { SteamNative } from './runtime/native';
import { SteamDispatch } from './runtime/dispatch';
import { decodeStruct, type StructLayout } from './runtime/struct';
import { ESteamAPIInitResult } from './generated/enums';
import { callbacksById } from './generated/callbacks';
import { ISteamApps } from './generated/interfaces/ISteamApps';
import { ISteamFriends } from './generated/interfaces/ISteamFriends';
import { ISteamUGC } from './generated/interfaces/ISteamUGC';
import { ISteamUser } from './generated/interfaces/ISteamUser';
import { ISteamUserStats } from './generated/interfaces/ISteamUserStats';
import { ISteamUtils } from './generated/interfaces/ISteamUtils';
import { SteamInitError } from './api/errors';
import { Workshop } from './api/workshop';

export interface InitOptions {
  /** App id to initialize under. Omit to rely on steam_appid.txt / existing env. */
  appId?: number;
  /** Override the bundled steam_api redistributable. */
  libPath?: string;
  /** Manual-dispatch pump interval (default 50ms, unref'd). */
  pumpIntervalMs?: number;
}

export class Steam {
  readonly native: SteamNative;
  readonly dispatch: SteamDispatch;
  private readonly cache = new Map<string, unknown>();
  private closed = false;

  constructor(
    native: SteamNative,
    dispatch: SteamDispatch,
    readonly appId: number,
  ) {
    this.native = native;
    this.dispatch = dispatch;
  }

  private iface<T>(ctor: new (nat: SteamNative) => T): T {
    let v = this.cache.get(ctor.name) as T | undefined;
    if (!v) {
      v = new ctor(this.native);
      this.cache.set(ctor.name, v);
    }
    return v;
  }

  get user(): ISteamUser {
    return this.iface(ISteamUser);
  }
  get friends(): ISteamFriends {
    return this.iface(ISteamFriends);
  }
  get utils(): ISteamUtils {
    return this.iface(ISteamUtils);
  }
  get apps(): ISteamApps {
    return this.iface(ISteamApps);
  }
  get userStats(): ISteamUserStats {
    return this.iface(ISteamUserStats);
  }
  get ugc(): ISteamUGC {
    return this.iface(ISteamUGC);
  }

  get workshop(): Workshop {
    let v = this.cache.get('workshop') as Workshop | undefined;
    if (!v) {
      v = new Workshop(this.ugc, this.dispatch, this.appId);
      this.cache.set('workshop', v);
    }
    return v;
  }

  /** The local user's 64-bit Steam id. */
  steamId(): bigint {
    return this.user.GetSteamID();
  }

  /** The local user's 32-bit account id (lower half of the Steam id). */
  accountId(): number {
    return Number(this.steamId() & 0xffffffffn);
  }

  /**
   * Subscribe to a plain Steam callback by struct name (e.g. 'ItemInstalled_t'),
   * decoded via the generated layout. Returns an unsubscribe function.
   */
  on<T>(callbackName: string, listener: (data: T) => void): () => void {
    const def = Object.values(callbacksById).find((c) => c.name === callbackName);
    if (!def) throw new Error(`steamwand: unknown callback struct '${callbackName}'`);
    const layout: StructLayout = process.platform === 'win32' ? def.win64 : def.posix;
    return this.dispatch.on(def.id, (buf) => listener(decodeStruct<T>(buf, layout)));
  }

  /** Stop the pump and shut the Steam API down. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.dispatch.stop();
    this.native.shutdown();
  }
}

/**
 * Initialize the Steam API (flat init + manual dispatch) and start the pump.
 * Steam must be running; init errors surface Valve's own diagnostic message.
 */
export function init(opts: InitOptions = {}): Steam {
  if (opts.appId !== undefined) {
    process.env.SteamAppId = String(opts.appId);
    process.env.SteamGameId = String(opts.appId);
  }
  const native = new SteamNative(opts.libPath);
  const errMsg = Buffer.alloc(1024);
  const result = native.initFlat(errMsg);
  if (result !== ESteamAPIInitResult.k_ESteamAPIInitResult_OK) {
    const text = errMsg.toString('utf8', 0, Math.max(errMsg.indexOf(0), 0));
    throw new SteamInitError(text || `SteamAPI_InitFlat failed (${result})`, result);
  }
  native.manualDispatchInit();
  const dispatch = new SteamDispatch(native, native.getHSteamPipe());
  dispatch.start(opts.pumpIntervalMs);
  const appId = opts.appId ?? Number(process.env.SteamAppId ?? 0);
  return new Steam(native, dispatch, appId);
}

export { SteamNative } from './runtime/native';
export { SteamDispatch, SteamApiCallError } from './runtime/dispatch';
export { decodeStruct } from './runtime/struct';
export type { StructLayout, FieldLayout, FieldType } from './runtime/struct';
export { stringArray } from './runtime/types';
export { SteamInitError, SteamResultError, eResultName } from './api/errors';
export { Workshop } from './api/workshop';
export type {
  QueryOptions,
  UpdateProgress,
  UserItemsPage,
  WorkshopItem,
  WorkshopItemUpdate,
  WorkshopStatistic,
} from './api/workshop';
/** The raw generated flat API: every interface class, enum, const, and layout. */
export * as flat from './generated';
