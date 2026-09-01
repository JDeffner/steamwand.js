import type { SteamDispatch } from '../runtime/dispatch';
import { decodeStruct } from '../runtime/struct';
import type { ISteamUserStats } from '../generated/interfaces/ISteamUserStats';
import { layoutOf } from '../generated/structs';
import type {
  LeaderboardEntry_t,
  LeaderboardFindResult_t,
  LeaderboardScoreUploaded_t,
  LeaderboardScoresDownloaded_t,
  LeaderboardUGCSet_t,
} from '../generated/structs';
import { ELeaderboardDataRequest, ELeaderboardUploadScoreMethod } from '../generated/enums';
import { callbackIdByName } from '../generated/callbacks';
import { ok, must } from './guards';

/**
 * One leaderboard, with the properties Steam keeps next to its handle.
 *
 * Every other method takes the `handle`, not the name, so keep this around for
 * as long as you use the leaderboard.
 *
 * @see Leaderboards.find
 * @see Leaderboards.findOrCreate
 */
export interface LeaderboardInfo {
  /** SteamLeaderboard_t. 64-bit, so a `bigint`. Pass it to every other method. */
  handle: bigint;
  /** Leaderboard name, as Steam has it. Max 128 UTF-8 bytes. */
  name: string;
  /** Number of entries on the leaderboard right now. */
  entryCount: number;
  /** ELeaderboardSortMethod (0 none, 1 ascending, 2 descending). */
  sortMethod: number;
  /** ELeaderboardDisplayType (0 none, 1 numeric, 2 seconds, 3 milliseconds). */
  displayType: number;
}

/**
 * What Steam did with an uploaded score.
 *
 * @see Leaderboards.uploadScore
 */
export interface ScoreUploadResult {
  /** True if the score replaced the user's previous one. False when keep-best kept the old score. */
  scoreChanged: boolean;
  /** The user's rank after the upload, 1-based. */
  newGlobalRank: number;
  /** The user's rank before the upload, 1-based, or 0 if they had no entry yet. */
  previousGlobalRank: number;
}

/**
 * One downloaded leaderboard entry.
 *
 * @see Leaderboards.downloadEntries
 */
export interface LeaderboardEntry {
  /** Steam id of the user who set the score. 64-bit, so a `bigint`. */
  steamId: bigint;
  /** Rank on the leaderboard, 1-based. */
  globalRank: number;
  /** The score itself. Always a 32-bit signed integer. */
  score: number;
  /** Game defined details, at most `maxDetails` of them. Empty when none were requested or stored. */
  details: number[];
  /** UGCHandle_t of the attached replay, or `k_UGCHandleInvalid` if the entry has none. 64-bit, so a `bigint`. */
  ugcHandle: bigint;
}

/**
 * Which entries to download, and how many details to read per entry.
 *
 * @see Leaderboards.downloadEntries
 */
export interface DownloadOptions {
  /** ELeaderboardDataRequest (0 global, 1 around user, 2 friends). */
  dataRequest?: number;
  /** First entry to fetch. An absolute 1-based rank for global, an offset from the user's own rank for around-user, ignored for friends. */
  rangeStart?: number;
  /** Last entry to fetch, read the same way as `rangeStart`. */
  rangeEnd?: number;
  /** Details to read per entry. Steam stores at most 64. Leave at 0 if the game stores none. */
  maxDetails?: number;
}

/** Bytes in one `int32` detail, for sizing the details buffers. */
const DETAIL_SIZE = 4;

/**
 * Task level wrapper over the leaderboard half of ISteamUserStats: find or
 * create a leaderboard, upload a score, download entries.
 *
 * Every method awaits the underlying async call through the dispatch, and
 * turns a failure into a thrown error instead of a flag on a struct. Reach it
 * as `steam.leaderboards`.
 *
 * @see Steam.leaderboards
 * @see SteamResultError
 */
export class Leaderboards {
  /**
   * @param userStats - The ISteamUserStats interface.
   * @param dispatch - Running pump that resolves the call results.
   */
  constructor(
    private readonly userStats: ISteamUserStats,
    private readonly dispatch: SteamDispatch,
  ) {}

  /**
   * Looks up a leaderboard by name.
   *
   * The leaderboard must already exist, which normally means it was created in
   * the Steamworks partner site. Use `findOrCreate` to create it from the game
   * instead.
   *
   * @param name - Leaderboard name, max 128 UTF-8 bytes. Case sensitive.
   * @returns The leaderboard, or null if the app has no leaderboard with that name.
   * @throws SteamApiCallError if the call could not be completed.
   * @example
   * ```ts
   * import { init } from 'steamwand.js';
   *
   * const steam = init({ appId: 480 });
   * const board = await steam.leaderboards.find('Fastest Lap');
   * if (board) console.log(board.handle, board.entryCount);
   * steam.close();
   * ```
   * @see findOrCreate
   */
  async find(name: string): Promise<LeaderboardInfo | null> {
    const call = this.userStats.FindLeaderboard(name);
    const r = await this.dispatch.callResultStruct<LeaderboardFindResult_t>(
      call,
      layoutOf('LeaderboardFindResult_t'),
      callbackIdByName.LeaderboardFindResult_t,
    );
    if (!r.m_bLeaderboardFound) return null;
    return this.info(r.m_hSteamLeaderboard);
  }

  /**
   * Looks up a leaderboard by name, and creates it if the app has none.
   *
   * The sort method and the display type only apply to a leaderboard this call
   * creates. An existing leaderboard keeps the settings it was created with,
   * so read them back from the returned `LeaderboardInfo`.
   *
   * @param name - Leaderboard name, max 128 UTF-8 bytes. Case sensitive.
   * @param sortMethod - ELeaderboardSortMethod: 1 ascending (lowest score is best), 2 descending.
   * @param displayType - ELeaderboardDisplayType: 1 numeric, 2 seconds, 3 milliseconds.
   * @returns The leaderboard, found or newly created.
   * @throws Error if Steam could neither find nor create the leaderboard.
   * @throws SteamApiCallError if the call could not be completed.
   * @example
   * ```ts
   * import { init, flat } from 'steamwand.js';
   *
   * const steam = init({ appId: 480 });
   * const board = await steam.leaderboards.findOrCreate(
   *   'Fastest Lap',
   *   flat.ELeaderboardSortMethod.k_ELeaderboardSortMethodAscending,
   *   flat.ELeaderboardDisplayType.k_ELeaderboardDisplayTypeTimeMilliSeconds,
   * );
   * steam.close();
   * ```
   * @see find
   */
  async findOrCreate(name: string, sortMethod: number, displayType: number): Promise<LeaderboardInfo> {
    const call = this.userStats.FindOrCreateLeaderboard(name, sortMethod, displayType);
    const r = await this.dispatch.callResultStruct<LeaderboardFindResult_t>(
      call,
      layoutOf('LeaderboardFindResult_t'),
      callbackIdByName.LeaderboardFindResult_t,
    );
    if (!r.m_bLeaderboardFound) throw new Error(`steamwand: FindOrCreateLeaderboard could not find or create "${name}"`);
    return this.info(r.m_hSteamLeaderboard);
  }

  /**
   * Uploads the current user's score.
   *
   * With the default keep-best method Steam drops the upload when the user
   * already has a better score, and reports that back as `scoreChanged: false`.
   * Force-update always overwrites, which is what a "reset my time" button
   * needs.
   *
   * @param handle - SteamLeaderboard_t from `find` or `findOrCreate`. 64-bit, so a `bigint`.
   * @param score - The score. Steam stores a 32-bit signed integer, so scale times and floats yourself.
   * @param opts.method - ELeaderboardUploadScoreMethod.
   * @defaultValue `k_ELeaderboardUploadScoreMethodKeepBest`
   * @param opts.details - Game defined details stored with the entry, at most 64 int32 values.
   * @defaultValue no details
   * @returns Whether the score changed, and the ranks around the change.
   * @throws Error if Steam reported the upload as failed.
   * @throws SteamApiCallError if the call could not be completed.
   * @example
   * ```ts
   * import { init } from 'steamwand.js';
   *
   * const steam = init({ appId: 480 });
   * const board = await steam.leaderboards.findOrCreate('Fastest Lap', 1, 3);
   * const { scoreChanged, newGlobalRank } = await steam.leaderboards.uploadScore(board.handle, 91_240);
   * console.log(scoreChanged ? `now rank ${newGlobalRank}` : 'kept the old score');
   * steam.close();
   * ```
   * @see downloadEntries
   */
  async uploadScore(
    handle: bigint,
    score: number,
    opts: { method?: number; details?: number[] } = {},
  ): Promise<ScoreUploadResult> {
    const details = opts.details ?? [];
    const detailsBuf = details.length > 0 ? Buffer.alloc(details.length * DETAIL_SIZE) : null;
    details.forEach((d, i) => detailsBuf?.writeInt32LE(d, i * DETAIL_SIZE));

    const call = this.userStats.UploadLeaderboardScore(
      handle,
      opts.method ?? ELeaderboardUploadScoreMethod.k_ELeaderboardUploadScoreMethodKeepBest,
      score,
      detailsBuf,
      details.length,
    );
    const r = await this.dispatch.callResultStruct<LeaderboardScoreUploaded_t>(
      call,
      layoutOf('LeaderboardScoreUploaded_t'),
      callbackIdByName.LeaderboardScoreUploaded_t,
    );
    if (!r.m_bSuccess) throw new Error('steamwand: UploadLeaderboardScore failed (leaderboard handle or score rejected)');
    return {
      scoreChanged: r.m_bScoreChanged !== 0,
      newGlobalRank: r.m_nGlobalRankNew,
      previousGlobalRank: r.m_nGlobalRankPrevious,
    };
  }

  /**
   * Downloads a range of entries, ranked best first.
   *
   * How the range is read depends on `dataRequest`. Global takes absolute
   * 1-based ranks, so `1` to `10` is the top ten. Around-user takes offsets
   * from the user's own rank, so `-4` to `5` is a ten entry window centred on
   * them. Friends ignores the range and returns every friend with an entry.
   *
   * @param handle - SteamLeaderboard_t from `find` or `findOrCreate`. 64-bit, so a `bigint`.
   * @param opts.dataRequest - ELeaderboardDataRequest (0 global, 1 around user, 2 friends).
   * @defaultValue `k_ELeaderboardDataRequestGlobal`
   * @param opts.rangeStart - First entry to fetch.
   * @defaultValue 1
   * @param opts.rangeEnd - Last entry to fetch.
   * @defaultValue 10
   * @param opts.maxDetails - Details to read per entry.
   * @defaultValue 0
   * @returns The entries Steam returned, which can be fewer than the range asked for.
   * @throws Error if an entry could not be read out of the downloaded set.
   * @throws SteamApiCallError if the call could not be completed.
   * @example
   * ```ts
   * import { init } from 'steamwand.js';
   *
   * const steam = init({ appId: 480 });
   * const board = await steam.leaderboards.findOrCreate('Fastest Lap', 1, 3);
   * const top = await steam.leaderboards.downloadEntries(board.handle, { rangeStart: 1, rangeEnd: 10 });
   * for (const e of top) console.log(e.globalRank, e.steamId, e.score);
   * steam.close();
   * ```
   * @see downloadEntriesForUsers
   * @see uploadScore
   */
  async downloadEntries(handle: bigint, opts: DownloadOptions = {}): Promise<LeaderboardEntry[]> {
    const call = this.userStats.DownloadLeaderboardEntries(
      handle,
      opts.dataRequest ?? ELeaderboardDataRequest.k_ELeaderboardDataRequestGlobal,
      opts.rangeStart ?? 1,
      opts.rangeEnd ?? 10,
    );
    return this.readEntries(call, opts.maxDetails ?? 0);
  }

  /**
   * Downloads the entries of a named set of users, for example a lobby.
   *
   * Users without an entry on this leaderboard are left out, so the result can
   * be shorter than `steamIds`. Steam caps the request at 100 users.
   *
   * @param handle - SteamLeaderboard_t from `find` or `findOrCreate`. 64-bit, so a `bigint`.
   * @param steamIds - Steam ids to look up, at most 100. 64-bit, so `bigint`s.
   * @param maxDetails - Details to read per entry.
   * @defaultValue 0
   * @returns One entry per user that has a score, ranked best first.
   * @throws Error if `steamIds` is empty, or if an entry could not be read out of the downloaded set.
   * @throws SteamApiCallError if the call could not be completed.
   * @see downloadEntries
   */
  async downloadEntriesForUsers(handle: bigint, steamIds: bigint[], maxDetails = 0): Promise<LeaderboardEntry[]> {
    if (steamIds.length === 0) throw new Error('steamwand: downloadEntriesForUsers needs at least one Steam id');
    // CSteamID is one packed 64-bit value, so the array is a flat uint64 buffer.
    const users = Buffer.alloc(steamIds.length * 8);
    steamIds.forEach((id, i) => users.writeBigUInt64LE(id, i * 8));
    const call = this.userStats.DownloadLeaderboardEntriesForUsers(handle, users, steamIds.length);
    return this.readEntries(call, maxDetails);
  }

  /**
   * Attaches a piece of UGC, usually a replay file, to the current user's
   * entry on this leaderboard.
   *
   * The user must already have an entry. One entry holds one UGC handle, so a
   * second call replaces the first.
   *
   * @param handle - SteamLeaderboard_t from `find` or `findOrCreate`. 64-bit, so a `bigint`.
   * @param ugcHandle - UGCHandle_t of a file shared through remote storage. 64-bit, so a `bigint`.
   * @throws SteamResultError if Steam refused the call, for example with `k_EResultFail` when the user has no entry.
   * @throws SteamApiCallError if the call could not be completed.
   */
  async attachUgc(handle: bigint, ugcHandle: bigint): Promise<void> {
    const call = this.userStats.AttachLeaderboardUGC(handle, ugcHandle);
    const r = await this.dispatch.callResultStruct<LeaderboardUGCSet_t>(
      call,
      layoutOf('LeaderboardUGCSet_t'),
      callbackIdByName.LeaderboardUGCSet_t,
    );
    ok('AttachLeaderboardUGC', r.m_eResult);
  }

  /**
   * Reads the properties Steam keeps next to a leaderboard handle.
   *
   * All four calls are local reads against the client's copy, so they need no
   * dispatch round trip.
   *
   * @param handle - SteamLeaderboard_t of a leaderboard Steam has already found.
   * @returns The handle plus its name, entry count, sort method, and display type.
   */
  private info(handle: bigint): LeaderboardInfo {
    return {
      handle,
      name: this.userStats.GetLeaderboardName(handle),
      entryCount: this.userStats.GetLeaderboardEntryCount(handle),
      sortMethod: this.userStats.GetLeaderboardSortMethod(handle),
      displayType: this.userStats.GetLeaderboardDisplayType(handle),
    };
  }

  /**
   * Awaits one download call and decodes every row of the returned set.
   *
   * The entry set handle is only valid until the next download, so every row
   * is read here rather than handed to the caller.
   *
   * @param call - SteamAPICall_t from a `DownloadLeaderboardEntries...` call.
   * @param maxDetails - Details to read per entry. 0 passes a null details buffer.
   * @returns The decoded entries.
   * @throws Error if a row inside the returned count could not be read.
   */
  private async readEntries(call: bigint, maxDetails: number): Promise<LeaderboardEntry[]> {
    const d = await this.dispatch.callResultStruct<LeaderboardScoresDownloaded_t>(
      call,
      layoutOf('LeaderboardScoresDownloaded_t'),
      callbackIdByName.LeaderboardScoresDownloaded_t,
    );
    const layout = layoutOf('LeaderboardEntry_t');
    const entryBuf = Buffer.alloc(layout.size);
    const detailsBuf = maxDetails > 0 ? Buffer.alloc(maxDetails * DETAIL_SIZE) : null;
    const entries: LeaderboardEntry[] = [];
    for (let i = 0; i < d.m_cEntryCount; i++) {
      must(
        'GetDownloadedLeaderboardEntry',
        this.userStats.GetDownloadedLeaderboardEntry(d.m_hSteamLeaderboardEntries, i, entryBuf, detailsBuf, maxDetails),
      );
      const e = decodeStruct<LeaderboardEntry_t>(entryBuf, layout);
      const count = Math.min(e.m_cDetails, maxDetails);
      const details: number[] = [];
      for (let j = 0; j < count; j++) details.push(detailsBuf!.readInt32LE(j * DETAIL_SIZE));
      entries.push({
        steamId: e.m_steamIDUser,
        globalRank: e.m_nGlobalRank,
        score: e.m_nScore,
        details,
        ugcHandle: e.m_hUGC,
      });
    }
    return entries;
  }
}
