/**
 * Live acceptance test for the curated controllers and capture layers against
 * the running Steam client, using Spacewar (appid 480). Steam Input is started
 * and shut down again, and the screenshot hook's prior state is restored.
 * No screenshot is written, because it would stay in the user's Steam library.
 *
 * Run: pnpm test:live:write (see AGENTS.md to select one file).
 * (requires a running, logged-in Steam client)
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { Steam } from '../../src';
import { writes, openSteam } from './config';

describe.skipIf(!writes)('controllers and capture (Spacewar, live writes)', () => {
  let steam: Steam;

  afterAll(() => {
    steam?.close();
  });

  beforeAll(() => {
    steam = openSteam();
    expect(steam.steamId()).toBeGreaterThan(0xffffffffn);
  });

  test('controllers: init, list, shutdown', () => {
    expect(typeof steam.controllers.init(true)).toBe('boolean');
    try {
      // Hardware coverage requires an attached controller; an empty list is valid.
      const handles = steam.controllers.list();
      expect(Array.isArray(handles)).toBe(true);
      for (const handle of handles) {
        expect(typeof handle).toBe('bigint');
        expect(typeof steam.controllers.type(handle)).toBe('number');
      }
      steam.controllers.runFrame();
    } finally {
      expect(typeof steam.controllers.shutdown()).toBe('boolean');
    }
  });

  test('capture: hook the screenshot key and hand it back', () => {
    const wasHooked = steam.capture.isHooked();
    try {
      steam.capture.hook(true);
      expect(steam.capture.isHooked()).toBe(true);
      steam.capture.hook(false);
      expect(steam.capture.isHooked()).toBe(false);
    } finally {
      steam.capture.hook(wasHooked);
    }
  });
});
