import * as fs from 'node:fs';
import type { SteamDispatch } from '../runtime/dispatch';
import { decodeStruct } from '../runtime/struct';
import { stringArray } from '../runtime/types';
import { out } from '../runtime/out';
import type { ISteamUGC } from '../generated/interfaces/ISteamUGC';
import { layoutOf } from '../generated/structs';
import { callbackIdByName, type SteamCallbackMap } from '../generated/callbacks';
import type {
  AddAppDependencyResult_t,
  AddUGCDependencyResult_t,
  CreateItemResult_t,
  DeleteItemResult_t,
  GetAppDependenciesResult_t,
  GetUserItemVoteResult_t,
  RemoteStorageSubscribePublishedFileResult_t,
  RemoteStorageUnsubscribePublishedFileResult_t,
  RemoveAppDependencyResult_t,
  RemoveUGCDependencyResult_t,
  SetUserItemVoteResult_t,
  StartPlaytimeTrackingResult_t,
  SteamUGCDetails_t,
  SteamUGCQueryCompleted_t,
  StopPlaytimeTrackingResult_t,
  SubmitItemUpdateResult_t,
  UserFavoriteItemsListChanged_t,
  WorkshopEULAStatus_t,
} from '../generated/structs';
import {
  EItemPreviewType,
  EItemState,
  EItemStatistic,
  EResult,
  EUGCMatchingUGCType,
  EUGCQuery,
  EUserUGCList,
  EUserUGCListSortOrder,
  EWorkshopFileType,
} from '../generated/enums';
import { k_cchDeveloperMetadataMax } from '../generated/consts';
import { ok, must } from './guards';

/** Steam caps a key/value tag key and value at 255 bytes each, so this buffer always holds one. */
const KEY_VALUE_TAG_BYTES = 256;

/**
 * One workshop item update. Every field is optional; only the fields you set
 * are sent, the rest keep their current value.
 *
 * @see Workshop.submitUpdate
 */
export interface WorkshopItemUpdate {
  /** Item title, max 128 UTF-8 bytes. */
  title?: string;
  /** Item description, max 8000 UTF-8 bytes. */
  description?: string;
  /** Steam API language code (`german`, `schinese`, ...): sets which language title/description apply to. */
  language?: string;
  /** Change note for this revision. Omit for no change note. */
  changeNote?: string;
  /** Absolute path to the content folder. The whole folder is uploaded. */
  contentPath?: string;
  /** Absolute path to the preview image. Max 1 MB, PNG or JPG. */
  previewPath?: string;
  /** Replaces the full tag list, so include the tags you want to keep. */
  tags?: string[];
  /** ERemoteStoragePublishedFileVisibility (0 public, 1 friends-only, 2 private, 3 unlisted). */
  visibility?: number;
  /** Free-form developer metadata, max 5000 UTF-8 bytes. Only the item owner reads it back. */
  metadata?: string;
  /** Key/value tags to set. Every key is cleared first, so one call replaces that key's values. */
  keyValueTags?: Record<string, string>;
  /** Absolute paths of extra preview images to add. Max 1 MB each, PNG or JPG. */
  previewImages?: string[];
  /** YouTube video ids to add as extra previews. */
  previewVideos?: string[];
  /** Indexes of existing additional previews to remove. Applied before the adds. */
  removePreviewIndexes?: number[];
}

/**
 * Upload progress of a running `SubmitItemUpdate`.
 *
 * @see Workshop.submitUpdate
 */
export interface UpdateProgress {
  /** EItemUpdateStatus (0 invalid .. 5 committing changes). */
  status: number;
  /** Bytes uploaded so far. 64-bit, so a `bigint`. */
  bytesProcessed: bigint;
  /** Total bytes to upload, or `0n` before Steam knows the size. */
  bytesTotal: bigint;
}

/**
 * One workshop item, decoded from `SteamUGCDetails_t` plus the per-item extras
 * that need their own flat call (preview URL, statistics).
 *
 * @see Workshop.getItem
 * @see Workshop.getUserItems
 */
export interface WorkshopItem {
  /** PublishedFileId_t. 64-bit, so a `bigint`. */
  fileId: bigint;
  /** Title in the requested language, or the default language. */
  title: string;
  /** Description. Truncated unless the query set `longDescription`. */
  description: string;
  /** EWorkshopFileType (0 community, 1 microtransaction, ...). */
  fileType: number;
  /** App the item was created for. */
  creatorAppId: number;
  /** App the item is consumed by. */
  consumerAppId: number;
  /** Steam id of the owner. 64-bit, so a `bigint`. */
  ownerSteamId: bigint;
  /** Creation time, Unix seconds. */
  timeCreated: number;
  /** Last update time, Unix seconds. */
  timeUpdated: number;
  /** ERemoteStoragePublishedFileVisibility (0 public, 1 friends-only, 2 private, 3 unlisted). */
  visibility: number;
  /** True if Steam banned the item. */
  banned: boolean;
  /** True if the item passed the app's acceptance check. */
  acceptedForUse: boolean;
  /** Tags, split from Steam's comma-separated list. Empty if the item has none. */
  tags: string[];
  /** True if Steam cut the tag list short, so `tags` is incomplete. */
  tagsTruncated: boolean;
  /** File name, for items that are a single file. Empty for folder content. */
  fileName: string;
  /** Size of the item content in bytes. */
  fileSize: number;
  /** Size of the preview image in bytes. */
  previewFileSize: number;
  /** Item URL, for items of a URL file type. Empty otherwise. */
  url: string;
  /** Lifetime up votes. */
  votesUp: number;
  /** Lifetime down votes. */
  votesDown: number;
  /** Steam's computed score, 0 to 1. */
  score: number;
  /** Number of child items, for collections. */
  numChildren: number;
  /** Total size of all files in bytes. 64-bit, so a `bigint`. */
  totalFilesSize: bigint;
  /** Preview image URL, or null if the item has no preview. */
  previewUrl: string | null;
  /** Counters Steam returned for this item. A key is absent if Steam did not return it. */
  statistics: Partial<Record<WorkshopStatistic, bigint>>;
  /** Child items of a collection. Empty unless the query set `children`. 64-bit, so `bigint`s. */
  children: bigint[];
  /** Extra previews beyond the main image. Empty unless the query set `additionalPreviews`. */
  additionalPreviews: AdditionalPreview[];
  /**
   * Free-form developer metadata. Absent unless the query set `metadata`, and
   * Steam only returns it to the item owner.
   */
  metadata?: string;
  /** Key/value tags. Absent unless the query set `keyValueTags`. */
  keyValueTags?: Record<string, string>;
}

/**
 * One extra preview of an item, beyond the main preview image.
 *
 * @see WorkshopItem.additionalPreviews
 */
export interface AdditionalPreview {
  /** EItemPreviewType (0 image, 1 YouTube video, 2 Sketchfab, ...). */
  type: number;
  /** Image URL, or the YouTube video id for a video preview. */
  urlOrVideoId: string;
  /** File name the preview was uploaded under. Empty for videos. */
  originalFileName: string;
}

/** Reads a NUL-terminated string out of a buffer a flat call wrote into. */
function cstr(buf: Buffer): string {
  return buf.toString('utf8', 0, Math.max(buf.indexOf(0), 0));
}

/** Packs file ids into the `PublishedFileId_t *` array the flat calls take. */
function fileIdArray(fileIds: bigint[]): Buffer {
  const buf = Buffer.alloc(Math.max(fileIds.length, 1) * 8);
  fileIds.forEach((id, i) => buf.writeBigUInt64LE(id, i * 8));
  return buf;
}

const STATISTICS: Record<string, number> = {
  numSubscriptions: EItemStatistic.k_EItemStatistic_NumSubscriptions,
  numFavorites: EItemStatistic.k_EItemStatistic_NumFavorites,
  numFollowers: EItemStatistic.k_EItemStatistic_NumFollowers,
  numUniqueSubscriptions: EItemStatistic.k_EItemStatistic_NumUniqueSubscriptions,
  numUniqueFavorites: EItemStatistic.k_EItemStatistic_NumUniqueFavorites,
  numUniqueWebsiteViews: EItemStatistic.k_EItemStatistic_NumUniqueWebsiteViews,
  numSecondsPlayed: EItemStatistic.k_EItemStatistic_NumSecondsPlayed,
  numPlaytimeSessions: EItemStatistic.k_EItemStatistic_NumPlaytimeSessions,
  numComments: EItemStatistic.k_EItemStatistic_NumComments,
};
/**
 * Name of an item counter in `WorkshopItem.statistics`, for example
 * `numSubscriptions` or `numUniqueFavorites`.
 */
export type WorkshopStatistic = keyof typeof STATISTICS & string;

/**
 * Options shared by every item query.
 *
 * @see Workshop.getItem
 * @see Workshop.getUserItems
 */
export interface QueryOptions {
  /** Steam API language code for returned text (title/description). */
  language?: string;
  /** Return the full description instead of the truncated one. */
  longDescription?: boolean;
  /** Return the child items of a collection, in `WorkshopItem.children`. */
  children?: boolean;
  /** Return the extra previews, in `WorkshopItem.additionalPreviews`. */
  additionalPreviews?: boolean;
  /** Return the developer metadata, in `WorkshopItem.metadata`. Only the item owner gets a value. */
  metadata?: boolean;
  /** Return the key/value tags, in `WorkshopItem.keyValueTags`. */
  keyValueTags?: boolean;
}

/**
 * One page of query results.
 *
 * @see Workshop.getUserItems
 */
export interface UserItemsPage {
  /** Items on this page, at most 50. Items Steam could not return are skipped. */
  items: WorkshopItem[];
  /** Total matches across all pages, for computing the page count. */
  totalResults: number;
}

/**
 * Filters and ranking for one whole-workshop query.
 *
 * @see Workshop.browse
 */
export interface BrowseOptions extends QueryOptions {
  /** App whose workshop to search. Defaults to the app id passed to `init`. */
  appId?: number;
  /** EUGCQuery ranking, for example `k_EUGCQuery_RankedByTrend`. Defaults to `k_EUGCQuery_RankedByVote`. */
  queryType?: number;
  /** EUGCMatchingUGCType, which item kinds to return. Defaults to `k_EUGCMatchingUGCType_Items`. */
  matchingType?: number;
  /** Text the title or description must contain. */
  searchText?: string;
  /** Tags every item must carry, or any of them with `matchAnyTag`. */
  requiredTags?: string[];
  /** Tags no item may carry. */
  excludedTags?: string[];
  /** Match items carrying any of `requiredTags` instead of all of them. */
  matchAnyTag?: boolean;
  /** Days the trend window covers for the `RankedByTrend` query types, 1 to 180. */
  trendDays?: number;
  /** Page cursor from a previous result. Omit, or pass `'*'`, for the first page. */
  cursor?: string;
}

/**
 * One page of a whole-workshop query.
 *
 * @see Workshop.browse
 */
export interface BrowsePage extends UserItemsPage {
  /** Cursor for the next page, or null after the last one. */
  nextCursor: string | null;
}

/**
 * Local state of one item, decoded from the `EItemState` bit field.
 *
 * @see Workshop.getState
 */
export interface ItemState {
  /** The current user is subscribed. */
  subscribed: boolean;
  /** Uploaded through the pre-2014 RemoteStorage workshop API. */
  legacy: boolean;
  /** Content is on disk. `getInstallInfo` has the path. */
  installed: boolean;
  /** Steam has a newer version than the installed one. */
  needsUpdate: boolean;
  /** A download is running. `getDownloadInfo` has the progress. */
  downloading: boolean;
  /** A download is queued but not started. */
  downloadPending: boolean;
  /** The user disabled the item in the Steam client. */
  disabledLocally: boolean;
}

/**
 * Where an installed item lives on disk.
 *
 * @see Workshop.getInstallInfo
 */
export interface InstallInfo {
  /** Absolute path of the content folder, or of the file for legacy items. */
  path: string;
  /** Bytes on disk. 64-bit, so a `bigint`. */
  sizeOnDisk: bigint;
  /** When the installed content was last updated, Unix seconds. */
  timestamp: number;
}

/**
 * Progress of a running item download.
 *
 * @see Workshop.getDownloadInfo
 * @see Workshop.download
 */
export interface DownloadProgress {
  /** Bytes downloaded so far. 64-bit, so a `bigint`. */
  bytesDownloaded: bigint;
  /** Total bytes, or `0n` before Steam knows the size. */
  bytesTotal: bigint;
}

/**
 * The current user's standing with the Steam Workshop legal agreement.
 *
 * @see Workshop.getEulaStatus
 */
export interface WorkshopEulaStatus {
  /** Version of the agreement this answer is about. */
  version: number;
  /** True if the user accepted this version. */
  accepted: boolean;
  /** True if Steam wants the user to look at it, usually because it changed. */
  needsAction: boolean;
  /** When the user last acted on it, Unix seconds, or 0. */
  actionTime: number;
}

/**
 * Task level wrapper over ISteamUGC, both sides of the Steam Workshop.
 *
 * For a creator: create, update, delete, and query items. For a player:
 * browse, subscribe, download, find the installed content on disk, vote, and
 * favorite. Every async method awaits the underlying call through the
 * dispatch and turns a non-OK `EResult` into a `SteamResultError`. Reach it
 * as `steam.workshop`, which builds it with the app id from `init`.
 *
 * @see Steam.workshop
 * @see SteamResultError
 */
export class Workshop {
  /**
   * @param ugc - The ISteamUGC interface.
   * @param dispatch - Running pump that resolves the call results.
   * @param appId - App id used when a method takes no explicit one.
   * @param subscribe - Callback subscriber, normally `steam.on` bound to the session.
   * @param once - Awaitable callback subscriber, normally `steam.once` bound to the session.
   */
  constructor(
    private readonly ugc: ISteamUGC,
    private readonly dispatch: SteamDispatch,
    private readonly appId: number,
    private readonly subscribeCallback: <K extends keyof SteamCallbackMap & string>(
      name: K,
      listener: (data: SteamCallbackMap[K]) => void,
    ) => () => void,
    private readonly once: <K extends keyof SteamCallbackMap & string>(
      name: K,
      match?: (data: SteamCallbackMap[K]) => boolean,
    ) => Promise<SteamCallbackMap[K]>,
  ) {}

  /**
   * Creates a new, empty workshop item and returns its file id.
   *
   * The item has no title, no content, and no preview yet. Fill it in with
   * `submitUpdate`. An item that is never updated stays invisible in the
   * workshop.
   *
   * @param appId - App to create the item under.
   * @defaultValue the app id passed to `init`
   * @param fileType - EWorkshopFileType.
   * @defaultValue `k_EWorkshopFileTypeCommunity`
   * @returns The new `fileId` (64-bit, so a `bigint`), and `legalAgreementRequired`,
   * which is true while the user has not accepted the workshop legal agreement. Steam
   * hides the item until they do.
   * @throws SteamResultError if Steam refused the call, for example with `k_EResultInsufficientPrivilege`.
   * @throws SteamApiCallError if the call could not be completed.
   * @example
   * ```ts
   * import { init } from 'steamwand.js';
   *
   * const steam = init({ appId: 480 });
   * const { fileId, legalAgreementRequired } = await steam.workshop.createItem();
   * await steam.workshop.submitUpdate(fileId, { title: 'My map' });
   * if (legalAgreementRequired) console.log('accept the workshop agreement in Steam');
   * steam.close();
   * ```
   * @see submitUpdate
   */
  async createItem(
    appId: number = this.appId,
    fileType: number = EWorkshopFileType.k_EWorkshopFileTypeCommunity,
  ): Promise<{ fileId: bigint; legalAgreementRequired: boolean }> {
    const call = this.ugc.CreateItem(appId, fileType);
    const r = await this.dispatch.callResultStruct<CreateItemResult_t>(
      call,
      layoutOf('CreateItemResult_t'),
      callbackIdByName.CreateItemResult_t,
    );
    ok('CreateItem', r.m_eResult);
    return { fileId: r.m_nPublishedFileId, legalAgreementRequired: r.m_bUserNeedsToAcceptWorkshopLegalAgreement };
  }

  /**
   * Apply one item update (StartItemUpdate + setters + SubmitItemUpdate) and
   * wait for the result. With `language` set, title/description apply to that
   * language only (SetItemUpdateLanguage).
   *
   * Paths in `update` are checked before the native call, because the native
   * layer aborts the whole process on a missing path instead of returning an
   * error.
   *
   * @param fileId - Item to update. 64-bit, so a `bigint`.
   * @param update - The fields to change. Unset fields keep their value.
   * @param opts.appId - App the item belongs to.
   * @defaultValue the app id passed to `init`
   * @param opts.onProgress - Called on a timer while the upload runs, and never after the promise settles.
   * @param opts.progressIntervalMs - Milliseconds between `onProgress` calls.
   * @defaultValue 500
   * @returns `legalAgreementRequired`, true while the user has not accepted the workshop legal agreement.
   * @throws Error if `contentPath` or `previewPath` does not exist.
   * @throws Error if a setter returns false, which means an invalid handle or argument.
   * @throws SteamResultError if Steam refused the submit, for example with `k_EResultFileNotFound`.
   * @throws SteamApiCallError if the call could not be completed.
   * @example
   * ```ts
   * import { init } from 'steamwand.js';
   *
   * const steam = init({ appId: 480 });
   * await steam.workshop.submitUpdate(123456789n, {
   *   title: 'My map',
   *   contentPath: 'C:/mods/my-map',
   *   changeNote: 'first release',
   * }, { onProgress: (p) => console.log(p.bytesProcessed, '/', p.bytesTotal) });
   * steam.close();
   * ```
   * @see createItem
   */
  async submitUpdate(
    fileId: bigint,
    update: WorkshopItemUpdate,
    opts: { appId?: number; onProgress?: (p: UpdateProgress) => void; progressIntervalMs?: number } = {},
  ): Promise<{ legalAgreementRequired: boolean }> {
    const appId = opts.appId ?? this.appId;
    // The native layer aborts the process on a missing path; keep it a readable error.
    if (update.contentPath !== undefined && !fs.existsSync(update.contentPath))
      throw new Error(`steamwand: content folder does not exist: ${update.contentPath}`);
    if (update.previewPath !== undefined && !fs.existsSync(update.previewPath))
      throw new Error(`steamwand: preview image does not exist: ${update.previewPath}`);
    for (const p of update.previewImages ?? [])
      if (!fs.existsSync(p)) throw new Error(`steamwand: preview image does not exist: ${p}`);

    const h = this.ugc.StartItemUpdate(appId, fileId);
    if (update.language !== undefined) must('SetItemUpdateLanguage', this.ugc.SetItemUpdateLanguage(h, update.language));
    if (update.title !== undefined) must('SetItemTitle', this.ugc.SetItemTitle(h, update.title));
    if (update.description !== undefined) must('SetItemDescription', this.ugc.SetItemDescription(h, update.description));
    if (update.contentPath !== undefined) must('SetItemContent', this.ugc.SetItemContent(h, update.contentPath));
    if (update.previewPath !== undefined) must('SetItemPreview', this.ugc.SetItemPreview(h, update.previewPath));
    if (update.visibility !== undefined) must('SetItemVisibility', this.ugc.SetItemVisibility(h, update.visibility));
    if (update.tags !== undefined) must('SetItemTags', this.ugc.SetItemTags(h, stringArray(update.tags), false));
    if (update.metadata !== undefined) must('SetItemMetadata', this.ugc.SetItemMetadata(h, update.metadata));
    for (const [key, value] of Object.entries(update.keyValueTags ?? {})) {
      must('RemoveItemKeyValueTags', this.ugc.RemoveItemKeyValueTags(h, key));
      must('AddItemKeyValueTag', this.ugc.AddItemKeyValueTag(h, key, value));
    }
    // Descending, so removing one preview does not shift the indexes still to remove.
    for (const index of [...(update.removePreviewIndexes ?? [])].sort((a, b) => b - a))
      must('RemoveItemPreview', this.ugc.RemoveItemPreview(h, index));
    for (const p of update.previewImages ?? [])
      must('AddItemPreviewFile', this.ugc.AddItemPreviewFile(h, p, EItemPreviewType.k_EItemPreviewType_Image));
    for (const videoId of update.previewVideos ?? [])
      must('AddItemPreviewVideo', this.ugc.AddItemPreviewVideo(h, videoId));

    // NULL change note = "no change note"; koffi passes null for 'str' fine.
    const note = update.changeNote ?? (null as unknown as string);
    const call = this.ugc.SubmitItemUpdate(h, note);

    let progressTimer: NodeJS.Timeout | undefined;
    if (opts.onProgress) {
      const onProgress = opts.onProgress;
      const processed = Buffer.alloc(8);
      const total = Buffer.alloc(8);
      progressTimer = setInterval(() => {
        const status = this.ugc.GetItemUpdateProgress(h, processed, total);
        onProgress({
          status,
          bytesProcessed: processed.readBigUInt64LE(0),
          bytesTotal: total.readBigUInt64LE(0),
        });
      }, opts.progressIntervalMs ?? 500);
      progressTimer.unref();
    }
    try {
      const r = await this.dispatch.callResultStruct<SubmitItemUpdateResult_t>(
        call,
        layoutOf('SubmitItemUpdateResult_t'),
        callbackIdByName.SubmitItemUpdateResult_t,
      );
      ok('SubmitItemUpdate', r.m_eResult);
      return { legalAgreementRequired: r.m_bUserNeedsToAcceptWorkshopLegalAgreement };
    } finally {
      if (progressTimer) clearInterval(progressTimer);
    }
  }

  /**
   * Deletes a workshop item permanently.
   *
   * Only the owner of the item can do this, and it cannot be undone.
   *
   * @param fileId - Item to delete. 64-bit, so a `bigint`.
   * @throws SteamResultError if Steam refused the call, for example with `k_EResultAccessDenied`.
   * @throws SteamApiCallError if the call could not be completed.
   */
  async deleteItem(fileId: bigint): Promise<void> {
    const call = this.ugc.DeleteItem(fileId);
    const r = await this.dispatch.callResultStruct<DeleteItemResult_t>(
      call,
      layoutOf('DeleteItemResult_t'),
      callbackIdByName.DeleteItemResult_t,
    );
    ok('DeleteItem', r.m_eResult);
  }

  /**
   * Marks an app (usually a DLC) as required by an item.
   *
   * Steam shows it as a required DLC on the item page. Only the item owner can
   * do this.
   *
   * @param fileId - Item to change. 64-bit, so a `bigint`.
   * @param appId - App id of the required app.
   * @throws SteamResultError if Steam refused the call, for example with `k_EResultAccessDenied`.
   * @throws SteamApiCallError if the call could not be completed.
   * @see removeAppDependency
   * @see getAppDependencies
   */
  async addAppDependency(fileId: bigint, appId: number): Promise<void> {
    const call = this.ugc.AddAppDependency(fileId, appId);
    const r = await this.dispatch.callResultStruct<AddAppDependencyResult_t>(
      call,
      layoutOf('AddAppDependencyResult_t'),
      callbackIdByName.AddAppDependencyResult_t,
    );
    ok('AddAppDependency', r.m_eResult);
  }

  /**
   * Drops an app requirement added with `addAppDependency`.
   *
   * @param fileId - Item to change. 64-bit, so a `bigint`.
   * @param appId - App id to remove.
   * @throws SteamResultError if Steam refused the call.
   * @throws SteamApiCallError if the call could not be completed.
   * @see addAppDependency
   */
  async removeAppDependency(fileId: bigint, appId: number): Promise<void> {
    const call = this.ugc.RemoveAppDependency(fileId, appId);
    const r = await this.dispatch.callResultStruct<RemoveAppDependencyResult_t>(
      call,
      layoutOf('RemoveAppDependencyResult_t'),
      callbackIdByName.RemoveAppDependencyResult_t,
    );
    ok('RemoveAppDependency', r.m_eResult);
  }

  /**
   * Lists the apps an item requires.
   *
   * Steam returns at most 32 app ids per call, so a longer list comes back
   * truncated.
   *
   * @param fileId - Item to read. 64-bit, so a `bigint`.
   * @returns The required app ids, in Steam's order.
   * @throws SteamResultError if Steam refused the call.
   * @throws SteamApiCallError if the call could not be completed.
   * @see addAppDependency
   */
  async getAppDependencies(fileId: bigint): Promise<number[]> {
    const call = this.ugc.GetAppDependencies(fileId);
    const r = await this.dispatch.callResultStruct<GetAppDependenciesResult_t>(
      call,
      layoutOf('GetAppDependenciesResult_t'),
      callbackIdByName.GetAppDependenciesResult_t,
    );
    ok('GetAppDependencies', r.m_eResult);
    const appIds: number[] = [];
    for (let i = 0; i < r.m_nNumAppDependencies; i++) appIds.push(r.m_rgAppIDs.readUInt32LE(i * 4));
    return appIds;
  }

  /**
   * Adds a child item to a collection, or a required item to an item.
   *
   * @param parentId - Collection or parent item. 64-bit, so a `bigint`.
   * @param childId - Item to add. 64-bit, so a `bigint`.
   * @throws SteamResultError if Steam refused the call, for example with `k_EResultAccessDenied`.
   * @throws SteamApiCallError if the call could not be completed.
   * @see removeDependency
   */
  async addDependency(parentId: bigint, childId: bigint): Promise<void> {
    const call = this.ugc.AddDependency(parentId, childId);
    const r = await this.dispatch.callResultStruct<AddUGCDependencyResult_t>(
      call,
      layoutOf('AddUGCDependencyResult_t'),
      callbackIdByName.AddUGCDependencyResult_t,
    );
    ok('AddDependency', r.m_eResult);
  }

  /**
   * Removes a child item added with `addDependency`.
   *
   * @param parentId - Collection or parent item. 64-bit, so a `bigint`.
   * @param childId - Item to remove. 64-bit, so a `bigint`.
   * @throws SteamResultError if Steam refused the call.
   * @throws SteamApiCallError if the call could not be completed.
   * @see addDependency
   */
  async removeDependency(parentId: bigint, childId: bigint): Promise<void> {
    const call = this.ugc.RemoveDependency(parentId, childId);
    const r = await this.dispatch.callResultStruct<RemoveUGCDependencyResult_t>(
      call,
      layoutOf('RemoveUGCDependencyResult_t'),
      callbackIdByName.RemoveUGCDependencyResult_t,
    );
    ok('RemoveDependency', r.m_eResult);
  }

  /**
   * Fetches one item's details.
   *
   * Works for any public item, not only items of this app or this user.
   *
   * @param fileId - Item to fetch. 64-bit, so a `bigint`.
   * @param opts - Language and description options for the query.
   * @returns The item, or null if it does not exist or is not visible to this user.
   * @throws SteamResultError if the query itself failed.
   * @throws SteamApiCallError if the call could not be completed.
   * @example
   * ```ts
   * import { init } from 'steamwand.js';
   *
   * const steam = init({ appId: 480 });
   * const item = await steam.workshop.getItem(123456789n, { longDescription: true });
   * console.log(item?.title, item?.statistics.numSubscriptions);
   * steam.close();
   * ```
   * @see getUserItems
   */
  async getItem(fileId: bigint, opts: QueryOptions = {}): Promise<WorkshopItem | null> {
    const ids = Buffer.alloc(8);
    ids.writeBigUInt64LE(fileId, 0);
    const handle = this.ugc.CreateQueryUGCDetailsRequest(ids, 1);
    const { items } = await this.runQuery(handle, opts);
    return items[0] ?? null;
  }

  /**
   * Fetches one page of a user's published items for this app.
   *
   * A page holds at most 50 items. Use `totalResults` from the first page to
   * work out how many pages there are.
   *
   * @param page - 1-based page number. Steam rejects 0.
   * @param accountId - 32-bit account id of the user, from `steam.accountId()`.
   * @param opts.appId - App to list items for.
   * @defaultValue the app id passed to `init`
   * @param opts.listType - EUserUGCList.
   * @defaultValue `k_EUserUGCList_Published`
   * @param opts.matchingType - EUGCMatchingUGCType.
   * @defaultValue `k_EUGCMatchingUGCType_Items`
   * @param opts.sortOrder - EUserUGCListSortOrder.
   * @defaultValue `k_EUserUGCListSortOrder_LastUpdatedDesc`
   * @returns The page items and the total match count.
   * @throws SteamResultError if the query failed.
   * @throws SteamApiCallError if the call could not be completed.
   * @example
   * ```ts
   * import { init } from 'steamwand.js';
   *
   * const steam = init({ appId: 480 });
   * const { items, totalResults } = await steam.workshop.getUserItems(1, steam.accountId());
   * console.log(`${items.length} of ${totalResults}`, items.map((i) => i.title));
   * steam.close();
   * ```
   * @see getItem
   */
  async getUserItems(
    page: number,
    accountId: number,
    opts: QueryOptions & {
      appId?: number;
      listType?: number;
      matchingType?: number;
      sortOrder?: number;
    } = {},
  ): Promise<UserItemsPage> {
    const appId = opts.appId ?? this.appId;
    const handle = this.ugc.CreateQueryUserUGCRequest(
      accountId,
      opts.listType ?? EUserUGCList.k_EUserUGCList_Published,
      opts.matchingType ?? EUGCMatchingUGCType.k_EUGCMatchingUGCType_Items,
      opts.sortOrder ?? EUserUGCListSortOrder.k_EUserUGCListSortOrder_LastUpdatedDesc,
      appId,
      appId,
      page,
    );
    return this.runQuery(handle, opts);
  }

  /**
   * Searches the whole workshop of an app, one page at a time.
   *
   * This is the query behind the in-game mod browser: rank by votes, trend,
   * or date, filter by tags, and match search text. Pages are cursor based,
   * so a walk over a large workshop does not stop at Steam's page limit.
   *
   * @param opts - Ranking, filters, cursor, and the usual query options.
   * @returns The page items, the total match count, and the cursor for the next page.
   * @throws SteamResultError if the query failed.
   * @throws SteamApiCallError if the call could not be completed.
   * @example
   * ```ts
   * import { init, flat } from 'steamwand.js';
   *
   * const steam = init({ appId: 480 });
   * let cursor: string | null = '*';
   * while (cursor) {
   *   const page = await steam.workshop.browse({
   *     queryType: flat.EUGCQuery.k_EUGCQuery_RankedByTrend,
   *     trendDays: 7,
   *     requiredTags: ['gameplay'],
   *     cursor,
   *   });
   *   console.log(page.items.map((i) => i.title));
   *   cursor = page.nextCursor;
   * }
   * steam.close();
   * ```
   * @see getUserItems
   */
  async browse(opts: BrowseOptions = {}): Promise<BrowsePage> {
    const appId = opts.appId ?? this.appId;
    const handle = this.ugc.CreateQueryAllUGCRequestCursor(
      opts.queryType ?? EUGCQuery.k_EUGCQuery_RankedByVote,
      opts.matchingType ?? EUGCMatchingUGCType.k_EUGCMatchingUGCType_Items,
      appId,
      appId,
      opts.cursor ?? '*',
    );
    if (opts.searchText !== undefined) must('SetSearchText', this.ugc.SetSearchText(handle, opts.searchText));
    for (const tag of opts.requiredTags ?? []) must('AddRequiredTag', this.ugc.AddRequiredTag(handle, tag));
    for (const tag of opts.excludedTags ?? []) must('AddExcludedTag', this.ugc.AddExcludedTag(handle, tag));
    if (opts.matchAnyTag !== undefined) must('SetMatchAnyTag', this.ugc.SetMatchAnyTag(handle, opts.matchAnyTag));
    if (opts.trendDays !== undefined) must('SetRankedByTrendDays', this.ugc.SetRankedByTrendDays(handle, opts.trendDays));
    const page = await this.runQuery(handle, opts);
    // Steam repeats the cursor it was given once the results run out.
    if (page.nextCursor === (opts.cursor ?? '*')) page.nextCursor = null;
    return page;
  }

  /**
   * Subscribes the current user to an item, so Steam downloads it and keeps
   * it updated.
   *
   * Steam starts the download on its own. Await `download` to know when the
   * content is on disk, or listen with `onInstalled`.
   *
   * @param fileId - Item to subscribe to. 64-bit, so a `bigint`.
   * @throws SteamResultError if Steam refused, for example with `k_EResultFileNotFound`.
   * @throws SteamApiCallError if the call could not be completed.
   * @see unsubscribe
   * @see download
   */
  async subscribe(fileId: bigint): Promise<void> {
    const call = this.ugc.SubscribeItem(fileId);
    const r = await this.dispatch.callResultStruct<RemoteStorageSubscribePublishedFileResult_t>(
      call,
      layoutOf('RemoteStorageSubscribePublishedFileResult_t'),
      callbackIdByName.RemoteStorageSubscribePublishedFileResult_t,
    );
    ok('SubscribeItem', r.m_eResult);
  }

  /**
   * Unsubscribes the current user from an item. Steam removes the content
   * from disk once the app exits.
   *
   * The local list behind `listSubscribed` catches up on the client's next
   * sync, so it can still carry the item right after this resolves.
   *
   * @param fileId - Item to unsubscribe from. 64-bit, so a `bigint`.
   * @throws SteamResultError if Steam refused.
   * @throws SteamApiCallError if the call could not be completed.
   * @see subscribe
   */
  async unsubscribe(fileId: bigint): Promise<void> {
    const call = this.ugc.UnsubscribeItem(fileId);
    const r = await this.dispatch.callResultStruct<RemoteStorageUnsubscribePublishedFileResult_t>(
      call,
      layoutOf('RemoteStorageUnsubscribePublishedFileResult_t'),
      callbackIdByName.RemoteStorageUnsubscribePublishedFileResult_t,
    );
    ok('UnsubscribeItem', r.m_eResult);
  }

  /**
   * Lists the items the current user is subscribed to for this app.
   *
   * A local read against the Steam client, so it needs no round trip. This
   * is the list a game walks at startup to find its mods: pair it with
   * `getState` and `getInstallInfo`.
   *
   * @param includeLocallyDisabled - Also list items the user disabled in the Steam client.
   * @returns The subscribed file ids, in Steam's order. 64-bit, so `bigint`s.
   * @example
   * ```ts
   * import { init } from 'steamwand.js';
   *
   * const steam = init({ appId: 480 });
   * for (const fileId of steam.workshop.listSubscribed()) {
   *   const info = steam.workshop.getInstallInfo(fileId);
   *   console.log(fileId, info?.path ?? '(not installed yet)');
   * }
   * steam.close();
   * ```
   * @see getState
   * @see getInstallInfo
   */
  listSubscribed(includeLocallyDisabled = false): bigint[] {
    const count = this.ugc.GetNumSubscribedItems(includeLocallyDisabled);
    if (count === 0) return [];
    const buf = Buffer.alloc(count * 8);
    const written = this.ugc.GetSubscribedItems(buf, count, includeLocallyDisabled);
    const ids: bigint[] = [];
    for (let i = 0; i < written; i++) ids.push(buf.readBigUInt64LE(i * 8));
    return ids;
  }

  /**
   * Reads the local state of an item as named flags.
   *
   * @param fileId - Item to read. 64-bit, so a `bigint`.
   * @returns One boolean per `EItemState` bit. All false for an item the client knows nothing about.
   * @see getInstallInfo
   * @see getDownloadInfo
   */
  getState(fileId: bigint): ItemState {
    const bits = this.ugc.GetItemState(fileId);
    return {
      subscribed: (bits & EItemState.k_EItemStateSubscribed) !== 0,
      legacy: (bits & EItemState.k_EItemStateLegacyItem) !== 0,
      installed: (bits & EItemState.k_EItemStateInstalled) !== 0,
      needsUpdate: (bits & EItemState.k_EItemStateNeedsUpdate) !== 0,
      downloading: (bits & EItemState.k_EItemStateDownloading) !== 0,
      downloadPending: (bits & EItemState.k_EItemStateDownloadPending) !== 0,
      disabledLocally: (bits & EItemState.k_EItemStateDisabledLocally) !== 0,
    };
  }

  /**
   * Finds an installed item on disk.
   *
   * @param fileId - Item to look up. 64-bit, so a `bigint`.
   * @returns The content path, size, and timestamp, or null while the item is not installed.
   * @see listSubscribed
   * @see getState
   */
  getInstallInfo(fileId: bigint): InstallInfo | null {
    const size = out.uint64();
    const folder = Buffer.alloc(1024);
    const timestamp = out.uint32();
    if (!this.ugc.GetItemInstallInfo(fileId, size.buffer, folder, folder.length, timestamp.buffer)) return null;
    return { path: cstr(folder), sizeOnDisk: size.value, timestamp: timestamp.value };
  }

  /**
   * Reads the progress of a running download.
   *
   * @param fileId - Item to look up. 64-bit, so a `bigint`.
   * @returns The byte counts, or null when no download is running for that item.
   * @see download
   */
  getDownloadInfo(fileId: bigint): DownloadProgress | null {
    const downloaded = out.uint64();
    const total = out.uint64();
    if (!this.ugc.GetItemDownloadInfo(fileId, downloaded.buffer, total.buffer)) return null;
    return { bytesDownloaded: downloaded.value, bytesTotal: total.value };
  }

  /**
   * Downloads an item, or updates it, and resolves once the content is on
   * disk.
   *
   * Steam downloads subscribed items on its own; call this to force one
   * now, for example after `subscribe` when the game needs the mod before it
   * can continue, or for an item the user is not subscribed to. The item is
   * installed when this resolves, so `getInstallInfo` answers right after.
   *
   * @param fileId - Item to download. 64-bit, so a `bigint`.
   * @param opts.highPriority - Put it in front of every other Steam download.
   * @defaultValue true
   * @param opts.onProgress - Called on a timer while the download runs, and never after the promise settles.
   * @param opts.progressIntervalMs - Milliseconds between `onProgress` calls.
   * @defaultValue 500
   * @throws Error if Steam refused to queue the download, which means an unknown item or a workshop the user may not read.
   * @throws SteamResultError if the download finished with a non-OK `EResult`.
   * @example
   * ```ts
   * import { init } from 'steamwand.js';
   *
   * const steam = init({ appId: 480 });
   * await steam.workshop.subscribe(123456789n);
   * await steam.workshop.download(123456789n, {
   *   onProgress: (p) => console.log(p.bytesDownloaded, '/', p.bytesTotal),
   * });
   * console.log(steam.workshop.getInstallInfo(123456789n)?.path);
   * steam.close();
   * ```
   * @see onInstalled
   */
  async download(
    fileId: bigint,
    opts: { highPriority?: boolean; onProgress?: (p: DownloadProgress) => void; progressIntervalMs?: number } = {},
  ): Promise<void> {
    if (!this.ugc.DownloadItem(fileId, opts.highPriority ?? true)) {
      throw new Error(`steamwand: DownloadItem refused ${fileId} (unknown item, or no access to its workshop)`);
    }
    // Callbacks only arrive inside a pump frame, so nothing can slip in
    // between the call above and this subscription. Steam answers a download
    // of an item that is already current with the same callback.
    const done = this.once('DownloadItemResult_t', (e) => e.m_nPublishedFileId === fileId);
    let progressTimer: NodeJS.Timeout | undefined;
    if (opts.onProgress) {
      const onProgress = opts.onProgress;
      progressTimer = setInterval(() => {
        const p = this.getDownloadInfo(fileId);
        if (p) onProgress(p);
      }, opts.progressIntervalMs ?? 500);
      progressTimer.unref();
    }
    try {
      const r = await done;
      ok('DownloadItem', r.m_eResult);
    } finally {
      if (progressTimer) clearInterval(progressTimer);
    }
  }

  /**
   * Subscribes to every item install and update for this app, whoever
   * started it.
   *
   * Steam fires this for downloads the client runs on its own, so it is
   * how a running game learns that a subscribed mod just updated.
   *
   * @param listener - Runs with the file id of the item that landed on disk.
   * @returns Unsubscribe function. Calling it more than once is harmless.
   * @see download
   */
  onInstalled(listener: (event: { fileId: bigint; appId: number }) => void): () => void {
    return this.subscribeCallback('ItemInstalled_t', (e) => {
      listener({ fileId: e.m_nPublishedFileId, appId: e.m_unAppID });
    });
  }

  /**
   * Casts, or changes, the current user's vote on an item.
   *
   * @param fileId - Item to vote on. 64-bit, so a `bigint`.
   * @param up - True for a thumbs up, false for a thumbs down.
   * @throws SteamResultError if Steam refused, for example with `k_EResultAccessDenied` on the user's own item.
   * @throws SteamApiCallError if the call could not be completed.
   * @see getVote
   */
  async vote(fileId: bigint, up: boolean): Promise<void> {
    const call = this.ugc.SetUserItemVote(fileId, up);
    const r = await this.dispatch.callResultStruct<SetUserItemVoteResult_t>(
      call,
      layoutOf('SetUserItemVoteResult_t'),
      callbackIdByName.SetUserItemVoteResult_t,
    );
    ok('SetUserItemVote', r.m_eResult);
  }

  /**
   * Reads the current user's vote on an item.
   *
   * @param fileId - Item to read. 64-bit, so a `bigint`.
   * @returns `'up'`, `'down'`, `'skipped'` if the user chose not to vote, or null if the user has not voted.
   * @throws SteamResultError if Steam refused.
   * @throws SteamApiCallError if the call could not be completed.
   * @see vote
   */
  async getVote(fileId: bigint): Promise<'up' | 'down' | 'skipped' | null> {
    const call = this.ugc.GetUserItemVote(fileId);
    const r = await this.dispatch.callResultStruct<GetUserItemVoteResult_t>(
      call,
      layoutOf('GetUserItemVoteResult_t'),
      callbackIdByName.GetUserItemVoteResult_t,
    );
    ok('GetUserItemVote', r.m_eResult);
    if (r.m_bVotedUp) return 'up';
    if (r.m_bVotedDown) return 'down';
    if (r.m_bVoteSkipped) return 'skipped';
    return null;
  }

  /**
   * Adds an item to the current user's favorites.
   *
   * @param fileId - Item to favorite. 64-bit, so a `bigint`.
   * @param appId - App the favorite is filed under.
   * @defaultValue the app id passed to `init`
   * @throws SteamResultError if Steam refused.
   * @throws SteamApiCallError if the call could not be completed.
   * @see removeFromFavorites
   */
  async addToFavorites(fileId: bigint, appId: number = this.appId): Promise<void> {
    const call = this.ugc.AddItemToFavorites(appId, fileId);
    const r = await this.dispatch.callResultStruct<UserFavoriteItemsListChanged_t>(
      call,
      layoutOf('UserFavoriteItemsListChanged_t'),
      callbackIdByName.UserFavoriteItemsListChanged_t,
    );
    ok('AddItemToFavorites', r.m_eResult);
  }

  /**
   * Removes an item from the current user's favorites.
   *
   * @param fileId - Item to remove. 64-bit, so a `bigint`.
   * @param appId - App the favorite is filed under.
   * @defaultValue the app id passed to `init`
   * @throws SteamResultError if Steam refused.
   * @throws SteamApiCallError if the call could not be completed.
   * @see addToFavorites
   */
  async removeFromFavorites(fileId: bigint, appId: number = this.appId): Promise<void> {
    const call = this.ugc.RemoveItemFromFavorites(appId, fileId);
    const r = await this.dispatch.callResultStruct<UserFavoriteItemsListChanged_t>(
      call,
      layoutOf('UserFavoriteItemsListChanged_t'),
      callbackIdByName.UserFavoriteItemsListChanged_t,
    );
    ok('RemoveItemFromFavorites', r.m_eResult);
  }

  /**
   * Tells Steam which items are in use, so their playtime statistics grow.
   *
   * Call it when a session with those mods starts, and the matching stop
   * method when it ends. Steam caps one call at 100 items.
   *
   * @param fileIds - Items in use. 64-bit, so `bigint`s.
   * @throws SteamResultError if Steam refused, for example with `k_EResultInvalidParam` above 100 items.
   * @throws SteamApiCallError if the call could not be completed.
   * @see stopPlaytimeTracking
   */
  async startPlaytimeTracking(fileIds: bigint[]): Promise<void> {
    const call = this.ugc.StartPlaytimeTracking(fileIdArray(fileIds), fileIds.length);
    const r = await this.dispatch.callResultStruct<StartPlaytimeTrackingResult_t>(
      call,
      layoutOf('StartPlaytimeTrackingResult_t'),
      callbackIdByName.StartPlaytimeTrackingResult_t,
    );
    ok('StartPlaytimeTracking', r.m_eResult);
  }

  /**
   * Stops playtime tracking for some items.
   *
   * @param fileIds - Items no longer in use. 64-bit, so `bigint`s. Omit to stop tracking every item.
   * @throws SteamResultError if Steam refused.
   * @throws SteamApiCallError if the call could not be completed.
   * @see startPlaytimeTracking
   */
  async stopPlaytimeTracking(fileIds?: bigint[]): Promise<void> {
    const call = fileIds
      ? this.ugc.StopPlaytimeTracking(fileIdArray(fileIds), fileIds.length)
      : this.ugc.StopPlaytimeTrackingForAllItems();
    const r = await this.dispatch.callResultStruct<StopPlaytimeTrackingResult_t>(
      call,
      layoutOf('StopPlaytimeTrackingResult_t'),
      callbackIdByName.StopPlaytimeTrackingResult_t,
    );
    ok('StopPlaytimeTracking', r.m_eResult);
  }

  /**
   * Opens the Steam Workshop legal agreement in the overlay.
   *
   * A user who has not accepted it cannot publish, and `createItem` reports
   * that through `legalAgreementRequired`.
   *
   * @returns True if the overlay opened. False when the overlay is disabled.
   * @see getEulaStatus
   */
  showEula(): boolean {
    return this.ugc.ShowWorkshopEULA();
  }

  /**
   * Reads whether the current user accepted the Steam Workshop legal
   * agreement.
   *
   * @returns The agreement version and the user's standing with it.
   * @throws SteamResultError if Steam refused, with `k_EResultInvalidParam` for an app that has no workshop agreement configured (Spacewar is one).
   * @throws SteamApiCallError if the call could not be completed.
   * @see showEula
   */
  async getEulaStatus(): Promise<WorkshopEulaStatus> {
    const call = this.ugc.GetWorkshopEULAStatus();
    const r = await this.dispatch.callResultStruct<WorkshopEULAStatus_t>(
      call,
      layoutOf('WorkshopEULAStatus_t'),
      callbackIdByName.WorkshopEULAStatus_t,
    );
    ok('GetWorkshopEULAStatus', r.m_eResult);
    return { version: r.m_unVersion, accepted: r.m_bAccepted, needsAction: r.m_bNeedsAction, actionTime: r.m_rtAction };
  }

  /**
   * Applies the query options, sends the query, and decodes every result row.
   *
   * The handle is released in a `finally`, so a failed query leaks nothing.
   * Rows Steam returns as `k_EResultFileNotFound`, or cannot return at all,
   * are skipped, so `items.length` can be below the returned row count.
   *
   * @param handle - UGCQueryHandle_t from a `CreateQuery...Request` call.
   * @param opts - Language and description options to apply before sending.
   * @returns The decoded items, the total match count, and the next cursor (null for page queries and after the last page).
   * @throws SteamResultError if the query completed with a non-OK EResult.
   */
  private async runQuery(handle: bigint, opts: QueryOptions): Promise<BrowsePage> {
    if (opts.language !== undefined) must('SetLanguage', this.ugc.SetLanguage(handle, opts.language));
    if (opts.longDescription) must('SetReturnLongDescription', this.ugc.SetReturnLongDescription(handle, true));
    if (opts.children) must('SetReturnChildren', this.ugc.SetReturnChildren(handle, true));
    if (opts.additionalPreviews)
      must('SetReturnAdditionalPreviews', this.ugc.SetReturnAdditionalPreviews(handle, true));
    if (opts.metadata) must('SetReturnMetadata', this.ugc.SetReturnMetadata(handle, true));
    if (opts.keyValueTags) must('SetReturnKeyValueTags', this.ugc.SetReturnKeyValueTags(handle, true));
    try {
      const call = this.ugc.SendQueryUGCRequest(handle);
      const q = await this.dispatch.callResultStruct<SteamUGCQueryCompleted_t>(
        call,
        layoutOf('SteamUGCQueryCompleted_t'),
        callbackIdByName.SteamUGCQueryCompleted_t,
      );
      ok('SendQueryUGCRequest', q.m_eResult);
      const items: WorkshopItem[] = [];
      const detailsBuf = Buffer.alloc(layoutOf('SteamUGCDetails_t').size);
      for (let i = 0; i < q.m_unNumResultsReturned; i++) {
        if (!this.ugc.GetQueryUGCResult(q.m_handle, i, detailsBuf)) continue;
        const d = decodeStruct<SteamUGCDetails_t>(detailsBuf, layoutOf('SteamUGCDetails_t'));
        if (d.m_eResult === EResult.k_EResultFileNotFound) continue;
        items.push(this.toItem(q.m_handle, i, d, opts));
      }
      // Steam hands back the cursor it was given once the results run out.
      const nextCursor = q.m_unNumResultsReturned > 0 && q.m_rgchNextCursor ? q.m_rgchNextCursor : null;
      return { items, totalResults: q.m_unTotalMatchingResults, nextCursor };
    } finally {
      this.ugc.ReleaseQueryUGCRequest(handle);
    }
  }

  /**
   * Builds one `WorkshopItem` from a decoded details struct.
   *
   * The preview URL and the statistics are not in `SteamUGCDetails_t`, so they
   * are read with their own flat calls against the still-open query handle.
   * That is why this runs before `ReleaseQueryUGCRequest`.
   *
   * @param handle - The open query handle.
   * @param index - Row index inside the query result.
   * @param d - The decoded `SteamUGCDetails_t` for that row.
   * @param opts - The options the query ran with, which decide whether metadata and key/value tags are read.
   * @returns The item. `previewUrl` is null and a statistic key is absent when Steam returned neither.
   */
  private toItem(handle: bigint, index: number, d: SteamUGCDetails_t, opts: QueryOptions): WorkshopItem {
    const urlBuf = Buffer.alloc(256);
    const previewUrl = this.ugc.GetQueryUGCPreviewURL(handle, index, urlBuf, 256)
      ? cstr(urlBuf) || null
      : null;
    const statistics: Partial<Record<WorkshopStatistic, bigint>> = {};
    const statBuf = Buffer.alloc(8);
    for (const [key, stat] of Object.entries(STATISTICS)) {
      if (this.ugc.GetQueryUGCStatistic(handle, index, stat, statBuf)) {
        statistics[key as WorkshopStatistic] = statBuf.readBigUInt64LE(0);
      }
    }
    // Both calls come back empty unless the query asked for them, which is
    // exactly the documented "option off" behaviour.
    const children: bigint[] = [];
    if (d.m_unNumChildren > 0) {
      const childBuf = Buffer.alloc(d.m_unNumChildren * 8);
      if (this.ugc.GetQueryUGCChildren(handle, index, childBuf, d.m_unNumChildren)) {
        for (let i = 0; i < d.m_unNumChildren; i++) children.push(childBuf.readBigUInt64LE(i * 8));
      }
    }
    const additionalPreviews: AdditionalPreview[] = [];
    const numPreviews = this.ugc.GetQueryUGCNumAdditionalPreviews(handle, index);
    for (let i = 0; i < numPreviews; i++) {
      const urlBuf2 = Buffer.alloc(256);
      const nameBuf = Buffer.alloc(260);
      const typeBuf = out.int32();
      if (!this.ugc.GetQueryUGCAdditionalPreview(handle, index, i, urlBuf2, 256, nameBuf, 260, typeBuf.buffer)) continue;
      additionalPreviews.push({
        type: typeBuf.value,
        urlOrVideoId: cstr(urlBuf2),
        originalFileName: cstr(nameBuf),
      });
    }
    let metadata: string | undefined;
    if (opts.metadata) {
      const metaBuf = Buffer.alloc(k_cchDeveloperMetadataMax);
      if (this.ugc.GetQueryUGCMetadata(handle, index, metaBuf, k_cchDeveloperMetadataMax)) metadata = cstr(metaBuf);
    }
    let keyValueTags: Record<string, string> | undefined;
    if (opts.keyValueTags) {
      // A prototype-free object, so a tag named __proto__ or constructor stays
      // a normal entry instead of touching the prototype chain.
      const tags: Record<string, string> = Object.create(null);
      const numTags = this.ugc.GetQueryUGCNumKeyValueTags(handle, index);
      for (let i = 0; i < numTags; i++) {
        const keyBuf = Buffer.alloc(KEY_VALUE_TAG_BYTES);
        const valueBuf = Buffer.alloc(KEY_VALUE_TAG_BYTES);
        const read = this.ugc.GetQueryUGCKeyValueTag(
          handle,
          index,
          i,
          keyBuf,
          KEY_VALUE_TAG_BYTES,
          valueBuf,
          KEY_VALUE_TAG_BYTES,
        );
        if (read) tags[cstr(keyBuf)] = cstr(valueBuf);
      }
      keyValueTags = tags;
    }
    return {
      fileId: d.m_nPublishedFileId,
      title: d.m_rgchTitle,
      description: d.m_rgchDescription,
      fileType: d.m_eFileType,
      creatorAppId: d.m_nCreatorAppID,
      consumerAppId: d.m_nConsumerAppID,
      ownerSteamId: d.m_ulSteamIDOwner,
      timeCreated: d.m_rtimeCreated,
      timeUpdated: d.m_rtimeUpdated,
      visibility: d.m_eVisibility,
      banned: d.m_bBanned,
      acceptedForUse: d.m_bAcceptedForUse,
      tags: d.m_rgchTags ? d.m_rgchTags.split(',') : [],
      tagsTruncated: d.m_bTagsTruncated,
      fileName: d.m_pchFileName,
      fileSize: d.m_nFileSize,
      previewFileSize: d.m_nPreviewFileSize,
      url: d.m_rgchURL,
      votesUp: d.m_unVotesUp,
      votesDown: d.m_unVotesDown,
      score: d.m_flScore,
      numChildren: d.m_unNumChildren,
      totalFilesSize: d.m_ulTotalFilesSize,
      previewUrl,
      statistics,
      children,
      additionalPreviews,
      metadata,
      keyValueTags,
    };
  }
}
