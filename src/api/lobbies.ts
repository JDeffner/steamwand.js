import type { SteamDispatch } from '../runtime/dispatch';
import { out } from '../runtime/out';
import type { ISteamMatchmaking } from '../generated/interfaces/ISteamMatchmaking';
import type { SteamCallbackMap } from '../generated/callbacks';
import { layoutOf } from '../generated/structs';
import type { LobbyCreated_t, LobbyEnter_t, LobbyMatchList_t } from '../generated/structs';
import { EChatMemberStateChange, EChatRoomEnterResponse, ELobbyComparison } from '../generated/enums';
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
 * The `EChatMemberStateChange` bits, in the order a listener sees them.
 *
 * Steam packs several bits into one callback, so one callback can mean both
 * "left" and "disconnected".
 */
const MEMBER_CHANGE_BITS = [
  [EChatMemberStateChange.k_EChatMemberStateChangeEntered, 'entered'],
  [EChatMemberStateChange.k_EChatMemberStateChangeLeft, 'left'],
  [EChatMemberStateChange.k_EChatMemberStateChangeDisconnected, 'disconnected'],
  [EChatMemberStateChange.k_EChatMemberStateChangeKicked, 'kicked'],
  [EChatMemberStateChange.k_EChatMemberStateChangeBanned, 'banned'],
] as const;

/** Turns `1.2.3.4` into the host-order uint32 Steam wants. A malformed part counts as 0. */
function ipToUint32(ip: string): number {
  const parts = ip.split('.');
  let value = 0;
  for (let i = 0; i < 4; i++) value = (value << 8) | ((Number(parts[i]) || 0) & 0xff);
  return value >>> 0;
}

/** Turns the host-order uint32 Steam reports back into `1.2.3.4`. */
function uint32ToIp(value: number): string {
  return [24, 16, 8, 0].map((shift) => (value >>> shift) & 0xff).join('.');
}

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
 * One membership change in a lobby, as delivered to an `onMemberChange` listener.
 *
 * @see Lobbies.onMemberChange
 */
export interface LobbyMemberChange {
  /** Steam id of the member this happened to. 64-bit, so a `bigint`. */
  steamId: bigint;
  /** Steam id of whoever caused it. The same as `steamId` unless somebody was kicked or banned. 64-bit, so a `bigint`. */
  bySteamId: bigint;
  /** What happened, from the `EChatMemberStateChange` bit that was set. */
  change: 'entered' | 'left' | 'disconnected' | 'kicked' | 'banned';
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
   * @param once - Awaitable callback subscriber, normally `steam.once` bound to the session.
   */
  constructor(
    private readonly matchmaking: ISteamMatchmaking,
    private readonly dispatch: SteamDispatch,
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
   * Changes who may find and join a lobby.
   *
   * Only the owner may do this. `create` fixes the type once; this is how a
   * lobby goes from private to public after the party filled up, or the other
   * way round.
   *
   * @param lobbyId - Lobby to change. 64-bit, so a `bigint`.
   * @param type - ELobbyType (0 private, 1 friends-only, 2 public, 3 invisible, 4 private unique).
   * @throws Error if the user is not the owner of that lobby.
   * @example
   * ```ts
   * import { init, flat } from 'steamwand.js';
   *
   * const steam = init({ appId: 480 });
   * const lobbyId = await steam.lobbies.create(flat.ELobbyType.k_ELobbyTypePrivate, 4);
   * steam.lobbies.setType(lobbyId, flat.ELobbyType.k_ELobbyTypePublic);
   * steam.close();
   * ```
   * @see create
   * @see setJoinable
   */
  setType(lobbyId: bigint, type: number): void {
    must('SetLobbyType', this.matchmaking.SetLobbyType(lobbyId, type));
  }

  /**
   * Opens or closes a lobby to new members.
   *
   * Only the owner may do this. A lobby that is not joinable still shows up in
   * `list`, so close it when the match starts and open it again in the next
   * lobby screen.
   *
   * @param lobbyId - Lobby to change. 64-bit, so a `bigint`.
   * @param joinable - True to let people in, false to keep them out.
   * @throws Error if the user is not the owner of that lobby.
   * @see setType
   */
  setJoinable(lobbyId: bigint, joinable: boolean): void {
    must('SetLobbyJoinable', this.matchmaking.SetLobbyJoinable(lobbyId, joinable));
  }

  /**
   * Points a lobby at the game server its members should connect to.
   *
   * This is the handoff at the end of the lobby screen: the owner starts or
   * picks a server and records it here, and every member gets a
   * `LobbyGameCreated_t` callback carrying the same values. Steam has no result
   * for this, so it cannot fail from here.
   *
   * Give either a `steamId` (for a Steam game server) or an `ip` and `port`
   * (for a plain address), or all three. Anything left out is sent as 0, which
   * is what Steam reads as "not set".
   *
   * @param lobbyId - Lobby to change. 64-bit, so a `bigint`.
   * @param server - The server to record.
   * @param server.steamId - Steam id of the game server. 64-bit, so a `bigint`.
   * @param server.ip - IPv4 address in dotted-quad form, for example `192.168.0.10`.
   * @param server.port - Port the server listens on.
   * @example
   * ```ts
   * import { init } from 'steamwand.js';
   *
   * const steam = init({ appId: 480 });
   * const lobbyId = await steam.lobbies.create(2, 4);
   * steam.lobbies.setGameServer(lobbyId, { ip: '192.168.0.10', port: 27015 });
   * steam.close();
   * ```
   * @see getGameServer
   */
  setGameServer(lobbyId: bigint, server: { steamId?: bigint; ip?: string; port?: number }): void {
    this.matchmaking.SetLobbyGameServer(
      lobbyId,
      server.ip ? ipToUint32(server.ip) : 0,
      server.port ?? 0,
      server.steamId ?? 0n,
    );
  }

  /**
   * Reads the game server a lobby points at.
   *
   * @param lobbyId - Lobby to read. 64-bit, so a `bigint`.
   * @returns The recorded server, or null if the lobby has none yet. A field
   * the owner did not set reads back as `0n`, `0.0.0.0`, or 0.
   * @see setGameServer
   */
  getGameServer(lobbyId: bigint): { steamId: bigint; ip: string; port: number } | null {
    const ip = out.uint32();
    // Steam writes a uint16 here, and `out` has no uint16 factory.
    const port = Buffer.alloc(2);
    const steamId = out.uint64();
    if (!this.matchmaking.GetLobbyGameServer(lobbyId, ip.buffer, port, steamId.buffer)) return null;
    return { steamId: steamId.value, ip: uint32ToIp(ip.value), port: port.readUInt16LE(0) };
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
   * Pulls one lobby's data into the local cache without joining it.
   *
   * Needed for a lobby this user is not in and did not just find through
   * `list`, for example one that arrived in a `GameLobbyJoinRequested_t`
   * invite. Once this resolves, `getData` and `listData` answer for that lobby.
   *
   * @param lobbyId - Lobby to fetch. 64-bit, so a `bigint`.
   * @throws Error if Steam refused the request, or if the lobby no longer exists.
   * @example
   * ```ts
   * import { init } from 'steamwand.js';
   *
   * const steam = init({ appId: 480 });
   * steam.on('GameLobbyJoinRequested_t', async (e) => {
   *   await steam.lobbies.requestData(e.m_steamIDLobby);
   *   console.log(steam.lobbies.getData(e.m_steamIDLobby, 'map'));
   * });
   * ```
   * @see getData
   * @see onDataChange
   */
  async requestData(lobbyId: bigint): Promise<void> {
    must('RequestLobbyData', this.matchmaking.RequestLobbyData(lobbyId));
    // Steam answers with a LobbyDataUpdate_t whose member id equals the lobby
    // id, which is how it marks "the lobby's own data" rather than a member's.
    const r = await this.once(
      'LobbyDataUpdate_t',
      (e) => e.m_ulSteamIDLobby === lobbyId && e.m_ulSteamIDMember === lobbyId,
    );
    if (r.m_bSuccess === 0) throw new Error(`steamwand: RequestLobbyData failed: lobby ${lobbyId} no longer exists`);
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
   * Subscribes to the data changes of one lobby.
   *
   * The callback says only that something changed, not what, so read the new
   * values with `getData` or `listData` inside the listener. Updates for other
   * lobbies are ignored, so one listener per lobby is enough.
   *
   * @param lobbyId - Lobby to listen to. 64-bit, so a `bigint`.
   * @param listener - Runs on every change, with `memberSteamId` naming the member whose own data changed, or null when the lobby's data changed.
   * @returns Unsubscribe function. Calling it more than once is harmless.
   * @example
   * ```ts
   * import { init } from 'steamwand.js';
   *
   * const steam = init({ appId: 480 });
   * const lobbyId = await steam.lobbies.create(2, 4);
   * const off = steam.lobbies.onDataChange(lobbyId, ({ memberSteamId }) => {
   *   if (memberSteamId === null) console.log(steam.lobbies.listData(lobbyId));
   *   else console.log(steam.lobbies.getMemberData(lobbyId, memberSteamId, 'ready'));
   * });
   * // later: off();
   * ```
   * @see setData
   * @see setMemberData
   */
  onDataChange(lobbyId: bigint, listener: (change: { memberSteamId: bigint | null }) => void): () => void {
    return this.subscribe('LobbyDataUpdate_t', (e) => {
      if (e.m_ulSteamIDLobby !== lobbyId) return;
      // Steam repeats the lobby id in the member field to mean "the lobby's
      // own data", so that case becomes null rather than a bogus Steam id.
      listener({ memberSteamId: e.m_ulSteamIDMember === lobbyId ? null : e.m_ulSteamIDMember });
    });
  }

  /**
   * Subscribes to the membership changes of one lobby.
   *
   * This is how a lobby screen learns that somebody joined, left, dropped, or
   * was thrown out. Changes for other lobbies are ignored, so one listener per
   * lobby is enough.
   *
   * Steam packs several `EChatMemberStateChange` bits into one callback, so a
   * member who timed out arrives as both `left` and `disconnected`. The
   * listener runs once per set bit, in the order entered, left, disconnected,
   * kicked, banned.
   *
   * @param lobbyId - Lobby to listen to. 64-bit, so a `bigint`.
   * @param listener - Runs once per membership change.
   * @returns Unsubscribe function. Calling it more than once is harmless.
   * @example
   * ```ts
   * import { init } from 'steamwand.js';
   *
   * const steam = init({ appId: 480 });
   * const lobbyId = await steam.lobbies.create(2, 4);
   * const off = steam.lobbies.onMemberChange(lobbyId, (c) => {
   *   console.log(c.steamId, c.change, steam.lobbies.getMembers(lobbyId).length);
   * });
   * // later: off();
   * ```
   * @see getMembers
   */
  onMemberChange(lobbyId: bigint, listener: (change: LobbyMemberChange) => void): () => void {
    return this.subscribe('LobbyChatUpdate_t', (e) => {
      if (e.m_ulSteamIDLobby !== lobbyId) return;
      for (const [bit, change] of MEMBER_CHANGE_BITS) {
        if (e.m_rgfChatMemberStateChange & bit) {
          listener({ steamId: e.m_ulSteamIDUserChanged, bySteamId: e.m_ulSteamIDMakingChange, change });
        }
      }
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
