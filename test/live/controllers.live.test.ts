/**
 * Live acceptance test for the curated controllers and capture layers against
 * the running Steam client, using Spacewar (appid 480). Touches nothing
 * durable: Steam Input is started and shut down again, and the screenshot key
 * hook is turned on and off again. No screenshot is written, because a written
 * one stays in the user's Steam library.
 *
 * Run: npx cross-env STEAM_LIVE=1 vitest run test/live/controllers.live.test.ts
 * (requires a running, logged-in Steam client)
 */
import { afterAll, describe, expect, test } from 'vitest';
import { init, type Steam } from '../../src';

const live = !!process.env.STEAM_LIVE;

describe.skipIf(!live)('controllers and capture (Spacewar, live)', () => {
  let steam: Steam;

  afterAll(() => {
    steam?.close();
  });

  test('init', () => {
    steam = init({ appId: 480 });
    expect(steam.steamId()).toBeGreaterThan(0xffffffffn);
  });

  test('controllers: init, list, shutdown', () => {
    expect(typeof steam.controllers.init(true)).toBe('boolean');
    // The dev machine has no controller attached, so an empty list is the
    // expected answer; every entry must be a handle when one is attached.
    const handles = steam.controllers.list();
    expect(Array.isArray(handles)).toBe(true);
    for (const handle of handles) {
      expect(typeof handle).toBe('bigint');
      expect(typeof steam.controllers.type(handle)).toBe('number');
    }
    steam.controllers.runFrame();
    expect(typeof steam.controllers.shutdown()).toBe('boolean');
  });

  test('capture: hook the screenshot key and hand it back', () => {
    steam.capture.hook(true);
    expect(steam.capture.isHooked()).toBe(true);
    steam.capture.hook(false);
    expect(steam.capture.isHooked()).toBe(false);
  });
});
