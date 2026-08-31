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

/**
 * Options for {@link init}.
 */
export interface InitOptions {
  /**
   * App id to initialize under. Omit to rely on steam_appid.txt / existing env.
   * When set, `init` writes it to the `SteamAppId` and `SteamGameId` env vars
   * before loading the library.
   */
  appId?: number;
  /**
   * Override the bundled steam_api redistributable. Absolute path of the .dll,
   * .so, or .dylib to load.
   *
   * @defaultValue the bundled library for this platform
   */
  libPath?: string;
  /**
   * Manual-dispatch pump interval (default 50ms, unref'd). The timer is ref'd
   * again while a call is in flight, so it never blocks process exit but also
   * never lets the process exit under an awaited call.
   */
  pumpIntervalMs?: number;
}

/**
 * A live Steam API session: the interfaces, the workshop helper, and the
 * running dispatch pump.
 *
 * Build one with {@link init}, and call {@link Steam.close} when you are done.
 * Interfaces are created on first use and cached.
 *
 * @see init
 */
export class Steam {
  /** The loaded library and the core flat exports. */
  readonly native: SteamNative;
  /** The running manual-dispatch pump. Use it to await raw call handles. */
  readonly dispatch: SteamDispatch;
  private readonly cache = new Map<string, unknown>();
  private closed = false;

  /**
   * Wraps an already initialized native library and a started dispatch. Use
   * {@link init} instead, which does both.
   *
   * @param native - Library with `SteamAPI_InitFlat` already run.
   * @param dispatch - Started pump for the same library.
   * @param appId - App id this session runs under. Used as the default in `workshop`.
   */
  constructor(
    native: SteamNative,
    dispatch: SteamDispatch,
    readonly appId: number,
  ) {
    this.native = native;
    this.dispatch = dispatch;
  }

  /** Returns the cached interface instance for `ctor`, creating it on first use. */
  private iface<T>(ctor: new (nat: SteamNative) => T): T {
    let v = this.cache.get(ctor.name) as T | undefined;
    if (!v) {
      v = new ctor(this.native);
      this.cache.set(ctor.name, v);
    }
    return v;
  }

  /** ISteamUser: the logged in account, its Steam id, and auth tickets. */
  get user(): ISteamUser {
    return this.iface(ISteamUser);
  }
  /** ISteamFriends: friend list, personas, avatars, and overlay calls. */
  get friends(): ISteamFriends {
    return this.iface(ISteamFriends);
  }
  /** ISteamUtils: app state, language, images, and API call bookkeeping. */
  get utils(): ISteamUtils {
    return this.iface(ISteamUtils);
  }
  /** ISteamApps: ownership, install state, DLC, and beta branch. */
  get apps(): ISteamApps {
    return this.iface(ISteamApps);
  }
  /** ISteamUserStats: stats, achievements, and leaderboards. */
  get userStats(): ISteamUserStats {
    return this.iface(ISteamUserStats);
  }
  /**
   * ISteamUGC: the raw workshop interface. Prefer {@link Steam.workshop} for
   * the common tasks.
   */
  get ugc(): ISteamUGC {
    return this.iface(ISteamUGC);
  }

  /**
   * Task level workshop helper over {@link Steam.ugc}, bound to this session's
   * app id and dispatch.
   *
   * @see Workshop
   */
  get workshop(): Workshop {
    let v = this.cache.get('workshop') as Workshop | undefined;
    if (!v) {
      v = new Workshop(this.ugc, this.dispatch, this.appId);
      this.cache.set('workshop', v);
    }
    return v;
  }

  /**
   * Returns the local user's 64-bit Steam id.
   *
   * @returns The Steam id. 64-bit, so a `bigint`.
   * @see accountId
   */
  steamId(): bigint {
    return this.user.GetSteamID();
  }

  /**
   * Returns the local user's 32-bit account id (lower half of the Steam id).
   *
   * This is the id `Workshop.getUserItems` takes.
   *
   * @returns The account id, small enough for a `number`.
   * @see steamId
   */
  accountId(): number {
    return Number(this.steamId() & 0xffffffffn);
  }

  /**
   * Subscribe to a plain Steam callback by struct name (e.g. 'ItemInstalled_t'),
   * decoded via the generated layout. Returns an unsubscribe function.
   *
   * This is for broadcast callbacks only. The result of an async call is not
   * one, await it through `steam.dispatch` instead.
   *
   * @param callbackName - Struct name exactly as in the SDK, for example `ItemInstalled_t`.
   * @param listener - Runs on every such callback, inside a pump frame. 64-bit fields are `bigint`.
   * @typeParam T - Generated struct interface for the callback.
   * @returns Unsubscribe function. Calling it more than once is harmless.
   * @throws Error if no generated callback carries that name.
   * @example
   * ```ts
   * import { init, flat } from 'steamwand.js';
   *
   * const steam = init({ appId: 480 });
   * const off = steam.on<flat.ItemInstalled_t>('ItemInstalled_t', (e) => {
   *   console.log('installed', e.m_nPublishedFileId); // bigint
   * });
   * // later: off();
   * ```
   * @see SteamDispatch.on
   */
  on<T>(callbackName: string, listener: (data: T) => void): () => void {
    const def = Object.values(callbacksById).find((c) => c.name === callbackName);
    if (!def) throw new Error(`steamwand: unknown callback struct '${callbackName}'`);
    const layout: StructLayout = process.platform === 'win32' ? def.win64 : def.posix;
    return this.dispatch.on(def.id, (buf) => listener(decodeStruct<T>(buf, layout)));
  }

  /**
   * Stops the pump and shuts the Steam API down.
   *
   * Idempotent: a second call does nothing. Calls that are still in flight
   * reject. Do not use this `Steam` or its interfaces after it.
   *
   * @example
   * ```ts
   * import { init } from 'steamwand.js';
   *
   * const steam = init({ appId: 480 });
   * try {
   *   console.log(steam.friends.GetPersonaName());
   * } finally {
   *   steam.close();
   * }
   * ```
   * @see SteamDispatch.stop
   */
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
 *
 * The process is switched to manual dispatch, so never call
 * SteamAPI_RunCallbacks after this. Call once per process, and call
 * {@link Steam.close} when you are done.
 *
 * @param opts - App id, library path, and pump interval.
 * @returns The live session.
 * @throws SteamInitError if `SteamAPI_InitFlat` fails, for example because Steam is not running or the account does not own the app. `initResult` carries the `ESteamAPIInitResult`.
 * @throws Error if the library cannot be loaded from `libPath`.
 * @example
 * ```ts
 * import { init } from 'steamwand.js';
 *
 * const steam = init({ appId: 480 });
 * console.log(steam.steamId(), steam.friends.GetPersonaName());
 * steam.close();
 * ```
 * @see Steam.close
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

/** The loaded library and the core flat exports. Usually reached as `steam.native`. */
export { SteamNative } from './runtime/native';
/** The manual dispatch pump and its call error. Usually reached as `steam.dispatch`. */
export { SteamDispatch, SteamApiCallError } from './runtime/dispatch';
/** Decodes raw callback bytes with a generated offset table. */
export { decodeStruct } from './runtime/struct';
export type { StructLayout, FieldLayout, FieldType } from './runtime/struct';
/** Wraps a string array for a flat parameter of type `SteamParamStringArray_t *`. */
export { stringArray } from './runtime/types';
/** The two error classes this package throws, plus the EResult namer. */
export { SteamInitError, SteamResultError, eResultName } from './api/errors';
/** Task level workshop helper. Usually reached as `steam.workshop`. */
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
