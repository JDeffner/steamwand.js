import { out } from '../runtime/out';
import type { ISteamApps } from '../generated/interfaces/ISteamApps';

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
 * Task level wrapper over ISteamApps: the DLC list, which is the one call in
 * that interface with an index loop and three out-buffers.
 *
 * Everything else on ISteamApps is a one-line read, so it stays on the
 * generated `steam.apps`. Reach this as `steam.dlc`, since the generated
 * interface already owns `steam.apps`.
 *
 * @see Steam.dlc
 */
export class Apps {
  /**
   * @param apps - The ISteamApps interface.
   */
  constructor(private readonly apps: ISteamApps) {}

  /**
   * Lists the DLC of the running app.
   *
   * This is a local read against the Steam client, so it needs no round trip.
   * The list is what Steam knows about the app, not what the user owns: check
   * ownership with `steam.apps.BIsDlcInstalled` or `BIsSubscribedApp`.
   *
   * @returns One entry per DLC, in Steam's order. Empty if the app has none.
   * @example
   * ```ts
   * import { init } from 'steamwand.js';
   *
   * const steam = init({ appId: 480 });
   * for (const dlc of steam.dlc.listDlc()) {
   *   console.log(dlc.appId, dlc.name, steam.apps.BIsDlcInstalled(dlc.appId));
   * }
   * steam.close();
   * ```
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
}
