/**
 * There is no live test for this layer. A peer to peer round trip needs two
 * Steam accounts on two machines, and one client cannot prove that a packet
 * left and came back. `test/live/` therefore covers everything except this.
 */
import type { ISteamNetworking } from '../generated/interfaces/ISteamNetworking';
import type { SteamCallbackMap } from '../generated/callbacks';
import type { P2PSessionState_t } from '../generated/structs';
import { layoutOf } from '../generated/structs';
import { EP2PSend } from '../generated/enums';
import { out } from '../runtime/out';
import { must } from './guards';

/**
 * One packet read off a channel.
 *
 * @see P2P.read
 * @see P2P.readAll
 */
export interface P2PPacket {
  /** Steam id of the peer that sent it. 64-bit, so a `bigint`. */
  steamId: bigint;
  /** The payload bytes, exactly as long as Steam reported. */
  data: Buffer;
}

/**
 * State of the session with one peer, decoded from `P2PSessionState_t`.
 *
 * @see P2P.sessionState
 */
export interface P2PSessionState {
  /** True while packets can flow in both directions. */
  connectionActive: boolean;
  /** True while Steam is still opening the session. */
  connecting: boolean;
  /** `EP2PSessionError`: 0 none, 2 no rights to app, 4 timeout. */
  error: number;
  /** True when the traffic goes through a Valve relay instead of straight to the peer. */
  usingRelay: boolean;
  /** Bytes still waiting to go out to this peer. */
  bytesQueued: number;
  /** Packets still waiting to go out to this peer. */
  packetsQueued: number;
  /** Peer address as a dotted quad, or an empty string when Steam does not know it. */
  remoteIp: string;
  /** Peer port, or 0 when Steam does not know it. */
  remotePort: number;
}

/** Formats a host-order IPv4 address as a dotted quad. 0 becomes an empty string. */
function dottedQuad(ip: number): string {
  if (ip === 0) return '';
  return [(ip >>> 24) & 0xff, (ip >>> 16) & 0xff, (ip >>> 8) & 0xff, ip & 0xff].join('.');
}

/**
 * Task level wrapper over ISteamNetworking: send bytes to another Steam user,
 * read what they send back, and manage the session in between.
 *
 * Valve deprecated ISteamNetworking in favour of ISteamNetworkingMessages.
 * This binding cannot wrap the replacement: every call on it takes a
 * `SteamNetworkingIdentity`, which is a C union. `steam_api.json` cannot
 * describe a union, so that struct has no offset table, and there is no
 * supported way to fill the buffer the generated `steam.networkingMessages`
 * asks for. The old interface is therefore the peer to peer path that works
 * today, and it still works: Valve keeps it alive for shipped games.
 *
 * Addressing is by Steam id and nothing else. There is no host, no port and no
 * socket: `send` names a peer, `read` drains what arrived. The first packet
 * from a peer you have not talked to raises `P2PSessionRequest_t` on the
 * receiver, who must call `acceptSession` before anything gets through, so
 * subscribe with `onSessionRequest` before you expect traffic.
 *
 * Reach it as `steam.p2p`.
 *
 * @see Steam.p2p
 */
export class P2P {
  /**
   * @param networking - The ISteamNetworking interface.
   * @param subscribe - Callback subscriber, normally `steam.on` bound to the session.
   */
  constructor(
    private readonly networking: ISteamNetworking,
    private readonly subscribe: <K extends keyof SteamCallbackMap & string>(
      name: K,
      listener: (data: SteamCallbackMap[K]) => void,
    ) => () => void,
  ) {}

  /**
   * Sends one packet to another Steam user.
   *
   * Steam opens the session on the first packet, which is why this can succeed
   * long before the peer has accepted anything. A reliable packet is resent
   * until it arrives and keeps its order; an unreliable one is sent once and
   * may be dropped or reordered.
   *
   * @param steamId - Peer to send to. 64-bit, so a `bigint`.
   * @param data - Payload. A string is encoded as UTF-8.
   * @param opts.reliable - True for `k_EP2PSendReliable`, false for `k_EP2PSendUnreliable`.
   * @defaultValue true
   * @param opts.channel - Channel to send on. The peer must read the same channel.
   * @defaultValue 0
   * @returns Steam's own answer. False means the packet was not queued at all, for example because the peer is not a valid Steam id.
   * @example
   * ```ts
   * import { init } from 'steamwand.js';
   *
   * const steam = init({ appId: 480 });
   * steam.p2p.send(76561198000000000n, 'hello');
   * steam.p2p.send(76561198000000000n, positionBytes, { reliable: false });
   * steam.close();
   * ```
   * @see read
   */
  send(steamId: bigint, data: Buffer | string, opts: { reliable?: boolean; channel?: number } = {}): boolean {
    const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    const type = opts.reliable === false ? EP2PSend.k_EP2PSendUnreliable : EP2PSend.k_EP2PSendReliable;
    return this.networking.SendP2PPacket(steamId, bytes, bytes.length, type, opts.channel ?? 0);
  }

  /**
   * Checks whether a packet is waiting on a channel.
   *
   * @param channel - Channel to check.
   * @defaultValue 0
   * @returns Size of the next packet in bytes, or null when nothing is waiting.
   * @see read
   */
  available(channel = 0): number | null {
    const size = out.uint32();
    if (!this.networking.IsP2PPacketAvailable(size.buffer, channel)) return null;
    return size.value;
  }

  /**
   * Reads the next packet off a channel.
   *
   * The read buffer is allocated at exactly the size Steam reported, so a
   * packet is never truncated and never over-allocated.
   *
   * @param channel - Channel to read.
   * @defaultValue 0
   * @returns The sender and the payload, or null when nothing is waiting.
   * @example
   * ```ts
   * import { init } from 'steamwand.js';
   *
   * const steam = init({ appId: 480 });
   * steam.p2p.onSessionRequest((id) => steam.p2p.acceptSession(id));
   * setInterval(() => {
   *   for (const p of steam.p2p.readAll()) console.log(p.steamId, p.data.toString());
   * }, 50);
   * ```
   * @see readAll
   * @see available
   */
  read(channel = 0): P2PPacket | null {
    const size = this.available(channel);
    if (size === null) return null;
    const buffer = Buffer.alloc(size);
    const written = out.uint32();
    const steamId = out.uint64();
    if (!this.networking.ReadP2PPacket(buffer, size, written.buffer, steamId.buffer, channel)) return null;
    return { steamId: steamId.value, data: Buffer.from(buffer.subarray(0, written.value)) };
  }

  /**
   * Drains every packet waiting on a channel.
   *
   * This is the call a game loop makes once per frame. Steam queues packets
   * while nobody reads, so leaving them is how a game falls behind.
   *
   * @param channel - Channel to drain.
   * @defaultValue 0
   * @returns The packets, oldest first. Empty when nothing was waiting.
   * @see read
   */
  readAll(channel = 0): P2PPacket[] {
    const packets: P2PPacket[] = [];
    for (let p = this.read(channel); p !== null; p = this.read(channel)) packets.push(p);
    return packets;
  }

  /**
   * Accepts a session another user asked for.
   *
   * Call it from an `onSessionRequest` listener for peers you expect, and only
   * for those: accepting an unknown Steam id lets that user send you traffic.
   * Sending to a peer accepts their session implicitly, so a client that
   * speaks first never needs this.
   *
   * @param steamId - Peer that asked. 64-bit, so a `bigint`.
   * @throws Error if Steam refused, which means an invalid Steam id.
   * @see onSessionRequest
   */
  acceptSession(steamId: bigint): void {
    must('AcceptP2PSessionWithUser', this.networking.AcceptP2PSessionWithUser(steamId));
  }

  /**
   * Closes the whole session with a peer, on every channel.
   *
   * Packets still queued for that peer are dropped. Call it when the player
   * leaves, or Steam keeps the session open until the process exits.
   *
   * @param steamId - Peer to disconnect from. 64-bit, so a `bigint`.
   * @throws Error if Steam refused, which means an invalid Steam id.
   * @see closeChannel
   */
  closeSession(steamId: bigint): void {
    must('CloseP2PSessionWithUser', this.networking.CloseP2PSessionWithUser(steamId));
  }

  /**
   * Closes one channel of a session and leaves the others open.
   *
   * @param steamId - Peer to close a channel with. 64-bit, so a `bigint`.
   * @param channel - Channel to close.
   * @throws Error if Steam refused, which means an invalid Steam id.
   * @see closeSession
   */
  closeChannel(steamId: bigint, channel: number): void {
    must('CloseP2PChannelWithUser', this.networking.CloseP2PChannelWithUser(steamId, channel));
  }

  /**
   * Reads the state of the session with one peer.
   *
   * Useful for diagnostics: whether the connection came up, whether it goes
   * through a relay, and how much is still queued to send.
   *
   * @param steamId - Peer to ask about. 64-bit, so a `bigint`.
   * @returns The state, or null when there is no session with that peer.
   * @example
   * ```ts
   * const state = steam.p2p.sessionState(peerId);
   * if (state?.usingRelay) console.log('relayed through', state.remoteIp);
   * ```
   */
  sessionState(steamId: bigint): P2PSessionState | null {
    const state = out.struct<P2PSessionState_t>(layoutOf('P2PSessionState_t'));
    if (!this.networking.GetP2PSessionState(steamId, state.buffer)) return null;
    const s = state.value;
    return {
      connectionActive: s.m_bConnectionActive !== 0,
      connecting: s.m_bConnecting !== 0,
      error: s.m_eP2PSessionError,
      usingRelay: s.m_bUsingRelay !== 0,
      bytesQueued: s.m_nBytesQueuedForSend,
      packetsQueued: s.m_nPacketsQueuedForSend,
      remoteIp: dottedQuad(s.m_nRemoteIP),
      remotePort: s.m_nRemotePort,
    };
  }

  /**
   * Allows or forbids relaying packets through Valve's servers.
   *
   * Relaying is on by default and is what makes peer to peer work behind a
   * NAT, at the cost of some latency. Turn it off only when your game has its
   * own fallback.
   *
   * @param allow - True to keep the relay, false to require a direct connection.
   */
  allowRelay(allow: boolean): void {
    this.networking.AllowP2PPacketRelay(allow);
  }

  /**
   * Subscribes to peers asking to open a session.
   *
   * The first packet from an unknown peer raises this instead of arriving.
   * Answer with `acceptSession` for peers you expect, and ignore the rest:
   * a session that is never accepted costs nothing.
   *
   * @param listener - Runs with the Steam id of the peer that asked.
   * @returns Unsubscribe function. Calling it more than once is harmless.
   * @example
   * ```ts
   * const off = steam.p2p.onSessionRequest((steamId) => {
   *   if (expectedPlayers.has(steamId)) steam.p2p.acceptSession(steamId);
   * });
   * // later: off();
   * ```
   * @see acceptSession
   */
  onSessionRequest(listener: (steamId: bigint) => void): () => void {
    return this.subscribe('P2PSessionRequest_t', (e) => listener(e.m_steamIDRemote));
  }

  /**
   * Subscribes to sessions that failed to come up or dropped.
   *
   * This is the only signal that a peer went away: there is no disconnect
   * event otherwise.
   *
   * @param listener - Runs with the peer and the `EP2PSessionError` (2 no rights to app, 4 timeout).
   * @returns Unsubscribe function. Calling it more than once is harmless.
   */
  onSessionConnectFail(listener: (event: { steamId: bigint; error: number }) => void): () => void {
    return this.subscribe('P2PSessionConnectFail_t', (e) =>
      listener({ steamId: e.m_steamIDRemote, error: e.m_eP2PSessionError }),
    );
  }
}
