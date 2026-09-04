# Contributing

steamwand.js is TypeScript bindings for the Steamworks SDK with no native build
step. A generator reads Valve's `steam_api.json` and emits the whole binding
layer; calls go through [koffi](https://koffi.dev) FFI at runtime, and fifteen
curated layers under `src/api/` cover the flows most games need.

## The rule that shapes everything

This repo has zero native code of its own and must keep it that way. Every
other Node Steamworks binding asks you to compile C++ or Rust to add a
function; steamwand exists so you do not have to. A change that needs a `.cpp`
file, node-gyp, napi-rs, or a prebuild matrix is the wrong change here. The
answer is more generator, more koffi, or a documented skip.
[AGENTS.md](AGENTS.md) explains the reasoning and the traps around it.

## Setup

You need Node 20 or newer and pnpm.

```
pnpm install
pnpm typecheck
pnpm test
```

That is enough for most work. Regenerating the binding layer also needs the
Steamworks SDK, which is not in this repo and must never be committed: Valve's
license does not allow redistributing the headers or `steam_api.json`. Download
it from [partner.steamgames.com](https://partner.steamgames.com/downloads/list)
and unpack it to `sdk/`, which is gitignored apart from
[`sdk/STEAMWAND.md`](sdk/STEAMWAND.md). That file has the exact paths, the hash
checks, and what to update on an SDK bump.

Never hand-edit anything under `src/generated/`. It is the output of
`scripts/generate.ts` and the next `pnpm generate` overwrites it. Fix the
generator instead, even for a one-character change.

## Commands

| command | what it does | needs |
| --- | --- | --- |
| `pnpm typecheck` | `tsc --noEmit` | nothing |
| `pnpm test` | offline layout regression tests | nothing |
| `pnpm build` | emit `dist/` via `tsconfig.build.json` | nothing |
| `pnpm generate` | rebuild `src/generated/` from the SDK | SDK unpacked at `sdk/` (see `sdk/STEAMWAND.md`) |
| `pnpm smoke` | ~30 read-only checks over 10 interfaces | running Steam client |
| `pnpm workbench` | web UI over the whole binding, for manual poking | running Steam client |
| `pnpm test:live` | workshop round trip plus checks for every other curated layer on appid 480 | running, logged-in Steam client |

## Verifying a change

Find the smallest proof that it works.

- Most changes: `pnpm typecheck` and `pnpm test`.
- Generator changes: regenerate and read the diff in `src/generated/`. The diff
  is the review. If it touches files you did not expect, find out why before
  committing. `test/offsets.test.ts` and `test/offsets.curated.test.ts` pin the struct offsets and are
  the first thing to run after any generator or SDK change.
- Runtime changes: add `pnpm smoke`.
- Curated layer or dispatch pump changes: `pnpm test:live`. It needs a running,
  logged-in Steam client and it talks to real Valve infrastructure on appid 480
  (Spacewar). It creates and deletes a private workshop item, one temporary
  cloud file, one throwaway lobby, and one cancelled auth ticket, and it cleans
  up after itself. Run it when the change warrants it, not by reflex.

An FFI mistake crashes the Node process instead of throwing. When a live script
dies with no stack trace, suspect the binding layer, not the test.

## Adding a curated layer

The generated layer already exposes all 807 functions, so a curated wrapper has
to earn its place. Good reasons: a multi-step flow, an out-buffer that is easy
to get wrong, a per-language variant. Renaming one call is not a reason.
`src/api/workshop.ts` is the style template.

Curated layers throw the typed errors from `src/api/errors.ts` with the
`EResult` attached; the generated layer returns whatever Valve returns,
uninterpreted. Keep that line sharp. 64-bit Steam values are `bigint`
everywhere, never `number` and never a string.

A curated layer must not shadow a generated accessor. `friends`, `user`,
`utils`, `screenshots`, `input`, and `apps` are already taken, which is why the
DLC layer lives at `steam.dlc`.

## Commits

Lower case, imperative, plain, matching the existing log. For example:
`workshop: read back metadata and key/value tags`.

## Releasing

1. Bump `version` in `package.json`.
2. Add the section to [CHANGELOG.md](CHANGELOG.md) and move anything under
   Unreleased into it.
3. Commit and push to `main`.
4. Push a `vX.Y.Z` tag.

`.github/workflows/publish.yml` runs on the tag. It refuses a tag that is not
an ancestor of `main` or that does not match `package.json`, then typechecks,
tests, builds, and publishes to npmjs with provenance, and to GitHub Packages
as `@jdeffner/steamwand.js`.
