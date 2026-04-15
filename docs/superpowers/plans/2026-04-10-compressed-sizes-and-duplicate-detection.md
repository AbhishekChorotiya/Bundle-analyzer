# Compressed Sizes & Duplicate Detection Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add gzip/brotli compressed size estimation and PR-introduced duplicate dependency detection to all outputs (reports, PR comment, AI prompt, JSON).

**Architecture:** Compressed sizes are estimated from raw byte sizes using per-extension ratios (no file I/O). Duplicate detection groups `node_modules` modules by canonical package name, finds multiple installation paths, and compares base vs PR to flag only new duplicates. Both features integrate into stats-parser → diff-engine → renderers/AI pipeline.

**Tech Stack:** Node.js (zero dependencies), custom test runner at `test/test-runner.js`

**Spec:** `docs/superpowers/specs/2026-04-10-compressed-sizes-and-duplicate-detection-design.md`

---

## Chunk 1: Compressed Size Estimation (stats-parser.js)

### Task 1: Add `estimateCompressedSize` function to stats-parser.js

**Files:**
- Modify: `lib/stats-parser.js:20-26` (ParsedAsset typedef), `lib/stats-parser.js:292-304` (parseAssets)
- Test: `test/test-runner.js`

- [ ] **Step 1: Write failing tests for `estimateCompressedSize`**

Add after the existing stats-parser tests (before diff-engine tests section). In `test/test-runner.js`, after the `parseEntrypoints extracts chunks array` test:

```js
test('estimateCompressedSize returns correct gzip/brotli for .js files', () => {
  const { estimateCompressedSize } = require('../lib/stats-parser');
  const result = estimateCompressedSize(100000, 'main.bundle.js');
  assertEqual(result.gzip, 30000, 'JS gzip should be 30% of raw');
  assertEqual(result.brotli, 25000, 'JS brotli should be 25% of raw');
});

test('estimateCompressedSize returns correct ratios for .css files', () => {
  const { estimateCompressedSize } = require('../lib/stats-parser');
  const result = estimateCompressedSize(100000, 'styles.css');
  assertEqual(result.gzip, 25000, 'CSS gzip should be 25% of raw');
  assertEqual(result.brotli, 20000, 'CSS brotli should be 20% of raw');
});

test('estimateCompressedSize uses default ratios for unknown extensions', () => {
  const { estimateCompressedSize } = require('../lib/stats-parser');
  const result = estimateCompressedSize(100000, 'data.bin');
  assertEqual(result.gzip, 50000, 'Unknown gzip should be 50% of raw');
  assertEqual(result.brotli, 45000, 'Unknown brotli should be 45% of raw');
});

test('estimateCompressedSize handles zero size', () => {
  const { estimateCompressedSize } = require('../lib/stats-parser');
  const result = estimateCompressedSize(0, 'main.js');
  assertEqual(result.gzip, 0, 'Zero size gzip should be 0');
  assertEqual(result.brotli, 0, 'Zero size brotli should be 0');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node test/test-runner.js`
Expected: FAIL — `estimateCompressedSize` is not exported

- [ ] **Step 3: Implement `estimateCompressedSize` and update `ParsedAsset` typedef**

In `lib/stats-parser.js`, add the CompressedSize typedef after line 26 (after ParsedAsset typedef):

```js
/**
 * @typedef {Object} CompressedSize
 * @property {number} gzip - Estimated gzip compressed size in bytes
 * @property {number} brotli - Estimated brotli compressed size in bytes
 */
```

Update the `ParsedAsset` typedef (lines 20-26) to add:
```js
 * @property {CompressedSize} compressed - Estimated compressed sizes
```

Add the compression ratio constants and function before `parseAssets` (before line 292):

```js
/**
 * Compression ratio estimates by file extension.
 * Ratios represent compressed/raw size (lower = better compression).
 * Based on industry benchmarks for minified production assets.
 */
const COMPRESSION_RATIOS = {
  '.js':   { gzip: 0.30, brotli: 0.25 },
  '.mjs':  { gzip: 0.30, brotli: 0.25 },
  '.css':  { gzip: 0.25, brotli: 0.20 },
  '.html': { gzip: 0.30, brotli: 0.25 },
  '.json': { gzip: 0.25, brotli: 0.20 },
  '.svg':  { gzip: 0.40, brotli: 0.35 },
  '.wasm': { gzip: 0.70, brotli: 0.65 },
};
const DEFAULT_RATIOS = { gzip: 0.50, brotli: 0.45 };

/**
 * Estimate compressed sizes for an asset based on file extension.
 * Uses well-established compression ratios for minified production assets.
 * @param {number} size - Raw size in bytes
 * @param {string} filename - Asset filename (used to determine extension)
 * @returns {CompressedSize}
 */
function estimateCompressedSize(size, filename) {
  if (size === 0) return { gzip: 0, brotli: 0 };
  const ext = filename.includes('.') ? '.' + filename.split('.').pop().toLowerCase() : '';
  const ratios = COMPRESSION_RATIOS[ext] || DEFAULT_RATIOS;
  return {
    gzip: Math.round(size * ratios.gzip),
    brotli: Math.round(size * ratios.brotli),
  };
}
```

Update `parseAssets` (line 297-303) to add `compressed` field to each asset:
```js
    .map(a => {
      const size = a.size || 0;
      return {
        name: a.name,
        size,
        chunkNames: a.chunkNames || [],
        chunks: Array.isArray(a.chunks) ? a.chunks : [],
        compressed: estimateCompressedSize(size, a.name),
      };
    })
```

Add `estimateCompressedSize` to the module.exports (line 340).

- [ ] **Step 4: Run tests to verify they pass**

Run: `node test/test-runner.js`
Expected: ALL PASS including the 4 new tests

- [ ] **Step 5: Add compressed sizes to `ParsedEntrypoint` and `BundleStats`**

Update `ParsedEntrypoint` typedef (lines 28-34) to add:
```js
 * @property {CompressedSize} compressed - Estimated compressed entrypoint sizes
```

Update `BundleStats` typedef (lines 36-47) to add:
```js
 * @property {number} totalGzipSize - Total estimated gzip size of all deliverable assets
```

In `parseEntrypoints` (line 331-337), compute compressed size for each entrypoint:
```js
    const assetsSize = ep.assetsSize || assets.reduce((sum, a) => sum + a.size, 0);
    // Sum gzip/brotli across all entrypoint assets
    const compressed = assets.reduce(
      (acc, a) => {
        const c = estimateCompressedSize(a.size || 0, a.name);
        return { gzip: acc.gzip + c.gzip, brotli: acc.brotli + c.brotli };
      },
      { gzip: 0, brotli: 0 }
    );

    return {
      name,
      assets,
      assetsSize,
      chunks: Array.isArray(ep.chunks) ? ep.chunks : [],
      compressed,
    };
```

In `parseStats` return object (line 86-96), add `totalGzipSize`:
```js
    totalGzipSize: assets.reduce((sum, a) => sum + a.compressed.gzip, 0),
```

- [ ] **Step 6: Add test for entrypoint compressed sizes**

```js
test('parseEntrypoints computes compressed sizes', () => {
  const stats = {
    assets: [
      { name: 'main.js', size: 100000, chunkNames: ['main'], chunks: [0] },
      { name: 'vendor.js', size: 50000, chunkNames: ['vendor'], chunks: [1] },
    ],
    entrypoints: {
      app: { assets: [{ name: 'main.js', size: 100000 }, { name: 'vendor.js', size: 50000 }], chunks: [0, 1] },
    },
  };
  const result = parseEntrypoints(stats);
  assertEqual(result.length, 1, 'Should have 1 entrypoint');
  assertTrue(result[0].compressed.gzip > 0, 'Gzip should be positive');
  assertTrue(result[0].compressed.brotli > 0, 'Brotli should be positive');
  // main.js: 30000 gzip + vendor.js: 15000 gzip = 45000
  assertEqual(result[0].compressed.gzip, 45000, 'Entrypoint gzip should sum assets');
});
```

- [ ] **Step 7: Run tests and verify**

Run: `node test/test-runner.js`
Expected: ALL PASS

- [ ] **Step 8: Commit**

```bash
git add lib/stats-parser.js test/test-runner.js
git commit -m "feat: add compressed size estimation to parsed assets and entrypoints"
```

---

### Task 2: Add compressed size fields to diff-engine.js

**Files:**
- Modify: `lib/diff-engine.js:18-28` (AssetChange typedef), `lib/diff-engine.js:30-39` (EntrypointChange typedef), `lib/diff-engine.js:55-68` (BundleDiff typedef), `lib/diff-engine.js:231-302` (computeAssetDiff), `lib/diff-engine.js:310-371` (computeEntrypointDiff), `lib/diff-engine.js:76-162` (computeDiff)
- Test: `test/test-runner.js`

- [ ] **Step 1: Write failing tests for gzip fields on AssetChange**

```js
test('computeAssetDiff includes gzip sizes on AssetChange', () => {
  const baseAssets = [
    { name: 'main.js', size: 100000, chunkNames: [], chunks: [0], compressed: { gzip: 30000, brotli: 25000 } },
  ];
  const prAssets = [
    { name: 'main.js', size: 120000, chunkNames: [], chunks: [0], compressed: { gzip: 36000, brotli: 30000 } },
  ];
  const result = computeAssetDiff(baseAssets, prAssets);
  const main = result.find(a => a.name === 'main.js');
  assertEqual(main.baseGzip, 30000, 'Should have base gzip');
  assertEqual(main.prGzip, 36000, 'Should have PR gzip');
  assertEqual(main.gzipChange, 6000, 'Should compute gzip diff');
});

test('computeAssetDiff has zero gzip for new assets base', () => {
  const baseAssets = [];
  const prAssets = [
    { name: 'new.js', size: 50000, chunkNames: [], chunks: [0], compressed: { gzip: 15000, brotli: 12500 } },
  ];
  const result = computeAssetDiff(baseAssets, prAssets);
  const newAsset = result.find(a => a.name === 'new.js');
  assertEqual(newAsset.baseGzip, 0, 'New asset base gzip should be 0');
  assertEqual(newAsset.prGzip, 15000, 'New asset PR gzip should be set');
  assertEqual(newAsset.gzipChange, 15000, 'New asset gzip change should equal PR gzip');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node test/test-runner.js`
Expected: FAIL — `baseGzip` is undefined

- [ ] **Step 3: Update AssetChange typedef and computeAssetDiff**

Update the `AssetChange` typedef (lines 18-28) to add:
```js
 * @property {number} baseGzip - Gzip size in base (0 if new)
 * @property {number} prGzip - Gzip size in PR (0 if removed)
 * @property {number} gzipChange - Gzip size difference
```

In `computeAssetDiff` (lines 231-302), add gzip fields to each change object:

For added assets (line 240-249):
```js
      changes.push({
        name,
        baseSize: 0,
        prSize: prAsset.size,
        change: prAsset.size,
        changeFormatted: formatSignedBytes(prAsset.size),
        type: 'added',
        chunkNames: prAsset.chunkNames || [],
        chunks: [...(prAsset.chunks || [])],
        baseGzip: 0,
        prGzip: prAsset.compressed?.gzip || 0,
        gzipChange: prAsset.compressed?.gzip || 0,
      });
```

For changed assets (line 250-261):
```js
      const baseGzip = baseAsset.compressed?.gzip || 0;
      const prGzip = prAsset.compressed?.gzip || 0;
      changes.push({
        name,
        baseSize: baseAsset.size,
        prSize: prAsset.size,
        change: diff,
        changeFormatted: formatSignedBytes(diff),
        type: 'changed',
        chunkNames: prAsset.chunkNames || [],
        chunks: [...new Set([...(baseAsset.chunks || []), ...(prAsset.chunks || [])])],
        baseGzip,
        prGzip,
        gzipChange: prGzip - baseGzip,
      });
```

For unchanged assets (line 262-273):
```js
      const gzip = prAsset.compressed?.gzip || 0;
      changes.push({
        name,
        baseSize: baseAsset.size,
        prSize: prAsset.size,
        change: 0,
        changeFormatted: formatSignedBytes(0),
        type: 'unchanged',
        chunkNames: prAsset.chunkNames || [],
        chunks: [...new Set([...(baseAsset.chunks || []), ...(prAsset.chunks || [])])],
        baseGzip: gzip,
        prGzip: gzip,
        gzipChange: 0,
      });
```

For removed assets (line 277-289):
```js
      changes.push({
        name,
        baseSize: baseAsset.size,
        prSize: 0,
        change: -baseAsset.size,
        changeFormatted: formatSignedBytes(-baseAsset.size),
        type: 'removed',
        chunkNames: baseAsset.chunkNames || [],
        chunks: [...(baseAsset.chunks || [])],
        baseGzip: baseAsset.compressed?.gzip || 0,
        prGzip: 0,
        gzipChange: -(baseAsset.compressed?.gzip || 0),
      });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node test/test-runner.js`
Expected: ALL PASS

- [ ] **Step 5: Update EntrypointChange typedef and computeEntrypointDiff**

Update `EntrypointChange` typedef (lines 30-39) to add:
```js
 * @property {number} baseGzip - Gzip size in base (0 if new)
 * @property {number} prGzip - Gzip size in PR (0 if removed)
 * @property {number} gzipChange - Gzip size difference
```

In `computeEntrypointDiff` (lines 310-371), add gzip fields:

For added (line 319-325): add `baseGzip: 0, prGzip: prEp.compressed?.gzip || 0, gzipChange: prEp.compressed?.gzip || 0,`

For changed (line 327-336): compute `const baseGzip = baseEp.compressed?.gzip || 0; const prGzip = prEp.compressed?.gzip || 0;` and add `baseGzip, prGzip, gzipChange: prGzip - baseGzip,`

For unchanged (line 337-345): compute `const gzip = prEp.compressed?.gzip || 0;` and add `baseGzip: gzip, prGzip: gzip, gzipChange: 0,`

For removed (line 350-360): add `baseGzip: baseEp.compressed?.gzip || 0, prGzip: 0, gzipChange: -(baseEp.compressed?.gzip || 0),`

- [ ] **Step 6: Update BundleDiff typedef and computeDiff return**

Update `BundleDiff` typedef (lines 55-68) to add:
```js
 * @property {number} totalGzipDiff - Total gzip size change
 * @property {number} baseGzipSize - Total gzip size in base
 * @property {number} prGzipSize - Total gzip size in PR
```

In `computeDiff` return object (lines 141-161), add:
```js
    baseGzipSize: baseStats.totalGzipSize || 0,
    prGzipSize: prStats.totalGzipSize || 0,
    totalGzipDiff: (prStats.totalGzipSize || 0) - (baseStats.totalGzipSize || 0),
```

- [ ] **Step 7: Write integration test for gzip in computeDiff**

```js
test('computeDiff includes gzip size data', () => {
  const baseStats = parseStats(JSON.parse(fs.readFileSync(path.join(__dirname, 'sample-base-stats.json'), 'utf-8')));
  const prStats = parseStats(JSON.parse(fs.readFileSync(path.join(__dirname, 'sample-pr-stats.json'), 'utf-8')));
  const diff = computeDiff(baseStats, prStats);

  assertTrue(diff.baseGzipSize > 0, 'Base gzip size should be positive');
  assertTrue(diff.prGzipSize > 0, 'PR gzip size should be positive');
  assertTrue(diff.prGzipSize > diff.baseGzipSize, 'PR gzip should be larger (PR added assets)');

  const mainAsset = diff.assetDiff.find(a => a.name === 'main.bundle.js');
  assertTrue(mainAsset.baseGzip > 0, 'Asset should have base gzip');
  assertTrue(mainAsset.prGzip > 0, 'Asset should have PR gzip');
});
```

- [ ] **Step 8: Run tests and verify**

Run: `node test/test-runner.js`
Expected: ALL PASS

- [ ] **Step 9: Commit**

```bash
git add lib/diff-engine.js test/test-runner.js
git commit -m "feat: add gzip size fields to asset and entrypoint diffs"
```

---

## Chunk 2: Duplicate Dependency Detection

### Task 3: Add `findDuplicatePackages` to stats-parser.js

**Files:**
- Modify: `lib/stats-parser.js` (add typedef and function, update parseStats, update exports)
- Test: `test/test-runner.js`

- [ ] **Step 1: Write failing tests for `findDuplicatePackages`**

```js
test('findDuplicatePackages detects multi-path packages', () => {
  const { findDuplicatePackages } = require('../lib/stats-parser');
  const modules = [
    { name: 'node_modules/lodash/lodash.js', size: 50000, isNodeModule: true },
    { name: 'node_modules/lib-a/node_modules/lodash/lodash.js', size: 45000, isNodeModule: true },
    { name: 'node_modules/react/index.js', size: 5000, isNodeModule: true },
    { name: 'src/App.js', size: 3000, isNodeModule: false },
  ];
  const result = findDuplicatePackages(modules);
  assertEqual(result.length, 1, 'Should find 1 duplicate');
  assertEqual(result[0].name, 'lodash', 'Duplicate should be lodash');
  assertEqual(result[0].instanceCount, 2, 'Should have 2 instances');
  assertEqual(result[0].totalSize, 95000, 'Total size should be sum');
  assertEqual(result[0].wastedSize, 45000, 'Wasted should be all except largest');
});

test('findDuplicatePackages handles scoped packages', () => {
  const { findDuplicatePackages } = require('../lib/stats-parser');
  const modules = [
    { name: 'node_modules/@babel/runtime/helpers/esm/extends.js', size: 1000, isNodeModule: true },
    { name: 'node_modules/some-lib/node_modules/@babel/runtime/helpers/esm/extends.js', size: 1200, isNodeModule: true },
  ];
  const result = findDuplicatePackages(modules);
  assertEqual(result.length, 1, 'Should find 1 duplicate');
  assertEqual(result[0].name, '@babel/runtime', 'Should detect scoped package');
});

test('findDuplicatePackages returns empty for no duplicates', () => {
  const { findDuplicatePackages } = require('../lib/stats-parser');
  const modules = [
    { name: 'node_modules/react/index.js', size: 5000, isNodeModule: true },
    { name: 'node_modules/react-dom/index.js', size: 20000, isNodeModule: true },
    { name: 'src/App.js', size: 3000, isNodeModule: false },
  ];
  const result = findDuplicatePackages(modules);
  assertEqual(result.length, 0, 'Should find no duplicates');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node test/test-runner.js`
Expected: FAIL — `findDuplicatePackages` is not exported

- [ ] **Step 3: Implement `findDuplicatePackages`**

Add the `DuplicatePackage` typedef after the `CompressedSize` typedef:

```js
/**
 * @typedef {Object} DuplicatePackage
 * @property {string} name - Canonical package name (e.g., "lodash")
 * @property {string[]} paths - All unique node_modules paths where it appears
 * @property {number} instanceCount - Number of instances
 * @property {number} totalSize - Total size across all instances
 * @property {number} wastedSize - Size of all instances except the largest
 */
```

Add the function before the `module.exports`:

```js
/**
 * Detect duplicate packages in the bundle.
 * Groups node_modules modules by canonical package name, then finds packages
 * installed at multiple node_modules paths (e.g., top-level + nested).
 * @param {ParsedModule[]} modules - All parsed modules
 * @returns {DuplicatePackage[]}
 */
function findDuplicatePackages(modules) {
  // Group modules by canonical package name AND installation path
  // Key: package name, Value: Map<installPath, totalSize>
  const packagePaths = new Map();

  for (const mod of modules) {
    if (!mod.isNodeModule) continue;
    const pkgName = extractPackageName(mod.name);
    if (!pkgName) continue;

    // Extract the full path up to and including the package dir
    // e.g., "node_modules/lib-a/node_modules/lodash/lodash.js" → "node_modules/lib-a/node_modules/lodash"
    const pathMatch = mod.name.match(/((?:.*\/)?node_modules\/(?:@[^/]+\/[^/]+|[^/]+))/);
    if (!pathMatch) continue;
    const installPath = pathMatch[1];

    if (!packagePaths.has(pkgName)) packagePaths.set(pkgName, new Map());
    const paths = packagePaths.get(pkgName);
    paths.set(installPath, (paths.get(installPath) || 0) + mod.size);
  }

  // Find packages with multiple installation paths
  const duplicates = [];
  for (const [name, paths] of packagePaths) {
    if (paths.size <= 1) continue;

    const instances = [...paths.entries()].map(([p, s]) => ({ path: p, size: s }));
    const totalSize = instances.reduce((sum, i) => sum + i.size, 0);
    const largestSize = Math.max(...instances.map(i => i.size));

    duplicates.push({
      name,
      paths: instances.map(i => i.path),
      instanceCount: instances.length,
      totalSize,
      wastedSize: totalSize - largestSize,
    });
  }

  // Sort by wasted size descending
  return duplicates.sort((a, b) => b.wastedSize - a.wastedSize);
}
```

Update `BundleStats` typedef to add:
```js
 * @property {DuplicatePackage[]} duplicates - Duplicate packages found in the bundle
```

In `parseStats` return object, add:
```js
    duplicates: findDuplicatePackages(modules),
```

Add `findDuplicatePackages` to module.exports.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node test/test-runner.js`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add lib/stats-parser.js test/test-runner.js
git commit -m "feat: add duplicate package detection to stats parser"
```

---

### Task 4: Add `computeNewDuplicates` to diff-engine.js

**Files:**
- Modify: `lib/diff-engine.js` (add function, update computeDiff, update BundleDiff typedef, update exports)
- Test: `test/test-runner.js`

- [ ] **Step 1: Write failing tests**

```js
test('computeNewDuplicates flags only PR-introduced duplicates', () => {
  const { computeNewDuplicates } = require('../lib/diff-engine');
  const baseDuplicates = [
    { name: 'lodash', paths: ['node_modules/lodash', 'node_modules/a/node_modules/lodash'], instanceCount: 2, totalSize: 90000, wastedSize: 40000 },
  ];
  const prDuplicates = [
    { name: 'lodash', paths: ['node_modules/lodash', 'node_modules/a/node_modules/lodash'], instanceCount: 2, totalSize: 90000, wastedSize: 40000 },
    { name: 'moment', paths: ['node_modules/moment', 'node_modules/b/node_modules/moment'], instanceCount: 2, totalSize: 200000, wastedSize: 95000 },
  ];
  const result = computeNewDuplicates(baseDuplicates, prDuplicates);
  assertEqual(result.length, 1, 'Should only flag moment (new in PR)');
  assertEqual(result[0].name, 'moment', 'New duplicate should be moment');
});

test('computeNewDuplicates flags duplicates with more instances in PR', () => {
  const { computeNewDuplicates } = require('../lib/diff-engine');
  const baseDuplicates = [
    { name: 'lodash', paths: ['node_modules/lodash', 'node_modules/a/node_modules/lodash'], instanceCount: 2, totalSize: 90000, wastedSize: 40000 },
  ];
  const prDuplicates = [
    { name: 'lodash', paths: ['node_modules/lodash', 'node_modules/a/node_modules/lodash', 'node_modules/c/node_modules/lodash'], instanceCount: 3, totalSize: 135000, wastedSize: 85000 },
  ];
  const result = computeNewDuplicates(baseDuplicates, prDuplicates);
  assertEqual(result.length, 1, 'Should flag lodash (grew from 2 to 3 instances)');
  assertEqual(result[0].instanceCount, 3, 'Should have 3 instances');
});

test('computeNewDuplicates returns empty when no new duplicates', () => {
  const { computeNewDuplicates } = require('../lib/diff-engine');
  const same = [{ name: 'lodash', paths: ['a', 'b'], instanceCount: 2, totalSize: 90000, wastedSize: 40000 }];
  const result = computeNewDuplicates(same, same);
  assertEqual(result.length, 0, 'Should be empty when same duplicates');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node test/test-runner.js`
Expected: FAIL — `computeNewDuplicates` not exported

- [ ] **Step 3: Implement `computeNewDuplicates`**

Add in `lib/diff-engine.js` before `computePackageDiffs`:

```js
/**
 * Compare base and PR duplicate packages to find only PR-introduced duplicates.
 * A duplicate is "new" if:
 * - The package didn't appear in baseDuplicates at all, OR
 * - The package has MORE instances in PR than in base
 * @param {import('./stats-parser').DuplicatePackage[]} baseDuplicates
 * @param {import('./stats-parser').DuplicatePackage[]} prDuplicates
 * @returns {import('./stats-parser').DuplicatePackage[]}
 */
function computeNewDuplicates(baseDuplicates, prDuplicates) {
  const baseMap = new Map((baseDuplicates || []).map(d => [d.name, d]));
  const newDups = [];

  for (const prDup of (prDuplicates || [])) {
    const baseDup = baseMap.get(prDup.name);
    if (!baseDup) {
      // Entirely new duplicate
      newDups.push(prDup);
    } else if (prDup.instanceCount > baseDup.instanceCount) {
      // More instances in PR than base
      newDups.push(prDup);
    }
  }

  return newDups;
}
```

Update `BundleDiff` typedef to add:
```js
 * @property {import('./stats-parser').DuplicatePackage[]} newDuplicates - Duplicates introduced in PR
```

In `computeDiff`, after the entrypoint reasons computation (line 139) and before the return, add:
```js
  // Compute new duplicate dependencies (PR vs base)
  const newDuplicates = computeNewDuplicates(
    baseStats.duplicates || [],
    prStats.duplicates || [],
  );
```

Add `newDuplicates` to the return object.

Add `computeNewDuplicates` to module.exports.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node test/test-runner.js`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add lib/diff-engine.js test/test-runner.js
git commit -m "feat: add PR-introduced duplicate detection to diff engine"
```

---

### Task 5: Add `DUPLICATE_DEPENDENCY` rule to rule-engine.js

**Files:**
- Modify: `lib/rule-engine.js:82-110` (runDetection), `lib/rule-engine.js:337-373` (detectDuplicateDependencies)
- Test: `test/test-runner.js`

- [ ] **Step 1: Write failing test**

```js
test('detectDuplicateDependencies flags new duplicates from diff.newDuplicates', () => {
  const { runDetection } = require('../lib/rule-engine');
  const diff = {
    added: [], allChanges: [], topChanges: [], removed: [],
    totalDiff: 0, nodeModulesDiff: 0, baseSize: 100000, prSize: 100000,
    packageDiffs: {}, assetDiff: [], entrypointDiff: [],
    newDuplicates: [
      { name: 'lodash', paths: ['node_modules/lodash', 'node_modules/a/node_modules/lodash'], instanceCount: 2, totalSize: 90000, wastedSize: 40000 },
    ],
  };
  const result = runDetection(diff);
  const dupRule = result.violations.find(v => v.id === 'DUPLICATE_DEPENDENCY');
  assertTrue(dupRule !== undefined, 'Should have DUPLICATE_DEPENDENCY violation');
  assertEqual(dupRule.severity, 'warning', 'Should be warning for <50KB waste');
  assertTrue(dupRule.message.includes('lodash'), 'Message should mention lodash');
});

test('detectDuplicateDependencies is critical for large waste', () => {
  const { runDetection } = require('../lib/rule-engine');
  const diff = {
    added: [], allChanges: [], topChanges: [], removed: [],
    totalDiff: 0, nodeModulesDiff: 0, baseSize: 100000, prSize: 100000,
    packageDiffs: {}, assetDiff: [], entrypointDiff: [],
    newDuplicates: [
      { name: 'moment', paths: ['a', 'b'], instanceCount: 2, totalSize: 200000, wastedSize: 95000 },
    ],
  };
  const result = runDetection(diff);
  const dupRule = result.violations.find(v => v.id === 'DUPLICATE_DEPENDENCY');
  assertTrue(dupRule !== undefined, 'Should have DUPLICATE_DEPENDENCY violation');
  assertEqual(dupRule.severity, 'critical', 'Should be critical for >=50KB waste');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node test/test-runner.js`
Expected: FAIL — no `DUPLICATE_DEPENDENCY` rule fires

- [ ] **Step 3: Update `detectDuplicateDependencies` function**

Replace the existing `detectDuplicateDependencies` function (lines 337-373) to use `diff.newDuplicates`:

```js
/**
 * Detect duplicate dependencies introduced by the PR.
 * Uses pre-computed newDuplicates from diff-engine (compares base vs PR).
 * Falls back to legacy shallow detection if newDuplicates is not available.
 * @param {import('./diff-engine').BundleDiff} diff
 * @returns {RuleResult[]}
 */
function detectDuplicateDependencies(diff) {
  const results = [];

  // New: use pre-computed PR-introduced duplicates
  const newDuplicates = diff.newDuplicates || [];
  for (const dup of newDuplicates) {
    results.push({
      id: 'DUPLICATE_DEPENDENCY',
      severity: dup.wastedSize >= 50 * 1024 ? 'critical' : 'warning',
      category: 'Dependency Management',
      message: `PR introduces duplicate dependency: ${dup.name} (${dup.instanceCount} copies, ${formatBytes(dup.wastedSize)} wasted)`,
      details: {
        package: dup.name,
        paths: dup.paths,
        instanceCount: dup.instanceCount,
        totalSize: dup.totalSize,
        wastedSize: dup.wastedSize,
        suggestion: `"${dup.name}" appears at ${dup.instanceCount} different node_modules paths. Use npm dedupe or package.json resolutions to consolidate.`,
      },
    });
  }

  // Legacy: shallow detection for backward compatibility when newDuplicates is not available
  if (newDuplicates.length === 0) {
    const packageVersions = new Map();
    for (const change of [...(diff.added || []), ...(diff.allChanges || [])]) {
      if (!change.packageName) continue;
      const baseName = change.packageName.replace(/@[\d.]+$/, '').replace(/@[\d.]+-/, '@');
      if (!packageVersions.has(baseName)) packageVersions.set(baseName, []);
      packageVersions.get(baseName).push(change.packageName);
    }
    for (const [baseName, versions] of packageVersions) {
      const uniqueVersions = [...new Set(versions)];
      if (uniqueVersions.length > 1) {
        results.push({
          id: 'POTENTIAL_DUPLICATES',
          severity: 'info',
          category: 'Dependency Management',
          message: `Multiple versions of ${baseName} detected`,
          details: {
            package: baseName,
            versions: uniqueVersions,
            suggestion: 'Consider deduplicating with npm dedupe or yarn resolutions',
          },
        });
      }
    }
  }

  return results;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node test/test-runner.js`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add lib/rule-engine.js test/test-runner.js
git commit -m "feat: add DUPLICATE_DEPENDENCY rule with severity based on wasted size"
```

---

## Chunk 3: Renderer Updates (comment.js, diff.js, analyze.js)

### Task 6: Update PR comment (scripts/comment.js) with gzip column and duplicates section

**Files:**
- Modify: `scripts/comment.js:68-98` (asset table), `scripts/comment.js:104-129` (entrypoint table), add new duplicates section
- Test: `test/test-runner.js`

- [ ] **Step 1: Update asset table header and rows**

Change line 71:
```js
    lines.push('| Output File | Base | PR | Gzip | Change | Top Contributors |');
    lines.push('|-------------|------|-----|------|--------|-----------------|');
```

In the asset row loop (line 74-87), add gzip column:
```js
      const gzipStr = asset.prGzip > 0 ? formatBytes(asset.prGzip) : '-';
      lines.push(`| \`${truncate(asset.name, 40)}\` | ${baseSizeStr} | ${prSizeStr} | ${gzipStr} | ${changeStr} | ${reasonsStr} |`);
```

Update the total row (line 94) to include empty gzip cell:
```js
      lines.push(`| **Total** | **${formatBytes(baseAssetSize)}** | **${formatBytes(prAssetSize)}** | **${diff.prGzipSize ? formatBytes(diff.prGzipSize) : '-'}** | **${renderSizeChange(totalAssetDiff, formatBytes(totalAssetDiff, { signed: true }))}** | |`);
```

- [ ] **Step 2: Update entrypoint table header and rows**

Change line 108:
```js
    lines.push('| Entrypoint | Base | PR | Gzip | Change | Top Contributors |');
    lines.push('|------------|------|-----|------|--------|-----------------|');
```

In the entrypoint row loop (line 111-124), add gzip column:
```js
      const gzipStr = ep.prGzip > 0 ? formatBytes(ep.prGzip) : '-';
      lines.push(`| \`${ep.name}\` | ${baseSizeStr} | ${prSizeStr} | ${gzipStr} | ${changeStr} | ${reasonsStr} |`);
```

- [ ] **Step 3: Add duplicates section**

After the entrypoint section (after line 129), add:

```js
  // New Duplicate Dependencies section
  const newDuplicates = diff.newDuplicates || [];
  if (newDuplicates.length > 0) {
    lines.push('<details>');
    lines.push('<summary><b>⚠️ New Duplicate Dependencies</b></summary>');
    lines.push('');
    lines.push('| Package | Copies | Wasted | Paths |');
    lines.push('|---------|--------|--------|-------|');

    for (const dup of newDuplicates) {
      const pathsStr = dup.paths.map(p => `\`${p}\``).join(', ');
      lines.push(`| \`${dup.name}\` | ${dup.instanceCount} | ${formatBytes(dup.wastedSize)} | ${pathsStr} |`);
    }

    lines.push('');
    lines.push('</details>');
    lines.push('');
  }
```

- [ ] **Step 4: Write test for comment output**

NOTE: `generateComment(analysis, options={})` takes a SINGLE `analysis` object with properties: `diff`, `aiAnalysis`/`ai`, `issues`/`detections`, `summary`, `changes`. The `diff` property must contain the actual diff data (assetDiff, entrypointDiff, etc.).

```js
test('generateComment includes Gzip column in asset table', () => {
  const { generateComment } = require('../scripts/comment');
  const analysis = {
    diff: {
      baseSize: 500000, prSize: 520000, totalDiff: 20000,
      baseSizeFormatted: '488.28 KB', prSizeFormatted: '507.81 KB', totalDiffFormatted: '+19.53 KB',
      nodeModulesDiff: 15000,
      assetDiff: [
        { name: 'main.js', baseSize: 100000, prSize: 120000, change: 20000, type: 'changed',
          changeFormatted: '+19.53 KB', chunkNames: [], chunks: [],
          baseGzip: 30000, prGzip: 36000, gzipChange: 6000, reasons: [] },
      ],
      entrypointDiff: [],
      baseAssetSize: 100000, prAssetSize: 120000, totalAssetDiff: 20000,
      prGzipSize: 36000,
      newDuplicates: [],
    },
    summary: {},
    aiAnalysis: { verdict: 'expected', confidence: 0.9, explanation: 'Test', rootCause: 'Test', suggestedFixes: [] },
    issues: { violations: [], critical: [], warnings: [], info: [] },
  };
  const comment = generateComment(analysis);
  assertTrue(comment.includes('Gzip'), 'Should have Gzip column header');
});

test('generateComment includes duplicate dependencies section', () => {
  const { generateComment } = require('../scripts/comment');
  const analysis = {
    diff: {
      baseSize: 500000, prSize: 520000, totalDiff: 20000,
      baseSizeFormatted: '488.28 KB', prSizeFormatted: '507.81 KB', totalDiffFormatted: '+19.53 KB',
      nodeModulesDiff: 15000,
      assetDiff: [],
      entrypointDiff: [],
      prGzipSize: 36000,
      newDuplicates: [
        { name: 'lodash', paths: ['node_modules/lodash', 'node_modules/a/node_modules/lodash'], instanceCount: 2, totalSize: 90000, wastedSize: 40000 },
      ],
    },
    summary: {},
    aiAnalysis: { verdict: 'expected', confidence: 0.9, explanation: 'Test', rootCause: 'Test', suggestedFixes: [] },
    issues: { violations: [], critical: [], warnings: [], info: [] },
  };
  const comment = generateComment(analysis);
  assertTrue(comment.includes('New Duplicate Dependencies'), 'Should have duplicates section');
  assertTrue(comment.includes('lodash'), 'Should mention lodash');
});
```

- [ ] **Step 5: Run tests and verify**

Run: `node test/test-runner.js`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add scripts/comment.js test/test-runner.js
git commit -m "feat: add Gzip column and duplicate dependencies section to PR comment"
```

---

### Task 7: Update text report (scripts/diff.js) with gzip and duplicates

**Files:**
- Modify: `scripts/diff.js` (asset lines, entrypoint lines, add duplicate section)
- Test: `test/test-runner.js`

- [ ] **Step 1: Update asset lines to show gzip**

In the asset output section of `generateReport()`, after the size line, add gzip:

For changed assets, update the line format to include `[gzip: X]`:
```js
// Where the line is built, append gzip info:
if (asset.prGzip > 0) {
  line += ` [gzip: ${formatBytes(asset.prGzip)}]`;
}
```

- [ ] **Step 2: Update entrypoint lines similarly**

Same pattern as assets — append `[gzip: X]` to entrypoint lines where `prGzip > 0`.

- [ ] **Step 3: Add duplicate dependencies section**

After the entrypoint section, before closing:

```js
  // Duplicate Dependencies
  const newDuplicates = diff.newDuplicates || [];
  if (newDuplicates.length > 0) {
    lines.push('');
    lines.push('## Duplicate Dependencies (New in PR)');
    lines.push('');
    for (const dup of newDuplicates) {
      const severity = dup.wastedSize >= 50 * 1024 ? '‼' : '⚠';
      lines.push(`  ${severity} ${dup.name} — ${dup.instanceCount} copies, ${formatBytes(dup.wastedSize)} wasted`);
      lines.push(`    Paths: ${dup.paths.join(', ')}`);
    }
  }
```

- [ ] **Step 4: Write tests for gzip and duplicates in diff.js report**

```js
test('generateReport includes gzip sizes in asset lines', () => {
  const { generateReport } = require('../scripts/diff');
  const diff = {
    baseSize: 500000, prSize: 520000, totalDiff: 20000,
    baseSizeFormatted: '488.28 KB', prSizeFormatted: '507.81 KB', totalDiffFormatted: '+19.53 KB',
    nodeModulesDiff: 15000,
    assetDiff: [
      { name: 'main.js', baseSize: 100000, prSize: 120000, change: 20000, type: 'changed',
        changeFormatted: '+19.53 KB', chunkNames: [], chunks: [],
        baseGzip: 30000, prGzip: 36000, gzipChange: 6000, reasons: [] },
    ],
    entrypointDiff: [],
    baseAssetSize: 100000, prAssetSize: 120000, totalAssetDiff: 20000,
    prGzipSize: 36000,
    newDuplicates: [],
    topChanges: [], added: [], removed: [], allChanges: [],
    packageDiffs: {},
  };
  const summary = { isSignificant: false };
  const report = generateReport(diff, summary);
  assertTrue(report.includes('[gzip:'), 'Should have gzip annotation in asset lines');
});

test('generateReport includes duplicate dependencies section', () => {
  const { generateReport } = require('../scripts/diff');
  const diff = {
    baseSize: 500000, prSize: 520000, totalDiff: 20000,
    baseSizeFormatted: '488.28 KB', prSizeFormatted: '507.81 KB', totalDiffFormatted: '+19.53 KB',
    nodeModulesDiff: 15000,
    assetDiff: [],
    entrypointDiff: [],
    newDuplicates: [
      { name: 'lodash', paths: ['node_modules/lodash', 'node_modules/a/node_modules/lodash'], instanceCount: 2, totalSize: 90000, wastedSize: 40000 },
    ],
    topChanges: [], added: [], removed: [], allChanges: [],
    packageDiffs: {},
  };
  const summary = { isSignificant: false };
  const report = generateReport(diff, summary);
  assertTrue(report.includes('Duplicate Dependencies'), 'Should have duplicates section');
  assertTrue(report.includes('lodash'), 'Should mention lodash');
});
```

- [ ] **Step 5: Run tests and verify**

Run: `node test/test-runner.js`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add scripts/diff.js test/test-runner.js
git commit -m "feat: add gzip sizes and duplicate section to text report"
```

---

### Task 8: Update JSON output and analysis report (scripts/analyze.js)

**Files:**
- Modify: `scripts/analyze.js` (generateJSONOutput, generateAnalysisReport)
- Test: `test/test-runner.js`

- [ ] **Step 1: Update `generateJSONOutput` (scripts/analyze.js line 298-383)**

In `generateJSONOutput`, add to the return object at the top level (after `entrypoints`):

```js
    compressed: {
      baseGzipTotal: diff.baseGzipSize || 0,
      prGzipTotal: diff.prGzipSize || 0,
      gzipDiff: diff.totalGzipDiff || 0,
    },
    duplicates: {
      new: (diff.newDuplicates || []).map(d => ({
        name: d.name,
        copies: d.instanceCount,
        wastedSize: d.wastedSize,
        paths: d.paths,
      })),
    },
```

In the `assets.changes` map (line 351-363), add `gzipSize: a.prGzip || 0` to each asset change object.

In the `entrypoints.changes` map (line 366-380), add `gzipSize: e.prGzip || 0` to each entrypoint change object.

- [ ] **Step 2: Update `generateAnalysisReport` (scripts/analyze.js line 87-291)**

In the asset output section (lines 208-228), after the `Contributors:` line for each asset, add gzip info:
```js
      if (asset.prGzip > 0) {
        lines.push(`    Gzip: ~${formatBytes(asset.prGzip)}`);
      }
```

After the entrypoint section (after line 267), add a duplicate dependencies section:
```js
  // Duplicate Dependencies
  const newDuplicates = diff.newDuplicates || [];
  if (newDuplicates.length > 0) {
    lines.push('⚠️ NEW DUPLICATE DEPENDENCIES');
    lines.push('─'.repeat(60));

    for (const dup of newDuplicates) {
      const severity = dup.wastedSize >= 50 * 1024 ? '‼' : '⚠';
      lines.push(`  ${severity} ${dup.name} — ${dup.instanceCount} copies, ${formatBytes(dup.wastedSize)} wasted`);
      lines.push(`    Paths: ${dup.paths.join(', ')}`);
    }
    lines.push('');
  }
```

- [ ] **Step 3: Write tests for analyze.js changes**

```js
test('generateJSONOutput includes compressed and duplicates fields', () => {
  const { generateJSONOutput } = require('../scripts/analyze');
  const analysis = {
    diff: {
      baseSize: 500000, prSize: 520000, totalDiff: 20000,
      totalDiffFormatted: '+19.53 KB', nodeModulesDiff: 15000,
      baseGzipSize: 150000, prGzipSize: 156000, totalGzipDiff: 6000,
      topChanges: [], packageDiffs: {},
      assetDiff: [
        { name: 'main.js', type: 'changed', baseSize: 100000, prSize: 120000, change: 20000,
          prGzip: 36000, reasons: [] },
      ],
      entrypointDiff: [
        { name: 'app', type: 'changed', baseSize: 100000, prSize: 120000, change: 20000,
          prGzip: 36000, baseAssets: [], prAssets: [], reasons: [] },
      ],
      baseAssetSize: 100000, prAssetSize: 120000, totalAssetDiff: 20000,
      baseAssetSizeFormatted: '97.66 KB', prAssetSizeFormatted: '117.19 KB',
      newDuplicates: [
        { name: 'lodash', paths: ['a', 'b'], instanceCount: 2, totalSize: 90000, wastedSize: 40000 },
      ],
    },
    detections: { violations: [], critical: [], warnings: [], info: [] },
    ai: { verdict: 'expected', confidence: 0.9, explanation: 'Test', rootCause: 'Test', suggestedFixes: [] },
  };
  const json = generateJSONOutput(analysis);
  assertTrue(json.compressed !== undefined, 'Should have compressed field');
  assertEqual(json.compressed.prGzipTotal, 156000, 'Should have PR gzip total');
  assertTrue(json.duplicates !== undefined, 'Should have duplicates field');
  assertEqual(json.duplicates.new.length, 1, 'Should have 1 new duplicate');
  assertEqual(json.duplicates.new[0].name, 'lodash', 'Duplicate should be lodash');
  assertEqual(json.assets.changes[0].gzipSize, 36000, 'Asset should have gzipSize');
  assertEqual(json.entrypoints.changes[0].gzipSize, 36000, 'Entrypoint should have gzipSize');
});
```

- [ ] **Step 4: Run tests and verify**

Run: `node test/test-runner.js`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/analyze.js test/test-runner.js
git commit -m "feat: add compressed sizes and duplicates to JSON output and analysis report"
```

---

## Chunk 4: AI Prompt Enhancement

### Task 9: Update AI prompt with compressed sizes and duplicate context

**Files:**
- Modify: `lib/ai-client.js:181-310` (buildAnalysisPrompt), `lib/ai-client.js:108-172` (SYSTEM_PROMPT)

- [ ] **Step 1: Add compressed sizes section to prompt**

In `buildAnalysisPrompt`, after the "Output File Changes" section (after line 267), add:

```js
  // Add compressed size context (gzip from diff, brotli estimated for AI context only)
  if (significantAssets.length > 0) {
    promptParts.push('', '## Compressed Sizes (Estimated)');
    promptParts.push('Gzip and Brotli estimates for output files:');
    const { estimateCompressedSize } = require('./stats-parser');
    for (const asset of significantAssets.slice(0, 15)) {
      if (asset.prSize > 0) {
        const gzip = asset.prGzip || estimateCompressedSize(asset.prSize, asset.name).gzip;
        const brotli = estimateCompressedSize(asset.prSize, asset.name).brotli;
        promptParts.push(`- ${asset.name}: raw ${formatBytes(asset.prSize)} → gzip ~${formatBytes(gzip)}, brotli ~${formatBytes(brotli)}`);
      }
    }
    if (diff.baseGzipSize || diff.prGzipSize) {
      promptParts.push(`- Total gzip: ~${formatBytes(diff.baseGzipSize || 0)} → ~${formatBytes(diff.prGzipSize || 0)}, change: ${diff.totalGzipDiff > 0 ? '+' : ''}${formatBytes(diff.totalGzipDiff || 0)}`);
    }
  }
```

- [ ] **Step 2: Add duplicate dependencies section to prompt**

After the compressed sizes section, add:

```js
  // Add duplicate dependency context
  const newDuplicates = diff.newDuplicates || [];
  if (newDuplicates.length > 0) {
    promptParts.push('', '## New Duplicate Dependencies');
    promptParts.push('PR introduces these duplicate packages (not present in base build):');
    for (const dup of newDuplicates) {
      promptParts.push(`- ${dup.name}: ${dup.instanceCount} copies at different node_modules paths, ${formatBytes(dup.wastedSize)} wasted`);
      promptParts.push(`  Paths: ${dup.paths.join(', ')}`);
    }
  }
```

- [ ] **Step 3: Update SYSTEM_PROMPT**

Add to the system prompt instructions (in the existing instruction block):
```
- Consider compressed sizes (gzip/brotli) when assessing real-world user impact. Raw sizes overstate the cost of text-based assets like JS and CSS.
- Flag duplicate dependencies as a common source of bundle bloat. If the PR introduces new duplicates, suggest npm dedupe or package.json resolutions.
```

- [ ] **Step 4: Update existing AI prompt test**

Verify the existing `parseAIResponse validates responses` test still passes (this test doesn't check prompt building, but ensure no regressions).

- [ ] **Step 5: Run tests and verify**

Run: `node test/test-runner.js`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add lib/ai-client.js
git commit -m "feat: enrich AI prompt with compressed sizes and duplicate dependency context"
```

---

## Chunk 5: Final Verification

### Task 10: End-to-end verification and sample data update

**Files:**
- Modify: `test/sample-pr-stats.json` (add a duplicate package for testing)
- Test: `test/test-runner.js`

- [ ] **Step 1: Add duplicate package to sample PR stats**

In `test/sample-pr-stats.json`, add a module that creates a duplicate:
```json
{
  "name": "./node_modules/lib-a/node_modules/react/index.js",
  "size": 4500,
  "chunks": [0],
  "reasons": [{ "moduleName": "./node_modules/lib-a/index.js" }],
  "usedExports": ["createElement"]
}
```

This creates a duplicate of `react` at a nested `node_modules` path.

- [ ] **Step 2: Write end-to-end integration test**

```js
test('full pipeline: compressed sizes and duplicates flow through computeDiff', () => {
  const baseStats = parseStats(JSON.parse(fs.readFileSync(path.join(__dirname, 'sample-base-stats.json'), 'utf-8')));
  const prStats = parseStats(JSON.parse(fs.readFileSync(path.join(__dirname, 'sample-pr-stats.json'), 'utf-8')));

  // Verify compressed sizes on parsed assets
  assertTrue(prStats.assets[0].compressed.gzip > 0, 'PR assets should have gzip sizes');
  assertTrue(prStats.totalGzipSize > 0, 'PR should have total gzip size');

  // Verify duplicates detected
  assertTrue(prStats.duplicates.length > 0, 'PR should have duplicates');
  const reactDup = prStats.duplicates.find(d => d.name === 'react');
  assertTrue(reactDup !== undefined, 'react should be a duplicate in PR');

  // Compute diff
  const diff = computeDiff(baseStats, prStats);

  // Verify gzip fields flow through
  assertTrue(diff.prGzipSize > 0, 'Diff should have PR gzip size');
  assertTrue(diff.baseGzipSize > 0, 'Diff should have base gzip size');
  const mainAsset = diff.assetDiff.find(a => a.name === 'main.bundle.js');
  assertTrue(mainAsset.prGzip > 0, 'Asset diff should have prGzip');

  // Verify new duplicates
  assertTrue(Array.isArray(diff.newDuplicates), 'Should have newDuplicates array');
  const newReact = diff.newDuplicates.find(d => d.name === 'react');
  assertTrue(newReact !== undefined, 'react duplicate should be new (not in base)');
});
```

- [ ] **Step 3: Run full test suite**

Run: `node test/test-runner.js`
Expected: ALL PASS

- [ ] **Step 4: Verify text report output**

Run: `node scripts/diff.js test/sample-base-stats.json test/sample-pr-stats.json`
Expected: Output shows `[gzip: ...]` on assets and a "Duplicate Dependencies" section.

- [ ] **Step 5: Commit**

```bash
git add test/sample-pr-stats.json test/test-runner.js
git commit -m "test: add end-to-end tests for compressed sizes and duplicate detection"
```

- [ ] **Step 6: Final test run and summary**

Run: `node test/test-runner.js`
Expected: ALL PASS, 0 failures. Print the test count.
