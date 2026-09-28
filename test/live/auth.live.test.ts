/**
 * Live acceptance test for the curated auth and system layers against the
 * running Steam client, using Spacewar (appid 480). With write opt-in, it
 * issues two auth tickets and attempts to cancel both. It opens no UI.
 *
 * Run: pnpm test:live (reads), pnpm test:live:write (also tickets).
 * (requires a running, logged-in Steam client)
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { Steam } from '../../src';
import { live, writes, openSteam } from './config';

describe.skipIf(!live)('auth and system layers (Spacewar, live)', () => {
  let steam: Steam;

  afterAll(() => {
    steam?.close();
  });

  beforeAll(() => {
    steam = openSteam();
    expect(steam.steamId()).toBeGreaterThan(0xffffffffn);
  });

  test.skipIf(!writes)('auth: session ticket round trip', async () => {
    const ticket = await steam.auth.getSessionTicket();
    try {
      expect(ticket.handle).toBeGreaterThan(0);
      expect(ticket.ticket.length).toBeGreaterThan(0);
      expect(ticket.hex.length).toBe(ticket.ticket.length * 2);
    } finally {
      steam.auth.cancelTicket(ticket.handle);
    }
  }, 30_000);

  test.skipIf(!writes)('auth: web api ticket round trip', async () => {
    const ticket = await steam.auth.getWebApiTicket('steamwand-live');
    try {
      expect(ticket.handle).toBeGreaterThan(0);
      expect(ticket.ticket.length).toBeGreaterThan(0);
      expect(ticket.hex.length).toBe(ticket.ticket.length * 2);
    } finally {
      steam.auth.cancelTicket(ticket.handle);
    }
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
