import type { SteamDispatch } from '../runtime/dispatch';
import { out } from '../runtime/out';
import type { ISteamUser } from '../generated/interfaces/ISteamUser';
import type { SteamCallbackMap } from '../generated/callbacks';
import { layoutOf } from '../generated/structs';
import type { EncryptedAppTicketResponse_t } from '../generated/structs';
import { EBeginAuthSessionResult } from '../generated/enums';
import { callbackIdByName } from '../generated/callbacks';
import { ok, must } from './guards';

/** Steam session tickets stay well under this, and Valve's own samples use the same size. */
const TICKET_BYTES = 1024;
/** Encrypted app tickets are capped by Steam at 1 KB of extra data plus overhead. */
const ENCRYPTED_TICKET_BYTES = 2048;

/**
 * One auth ticket, ready to hand to a game server or a Web API call.
 *
 * @see Auth.getSessionTicket
 * @see Auth.getWebApiTicket
 */
export interface AuthTicket {
  /** Ticket handle, for `cancelTicket`. 32-bit, so a `number`. */
  handle: number;
  /** The raw ticket bytes, exactly as long as Steam reported. */
  ticket: Buffer;
  /** The same bytes as lowercase hex, which is what Valve's Web API expects. */
  hex: string;
}

/**
 * One `ValidateAuthTicketResponse_t`, as delivered to an `onValidateTicket` listener.
 *
 * @see Auth.onValidateTicket
 */
export interface ValidateTicketResult {
  /** Steam id the ticket belongs to. 64-bit, so a `bigint`. */
  steamId: bigint;
  /** `EAuthSessionResponse`. 0 (`k_EAuthSessionResponseOK`) means the session is authenticated. */
  response: number;
  /** Steam id that owns the license, which differs from `steamId` under Family Sharing. 64-bit, so a `bigint`. */
  ownerSteamId: bigint;
}

/**
 * Task level wrapper over ISteamUser: issue auth tickets, validate somebody
 * else's, and read the small facts about the logged-in account.
 *
 * A ticket is how a game server or a Web API backend learns that this user
 * really is who they claim to be. `getSessionTicket` is the one for your own
 * game server (which validates it with `beginSession`), `getWebApiTicket` the
 * one for a HTTP backend calling `AuthenticateUserTicket`. Both wait for
 * Steam's confirming callback, so an awaited ticket is a usable ticket.
 *
 * Reach it as `steam.auth`. Named `auth` because the generated ISteamUser
 * accessor already owns `steam.user`.
 *
 * @see Steam.auth
 * @see SteamResultError
 */
export class Auth {
  /**
   * @param user - The ISteamUser interface.
   * @param dispatch - Running pump that resolves the call results.
   * @param subscribe - Callback subscriber, normally `steam.on` bound to the session.
   * @param once - Awaitable callback subscriber, normally `steam.once` bound to the session.
   */
  constructor(
    private readonly user: ISteamUser,
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
   * Issues a session ticket for your own game server.
   *
   * Steam fills the ticket bytes immediately and confirms it with
   * `GetAuthSessionTicketResponse_t`; this waits for that confirmation, so the
   * resolved ticket is one the server can accept. Cancel it with
   * `cancelTicket` when the session ends, or the handle stays allocated.
   *
   * @param _identity - Reserved. The `SteamNetworkingIdentity` parameter carries a C union, which this binding excludes on purpose, so only `null` (any identity) can be passed and this argument is ignored.
   * @returns The handle, the raw bytes, and their hex form.
   * @throws Error if Steam refused to issue a ticket at all.
   * @throws SteamResultError if Steam refused the ticket, for example with `k_EResultNoConnection` when the client is offline.
   * @example
   * ```ts
   * import { init } from 'steamwand.js';
   *
   * const steam = init({ appId: 480 });
   * const ticket = await steam.auth.getSessionTicket();
   * // send ticket.hex to your game server, then:
   * steam.auth.cancelTicket(ticket.handle);
   * steam.close();
   * ```
   * @see cancelTicket
   * @see beginSession
   */
  async getSessionTicket(_identity?: null): Promise<AuthTicket> {
    const buffer = Buffer.alloc(TICKET_BYTES);
    const written = out.uint32();
    const handle = this.user.GetAuthSessionTicket(buffer, TICKET_BYTES, written.buffer, null);
    if (handle === 0) throw new Error('steamwand: GetAuthSessionTicket returned an invalid handle');

    const r = await this.once('GetAuthSessionTicketResponse_t', (e) => e.m_hAuthTicket === handle);
    ok('GetAuthSessionTicket', r.m_eResult);
    const ticket = buffer.subarray(0, written.value);
    return { handle, ticket, hex: ticket.toString('hex') };
  }

  /**
   * Issues a ticket for Valve's `AuthenticateUserTicket` Web API endpoint.
   *
   * This is the ticket a HTTP backend needs. The bytes only exist inside the
   * `GetTicketForWebApiResponse_t` callback, so there is no synchronous form:
   * the ticket is whatever that callback carried.
   *
   * @param identity - Identity string agreed with your backend, which Valve echoes back on verification. Omit for no identity.
   * @returns The handle, the raw bytes, and their hex form.
   * @throws Error if Steam refused to issue a ticket at all.
   * @throws SteamResultError if Steam refused the ticket.
   * @example
   * ```ts
   * import { init } from 'steamwand.js';
   *
   * const steam = init({ appId: 480 });
   * const ticket = await steam.auth.getWebApiTicket('my-backend');
   * // POST ticket.hex to ISteamUserAuth/AuthenticateUserTicket
   * steam.auth.cancelTicket(ticket.handle);
   * steam.close();
   * ```
   * @see getSessionTicket
   */
  async getWebApiTicket(identity = ''): Promise<AuthTicket> {
    const handle = this.user.GetAuthTicketForWebApi(identity);
    if (handle === 0) throw new Error('steamwand: GetAuthTicketForWebApi returned an invalid handle');

    const r = await this.once('GetTicketForWebApiResponse_t', (e) => e.m_hAuthTicket === handle);
    ok('GetAuthTicketForWebApi', r.m_eResult);
    const ticket = r.m_rgubTicket.subarray(0, r.m_cubTicket);
    return { handle, ticket, hex: ticket.toString('hex') };
  }

  /**
   * Cancels a ticket this user issued.
   *
   * Every server that authenticated with it gets a
   * `ValidateAuthTicketResponse_t` carrying
   * `k_EAuthSessionResponseAuthTicketCanceled`. Call it when the player
   * disconnects, and on shutdown for every ticket still out.
   *
   * @param handle - Ticket handle from `getSessionTicket` or `getWebApiTicket`.
   * @see getSessionTicket
   */
  cancelTicket(handle: number): void {
    this.user.CancelAuthTicket(handle);
  }

  /**
   * Starts authenticating another user's session ticket.
   *
   * This is the server side of `getSessionTicket`. The answer is not here: it
   * arrives asynchronously as a `ValidateAuthTicketResponse_t`, so subscribe
   * with `onValidateTicket` before calling this. Pair every successful call
   * with `endSession`.
   *
   * @param ticket - The other user's raw ticket bytes.
   * @param steamId - Steam id that ticket claims to belong to. 64-bit, so a `bigint`.
   * @throws Error if Steam rejected the ticket outright, for example as expired or as a duplicate request. The message names the `EBeginAuthSessionResult`.
   * @example
   * ```ts
   * import { init } from 'steamwand.js';
   *
   * const steam = init({ appId: 480 });
   * const off = steam.auth.onValidateTicket((r) => console.log(r.steamId, r.response));
   * steam.auth.beginSession(ticketBytes, playerSteamId);
   * // later: steam.auth.endSession(playerSteamId); off();
   * ```
   * @see endSession
   * @see onValidateTicket
   */
  beginSession(ticket: Buffer, steamId: bigint): void {
    const result = this.user.BeginAuthSession(ticket, ticket.length, steamId);
    if (result !== EBeginAuthSessionResult.k_EBeginAuthSessionResultOK) {
      const name =
        Object.entries(EBeginAuthSessionResult).find(([, v]) => v === result)?.[0] ??
        `EBeginAuthSessionResult(${result})`;
      throw new Error(`steamwand: BeginAuthSession failed: ${name}`);
    }
  }

  /**
   * Ends a session started with `beginSession`.
   *
   * Steam has no result for this, so it cannot fail from here. Not calling it
   * leaks the session on Steam's side until the process exits.
   *
   * @param steamId - The same Steam id `beginSession` was called with. 64-bit, so a `bigint`.
   * @see beginSession
   */
  endSession(steamId: bigint): void {
    this.user.EndAuthSession(steamId);
  }

  /**
   * Subscribes to the answers for every session started with `beginSession`.
   *
   * The listener runs once per answer, including later ones for a session that
   * already validated: a ban or a cancelled ticket arrives the same way, so
   * treat a non-OK response as a reason to drop the player.
   *
   * @param listener - Runs on every `ValidateAuthTicketResponse_t`.
   * @returns Unsubscribe function. Calling it more than once is harmless.
   * @see beginSession
   */
  onValidateTicket(listener: (result: ValidateTicketResult) => void): () => void {
    return this.subscribe('ValidateAuthTicketResponse_t', (e) =>
      listener({ steamId: e.m_SteamID, response: e.m_eAuthSessionResponse, ownerSteamId: e.m_OwnerSteamID }),
    );
  }

  /**
   * Checks whether another user owns an app.
   *
   * Only meaningful after `beginSession` succeeded for that user, which is
   * what gives this client the right to ask.
   *
   * @param steamId - User to check. 64-bit, so a `bigint`.
   * @param appId - App id to check ownership of.
   * @returns `EUserHasLicenseForAppResult`: 0 has a license, 1 does not, 2 this client may not ask.
   */
  userHasLicenseForApp(steamId: bigint, appId: number): number {
    return this.user.UserHasLicenseForApp(steamId, appId);
  }

  /**
   * Requests an encrypted app ticket and returns it once Steam has one.
   *
   * The ticket is decrypted on your backend with the app's encryption key from
   * the partner site, so an app without that key configured cannot use this.
   * Steam rate limits this to one call per minute.
   *
   * @param data - Up to 1 KB of your own data to seal into the ticket. Omit to send none.
   * @returns The encrypted ticket bytes.
   * @throws SteamResultError if Steam refused the request, for example with `k_EResultNoConnection`, or `k_EResultLimitExceeded` when called again too soon.
   * @throws Error if the ticket did not fit the read buffer.
   * @throws SteamApiCallError if the call could not be completed.
   * @see getWebApiTicket
   */
  async requestEncryptedAppTicket(data?: Buffer): Promise<Buffer> {
    const call = this.user.RequestEncryptedAppTicket(data ?? null, data?.length ?? 0);
    const r = await this.dispatch.callResultStruct<EncryptedAppTicketResponse_t>(
      call,
      layoutOf('EncryptedAppTicketResponse_t'),
      callbackIdByName.EncryptedAppTicketResponse_t,
    );
    ok('RequestEncryptedAppTicket', r.m_eResult);

    const buffer = Buffer.alloc(ENCRYPTED_TICKET_BYTES);
    const written = out.uint32();
    must('GetEncryptedAppTicket', this.user.GetEncryptedAppTicket(buffer, ENCRYPTED_TICKET_BYTES, written.buffer));
    return buffer.subarray(0, written.value);
  }

  /**
   * Checks whether the Steam client is logged on to Valve's servers.
   *
   * False while the client is in offline mode, which is when the ticket
   * methods start failing.
   *
   * @returns True if the user is logged on.
   */
  isLoggedOn(): boolean {
    return this.user.BLoggedOn();
  }

  /**
   * Reads the current user's Steam level.
   *
   * @returns The level, or 0 if Steam does not know it yet.
   */
  steamLevel(): number {
    return this.user.GetPlayerSteamLevel();
  }

  /**
   * Checks whether this user sits behind a NAT.
   *
   * @returns True if Steam detected a NAT, which matters for peer to peer connectivity.
   */
  isBehindNat(): boolean {
    return this.user.BIsBehindNAT();
  }

  /**
   * Checks whether the account has a verified phone number.
   *
   * @returns True if the phone number is verified.
   */
  isPhoneVerified(): boolean {
    return this.user.BIsPhoneVerified();
  }

  /**
   * Checks whether the account uses the Steam Guard mobile authenticator.
   *
   * @returns True if two-factor authentication is on.
   */
  isTwoFactorEnabled(): boolean {
    return this.user.BIsTwoFactorEnabled();
  }
}
