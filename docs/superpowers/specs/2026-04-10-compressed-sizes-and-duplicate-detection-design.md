# Design Spec: Compressed Sizes & Duplicate Dependency Detection

## Goal

Add two features to the bundle analyzer:
1. **Compressed size analysis** — compute gzip + brotli sizes for every asset; display gzip in reports; include brotli in AI context only
2. **Duplicate dependency detection** — detect multi-version packages in the bundle; flag only **newly introduced** duplicates in the PR; add a new `DUPLICATE_DEPENDENCY` detection rule

Both features integrate into all outputs: text report, PR comment, JSON output, and AI prompt context.

## Constraints

- Zero npm dependencies — use Node.js built-in `zlib` module (gzip via `gzipSync`, brotli via `brotliCompressSync`)
- No actual file I/O for compression — we compute compressed sizes from the raw byte sizes using estimation ratios, since we don't have the actual file contents (only webpack stats JSON)
- Custom test runner at `test/test-runner.js` (not jest/mocha)
- Maintain existing `formatBytes` API in `lib/utils.js`

## Design Decisions

### Compressed Size Estimation

**Problem:** We don't have actual file contents — webpack stats JSON only gives us file names and raw byte sizes. We cannot run `gzipSync` on actual bytes.

**Solution:** Use well-established compression ratio estimates based on asset type:

| Asset Type | Gzip Ratio | Brotli Ratio | Source |
|-----------|------------|--------------|--------|
| `.js` | 0.30 | 0.25 | Industry standard for minified JS |
| `.css` | 0.25 | 0.20 | CSS compresses well due to repetition |
| `.html` | 0.30 | 0.25 | Similar to JS |
| `.json` | 0.25 | 0.20 | Highly repetitive structure |
| `.svg` | 0.40 | 0.35 | XML-based, compresses well |
| `.wasm` | 0.70 | 0.65 | Already binary, less compressible |
| Other | 0.50 | 0.45 | Conservative default |

Compressed size = `Math.round(rawSize * ratio)`

**Rationale:** This is the same approach bundlephobia uses. Exact compression depends on content, but ratio-based estimates are within ±5% for minified JS (the bulk of our assets). The alternative — requiring actual file access — would break our architecture (stats-only analysis).

**Future enhancement:** If the tool ever gets access to the actual build output directory, we can swap in real `zlib.gzipSync` / `zlib.brotliCompressSync` calls.

### Duplicate Dependency Detection

**Problem:** The existing `POTENTIAL_DUPLICATES` rule (rule #8 in rule-engine.js) only does a shallow check — it looks for packages whose base name appears more than once. It does NOT:
- Compare base vs PR to identify newly introduced duplicates
- Calculate the size impact of duplication
- Distinguish between version conflicts and legitimately different packages

**Solution:** New analysis function in `lib/stats-parser.js` that:

1. **Extracts versioned package paths** from module names — e.g., `node_modules/lodash` at two different sub-paths like `node_modules/lodash` and `node_modules/some-lib/node_modules/lodash`
2. **Groups modules by canonical package name** — normalize `@scope/pkg` and `pkg` names
3. **Counts unique installation paths** — same package at different `node_modules` depths = duplicate
4. **Compares base vs PR** — only flag duplicates that are NEW in the PR build
5. **Calculates wasted bytes** — sum of all but the largest instance

### Data Flow

```
stats-parser.js                 diff-engine.js              rule-engine.js
┌─────────────┐                ┌──────────────┐            ┌──────────────┐
│ parseStats() │                │ computeDiff()│            │runDetection()│
│  + estimate  │───────────────▶│  + compress  │───────────▶│  + DUPLICATE │
│  compressed  │                │  diffs       │            │  _DEPENDENCY │
│  sizes       │                │  + duplicate │            │  rule        │
│  + find      │                │  detection   │            └──────────────┘
│  duplicates  │                └──────┬───────┘                    │
└─────────────┘                       │                            │
                                      ▼                            ▼
                    ┌──────────────────────────────────┐
                    │          All Renderers            │
                    │  comment.js  diff.js  analyze.js  │
                    │  + gzip columns                   │
                    │  + duplicate section               │
                    │                                    │
                    │          ai-client.js              │
                    │  + gzip + brotli in prompt         │
                    │  + duplicate context               │
                    └──────────────────────────────────┘
```

## Type Changes

### New types in `stats-parser.js`

```js
/**
 * @typedef {Object} CompressedSize
 * @property {number} gzip - Estimated gzip compressed size in bytes
 * @property {number} brotli - Estimated brotli compressed size in bytes
 */

/**
 * @typedef {Object} DuplicatePackage
 * @property {string} name - Canonical package name (e.g., "lodash")
 * @property {string[]} paths - All unique node_modules paths where it appears
 * @property {number} instanceCount - Number of instances
 * @property {number} totalSize - Total size across all instances
 * @property {number} wastedSize - Size of all instances except the largest (waste from duplication)
 */
```

### Modified types

**`ParsedAsset`** — add:
```js
 * @property {CompressedSize} compressed - Estimated compressed sizes
```

**`ParsedEntrypoint`** — add:
```js
 * @property {CompressedSize} compressed - Estimated compressed entrypoint sizes (sum of asset compressed sizes)
```

**`BundleStats`** — add:
```js
 * @property {DuplicatePackage[]} duplicates - Duplicate packages found in the bundle
 * @property {number} totalGzipSize - Total estimated gzip size of all deliverable assets
```

**`AssetChange`** (diff-engine.js) — add:
```js
 * @property {number} baseGzip - Gzip size in base (0 if new)
 * @property {number} prGzip - Gzip size in PR (0 if removed)
 * @property {number} gzipChange - Gzip size difference
```

**`EntrypointChange`** (diff-engine.js) — add:
```js
 * @property {number} baseGzip - Gzip size in base (0 if new)
 * @property {number} prGzip - Gzip size in PR (0 if removed)
 * @property {number} gzipChange - Gzip size difference
```

**`BundleDiff`** (diff-engine.js) — add:
```js
 * @property {DuplicatePackage[]} newDuplicates - Duplicates introduced in PR (not in base)
 * @property {number} totalGzipDiff - Total gzip size change
 * @property {number} baseGzipSize - Total gzip size in base
 * @property {number} prGzipSize - Total gzip size in PR
```

## New Functions

### `lib/stats-parser.js`

**`estimateCompressedSize(size, filename)`** — returns `CompressedSize` based on file extension ratio lookup.

**`findDuplicatePackages(modules)`** — returns `DuplicatePackage[]`. Groups modules by canonical package name, finds packages with multiple `node_modules` installation paths.

### `lib/diff-engine.js`

**`computeNewDuplicates(baseDuplicates, prDuplicates)`** — returns `DuplicatePackage[]` of only those duplicates that exist in PR but NOT in base. A duplicate is "new" if:
- The package name didn't appear in `baseDuplicates` at all, OR
- The package had fewer instances in base than in PR

## New Detection Rule

### `DUPLICATE_DEPENDENCY` (in `rule-engine.js`)

```
ID: DUPLICATE_DEPENDENCY
Severity: warning (if wasted < 50KB), critical (if wasted >= 50KB)
Category: Dependency Management
Condition: newDuplicates.length > 0
Message: "PR introduces duplicate dependency: {name} ({instanceCount} copies, {wastedSize} wasted)"
Details: { name, paths, instanceCount, totalSize, wastedSize }
```

This replaces/enhances the existing `POTENTIAL_DUPLICATES` rule which was info-level and didn't compare base vs PR.

## Report Changes

### PR Comment (`scripts/comment.js`)

**Asset table** — add Gzip column:
```
| Output File | Base | PR | Gzip | Change | Top Contributors |
|-------------|------|-----|------|--------|-----------------|
| `main.js`   | 1.2 MB | 1.5 MB | 450 KB | +300 KB | lodash (+200 KB) |
```

**Entrypoint table** — add Gzip column:
```
| Entrypoint | Base | PR | Gzip | Change | Top Contributors |
|------------|------|-----|------|--------|-----------------|
| `app`      | 1.7 MB | 2.0 MB | 600 KB | +300 KB | lodash (+200 KB) |
```

**New "Duplicate Dependencies" section** (after entrypoints, only if newDuplicates.length > 0):
```markdown
### ⚠️ New Duplicate Dependencies

| Package | Copies | Wasted | Paths |
|---------|--------|--------|-------|
| `lodash` | 3 | 45.2 KB | `node_modules/lodash`, `node_modules/lib-a/node_modules/lodash` |
```

### Text Report (`scripts/diff.js`)

**Asset lines** — add gzip size in parens:
```
~ main.bundle.js  1.19 MB → 1.49 MB  (+314.45 KB) [gzip: 447 KB]
    Contributors: lodash (+684 KB), chart.js (+176 KB)
```

**New duplicate section:**
```
## Duplicate Dependencies (New in PR)

⚠ lodash — 3 copies, 45.2 KB wasted
    Paths: node_modules/lodash, node_modules/lib-a/node_modules/lodash
```

### JSON Output (`scripts/analyze.js`)

Add to top-level:
```json
{
  "compressed": {
    "baseGzipTotal": 506880,
    "prGzipTotal": 614400,
    "gzipDiff": 107520
  },
  "duplicates": {
    "new": [
      { "name": "lodash", "copies": 3, "wastedSize": 46285, "paths": ["..."] }
    ]
  }
}
```

Asset/entrypoint changes gain `gzipSize` field.

### AI Prompt (`lib/ai-client.js`)

**New section after "Output File Changes":**
```
## Compressed Sizes (Estimated)

Asset gzip/brotli sizes (post-minification estimates):
- main.bundle.js: raw 1.49 MB → gzip 447 KB, brotli 373 KB
- vendor.bundle.js: raw 512 KB → gzip 154 KB, brotli 128 KB

Total gzip: 601 KB (base) → 708 KB (PR), change: +107 KB
```

**New section after "Package Changes":**
```
## New Duplicate Dependencies

PR introduces these duplicate packages (not present in base):
- lodash: 3 copies at different node_modules paths, 45.2 KB wasted
  Paths: node_modules/lodash, node_modules/lib-a/node_modules/lodash
```

**Updated system prompt** — add instruction: "Consider compressed sizes (gzip/brotli) when assessing real-world impact. Raw sizes overstate the impact of text-based assets. Also flag duplicate dependencies as a common source of bloat."

## Out of Scope

- Actual file content compression (requires build output directory access)
- Historical tracking / persistence
- Interactive visualization
- Performance budgets / CI gating (future feature)
- Fixing the JSON serialization → `--input` flow disconnect (known issue from previous spec)

## Test Strategy

- Unit tests for `estimateCompressedSize()` with various file extensions
- Unit tests for `findDuplicatePackages()` with mock modules
- Unit tests for `computeNewDuplicates()` comparing base vs PR duplicates
- Integration test: `computeDiff()` produces gzip fields on AssetChange and EntrypointChange
- Integration test: `computeDiff()` produces `newDuplicates` array
- Render tests: comment.js produces Gzip column, duplicate section
- Rule test: `DUPLICATE_DEPENDENCY` fires for new duplicates
