import { out } from '../runtime/out';
import type { ISteamApps } from '../generated/interfaces/ISteamApps';
import type { SteamCallbackMap } from '../generated/callbacks';

/**
 * One DLC of the running app, as Steam reports it to the client.
 *
 * @see Apps.listDlc
 */
export interface DlcInfo {
  /** App id of the DLC. */
  appId: number;
  /** True while the DLC is available for purchase or install (not hidden or removed). */
  available: boolean;
  /** Display name of the DLC, in the Steam client language. */
  name: string;
}

/**
 * Task level wrapper over the DLC half of ISteamApps: what the app has, what
 * the user owns, what is installed, and installing the rest.
 *
 * Listing DLC is an index loop over a call with three out-buffers, and
 * `install` is a two step flow: start the download, then wait for Steam's
 * `DlcInstalled_t`. Reach this as `steam.dlc`, since the generated interface
 * already owns `steam.apps`.
 *
 * The install and build facts of the running app are on `steam.system`, not
 * here: this layer is about the DLC of that app.
 *
 * @see Steam.dlc
 * @see System
 */
export class Apps {
  /**
   * @param apps - The ISteamApps interface.
   * @param subscribe - Callback subscriber, normally `steam.on` bound to the session.
   * @param once - Awaitable callback subscriber, normally `steam.once` bound to the session.
   */
  constructor(
    private readonly apps: ISteamApps,
    private readonly subscribe: <K extends keyof SteamCallbackMap & string>(
      name: K,
      listener: (data: SteamCallbackMap[K]) => void,
    ) => () => void,
    private readonly once: <K extends keyof SteamCallbackMap & string>(
      name: K,
      match?: (data: SteamCallbackMap[K]) => boolean,
    ) => Promise<SteamCallbackMap[K]>,
  ) {}

  /**
   * Lists the DLC of the running app.
   *
   * This is a local read against the Steam client, so it needs no round trip.
   * The list is what Steam knows about the app, not what the user owns: check
   * that with `isOwned`, and disk state with `isInstalled`.
   *
   * @returns One entry per DLC, in Steam's order. Empty if the app has none.
   * @example
   * ```ts
   * import { init } from 'steamwand.js';
   *
   * const steam = init({ appId: 480 });
   * for (const dlc of steam.dlc.listDlc()) {
   *   console.log(dlc.appId, dlc.name, steam.dlc.isInstalled(dlc.appId));
   * }
   * steam.close();
   * ```
   * @see isOwned
   * @see isInstalled
   */
  listDlc(): DlcInfo[] {
    const list: DlcInfo[] = [];
    const count = this.apps.GetDLCCount();
    for (let i = 0; i < count; i++) {
      const appId = out.uint32();
      const available = out.bool();
      const nameBuf = Buffer.alloc(128);
      if (!this.apps.BGetDLCDataByIndex(i, appId.buffer, available.buffer, nameBuf, nameBuf.length)) continue;
      list.push({
        appId: appId.value,
        available: available.value,
        name: nameBuf.toString('utf8', 0, Math.max(nameBuf.indexOf(0), 0)),
      });
    }
    return list;
  }

  /**
   * Checks whether a DLC is installed on this machine.
   *
   * Installed and owned are different questions: a DLC the user owns is only
   * installed once Steam has downloaded it. Gate the content on this one.
   *
   * @param appId - App id of the DLC.
   * @returns True if the files are on disk.
   * @see isOwned
   */
  isInstalled(appId: number): boolean {
    return this.apps.BIsDlcInstalled(appId);
  }

  /**
   * Checks whether the user owns an app or DLC.
   *
   * @param appId - App id to check.
   * @returns True if the user has a license, whether or not the files are installed.
   * @see isInstalled
   */
  isOwned(appId: number): boolean {
    return this.apps.BIsSubscribedApp(appId);
  }

  /**
   * Installs a DLC and resolves once Steam reports it installed.
   *
   * Returns at once when the DLC is already installed. Otherwise Steam queues
   * the download and confirms with `DlcInstalled_t`, which this waits for, so
   * the resolved promise means the files are on disk. The download itself is
   * Steam's, so this can take as long as the DLC is large; watch it with
   * `downloadProgress`.
   *
   * @param appId - App id of the DLC.
   * @throws Error if the user does not own the DLC. Steam would drop the request silently and never answer.
   * @example
   * ```ts
   * import { init } from 'steamwand.js';
   *
   * const steam = init({ appId: 480 });
   * const [dlc] = steam.dlc.listDlc();
   * if (dlc && steam.dlc.isOwned(dlc.appId)) await steam.dlc.install(dlc.appId);
   * steam.close();
   * ```
   * @see downloadProgress
   * @see onInstalled
   */
  async install(appId: number): Promise<void> {
    if (this.apps.BIsDlcInstalled(appId)) return;
    // Steam drops the request for an unowned DLC without a callback, which
    // would leave this promise pending forever.
    if (!this.apps.BIsSubscribedApp(appId)) throw new Error(`steamwand: the user does not own DLC ${appId}`);
    this.apps.InstallDLC(appId);
    await this.once('DlcInstalled_t', (e) => e.m_nAppID === appId);
  }

  /**
   * Uninstalls a DLC and frees its disk space.
   *
   * Steam has no result for this, so it cannot fail from here, and it returns
   * before the files are gone.
   *
   * @param appId - App id of the DLC.
   * @see install
   */
  uninstall(appId: number): void {
    this.apps.UninstallDLC(appId);
  }

  /**
   * Reads how far a DLC download has come.
   *
   * @param appId - App id of the DLC.
   * @returns The two byte counts, or null when that DLC is not downloading, which includes a finished one.
   * @example
   * ```ts
   * import { init } from 'steamwand.js';
   *
   * const steam = init({ appId: 480 });
   * const p = steam.dlc.downloadProgress(1234);
   * if (p) console.log(Number((p.bytesDownloaded * 100n) / p.bytesTotal), '%');
   * steam.close();
   * ```
   * @see install
   */
  downloadProgress(appId: number): { bytesDownloaded: bigint; bytesTotal: bigint } | null {
    const downloaded = out.uint64();
    const total = out.uint64();
    if (!this.apps.GetDlcDownloadProgress(appId, downloaded.buffer, total.buffer)) return null;
    return { bytesDownloaded: downloaded.value, bytesTotal: total.value };
  }

  /**
   * Subscribes to DLC finishing installation.
   *
   * Fires for every DLC Steam installs while the app runs, including one the
   * user bought from the store or the overlay, so this is the hook that turns
   * on the content without a restart. `install` already waits for its own DLC.
   *
   * @param listener - Runs with the app id of the installed DLC, inside a pump frame.
   * @returns Unsubscribe function. Calling it more than once is harmless.
   * @see install
   */
  onInstalled(listener: (appId: number) => void): () => void {
    return this.subscribe('DlcInstalled_t', (e) => listener(e.m_nAppID));
  }
}
