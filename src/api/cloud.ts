import type { SteamDispatch } from '../runtime/dispatch';
import { out } from '../runtime/out';
import type { ISteamRemoteStorage } from '../generated/interfaces/ISteamRemoteStorage';
import type { SteamCallbackMap } from '../generated/callbacks';
import { layoutOf } from '../generated/structs';
import type {
  RemoteStorageFileReadAsyncComplete_t,
  RemoteStorageFileShareResult_t,
  RemoteStorageFileWriteAsyncComplete_t,
} from '../generated/structs';
import { ERemoteStorageFilePathType, ERemoteStorageLocalFileChange } from '../generated/enums';
import { callbackIdByName } from '../generated/callbacks';
import { ok, must } from './guards';

/**
 * One file in the cloud, as returned by the file listing.
 *
 * @see Cloud.listFiles
 */
export interface CloudFile {
  /** File name, the same name `readFile` and `deleteFile` take. */
  name: string;
  /** Size of the file in bytes. Steam caps a single file at 100 MB, so a `number` is enough. */
  sizeBytes: number;
}

/**
 * Size and modification time of one cloud file.
 *
 * @see Cloud.getFileInfo
 */
export interface CloudFileInfo {
  /** Size of the file in bytes. */
  sizeBytes: number;
  /** Last write time, Unix seconds. 64-bit, so a `bigint`. */
  timestamp: bigint;
}

/**
 * How much cloud storage this app may use, and how much is left.
 *
 * @see Cloud.quota
 */
export interface CloudQuota {
  /** Total bytes Steam grants this app for this user. 64-bit, so a `bigint`. */
  totalBytes: bigint;
  /** Bytes still free. A write larger than this fails with `k_EResultLimitExceeded`. 64-bit, so a `bigint`. */
  availableBytes: bigint;
}

/**
 * Task level wrapper over ISteamRemoteStorage: read, write, list, and delete
 * Steam Cloud files for the current user and app.
 *
 * Reads and writes go through Valve's async path, so a slow disk or a large
 * file never blocks the Node event loop. Every method turns a non-OK
 * `EResult` into a `SteamResultError`, and a false return into an `Error`.
 * Reach it as `steam.cloud`.
 *
 * A file only reaches Valve's servers when cloud sync is on for both the
 * account and the app. Check that with `isEnabledForAccount` and
 * `isEnabledForApp`; local reads and writes work either way.
 *
 * The workshop lives in `steam.workshop`, not here. The legacy
 * publish-to-workshop calls on ISteamRemoteStorage are deprecated and are not
 * wrapped.
 *
 * @see Steam.cloud
 * @see SteamResultError
 */
export class Cloud {
  /**
   * @param remoteStorage - The ISteamRemoteStorage interface.
   * @param dispatch - Running pump that resolves the call results.
   * @param subscribe - Callback subscriber, normally `steam.on` bound to the session.
   */
  constructor(
    private readonly remoteStorage: ISteamRemoteStorage,
    private readonly dispatch: SteamDispatch,
    private readonly subscribe: <K extends keyof SteamCallbackMap & string>(
      name: K,
      listener: (data: SteamCallbackMap[K]) => void,
    ) => () => void,
  ) {}

  /**
   * Writes one file, replacing it if it already exists.
   *
   * Steam writes the file locally first and syncs it later, so the promise
   * resolving does not mean the file reached Valve's servers. Use
   * `isPersisted` for that.
   *
   * @param name - File name, for example `save01.json`. Forward slashes make subfolders.
   * @param data - The file contents. A string is encoded as UTF-8. Steam rejects an empty write and caps one file at 100 MB.
   * @throws SteamResultError if Steam refused the write, for example with `k_EResultLimitExceeded` when the quota is full.
   * @throws SteamApiCallError if the call could not be completed.
   * @example
   * ```ts
   * import { init } from 'steamwand.js';
   *
   * const steam = init({ appId: 480 });
   * await steam.cloud.writeFile('save01.json', JSON.stringify({ level: 3 }));
   * steam.close();
   * ```
   * @see readFile
   */
  async writeFile(name: string, data: Buffer | string): Promise<void> {
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    const call = this.remoteStorage.FileWriteAsync(name, buf, buf.length);
    const r = await this.dispatch.callResultStruct<RemoteStorageFileWriteAsyncComplete_t>(
      call,
      layoutOf('RemoteStorageFileWriteAsyncComplete_t'),
      callbackIdByName.RemoteStorageFileWriteAsyncComplete_t,
    );
    ok('FileWriteAsync', r.m_eResult);
  }

  /**
   * Groups several writes into one save, so Steam syncs them together.
   *
   * A save game that is more than one file is only consistent as a set. Inside
   * the callback Steam holds the sync back, and it starts one sync for
   * everything written once the callback finished. Anything the callback does
   * that is not a cloud write is fine; it just delays the sync.
   *
   * The batch is always closed, even when the callback throws, and the
   * callback's own error is the one that reaches the caller.
   *
   * @param fn - Runs the writes. Awaited, so it may be async.
   * @returns Whatever `fn` returned.
   * @throws Error if Steam refused to open the batch, or whatever `fn` threw.
   * @typeParam T - What `fn` returns.
   * @example
   * ```ts
   * import { init } from 'steamwand.js';
   *
   * const steam = init({ appId: 480 });
   * await steam.cloud.writeBatch(async () => {
   *   await steam.cloud.writeFile('save01/meta.json', JSON.stringify({ level: 3 }));
   *   await steam.cloud.writeFile('save01/world.bin', worldBytes);
   * });
   * steam.close();
   * ```
   * @see writeFile
   */
  async writeBatch<T>(fn: () => Promise<T> | T): Promise<T> {
    must('BeginFileWriteBatch', this.remoteStorage.BeginFileWriteBatch());
    try {
      return await fn();
    } finally {
      this.remoteStorage.EndFileWriteBatch();
    }
  }

  /**
   * Reads one whole file.
   *
   * Three flat calls in a row: `GetFileSize` for the length, `FileReadAsync`
   * to queue the read, then `FileReadAsyncComplete` to copy the bytes Steam
   * holds into a buffer of exactly the size Steam reports it read. Steam frees
   * its own copy in that last call, so it runs even for a short read.
   *
   * @param name - File name to read.
   * @returns The file contents. An empty file gives an empty buffer, without any async call.
   * @throws Error if the file does not exist, or if `FileReadAsyncComplete` refused the handle.
   * @throws SteamResultError if Steam refused the read, for example with `k_EResultFileNotFound`.
   * @throws SteamApiCallError if the call could not be completed.
   * @example
   * ```ts
   * import { init } from 'steamwand.js';
   *
   * const steam = init({ appId: 480 });
   * const save = JSON.parse((await steam.cloud.readFile('save01.json')).toString('utf8'));
   * console.log(save.level);
   * steam.close();
   * ```
   * @see writeFile
   */
  async readFile(name: string): Promise<Buffer> {
    if (!this.remoteStorage.FileExists(name)) throw new Error(`steamwand: cloud file does not exist: ${name}`);
    const size = this.remoteStorage.GetFileSize(name);
    if (size <= 0) return Buffer.alloc(0);

    const call = this.remoteStorage.FileReadAsync(name, 0, size);
    const r = await this.dispatch.callResultStruct<RemoteStorageFileReadAsyncComplete_t>(
      call,
      layoutOf('RemoteStorageFileReadAsyncComplete_t'),
      callbackIdByName.RemoteStorageFileReadAsyncComplete_t,
    );
    ok('FileReadAsync', r.m_eResult);

    // Steam reports how much it actually read; the buffer must be that size,
    // not the size GetFileSize gave, or the copy runs past the end.
    const buffer = Buffer.alloc(Math.max(r.m_cubRead, 1));
    must('FileReadAsyncComplete', this.remoteStorage.FileReadAsyncComplete(r.m_hFileReadAsync, buffer, r.m_cubRead));
    return buffer.subarray(0, r.m_cubRead);
  }

  /**
   * Deletes a file from the cloud and from disk.
   *
   * This is the one to use when the user deletes a save game: the file is gone
   * everywhere, and it stops counting against the quota.
   *
   * @param name - File name to delete.
   * @throws Error if Steam returned false, which usually means the file does not exist.
   * @see forgetFile
   */
  deleteFile(name: string): void {
    must('FileDelete', this.remoteStorage.FileDelete(name));
  }

  /**
   * Stops syncing a file without deleting it.
   *
   * The local copy stays on this machine and the cloud copy stays on Valve's
   * servers, but the two stop tracking each other, so the file is not
   * downloaded onto the user's other machines. Use this for a save the user
   * wants on one machine only. Use `deleteFile` to actually remove it.
   *
   * @param name - File name to forget.
   * @throws Error if Steam returned false, which usually means the file does not exist.
   * @see deleteFile
   */
  forgetFile(name: string): void {
    must('FileForget', this.remoteStorage.FileForget(name));
  }

  /**
   * Checks whether a file exists in this app's cloud storage.
   *
   * @param name - File name to check.
   * @returns True if the file exists, locally or in the cloud.
   */
  exists(name: string): boolean {
    return this.remoteStorage.FileExists(name);
  }

  /**
   * Checks whether a file already reached Valve's servers.
   *
   * False right after a write, and true once the sync finished. A file that
   * was forgotten with `forgetFile` never becomes persisted.
   *
   * @param name - File name to check.
   * @returns True if the cloud copy is up to date.
   * @see forgetFile
   */
  isPersisted(name: string): boolean {
    return this.remoteStorage.FilePersisted(name);
  }

  /**
   * Lists every file in this app's cloud storage for the current user.
   *
   * @returns One entry per file, in Steam's own order. Empty if the app has no cloud files.
   * @example
   * ```ts
   * import { init } from 'steamwand.js';
   *
   * const steam = init({ appId: 480 });
   * for (const f of steam.cloud.listFiles()) console.log(f.name, f.sizeBytes);
   * steam.close();
   * ```
   * @see getFileInfo
   */
  listFiles(): CloudFile[] {
    const count = this.remoteStorage.GetFileCount();
    const size = out.int32();
    const files: CloudFile[] = [];
    for (let i = 0; i < count; i++) {
      const name = this.remoteStorage.GetFileNameAndSize(i, size.buffer);
      files.push({ name, sizeBytes: size.value });
    }
    return files;
  }

  /**
   * Reads one file's size and modification time without reading its contents.
   *
   * @param name - File name to look at.
   * @returns The size and timestamp, or null if the file does not exist.
   * @see listFiles
   */
  getFileInfo(name: string): CloudFileInfo | null {
    if (!this.remoteStorage.FileExists(name)) return null;
    return {
      sizeBytes: this.remoteStorage.GetFileSize(name),
      timestamp: this.remoteStorage.GetFileTimestamp(name),
    };
  }

  /**
   * Publishes a cloud file and returns the UGC handle that points at it.
   *
   * The handle is public: anybody who has it can download the file, so only
   * share what the user meant to share. It is the handle a leaderboard entry
   * carries through `steam.leaderboards.attachUgc`, for example a replay saved
   * alongside a score.
   *
   * @param name - File name to publish. It must already be in cloud storage.
   * @returns The UGC handle. 64-bit, so a `bigint`.
   * @throws SteamResultError if Steam refused, for example with `k_EResultFileNotFound`.
   * @throws SteamApiCallError if the call could not be completed.
   * @example
   * ```ts
   * import { init } from 'steamwand.js';
   *
   * const steam = init({ appId: 480 });
   * await steam.cloud.writeFile('replay01.bin', replayBytes);
   * const ugc = await steam.cloud.share('replay01.bin');
   * const board = await steam.leaderboards.find('Feet Traveled');
   * if (board) await steam.leaderboards.attachUgc(board.handle, ugc);
   * steam.close();
   * ```
   * @see writeFile
   */
  async share(name: string): Promise<bigint> {
    const call = this.remoteStorage.FileShare(name);
    const r = await this.dispatch.callResultStruct<RemoteStorageFileShareResult_t>(
      call,
      layoutOf('RemoteStorageFileShareResult_t'),
      callbackIdByName.RemoteStorageFileShareResult_t,
    );
    ok('FileShare', r.m_eResult);
    return r.m_hFile;
  }

  /**
   * Reads which platforms one file syncs to.
   *
   * @param name - File name to look at.
   * @returns An `ERemoteStoragePlatform` bit mask: 1 Windows, 2 macOS, 8 Linux, 16 Switch, 32 Android, 64 iOS, -1 all.
   * @see setSyncPlatforms
   */
  syncPlatforms(name: string): number {
    return this.remoteStorage.GetSyncPlatforms(name);
  }

  /**
   * Limits a file to certain platforms.
   *
   * Use it for a file that only makes sense on one platform, for example a
   * settings file holding key bindings that a controller-only build cannot
   * read. Steam still keeps the file, it just stops downloading it elsewhere.
   *
   * @param name - File name to change. It must already be in cloud storage.
   * @param platforms - `ERemoteStoragePlatform` bit mask. Or the bits together for several platforms, -1 for all.
   * @throws Error if Steam returned false, which usually means the file does not exist.
   * @example
   * ```ts
   * import { init, flat } from 'steamwand.js';
   *
   * const steam = init({ appId: 480 });
   * const desktop =
   *   flat.ERemoteStoragePlatform.k_ERemoteStoragePlatformWindows |
   *   flat.ERemoteStoragePlatform.k_ERemoteStoragePlatformLinux;
   * steam.cloud.setSyncPlatforms('bindings.cfg', desktop);
   * steam.close();
   * ```
   * @see syncPlatforms
   */
  setSyncPlatforms(name: string, platforms: number): void {
    must('SetSyncPlatforms', this.remoteStorage.SetSyncPlatforms(name, platforms));
  }

  /**
   * Reads this app's cloud storage quota for the current user.
   *
   * A write larger than `availableBytes` fails with `k_EResultLimitExceeded`,
   * so check this before writing something big.
   *
   * @returns The total and the still free byte counts, both 64-bit, so `bigint`.
   * @throws Error if Steam returned false, which means the quota is not known yet.
   * @example
   * ```ts
   * import { init } from 'steamwand.js';
   *
   * const steam = init({ appId: 480 });
   * const { totalBytes, availableBytes } = steam.cloud.quota();
   * console.log(`${availableBytes} of ${totalBytes} bytes free`);
   * steam.close();
   * ```
   */
  quota(): CloudQuota {
    const total = out.uint64();
    const available = out.uint64();
    must('GetQuota', this.remoteStorage.GetQuota(total.buffer, available.buffer));
    return { totalBytes: total.value, availableBytes: available.value };
  }

  /**
   * Checks whether the user turned cloud sync on for their whole account.
   *
   * The user sets this in the Steam client settings. The app cannot change it.
   * Files still write locally when it is off, they just never sync.
   *
   * @returns True if account-wide cloud sync is on.
   * @see isEnabledForApp
   */
  isEnabledForAccount(): boolean {
    return this.remoteStorage.IsCloudEnabledForAccount();
  }

  /**
   * Checks whether cloud sync is on for this app.
   *
   * Steam sets the starting value from the user's per-app setting.
   * `setEnabledForApp` overrides it for this session.
   *
   * @returns True if cloud sync is on for this app.
   * @see setEnabledForApp
   */
  isEnabledForApp(): boolean {
    return this.remoteStorage.IsCloudEnabledForApp();
  }

  /**
   * Turns cloud sync on or off for this app.
   *
   * This is meant for an in-game "sync my saves" option. It does not change the
   * user's Steam client setting, and it cannot switch sync on while the account
   * has it off.
   *
   * @param enabled - True to sync this app's files, false to keep them local.
   * @see isEnabledForApp
   */
  setEnabledForApp(enabled: boolean): void {
    this.remoteStorage.SetCloudEnabledForApp(enabled);
  }

  /**
   * Lists the files a Steam sync changed underneath the running app.
   *
   * Steam only fills this list while the app is running, and it clears it on
   * the next sync, so read it from an `onLocalFileChange` listener rather than
   * polling. A game that keeps a save open in memory uses this to notice that
   * the copy on disk moved on, and to offer the player a reload.
   *
   * @returns One entry per changed file, in Steam's own order. Empty when nothing changed.
   * @example
   * ```ts
   * import { init } from 'steamwand.js';
   *
   * const steam = init({ appId: 480 });
   * const off = steam.cloud.onLocalFileChange(() => {
   *   for (const c of steam.cloud.listLocalChanges()) console.log(c.name, c.change);
   * });
   * // later: off();
   * ```
   * @see onLocalFileChange
   */
  listLocalChanges(): { name: string; change: 'updated' | 'deleted'; pathType: 'absolute' | 'apiFilename' }[] {
    const count = this.remoteStorage.GetLocalFileChangeCount();
    const change = out.int32();
    const pathType = out.int32();
    const changes: { name: string; change: 'updated' | 'deleted'; pathType: 'absolute' | 'apiFilename' }[] = [];
    for (let i = 0; i < count; i++) {
      const name = this.remoteStorage.GetLocalFileChange(i, change.buffer, pathType.buffer);
      changes.push({
        name,
        change:
          change.value === ERemoteStorageLocalFileChange.k_ERemoteStorageLocalFileChange_FileDeleted
            ? 'deleted'
            : 'updated',
        pathType:
          pathType.value === ERemoteStorageFilePathType.k_ERemoteStorageFilePathType_Absolute
            ? 'absolute'
            : 'apiFilename',
      });
    }
    return changes;
  }

  /**
   * Subscribes to the "Steam just changed files on disk" notice.
   *
   * Steam fires it once after a sync changed files while the app was running,
   * for example because the user played on another machine. The callback
   * carries nothing; `listLocalChanges` says which files, and only while the
   * listener runs.
   *
   * @param listener - Runs after every such sync.
   * @returns Unsubscribe function. Calling it more than once is harmless.
   * @see listLocalChanges
   */
  onLocalFileChange(listener: () => void): () => void {
    return this.subscribe('RemoteStorageLocalFileChange_t', () => listener());
  }
}
