# Bundle Reason Attribution — Design Spec

**Date:** 2026-04-10
**Status:** Approved
**Scope:** Fix missing module-level reasons for HTML assets, split chunks, and all entrypoints

## Problem

The bundle report shows "Top Contributors" (module-level reasons explaining *why* an asset's size changed) for some assets but not others, and shows zero reasons for entrypoints:

1. **HTML assets (e.g. `fullscreenIndex.html`) show empty reasons** — `computeAssetReasons()` builds an `assetName → chunkIds` reverse map from `stats.chunks[].files`, but HTML files (emitted by HtmlWebpackPlugin) don't appear in `stats.chunks[].files`. However, `stats.assets[].chunks` DOES contain chunk IDs for these HTML assets. The fix is to extract the `chunks` field (numeric IDs) from `parseAssets()` and use it as a fallback in `computeAssetReasons()`.

2. **Split chunks (e.g. `6054.js`) may show empty reasons** — These chunks appear in `stats.chunks[].files` so the reverse map works, but some split chunks are runtime-only with no user modules. This is expected behavior (no fix needed), but needs documenting.

3. **Entrypoints have ZERO reason attribution** — `computeEntrypointDiff()` returns `{ name, baseSize, prSize, change, type }` with no `reasons` field. No `computeEntrypointReasons()` function exists. The entrypoint table in all 4 report renderers shows no "Top Contributors" column.

### Root Causes (6 gaps)

| # | Gap | File | Fix |
|---|-----|------|-----|
| 1 | `parseAssets()` discards `stats.assets[].chunks` | stats-parser.js:290-301 | Extract `chunks` (numeric IDs) into `ParsedAsset` |
| 2 | `computeAssetReasons()` only uses chunk→asset reverse map | diff-engine.js:370-425 | Fallback to asset-level `chunks` when reverse map has no entry |
| 3 | `parseEntrypoints()` discards `stats.entrypoints[name].chunks` | stats-parser.js:308-334 | Extract `chunks` array |
| 4 | No `computeEntrypointReasons()` function exists | diff-engine.js | New function analogous to `computeAssetReasons()` |
| 5 | `EntrypointChange` typedef has no `reasons` field | diff-engine.js:30-37 | Add `reasons: AssetContributor[]` |
| 6 | Report renderers don't display entrypoint reasons | comment.js, diff.js, analyze.js, ai-client.js | Add Top Contributors column/line |

### Out of scope

- The JSON serialization gap (analyze.js `generateJSONOutput()` → comment.js `--input` path) where `analysis.assets.changes` vs `analysis.diff.assetDiff` misalign. This is a separate bug.
- Runtime-only split chunks that genuinely have no user modules — empty reasons `[]` is correct for these.

## Design

### 1. Extend `ParsedAsset` with `chunks` field (stats-parser.js)

```js
/**
 * @typedef {Object} ParsedAsset
 * @property {string} name - Output file name
 * @property {number} size - Asset size in bytes
 * @property {string[]} chunkNames - Chunk names this asset belongs to
 * @property {number[]} chunks - Chunk IDs this asset belongs to (for module attribution)
 */
```

In `parseAssets()`, add `chunks: Array.isArray(a.chunks) ? a.chunks : []` to the mapped object.

### 2. Fallback in `computeAssetReasons()` (diff-engine.js)

Currently the function builds `assetToChunkIds` only from `baseChunkToAssets` / `prChunkToAssets` (the `stats.chunks[].files` reverse map). After building that map, add a second pass that checks the asset objects from `assetDiff` — if an asset has no entry in `assetToChunkIds` but does have a `chunks` field, use those chunk IDs.

This requires passing the parsed assets (or at least their chunk IDs) to `computeAssetReasons()`. Two options:
- **Option A:** Add `baseAssets` and `prAssets` parameters to `computeAssetReasons()`
- **Option B:** Enrich `AssetChange` with `chunks` during `computeAssetDiff()` so the data is already on the object

**Choice: Option B** — it's simpler. `computeAssetDiff()` already receives `ParsedAsset[]` arrays. We merge chunk IDs from both base and PR into `AssetChange.chunks` (union set). Then `computeAssetReasons()` can use `asset.chunks` as fallback without any signature change.

Changes to `computeAssetDiff()`: add `chunks` field to each `AssetChange`, populated from the input `ParsedAsset.chunks` arrays (union of base and PR chunk IDs for that asset name).

Changes to `computeAssetReasons()`: after the initial `assetToChunkIds` reverse map is built, for any asset where `assetToChunkIds.get(asset.name)` is empty/missing, fall back to `asset.chunks` if present.

### 3. Extend `ParsedEntrypoint` with `chunks` field (stats-parser.js)

```js
/**
 * @typedef {Object} ParsedEntrypoint
 * @property {string} name - Entrypoint name
 * @property {ParsedAsset[]} assets - Assets belonging to this entrypoint
 * @property {number} assetsSize - Total size of all assets
 * @property {number[]} chunks - Chunk IDs belonging to this entrypoint
 */
```

In `parseEntrypoints()`, add `chunks: Array.isArray(ep.chunks) ? ep.chunks : []` to the returned object.

### 4. Extend `EntrypointChange` with `reasons` (diff-engine.js)

```js
/**
 * @typedef {Object} EntrypointChange
 * @property {string} name
 * @property {number} baseSize
 * @property {number} prSize
 * @property {number} change
 * @property {string} changeFormatted
 * @property {string} type
 * @property {AssetContributor[]} reasons - Top module/package contributors
 */
```

### 5. New `computeEntrypointReasons()` function (diff-engine.js)

Independent computation (not derived from asset reasons). Algorithm:

```
function computeEntrypointReasons(entrypointDiff, moduleChanges, baseEntrypoints, prEntrypoints, topN = 3):
  // Build entrypoint name → chunk IDs (union of base + PR)
  for each entrypoint in baseEntrypoints + prEntrypoints:
    entrypointToChunkIds[ep.name] = union of ep.chunks

  for each ep in entrypointDiff:
    if ep.type is added/removed/unchanged:
      ep.reasons = []
      continue

    chunkIds = entrypointToChunkIds[ep.name]
    if no chunkIds:
      ep.reasons = []
      continue

    // Find module changes belonging to this entrypoint's chunks
    relevant = moduleChanges where mc.chunks intersects chunkIds
    // Group by package (for node_modules) or module name
    // Sort by absolute change, take top N
    ep.reasons = top N contributors
```

This is structurally identical to `computeAssetReasons()` but uses entrypoint chunk IDs instead of asset chunk IDs.

### 6. Wire into `computeDiff()` (diff-engine.js)

After the existing `computeAssetReasons()` call, add:

```js
computeEntrypointReasons(
  entrypointDiff,
  allChanges,
  baseStats.entrypoints || [],
  prStats.entrypoints || [],
);
```

### 7. Update report renderers

**comment.js (entrypoint table):**
- Change 4-column header to 5-column: add "Top Contributors"
- Use existing `formatAssetReasons()` helper (it works on any object with `.reasons` and `.type`)
- Add reasons cell to each row

**diff.js (entrypoint section):**
- After printing each entrypoint line, check for reasons and print `Contributors: ...` line
- Use existing `formatAssetReasonsText()` helper

**analyze.js (entrypoint section):**
- After printing each entrypoint line, print `Contributors: ...` if reasons exist
- In `generateJSONOutput()`, add `reasons` to entrypoint changes serialization

**ai-client.js (entrypoint prompt section):**
- After each entrypoint line, append contributors if present

### 8. Update test sample stats

Add `chunks` field to entrypoints in both `sample-base-stats.json` and `sample-pr-stats.json` so test assertions can verify the new functionality.

### 9. Test coverage

New tests:
- `parseAssets()` returns `chunks` field
- `parseEntrypoints()` returns `chunks` field
- `computeAssetReasons()` uses asset-level chunks as fallback (test with an asset that has NO entry in `chunkToAssets` map but DOES have `chunks`)
- `computeEntrypointReasons()` correctly maps modules to entrypoints via chunk IDs
- `computeEntrypointReasons()` returns empty `[]` for added/removed/unchanged entrypoints
- End-to-end: `computeDiff()` produces entrypoint reasons

## Data Flow

```
parseStats()
  ├── parseAssets() → ParsedAsset[] (now with .chunks)
  ├── parseEntrypoints() → ParsedEntrypoint[] (now with .chunks)
  └── buildChunkToAssetsMap() → chunkId→assetNames

computeDiff(baseStats, prStats)
  ├── computeAssetDiff() → AssetChange[] (now with .chunks)
  ├── computeEntrypointDiff() → EntrypointChange[]
  ├── computeAssetReasons(assetDiff, modules, chunkToAssets, chunkToAssets)
  │     └── Fallback: if asset not in chunkToAssets, use asset.chunks
  └── computeEntrypointReasons(entrypointDiff, modules, baseEntrypoints, prEntrypoints)
        └── Maps modules to entrypoints via entrypoint chunk IDs
```

## File Changes Summary

| File | Change |
|------|--------|
| `lib/stats-parser.js` | `parseAssets()` adds `chunks` field; `parseEntrypoints()` adds `chunks` field; update `ParsedAsset`/`ParsedEntrypoint` typedefs |
| `lib/diff-engine.js` | `computeAssetDiff()` adds `chunks` to `AssetChange`; `computeAssetReasons()` adds fallback; new `computeEntrypointReasons()`; `computeDiff()` calls it; update `EntrypointChange`/`AssetChange` typedefs; export new function |
| `scripts/comment.js` | Entrypoint table: 4→5 columns with Top Contributors |
| `scripts/diff.js` | Entrypoint section: add Contributors line |
| `scripts/analyze.js` | Entrypoint section: add Contributors line; JSON output: add `reasons` to entrypoints |
| `lib/ai-client.js` | Entrypoint prompt section: include contributors |
| `test/sample-base-stats.json` | Add `chunks` to entrypoints |
| `test/sample-pr-stats.json` | Add `chunks` to entrypoints |
| `test/test-runner.js` | New tests for all above |
