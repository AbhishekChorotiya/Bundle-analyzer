# Code Quality Cleanup — Design Spec

**Date:** 2026-04-10
**Status:** Approved
**Scope:** Consolidate duplicated code, remove dead code, add error handling

## Problem

The bundle-ai codebase has accumulated several code quality issues:

1. **Duplicated `formatBytes`** — 4 separate implementations across stats-parser.js, diff.js, comment.js, and analyze.js with inconsistent unit labels ("Bytes" vs "B") and sign behavior
2. **Duplicated `.env` parsing** — identical manual parsing in cli.js and analyze.js
3. **Duplicated `getRootCause`** — in both diff-engine.js and rule-engine.js with slightly different behavior
4. **Dead code** — 5 exported functions/variables that are never called from anywhere
5. **Missing error handling** — no AI API timeout, no CLI argument validation, no stats JSON structure validation

## Design

### 1. New shared utility module: `lib/utils.js`

Create a single utility module exporting three functions:

```js
/**
 * Format byte count to human-readable string.
 * Uses units: B, KB, MB, GB
 * @param {number} bytes
 * @param {{ signed?: boolean }} options - If signed, prefix with +/-
 * @returns {string}
 */
function formatBytes(bytes, { signed = false } = {})

/**
 * Load .env file and set process.env entries.
 * Parses KEY=VALUE lines, ignores comments (#) and empty lines.
 * @param {string} filePath - Path to .env file
 */
function loadEnv(filePath)

/**
 * Extract root cause module name from a webpack module identifier.
 * Strips loader prefixes (everything before last !) and leading ./
 * @param {string} name - Raw webpack module name
 * @returns {string}
 */
function getRootCause(name)
```

**`formatBytes` behavior:**
- Zero → `"0 B"`
- Standardized units: `['B', 'KB', 'MB', 'GB']`
- `signed: true` → prefix with `+` for positive, `-` for negative
- `signed: false` (default) → no sign prefix, uses absolute value

**`loadEnv` behavior:**
- Read file with `fs.readFileSync`
- Split by newlines, skip empty lines and lines starting with `#`
- Split each line on first `=`, trim key and value
- Strip surrounding quotes from value
- Set `process.env[key] = value` (only if not already set)

**`getRootCause` behavior:**
- Strip loader prefixes: `name.split('!').pop()`
- Strip leading `./`: `.replace(/^\.\//, '')`

### 2. Call site updates

| Current location | Current function | Replacement |
|-----------------|-----------------|-------------|
| `stats-parser.js` | `formatBytes()` | Import from `utils.js` |
| `diff-engine.js` | Re-exports `formatBytes` + has `formatSignedBytes` | Import `formatBytes` from `utils.js`, update `formatSignedBytes` to call it with `{ signed: true }` |
| `scripts/diff.js` | Local `formatBytes()` with signed option | Import from `utils.js` |
| `scripts/comment.js` | Local signed `formatBytes()` | Import from `utils.js` |
| `scripts/analyze.js` | Local `formatBytes()` + `formatBytesAbs()` | Import from `utils.js` |
| `cli.js` | `.env` parsing block (lines 16-30) | Import `loadEnv` from `utils.js` |
| `scripts/analyze.js` | `.env` parsing block (lines 10-25) | Import `loadEnv` from `utils.js` |
| `diff-engine.js` | `getRootCause()` | Import from `utils.js` |
| `rule-engine.js` | `getRootCause()` | Import from `utils.js` |

### 3. Dead code removal

| File | Item | Reason |
|------|------|--------|
| `stats-parser.js` | `findMainChunk()` | Exported but never called |
| `diff-engine.js` | `filterChanges()` | Exported but never called |
| `diff-engine.js` | `changed` array in `computeDiff()` | Populated but never read |
| `rescript-analyzer.js` | `getLinesChanged()` | Exported but never called |
| `rescript-analyzer.js` | `correlateWithBundleChanges` in `module.exports` | Only called internally; keep function, remove from exports |

### 4. Error handling improvements

#### 4a. AI API timeout (5 minutes)

In `ai-client.js`, add `signal: AbortSignal.timeout(300000)` to the `fetch()` options. On `AbortError`, log a warning and fall back to offline/rule-based analysis.

#### 4b. CLI argument validation

In `cli.js` `parseArgs()`, after processing each flag that expects a value (`--base`, `--head`, `--base-stats`, `--pr-stats`, `--output`, `--format`, `--model`, `--repo`), validate that the next argument exists and does not start with `--`. If invalid, print an error message and `process.exit(1)`.

#### 4c. Stats JSON validation

In `stats-parser.js` `parseStats()`, add an upfront guard:
```js
if (!stats || !Array.isArray(stats.modules)) {
  throw new Error('Invalid webpack stats: expected object with "modules" array');
}
```

This fires before any iteration, preventing silent NaN propagation from malformed input.

### 5. Test updates

- Add tests for `formatBytes` from utils.js (replaces existing stats-parser formatBytes test)
- Add tests for `loadEnv`
- Add tests for `getRootCause`
- Add test for stats validation (malformed input throws)
- Verify all 33 existing tests still pass

## Files affected

| File | Changes |
|------|---------|
| `lib/utils.js` | **New** — formatBytes, loadEnv, getRootCause |
| `lib/stats-parser.js` | Remove formatBytes, findMainChunk; import formatBytes from utils; add stats validation |
| `lib/diff-engine.js` | Remove formatBytes re-export, filterChanges, changed array, getRootCause; import from utils |
| `lib/rule-engine.js` | Remove getRootCause; import from utils |
| `lib/ai-client.js` | Add AbortSignal.timeout(300000) to fetch, handle AbortError |
| `lib/rescript-analyzer.js` | Remove getLinesChanged, remove correlateWithBundleChanges from exports |
| `scripts/diff.js` | Remove local formatBytes; import from utils |
| `scripts/comment.js` | Remove local formatBytes; import from utils |
| `scripts/analyze.js` | Remove local formatBytes, formatBytesAbs, .env parsing; import from utils |
| `cli.js` | Remove .env parsing; import loadEnv from utils; add arg validation |
| `test/test-runner.js` | Update formatBytes test source, add new tests |

## Acceptance criteria

- All 33 existing tests pass
- New tests for utils.js functions pass
- No duplicate formatBytes/loadEnv/getRootCause in codebase
- No dead code in exports
- AI API call times out after 5 minutes
- CLI prints error on missing argument values
- parseStats throws on malformed input
