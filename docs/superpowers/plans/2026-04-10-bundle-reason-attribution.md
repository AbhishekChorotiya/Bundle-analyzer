# Bundle Reason Attribution Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix missing module-level reasons for HTML assets and add entrypoint reason attribution across all report renderers.

**Architecture:** Extend parsed stats with chunk ID arrays, add fallback logic in asset reason computation, create new `computeEntrypointReasons()` function, and update all 4 renderers to display entrypoint reasons.

**Tech Stack:** Vanilla Node.js, custom test runner at `test/test-runner.js`

---

## File Structure

| File | Responsibility | Action |
|------|---------------|--------|
| `lib/stats-parser.js` | Webpack stats parsing | Modify: add `chunks` to `parseAssets()` and `parseEntrypoints()` |
| `lib/diff-engine.js` | Diff computation engine | Modify: add `chunks` to `computeAssetDiff()`, fallback in `computeAssetReasons()`, new `computeEntrypointReasons()`, wire in `computeDiff()` |
| `scripts/comment.js` | PR markdown comment renderer | Modify: entrypoint table 4→5 columns |
| `scripts/diff.js` | CLI text report renderer | Modify: entrypoint section add Contributors line |
| `scripts/analyze.js` | Analysis pipeline + report | Modify: entrypoint section add Contributors line + JSON output |
| `lib/ai-client.js` | AI prompt builder | Modify: entrypoint prompt section add contributors |
| `test/sample-base-stats.json` | Test fixture | Modify: add `chunks` to entrypoints, add HTML asset |
| `test/sample-pr-stats.json` | Test fixture | Modify: add `chunks` to entrypoints, add HTML asset |
| `test/test-runner.js` | Tests | Modify: add new tests |

---

## Chunk 1: Parser and Engine Changes

### Task 1: Add `chunks` field to `parseAssets()`

**Files:**
- Modify: `lib/stats-parser.js:21-25` (ParsedAsset typedef)
- Modify: `lib/stats-parser.js:290-301` (parseAssets function)
- Modify: `test/test-runner.js` (add test before summary block)

- [ ] **Step 1: Write the failing test**

Add this test before the `// Summary` block at line 583 of `test/test-runner.js`:

```js
test('parseAssets extracts chunks (numeric IDs) from assets', () => {
  const stats = {
    assets: [
      { name: 'app.js', size: 1000, chunks: [0, 1], chunkNames: ['main'] },
      { name: 'index.html', size: 500, chunks: [0], chunkNames: [] },
      { name: 'app.js.map', size: 5000, chunks: [0], chunkNames: ['main'] },
    ],
  };
  const assets = parseAssets(stats);
  assertEqual(assets.length, 2, 'Should filter out .map files');
  // app.js is larger, sorted first
  assertEqual(assets[0].name, 'app.js');
  assertEqual(assets[0].chunks.length, 2, 'app.js should have 2 chunk IDs');
  assertEqual(assets[0].chunks[0], 0);
  assertEqual(assets[0].chunks[1], 1);
  assertEqual(assets[1].name, 'index.html');
  assertEqual(assets[1].chunks.length, 1, 'index.html should have 1 chunk ID');
  assertEqual(assets[1].chunks[0], 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/test-runner.js`
Expected: FAIL — `assets[0].chunks` is undefined because `parseAssets()` doesn't extract it yet.

- [ ] **Step 3: Update ParsedAsset typedef**

In `lib/stats-parser.js`, change the typedef at lines 21-25:

```js
/**
 * @typedef {Object} ParsedAsset
 * @property {string} name - Output file name (e.g. "app.js")
 * @property {number} size - Asset size in bytes (post-minification)
 * @property {string[]} chunkNames - Chunk names this asset belongs to
 * @property {number[]} chunks - Chunk IDs this asset belongs to (for module attribution)
 */
```

- [ ] **Step 4: Update parseAssets() to extract chunks**

In `lib/stats-parser.js`, change the `.map()` in `parseAssets()` (lines 295-299) from:

```js
    .map(a => ({
      name: a.name,
      size: a.size || 0,
      chunkNames: a.chunkNames || [],
    }))
```

to:

```js
    .map(a => ({
      name: a.name,
      size: a.size || 0,
      chunkNames: a.chunkNames || [],
      chunks: Array.isArray(a.chunks) ? a.chunks : [],
    }))
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node test/test-runner.js`
Expected: ALL PASS (39 tests)

- [ ] **Step 6: Commit**

```bash
git add lib/stats-parser.js test/test-runner.js
git commit -m "feat: extract chunk IDs from parseAssets() for module attribution"
```

---

### Task 2: Add `chunks` field to `parseEntrypoints()`

**Files:**
- Modify: `lib/stats-parser.js:28-32` (ParsedEntrypoint typedef)
- Modify: `lib/stats-parser.js:308-334` (parseEntrypoints function)
- Modify: `test/sample-base-stats.json` (add chunks to entrypoints)
- Modify: `test/sample-pr-stats.json` (add chunks to entrypoints)
- Modify: `test/test-runner.js` (add test)

- [ ] **Step 1: Update test sample stats with entrypoint chunks**

In `test/sample-base-stats.json`, change the `entrypoints` section (lines 39-48) from:

```json
  "entrypoints": {
    "app": {
      "assets": ["vendor.bundle.js", "main.bundle.js"],
      "assetsSize": 1769472
    },
    "HyperLoader": {
      "assets": ["vendor.bundle.js"],
      "assetsSize": 524288
    }
  },
```

to:

```json
  "entrypoints": {
    "app": {
      "assets": ["vendor.bundle.js", "main.bundle.js"],
      "assetsSize": 1769472,
      "chunks": [0, 1]
    },
    "HyperLoader": {
      "assets": ["vendor.bundle.js"],
      "assetsSize": 524288,
      "chunks": [1]
    }
  },
```

In `test/sample-pr-stats.json`, change the `entrypoints` section (lines 45-58) from:

```json
  "entrypoints": {
    "app": {
      "assets": ["vendor.bundle.js", "main.bundle.js"],
      "assetsSize": 2084288
    },
    "HyperLoader": {
      "assets": ["vendor.bundle.js"],
      "assetsSize": 524288
    },
    "hs-sdk-sw": {
      "assets": ["sw.bundle.js"],
      "assetsSize": 65536
    }
  },
```

to:

```json
  "entrypoints": {
    "app": {
      "assets": ["vendor.bundle.js", "main.bundle.js"],
      "assetsSize": 2084288,
      "chunks": [0, 1]
    },
    "HyperLoader": {
      "assets": ["vendor.bundle.js"],
      "assetsSize": 524288,
      "chunks": [1]
    },
    "hs-sdk-sw": {
      "assets": ["sw.bundle.js"],
      "assetsSize": 65536,
      "chunks": [2]
    }
  },
```

- [ ] **Step 2: Write the failing test**

Add after the previous new test in `test/test-runner.js`:

```js
test('parseEntrypoints extracts chunks array from entrypoints', () => {
  const stats = {
    entrypoints: {
      app: {
        assets: [{ name: 'app.js', size: 1000 }],
        assetsSize: 1000,
        chunks: [0, 1],
      },
      loader: {
        assets: [{ name: 'loader.js', size: 500 }],
        assetsSize: 500,
        chunks: [2],
      },
      legacy: {
        assets: [{ name: 'legacy.js', size: 300 }],
        assetsSize: 300,
        // No chunks field — should default to []
      },
    },
    assets: [],
  };
  const entrypoints = parseEntrypoints(stats);
  assertEqual(entrypoints.length, 3);

  const app = entrypoints.find(e => e.name === 'app');
  assertEqual(app.chunks.length, 2, 'app should have 2 chunk IDs');
  assertEqual(app.chunks[0], 0);
  assertEqual(app.chunks[1], 1);

  const loader = entrypoints.find(e => e.name === 'loader');
  assertEqual(loader.chunks.length, 1, 'loader should have 1 chunk ID');
  assertEqual(loader.chunks[0], 2);

  const legacy = entrypoints.find(e => e.name === 'legacy');
  assertEqual(legacy.chunks.length, 0, 'legacy should have 0 chunk IDs');
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node test/test-runner.js`
Expected: FAIL — `chunks` is undefined on entrypoint objects.

- [ ] **Step 4: Update ParsedEntrypoint typedef**

In `lib/stats-parser.js`, change the typedef at lines 28-32:

```js
/**
 * @typedef {Object} ParsedEntrypoint
 * @property {string} name - Entrypoint name (e.g. "app", "HyperLoader")
 * @property {ParsedAsset[]} assets - Assets belonging to this entrypoint
 * @property {number} assetsSize - Total size of all assets in this entrypoint
 * @property {number[]} chunks - Chunk IDs belonging to this entrypoint
 */
```

- [ ] **Step 5: Update parseEntrypoints() to extract chunks**

In `lib/stats-parser.js`, change the return statement in `parseEntrypoints()` (lines 328-333) from:

```js
    return {
      name,
      assets,
      assetsSize: ep.assetsSize || assets.reduce((sum, a) => sum + a.size, 0),
    };
```

to:

```js
    return {
      name,
      assets,
      assetsSize: ep.assetsSize || assets.reduce((sum, a) => sum + a.size, 0),
      chunks: Array.isArray(ep.chunks) ? ep.chunks : [],
    };
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `node test/test-runner.js`
Expected: ALL PASS (40 tests)

- [ ] **Step 7: Commit**

```bash
git add lib/stats-parser.js test/sample-base-stats.json test/sample-pr-stats.json test/test-runner.js
git commit -m "feat: extract chunk IDs from parseEntrypoints() for reason attribution"
```

---

### Task 3: Add `chunks` to `AssetChange` in `computeAssetDiff()`

**Files:**
- Modify: `lib/diff-engine.js:17-27` (AssetChange typedef)
- Modify: `lib/diff-engine.js:221-276` (computeAssetDiff function)
- Modify: `test/test-runner.js` (add test)

- [ ] **Step 1: Write the failing test**

Add in `test/test-runner.js`:

```js
test('computeAssetDiff includes chunks on AssetChange objects', () => {
  const baseAssets = [
    { name: 'app.js', size: 1000, chunkNames: ['main'], chunks: [0] },
  ];
  const prAssets = [
    { name: 'app.js', size: 1200, chunkNames: ['main'], chunks: [0, 3] },
    { name: 'index.html', size: 500, chunkNames: [], chunks: [0] },
  ];
  const diff = computeAssetDiff(baseAssets, prAssets);

  const appChange = diff.find(a => a.name === 'app.js');
  assertEqual(appChange.type, 'changed');
  // Chunks should be union of base [0] and PR [0, 3] = [0, 3]
  assertTrue(appChange.chunks.includes(0), 'Should include chunk 0');
  assertTrue(appChange.chunks.includes(3), 'Should include chunk 3');

  const htmlChange = diff.find(a => a.name === 'index.html');
  assertEqual(htmlChange.type, 'added');
  assertTrue(htmlChange.chunks.includes(0), 'HTML asset should have chunk 0');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/test-runner.js`
Expected: FAIL — `appChange.chunks` is undefined.

- [ ] **Step 3: Update AssetChange typedef**

In `lib/diff-engine.js`, change the typedef at lines 17-27 to add `chunks`:

```js
/**
 * @typedef {Object} AssetChange
 * @property {string} name - Output file name
 * @property {number} baseSize - Size in base branch (0 if new)
 * @property {number} prSize - Size in PR branch (0 if removed)
 * @property {number} change - Size difference in bytes
 * @property {string} changeFormatted - Human readable change
 * @property {string} type - 'added' | 'removed' | 'changed' | 'unchanged'
 * @property {string[]} chunkNames - Chunk names this asset belongs to
 * @property {number[]} chunks - Chunk IDs (union of base + PR) for module attribution
 * @property {AssetContributor[]} reasons - Top module/package contributors to size change
 */
```

- [ ] **Step 4: Update computeAssetDiff() to include chunks**

In `lib/diff-engine.js`, function `computeAssetDiff()` (lines 221-276), add a `chunks` field to every `AssetChange` object. For each of the 4 push sites:

**Added assets (line 230-238):** Add `chunks: [...(prAsset.chunks || [])],` after the `chunkNames` line.

**Changed assets (line 241-249):** Add union of base + PR chunks. Replace:
```js
        chunkNames: prAsset.chunkNames || [],
```
with:
```js
        chunkNames: prAsset.chunkNames || [],
        chunks: [...new Set([...(baseAsset.chunks || []), ...(prAsset.chunks || [])])],
```

**Unchanged assets (line 251-259):** Same union logic:
```js
        chunkNames: prAsset.chunkNames || [],
        chunks: [...new Set([...(baseAsset.chunks || []), ...(prAsset.chunks || [])])],
```

**Removed assets (line 266-274):** Add `chunks: [...(baseAsset.chunks || [])],` after `chunkNames`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `node test/test-runner.js`
Expected: ALL PASS (41 tests)

- [ ] **Step 6: Commit**

```bash
git add lib/diff-engine.js test/test-runner.js
git commit -m "feat: include chunk IDs on AssetChange for module attribution fallback"
```

---

### Task 4: Add asset-level chunks fallback in `computeAssetReasons()`

**Files:**
- Modify: `lib/diff-engine.js:370-425` (computeAssetReasons function)
- Modify: `test/test-runner.js` (add test)

- [ ] **Step 1: Write the failing test**

This tests the fallback: an asset that is NOT in `chunkToAssets` (like an HTML file) but HAS `chunks` on the asset object.

```js
test('computeAssetReasons uses asset-level chunks as fallback', () => {
  // HTML asset not in chunkToAssets map, but has chunks on the asset object
  const assetDiff = [
    {
      name: 'index.html',
      baseSize: 500,
      prSize: 520,
      change: 20,
      type: 'changed',
      chunkNames: [],
      chunks: [0],  // This is the fallback source
    },
  ];
  const moduleChanges = [
    { name: 'src/App.js', change: 15, chunks: [0], packageName: null },
    { name: 'node_modules/react/index.js', change: 5, chunks: [0], packageName: 'react' },
    { name: 'src/Other.js', change: 100, chunks: [1], packageName: null },  // Different chunk
  ];
  // Empty chunkToAssets — simulates HTML not being in stats.chunks[].files
  const baseChunkToAssets = {};
  const prChunkToAssets = {};

  computeAssetReasons(assetDiff, moduleChanges, baseChunkToAssets, prChunkToAssets);

  const html = assetDiff[0];
  assertEqual(html.reasons.length, 2, 'Should have 2 contributors from chunk 0');
  // src/App.js has larger absolute change first? No, Other.js is chunk 1. So App.js(15) and react(5).
  assertEqual(html.reasons[0].name, 'src/App.js', 'First contributor should be src/App.js');
  assertEqual(html.reasons[0].change, 15);
  assertEqual(html.reasons[1].name, 'react', 'Second should be react package');
  assertEqual(html.reasons[1].change, 5);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/test-runner.js`
Expected: FAIL — `html.reasons.length` is 0 because the reverse map has no entry for `index.html` and there's no fallback.

- [ ] **Step 3: Add fallback logic in computeAssetReasons()**

In `lib/diff-engine.js`, in the `computeAssetReasons()` function, change the block at lines 394-398 from:

```js
    const chunkIds = assetToChunkIds.get(asset.name);
    if (!chunkIds || chunkIds.size === 0) {
      asset.reasons = [];
      continue;
    }
```

to:

```js
    let chunkIds = assetToChunkIds.get(asset.name);
    // Fallback: if asset not in chunk→asset reverse map, use asset-level chunk IDs
    // This handles HTML files and other assets not listed in stats.chunks[].files
    if ((!chunkIds || chunkIds.size === 0) && asset.chunks && asset.chunks.length > 0) {
      chunkIds = new Set(asset.chunks);
    }
    if (!chunkIds || chunkIds.size === 0) {
      asset.reasons = [];
      continue;
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node test/test-runner.js`
Expected: ALL PASS (42 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/diff-engine.js test/test-runner.js
git commit -m "feat: fallback to asset-level chunk IDs for HTML asset reason attribution"
```

---

### Task 5: Create `computeEntrypointReasons()` and wire into `computeDiff()`

**Files:**
- Modify: `lib/diff-engine.js:30-37` (EntrypointChange typedef)
- Modify: `lib/diff-engine.js` (new function + call in computeDiff)
- Modify: `lib/diff-engine.js:494-505` (module.exports)
- Modify: `test/test-runner.js` (add tests)

- [ ] **Step 1: Write the failing tests**

Add two tests in `test/test-runner.js`:

```js
test('computeEntrypointReasons maps module changes to entrypoints via chunk IDs', () => {
  const entrypointDiff = [
    { name: 'app', baseSize: 1000, prSize: 1100, change: 100, type: 'changed' },
    { name: 'loader', baseSize: 500, prSize: 0, change: -500, type: 'removed' },
  ];
  const moduleChanges = [
    { name: 'src/App.js', change: 60, chunks: [0], packageName: null },
    { name: 'node_modules/lodash/index.js', change: 30, chunks: [0, 1], packageName: 'lodash' },
    { name: 'src/utils.js', change: 10, chunks: [2], packageName: null },
  ];
  const baseEntrypoints = [
    { name: 'app', chunks: [0, 1] },
    { name: 'loader', chunks: [1] },
  ];
  const prEntrypoints = [
    { name: 'app', chunks: [0, 1] },
  ];

  computeEntrypointReasons(entrypointDiff, moduleChanges, baseEntrypoints, prEntrypoints);

  const app = entrypointDiff[0];
  assertEqual(app.reasons.length, 2, 'app should have 2 contributors (chunks 0,1)');
  assertEqual(app.reasons[0].name, 'src/App.js', 'First should be App.js (60)');
  assertEqual(app.reasons[0].change, 60);
  assertEqual(app.reasons[1].name, 'lodash', 'Second should be lodash (30)');

  const loader = entrypointDiff[1];
  assertEqual(loader.reasons.length, 0, 'Removed entrypoint should have empty reasons');
});

test('computeEntrypointReasons returns empty reasons for unchanged entrypoints', () => {
  const entrypointDiff = [
    { name: 'app', baseSize: 1000, prSize: 1000, change: 0, type: 'unchanged' },
    { name: 'new-ep', baseSize: 0, prSize: 500, change: 500, type: 'added' },
  ];
  const moduleChanges = [
    { name: 'src/App.js', change: 0, chunks: [0], packageName: null },
  ];
  const baseEntrypoints = [{ name: 'app', chunks: [0] }];
  const prEntrypoints = [{ name: 'app', chunks: [0] }, { name: 'new-ep', chunks: [1] }];

  computeEntrypointReasons(entrypointDiff, moduleChanges, baseEntrypoints, prEntrypoints);

  assertEqual(entrypointDiff[0].reasons.length, 0, 'Unchanged should have empty reasons');
  assertEqual(entrypointDiff[1].reasons.length, 0, 'Added should have empty reasons');
});
```

- [ ] **Step 2: Update test imports**

At the top of `test/test-runner.js`, the diff-engine import needs `computeEntrypointReasons`. Find the existing require for diff-engine at line 135 and add it. The current import line is:

```js
const { computeDiff, generateSummary, computeAssetDiff, computeEntrypointDiff, computeAssetReasons } = require('../lib/diff-engine');
```

Change to:

```js
const { computeDiff, generateSummary, computeAssetDiff, computeEntrypointDiff, computeAssetReasons, computeEntrypointReasons } = require('../lib/diff-engine');
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `node test/test-runner.js`
Expected: FAIL — `computeEntrypointReasons is not a function`.

- [ ] **Step 4: Update EntrypointChange typedef**

In `lib/diff-engine.js`, change lines 30-37 from:

```js
/**
 * @typedef {Object} EntrypointChange
 * @property {string} name - Entrypoint name
 * @property {number} baseSize - Total assets size in base branch (0 if new)
 * @property {number} prSize - Total assets size in PR branch (0 if removed)
 * @property {number} change - Size difference in bytes
 * @property {string} changeFormatted - Human readable change
 * @property {string} type - 'added' | 'removed' | 'changed' | 'unchanged'
 */
```

to:

```js
/**
 * @typedef {Object} EntrypointChange
 * @property {string} name - Entrypoint name
 * @property {number} baseSize - Total assets size in base branch (0 if new)
 * @property {number} prSize - Total assets size in PR branch (0 if removed)
 * @property {number} change - Size difference in bytes
 * @property {string} changeFormatted - Human readable change
 * @property {string} type - 'added' | 'removed' | 'changed' | 'unchanged'
 * @property {AssetContributor[]} reasons - Top module/package contributors to size change
 */
```

- [ ] **Step 5: Implement computeEntrypointReasons()**

In `lib/diff-engine.js`, add the following function AFTER `computeAssetReasons()` (after line 425) and BEFORE `computePackageDiffs()`:

```js
/**
 * Compute module-level reasons (contributors) for each entrypoint's size change.
 * Maps module changes to entrypoints using the entrypoint's chunk IDs.
 *
 * @param {EntrypointChange[]} entrypointDiff - Entrypoint-level changes
 * @param {ModuleChange[]} moduleChanges - All module changes
 * @param {import('./stats-parser').ParsedEntrypoint[]} baseEntrypoints - Base branch entrypoints
 * @param {import('./stats-parser').ParsedEntrypoint[]} prEntrypoints - PR branch entrypoints
 * @param {number} [topN=3] - Number of top contributors to return per entrypoint
 */
function computeEntrypointReasons(entrypointDiff, moduleChanges, baseEntrypoints, prEntrypoints, topN = 3) {
  // Build entrypoint name → chunk IDs (union of base and PR)
  const epToChunkIds = new Map();

  for (const ep of baseEntrypoints) {
    if (!epToChunkIds.has(ep.name)) epToChunkIds.set(ep.name, new Set());
    for (const cid of (ep.chunks || [])) {
      epToChunkIds.get(ep.name).add(cid);
    }
  }
  for (const ep of prEntrypoints) {
    if (!epToChunkIds.has(ep.name)) epToChunkIds.set(ep.name, new Set());
    for (const cid of (ep.chunks || [])) {
      epToChunkIds.get(ep.name).add(cid);
    }
  }

  for (const ep of entrypointDiff) {
    if (ep.type === 'added' || ep.type === 'removed' || ep.type === 'unchanged') {
      ep.reasons = [];
      continue;
    }

    const chunkIds = epToChunkIds.get(ep.name);
    if (!chunkIds || chunkIds.size === 0) {
      ep.reasons = [];
      continue;
    }

    // Find module changes that belong to this entrypoint's chunks
    const relevant = moduleChanges.filter(mc =>
      mc.chunks.some(cid => chunkIds.has(cid))
    );

    // Group by package name (for node_modules) or use module name for source files
    const grouped = new Map();
    for (const mc of relevant) {
      const key = mc.packageName || mc.name;
      if (!grouped.has(key)) grouped.set(key, 0);
      grouped.set(key, grouped.get(key) + mc.change);
    }

    // Sort by absolute change, take top N
    const sorted = [...grouped.entries()]
      .sort(([, a], [, b]) => Math.abs(b) - Math.abs(a))
      .slice(0, topN);

    ep.reasons = sorted.map(([name, change]) => ({
      name,
      change,
      changeFormatted: formatSignedBytes(change),
      type: change > 0 ? 'added' : change < 0 ? 'removed' : 'changed',
    }));
  }
}
```

- [ ] **Step 6: Wire computeEntrypointReasons() into computeDiff()**

In `lib/diff-engine.js`, in the `computeDiff()` function, add the call after the existing `computeAssetReasons()` call (after line 129):

```js
  // Compute module-level reasons for each entrypoint's size change
  computeEntrypointReasons(
    entrypointDiff,
    allChanges,
    baseStats.entrypoints || [],
    prStats.entrypoints || [],
  );
```

- [ ] **Step 7: Export the new function**

In `lib/diff-engine.js`, add `computeEntrypointReasons` to the `module.exports` object (line 494-505):

```js
module.exports = {
  computeDiff,
  createModuleChange,
  buildImportChain,
  computePackageDiffs,
  computeAssetDiff,
  computeEntrypointDiff,
  computeAssetReasons,
  computeEntrypointReasons,
  formatSignedBytes,
  generateSummary,
  formatBytes,
};
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `node test/test-runner.js`
Expected: ALL PASS (44 tests)

- [ ] **Step 9: Commit**

```bash
git add lib/diff-engine.js test/test-runner.js
git commit -m "feat: add computeEntrypointReasons() for entrypoint module attribution"
```

---

## Chunk 2: Report Renderer Updates

### Task 6: Update comment.js entrypoint table to show reasons

**Files:**
- Modify: `scripts/comment.js:100-128` (entrypoint section)

- [ ] **Step 1: Update entrypoint table header**

In `scripts/comment.js`, change line 108 from:

```js
    lines.push('| Entrypoint | Base | PR | Change |');
```

to:

```js
    lines.push('| Entrypoint | Base | PR | Change | Top Contributors |');
```

And change line 109 from:

```js
    lines.push('|------------|------|-----|--------|');
```

to:

```js
    lines.push('|------------|------|-----|--------|-----------------|');
```

- [ ] **Step 2: Add reasons cell to each entrypoint row**

In `scripts/comment.js`, change line 122 from:

```js
      lines.push(`| \`${ep.name}\` | ${baseSizeStr} | ${prSizeStr} | ${changeStr} |`);
```

to:

```js
      const reasonsStr = formatAssetReasons(ep);
      lines.push(`| \`${ep.name}\` | ${baseSizeStr} | ${prSizeStr} | ${changeStr} | ${reasonsStr} |`);
```

- [ ] **Step 3: Run tests to verify nothing broke**

Run: `node test/test-runner.js`
Expected: ALL PASS

- [ ] **Step 4: Commit**

```bash
git add scripts/comment.js
git commit -m "feat: show Top Contributors in entrypoint table (comment.js)"
```

---

### Task 7: Update diff.js entrypoint section to show reasons

**Files:**
- Modify: `scripts/diff.js:103-128` (entrypoint section)

- [ ] **Step 1: Add contributors line after each entrypoint**

In `scripts/diff.js`, after line 125:

```js
      lines.push(`${symbol} ${ep.name}  ${baseSizeStr} → ${prSizeStr}  ${changeStr}`);
```

Add:

```js
      const reasonsStr = formatAssetReasonsText(ep);
      if (reasonsStr) {
        lines.push(`    Contributors: ${reasonsStr}`);
      }
```

(The `formatAssetReasonsText()` function at line 287 already handles `asset.reasons || []` and returns `null` for added/removed types, so it works for entrypoints too.)

- [ ] **Step 2: Run tests to verify nothing broke**

Run: `node test/test-runner.js`
Expected: ALL PASS

- [ ] **Step 3: Commit**

```bash
git add scripts/diff.js
git commit -m "feat: show Contributors in entrypoint section (diff.js)"
```

---

### Task 8: Update analyze.js entrypoint section and JSON output

**Files:**
- Modify: `scripts/analyze.js:237-262` (entrypoint display section)
- Modify: `scripts/analyze.js:360-371` (JSON output entrypoints)

- [ ] **Step 1: Add contributors line in entrypoint display**

In `scripts/analyze.js`, after the `prAssets` block (after line 259, but still inside the `for` loop — before the closing `}`):

```js
      if (ep.prAssets && ep.prAssets.length > 0) {
        lines.push(`    Assets: ${ep.prAssets.join(', ')}`);
      }
```

Add after it:

```js
      const reasons = ep.reasons || [];
      if (reasons.length > 0 && ep.type === 'changed') {
        const reasonStr = reasons.map(r => `${r.name} (${r.changeFormatted})`).join(', ');
        lines.push(`    Contributors: ${reasonStr}`);
      }
```

- [ ] **Step 2: Add reasons to JSON output**

In `scripts/analyze.js`, in the `generateJSONOutput()` function, change the entrypoints mapping (lines 360-370) from:

```js
    entrypoints: {
      changes: (diff.entrypointDiff || []).filter(e => e.type !== 'unchanged').map(e => ({
        name: e.name,
        type: e.type,
        baseSize: e.baseSize,
        prSize: e.prSize,
        change: e.change,
        baseAssets: e.baseAssets || [],
        prAssets: e.prAssets || [],
      })),
    },
```

to:

```js
    entrypoints: {
      changes: (diff.entrypointDiff || []).filter(e => e.type !== 'unchanged').map(e => ({
        name: e.name,
        type: e.type,
        baseSize: e.baseSize,
        prSize: e.prSize,
        change: e.change,
        baseAssets: e.baseAssets || [],
        prAssets: e.prAssets || [],
        reasons: (e.reasons || []).map(r => ({
          name: r.name,
          change: r.change,
          changeFormatted: r.changeFormatted,
          type: r.type,
        })),
      })),
    },
```

- [ ] **Step 3: Run tests to verify nothing broke**

Run: `node test/test-runner.js`
Expected: ALL PASS

- [ ] **Step 4: Commit**

```bash
git add scripts/analyze.js
git commit -m "feat: show Contributors in entrypoint section and JSON output (analyze.js)"
```

---

### Task 9: Update ai-client.js entrypoint prompt section

**Files:**
- Modify: `lib/ai-client.js:269-280` (entrypoint prompt section)

- [ ] **Step 1: Add contributors to entrypoint prompt lines**

In `lib/ai-client.js`, change the entrypoint loop (lines 274-279) from:

```js
    for (const ep of significantEntrypoints) {
      const baseSizeStr = ep.baseSize > 0 ? formatBytes(ep.baseSize) : '-';
      const prSizeStr = ep.prSize > 0 ? formatBytes(ep.prSize) : '-';
      const label = ep.type === 'added' ? '[NEW]' : ep.type === 'removed' ? '[DEL]' : '[CHG]';
      promptParts.push(`- ${label} ${ep.name}: ${baseSizeStr} → ${prSizeStr} (${ep.changeFormatted})`);
    }
```

to:

```js
    for (const ep of significantEntrypoints) {
      const baseSizeStr = ep.baseSize > 0 ? formatBytes(ep.baseSize) : '-';
      const prSizeStr = ep.prSize > 0 ? formatBytes(ep.prSize) : '-';
      const label = ep.type === 'added' ? '[NEW]' : ep.type === 'removed' ? '[DEL]' : '[CHG]';
      let line = `- ${label} ${ep.name}: ${baseSizeStr} → ${prSizeStr} (${ep.changeFormatted})`;
      const reasons = ep.reasons || [];
      if (reasons.length > 0) {
        const reasonStr = reasons.map(r => `${r.name} (${r.changeFormatted})`).join(', ');
        line += ` — Contributors: ${reasonStr}`;
      }
      promptParts.push(line);
    }
```

- [ ] **Step 2: Run tests to verify nothing broke**

Run: `node test/test-runner.js`
Expected: ALL PASS

- [ ] **Step 3: Commit**

```bash
git add lib/ai-client.js
git commit -m "feat: include entrypoint contributors in AI analysis prompt"
```

---

### Task 10: Add end-to-end integration test

**Files:**
- Modify: `test/test-runner.js` (add integration test)

- [ ] **Step 1: Write integration test**

Add near the end of `test/test-runner.js` (before the Summary block):

```js
test('computeDiff produces entrypoint reasons end-to-end', () => {
  // Use the sample stats files which now have chunks on entrypoints
  const baseStats = parseStats(JSON.parse(fs.readFileSync(path.join(__dirname, 'sample-base-stats.json'), 'utf-8')));
  const prStats = parseStats(JSON.parse(fs.readFileSync(path.join(__dirname, 'sample-pr-stats.json'), 'utf-8')));
  const diff = computeDiff(baseStats, prStats);

  // app entrypoint should be 'changed' (assetsSize differs: 1769472 vs 2084288)
  const appEp = diff.entrypointDiff.find(e => e.name === 'app');
  assertTrue(appEp !== undefined, 'app entrypoint should exist');
  assertEqual(appEp.type, 'changed', 'app should be changed');
  assertTrue(Array.isArray(appEp.reasons), 'app should have reasons array');
  // Reasons may be empty if no module changes match app's chunks, but the field must exist
});
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `node test/test-runner.js`
Expected: ALL PASS (45 tests)

- [ ] **Step 3: Commit**

```bash
git add test/test-runner.js
git commit -m "test: add end-to-end integration test for entrypoint reasons"
```

---

### Task 11: Final verification

- [ ] **Step 1: Run all tests**

Run: `node test/test-runner.js`
Expected: ALL PASS (45 tests, 0 failures)

- [ ] **Step 2: Verify no regressions with sample stats**

Run: `node scripts/diff.js --base test/sample-base-stats.json --pr test/sample-pr-stats.json`
Expected: Output shows entrypoint section with Contributors lines where applicable.

- [ ] **Step 3: Verify comment output**

Run: `node cli.js --base test/sample-base-stats.json --pr test/sample-pr-stats.json --format comment 2>/dev/null || true`
Expected: Entrypoint table has 5 columns (including Top Contributors).
