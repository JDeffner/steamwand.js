import type { SteamDispatch } from '../runtime/dispatch';
import { out } from '../runtime/out';
import type { ISteamUserStats } from '../generated/interfaces/ISteamUserStats';
import type { SteamCallbackMap } from '../generated/callbacks';
import { layoutOf } from '../generated/structs';
import type {
  GlobalAchievementPercentagesReady_t,
  GlobalStatsReceived_t,
  NumberOfCurrentPlayers_t,
  UserStatsReceived_t,
} from '../generated/structs';
import { callbackIdByName } from '../generated/callbacks';
import { ok, must } from './guards';

/**
 * State of one achievement for the current user.
 *
 * @see Stats.getAchievement
 */
export interface AchievementState {
  /** True once the user unlocked it. */
  achieved: boolean;
  /** Unlock time in Unix seconds, or null while the achievement is locked. */
  unlockTime: number | null;
}

/**
 * Display text of one achievement, in the Steam client language.
 *
 * The text comes from the achievement configuration in the partner site, so a
 * name that is not configured reads back as an empty string.
 *
 * @see Stats.getDisplay
 */
export interface AchievementDisplay {
  /** Localized display name. */
  name: string;
  /** Localized description. Empty while the achievement is hidden and locked. */
  description: string;
  /** True if Steam hides the achievement from the user until it unlocks. */
  hidden: boolean;
}

/**
 * Task level wrapper over ISteamUserStats: achievements and per-user stats.
 *
 * Steam loads the current user's stats during `init`, so the read methods work
 * right away. They are local reads with no round trip: `unlock`, `clear`, and
 * `store` are the only methods that send anything to Steam. Reach it as
 * `steam.stats`.
 *
 * Leaderboards live in `steam.leaderboards`.
 *
 * @see Steam.stats
 * @see SteamResultError
 */
export class Stats {
  /**
   * @param userStats - The ISteamUserStats interface.
   * @param dispatch - Running pump that resolves the call results.
   * @param once - Awaitable callback subscriber, normally `steam.once` bound to the session.
   */
  constructor(
    private readonly userStats: ISteamUserStats,
    private readonly dispatch: SteamDispatch,
    private readonly once: <K extends keyof SteamCallbackMap & string>(
      name: K,
      match?: (data: SteamCallbackMap[K]) => boolean,
    ) => Promise<SteamCallbackMap[K]>,
  ) {}

  /**
   * Reads whether the current user unlocked an achievement.
   *
   * @param name - Achievement API name, as configured on the partner site.
   * @returns True if the achievement is unlocked.
   * @throws Error if the app has no achievement with that API name.
   * @example
   * ```ts
   * import { init } from 'steamwand.js';
   *
   * const steam = init({ appId: 480 });
   * if (!steam.stats.isAchieved('ACH_WIN_ONE_GAME')) steam.stats.unlock('ACH_WIN_ONE_GAME');
   * steam.close();
   * ```
   * @see getAchievement
   */
  isAchieved(name: string): boolean {
    const achieved = out.bool();
    must('GetAchievement', this.userStats.GetAchievement(name, achieved.buffer));
    return achieved.value;
  }

  /**
   * Reads an achievement with its unlock time.
   *
   * @param name - Achievement API name.
   * @returns `achieved`, and `unlockTime` in Unix seconds or null while locked.
   * @throws Error if the app has no achievement with that API name.
   * @see isAchieved
   */
  getAchievement(name: string): AchievementState {
    const achieved = out.bool();
    const unlockTime = out.uint32();
    must(
      'GetAchievementAndUnlockTime',
      this.userStats.GetAchievementAndUnlockTime(name, achieved.buffer, unlockTime.buffer),
    );
    return { achieved: achieved.value, unlockTime: achieved.value ? unlockTime.value : null };
  }

  /**
   * Reads the localized display text of an achievement.
   *
   * @param name - Achievement API name.
   * @returns The display name, description, and hidden flag. Fields are empty for an unknown API name.
   * @see listAchievements
   */
  getDisplay(name: string): AchievementDisplay {
    return {
      name: this.userStats.GetAchievementDisplayAttribute(name, 'name') ?? '',
      description: this.userStats.GetAchievementDisplayAttribute(name, 'desc') ?? '',
      hidden: this.userStats.GetAchievementDisplayAttribute(name, 'hidden') === '1',
    };
  }

  /**
   * Fetches the icon of an achievement and returns its Steam image handle.
   *
   * Steam either has the icon cached, in which case this resolves at once, or
   * it starts a download and answers with `UserAchievementIconFetched_t`. Both
   * paths end here. Decode the pixels with `steam.system.image(handle)`.
   *
   * The icon Steam gives back is the locked or the unlocked one, whichever
   * matches the current state, so read it again after `unlock`.
   *
   * @param name - Achievement API name.
   * @returns The image handle, or null when the achievement has no icon configured.
   * @throws Error if the promise is still waiting when the session closes. An
   * API name this app does not define never gets an answer, so check it against
   * `listAchievements` first.
   * @example
   * ```ts
   * import { init } from 'steamwand.js';
   *
   * const steam = init({ appId: 480 });
   * const handle = await steam.stats.achievementIcon('ACH_WIN_ONE_GAME');
   * const icon = handle === null ? null : steam.system.image(handle);
   * console.log(icon?.width, icon?.height);
   * steam.close();
   * ```
   * @see listAchievements
   */
  async achievementIcon(name: string): Promise<number | null> {
    // Steam sends no callback for an unknown API name, which would leave the
    // promise pending forever; GetAchievement is false for exactly that case.
    must('GetAchievement', this.userStats.GetAchievement(name, out.bool().buffer));
    const handle = this.userStats.GetAchievementIcon(name);
    if (handle !== 0) return handle;
    // 0 means Steam started a download rather than "no icon"; the callback
    // carries the real answer, and its own 0 is the one that means no icon.
    const r = await this.once('UserAchievementIconFetched_t', (e) => e.m_rgchAchievementName === name);
    return r.m_nIconHandle === 0 ? null : r.m_nIconHandle;
  }

  /**
   * Lists the API names of every achievement this app defines.
   *
   * Steam knows the list only after it loaded the app's stats schema, so an
   * empty array right after `init` means the schema is not there yet, not that
   * the app has no achievements.
   *
   * @returns The API names, in the order the partner site defines them.
   * @example
   * ```ts
   * import { init } from 'steamwand.js';
   *
   * const steam = init({ appId: 480 });
   * for (const name of steam.stats.listAchievements()) {
   *   console.log(name, steam.stats.getDisplay(name).name, steam.stats.isAchieved(name));
   * }
   * steam.close();
   * ```
   * @see getDisplay
   */
  listAchievements(): string[] {
    const count = this.userStats.GetNumAchievements();
    const names: string[] = [];
    for (let i = 0; i < count; i++) names.push(this.userStats.GetAchievementName(i));
    return names;
  }

  /**
   * Unlocks an achievement and stores it.
   *
   * Steam shows the unlock notification on the store, so there is no reason to
   * batch this. Unlocking an already unlocked achievement does nothing.
   *
   * @param name - Achievement API name.
   * @throws Error if the app has no achievement with that API name, or if the store failed.
   * @see clear
   * @see indicateProgress
   */
  unlock(name: string): void {
    must('SetAchievement', this.userStats.SetAchievement(name));
    must('StoreStats', this.userStats.StoreStats());
  }

  /**
   * Locks an achievement again and stores it.
   *
   * Meant for testing. A released game normally never clears an achievement.
   *
   * @param name - Achievement API name.
   * @throws Error if the app has no achievement with that API name, or if the store failed.
   * @see unlock
   */
  clear(name: string): void {
    must('ClearAchievement', this.userStats.ClearAchievement(name));
    must('StoreStats', this.userStats.StoreStats());
  }

  /**
   * Shows the progress toast for a progress achievement ("30 of 100 kills").
   *
   * This only draws the notification. It does not unlock anything and it does
   * not record the progress: keep the progress in a stat and call `unlock`
   * yourself when it reaches the maximum.
   *
   * @param name - Achievement API name.
   * @param current - Progress so far. Steam ignores the call if this is not above the last shown value.
   * @param max - Progress value that completes the achievement.
   * @throws Error if the app has no achievement with that API name.
   * @example
   * ```ts
   * import { init } from 'steamwand.js';
   *
   * const steam = init({ appId: 480 });
   * const kills = steam.stats.getInt('kills') + 1;
   * steam.stats.setInt('kills', kills);
   * steam.stats.store();
   * if (kills < 100) steam.stats.indicateProgress('ACH_100_KILLS', kills, 100);
   * else steam.stats.unlock('ACH_100_KILLS');
   * steam.close();
   * ```
   * @see unlock
   */
  indicateProgress(name: string, current: number, max: number): void {
    must('IndicateAchievementProgress', this.userStats.IndicateAchievementProgress(name, current, max));
  }

  /**
   * Reads the progress range the partner site configured for an achievement.
   *
   * Saves hard-coding the "of 100" in `indicateProgress`: read the maximum here
   * and the toast stays right when the configuration changes.
   *
   * @param name - Achievement API name.
   * @returns The min and max progress, or null for an achievement with no progress configured.
   * @example
   * ```ts
   * import { init } from 'steamwand.js';
   *
   * const steam = init({ appId: 480 });
   * const limits = steam.stats.getProgressLimits('ACH_100_KILLS');
   * if (limits) steam.stats.indicateProgress('ACH_100_KILLS', steam.stats.getInt('kills'), limits.max);
   * steam.close();
   * ```
   * @see indicateProgress
   */
  getProgressLimits(name: string): { min: number; max: number } | null {
    const min = out.int32();
    const max = out.int32();
    if (!this.userStats.GetAchievementProgressLimitsInt32(name, min.buffer, max.buffer)) return null;
    return { min: min.value, max: max.value };
  }

  /**
   * Reads an integer stat of the current user.
   *
   * @param name - Stat API name, as configured on the partner site.
   * @returns The current value, or 0 if the user never set it.
   * @throws Error if the app has no INT stat with that API name.
   * @see setInt
   */
  getInt(name: string): number {
    const value = out.int32();
    must('GetStatInt32', this.userStats.GetStatInt32(name, value.buffer));
    return value.value;
  }

  /**
   * Reads a float stat of the current user.
   *
   * Works for AVGRATE stats too, which read back as the current average.
   *
   * @param name - Stat API name.
   * @returns The current value, or 0 if the user never set it.
   * @throws Error if the app has no FLOAT or AVGRATE stat with that API name.
   * @see setFloat
   */
  getFloat(name: string): number {
    const value = out.float();
    must('GetStatFloat', this.userStats.GetStatFloat(name, value.buffer));
    return value.value;
  }

  /**
   * Sets an integer stat of the current user.
   *
   * The value stays local until `store`. That is on purpose: set every stat
   * that changed, then store once.
   *
   * @param name - Stat API name.
   * @param value - New value. Steam rejects it if the partner site set a max and this is above it.
   * @throws Error if the app has no INT stat with that API name.
   * @see store
   */
  setInt(name: string, value: number): void {
    must('SetStatInt32', this.userStats.SetStatInt32(name, value));
  }

  /**
   * Sets a float stat of the current user.
   *
   * The value stays local until `store`.
   *
   * @param name - Stat API name.
   * @param value - New value.
   * @throws Error if the app has no FLOAT stat with that API name.
   * @see store
   */
  setFloat(name: string, value: number): void {
    must('SetStatFloat', this.userStats.SetStatFloat(name, value));
  }

  /**
   * Feeds one session into an AVGRATE stat, for example "kills per hour".
   *
   * Steam keeps the running average itself; read it back with `getFloat`. The
   * value stays local until `store`.
   *
   * @param name - Stat API name. Must be an AVGRATE stat.
   * @param sessionCount - What happened this session, for example the number of kills.
   * @param sessionLength - How long the session lasted, in the unit the stat is configured with (usually seconds).
   * @throws Error if the app has no AVGRATE stat with that API name.
   * @see getFloat
   * @see store
   */
  updateAvgRate(name: string, sessionCount: number, sessionLength: number): void {
    must('UpdateAvgRateStat', this.userStats.UpdateAvgRateStat(name, sessionCount, sessionLength));
  }

  /**
   * Sends every pending stat change to Steam.
   *
   * The setters are local, so nothing is persisted until this runs. Call it at
   * a natural break, for example at the end of a level or on shutdown. It
   * returns as soon as Steam accepted the batch; the server round trip
   * finishes in the background.
   *
   * @throws Error if Steam refused the batch, which means it is not logged on or a value is above its configured max.
   * @see setInt
   * @see setFloat
   */
  store(): void {
    must('StoreStats', this.userStats.StoreStats());
  }

  /**
   * Resets every stat of the current user, and optionally every achievement.
   *
   * Meant for testing. This stores by itself, and it cannot be undone.
   *
   * @param alsoAchievements - Also lock every achievement again.
   * @defaultValue false
   * @throws Error if Steam refused the reset.
   */
  resetAll(alsoAchievements = false): void {
    must('ResetAllStats', this.userStats.ResetAllStats(alsoAchievements));
  }

  /**
   * Asks Steam how many people are playing this app right now.
   *
   * @returns The player count Steam reported.
   * @throws Error if Steam could not answer, for example while it is offline.
   * @throws SteamApiCallError if the call could not be completed.
   * @example
   * ```ts
   * import { init } from 'steamwand.js';
   *
   * const steam = init({ appId: 480 });
   * console.log(await steam.stats.getNumberOfCurrentPlayers(), 'players online');
   * steam.close();
   * ```
   */
  async getNumberOfCurrentPlayers(): Promise<number> {
    const call = this.userStats.GetNumberOfCurrentPlayers();
    const r = await this.dispatch.callResultStruct<NumberOfCurrentPlayers_t>(
      call,
      layoutOf('NumberOfCurrentPlayers_t'),
      callbackIdByName.NumberOfCurrentPlayers_t,
    );
    if (r.m_bSuccess === 0) throw new Error('steamwand: GetNumberOfCurrentPlayers failed (is Steam online?)');
    return r.m_cPlayers;
  }

  /**
   * Fetches, for every achievement of this app, the share of players who
   * unlocked it.
   *
   * One round trip (RequestGlobalAchievementPercentages) fills Steam's local
   * cache, then every percentage is read from it.
   *
   * @returns Achievement API name to percentage, 0 to 100. An achievement Steam has no data for is absent.
   * @throws SteamResultError if Steam refused the request, for example with `k_EResultFail` while offline.
   * @throws SteamApiCallError if the call could not be completed.
   * @example
   * ```ts
   * import { init } from 'steamwand.js';
   *
   * const steam = init({ appId: 480 });
   * const percent = await steam.stats.getGlobalPercentages();
   * console.log(percent['ACH_WIN_ONE_GAME']?.toFixed(1), '% of players');
   * steam.close();
   * ```
   * @see listAchievements
   */
  async getGlobalPercentages(): Promise<Record<string, number>> {
    const call = this.userStats.RequestGlobalAchievementPercentages();
    const r = await this.dispatch.callResultStruct<GlobalAchievementPercentagesReady_t>(
      call,
      layoutOf('GlobalAchievementPercentagesReady_t'),
      callbackIdByName.GlobalAchievementPercentagesReady_t,
    );
    ok('RequestGlobalAchievementPercentages', r.m_eResult);
    // A prototype-free object, so an achievement API name like __proto__ stays
    // a normal entry instead of touching the prototype chain.
    const percentages: Record<string, number> = Object.create(null);
    const percent = out.float();
    for (const name of this.listAchievements()) {
      if (this.userStats.GetAchievementAchievedPercent(name, percent.buffer)) percentages[name] = percent.value;
    }
    return percentages;
  }

  /**
   * Downloads another user's stats and achievements into Steam's local cache.
   *
   * Only needed for other users; the current user's stats are already there.
   * Once this resolves, read the cached values with `getUserAchievement`,
   * `getUserInt`, and `getUserFloat`.
   *
   * @param steamId - Steam id of the user. 64-bit, so a `bigint`.
   * @throws SteamResultError if Steam refused, for example with `k_EResultFail` when the user's profile is private.
   * @throws SteamApiCallError if the call could not be completed.
   * @example
   * ```ts
   * import { init } from 'steamwand.js';
   *
   * const steam = init({ appId: 480 });
   * const friend = 76561197960287930n;
   * await steam.stats.requestUserStats(friend);
   * console.log(steam.stats.getUserInt(friend, 'kills'));
   * steam.close();
   * ```
   * @see getUserAchievement
   * @see getUserInt
   */
  async requestUserStats(steamId: bigint): Promise<void> {
    const call = this.userStats.RequestUserStats(steamId);
    const r = await this.dispatch.callResultStruct<UserStatsReceived_t>(
      call,
      layoutOf('UserStatsReceived_t'),
      callbackIdByName.UserStatsReceived_t,
    );
    ok('RequestUserStats', r.m_eResult);
  }

  /**
   * Reads another user's achievement with its unlock time.
   *
   * `requestUserStats(steamId)` must have resolved for that user first; this is
   * a local read against the cache it filled.
   *
   * @param steamId - Steam id of the user. 64-bit, so a `bigint`.
   * @param name - Achievement API name.
   * @returns `achieved`, and `unlockTime` in Unix seconds or null while locked.
   * @throws Error if the stats for that user are not in the cache, or the app has no achievement with that API name.
   * @example
   * ```ts
   * import { init } from 'steamwand.js';
   *
   * const steam = init({ appId: 480 });
   * const friend = 76561197960287930n;
   * await steam.stats.requestUserStats(friend);
   * console.log(steam.stats.getUserAchievement(friend, 'ACH_WIN_ONE_GAME').achieved);
   * steam.close();
   * ```
   * @see requestUserStats
   * @see getAchievement
   */
  getUserAchievement(steamId: bigint, name: string): AchievementState {
    const achieved = out.bool();
    const unlockTime = out.uint32();
    must(
      'GetUserAchievementAndUnlockTime',
      this.userStats.GetUserAchievementAndUnlockTime(steamId, name, achieved.buffer, unlockTime.buffer),
    );
    return { achieved: achieved.value, unlockTime: achieved.value ? unlockTime.value : null };
  }

  /**
   * Reads another user's integer stat.
   *
   * `requestUserStats(steamId)` must have resolved for that user first.
   *
   * @param steamId - Steam id of the user. 64-bit, so a `bigint`.
   * @param name - Stat API name.
   * @returns The value, or 0 if that user never set it.
   * @throws Error if the stats for that user are not in the cache, or the app has no INT stat with that API name.
   * @see requestUserStats
   */
  getUserInt(steamId: bigint, name: string): number {
    const value = out.int32();
    must('GetUserStatInt32', this.userStats.GetUserStatInt32(steamId, name, value.buffer));
    return value.value;
  }

  /**
   * Reads another user's float stat.
   *
   * `requestUserStats(steamId)` must have resolved for that user first. Works
   * for AVGRATE stats too, which read back as that user's current average.
   *
   * @param steamId - Steam id of the user. 64-bit, so a `bigint`.
   * @param name - Stat API name.
   * @returns The value, or 0 if that user never set it.
   * @throws Error if the stats for that user are not in the cache, or the app has no FLOAT or AVGRATE stat with that API name.
   * @see requestUserStats
   */
  getUserFloat(steamId: bigint, name: string): number {
    const value = out.float();
    must('GetUserStatFloat', this.userStats.GetUserStatFloat(steamId, name, value.buffer));
    return value.value;
  }

  /**
   * Downloads this app's aggregated global stats into Steam's local cache.
   *
   * Global stats are the sums over every player, and only stats the partner
   * site marks as aggregated have them. Nothing reads back before this
   * resolves, so it is the first call of the group.
   *
   * @param historyDays - How many days of daily history to fetch too, at most 60. 0 for the totals only.
   * @defaultValue 0
   * @throws SteamResultError if Steam refused, for example with `k_EResultInvalidState` when the app aggregates no stat at all.
   * @throws SteamApiCallError if the call could not be completed.
   * @example
   * ```ts
   * import { init } from 'steamwand.js';
   *
   * const steam = init({ appId: 480 });
   * await steam.stats.requestGlobalStats(7);
   * console.log(steam.stats.getGlobalInt('kills_total'));
   * console.log(steam.stats.getGlobalIntHistory('kills_total', 7));
   * steam.close();
   * ```
   * @see getGlobalInt
   * @see getGlobalIntHistory
   */
  async requestGlobalStats(historyDays = 0): Promise<void> {
    const call = this.userStats.RequestGlobalStats(historyDays);
    const r = await this.dispatch.callResultStruct<GlobalStatsReceived_t>(
      call,
      layoutOf('GlobalStatsReceived_t'),
      callbackIdByName.GlobalStatsReceived_t,
    );
    ok('RequestGlobalStats', r.m_eResult);
  }

  /**
   * Reads the global total of an integer stat.
   *
   * `requestGlobalStats` must have resolved first. The total is 64-bit because
   * it sums over every player, so it is a `bigint`.
   *
   * @param name - Stat API name. It must be aggregated on the partner site.
   * @returns The total across every player.
   * @throws Error if the global stats are not in the cache, or the app aggregates no INT stat with that API name.
   * @see requestGlobalStats
   */
  getGlobalInt(name: string): bigint {
    const value = out.int64();
    must('GetGlobalStatInt64', this.userStats.GetGlobalStatInt64(name, value.buffer));
    return value.value;
  }

  /**
   * Reads the global total of a float stat.
   *
   * `requestGlobalStats` must have resolved first.
   *
   * @param name - Stat API name. It must be aggregated on the partner site.
   * @returns The total across every player.
   * @throws Error if the global stats are not in the cache, or the app aggregates no FLOAT stat with that API name.
   * @see requestGlobalStats
   */
  getGlobalDouble(name: string): number {
    const value = out.double();
    must('GetGlobalStatDouble', this.userStats.GetGlobalStatDouble(name, value.buffer));
    return value.value;
  }

  /**
   * Reads the daily history of an integer global stat.
   *
   * `requestGlobalStats` must have resolved with at least this many
   * `historyDays` first, or the history is not in the cache.
   *
   * @param name - Stat API name. It must be aggregated on the partner site.
   * @param days - How many days to read, most recent first. At most 60.
   * @returns One total per day, today first. Shorter than `days` when Steam has
   * less history, and empty when it has none.
   * @example
   * ```ts
   * import { init } from 'steamwand.js';
   *
   * const steam = init({ appId: 480 });
   * await steam.stats.requestGlobalStats(7);
   * const [today, yesterday] = steam.stats.getGlobalIntHistory('kills_total', 7);
   * console.log(today, yesterday);
   * steam.close();
   * ```
   * @see requestGlobalStats
   */
  getGlobalIntHistory(name: string, days: number): bigint[] {
    if (days <= 0) return [];
    const buffer = Buffer.alloc(days * 8);
    // Steam returns how many days it actually wrote, which is at most `days`
    // and can be 0 for a stat it has no history for.
    const written = Math.min(this.userStats.GetGlobalStatHistoryInt64(name, buffer, buffer.length), days);
    const history: bigint[] = [];
    for (let i = 0; i < written; i++) history.push(buffer.readBigInt64LE(i * 8));
    return history;
  }
}
