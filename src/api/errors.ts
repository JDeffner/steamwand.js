import { EResult } from '../generated/enums';

const names = new Map<number, string>(Object.entries(EResult).map(([k, v]) => [v as number, k]));

/**
 * Names an `EResult` value for a message or a log line.
 *
 * @param result - An `EResult` value, for example `m_eResult` from a result struct.
 * @returns The enum name, for example `k_EResultOK`, or `EResult(<n>)` if the value is unknown.
 * @see SteamResultError
 */
export function eResultName(result: number): string {
  return names.get(result) ?? `EResult(${result})`;
}

/**
 * A Steam API call completed with a non-OK EResult.
 *
 * The call itself worked. Steam refused the operation, for example with
 * `k_EResultAccessDenied` or `k_EResultFileNotFound`. The `Workshop` methods
 * throw this.
 *
 * @see eResultName
 * @see SteamApiCallError
 */
export class SteamResultError extends Error {
  /**
   * @param operation - Flat method that failed, for example `SubmitItemUpdate`. Kept on the error.
   * @param result - The `EResult` Steam returned. Kept on the error, and named in `message`.
   */
  constructor(
    readonly operation: string,
    readonly result: number,
  ) {
    super(`${operation} failed: ${eResultName(result)}`);
    this.name = 'SteamResultError';
  }
}

/**
 * SteamAPI_InitFlat failed; `message` carries Valve's own diagnostic text.
 *
 * Usual causes: Steam is not running, the app id is unknown, or the account
 * does not own the app.
 *
 * @see init
 */
export class SteamInitError extends Error {
  /**
   * @param message - Valve's diagnostic text, or a fallback naming the result code.
   * @param initResult - The `ESteamAPIInitResult` value. Kept on the error.
   */
  constructor(
    message: string,
    readonly initResult: number,
  ) {
    super(message);
    this.name = 'SteamInitError';
  }
}
