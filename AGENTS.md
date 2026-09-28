# steamwand.js agent guide

steamwand is TypeScript bindings for the Steamworks SDK with no native build
step. A generator reads `steam_api.json` (Valve's machine-readable description
of the flat C API) and emits a full TS binding layer; calls go through
[koffi](https://koffi.dev) FFI at runtime. On top of that sits a small
handwritten runtime (library loader, callback dispatch pump, struct decoder)
and twelve curated ergonomic layers: `workshop`, `stats`, `cloud`,
`leaderboards`, `lobbies`, `social`, `overlay`, `auth`, `system`, `capture`,
`controllers`, and `dlc`.

Treat these instructions as good defaults, not hard rules. When the developer
asks for something that contradicts them, the developer wins.

## The one idea that must survive every change

This project exists because every other Node Steamworks binding makes you
compile someone else's native code to add a function. steamwand has zero
native code of its own and must stay that way. If a change needs a `.cpp`
file, node-gyp, napi-rs, or a prebuild matrix, the change is wrong for this
repo. The answer is always more generator, more koffi, or a documented skip.

## Ways to hurt yourself

1. **Editing `src/generated/` by hand.** Everything under that directory is
   the output of `scripts/generate.ts` and dies on the next `pnpm generate`.
   Fix the generator, regenerate, and read the diff. If the diff touches
   files you did not expect, stop and find out why before committing.
2. **Committing the SDK.** Valve's license forbids redistributing the SDK
   headers and `steam_api.json`. `sdk/` is gitignored except for its
   `STEAMWAND.md`, and the `steamworks_sdk_*.zip` at the repo root must never
   be committed either. The five redistributable binaries under `runtime/`
   are the only Valve files allowed in git.
3. **Guessing a struct layout.** The per-platform offset tables in
   `src/generated/structs.ts` are load-bearing: a wrong offset reads garbage
   or crashes, and nothing warns you. Windows packs callback structs at 8
   bytes, Linux and macOS at 4, `CSteamID` at 1. Structs with C unions are
   excluded on purpose because `steam_api.json` cannot express them; do not
   "helpfully" add a layout for one. `test/offsets.test.ts` pins the workshop
   set and is the first thing to run after any generator or SDK change.
4. **Forgetting that FFI failures are fatal.** A bad signature or pointer
   crashes the Node process. It does not throw. When a live script dies with
   no stack trace, suspect the binding layer, not the test.
5. **Treating live tests as disposable local tests.** They use the real Steam client and Valve services. `pnpm test:live` runs reads on app ID 480. `pnpm test:live:write` also writes one unique cloud file and presence key, creates a private lobby, issues two auth tickets, and changes local controller and screenshot-hook state. `pnpm test:workshop` runs a separate private upload lifecycle. Cleanup is attempted, not guaranteed. Select the test that proves the change; do not run live writes as a default check.

## Commands

Everything is pnpm.

| command | what it does | needs |
| --- | --- | --- |
| `pnpm typecheck` | `tsc --noEmit` | nothing |
| `pnpm test` | offline layouts, dispatch, native close guards, platform, out-buffer, API contract, and test-workflow checks; excludes live files even if live flags are inherited | installed dependencies, no Steam client |
| `pnpm build` | emit `dist/` via `tsconfig.build.json` | nothing |
| `pnpm generate` | rebuild `src/generated/` from the SDK | SDK unpacked at `sdk/` (see `sdk/STEAMWAND.md`) |
| `pnpm smoke` | read-only generated-surface checks with account-specific fixtures | logged-in Steam client, CK3 owned and installed, the script's referenced Workshop item available |
| `pnpm workbench` | web UI over the whole binding, for manual poking | running Steam client |
| `pnpm test:live` | live reads on app ID 480; explicitly disables write tests | running, logged-in Steam client |
| `pnpm test:live:write` | curated live reads and writes on app ID 480; excludes Workshop uploads | authorized account, `STEAM_TEST_STEAM_ID` |
| `pnpm test:workshop` | private create, upload, translations, metadata, preview, download verification, delete | authorized account, `STEAM_TEST_STEAM_ID`, `STEAM_TEST_APP_ID`; see below |

## Where code lives

- `src/runtime/` is the handwritten core: `native.ts` loads the Valve
  library, `platform.ts` picks the binary, `dispatch.ts` pumps Valve's manual
  dispatch API and turns call results into promises, `struct.ts` decodes
  callback structs from the offset tables. All of it together is about 650
  lines. Keep it that size; complexity belongs in the generator, which runs
  offline, not in the runtime, which runs in someone's game.
- `src/api/` is the curated layer: `workshop.ts`, `stats.ts`, `cloud.ts`,
  `leaderboards.ts`, `lobbies.ts`, `social.ts`, `overlay.ts`, `auth.ts`,
  `system.ts`, `capture.ts`, `controllers.ts`, `apps.ts` (exposed as `dlc`),
  the shared `ok`/`must` guards in `guards.ts`, and the typed errors in
  `errors.ts`. This is the only place where ergonomics beat fidelity.
  `workshop.ts` is the style template the others were written against. A
  curated layer whose natural name is taken by a generated accessor
  (`friends`, `user`, `utils`, `screenshots`, `input`, `apps`) gets a
  different one; do not shadow the generated accessors.
- `src/generated/` is generator output only: enums, consts, callback structs,
  offset tables, and one class per interface under `interfaces/`.
- `scripts/generate.ts` is the generator itself. It hashes `steam_api.json`
  against `sdk.lock.json` and warns on mismatch; take the warning seriously,
  it means the SDK moved.
- `runtime/` (repo root, not `src/runtime/`) holds Valve's redistributable
  binaries. Only touch it during an SDK bump, following `sdk/STEAMWAND.md`.
- `test/offsets.test.ts` runs offline; `test/live/` needs Steam.

## Verifying a change

Run `pnpm typecheck`, `pnpm test`, and `pnpm build` for code changes. CI runs these on Windows, Linux, and macOS. `test/types.test.ts` contains compile-time assertions enforced by typecheck, not by Vitest alone. After generator or SDK changes, regenerate, run `pnpm exec vitest run test/offsets.test.ts` first, then run the full checks and inspect the generated diff.

For runtime changes, use live reads or smoke when its account-specific prerequisites are met. For changed write behavior, select the affected live suite after authorization. Use the workbench for a call that needs manual inspection. Existing tests cover selected flows, not every generated function or curated behavior. Controller checks without hardware, the overlay enabled flag, and screenshot-hook checks do not verify real controller input, rendering, or screenshot capture. Add focused outcome tests when a changed contract lacks coverage; do not duplicate coverage just for a refactor.

### Live test authorization and setup

Only the exact value `1` enables `STEAM_LIVE` or `STEAM_LIVE_WRITE`; writes require both. The package scripts set these flags for their selected mode and serialize live test files. Do not run another live test process or the workbench at the same time. Ordinary CI stays offline. Do not add scheduled uploads, load tests, automated agreement acceptance, or account creation. Valve documents developer test uploads, but that is not blanket permission for unattended automation. Get Steamworks clarification for that use case.

For write tests, the maintainer sets `STEAM_TEST_STEAM_ID` to the authorized account's SteamID64. This is a public identifier, not a credential. The test checks the logged-in account and app before any test writes. The user logs into Steam themselves; never collect or store Steam passwords in scripts or test output. `pnpm test:workshop` also requires `STEAM_TEST_APP_ID`, with no default. Set `480` explicitly for the Spacewar development example, or use an authorized app you control. The other curated live suites remain on 480 because their stats and leaderboard fixtures depend on it.

For an app you control, enable ISteamUGC and preview-storage quotas and restrict Workshop access to developers or a selected tester group where appropriate. A game beta branch does not by itself configure Workshop visibility. Use an account with the required app license and permissions; Family Sharing and Free Weekend licenses cannot upload. Handle both the app Workshop EULA and `legalAgreementRequired` from creation and updates. If acceptance is needed, stop and let the user accept in Steam. Never bypass account restrictions or retry permission and quota failures in a loop.

PowerShell setup for an authorized Workshop run:

```powershell
$env:STEAM_TEST_STEAM_ID = '<authorized SteamID64>'
$env:STEAM_TEST_APP_ID = '<authorized app ID, or 480 explicitly>'
pnpm test:workshop
```

For a single curated file, use its exact path rather than appending a filter to a package command that already selects `test/live`:

```powershell
pnpm exec cross-env STEAM_LIVE=1 STEAM_LIVE_WRITE=1 vitest run test/live/auth.live.test.ts --no-file-parallelism
```

The Workshop test uses one small fixture and forces private visibility on every update. It checks the item owner, consumer app, visibility, translated text, metadata, and preview; then it downloads the content and compares the bytes before deletion. It checks app dependencies with 481 when testing 480. For another app, set `STEAM_TEST_DEPENDENCY_APP_ID` to include that check; otherwise the test reports that it omitted it. Test only content you have rights to upload. Never upload an entire repository, personal files, or a real mod directory as a test fixture. Use mocks for error combinations and stress tests. The live workflow does not automatically retry writes.

### Workshop failure recovery

`.steamwand-live/workshop/recovery.json` records the app, account, start time, current operation, and item ID as soon as creation returns. IDs are decimal strings in JSON to preserve all 64 bits. The directory is gitignored and blocks another Workshop run, including a run in another process using this checkout. Keep it while a run is active or its remote outcome is unresolved.

Each Workshop call has a deadline. An upload cannot be cancelled after submission. On timeout or an uncertain API-call result, the test stops, preserves the record and upload files, and sends no deletion or retry. Other failures attempt deletion of the one recorded item. Failed deletion fails the test and keeps the record. Successful cleanup removes the local fixture directory. The test does not remove Steam's download cache.

To recover, first ensure the test process has stopped and inspect the recorded operation. Use the recorded account and app to inspect the exact item in Steam; confirm ownership and that it is the test fixture before deleting it. Wait for any upload to settle before deleting. Check `Steam/workshopbuilds/depot_build_<appid>.log` for uploads and `Steam/logs/Workshop_log.txt` for downloads. If creation failed before an ID was returned, inspect that account's recent items and logs; do not bulk-delete by a title prefix. After confirming that the remote fixture is gone (or no item was created), remove only this checkout's `.steamwand-live/workshop` directory. Never erase the recovery record merely to make the next run start.

Policy sources checked on 2026-09-28: [Workshop implementation, test uploads, agreements, logs, and upload cancellation](https://partner.steamgames.com/doc/features/workshop/implementation), [Workshop testing and license requirements](https://partner.steamgames.com/doc/features/workshop), [ISteamUGC callbacks and downloads](https://partner.steamgames.com/doc/api/ISteamUGC), [Steam Subscriber Agreement](https://store.steampowered.com/subscriber_agreement/english), and [Steam Online Conduct](https://store.steampowered.com/online_conduct/). Private visibility and app ID 480 do not exempt tests from these terms. This workflow is a development safeguard, not a guarantee of compliance for every use.

## Taste

- 64-bit Steam values (Steam ids, file ids, UGC handles) are `bigint`
  everywhere. Never `number`, never a string.
- The curated layer throws the typed errors from `src/api/errors.ts` with the
  `EResult` attached. The generated layer returns whatever Valve returns,
  uninterpreted. Do not blur that line in either direction.
- New curated wrappers need a reason. The generated layer already exposes all
  807 functions; a wrapper earns its place by fixing real ergonomics (multi
  step flows, out-buffers, per-language variants), not by renaming one call.
- The generated layer's out-buffer parameters stay raw `Buffer`s plus the
  `out` helpers. Emitting value-returning variants for all 221 of them was
  considered for 0.3 and rejected: it doubles the generated surface and the
  SDK-bump churn, and the curated layers cover the flows that hurt.
  Ergonomics wins go into curated layers, one domain at a time.
- Public docs live in the GitHub wiki and in the generated doc comments
  (each function carries its C signature and a link to Valve's docs). The
  README is the front door; keep it honest about limits, including the list
  of skipped functions and the union-struct exclusion.
- Commit messages follow the existing log: lower case, imperative, plain.

## Development
- Development happens on Windows. Check Steam and fixture prerequisites before live reads. Ask before live writes unless the user has already authorized the specific write test in this session or the task explicitly requests a Workshop round trip. A request to edit testing documentation or its harness does not itself request a live upload.
- The local `sdk/` directory often contains an unpacked SDK. It is gitignored
  along with the SDK zip; never stage either, and never quote SDK header
  contents into committed files.
- Prefer editing `scripts/generate.ts` and regenerating over any change
  inside `src/generated/`, even for a one-character fix.
