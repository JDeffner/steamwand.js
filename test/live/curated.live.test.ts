/**
 * Live acceptance test for the curated stats, cloud, leaderboards, and
 * lobbies layers against the running Steam client, using Spacewar (appid
 * 480). Writes require a separate opt-in. Cleanup is attempted for one cloud
 * file and one private lobby. No achievement or stat is written.
 *
 * Run: pnpm test:live (reads), pnpm test:live:write (also writes).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { flat, SteamResultError, type Steam } from '../../src';
import { live, writes, openSteam } from './config';

describe.skipIf(!live)('curated layers (Spacewar, live)', () => {
  let steam: Steam;
  const cloudFile = `steamwand-test-${randomUUID()}.txt`;
  let cloudTouched = false;
  let lobbyId: bigint | undefined;

  afterAll(() => {
    try {
      if (cloudTouched && steam?.cloud.exists(cloudFile)) steam.cloud.deleteFile(cloudFile);
    } finally {
      try {
        if (steam && lobbyId) steam.lobbies.leave(lobbyId);
      } finally {
        steam?.close();
      }
    }
  });

  beforeAll(() => {
    steam = openSteam();
    expect(steam.steamId()).toBeGreaterThan(0xffffffffn);
  });

  test('stats: achievement schema and display text', () => {
    const names = steam.stats.listAchievements();
    expect(names.length).toBeGreaterThan(0);
    const display = steam.stats.getDisplay(names[0]);
    expect(display.name.length).toBeGreaterThan(0);
    expect(typeof steam.stats.isAchieved(names[0])).toBe('boolean');
    expect(typeof steam.stats.getAchievement(names[0]).achieved).toBe('boolean');
  });

  test('stats: current players and global percentages (async)', async () => {
    expect(await steam.stats.getNumberOfCurrentPlayers()).toBeGreaterThan(0);
    // Valve keeps no global achievement data for Spacewar, so Steam may refuse
    // with k_EResultFail. Either outcome proves the async round trip.
    try {
      const pct = await steam.stats.getGlobalPercentages();
      expect(Object.keys(pct).length).toBeGreaterThan(0);
    } catch (err) {
      expect(err).toBeInstanceOf(SteamResultError);
      expect((err as SteamResultError).result).toBe(flat.EResult.k_EResultFail);
    }
  }, 30_000);

  test.skipIf(!writes)('cloud: write, read back, list, delete', async () => {
    expect(steam.cloud.exists(cloudFile)).toBe(false);
    cloudTouched = true;
    console.info(`Cloud test fixture: ${cloudFile}`);
    await steam.cloud.writeFile(cloudFile, 'hello from steamwand');
    expect((await steam.cloud.readFile(cloudFile)).toString('utf8')).toBe('hello from steamwand');
    expect(steam.cloud.listFiles().map((f) => f.name)).toContain(cloudFile);
    steam.cloud.deleteFile(cloudFile);
    expect(steam.cloud.exists(cloudFile)).toBe(false);
  }, 30_000);

  test('cloud: quota reads', () => {
    const q = steam.cloud.quota();
    expect(q.totalBytes).toBeGreaterThan(0n);
    expect(q.availableBytes).toBeLessThanOrEqual(q.totalBytes);
  });

  test('leaderboards: find round trip (existing or null path)', async () => {
    // Spacewar ships a "Feet Traveled" leaderboard; fall back to the null
    // path so this stays green if Valve ever renames it.
    const board = await steam.leaderboards.find('Feet Traveled');
    if (board) {
      expect(board.handle).toBeGreaterThan(0n);
      const top = await steam.leaderboards.downloadEntries(board.handle, { rangeStart: 1, rangeEnd: 3 });
      expect(top.length).toBeGreaterThan(0);
      expect(top[0].globalRank).toBe(1);
    } else {
      expect(await steam.leaderboards.find('steamwand-does-not-exist')).toBeNull();
    }
  }, 30_000);

  test.skipIf(!writes)('lobbies: create, data, chat echo, leave', async () => {
    lobbyId = await steam.lobbies.create(0, 2); // 0 = private
    steam.lobbies.setData(lobbyId, 'map', 'live-check');
    expect(steam.lobbies.getData(lobbyId, 'map')).toBe('live-check');
    // Steam treats lobby data keys case-insensitively and may hand them back
    // recased ('Map' was observed on the live client), so match by value.
    expect(Object.values(steam.lobbies.listData(lobbyId))).toContain('live-check');
    expect(steam.lobbies.getMembers(lobbyId)).toContain(steam.steamId());

    const echoed = new Promise<string>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('lobby chat timed out')), 10_000);
      steam.lobbies.onChat(lobbyId!, (m) => {
        clearTimeout(t);
        resolve(m.message);
      });
    });
    steam.lobbies.sendChat(lobbyId, 'ping');
    expect(await echoed).toBe('ping');

    steam.lobbies.leave(lobbyId);
    lobbyId = undefined;
  }, 30_000);
});
