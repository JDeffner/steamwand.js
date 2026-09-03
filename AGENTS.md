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
5. **Running `pnpm test:live` casually.** It talks to the real Steam client
   on appid 480: creates a private workshop item, uploads content, sets a
   German translation, queries it back, deletes it, then round-trips the
   curated stats, cloud, leaderboards, lobbies, social, auth, system,
   capture, and controllers layers (one temp cloud file, one private
   throwaway lobby, one cancelled auth ticket). It cleans up after itself, but it
   needs a running, logged-in Steam client and it touches real Valve
   infrastructure. Run it when the change touches the runtime or a curated
   layer, not as a reflex.

## Commands

Everything is pnpm.

| command | what it does | needs |
| --- | --- | --- |
| `pnpm typecheck` | `tsc --noEmit` | nothing |
| `pnpm test` | offline layout regression tests | nothing |
| `pnpm build` | emit `dist/` via `tsconfig.build.json` | nothing |
| `pnpm generate` | rebuild `src/generated/` from the SDK | SDK unpacked at `sdk/` (see `sdk/STEAMWAND.md`) |
| `pnpm smoke` | ~30 read-only checks over 10 interfaces | running Steam client |
| `pnpm workbench` | web UI over the whole binding, for manual poking | running Steam client |
| `pnpm test:live` | workshop round trip plus checks for every other curated layer on appid 480 | running, logged-in Steam client |

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

Smallest proof that it works. For most changes that is `pnpm typecheck` and
`pnpm test`. After generator changes, also regenerate and read the diff in
`src/generated/`; the diff is the review. Reach for `pnpm smoke` when the
runtime changed, `pnpm test:live` when a curated layer or the dispatch pump
changed, and the workbench when you need to poke one call by hand. Do not
add new smoke checks or live tests to prove a refactor; the existing ones
already cover the surface.

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
- Development happens on Windows; the Steam client is usually running, so
  `pnpm smoke` is a cheap live sanity check. Still ask before `pnpm test:live`
  unless the task is explicitly about the workshop layer.
- The local `sdk/` directory often contains an unpacked SDK. It is gitignored
  along with the SDK zip; never stage either, and never quote SDK header
  contents into committed files.
- pnpm 11 holds back packages published in the last day. Right after a
  dependency bump, install once with `--config.minimumReleaseAge=0`; do not
  put that override in the repo config.
- Prefer editing `scripts/generate.ts` and regenerating over any change
  inside `src/generated/`, even for a one-character fix.
