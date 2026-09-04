/**
 * Live acceptance test for the curated recording (Steam Timeline) layer
 * against the running Steam client, using Spacewar (appid 480). It marks one
 * timeline event on the current session and opens no UI. Nothing here needs
 * Game Recording to be on: with it off Steam still accepts the calls and
 * simply records nothing, which is exactly what the assertions allow for.
 *
 * Run: npx cross-env STEAM_LIVE=1 vitest run test/live/recording.live.test.ts
 * (requires a running, logged-in Steam client)
 */
import { afterAll, describe, expect, test } from 'vitest';
import { init, flat, type Steam } from '../../src';

const live = !!process.env.STEAM_LIVE;

describe.skipIf(!live)('recording layer (Spacewar, live)', () => {
  let steam: Steam;
  let eventId: bigint;

  afterAll(() => {
    steam?.close();
  });

  test('init', () => {
    steam = init({ appId: 480 });
    expect(steam.steamId()).toBeGreaterThan(0xffffffffn);
  });

  test('game mode and tooltip do not throw', () => {
    steam.recording.setGameMode(flat.ETimelineGameMode.k_ETimelineGameMode_Playing);
    steam.recording.setTooltip('steamwand live test');
    steam.recording.clearTooltip();
  });

  test('addEvent returns a handle', () => {
    // 0n when the client has Game Recording off, a real handle when it is on.
    eventId = steam.recording.addEvent({
      title: 'steamwand live test',
      description: 'Marker written by test/live/recording.live.test.ts',
      icon: 'steam_achievement',
    });
    expect(typeof eventId).toBe('bigint');
  });

  test('eventRecordingExists answers with a boolean', async () => {
    expect(typeof (await steam.recording.eventRecordingExists(eventId))).toBe('boolean');
  }, 30_000);
});
