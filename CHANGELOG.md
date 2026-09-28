# Changelog

## 0.6.0 (2026-09-28)

### Workshop fixes

- [#16](https://github.com/JDeffner/steamwand.js/issues/16): Queries with `additionalPreviews: true` reject if any preview cannot be read. Returned previews include their original Steam `index` for use in `removePreviewIndexes`.
- [#17](https://github.com/JDeffner/steamwand.js/issues/17): Item rows with a non-OK result reject with `SteamResultError`, including the result code and row context. File-not-found rows remain omitted. A false row getter rejects instead of appearing as a missing item. A failed row rejects the whole page.
- [#18](https://github.com/JDeffner/steamwand.js/issues/18): Query handles are released after option setup failures. Invalid allocation handles are rejected without use or release. A cleanup failure does not replace the original query error.
- [#19](https://github.com/JDeffner/steamwand.js/issues/19): Upload paths are validated before an update starts. Content must be a readable directory; previews must be readable regular files. Paths must be absolute. Symlinks are followed, and filesystem errors retain their original cause.
- [#20](https://github.com/JDeffner/steamwand.js/issues/20): Added `getAppDependenciesResult()` and the exported `AppDependenciesResult` type, with `appIds`, `totalCount`, and `complete`. Invalid counts are rejected before reading beyond the result buffer.

### Migration

`getAppDependencies()` still returns `number[]`, but is deprecated because it cannot report truncation. Use `getAppDependenciesResult()` and check `complete` before replacing or reconciling app requirements. Steam returns at most 32 IDs and provides no pagination for this call.

Queries that previously returned partial galleries or silently skipped failed item reads now reject. Handle these failures before using query results to prepare an update. Test fixtures that construct `AdditionalPreview` values must include `index`.

Relative upload paths now fail validation. Resolve them with `node:path.resolve()` before calling `submitUpdate()`. Path checks do not validate image formats or sizes, inspect every content file, or prevent later filesystem changes.

### Change notes

[#15](https://github.com/JDeffner/steamwand.js/issues/15): Documented the localized change-note limitation. No supported API for translating one existing history entry was found in the reviewed Valve documentation. The README shows one change note with language-labeled sections sent with the content upload. The `language` option continues to select titles and descriptions only.

### Verification

Added offline regression tests for query cleanup, item errors, gallery completeness, upload paths, and dependency counts, plus compile-time checks for the new public types. Updated the live Workshop test to use the new result contract. Live Steam behavior was not tested for this release preparation.
