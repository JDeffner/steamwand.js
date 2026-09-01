import type { SteamDispatch } from '../runtime/dispatch';
import { out } from '../runtime/out';
import type { ISteamUserStats } from '../generated/interfaces/ISteamUserStats';
import { layoutOf } from '../generated/structs';
import type {
  GlobalAchievementPercentagesReady_t,
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
 * Leaderboards live in `steam.leaderboards`; global stats stay on the
 * generated `steam.userStats` methods.
 *
 * @see Steam.stats
 * @see SteamResultError
 */
export class Stats {
  /**
   * @param userStats - The ISteamUserStats interface.
   * @param dispatch - Running pump that resolves the call results.
   */
  constructor(
    private readonly userStats: ISteamUserStats,
    private readonly dispatch: SteamDispatch,
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
    const percentages: Record<string, number> = {};
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
   * Once this resolves, read the cached values with the generated user-scoped
   * calls: `steam.userStats.GetUserStatInt32`, `GetUserStatFloat`,
   * `GetUserAchievement`, and `GetUserAchievementAndUnlockTime`.
   *
   * @param steamId - Steam id of the user. 64-bit, so a `bigint`.
   * @throws SteamResultError if Steam refused, for example with `k_EResultFail` when the user's profile is private.
   * @throws SteamApiCallError if the call could not be completed.
   * @example
   * ```ts
   * import { init, out } from 'steamwand.js';
   *
   * const steam = init({ appId: 480 });
   * const friend = 76561197960287930n;
   * await steam.stats.requestUserStats(friend);
   * const kills = out.int32();
   * steam.userStats.GetUserStatInt32(friend, 'kills', kills.buffer);
   * console.log(kills.value);
   * steam.close();
   * ```
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
}
