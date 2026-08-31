import { EResult } from '../generated/enums';

const names = new Map<number, string>(Object.entries(EResult).map(([k, v]) => [v as number, k]));

export function eResultName(result: number): string {
  return names.get(result) ?? `EResult(${result})`;
}

/** A Steam API call completed with a non-OK EResult. */
export class SteamResultError extends Error {
  constructor(
    readonly operation: string,
    readonly result: number,
  ) {
    super(`${operation} failed: ${eResultName(result)}`);
    this.name = 'SteamResultError';
  }
}

/** SteamAPI_InitFlat failed; `message` carries Valve's own diagnostic text. */
export class SteamInitError extends Error {
  constructor(
    message: string,
    readonly initResult: number,
  ) {
    super(message);
    this.name = 'SteamInitError';
  }
}
