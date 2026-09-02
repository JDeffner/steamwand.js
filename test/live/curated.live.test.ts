/**
 * Live acceptance test for the curated stats, cloud, leaderboards, and
 * lobbies layers against the running Steam client, using Spacewar (appid
 * 480). Touches nothing durable: one tiny cloud file (deleted again) and one
 * private throwaway lobby (left again). No achievement or stat is written.
 *
 * Run: pnpm test:live   (requires a running, logged-in Steam client)
 */
import { afterAll, describe, expect, test } from 'vitest';
import { init, SteamResultError, type Steam } from '../../src';

const live = !!process.env.STEAM_LIVE;

describe.skipIf(!live)('curated layers (Spacewar, live)', () => {
  let steam: Steam;
  const cloudFile = 'steamwand-live-check.txt';
  let lobbyId: bigint | undefined;

  afterAll(() => {
    if (steam?.cloud.exists(cloudFile)) steam.cloud.deleteFile(cloudFile);
    if (steam && lobbyId) steam.lobbies.leave(lobbyId);
    steam?.close();
  });

  test('init', () => {
    steam = init({ appId: 480 });
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
    }
  }, 30_000);

  test('cloud: write, read back, list, delete', async () => {
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

  test('lobbies: create, data, chat echo, leave', async () => {
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
