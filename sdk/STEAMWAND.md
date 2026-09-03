# sdk/
`sdk/` is empty on purpose. The Steamworks SDK is licensed by Valve and is not
redistributable, so it stays out of git. This file is here so the folder, and
this explanation, arrive with a clone.

You need the SDK for one thing: `pnpm generate`, which rebuilds
`src/generated/` from the SDK's `steam_api.json`. Building the package,
running the tests, the smoke script, and the workbench all work without it.

## Putting it in place

The pinned version is in [`sdk.lock.json`](../sdk.lock.json): **SDK 1.65**.

1. Download `steamworks_sdk_165.zip` from
   [partner.steamgames.com/downloads/list](https://partner.steamgames.com/downloads/list).
   A Steamworks account is required.
2. Unzip it at the repo root. The archive's top-level folder is already named
   `sdk/`, so the contents land exactly where the generator looks.
3. Confirm that `sdk/public/steam/steam_api.json` exists.

`pnpm generate` exits with an error naming the path it wanted if the file is
missing. To keep the SDK elsewhere, point `STEAMWORKS_SDK` at your copy:

```bash
npx cross-env STEAMWORKS_SDK=D:/steamworks_sdk pnpm generate
```

## Checking what you downloaded

`sdk.lock.json` records the sha256 of the zip and of `steam_api.json`. Verify
the download before you trust it:

```bash
sha256sum steamworks_sdk_165.zip
```

That must print `8c42792e09100988e31e3dc069de2eb1bc60702a0445bb37298ba0c54067c202`.

The generator hashes `steam_api.json` on every run and prints a warning when it
does not match the lock. It still generates. Treat the warning as a prompt to
read the diff carefully, because the SDK moved under you.

## Bumping the SDK version

The five native files under `runtime/` are committed, and they come
straight out of the same archive:

| in the zip | in this repo |
| --- | --- |
| `sdk/redistributable_bin/win64/steam_api64.dll` | `runtime/win64/steam_api64.dll` |
| `sdk/redistributable_bin/win64/steam_api64.lib` | `runtime/win64/steam_api64.lib` |
| `sdk/redistributable_bin/linux64/libsteam_api.so` | `runtime/linux64/libsteam_api.so` |
| `sdk/redistributable_bin/linuxarm64/libsteam_api.so` | `runtime/linuxarm64/libsteam_api.so` |
| `sdk/redistributable_bin/osx/libsteam_api.dylib` | `runtime/osx/libsteam_api.dylib` |

A bump is therefore: unzip the new SDK, copy those five files across, update
all three fields in `sdk.lock.json`, run `pnpm generate`, then read the diff in
`src/generated/`. Callback struct offsets change between SDK versions, so
`test/offsets.test.ts` is the first thing to run afterwards.
