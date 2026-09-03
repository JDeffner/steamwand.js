import type { ISteamFriends } from '../generated/interfaces/ISteamFriends';
import type { ISteamUtils } from '../generated/interfaces/ISteamUtils';
import type { SteamCallbackMap } from '../generated/callbacks';
import { EActivateGameOverlayToWebPageMode, ENotificationPosition, EOverlayToStoreFlag } from '../generated/enums';

/**
 * A top level overlay dialog name, as Valve documents them for
 * `ActivateGameOverlay`. Any other string is passed through unchanged, so a
 * dialog Valve adds later still works.
 *
 * @see Overlay.activate
 */
export type OverlayDialog =
  | 'Friends'
  | 'Community'
  | 'Players'
  | 'Settings'
  | 'OfficialGameGroup'
  | 'Stats'
  | 'Achievements'
  | (string & {});

/**
 * A per-user overlay dialog name, as Valve documents them for
 * `ActivateGameOverlayToUser`. Any other string is passed through unchanged.
 *
 * @see Overlay.activateToUser
 */
export type OverlayUserDialog =
  | 'steamid'
  | 'chat'
  | 'jointrade'
  | 'stats'
  | 'achievements'
  | 'friendadd'
  | 'friendremove'
  | 'friendrequestaccept'
  | 'friendrequestignore'
  | (string & {});

/**
 * The Steam overlay opened or closed, as delivered to an `onActivated`
 * listener.
 *
 * @see Overlay.onActivated
 */
export interface OverlayActivation {
  /** True when the overlay just opened, false when it just closed. */
  active: boolean;
}

/**
 * Task level wrapper over the Steam overlay: open its dialogs, place its
 * notifications, and know when it is up.
 *
 * Every `activate` method is fire and forget: Steam has no result for them, so
 * a call with a bad dialog name or a disabled overlay does nothing and reports
 * nothing. Check `isEnabled` first if that matters. Pause the game from
 * `onActivated`, since the overlay takes input focus while it is open. Reach
 * this as `steam.overlay`, since the generated interfaces already own
 * `steam.friends` and `steam.utils`.
 *
 * @see Steam.overlay
 * @see Social
 */
export class Overlay {
  /**
   * @param friends - The ISteamFriends interface, which owns the activate calls.
   * @param utils - The ISteamUtils interface, which owns the enabled flag and the notification placement.
   * @param subscribe - Callback subscriber, normally `steam.on` bound to the session.
   */
  constructor(
    private readonly friends: ISteamFriends,
    private readonly utils: ISteamUtils,
    private readonly subscribe: <K extends keyof SteamCallbackMap & string>(
      name: K,
      listener: (data: SteamCallbackMap[K]) => void,
    ) => () => void,
  ) {}

  /**
   * Reads whether the overlay is loaded and ready.
   *
   * False until the overlay has hooked the process, and permanently false when
   * the user turned it off or the app runs outside Steam. This is the only
   * honest way to tell whether the `activate` calls will do anything.
   *
   * @returns True if the overlay can be opened right now.
   * @example
   * ```ts
   * import { init } from 'steamwand.js';
   *
   * const steam = init({ appId: 480 });
   * if (steam.overlay.isEnabled()) steam.overlay.activate('Friends');
   * steam.close();
   * ```
   */
  isEnabled(): boolean {
    return this.utils.IsOverlayEnabled();
  }

  /**
   * Opens a top level overlay dialog.
   *
   * @param dialog - Dialog name, for example `Friends` or `Achievements`.
   * @see activateToUser
   * @see isEnabled
   */
  activate(dialog: OverlayDialog): void {
    this.friends.ActivateGameOverlay(dialog);
  }

  /**
   * Opens an overlay dialog about one user, for example their profile or a
   * chat window.
   *
   * @param dialog - Dialog name, for example `steamid` for the profile or `chat` to start a conversation.
   * @param steamId - User, clan, or lobby the dialog is about. 64-bit, so a `bigint`.
   * @example
   * ```ts
   * import { init } from 'steamwand.js';
   *
   * const steam = init({ appId: 480 });
   * const [friend] = steam.social.listFriends();
   * if (friend) steam.overlay.activateToUser('steamid', friend.steamId);
   * ```
   * @see activate
   */
  activateToUser(dialog: OverlayUserDialog, steamId: bigint): void {
    this.friends.ActivateGameOverlayToUser(dialog, steamId);
  }

  /**
   * Opens a web page in the overlay browser.
   *
   * @param url - Full URL including the protocol.
   * @param modal - True to open a stripped browser window that the user must close before returning to the game.
   * @defaultValue `false`
   * @see activateToStore
   */
  activateToWebPage(url: string, modal = false): void {
    this.friends.ActivateGameOverlayToWebPage(
      url,
      modal
        ? EActivateGameOverlayToWebPageMode.k_EActivateGameOverlayToWebPageMode_Modal
        : EActivateGameOverlayToWebPageMode.k_EActivateGameOverlayToWebPageMode_Default,
    );
  }

  /**
   * Opens a store page in the overlay.
   *
   * @param appId - App id to show. Pass 0 with the cart flags to show the cart itself.
   * @param flag - EOverlayToStoreFlag (0 just show the page, 1 add to cart, 2 add to cart and show it).
   * @defaultValue `EOverlayToStoreFlag.k_EOverlayToStoreFlag_None`
   * @see activateToWebPage
   */
  activateToStore(appId: number, flag: number = EOverlayToStoreFlag.k_EOverlayToStoreFlag_None): void {
    this.friends.ActivateGameOverlayToStore(appId, flag);
  }

  /**
   * Opens the invite dialog for a lobby, so the user can pick friends to
   * invite.
   *
   * The user must already be in that lobby. Invitees get a
   * `GameLobbyJoinRequested_t` callback when they accept, which
   * `steam.social.onGameLobbyJoinRequested` delivers.
   *
   * @param lobbyId - Lobby to invite to. 64-bit, so a `bigint`.
   * @see Social.onGameLobbyJoinRequested
   */
  activateInviteDialog(lobbyId: bigint): void {
    this.friends.ActivateGameOverlayInviteDialog(lobbyId);
  }

  /**
   * Opens the invite dialog for a game that has no lobby, using a plain
   * connect string.
   *
   * Invitees get the string back as `steam.social.onGameRichPresenceJoinRequested`
   * when the app is running, or as `+connect <string>` on the command line
   * when it is not.
   *
   * @param connect - Connect string, max 256 UTF-8 bytes. Whatever your game needs to join, for example a server address.
   * @see Social.onGameRichPresenceJoinRequested
   */
  activateInviteDialogConnectString(connect: string): void {
    this.friends.ActivateGameOverlayInviteDialogConnectString(connect);
  }

  /**
   * Moves the overlay notifications (achievement popups, chat toasts) to one
   * corner of the screen.
   *
   * @param position - ENotificationPosition (0 top left, 1 top right, 2 bottom left, 3 bottom right).
   * @defaultValue `ENotificationPosition.k_EPositionBottomRight`
   * @example
   * ```ts
   * import { init, flat } from 'steamwand.js';
   *
   * const steam = init({ appId: 480 });
   * steam.overlay.setNotificationPosition(flat.ENotificationPosition.k_EPositionTopLeft);
   * steam.close();
   * ```
   * @see setNotificationInset
   */
  setNotificationPosition(position: number = ENotificationPosition.k_EPositionBottomRight): void {
    this.utils.SetOverlayNotificationPosition(position);
  }

  /**
   * Pushes the overlay notifications away from the edges of their corner.
   *
   * Use it to keep the popups clear of your own HUD. The inset applies to the
   * corner set by `setNotificationPosition`, so set the position first.
   *
   * @param x - Horizontal inset in pixels.
   * @param y - Vertical inset in pixels.
   * @see setNotificationPosition
   */
  setNotificationInset(x: number, y: number): void {
    this.utils.SetOverlayNotificationInset(x, y);
  }

  /**
   * Subscribes to the overlay opening and closing.
   *
   * This is where a single player game pauses itself: the overlay takes input
   * focus for as long as it is open.
   *
   * @param listener - Runs on every `GameOverlayActivated_t`, inside a pump frame.
   * @returns Unsubscribe function. Calling it more than once is harmless.
   * @example
   * ```ts
   * import { init } from 'steamwand.js';
   *
   * const steam = init({ appId: 480 });
   * const off = steam.overlay.onActivated((e) => {
   *   console.log(e.active ? 'paused' : 'resumed');
   * });
   * // later: off();
   * ```
   */
  onActivated(listener: (event: OverlayActivation) => void): () => void {
    return this.subscribe('GameOverlayActivated_t', (e) => {
      listener({ active: e.m_bActive !== 0 });
    });
  }
}
