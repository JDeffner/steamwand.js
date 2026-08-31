# steamwand

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
layer, and the whole flat API surface: 25 interfaces, 801 functions,
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
[workshop layer](https://github.com/JDeffner/steamwand.js/wiki/Workshop), the
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

// The raw generated layer, when the curated one stops
const ticket = steam.apps.GetAppOwner();
steam.on('ItemInstalled_t', (data) => console.log('installed', data));

steam.close();
```

Async Steam calls come back as promises through Valve's manual dispatch API.
64-bit values (Steam ids, file ids, handles) are `bigint` everywhere.

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
decoder, and the ergonomic `workshop` layer.

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

- 18 of the 819 flat functions are skipped: those taking C function pointers
  (debug hooks, netsockets status callbacks) or passing structs by value
  (Steam Input action data). The generator lists every skip when it runs.
- Structs containing C unions (`SteamNetworkingIdentity` and relatives) get
  no layout table, because `steam_api.json` cannot express unions and a
  guessed layout would read garbage. They are excluded loudly, not wrongly.
- An FFI mistake crashes the process instead of throwing. If you embed this
  in something that must survive (a VS Code extension, an editor), run it in
  a child process. That is how the CK3 modding toolkit uses it.
- Game server APIs are not wired up.

## Tests

`pnpm test` runs offline (layout regression tests). `pnpm test:live` runs the
full workshop round trip against the running Steam client on appid 480
(Spacewar): create a private item, upload content, set a German translation,
query both languages back, delete the item. It cleans up after itself.

## License

MIT for the code here. The Steamworks redistributables in `runtime/` are
Valve's, under the Steamworks SDK Access Agreement.
