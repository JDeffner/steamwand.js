import type { SteamDispatch } from '../runtime/dispatch';
import { out } from '../runtime/out';
import type { ISteamMatchmaking } from '../generated/interfaces/ISteamMatchmaking';
import type { SteamCallbackMap } from '../generated/callbacks';
import { layoutOf } from '../generated/structs';
import type { LobbyCreated_t, LobbyEnter_t, LobbyMatchList_t } from '../generated/structs';
import { EChatRoomEnterResponse, ELobbyComparison } from '../generated/enums';
import { callbackIdByName } from '../generated/callbacks';
import { ok, must } from './guards';

/** Steam caps a lobby data key at 255 bytes, so this buffer always holds one. */
const KEY_BYTES = 256;
/** Steam caps a lobby data value at 8192 bytes, so this buffer always holds one. */
const VALUE_BYTES = 8192;
/** Steam caps a lobby chat message at 4096 bytes, so this buffer always holds one. */
const CHAT_BYTES = 4096;

const ENTER_RESPONSE_NAMES = new Map<number, string>(
  Object.entries(EChatRoomEnterResponse).map(([k, v]) => [v as number, k]),
);

/**
 * Filters for one lobby search.
 *
 * Steam keeps filters on the client until the next `RequestLobbyList`, so
 * every field here applies to that one request and to nothing after it.
 *
 * @see Lobbies.list
 */
export interface LobbySearchOptions {
  /** Lobby data keys that must equal these values. Compared as strings. */
  stringFilters?: Record<string, string>;
  /** Lobby data keys that must equal these numbers. Compared as 32-bit integers. */
  numberFilters?: Record<string, number>;
  /** Only lobbies with at least this many open slots. */
  slotsAvailable?: number;
  /** ELobbyDistanceFilter (0 close, 1 default, 2 far, 3 worldwide). */
  distance?: number;
  /** Stop searching after this many matches. Steam returns at most 50 either way. */
  maxResults?: number;
}

/**
 * One lobby chat message, as delivered to an `onChat` listener.
 *
 * @see Lobbies.onChat
 */
export interface LobbyChatMessage {
  /** Steam id of the member who sent it. 64-bit, so a `bigint`. */
  senderSteamId: bigint;
  /** The message text, decoded as UTF-8. */
  message: string;
}

/**
 * Task level wrapper over ISteamMatchmaking: create, join, and search lobbies,
 * read and write lobby data, and send lobby chat.
 *
 * The async methods await their call result through the dispatch and turn a
 * refusal into a `SteamResultError`. The synchronous methods read the local
 * lobby cache, which only holds lobbies this user is in or has just found, and
 * throw a plain `Error` when Steam rejects the handle. Reach it as
 * `steam.lobbies`.
 *
 * @see Steam.lobbies
 * @see SteamResultError
 */
export class Lobbies {
  /**
   * @param matchmaking - The ISteamMatchmaking interface.
   * @param dispatch - Running pump that resolves the call results.
   * @param subscribe - Callback subscriber, normally `steam.on` bound to the session.
   */
  constructor(
    private readonly matchmaking: ISteamMatchmaking,
    private readonly dispatch: SteamDispatch,
    private readonly subscribe: <K extends keyof SteamCallbackMap & string>(
      name: K,
      listener: (data: SteamCallbackMap[K]) => void,
    ) => () => void,
  ) {}

  /**
   * Creates a lobby and joins it, then returns its id.
   *
   * The caller becomes the owner. A lobby with no members left is destroyed by
   * Steam, so a lobby only outlives the process if somebody else joined it.
   *
   * @param type - ELobbyType (0 private, 1 friends-only, 2 public, 3 invisible, 4 private unique).
   * @param maxMembers - Member limit, including the owner. Steam allows at most 250.
   * @returns The new lobby id. 64-bit, so a `bigint`.
   * @throws SteamResultError if Steam refused the call, for example with `k_EResultLimitExceeded`.
   * @throws SteamApiCallError if the call could not be completed.
   * @example
   * ```ts
   * import { init, flat } from 'steamwand.js';
   *
   * const steam = init({ appId: 480 });
   * const lobbyId = await steam.lobbies.create(flat.ELobbyType.k_ELobbyTypePublic, 4);
   * steam.lobbies.setData(lobbyId, 'map', 'de_dust2');
   * steam.close();
   * ```
   * @see join
   * @see leave
   */
  async create(type: number, maxMembers: number): Promise<bigint> {
    const call = this.matchmaking.CreateLobby(type, maxMembers);
    const r = await this.dispatch.callResultStruct<LobbyCreated_t>(
      call,
      layoutOf('LobbyCreated_t'),
      callbackIdByName.LobbyCreated_t,
    );
    ok('CreateLobby', r.m_eResult);
    return r.m_ulSteamIDLobby;
  }

  /**
   * Joins an existing lobby.
   *
   * On success the lobby data and the member list are in the local cache, so
   * `getData`, `listData`, and `getMembers` work right after this resolves.
   *
   * @param lobbyId - Lobby to join. 64-bit, so a `bigint`.
   * @throws Error if Steam let the user in nowhere, for example because the lobby is full or does not exist. The message names the `EChatRoomEnterResponse`.
   * @throws SteamApiCallError if the call could not be completed.
   * @example
   * ```ts
   * import { init } from 'steamwand.js';
   *
   * const steam = init({ appId: 480 });
   * const [first] = await steam.lobbies.list({ slotsAvailable: 1 });
   * if (first) {
   *   await steam.lobbies.join(first);
   *   console.log(steam.lobbies.getMembers(first));
   * }
   * steam.close();
   * ```
   * @see create
   * @see leave
   */
  async join(lobbyId: bigint): Promise<void> {
    const call = this.matchmaking.JoinLobby(lobbyId);
    const r = await this.dispatch.callResultStruct<LobbyEnter_t>(
      call,
      layoutOf('LobbyEnter_t'),
      callbackIdByName.LobbyEnter_t,
    );
    const response = r.m_EChatRoomEnterResponse;
    if (response !== EChatRoomEnterResponse.k_EChatRoomEnterResponseSuccess) {
      const name = ENTER_RESPONSE_NAMES.get(response) ?? `EChatRoomEnterResponse(${response})`;
      throw new Error(`steamwand: JoinLobby failed: ${name}`);
    }
  }

  /**
   * Leaves a lobby.
   *
   * Steam has no result for this, so it cannot fail from here. Leaving as the
   * last member destroys the lobby; leaving as the owner hands ownership to
   * another member.
   *
   * @param lobbyId - Lobby to leave. 64-bit, so a `bigint`.
   * @see join
   */
  leave(lobbyId: bigint): void {
    this.matchmaking.LeaveLobby(lobbyId);
  }

  /**
   * Lists the Steam ids of every member currently in a lobby.
   *
   * Reads the local cache, so it only answers for a lobby this user is in.
   *
   * @param lobbyId - Lobby to read. 64-bit, so a `bigint`.
   * @returns The member Steam ids, owner included. Empty if the user is not in that lobby.
   * @see getOwner
   */
  getMembers(lobbyId: bigint): bigint[] {
    const count = this.matchmaking.GetNumLobbyMembers(lobbyId);
    const members: bigint[] = [];
    for (let i = 0; i < count; i++) members.push(this.matchmaking.GetLobbyMemberByIndex(lobbyId, i));
    return members;
  }

  /**
   * Reads the Steam id of the lobby owner.
   *
   * @param lobbyId - Lobby to read. 64-bit, so a `bigint`.
   * @returns The owner's Steam id, or `0n` if the user is not in that lobby.
   * @see setOwner
   */
  getOwner(lobbyId: bigint): bigint {
    return this.matchmaking.GetLobbyOwner(lobbyId);
  }

  /**
   * Hands ownership of a lobby to another member.
   *
   * Only the current owner may do this, and the new owner must already be in
   * the lobby.
   *
   * @param lobbyId - Lobby to change. 64-bit, so a `bigint`.
   * @param steamId - Member to make owner. 64-bit, so a `bigint`.
   * @throws Error if the user is not the owner, or the target is not a member.
   * @see getOwner
   */
  setOwner(lobbyId: bigint, steamId: bigint): void {
    must('SetLobbyOwner', this.matchmaking.SetLobbyOwner(lobbyId, steamId));
  }

  /**
   * Reads the member limit of a lobby.
   *
   * @param lobbyId - Lobby to read. 64-bit, so a `bigint`.
   * @returns The limit, or 0 if the lobby is not in the local cache.
   * @see setMemberLimit
   */
  getMemberLimit(lobbyId: bigint): number {
    return this.matchmaking.GetLobbyMemberLimit(lobbyId);
  }

  /**
   * Changes the member limit of a lobby.
   *
   * Only the owner may do this. Search results reflect the new limit after the
   * next `list`.
   *
   * @param lobbyId - Lobby to change. 64-bit, so a `bigint`.
   * @param maxMembers - New limit, including the owner. Steam allows at most 250.
   * @throws Error if the user is not the owner of that lobby.
   * @see getMemberLimit
   */
  setMemberLimit(lobbyId: bigint, maxMembers: number): void {
    must('SetLobbyMemberLimit', this.matchmaking.SetLobbyMemberLimit(lobbyId, maxMembers));
  }

  /**
   * Invites a user to a lobby.
   *
   * The invitee gets a `GameLobbyJoinRequested_t` callback when they accept,
   * carrying the lobby id to pass to `join`.
   *
   * @param lobbyId - Lobby to invite to. 64-bit, so a `bigint`.
   * @param steamId - User to invite. 64-bit, so a `bigint`.
   * @throws Error if the user is not in that lobby, or the invitee id is invalid.
   */
  inviteUser(lobbyId: bigint, steamId: bigint): void {
    must('InviteUserToLobby', this.matchmaking.InviteUserToLobby(lobbyId, steamId));
  }

  /**
   * Reads one lobby data value.
   *
   * @param lobbyId - Lobby to read. 64-bit, so a `bigint`.
   * @param key - Data key, max 255 UTF-8 bytes.
   * @returns The value, or an empty string if the key is unset or the lobby is not cached.
   * @see setData
   * @see listData
   */
  getData(lobbyId: bigint, key: string): string {
    return this.matchmaking.GetLobbyData(lobbyId, key);
  }

  /**
   * Writes one lobby data value.
   *
   * Only the owner may do this. Every member gets a `LobbyDataUpdate_t`
   * callback, and lobby data is what `list` filters on.
   *
   * @param lobbyId - Lobby to change. 64-bit, so a `bigint`.
   * @param key - Data key, max 255 UTF-8 bytes.
   * @param value - Data value, max 8192 UTF-8 bytes.
   * @throws Error if the user is not the owner, or the key is too long.
   * @see getData
   * @see deleteData
   */
  setData(lobbyId: bigint, key: string, value: string): void {
    must('SetLobbyData', this.matchmaking.SetLobbyData(lobbyId, key, value));
  }

  /**
   * Removes one lobby data key.
   *
   * Only the owner may do this.
   *
   * @param lobbyId - Lobby to change. 64-bit, so a `bigint`.
   * @param key - Data key to remove.
   * @throws Error if the user is not the owner, or the key was not set.
   * @see setData
   */
  deleteData(lobbyId: bigint, key: string): void {
    must('DeleteLobbyData', this.matchmaking.DeleteLobbyData(lobbyId, key));
  }

  /**
   * Reads every lobby data key and value.
   *
   * @param lobbyId - Lobby to read. 64-bit, so a `bigint`.
   * @returns Key to value. Empty if the lobby is not in the local cache. Keys
   * are case-insensitive on Steam's side and may come back recased (`Map` for
   * a key set as `map`); `getData` with the original key still works.
   * @example
   * ```ts
   * import { init } from 'steamwand.js';
   *
   * const steam = init({ appId: 480 });
   * const lobbyId = await steam.lobbies.create(2, 4);
   * steam.lobbies.setData(lobbyId, 'map', 'de_dust2');
   * console.log(steam.lobbies.listData(lobbyId)); // { map: 'de_dust2' }
   * steam.close();
   * ```
   * @see getData
   */
  listData(lobbyId: bigint): Record<string, string> {
    const count = this.matchmaking.GetLobbyDataCount(lobbyId);
    const key = out.string(KEY_BYTES);
    const value = out.string(VALUE_BYTES);
    // A prototype-free object, so a lobby key named __proto__ or constructor
    // stays a normal entry instead of touching the prototype chain.
    const data: Record<string, string> = Object.create(null);
    for (let i = 0; i < count; i++) {
      if (!this.matchmaking.GetLobbyDataByIndex(lobbyId, i, key.buffer, KEY_BYTES, value.buffer, VALUE_BYTES)) continue;
      data[key.value] = value.value;
    }
    return data;
  }

  /**
   * Reads one data value a member set on themselves.
   *
   * @param lobbyId - Lobby the member is in. 64-bit, so a `bigint`.
   * @param steamId - Member to read. 64-bit, so a `bigint`.
   * @param key - Data key.
   * @returns The value, or an empty string if the key is unset.
   * @see setMemberData
   */
  getMemberData(lobbyId: bigint, steamId: bigint, key: string): string {
    return this.matchmaking.GetLobbyMemberData(lobbyId, steamId, key);
  }

  /**
   * Writes one data value on this user's own lobby membership.
   *
   * A member can only write their own data, which is why there is no Steam id
   * parameter. Every member gets a `LobbyDataUpdate_t` callback. Steam has no
   * result for this, so it cannot fail from here.
   *
   * @param lobbyId - Lobby the user is in. 64-bit, so a `bigint`.
   * @param key - Data key, max 255 UTF-8 bytes.
   * @param value - Data value, max 8192 UTF-8 bytes.
   * @see getMemberData
   */
  setMemberData(lobbyId: bigint, key: string, value: string): void {
    this.matchmaking.SetLobbyMemberData(lobbyId, key, value);
  }

  /**
   * Sends a chat message to every member of a lobby, this user included.
   *
   * The text goes out as UTF-8 with a terminating NUL, which is what `onChat`
   * and Valve's own samples expect.
   *
   * @param lobbyId - Lobby to send to. 64-bit, so a `bigint`.
   * @param message - The text, max 4096 UTF-8 bytes including the terminator.
   * @throws Error if the user is not in that lobby, or the message is too long.
   * @see onChat
   */
  sendChat(lobbyId: bigint, message: string): void {
    const body = Buffer.from(`${message}\0`, 'utf8');
    must('SendLobbyChatMsg', this.matchmaking.SendLobbyChatMsg(lobbyId, body, body.length));
  }

  /**
   * Subscribes to the chat of one lobby.
   *
   * Messages for other lobbies are ignored, so one listener per lobby is
   * enough. The payload is not in the callback: it is fetched with
   * `GetLobbyChatEntry` inside the pump frame, before Steam drops it.
   *
   * @param lobbyId - Lobby to listen to. 64-bit, so a `bigint`.
   * @param listener - Runs on every message in that lobby, this user's own included.
   * @returns Unsubscribe function. Calling it more than once is harmless.
   * @example
   * ```ts
   * import { init } from 'steamwand.js';
   *
   * const steam = init({ appId: 480 });
   * const lobbyId = await steam.lobbies.create(2, 4);
   * const off = steam.lobbies.onChat(lobbyId, (m) => console.log(m.senderSteamId, m.message));
   * steam.lobbies.sendChat(lobbyId, 'hello');
   * // later: off();
   * ```
   * @see sendChat
   */
  onChat(lobbyId: bigint, listener: (message: LobbyChatMessage) => void): () => void {
    const sender = out.uint64();
    const entryType = out.int32();
    const body = Buffer.alloc(CHAT_BYTES);
    return this.subscribe('LobbyChatMsg_t', (e) => {
      if (e.m_ulSteamIDLobby !== lobbyId) return;
      const size = this.matchmaking.GetLobbyChatEntry(
        lobbyId,
        e.m_iChatID,
        sender.buffer,
        body,
        CHAT_BYTES,
        entryType.buffer,
      );
      if (size <= 0) return;
      // Senders terminate the body; drop that NUL so the text round trips.
      const end = body[size - 1] === 0 ? size - 1 : size;
      listener({ senderSteamId: sender.value, message: body.toString('utf8', 0, end) });
    });
  }

  /**
   * Searches for lobbies of this app and returns the matches.
   *
   * The filters in `opts` are applied to this request only: Steam clears them
   * once the request goes out, so every call needs its own filters. A match is
   * in the local cache when this resolves, so `getData` and `getMemberLimit`
   * answer for it without joining.
   *
   * @param opts - Filters for this one request. Omit for an unfiltered search.
   * @returns The matching lobby ids, at most 50, best match first.
   * @throws SteamApiCallError if the call could not be completed.
   * @example
   * ```ts
   * import { init } from 'steamwand.js';
   *
   * const steam = init({ appId: 480 });
   * const ids = await steam.lobbies.list({
   *   stringFilters: { map: 'de_dust2' },
   *   slotsAvailable: 1,
   *   maxResults: 10,
   * });
   * console.log(ids.map((id) => steam.lobbies.getData(id, 'map')));
   * steam.close();
   * ```
   * @see join
   */
  async list(opts: LobbySearchOptions = {}): Promise<bigint[]> {
    for (const [key, value] of Object.entries(opts.stringFilters ?? {})) {
      this.matchmaking.AddRequestLobbyListStringFilter(key, value, ELobbyComparison.k_ELobbyComparisonEqual);
    }
    for (const [key, value] of Object.entries(opts.numberFilters ?? {})) {
      this.matchmaking.AddRequestLobbyListNumericalFilter(key, value, ELobbyComparison.k_ELobbyComparisonEqual);
    }
    if (opts.slotsAvailable !== undefined) this.matchmaking.AddRequestLobbyListFilterSlotsAvailable(opts.slotsAvailable);
    if (opts.distance !== undefined) this.matchmaking.AddRequestLobbyListDistanceFilter(opts.distance);
    if (opts.maxResults !== undefined) this.matchmaking.AddRequestLobbyListResultCountFilter(opts.maxResults);

    const call = this.matchmaking.RequestLobbyList();
    const r = await this.dispatch.callResultStruct<LobbyMatchList_t>(
      call,
      layoutOf('LobbyMatchList_t'),
      callbackIdByName.LobbyMatchList_t,
    );
    const lobbies: bigint[] = [];
    for (let i = 0; i < r.m_nLobbiesMatching; i++) lobbies.push(this.matchmaking.GetLobbyByIndex(i));
    return lobbies;
  }
}
