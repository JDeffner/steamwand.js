import * as fs from 'node:fs';
import type { SteamDispatch } from '../runtime/dispatch';
import { decodeStruct } from '../runtime/struct';
import { stringArray } from '../runtime/types';
import { out } from '../runtime/out';
import type { ISteamUGC } from '../generated/interfaces/ISteamUGC';
import { layoutOf } from '../generated/structs';
import { callbackIdByName } from '../generated/callbacks';
import type {
  AddAppDependencyResult_t,
  AddUGCDependencyResult_t,
  CreateItemResult_t,
  DeleteItemResult_t,
  GetAppDependenciesResult_t,
  RemoveAppDependencyResult_t,
  RemoveUGCDependencyResult_t,
  SteamUGCDetails_t,
  SteamUGCQueryCompleted_t,
  SubmitItemUpdateResult_t,
} from '../generated/structs';
import { EItemPreviewType, EItemStatistic, EResult, EUGCMatchingUGCType, EUserUGCList, EUserUGCListSortOrder, EWorkshopFileType } from '../generated/enums';
import { ok, must } from './guards';

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
 * Task level wrapper over ISteamUGC: create, update, delete, and query
 * workshop items.
 *
 * Every method awaits the underlying async call through the dispatch, and
 * turns a non-OK `EResult` into a `SteamResultError`. Reach it as
 * `steam.workshop`, which builds it with the app id from `init`.
 *
 * @see Steam.workshop
 * @see SteamResultError
 */
export class Workshop {
  /**
   * @param ugc - The ISteamUGC interface.
   * @param dispatch - Running pump that resolves the call results.
   * @param appId - App id used when a method takes no explicit one.
   */
  constructor(
    private readonly ugc: ISteamUGC,
    private readonly dispatch: SteamDispatch,
    private readonly appId: number,
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
   * Applies the query options, sends the query, and decodes every result row.
   *
   * The handle is released in a `finally`, so a failed query leaks nothing.
   * Rows Steam returns as `k_EResultFileNotFound`, or cannot return at all,
   * are skipped, so `items.length` can be below the returned row count.
   *
   * @param handle - UGCQueryHandle_t from a `CreateQuery...Request` call.
   * @param opts - Language and description options to apply before sending.
   * @returns The decoded items and the total match count.
   * @throws SteamResultError if the query completed with a non-OK EResult.
   */
  private async runQuery(handle: bigint, opts: QueryOptions): Promise<UserItemsPage> {
    if (opts.language !== undefined) must('SetLanguage', this.ugc.SetLanguage(handle, opts.language));
    if (opts.longDescription) must('SetReturnLongDescription', this.ugc.SetReturnLongDescription(handle, true));
    if (opts.children) must('SetReturnChildren', this.ugc.SetReturnChildren(handle, true));
    if (opts.additionalPreviews)
      must('SetReturnAdditionalPreviews', this.ugc.SetReturnAdditionalPreviews(handle, true));
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
        items.push(this.toItem(q.m_handle, i, d));
      }
      return { items, totalResults: q.m_unTotalMatchingResults };
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
   * @returns The item. `previewUrl` is null and a statistic key is absent when Steam returned neither.
   */
  private toItem(handle: bigint, index: number, d: SteamUGCDetails_t): WorkshopItem {
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
    };
  }
}
