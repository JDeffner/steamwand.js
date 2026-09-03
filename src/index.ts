import { SteamNative } from './runtime/native';
import { SteamDispatch } from './runtime/dispatch';
import { decodeStruct, type StructLayout } from './runtime/struct';
import { ESteamAPIInitResult } from './generated/enums';
import { callbackIdByName, callbacksById, type SteamCallbackMap } from './generated/callbacks';
import { SteamInterfaces } from './generated/accessors';
import { SteamAsync } from './generated/async';
import { SteamInitError } from './api/errors';
import { Workshop } from './api/workshop';
import { Stats } from './api/stats';
import { Cloud } from './api/cloud';
import { Leaderboards } from './api/leaderboards';
import { Lobbies } from './api/lobbies';
import { Social } from './api/social';
import { Overlay } from './api/overlay';
import { Apps } from './api/apps';
import { Auth } from './api/auth';
import { System } from './api/system';
import { Capture } from './api/capture';
import { Controllers } from './api/controllers';

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
 * stats, cloud, leaderboards, lobbies, social, overlay, auth, system, capture,
 * controllers, dlc), and the running dispatch pump.
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
  private socialHelper: Social | undefined;
  private overlayHelper: Overlay | undefined;
  private appsHelper: Apps | undefined;
  private authHelper: Auth | undefined;
  private systemHelper: System | undefined;
  private captureHelper: Capture | undefined;
  private controllersHelper: Controllers | undefined;
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
   * Task level friends, presence, and avatar helper over
   * {@link Steam.friends}. Named `social` because the generated ISteamFriends
   * accessor already owns `friends`.
   *
   * @see Social
   */
  get social(): Social {
    if (!this.socialHelper) {
      this.socialHelper = new Social(this.friends, this.utils, (n, l) => this.on(n, l));
    }
    return this.socialHelper;
  }

  /**
   * Task level Steam overlay helper over {@link Steam.friends} and
   * {@link Steam.utils}.
   *
   * @see Overlay
   */
  get overlay(): Overlay {
    if (!this.overlayHelper) {
      this.overlayHelper = new Overlay(this.friends, this.utils, (n, l) => this.on(n, l));
    }
    return this.overlayHelper;
  }

  /**
   * Task level DLC helper over {@link Steam.apps}. Named `dlc` because the
   * generated ISteamApps accessor already owns `apps`.
   *
   * @see Apps
   */
  get dlc(): Apps {
    if (!this.appsHelper) this.appsHelper = new Apps(this.apps);
    return this.appsHelper;
  }

  /**
   * Task level auth ticket helper over {@link Steam.user}. Named `auth`
   * because the generated ISteamUser accessor already owns `user`.
   *
   * @see Auth
   */
  get auth(): Auth {
    if (!this.authHelper) this.authHelper = new Auth(this.user, this.dispatch, (n, l) => this.on(n, l), (n, m) => this.once(n, m));
    return this.authHelper;
  }

  /**
   * Task level machine and client facts helper over {@link Steam.utils} and
   * {@link Steam.apps}. Named `system` because the generated ISteamUtils
   * accessor already owns `utils`.
   *
   * @see System
   */
  get system(): System {
    if (!this.systemHelper) this.systemHelper = new System(this.utils, this.apps, (n, l) => this.on(n, l), (n, m) => this.once(n, m));
    return this.systemHelper;
  }

  /**
   * Task level screenshot helper over {@link Steam.screenshots}. Named
   * `capture` because the generated ISteamScreenshots accessor already owns
   * `screenshots`.
   *
   * @see Capture
   */
  get capture(): Capture {
    if (!this.captureHelper) this.captureHelper = new Capture(this.screenshots, (n, l) => this.on(n, l));
    return this.captureHelper;
  }

  /**
   * Task level Steam Input helper over {@link Steam.input}. Named
   * `controllers` because the generated ISteamInput accessor already owns
   * `input`.
   *
   * @see Controllers
   */
  get controllers(): Controllers {
    if (!this.controllersHelper) this.controllersHelper = new Controllers(this.input, (n, l) => this.on(n, l));
    return this.controllersHelper;
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

  /** Callback id and this platform's layout for a callback struct name. */
  private callbackDef(callbackName: string): { id: number; layout: StructLayout } {
    const id = callbackIdByName[callbackName];
    const def = id === undefined ? undefined : callbacksById[id];
    if (!def) throw new Error(`steamwand: unknown callback struct '${callbackName}'`);
    return { id, layout: process.platform === 'win32' ? def.win64 : def.posix };
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
    const { id, layout } = this.callbackDef(callbackName);
    return this.dispatch.on(id, (buf) => listener(decodeStruct<SteamCallbackMap[K]>(buf, layout)));
  }

  /**
   * Awaits the first plain callback of `callbackName` that `match` accepts,
   * decoded via the generated layout.
   *
   * The awaitable form of {@link Steam.on}, for the flat calls that answer
   * through a broadcast callback instead of a call result. The pump keeps the
   * process alive while the promise is pending.
   *
   * @param callbackName - Struct name exactly as in the SDK, for example `GetAuthSessionTicketResponse_t`.
   * @param match - Runs on every such callback with the decoded struct. The first true one settles the promise.
   * @defaultValue accept the first callback
   * @typeParam K - The callback name, which decides the result type.
   * @returns The decoded callback struct. 64-bit fields are `bigint`.
   * @throws Error if no generated callback carries that name, or if {@link Steam.close} runs while still waiting.
   * @example
   * ```ts
   * import { init } from 'steamwand.js';
   *
   * const steam = init({ appId: 480 });
   * const ticket = Buffer.alloc(1024);
   * const size = Buffer.alloc(4);
   * const handle = steam.user.GetAuthSessionTicket(ticket, ticket.length, size, null);
   * const r = await steam.once('GetAuthSessionTicketResponse_t', (e) => e.m_hAuthTicket === handle);
   * console.log(r.m_eResult);
   * ```
   * @see SteamDispatch.once
   */
  once<K extends keyof SteamCallbackMap & string>(
    callbackName: K,
    match: (data: SteamCallbackMap[K]) => boolean = () => true,
  ): Promise<SteamCallbackMap[K]> {
    const { id, layout } = this.callbackDef(callbackName);
    const decode = (buf: Buffer) => decodeStruct<SteamCallbackMap[K]>(buf, layout);
    return this.dispatch.once(id, (buf) => match(decode(buf))).then(decode);
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
  AdditionalPreview,
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
/** Task level friends, presence, and avatar helper. Usually reached as `steam.social`. */
export { Social } from './api/social';
export type {
  Avatar,
  AvatarSize,
  Friend,
  LobbyJoinRequest,
  PersonaStateChange,
  RichPresenceJoinRequest,
} from './api/social';
/** Task level Steam overlay helper. Usually reached as `steam.overlay`. */
export { Overlay } from './api/overlay';
export type { OverlayActivation, OverlayDialog, OverlayUserDialog } from './api/overlay';
/** Task level DLC helper. Usually reached as `steam.dlc`. */
export { Apps } from './api/apps';
export type { DlcInfo } from './api/apps';
/** Task level auth ticket helper. Usually reached as `steam.auth`. */
export { Auth } from './api/auth';
export type { AuthTicket, ValidateTicketResult } from './api/auth';
/** Task level machine and client facts helper. Usually reached as `steam.system`. */
export { System } from './api/system';
export type { GamepadTextInputOptions, SteamImage } from './api/system';
/** Task level screenshot helper. Usually reached as `steam.capture`. */
export { Capture } from './api/capture';
export type { ScreenshotReady } from './api/capture';
/** Task level Steam Input helper. Usually reached as `steam.controllers`. */
export { Controllers } from './api/controllers';
export type { AnalogAction, DigitalAction } from './api/controllers';
/** The raw generated flat API: every interface class, enum, const, and layout. */
export * as flat from './generated';
