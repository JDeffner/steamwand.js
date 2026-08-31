import { describe, expect, it } from 'vitest';
import type { Steam } from '../src';
import type * as flat from '../src/generated';

/**
 * Compile-time contract, enforced by `pnpm typecheck`: 64-bit values are
 * bigint-only, callback names and listener payloads are checked, async
 * wrappers resolve with their result struct. `tsc` fails if a
 * `@ts-expect-error` line stops erroring. Never called at runtime.
 */
function typeContract(steam: Steam, friends: flat.ISteamFriends, ugc: flat.ISteamUGC): void {
  friends.GetFriendPersonaName(76561197960287930n);
  // @ts-expect-error 64-bit params take bigint, not number
  friends.GetFriendPersonaName(76561197960287930);
  // @ts-expect-error 64-bit params take bigint, not number
  ugc.SubscribeItem(123);

  const off = steam.on('ItemInstalled_t', (e) => {
    const id: bigint = e.m_nPublishedFileId;
    void id;
  });
  void off;
  // @ts-expect-error unknown callback names are rejected
  steam.on('NotACallback_t', () => {});

  const found: Promise<flat.LeaderboardFindResult_t> = steam.async.userStats.FindLeaderboard('scores');
  void found;
}

describe('type contract', () => {
  it('compiles (the assertions live in tsc, not here)', () => {
    expect(typeof typeContract).toBe('function');
  });
});
