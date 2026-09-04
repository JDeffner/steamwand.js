<p align="center">
  <img src="https://raw.githubusercontent.com/JDeffner/steamwand.js/main/assets/banner.png" alt="steamwand">
</p>

[![npm](https://img.shields.io/npm/v/steamwand.js?logo=npm&logoColor=white&color=cb3837)](https://www.npmjs.com/package/steamwand.js)
[![CI](https://github.com/JDeffner/steamwand.js/actions/workflows/ci.yml/badge.svg)](https://github.com/JDeffner/steamwand.js/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/steamwand.js?logo=nodedotjs&logoColor=white&color=5FA04E)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/steamwand.js?color=blue)](LICENSE)
[![Discord](https://img.shields.io/badge/Discord-join-5865F2?logo=discord&logoColor=white)](https://discord.gg/DfEJ2H9hj4)

TypeScript bindings for the Steamworks SDK with no native build step. The
binding layer is generated from `steam_api.json`, Valve's own machine-readable
description of the flat C API, and called through [koffi](https://koffi.dev)
FFI. When a new SDK ships, you regenerate; when you need a function nobody
wrapped yet, it is already there.

## Why another Steamworks binding

Every existing Node binding makes you compile someone else's native code to
add a function. greenworks is NAN-era C++ built on the pre-2014 RemoteStorage
workshop API. steamworks.js is solid but every contribution means Rust,
napi-rs, and a three-platform build matrix; adding one setter
(`SetItemUpdateLanguage`) took two forked repos and a patch file. steamwand
has no native code of its own. One generic FFI dependency, one generated TS
layer, and the whole flat API surface: 25 interfaces, 807 functions,
191 callback structs with per-platform offset tables.

## Install

```
pnpm add steamwand.js
```

Node 20+. Windows x64, Linux x64, Linux ARM64, and macOS (x64 and Apple
silicon, one universal library) are wired up; the Steam client must be
running. The `steam_api` redistributables ship in the package. koffi's own
native binary comes as a separate `@koromix/koffi-<os>-<arch>` package next to
`koffi` in `node_modules`, so a bundler or Electron packager rule that only
keeps `steamwand.js/**` must also keep `koffi/**` and `@koromix/**`.

[CHANGELOG.md](CHANGELOG.md) records what each release changed.

## Documentation

Full docs are in the [wiki](https://github.com/JDeffner/steamwand.js/wiki):
[getting started](https://github.com/JDeffner/steamwand.js/wiki/Getting-Started),
the [core API](https://github.com/JDeffner/steamwand.js/wiki/Core-API), the
curated [workshop](https://github.com/JDeffner/steamwand.js/wiki/Workshop),
[stats](https://github.com/JDeffner/steamwand.js/wiki/Stats),
[cloud](https://github.com/JDeffner/steamwand.js/wiki/Cloud),
[leaderboards](https://github.com/JDeffner/steamwand.js/wiki/Leaderboards), and
[lobbies](https://github.com/JDeffner/steamwand.js/wiki/Lobbies),
[social](https://github.com/JDeffner/steamwand.js/wiki/Social),
[overlay](https://github.com/JDeffner/steamwand.js/wiki/Overlay),
[auth](https://github.com/JDeffner/steamwand.js/wiki/Auth),
[system](https://github.com/JDeffner/steamwand.js/wiki/System),
[capture](https://github.com/JDeffner/steamwand.js/wiki/Capture),
[controllers](https://github.com/JDeffner/steamwand.js/wiki/Controllers),
[DLC](https://github.com/JDeffner/steamwand.js/wiki/DLC),
[inventory](https://github.com/JDeffner/steamwand.js/wiki/Inventory),
[P2P](https://github.com/JDeffner/steamwand.js/wiki/P2P), and
[recording](https://github.com/JDeffner/steamwand.js/wiki/Recording) layers, the
[raw flat API](https://github.com/JDeffner/steamwand.js/wiki/Flat-API),
[recipes](https://github.com/JDeffner/steamwand.js/wiki/Recipes), and
[troubleshooting](https://github.com/JDeffner/steamwand.js/wiki/Troubleshooting).
Every generated function also carries its original C signature, its out-buffer
sizes, and a link to Valve's documentation, so hovering it in an editor is
usually enough. To work on steamwand itself, start at
[CONTRIBUTING.md](CONTRIBUTING.md).

## Use

```ts
import { init, flat } from 'steamwand.js';

const steam = init({ appId: 480 });

// Curated workshop layer
const { fileId } = await steam.workshop.createItem();
await steam.workshop.submitUpdate(fileId, {
  title: 'My mod',
  description: 'Full description',
  contentPath: 'C:/mods/my-mod',
  tags: ['gameplay'],
  changeNote: 'first upload',
}, { onProgress: (p) => console.log(p.status, p.bytesProcessed) });

// Per-language text, the thing that started this project
await steam.workshop.submitUpdate(fileId, {
  language: 'german',
  title: 'Mein Mod',
  description: 'Deutsche Beschreibung',
});

const item = await steam.workshop.getItem(fileId, { language: 'german' });

// Workshop item wiring: required DLC, collection children, extra previews,
// metadata and key/value tags, plus the running app's DLC list
await steam.workshop.addAppDependency(fileId, 1_234_567);
await steam.workshop.addDependency(9_876_543_210n, fileId); // collection, child
await steam.workshop.submitUpdate(fileId, {
  metadata: JSON.stringify({ buildId: 42 }),
  keyValueTags: { engineVersion: '1.14' },
  previewImages: ['C:/mods/my-mod/screenshot.png'],
  previewVideos: ['dQw4w9WgXcQ'],
});
const full = await steam.workshop.getItem(fileId, { children: true, additionalPreviews: true });

// The player side of the workshop: browse, subscribe, download, load from disk
const trending = await steam.workshop.browse({ queryType: flat.EUGCQuery.k_EUGCQuery_RankedByTrend, trendDays: 7 });
await steam.workshop.subscribe(trending.items[0].fileId);
await steam.workshop.download(trending.items[0].fileId, { onProgress: (p) => console.log(p.bytesDownloaded) });
for (const id of steam.workshop.listSubscribed()) console.log(steam.workshop.getInstallInfo(id)?.path);
const dlc = steam.dlc.listDlc();

// Achievements, stats, cloud saves, leaderboards, lobbies: same treatment
steam.stats.unlock('ACH_WIN_ONE_GAME');
await steam.cloud.writeFile('save01.json', JSON.stringify({ level: 3 }));
const board = await steam.leaderboards.findOrCreate('Fastest Lap', 1, 3);
await steam.leaderboards.uploadScore(board.handle, 91_240);
const lobbyId = await steam.lobbies.create(2, 4);
steam.lobbies.setData(lobbyId, 'map', 'de_dust2');

// Friends, rich presence, overlay, auth tickets, system facts, Steam Input
const friends = steam.social.listFriendsInGame();
steam.social.setRichPresence('status', 'In the menu');
steam.overlay.activateInviteDialog(lobbyId);
const { hex } = await steam.auth.getWebApiTicket('my-backend');
if (steam.system.isSteamDeck()) steam.controllers.init();

// Inventory Service items, P2P packets, Game Recording timeline events
const inventory = await steam.items.getAll();
steam.p2p.send(friends[0].steamId, JSON.stringify({ hello: 1 }));
steam.recording.addEvent({ title: 'Boss down', description: 'Act 1', icon: 'steam_trophy' });

// The raw generated layer, when the curated ones stop
const ticket = steam.apps.GetAppOwner();
steam.on('ItemInstalled_t', (data) => console.log('installed', data));
const found = await steam.async.userStats.FindLeaderboard('Fastest Lap');

steam.close();
```

Fifteen curated layers (`workshop`, `stats`, `cloud`, `leaderboards`,
`lobbies`, `social`, `overlay`, `auth`, `system`, `capture`, `controllers`,
`dlc`, `items`, `p2p`, `recording`) cover the flows most games need, with
typed errors that carry the `EResult`. For everything else, `steam.async` wraps each of the 76 call-result
functions as a promise, `steam.on` and `steam.once` give typed callbacks by
struct name, and the `out` helpers make the flat API's out-buffers safe. 64-bit values (Steam ids, file
ids, handles) are `bigint` everywhere. The dispatch pump checks every async
result against the callback id the caller expected, so a mixed-up completion
rejects instead of decoding garbage.

## What is generated, what is not

`scripts/generate.ts` reads `steam_api.json` and emits `src/generated/`:
enums, consts, one class per interface with its versioned accessor
(`SteamAPI_SteamUGC_v021`, so an SDK bump is a regeneration, not an
archaeology project), and struct layouts as explicit per-platform offset
tables. Windows packs callback structs at 8 bytes, Linux and macOS at 4,
`CSteamID` is pack(1); the generator encodes those rules and its output has
been verified against steamworks-sys's bindgen layouts, 428 comparisons with
zero differences. `test/offsets.test.ts` and `test/offsets.curated.test.ts` pin every struct the curated layers decode so a future
SDK bump cannot silently shift an offset.

Handwritten and small: the library loader, the dispatch pump, the struct
decoder, and the fifteen curated layers under `src/api/`. After `close()`,
every call through the session throws instead of reaching the unloaded API.

The SDK itself is not in this repo and must not be committed; Valve's license
does not allow redistributing the headers or `steam_api.json`. To regenerate,
download the SDK from
[partner.steamgames.com](https://partner.steamgames.com/downloads/list),
unpack it to `sdk/` (gitignored apart from the STEAMWAND.md file), and run
`pnpm generate`. [`sdk/STEAMWAND.md`](sdk/STEAMWAND.md) has the exact paths, the
hash checks, and what to update on a version bump. `sdk.lock.json` records
which SDK version and `steam_api.json` hash the committed output came from.
Shipping the redistributable binaries (`steam_api64.dll` and friends) is
normal practice and allowed.

## Known limits

- 12 of the 819 flat functions are skipped: 9 that take C function pointers
  (debug hooks, netsockets status callbacks) and 3 whose by-value struct the
  generator cannot prove safe (`SteamIPAddress_t` is a C union,
  `SteamPartyBeaconLocation_t` packs differently per platform). The Steam
  Input action-data calls, skipped before 0.3, are bound. The generator lists
  every remaining skip when it runs.
- Structs containing C unions (`SteamNetworkingIdentity` and relatives) get
  no layout table, because `steam_api.json` cannot express unions and a
  guessed layout would read garbage. They are excluded loudly, not wrongly.
- An FFI mistake crashes the process instead of throwing. If you embed this
  in something that must survive (a VS Code extension, an editor), run it in
  a child process. That is how the CK3 modding toolkit uses it.
- Game server APIs are not wired up. `ISteamNetworkingSockets` and
  `ISteamNetworkingMessages` take `SteamNetworkingIdentity`, one of the union
  structs above, so only their generated methods that avoid it are usable.
  The curated `p2p` layer sits on the older `ISteamNetworking` P2P calls,
  which Valve has deprecated but still ships and still routes through the
  Steam relay network.
- The Steam overlay draws into the game's own renderer. Node has none, so an
  Electron app gets no overlay from this package; that needs a native hook.

## Tests

`pnpm test` runs offline (layout regression, dispatch pump, platform, and
close-guard tests). `pnpm test:live` runs against the running Steam client on
appid 480 (Spacewar): the full workshop round trip (create a private item,
upload content and a preview image, set a German translation, metadata and
key/value tags, an app dependency, query everything back, subscribe, download,
find it on disk, unsubscribe, delete the item) plus checks for the stats,
cloud, leaderboards, lobbies, social, auth, system, capture, controllers,
items, and recording layers (one temporary cloud file, one private throwaway
lobby, one cancelled auth ticket, one timeline event). It cleans up after
itself.

## License

MIT for the code here. The Steamworks redistributables in `runtime/` are
Valve's, under the Steamworks SDK Access Agreement.
