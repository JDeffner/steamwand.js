import { init, type Steam } from '../../src';

export function liveMode(env: NodeJS.ProcessEnv): { live: boolean; writes: boolean } {
  const live = env.STEAM_LIVE === '1';
  return { live, writes: live && env.STEAM_LIVE_WRITE === '1' };
}

export const { live, writes } = liveMode(process.env);

export function testAppId(value: string | undefined): number {
  if (!value || !/^[1-9]\d*$/.test(value) || Number(value) > 0xffffffff) {
    throw new Error('Set STEAM_TEST_APP_ID to the authorized Workshop app ID (set 480 explicitly for Spacewar).');
  }
  return Number(value);
}

export function expectedSteamId(value: string | undefined): bigint {
  if (!value || !/^[1-9]\d*$/.test(value) || BigInt(value) > 0xffffffffffffffffn) {
    throw new Error('Set STEAM_TEST_STEAM_ID to the SteamID64 of the account authorized for live writes.');
  }
  return BigInt(value);
}

export function checkIdentity(steam: { steamId(): bigint; system: { appId(): number } }, appId: number, account?: bigint): void {
  if (steam.system.appId() !== appId) throw new Error(`Steam initialized with an unexpected app ID; expected ${appId}.`);
  if (account !== undefined && steam.steamId() !== account) {
    throw new Error('The logged-in Steam account does not match STEAM_TEST_STEAM_ID. No test writes were started.');
  }
}

export function openSteam(appId = 480): Steam {
  if (!live) throw new Error('Live tests require STEAM_LIVE=1.');
  const account = writes ? expectedSteamId(process.env.STEAM_TEST_STEAM_ID) : undefined;
  const steam = init({ appId });
  try {
    checkIdentity(steam, appId, account);
    return steam;
  } catch (error) {
    steam.close();
    throw error;
  }
}
