# Unused & Unnecessary Code Detection — Design Spec

**Date:** 2026-04-13
**Status:** Approved
**Scope:** Enhance bundle-ai to detect unused, unnecessary, and dead code in webpack bundles using enriched stats parsing, new deterministic rules, chunk graph analysis, bundle AST analysis, and tiered AI calls.

---

## Problem

The tool currently analyzes webpack stats JSON to compare base vs PR builds, but significantly underutilizes the data available. Key gaps:

1. `usedExports` is parsed but only sent to AI — no deterministic rule acts on it
2. `usedExports: false` (tree-shaking disabled) is collapsed to `[]`, losing the signal
3. `reason.type` (side-effect vs named import) is completely discarded
4. `providedExports`, `optimizationBailout`, `depth`, `orphan` are not parsed at all
5. Chunk relationship data (`initial`, `entry`, `parents`, `children`, `origins`) is ignored
6. No polyfill-aware patterns exist in the rule engine
7. No analysis of actual bundled JS content for dead code patterns
8. Only 3 hardcoded "heavy package" patterns exist

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│ ENHANCED PIPELINE                                           │
│                                                             │
│  stats-parser.js (enhanced)                                 │
│    ├── ParsedModule: +providedExports, +optimizationBailout │
│    │                 +depth, +orphan, +treeShakingDisabled   │
│    │                 +reasonDetails (type, userRequest, loc) │
│    └── BundleStats:  +chunkGraph (ParsedChunk[])            │
│                                                             │
│  chunk-analyzer.js (NEW)                                    │
│    └── analyzeChunkGraph() → orphan chunks, async chunks    │
│                                                             │
│  rule-engine.js (enhanced)                                  │
│    ├── existing 11 detection functions (13 rule IDs)        │
│    └── 6 NEW rules (see below)                              │
│                                                             │
│  bundle-analyzer.js (NEW, --deep-analysis only)             │
│    └── analyzeBundleAST() → dead branches, unreachable code │
│                             unused functions, dup strings   │
│                                                             │
│  ai-client.js (enhanced)                                    │
│    ├── analyzeBundle() — existing, unchanged                │
│    ├── analyzeTreeShaking() — NEW, focused call             │
│    └── analyzeBundleAST() — NEW, --deep-analysis only       │
│                                                             │
│  All 3 AI calls run in PARALLEL                             │
└─────────────────────────────────────────────────────────────┘
```

---

## Section 1: Stats Parser Enhancements

**File:** `lib/stats-parser.js`

### Extended `ParsedModule` Fields

| Field | Type | Source | Description |
|-------|------|--------|-------------|
| `providedExports` | `string[] \| null` | `module.providedExports` | Exports the module provides (from webpack) |
| `optimizationBailout` | `string[]` | `module.optimizationBailout` | Why tree-shaking failed for this module |
| `depth` | `number \| null` | `module.depth` | Distance from entrypoint |
| `orphan` | `boolean` | `module.orphan` | True if module is unreachable from any entrypoint |
| `treeShakingDisabled` | `boolean` | Derived from `usedExports === false` | Distinguishes "disabled" from "no data" |
| `reasonDetails` | `ReasonDetail[]` | `module.reasons[]` | Enriched reasons preserving type/userRequest/loc |

### New `ReasonDetail` Typedef

```js
/**
 * @typedef {Object} ReasonDetail
 * @property {string} module - Cleaned module name
 * @property {string} type - "harmony side effect evaluation", "harmony import specifier", "cjs require", etc.
 * @property {string} userRequest - The actual import string ("lodash", "./utils")
 * @property {string} loc - Source location of the import
 */
```

### Changes to `parseUsedExports()`

- When `usedExports === false`: still return `[]` for backward compatibility, but set `treeShakingDisabled: true` on the module
- This preserves the existing `usedExports` contract while adding the lost signal
- Update `extractDeepContext()` in `ai-client.js` to check `treeShakingDisabled` and report "tree-shaking disabled" rather than treating empty `usedExports` as "unknown"

### Changes to `parseReasons()`

- Continue populating the existing `reasons: string[]` field for backward compatibility
- Also populate new `reasonDetails: ReasonDetail[]` with full data from each reason object
- Extract `type`, `userRequest`, `loc` fields that are currently discarded

### New `parseChunkGraph()` Function

Extracts chunk relationship data from `stats.chunks[]`. Fields `parents`, `children`, `siblings` default to `[]` when not present in the stats JSON, matching the project's existing defensive array handling pattern (see `stats-parser.js:136`):

```js
/**
 * @typedef {Object} ParsedChunk
 * @property {number} id
 * @property {string[]} names
 * @property {string[]} files
 * @property {boolean} initial - Is this an initial-load chunk?
 * @property {boolean} entry - Is this an entry chunk?
 * @property {ChunkOrigin[]} origins - What triggered this chunk's creation
 * @property {number[]} parents - Parent chunk IDs
 * @property {number[]} children - Child chunk IDs
 * @property {number[]} siblings - Sibling chunk IDs
 * @property {number} moduleCount
 * @property {number} size - Total size of modules in this chunk
 */
```

### Extended `BundleStats` Return

Add `chunkGraph: ParsedChunk[]` to the return object of `parseStats()`.

---

## Section 2: New Rule Engine Rules

**File:** `lib/rule-engine.js`

Six new deterministic detection rules. No AI required — pure data checks.

### Rule 1: `TREE_SHAKING_INEFFICIENCY`

- **Severity:** warning (>20KB), critical (>100KB)
- **Condition:** `(usedExports.length / providedExports.length) < 0.3 AND size > 20KB AND providedExports !== null AND treeShakingDisabled === false AND usedExports.length > 0`
- **Details:** Module name, size, used count vs provided count, specific used exports
- **Note:** The `treeShakingDisabled === false` and `usedExports.length > 0` guards prevent false positives on modules where webpack didn't provide usedExports data or where tree-shaking is disabled
- **Example:** `lodash ships 72KB but only 3/300 exports used`

### Rule 2: `SIDE_EFFECT_IMPORT`

- **Severity:** warning
- **Condition:** `treeShakingDisabled === true AND reasonDetails.some(r => r.type === "harmony side effect evaluation") AND size > 10KB`
- **Details:** Module name, size, which source file triggered the side-effect import
- **Example:** `date-fns/esm/index.js (51KB) imported only for side effects`

### Rule 3: `OPTIMIZATION_BAILOUT`

- **Severity:** info (>20KB), warning (>50KB)
- **Condition:** `optimizationBailout.length > 0 AND size > 20KB`
- **Details:** Module name, size, specific bailout reason strings
- **Example:** `chart.js (200KB) — "Module is not an ECMAScript module"`

### Rule 4: `ORPHAN_CHUNK`

- **Severity:** warning
- **Condition:** `chunk.initial === false AND chunk.entry === false AND chunk.parents.length === 0 AND chunk.origins.length === 0`
- **Details:** Chunk ID, files, total size — dead weight never loaded at runtime
- **Depends on:** `options.chunkAnalysis` from chunk-analyzer.js

### Rule 5: `UNNECESSARY_POLYFILL`

- **Severity:** info, warning (>50KB total)
- **Condition:** Newly added module matches known polyfill pattern
- **Data source:** Operates on `diff.added` modules. Matches module name against known polyfill patterns.
- **Known patterns:** `core-js/`, `regenerator-runtime/`, `@babel/polyfill`, `whatwg-fetch`, `raf/`, `unfetch`, `url-polyfill`, `es6-promise`, `promise-polyfill`, `object-assign`, `string.prototype.*`, `array.prototype.*`
- **Details:** Polyfill name, size, suggestion to check browserslist

### Rule 6: `BARREL_FILE_IMPORT`

- **Severity:** info, warning (>30KB)
- **Condition:** `reasonDetails.some(r => r.userRequest matches barrel pattern) AND (usedExports.length / providedExports.length) < 0.5 AND size > 15KB`
- **Barrel pattern definition:** A `userRequest` matches barrel pattern if it ends with `/index`, refers to a package root without a deep path (e.g., `'lodash'` but not `'lodash/debounce'`), or points to a directory import. Additionally, the imported module must have `providedExports.length > 10` to confirm it's re-exporting many things.
- **Details:** Suggests using direct/deep imports instead of barrel files

### Integration

`runDetection(diff, options)` — `options` gains:
- `options.prStats` — full `BundleStats` from PR build (for module-level fields)
- `options.chunkAnalysis` — `ChunkAnalysis` from chunk-analyzer.js

**Updated call site in `scripts/analyze.js`:**
`computeAnalysisInputs()` must pass the new options: `runDetection(diff, { baseStats, prStats, chunkAnalysis, linesChanged })`

---

## Section 3: Chunk Graph Analysis

**File:** `lib/chunk-analyzer.js` (NEW)

### Purpose

Build a chunk dependency graph and identify orphan chunks (generated but never loaded at runtime).

### API

```js
/**
 * @param {ParsedChunk[]} chunkGraph - From stats-parser.js
 * @param {ParsedModule[]} modules - For size attribution
 * @returns {ChunkAnalysis}
 */
function analyzeChunkGraph(chunkGraph, modules)
```

### Return Type

```js
/**
 * @typedef {Object} ChunkAnalysis
 * @property {OrphanChunk[]} orphanChunks - Chunks never loaded at runtime
 * @property {number} unreachableModuleSize - Total bytes in orphan chunks
 * @property {AsyncChunkInfo[]} asyncChunks - Non-initial chunks with load info
 * @property {InitialChunkInfo[]} initialChunks - Initial load chunks
 * @property {number} totalChunks
 * @property {number} totalAsyncChunks
 * @property {number} totalInitialChunks
 */
```

### Algorithm

1. Build adjacency list from `chunk.parents` and `chunk.children`
2. Mark all `entry: true` chunks as reachable
3. BFS from entry chunks through `children` edges — mark everything reachable
4. Any chunk NOT `initial`, NOT `entry`, NOT reachable = orphan
5. For async chunks, use `chunk.origins[]` to determine which module's `import()` created them

### Integration

Called from `scripts/orchestrate.js` after `parseStats()`. Results passed to `runDetection()` via `options.chunkAnalysis` and to AI context.

---

## Section 4: Bundle AST Analysis

**File:** `lib/bundle-analyzer.js` (NEW)

### Dependency

**`acorn`** — minimal (~120KB), fast, already used by webpack internally. Added as an **optional dependency** to preserve the project's zero-runtime-dependency design.

**Import strategy:** `acorn` is lazy-loaded inside `analyzeBundleAST()` with a try/catch guard:
```js
function analyzeBundleAST(distDir, options = {}) {
  let acorn;
  try {
    acorn = require('acorn');
  } catch {
    return { skipped: true, reason: 'acorn not installed — run npm install acorn for --deep-analysis support' };
  }
  // ... analysis logic
}
```

In `package.json`, `acorn` is listed under `optionalDependencies` (not `dependencies`). Users who don't use `--deep-analysis` never need it installed.

### Build Output Directory

Read from `.env`:
```
BUILD_OUTPUT_DIR=dist/prod/v1
```

This is relative to the repo root. `clone-builder.js` uses this to locate bundled JS files after building.

### Activation

Opt-in via `--deep-analysis` CLI flag. Only works in full mode (not `--file` mode, since dist output isn't available with pre-built stats).

### API

```js
/**
 * @param {string} distDir - Absolute path to webpack output directory
 * @param {Object} options
 * @param {number} [options.maxFiles=10] - Max files to analyze (largest first)
 * @param {number} [options.maxFileSize=5242880] - Skip files >5MB
 * @returns {BundleASTAnalysis}
 */
function analyzeBundleAST(distDir, options = {})
```

### Detection Targets

| Target | AST Pattern | Heuristic |
|--------|-------------|-----------|
| **Dead branches** | `IfStatement` with `Literal(false)` or unresolved `process.env` check | Report estimated bytes of dead block |
| **Unreachable code** | Statements after `ReturnStatement`/`ThrowStatement` in a `BlockStatement` | Estimate bytes of unreachable statements |
| **Unused functions** | `FunctionDeclaration` identifiers not referenced elsewhere in the file | High size threshold (>500 bytes) to reduce false positives from dynamic access |
| **Duplicate strings** | `Literal` strings >50 chars appearing >5 times | Report total wasted bytes |
| **Empty modules** | Webpack module wrappers (`__webpack_modules__` entries) with empty/comment-only body | Count and report |

### Return Type

```js
/**
 * @typedef {Object} BundleASTAnalysis
 * @property {DeadBranch[]} deadBranches
 * @property {UnreachableCode[]} unreachableCode
 * @property {UnusedFunction[]} unusedFunctions
 * @property {DuplicateString[]} duplicateStrings
 * @property {EmptyModule[]} emptyModules
 * @property {number} totalWastedBytes
 * @property {number} filesAnalyzed
 * @property {number} analysisTimeMs
 */
```

### Performance Guardrails

- Analyze top 10 largest `.js` files only (configurable)
- Skip files >5MB
- Skip `.map` and `.LICENSE.txt` files
- 30-second timeout for entire analysis pass. Implemented via `Promise.race` with a timer — on timeout, returns a partial `BundleASTAnalysis` with `filesAnalyzed` reflecting progress and `timedOut: true`
- Graceful skip in `--file` mode (no dist output available)

### Limitations

- **Minified code:** Function names mangled → `unusedFunctions` less useful. Dead branches and unreachable code still detectable.
- **False positives:** Unused function detection is heuristic. High size thresholds minimize noise.
- **Full mode only:** Requires actual build output.

### Changes to `clone-builder.js`

`buildBranch()` returns `{ statsPath, compiledJsDir, distDir }` where:
- `distDir = path.resolve(repoDir, process.env.BUILD_OUTPUT_DIR)` when `BUILD_OUTPUT_DIR` is set
- `distDir = null` when `BUILD_OUTPUT_DIR` is unset (graceful degradation — AST analysis is skipped)
- **Important:** `buildBranch` builds both base and PR sequentially in the same `repoDir`. After building base then PR, the base dist output is overwritten. Therefore, **bundle AST analysis runs only on the PR build's dist output**, never on base. The base `distDir` return value is ignored by the orchestrator.
- `distDir` is always an absolute path when non-null

---

## Section 5: AI Context Enrichment

**File:** `lib/ai-client.js`

### Strategy: 3 Parallel AI Calls

To avoid bloating context, the new data is NOT added to the existing prompt. Instead, 3 focused AI calls run in parallel:

### Call 1: `analyzeBundle()` — Existing, Unchanged

Same as today. Receives diff data, detection violations, code diffs.

**Token budget:** ~4K-8K input, ~2K output

### Call 2: `analyzeTreeShaking()` — NEW

**Focused context (curated, not raw):**
- Top 15 modules by "wasted exports" score: `(providedExports.length - usedExports.length) * size`
- Modules with `optimizationBailout` messages (only bailout strings + module name + size)
- Modules flagged by `SIDE_EFFECT_IMPORT` rule (module name, size, importer, reason type)
- `TREE_SHAKING_INEFFICIENCY` violations

**AI is asked to:**
- Identify highest-impact tree-shaking fixes
- Suggest specific import rewrites (e.g., `import { debounce } from 'lodash/debounce'`)
- Explain which bailout reasons are fixable vs inherent

**Returns:** `{ findings: [...], suggestions: [...], estimatedSavings: number }`

**Token budget:** ~2K-4K input, ~1.5K output

### Call 3: `analyzeBundleASTWithAI()` — NEW, `--deep-analysis` only

**Focused context:**
- Dead branches found (file, pattern, estimated bytes)
- Unreachable code blocks (file, after what statement, bytes)
- Unused functions (top 20 by size)
- Duplicate strings (top 10)
- Empty module wrappers

**AI is asked to:**
- Assess real issues vs false positives
- Prioritize by impact
- Identify build config issues (e.g., `process.env.NODE_ENV` not replaced)

**Returns:** `{ confirmed: [...], falsePositives: [...], buildConfigIssues: [...] }`

**Token budget:** ~1K-3K input, ~1K output

### Result Merging

After parallel completion (via existing `runWithConcurrency`):
- Each of the 3 AI calls is individually wrapped with try/catch, returning `null` on failure (matching the pattern in `analyzeCodeChunks` at `ai-client.js:793-797`). A failure in one call does not affect the others.
- `analyzeBundle` result → main verdict, confidence, root cause (existing)
- `analyzeTreeShaking` result → new "Tree-Shaking Analysis" section in reports
- `analyzeBundleASTWithAI` result → new "Dead Code Analysis" section (only with `--deep-analysis`)

### Report Changes

PR comment (`scripts/comment.js`) and text report (`scripts/analyze.js`) gain:
- **Tree-Shaking Analysis** section: top findings, specific import rewrite suggestions, estimated savings
- **Dead Code Analysis** section (conditional on `--deep-analysis`): confirmed dead code patterns, build config issues

---

## `.env` Changes

```
# Existing
OPENAI_API_KEY=...
OPENAI_BASE_URL=...
REPO_URL=...

# New
BUILD_OUTPUT_DIR=dist/prod/v1    # path to prod build output within the repo (relative to repo root)
```

---

## CLI Changes

New flag:
```
--deep-analysis    Enable bundle AST analysis (requires full mode, reads actual JS output files)
```

**Integration:** Add `--deep-analysis` case to `parseArgs()` in `scripts/orchestrate.js` (sets `options.deepAnalysis = true`). Add description to `printHelp()` output.

---

## File Change Summary

| File | Change Type | Description |
|------|-------------|-------------|
| `lib/stats-parser.js` | Modified | Parse providedExports, optimizationBailout, depth, orphan, reasonDetails, chunkGraph; fix usedExports:false signal |
| `lib/rule-engine.js` | Modified | Add 6 new rules: TREE_SHAKING_INEFFICIENCY, SIDE_EFFECT_IMPORT, OPTIMIZATION_BAILOUT, ORPHAN_CHUNK, UNNECESSARY_POLYFILL, BARREL_FILE_IMPORT |
| `lib/chunk-analyzer.js` | **New** | Chunk dependency graph analysis, orphan chunk detection |
| `lib/bundle-analyzer.js` | **New** | AST analysis of bundled JS files using acorn |
| `lib/ai-client.js` | Modified | Add analyzeTreeShaking() and analyzeBundleASTWithAI() parallel calls |
| `lib/clone-builder.js` | Modified | Return distDir from BUILD_OUTPUT_DIR env var |
| `scripts/orchestrate.js` | Modified | Integrate chunk analysis, bundle AST analysis, new AI calls, --deep-analysis flag |
| `scripts/analyze.js` | Modified | New report sections for tree-shaking and dead code |
| `scripts/comment.js` | Modified | New PR comment sections for tree-shaking and dead code |
| `.env` | Modified | Add BUILD_OUTPUT_DIR |
| `package.json` | Modified | Add acorn as optionalDependency |
| `test/test-runner.js` | Modified | Tests for all new functionality |

---

## Implementation Order

1. Stats parser enhancements (foundation — everything depends on this)
2. New rule engine rules (immediate value, no new files)
3. Chunk analyzer module (independent from rules)
4. Bundle AST analyzer module (independent, requires acorn)
5. AI context enrichment (depends on 1-4 for data)
6. Orchestration and reporting integration
7. Tests
