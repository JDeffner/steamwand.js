/**
 * Read-only live smoke across the generated surface: one call per argument
 * and return shape (str/bool/float/u64/out-buffer/call result/struct decode)
 * over 10 interfaces. Needs a running Steam client; changes nothing.
 * Run: pnpm smoke
 */
import { init, flat } from '../src';

const results: [string, string, string][] = [];
let failed = 0;
function t(iface: string, name: string, fn: () => unknown, check?: (v: any) => boolean) {
  try {
    const v = fn();
    const ok = check ? check(v) : true;
    if (!ok) failed++;
    results.push([iface, name, ok ? `OK  ${String(v).slice(0, 60)}` : `UNEXPECTED ${String(v)}`]);
  } catch (e) {
    failed++;
    results.push([iface, name, `THREW ${(e as Error).message.slice(0, 80)}`]);
  }
}

(async () => {
  const steam = init({ appId: 480 });

  // ISteamUser
  t('user', 'GetSteamID (u64 return)', () => steam.user.GetSteamID(), v => v > 0xffffffffn);
  t('user', 'BLoggedOn (bool)', () => steam.user.BLoggedOn(), v => v === true);
  t('user', 'GetPlayerSteamLevel (int)', () => steam.user.GetPlayerSteamLevel(), v => v > 0);

  // ISteamFriends
  t('friends', 'GetPersonaName (str return)', () => steam.friends.GetPersonaName(), v => typeof v === 'string' && v.length > 0);
  t('friends', 'GetPersonaState (enum)', () => steam.friends.GetPersonaState(), v => v >= 0 && v <= 6);
  t('friends', 'GetFriendCount (int-flag param)', () => steam.friends.GetFriendCount(flat.EFriendFlags.k_EFriendFlagImmediate), v => v >= 0);

  // ISteamUtils
  t('utils', 'GetAppID', () => steam.utils.GetAppID(), v => v === 480);
  t('utils', 'GetIPCountry (str)', () => steam.utils.GetIPCountry(), v => typeof v === 'string' && v.length === 2);
  t('utils', 'GetServerRealTime (uint32)', () => steam.utils.GetServerRealTime(), v => v > 1_700_000_000);
  t('utils', 'GetSteamUILanguage (str)', () => steam.utils.GetSteamUILanguage(), v => typeof v === 'string');
  t('utils', 'IsOverlayEnabled (bool)', () => steam.utils.IsOverlayEnabled(), v => typeof v === 'boolean');

  // ISteamApps
  t('apps', 'BIsSubscribed', () => steam.apps.BIsSubscribed(), v => v === true);
  t('apps', 'GetCurrentGameLanguage (str)', () => steam.apps.GetCurrentGameLanguage(), v => typeof v === 'string');
  t('apps', 'GetAppOwner (CSteamID as u64)', () => steam.apps.GetAppOwner(), v => v === steam.steamId());
  t('apps', 'BIsSubscribedApp(1158310) (typedef param)', () => steam.apps.BIsSubscribedApp(1158310), v => v === true);
  t('apps', 'BIsDlcInstalled(999999) (negative case)', () => steam.apps.BIsDlcInstalled(999999), v => v === false);
  t('apps', 'GetAppInstallDir (char* out-buffer)', () => {
    const buf = Buffer.alloc(260);
    const len = steam.apps.GetAppInstallDir(1158310, buf, 260);
    return buf.toString('utf8', 0, Math.max(buf.indexOf(0), 0));
  }, v => typeof v === 'string' && (v as string).toLowerCase().includes('crusader'));
  t('apps', 'GetEarliestPurchaseUnixTime (uint32)', () => steam.apps.GetEarliestPurchaseUnixTime(480), v => typeof v === 'number');

  // ISteamUserStats
  t('userStats', 'GetNumAchievements (uint32)', () => steam.userStats.GetNumAchievements(), v => typeof v === 'number');

  // ISteamRemoteStorage
  const rs = new flat.ISteamRemoteStorage(steam.native);
  t('remoteStorage', 'IsCloudEnabledForAccount', () => rs.IsCloudEnabledForAccount(), v => typeof v === 'boolean');
  t('remoteStorage', 'GetFileCount (int32)', () => rs.GetFileCount(), v => v >= 0);

  // ISteamMusic
  const music = new flat.ISteamMusic(steam.native);
  t('music', 'BIsEnabled', () => music.BIsEnabled(), v => typeof v === 'boolean');
  t('music', 'GetVolume (float return)', () => music.GetVolume(), v => v >= 0 && v <= 1);

  // ISteamUGC raw layer
  t('ugc', 'GetNumSubscribedItems (uint32)', () => steam.ugc.GetNumSubscribedItems(false), v => typeof v === 'number');
  t('ugc', 'GetItemState(known CK3 item) (u64 param)', () => steam.ugc.GetItemState(3786319531n), v => typeof v === 'number');
  t('ugc', 'GetItemUpdateProgress (u64* out-params, invalid handle)', () => {
    const a = Buffer.alloc(8), b = Buffer.alloc(8);
    return steam.ugc.GetItemUpdateProgress(0xffffffffffffffffn, a, b);
  }, v => v === flat.EItemUpdateStatus.k_EItemUpdateStatusInvalid);

  // Async call results across apps (Workshop query for CK3 from a 480 session)
  const item = await steam.workshop.getItem(3786319531n, { language: 'japanese', longDescription: true });
  t('workshop', 'getItem cross-app + language (call result + struct decode)', () => item?.title, v => String(v).includes('Custom Name Lists'));
  t('workshop', 'stats decode (u64 stat out-param)', () => item?.statistics.numSubscriptions, v => (v as bigint) > 2000n);
  const page = await steam.workshop.getUserItems(1, steam.accountId(), { appId: 480 }).catch(e => e);
  t('workshop', 'getUserItems (user query flavor, own app)', () => page.totalResults, v => typeof v === 'number');

  // ISteamHTTP: create+release a request handle (no network, fully local state)
  const http = new flat.ISteamHTTP(steam.native);
  t('http', 'CreateHTTPRequest/ReleaseHTTPRequest (handle lifecycle)', () => {
    const h = http.CreateHTTPRequest(flat.EHTTPMethod.k_EHTTPMethodGET, 'https://example.invalid/');
    const released = http.ReleaseHTTPRequest(h);
    return `handle=${h} released=${released}`;
  });

  steam.close();

  for (const [i, n, r] of results) console.log(`${r.startsWith('OK') ? 'PASS' : 'FAIL'}  [${i}] ${n}: ${r}`);
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})();
