/**
 * Live acceptance test for the curated social and overlay layers against the
 * running Steam client, using Spacewar (appid 480). It never opens an overlay
 * dialog and leaves no state behind: the one rich presence key it sets is
 * cleared again.
 *
 * Run: npx cross-env STEAM_LIVE=1 vitest run test/live/social.live.test.ts
 * (requires a running, logged-in Steam client)
 */
import { afterAll, describe, expect, test } from 'vitest';
import { init, type Steam } from '../../src';

const live = !!process.env.STEAM_LIVE;

describe.skipIf(!live)('social and overlay layers (Spacewar, live)', () => {
  let steam: Steam;
  const presenceKey = 'status';

  afterAll(() => {
    steam?.social.clearRichPresence();
    steam?.close();
  });

  test('init', () => {
    steam = init({ appId: 480 });
    expect(steam.steamId()).toBeGreaterThan(0xffffffffn);
  });

  test('social: own persona name and state', () => {
    expect(steam.social.personaName().length).toBeGreaterThan(0);
    expect(typeof steam.social.personaState()).toBe('number');
  });

  test('social: friend list entries are typed', () => {
    const friends = steam.social.listFriends();
    expect(friends.length).toBeGreaterThanOrEqual(0);
    for (const friend of friends.slice(0, 5)) {
      expect(typeof friend.steamId).toBe('bigint');
      expect(typeof friend.name).toBe('string');
      expect(typeof friend.state).toBe('number');
      expect(typeof friend.relationship).toBe('number');
      expect(steam.social.friendName(friend.steamId)).toBe(friend.name);
      expect(steam.social.friendState(friend.steamId)).toBe(friend.state);
    }
  });

  test('social: rich presence write, read back, clear', () => {
    const me = steam.steamId();
    steam.social.setRichPresence(presenceKey, 'live-check');
    expect(steam.social.getRichPresence(me, presenceKey)).toBe('live-check');
    expect(Object.values(steam.social.listRichPresence(me))).toContain('live-check');

    steam.social.clearRichPresence();
    expect(steam.social.getRichPresence(me, presenceKey)).toBe('');
  });

  test('social: own avatar is either loaded or pending', () => {
    // Steam loads avatar pixels asynchronously, so null is a valid answer here.
    const avatar = steam.social.avatar(steam.steamId(), 'small');
    if (avatar) {
      expect(avatar.width).toBeGreaterThan(0);
      expect(avatar.rgba.length).toBe(avatar.width * avatar.height * 4);
    } else {
      expect(avatar).toBeNull();
    }
  });

  test('overlay: enabled flag reads without opening anything', () => {
    expect(typeof steam.overlay.isEnabled()).toBe('boolean');
  });
});
