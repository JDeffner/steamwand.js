import * as fs from 'node:fs';
import type { SteamDispatch } from '../runtime/dispatch';
import { decodeStruct } from '../runtime/struct';
import { stringArray } from '../runtime/types';
import type { ISteamUGC } from '../generated/interfaces/ISteamUGC';
import { layoutOf } from '../generated/structs';
import type {
  CreateItemResult_t,
  DeleteItemResult_t,
  SteamUGCDetails_t,
  SteamUGCQueryCompleted_t,
  SubmitItemUpdateResult_t,
} from '../generated/structs';
import { EItemStatistic, EResult, EUGCMatchingUGCType, EUserUGCList, EUserUGCListSortOrder, EWorkshopFileType } from '../generated/enums';
import { SteamResultError } from './errors';

export interface WorkshopItemUpdate {
  title?: string;
  description?: string;
  /** Steam API language code (`german`, `schinese`, ...): sets which language title/description apply to. */
  language?: string;
  changeNote?: string;
  /** Absolute path to the content folder. */
  contentPath?: string;
  /** Absolute path to the preview image. */
  previewPath?: string;
  tags?: string[];
  /** ERemoteStoragePublishedFileVisibility (0 public, 1 friends-only, 2 private, 3 unlisted). */
  visibility?: number;
}

export interface UpdateProgress {
  /** EItemUpdateStatus (0 invalid .. 5 committing changes). */
  status: number;
  bytesProcessed: bigint;
  bytesTotal: bigint;
}

export interface WorkshopItem {
  fileId: bigint;
  title: string;
  description: string;
  fileType: number;
  creatorAppId: number;
  consumerAppId: number;
  ownerSteamId: bigint;
  timeCreated: number;
  timeUpdated: number;
  visibility: number;
  banned: boolean;
  acceptedForUse: boolean;
  tags: string[];
  tagsTruncated: boolean;
  fileName: string;
  fileSize: number;
  previewFileSize: number;
  url: string;
  votesUp: number;
  votesDown: number;
  score: number;
  numChildren: number;
  totalFilesSize: bigint;
  previewUrl: string | null;
  statistics: Partial<Record<WorkshopStatistic, bigint>>;
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
export type WorkshopStatistic = keyof typeof STATISTICS & string;

export interface QueryOptions {
  /** Steam API language code for returned text (title/description). */
  language?: string;
  /** Return the full description instead of the truncated one. */
  longDescription?: boolean;
}

export interface UserItemsPage {
  items: WorkshopItem[];
  totalResults: number;
}

function ok(operation: string, result: number): void {
  if (result !== EResult.k_EResultOK) throw new SteamResultError(operation, result);
}

function must(operation: string, returned: boolean): void {
  if (!returned) throw new Error(`steamwand: ${operation} returned false (invalid handle or argument?)`);
}

export class Workshop {
  constructor(
    private readonly ugc: ISteamUGC,
    private readonly dispatch: SteamDispatch,
    private readonly appId: number,
  ) {}

  /** Create a new (empty) workshop item. */
  async createItem(
    appId: number = this.appId,
    fileType: number = EWorkshopFileType.k_EWorkshopFileTypeCommunity,
  ): Promise<{ fileId: bigint; legalAgreementRequired: boolean }> {
    const call = this.ugc.CreateItem(appId, fileType);
    const r = await this.dispatch.callResultStruct<CreateItemResult_t>(call, layoutOf('CreateItemResult_t'));
    ok('CreateItem', r.m_eResult);
    return { fileId: r.m_nPublishedFileId, legalAgreementRequired: r.m_bUserNeedsToAcceptWorkshopLegalAgreement };
  }

  /**
   * Apply one item update (StartItemUpdate + setters + SubmitItemUpdate) and
   * wait for the result. With `language` set, title/description apply to that
   * language only (SetItemUpdateLanguage).
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

    const h = this.ugc.StartItemUpdate(appId, fileId);
    if (update.language !== undefined) must('SetItemUpdateLanguage', this.ugc.SetItemUpdateLanguage(h, update.language));
    if (update.title !== undefined) must('SetItemTitle', this.ugc.SetItemTitle(h, update.title));
    if (update.description !== undefined) must('SetItemDescription', this.ugc.SetItemDescription(h, update.description));
    if (update.contentPath !== undefined) must('SetItemContent', this.ugc.SetItemContent(h, update.contentPath));
    if (update.previewPath !== undefined) must('SetItemPreview', this.ugc.SetItemPreview(h, update.previewPath));
    if (update.visibility !== undefined) must('SetItemVisibility', this.ugc.SetItemVisibility(h, update.visibility));
    if (update.tags !== undefined) must('SetItemTags', this.ugc.SetItemTags(h, stringArray(update.tags), false));

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
      );
      ok('SubmitItemUpdate', r.m_eResult);
      return { legalAgreementRequired: r.m_bUserNeedsToAcceptWorkshopLegalAgreement };
    } finally {
      if (progressTimer) clearInterval(progressTimer);
    }
  }

  /** Delete a workshop item permanently. */
  async deleteItem(fileId: bigint): Promise<void> {
    const call = this.ugc.DeleteItem(fileId);
    const r = await this.dispatch.callResultStruct<DeleteItemResult_t>(call, layoutOf('DeleteItemResult_t'));
    ok('DeleteItem', r.m_eResult);
  }

  /** Fetch one item's details, or null if it does not exist. */
  async getItem(fileId: bigint, opts: QueryOptions = {}): Promise<WorkshopItem | null> {
    const ids = Buffer.alloc(8);
    ids.writeBigUInt64LE(fileId, 0);
    const handle = this.ugc.CreateQueryUGCDetailsRequest(ids, 1);
    const { items } = await this.runQuery(handle, opts);
    return items[0] ?? null;
  }

  /** One page (1-based) of a user's published items for this app. */
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

  private async runQuery(handle: bigint, opts: QueryOptions): Promise<UserItemsPage> {
    if (opts.language !== undefined) must('SetLanguage', this.ugc.SetLanguage(handle, opts.language));
    if (opts.longDescription) must('SetReturnLongDescription', this.ugc.SetReturnLongDescription(handle, true));
    try {
      const call = this.ugc.SendQueryUGCRequest(handle);
      const q = await this.dispatch.callResultStruct<SteamUGCQueryCompleted_t>(
        call,
        layoutOf('SteamUGCQueryCompleted_t'),
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

  private toItem(handle: bigint, index: number, d: SteamUGCDetails_t): WorkshopItem {
    const urlBuf = Buffer.alloc(256);
    const previewUrl = this.ugc.GetQueryUGCPreviewURL(handle, index, urlBuf, 256)
      ? urlBuf.toString('utf8', 0, Math.max(urlBuf.indexOf(0), 0)) || null
      : null;
    const statistics: Partial<Record<WorkshopStatistic, bigint>> = {};
    const statBuf = Buffer.alloc(8);
    for (const [key, stat] of Object.entries(STATISTICS)) {
      if (this.ugc.GetQueryUGCStatistic(handle, index, stat, statBuf)) {
        statistics[key as WorkshopStatistic] = statBuf.readBigUInt64LE(0);
      }
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
    };
  }
}
