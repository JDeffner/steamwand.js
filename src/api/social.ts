import { out } from '../runtime/out';
import type { ISteamFriends } from '../generated/interfaces/ISteamFriends';
import type { ISteamUtils } from '../generated/interfaces/ISteamUtils';
import type { SteamCallbackMap } from '../generated/callbacks';
import { EFriendFlags } from '../generated/enums';
import { must } from './guards';

/**
 * One entry of the local user's friend list.
 *
 * @see Social.listFriends
 */
export interface Friend {
  /** Steam id of the friend. 64-bit, so a `bigint`. */
  steamId: bigint;
  /** Persona name, or an empty string while Steam has not cached it yet. */
  name: string;
  /** EPersonaState (0 offline, 1 online, 2 busy, 3 away, 4 snooze, ...). */
  state: number;
  /** EFriendRelationship (0 none, 1 blocked, 3 friend, ...). */
  relationship: number;
}

/** Which of the three avatar sizes Steam keeps for a user. */
export type AvatarSize = 'small' | 'medium' | 'large';

/**
 * A decoded avatar image. 32x32 for `small`, 64x64 for `medium`, and 184x184
 * for `large`, but read the reported size instead of assuming it.
 *
 * @see Social.avatar
 */
export interface Avatar {
  /** Image width in pixels. */
  width: number;
  /** Image height in pixels. */
  height: number;
  /** Raw pixels, 4 bytes per pixel in RGBA order, `width * height * 4` bytes long. */
  rgba: Buffer;
}

/**
 * A friend's persona changed, as delivered to an `onPersonaStateChange` listener.
 *
 * @see Social.onPersonaStateChange
 */
export interface PersonaStateChange {
  /** The user whose persona changed. 64-bit, so a `bigint`. */
  steamId: bigint;
  /** EPersonaChange bit field: which parts changed (name, status, avatar, ...). */
  changeFlags: number;
}

/**
 * A friend asked to join this user's game through rich presence.
 *
 * @see Social.onGameRichPresenceJoinRequested
 */
export interface RichPresenceJoinRequest {
  /** The friend who sent the invite. 64-bit, so a `bigint`. */
  steamId: bigint;
  /** The value of that friend's `connect` rich presence key, max 256 bytes. */
  connect: string;
}

/**
 * A friend asked to join this user into a lobby, from the overlay or the
 * Steam client.
 *
 * @see Social.onGameLobbyJoinRequested
 */
export interface LobbyJoinRequest {
  /** Lobby to pass to `steam.lobbies.join`. 64-bit, so a `bigint`. */
  lobbyId: bigint;
  /** The friend who invited, or a clan id when the invite came from a group. */
  steamId: bigint;
}

/**
 * Task level wrapper over ISteamFriends: the local persona, the friend list,
 * avatars, and rich presence.
 *
 * Everything here except the avatar pixels is a local read against the Steam
 * client, so it needs no round trip. The client only caches persona data for
 * users it has a reason to know about: for anybody else, call
 * `requestUserInformation` first and read again on the next
 * `onPersonaStateChange`. Reach it as `steam.social`, since the generated
 * interface already owns `steam.friends`.
 *
 * The overlay calls of the same interface live in `steam.overlay`; clans,
 * chat, and coplay stay on the generated `steam.friends`.
 *
 * @see Steam.social
 * @see Overlay
 */
export class Social {
  /**
   * @param friends - The ISteamFriends interface.
   * @param utils - The ISteamUtils interface, used to decode avatar handles into pixels.
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
   * Reads the local user's persona name.
   *
   * @returns The display name shown to other players.
   * @example
   * ```ts
   * import { init } from 'steamwand.js';
   *
   * const steam = init({ appId: 480 });
   * console.log(steam.social.personaName());
   * steam.close();
   * ```
   * @see personaState
   */
  personaName(): string {
    return this.friends.GetPersonaName();
  }

  /**
   * Reads the local user's online state.
   *
   * @returns EPersonaState (0 offline, 1 online, 2 busy, 3 away, 4 snooze, 7 invisible).
   * @see personaName
   */
  personaState(): number {
    return this.friends.GetPersonaState();
  }

  /**
   * Lists the local user's friends with their names and states.
   *
   * Steam decides what a "friend" is through the flags: the default takes
   * everything the client knows about, including blocked users and clan
   * members. Pass `flat.EFriendFlags.k_EFriendFlagImmediate` for the plain
   * friend list.
   *
   * @param flags - EFriendFlags bit field.
   * @defaultValue `EFriendFlags.k_EFriendFlagAll`
   * @returns One entry per match, in Steam's order. Empty if nothing matches the flags.
   * @example
   * ```ts
   * import { init, flat } from 'steamwand.js';
   *
   * const steam = init({ appId: 480 });
   * const online = steam.social
   *   .listFriends(flat.EFriendFlags.k_EFriendFlagImmediate)
   *   .filter((f) => f.state !== flat.EPersonaState.k_EPersonaStateOffline);
   * console.log(online.map((f) => f.name));
   * steam.close();
   * ```
   * @see friendName
   * @see friendState
   */
  listFriends(flags: number = EFriendFlags.k_EFriendFlagAll): Friend[] {
    const count = this.friends.GetFriendCount(flags);
    const list: Friend[] = [];
    for (let i = 0; i < count; i++) {
      const steamId = this.friends.GetFriendByIndex(i, flags);
      list.push({
        steamId,
        name: this.friends.GetFriendPersonaName(steamId),
        state: this.friends.GetFriendPersonaState(steamId),
        relationship: this.friends.GetFriendRelationship(steamId),
      });
    }
    return list;
  }

  /**
   * Reads one user's persona name.
   *
   * @param steamId - User to read. 64-bit, so a `bigint`.
   * @returns The persona name, or an empty string if the client has no data for that user yet.
   * @see requestUserInformation
   */
  friendName(steamId: bigint): string {
    return this.friends.GetFriendPersonaName(steamId);
  }

  /**
   * Reads one user's online state.
   *
   * @param steamId - User to read. 64-bit, so a `bigint`.
   * @returns EPersonaState. Offline (0) for a user the client has no data for.
   * @see requestUserInformation
   */
  friendState(steamId: bigint): number {
    return this.friends.GetFriendPersonaState(steamId);
  }

  /**
   * Asks Steam to fetch persona data for a user who is not a friend.
   *
   * The data arrives asynchronously. Subscribe with `onPersonaStateChange`
   * and read `friendName`, `friendState`, or `avatar` again from the listener.
   *
   * @param steamId - User to fetch. 64-bit, so a `bigint`.
   * @param nameOnly - True to fetch only the name and avatar, which is faster. False also fetches the full persona.
   * @defaultValue `false`
   * @returns True if Steam started a fetch. False means the data was already cached, so no callback follows.
   * @example
   * ```ts
   * import { init } from 'steamwand.js';
   *
   * const steam = init({ appId: 480 });
   * const other = 76561197960287930n;
   * if (steam.social.requestUserInformation(other, true)) {
   *   steam.social.onPersonaStateChange((e) => {
   *     if (e.steamId === other) console.log(steam.social.friendName(other));
   *   });
   * }
   * ```
   * @see onPersonaStateChange
   */
  requestUserInformation(steamId: bigint, nameOnly = false): boolean {
    return this.friends.RequestUserInformation(steamId, nameOnly);
  }

  /**
   * Subscribes to persona changes of any user the client tracks.
   *
   * This fires often and for many users, the local one included, so filter on
   * the Steam id before doing work.
   *
   * @param listener - Runs on every `PersonaStateChange_t`, inside a pump frame.
   * @returns Unsubscribe function. Calling it more than once is harmless.
   * @see requestUserInformation
   */
  onPersonaStateChange(listener: (change: PersonaStateChange) => void): () => void {
    return this.subscribe('PersonaStateChange_t', (e) => {
      listener({ steamId: e.m_ulSteamID, changeFlags: e.m_nChangeFlags });
    });
  }

  /**
   * Reads a user's avatar as raw pixels.
   *
   * Steam hands out an image handle first and loads the pixels afterwards, so
   * the first call for a user Steam has not cached returns null. Subscribe to
   * `AvatarImageLoaded_t` through `steam.on` and call this again from the
   * listener; for a non-friend, call `requestUserInformation` first to start
   * the fetch at all.
   *
   * @param steamId - User to read. 64-bit, so a `bigint`.
   * @param size - Which of the three cached sizes to read.
   * @defaultValue `'medium'`
   * @returns The image, or null while Steam has no loaded avatar for that user.
   * @throws Error if Steam refuses the image handle it just handed out.
   * @example
   * ```ts
   * import { init } from 'steamwand.js';
   *
   * const steam = init({ appId: 480 });
   * const me = steam.steamId();
   * const off = steam.on('AvatarImageLoaded_t', (e) => {
   *   if (e.m_steamID !== me) return;
   *   const a = steam.social.avatar(me, 'large');
   *   if (a) console.log(a.width, a.height, a.rgba.length);
   *   off();
   * });
   * ```
   * @see requestUserInformation
   */
  avatar(steamId: bigint, size: AvatarSize = 'medium'): Avatar | null {
    const handle =
      size === 'small'
        ? this.friends.GetSmallFriendAvatar(steamId)
        : size === 'large'
          ? this.friends.GetLargeFriendAvatar(steamId)
          : this.friends.GetMediumFriendAvatar(steamId);
    // 0 means the user has no avatar, -1 means Steam is still loading one.
    if (handle <= 0) return null;

    const width = out.uint32();
    const height = out.uint32();
    must('GetImageSize', this.utils.GetImageSize(handle, width.buffer, height.buffer));
    const rgba = Buffer.alloc(width.value * height.value * 4);
    must('GetImageRGBA', this.utils.GetImageRGBA(handle, rgba, rgba.length));
    return { width: width.value, height: height.value, rgba };
  }

  /**
   * Sets one rich presence key on the local user.
   *
   * Friends read it with `getRichPresence`, and Steam shows the value of the
   * `status` key in the friend list. The `connect` key is the one Steam turns
   * into a "Join game" option, which arrives back as
   * `onGameRichPresenceJoinRequested` on the other side. Steam allows 20 keys,
   * 64 bytes per key and 256 bytes per value.
   *
   * @param key - Rich presence key, max 64 UTF-8 bytes.
   * @param value - Value, max 256 UTF-8 bytes. An empty string removes the key.
   * @throws Error if the key or value is too long, or the 20 key limit is reached.
   * @example
   * ```ts
   * import { init } from 'steamwand.js';
   *
   * const steam = init({ appId: 480 });
   * steam.social.setRichPresence('status', 'In the lobby');
   * steam.social.setRichPresence('connect', '+connect_lobby 109775242724');
   * steam.close();
   * ```
   * @see clearRichPresence
   * @see getRichPresence
   */
  setRichPresence(key: string, value: string): void {
    must('SetRichPresence', this.friends.SetRichPresence(key, value));
  }

  /**
   * Removes every rich presence key of the local user.
   *
   * Steam has no result for this, so it cannot fail from here.
   *
   * @see setRichPresence
   */
  clearRichPresence(): void {
    this.friends.ClearRichPresence();
  }

  /**
   * Reads one rich presence key of a friend.
   *
   * Only friends running the same app have rich presence, and only after the
   * client has it cached: pass the local Steam id to read back what
   * `setRichPresence` wrote.
   *
   * @param steamId - User to read. 64-bit, so a `bigint`.
   * @param key - Rich presence key.
   * @returns The value, or an empty string if the key is unset or the user is not cached.
   * @see listRichPresence
   * @see setRichPresence
   */
  getRichPresence(steamId: bigint, key: string): string {
    return this.friends.GetFriendRichPresence(steamId, key);
  }

  /**
   * Reads every rich presence key and value of a friend.
   *
   * @param steamId - User to read. 64-bit, so a `bigint`.
   * @returns Key to value, on a null-prototype object so a key named `toString` is safe. Empty if the user has no rich presence.
   * @see getRichPresence
   */
  listRichPresence(steamId: bigint): Record<string, string> {
    const count = this.friends.GetFriendRichPresenceKeyCount(steamId);
    const data: Record<string, string> = Object.create(null);
    for (let i = 0; i < count; i++) {
      const key = this.friends.GetFriendRichPresenceKeyByIndex(steamId, i);
      if (!key) continue;
      data[key] = this.friends.GetFriendRichPresence(steamId, key);
    }
    return data;
  }

  /**
   * Subscribes to rich presence join requests.
   *
   * Fires when a friend clicks "Join game" and this app is already running.
   * The connect string is whatever that friend put in their `connect` rich
   * presence key. When the app is not running, Steam passes the same string on
   * the command line as `+connect <value>` instead.
   *
   * @param listener - Runs on every `GameRichPresenceJoinRequested_t`, inside a pump frame.
   * @returns Unsubscribe function. Calling it more than once is harmless.
   * @see setRichPresence
   */
  onGameRichPresenceJoinRequested(listener: (request: RichPresenceJoinRequest) => void): () => void {
    return this.subscribe('GameRichPresenceJoinRequested_t', (e) => {
      listener({ steamId: e.m_steamIDFriend, connect: e.m_rgchConnect });
    });
  }

  /**
   * Subscribes to lobby join requests.
   *
   * Fires when the user accepts a lobby invite while this app is running. Pass
   * the lobby id straight to `steam.lobbies.join`.
   *
   * @param listener - Runs on every `GameLobbyJoinRequested_t`, inside a pump frame.
   * @returns Unsubscribe function. Calling it more than once is harmless.
   * @example
   * ```ts
   * import { init } from 'steamwand.js';
   *
   * const steam = init({ appId: 480 });
   * steam.social.onGameLobbyJoinRequested(async (r) => {
   *   await steam.lobbies.join(r.lobbyId);
   * });
   * ```
   * @see Lobbies.join
   */
  onGameLobbyJoinRequested(listener: (request: LobbyJoinRequest) => void): () => void {
    return this.subscribe('GameLobbyJoinRequested_t', (e) => {
      listener({ lobbyId: e.m_steamIDLobby, steamId: e.m_steamIDFriend });
    });
  }
}
