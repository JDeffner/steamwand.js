import { SteamNative } from './runtime/native';
import { SteamDispatch } from './runtime/dispatch';
import { decodeStruct, type StructLayout } from './runtime/struct';
import { ESteamAPIInitResult } from './generated/enums';
import { callbacksById, type SteamCallbackMap } from './generated/callbacks';
import { SteamInterfaces } from './generated/accessors';
import { SteamAsync } from './generated/async';
import { SteamInitError } from './api/errors';
import { Workshop } from './api/workshop';
import { Stats } from './api/stats';
import { Cloud } from './api/cloud';
import { Leaderboards } from './api/leaderboards';
import { Lobbies } from './api/lobbies';

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
 * A live Steam API session: the interfaces, the curated helpers (workshop,
 * stats, cloud, leaderboards, lobbies), and the running dispatch pump.
 *
 * Build one with {@link init}, and call {@link Steam.close} when you are done.
 * Interfaces are created on first use and cached.
 *
 * @see init
 */
export class Steam extends SteamInterfaces {
  /** The running manual-dispatch pump. Use it to await raw call handles. */
  readonly dispatch: SteamDispatch;
  private workshopHelper: Workshop | undefined;
  private statsHelper: Stats | undefined;
  private cloudHelper: Cloud | undefined;
  private leaderboardsHelper: Leaderboards | undefined;
  private lobbiesHelper: Lobbies | undefined;
  private asyncCalls: SteamAsync | undefined;
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
    super(native);
    this.dispatch = dispatch;
  }

  /**
   * Task level workshop helper over {@link Steam.ugc}, bound to this session's
   * app id and dispatch.
   *
   * @see Workshop
   */
  get workshop(): Workshop {
    if (!this.workshopHelper) this.workshopHelper = new Workshop(this.ugc, this.dispatch, this.appId);
    return this.workshopHelper;
  }

  /**
   * Task level achievements and stats helper over {@link Steam.userStats}.
   *
   * @see Stats
   */
  get stats(): Stats {
    if (!this.statsHelper) this.statsHelper = new Stats(this.userStats, this.dispatch);
    return this.statsHelper;
  }

  /**
   * Task level Steam Cloud helper over {@link Steam.remoteStorage}.
   *
   * @see Cloud
   */
  get cloud(): Cloud {
    if (!this.cloudHelper) this.cloudHelper = new Cloud(this.remoteStorage, this.dispatch);
    return this.cloudHelper;
  }

  /**
   * Task level leaderboards helper over {@link Steam.userStats}.
   *
   * @see Leaderboards
   */
  get leaderboards(): Leaderboards {
    if (!this.leaderboardsHelper) this.leaderboardsHelper = new Leaderboards(this.userStats, this.dispatch);
    return this.leaderboardsHelper;
  }

  /**
   * Task level lobbies helper over {@link Steam.matchmaking}.
   *
   * @see Lobbies
   */
  get lobbies(): Lobbies {
    if (!this.lobbiesHelper) this.lobbiesHelper = new Lobbies(this.matchmaking, this.dispatch, (n, l) => this.on(n, l));
    return this.lobbiesHelper;
  }

  /**
   * Every flat call that returns a `SteamAPICall_t`, as a promise that resolves
   * with the decoded result struct, grouped by interface.
   *
   * This is the generated layer, so it resolves with whatever Steam returns: a
   * non-OK `EResult` inside the struct is not an error here.
   *
   * @example
   * ```ts
   * import { init } from 'steamwand.js';
   *
   * const steam = init({ appId: 480 });
   * const r = await steam.async.userStats.FindLeaderboard('Quickest Win');
   * console.log(r.m_bLeaderboardFound, r.m_hSteamLeaderboard);
   * steam.close();
   * ```
   * @see SteamDispatch.callResultStruct
   */
  get async(): SteamAsync {
    if (!this.asyncCalls) this.asyncCalls = new SteamAsync(this, this.dispatch);
    return this.asyncCalls;
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
   * @param callbackName - Struct name exactly as in the SDK, for example `ItemInstalled_t`. Checked against {@link flat.SteamCallbackMap} at compile time.
   * @param listener - Runs on every such callback, inside a pump frame. 64-bit fields are `bigint`.
   * @typeParam K - The callback name, which decides the listener's argument type.
   * @returns Unsubscribe function. Calling it more than once is harmless.
   * @throws Error if no generated callback carries that name.
   * @example
   * ```ts
   * import { init } from 'steamwand.js';
   *
   * const steam = init({ appId: 480 });
   * const off = steam.on('ItemInstalled_t', (e) => {
   *   console.log('installed', e.m_nPublishedFileId); // bigint
   * });
   * // later: off();
   * ```
   * @see SteamDispatch.on
   */
  on<K extends keyof SteamCallbackMap & string>(
    callbackName: K,
    listener: (data: SteamCallbackMap[K]) => void,
  ): () => void {
    const def = Object.values(callbacksById).find((c) => c.name === callbackName);
    if (!def) throw new Error(`steamwand: unknown callback struct '${callbackName}'`);
    const layout: StructLayout = process.platform === 'win32' ? def.win64 : def.posix;
    return this.dispatch.on(def.id, (buf) => listener(decodeStruct<SteamCallbackMap[K]>(buf, layout)));
  }

  /**
   * Stops the pump and shuts the Steam API down.
   *
   * Idempotent: a second call does nothing. Calls that are still in flight
   * reject. Do not use this `Steam` or its interfaces after it.
   *
   * This also releases the one-session-per-process lock, so {@link init} may be
   * called again afterwards.
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
    sessionActive = false;
    this.dispatch.stop();
    this.native.shutdown();
  }
}

/**
 * True between a successful {@link init} and the matching {@link Steam.close}.
 * The Steam API and its dispatch pump are process-global, so a second session
 * would pump the same queue twice and steal the first one's callbacks.
 */
let sessionActive = false;

/**
 * Initialize the Steam API (flat init + manual dispatch) and start the pump.
 * Steam must be running; init errors surface Valve's own diagnostic message.
 *
 * The process is switched to manual dispatch, so never call
 * SteamAPI_RunCallbacks after this. Only one session may be open at a time:
 * calling this again before {@link Steam.close} throws. Init after close is
 * allowed.
 *
 * @param opts - App id, library path, and pump interval.
 * @returns The live session.
 * @throws Error if a session is already open. Close it first.
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
  if (sessionActive) {
    throw new Error('steamwand: a Steam session is already open (one init per process); call close() on it first');
  }
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
  sessionActive = true;
  const appId = opts.appId ?? Number(process.env.SteamAppId ?? 0);
  return new Steam(native, dispatch, appId);
}

/**
 * Relaunches the app through Steam when it was started some other way, for
 * example straight from the executable.
 *
 * Call this before {@link init}, at the very top of the process. When it
 * returns true, Steam is starting your app again, so exit immediately and let
 * that copy take over. It always returns false when a `steam_appid.txt` sits
 * next to the executable, which is why that file only belongs in development.
 *
 * @param appId - App id to relaunch under.
 * @param libPath - Override the bundled steam_api redistributable.
 * @defaultValue the bundled library for this platform
 * @returns True if Steam is relaunching the app, so this process must exit.
 * @throws Error if the library cannot be loaded from `libPath`.
 * @example
 * ```ts
 * import { restartAppIfNecessary, init } from 'steamwand.js';
 *
 * if (restartAppIfNecessary(480)) process.exit(0);
 * const steam = init({ appId: 480 });
 * ```
 * @see init
 */
export function restartAppIfNecessary(appId: number, libPath?: string): boolean {
  const native = new SteamNative(libPath);
  return native.func('SteamAPI_RestartAppIfNecessary', 'bool', ['uint32'])(appId) as boolean;
}

/**
 * Returns whether a Steam client is running on this machine.
 *
 * Call this before {@link init} to tell "Steam is not running" apart from the
 * other init failures. It loads the library but does not start the Steam API,
 * so it is safe to call on its own.
 *
 * @param libPath - Override the bundled steam_api redistributable.
 * @defaultValue the bundled library for this platform
 * @returns True if a Steam client is running.
 * @throws Error if the library cannot be loaded from `libPath`.
 * @see init
 */
export function isSteamRunning(libPath?: string): boolean {
  const native = new SteamNative(libPath);
  return native.func('SteamAPI_IsSteamRunning', 'bool', [])() as boolean;
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
/** Typed out-parameter buffers for the flat API: `out.bool()`, `out.uint64()`, ... */
export { out } from './runtime/out';
export type { OutParam } from './runtime/out';
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
/** Task level achievements and stats helper. Usually reached as `steam.stats`. */
export { Stats } from './api/stats';
export type { AchievementDisplay, AchievementState } from './api/stats';
/** Task level Steam Cloud helper. Usually reached as `steam.cloud`. */
export { Cloud } from './api/cloud';
export type { CloudFile, CloudFileInfo, CloudQuota } from './api/cloud';
/** Task level leaderboards helper. Usually reached as `steam.leaderboards`. */
export { Leaderboards } from './api/leaderboards';
export type { DownloadOptions, LeaderboardEntry, LeaderboardInfo, ScoreUploadResult } from './api/leaderboards';
/** Task level lobbies helper. Usually reached as `steam.lobbies`. */
export { Lobbies } from './api/lobbies';
export type { LobbyChatMessage, LobbySearchOptions } from './api/lobbies';
/** The raw generated flat API: every interface class, enum, const, and layout. */
export * as flat from './generated';
