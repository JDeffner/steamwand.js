/**
 * Live acceptance test for the curated auth and system layers against the
 * running Steam client, using Spacewar (appid 480). Read-only: it issues two
 * auth tickets and cancels both again, and opens no UI.
 *
 * Run: npx cross-env STEAM_LIVE=1 vitest run test/live/auth.live.test.ts
 * (requires a running, logged-in Steam client)
 */
import { afterAll, describe, expect, test } from 'vitest';
import { init, type Steam } from '../../src';

const live = !!process.env.STEAM_LIVE;

describe.skipIf(!live)('auth and system layers (Spacewar, live)', () => {
  let steam: Steam;

  afterAll(() => {
    steam?.close();
  });

  test('init', () => {
    steam = init({ appId: 480 });
    expect(steam.steamId()).toBeGreaterThan(0xffffffffn);
  });

  test('auth: session ticket round trip', async () => {
    const ticket = await steam.auth.getSessionTicket();
    expect(ticket.handle).toBeGreaterThan(0);
    expect(ticket.ticket.length).toBeGreaterThan(0);
    expect(ticket.hex.length).toBe(ticket.ticket.length * 2);
    steam.auth.cancelTicket(ticket.handle);
  }, 30_000);

  test('auth: web api ticket round trip', async () => {
    const ticket = await steam.auth.getWebApiTicket('steamwand-live');
    expect(ticket.handle).toBeGreaterThan(0);
    expect(ticket.ticket.length).toBeGreaterThan(0);
    expect(ticket.hex.length).toBe(ticket.ticket.length * 2);
    steam.auth.cancelTicket(ticket.handle);
  }, 30_000);

  test('auth: account facts', () => {
    expect(steam.auth.isLoggedOn()).toBe(true);
    expect(typeof steam.auth.isBehindNat()).toBe('boolean');
  });

  test('system: machine and client facts', () => {
    expect(steam.system.ipCountry()).toMatch(/^[A-Z]{2}$/);
    expect(Math.abs(steam.system.serverTime().getTime() - Date.now())).toBeLessThan(10 * 60 * 1000);
    expect(steam.system.uiLanguage().length).toBeGreaterThan(0);
    expect(typeof steam.system.isSteamDeck()).toBe('boolean');
    expect(steam.system.appId()).toBe(480);
  });
});
