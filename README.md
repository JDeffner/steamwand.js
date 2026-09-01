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

Node 18+. Windows x64, Linux x64, and macOS are wired up; the Steam client
must be running. The `steam_api` redistributables ship in the package.

## Documentation

Full docs are in the [wiki](https://github.com/JDeffner/steamwand.js/wiki):
[getting started](https://github.com/JDeffner/steamwand.js/wiki/Getting-Started),
the [core API](https://github.com/JDeffner/steamwand.js/wiki/Core-API), the
curated [workshop](https://github.com/JDeffner/steamwand.js/wiki/Workshop),
[stats](https://github.com/JDeffner/steamwand.js/wiki/Stats),
[cloud](https://github.com/JDeffner/steamwand.js/wiki/Cloud),
[leaderboards](https://github.com/JDeffner/steamwand.js/wiki/Leaderboards), and
[lobbies](https://github.com/JDeffner/steamwand.js/wiki/Lobbies) layers, the
[raw flat API](https://github.com/JDeffner/steamwand.js/wiki/Flat-API),
[recipes](https://github.com/JDeffner/steamwand.js/wiki/Recipes), and
[troubleshooting](https://github.com/JDeffner/steamwand.js/wiki/Troubleshooting).
Every generated function also carries its original C signature, its out-buffer
sizes, and a link to Valve's documentation, so hovering it in an editor is
usually enough.

## Use

```ts
import { init } from 'steamwand.js';

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

// Achievements, stats, cloud saves, leaderboards, lobbies: same treatment
steam.stats.unlock('ACH_WIN_ONE_GAME');
await steam.cloud.writeFile('save01.json', JSON.stringify({ level: 3 }));
const board = await steam.leaderboards.findOrCreate('Fastest Lap', 1, 3);
await steam.leaderboards.uploadScore(board.handle, 91_240);
const lobbyId = await steam.lobbies.create(2, 4);
steam.lobbies.setData(lobbyId, 'map', 'de_dust2');

// The raw generated layer, when the curated ones stop
const ticket = steam.apps.GetAppOwner();
steam.on('ItemInstalled_t', (data) => console.log('installed', data));
const found = await steam.async.userStats.FindLeaderboard('Fastest Lap');

steam.close();
```

Five curated layers (`workshop`, `stats`, `cloud`, `leaderboards`, `lobbies`)
cover the flows most games need, with typed errors that carry the `EResult`.
For everything else, `steam.async` wraps each of the 76 call-result functions
as a promise, `steam.on` gives typed callbacks by struct name, and the `out`
helpers make the flat API's out-buffers safe. 64-bit values (Steam ids, file
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
zero differences. `test/offsets.test.ts` pins the workshop set so a future
SDK bump cannot silently shift an offset.

Handwritten and small: the library loader, the dispatch pump, the struct
decoder, and the five curated layers under `src/api/`.

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
- Game server APIs are not wired up.

## Tests

`pnpm test` runs offline (layout regression tests). `pnpm test:live` runs
against the running Steam client on appid 480 (Spacewar): the full workshop
round trip (create a private item, upload content, set a German translation,
query both languages back, delete the item) plus checks for the stats, cloud,
leaderboards, and lobbies layers (one temporary cloud file, one private
throwaway lobby). It cleans up after itself.

## License

MIT for the code here. The Steamworks redistributables in `runtime/` are
Valve's, under the Steamworks SDK Access Agreement.
