import { EResult } from '../generated/enums';
import { SteamResultError } from './errors';

/**
 * Throws unless the EResult is OK.
 *
 * @throws SteamResultError if `result` is not `k_EResultOK`.
 */
export function ok(operation: string, result: number): void {
  if (result !== EResult.k_EResultOK) throw new SteamResultError(operation, result);
}

/**
 * Throws unless a boolean flat method returned true.
 *
 * @throws Error if `returned` is false, which means an invalid handle or argument.
 */
export function must(operation: string, returned: boolean): void {
  if (!returned) throw new Error(`steamwand: ${operation} returned false (invalid handle or argument?)`);
}
