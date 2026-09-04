/**
 * Live acceptance test for the curated inventory layer against the running
 * Steam client, using Spacewar (appid 480). Read-only: it loads the item
 * definition catalogue and reads the player's items. Nothing is consumed,
 * generated, traded, or purchased.
 *
 * Run: npx cross-env STEAM_LIVE=1 vitest run test/live/inventory.live.test.ts
 * (requires a running, logged-in Steam client)
 */
import { afterAll, describe, expect, test } from 'vitest';
import { init, type Steam } from '../../src';

const live = !!process.env.STEAM_LIVE;

describe.skipIf(!live)('inventory layer (Spacewar, live)', () => {
  let steam: Steam;

  afterAll(() => {
    steam?.close();
  });

  test('init', () => {
    steam = init({ appId: 480 });
    expect(steam.steamId()).toBeGreaterThan(0xffffffffn);
  });

  test('item definitions load', async () => {
    await steam.items.loadDefinitions();
    expect(Array.isArray(steam.items.listDefinitions())).toBe(true);
  }, 30_000);

  test('getAll returns item stacks', async () => {
    const items = await steam.items.getAll();
    expect(Array.isArray(items)).toBe(true);
    for (const item of items) {
      expect(typeof item.itemId).toBe('bigint');
      expect(typeof item.definition).toBe('number');
      expect(typeof item.quantity).toBe('number');
      expect(typeof item.flags).toBe('number');
    }
  }, 30_000);
});
