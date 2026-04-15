/**
 * @fileoverview Bundle Diff Engine
 * Computes differences between base and PR bundle stats
 */

const { isNodeModule, extractPackageName } = require('./stats-parser');
const { formatBytes, getRootCause } = require('./utils');

/**
 * Normalize a module grouping key to prevent duplicates from webpack name variants.
 * For node_modules packages, the key is already the package name (e.g. "lodash").
 * For source files, strip any residual loader prefixes, query strings, and
 * concatenated module suffixes that cleanModuleName may not have caught.
 * @param {string} key - The raw grouping key (packageName or module name)
 * @returns {string}
 */
function normalizeGroupingKey(key) {
  return key
    .replace(/^.*!/, '')           // strip loader prefixes
    .replace(/\?[^/]*$/, '')       // strip query strings
    .replace(/\s+\+\s+\d+\s+modules?$/, '') // strip " + N modules"
    .replace(/^\.+\//, '')         // strip leading ./
    .trim();
}

/**
 * @typedef {Object} AssetContributor
 * @property {string} name - Module or package name
 * @property {number} change - Size change in bytes
 * @property {string} changeFormatted - Human readable change
 * @property {string} type - 'added' | 'removed' | 'changed'
 */

/**
 * @typedef {Object} AssetChange
 * @property {string} name - Output file name
 * @property {number} baseSize - Size in base branch (0 if new)
 * @property {number} prSize - Size in PR branch (0 if removed)
 * @property {number} change - Size difference in bytes
 * @property {string} changeFormatted - Human readable change
 * @property {string} type - 'added' | 'removed' | 'changed' | 'unchanged'
 * @property {number} baseGzip - Gzip size in base (0 if new)
 * @property {number} prGzip - Gzip size in PR (0 if removed)
 * @property {number} gzipChange - Gzip size difference
 * @property {string[]} chunkNames - Chunk names this asset belongs to
 * @property {number[]} chunks - Chunk IDs (union of base + PR) for module attribution
 * @property {AssetContributor[]} reasons - Top module/package contributors to size change
 * @property {Object} [reasonsMeta] - Metadata about all contributors (not just top N)
 * @property {number} [reasonsMeta.totalCount] - Total number of contributing modules/packages
 * @property {number} [reasonsMeta.netChange] - Net change across all contributors
 */

/**
 * @typedef {Object} EntrypointChange
 * @property {string} name - Entrypoint name
 * @property {number} baseSize - Total pre-minify module size in base branch (0 if new)
 * @property {number} prSize - Total pre-minify module size in PR branch (0 if removed)
 * @property {number} change - Size difference in bytes
 * @property {string} changeFormatted - Human readable change
 * @property {string} type - 'added' | 'removed' | 'changed' | 'unchanged'
 * @property {number} baseGzip - Gzip size in base (0 if new)
 * @property {number} prGzip - Gzip size in PR (0 if removed)
 * @property {number} gzipChange - Gzip size difference
 * @property {AssetContributor[]} reasons - Top module/package contributors to size change
 * @property {Object} [reasonsMeta] - Metadata about all contributors (not just top N)
 * @property {number} [reasonsMeta.totalCount] - Total number of contributing modules/packages
 * @property {number} [reasonsMeta.netChange] - Net change across all contributors
 */

/**
 * @typedef {Object} ModuleChange
 * @property {string} name - Module name
 * @property {number} oldSize - Previous size in bytes
 * @property {number} newSize - New size in bytes
 * @property {number} change - Size difference
 * @property {string} changeFormatted - Human readable change
 * @property {string[]} importChain - Chain of imports leading to this module
 * @property {string} type - 'added' | 'removed' | 'changed'
 * @property {boolean} isNodeModule - Whether from node_modules
 * @property {string|null} packageName - Package name if from node_modules
 * @property {number[]} chunks - Chunk IDs this module belongs to
 * @property {string[]} chunkNames - Stable chunk names this module belongs to (for cross-build matching)
 */

/**
 * @typedef {Object} BundleDiff
 * @property {number} totalDiff - Total size change in bytes
 * @property {string} totalDiffFormatted - Human readable total change
 * @property {number} nodeModulesDiff - node_modules size change
 * @property {ModuleChange[]} allChanges - All module changes
 * @property {ModuleChange[]} topChanges - Top contributors to size change
 * @property {ModuleChange[]} added - New modules
 * @property {ModuleChange[]} removed - Removed modules
 * @property {Object.<string, number>} packageDiffs - Changes by package
 * @property {AssetChange[]} assetDiff - Asset-level changes (output files, pre-minify sizes)
 * @property {EntrypointChange[]} entrypointDiff - Entrypoint-level changes
 * @property {number} totalAssetDiff - Total pre-minify asset size change
 * @property {number} baseAssetSize - Total pre-minify asset size in base
 * @property {number} prAssetSize - Total pre-minify asset size in PR
 * @property {import('./stats-parser').DuplicatePackage[]} newDuplicates - Duplicates introduced in PR
 */

/**
 * Compute bundle diff between base and PR stats
 * @param {import('./stats-parser').BundleStats} baseStats - Base branch stats
 * @param {import('./stats-parser').BundleStats} prStats - PR branch stats
 * @returns {BundleDiff}
 */
function computeDiff(baseStats, prStats) {
  // Build lookup maps for fast comparison
  const baseModules = new Map(baseStats.modules.map(m => [m.name, m]));
  const prModules = new Map(prStats.modules.map(m => [m.name, m]));

  const allChanges = [];
  const added = [];
  const removed = [];

  // Find added and changed modules
  for (const [name, prModule] of prModules) {
    const baseModule = baseModules.get(name);

    if (!baseModule) {
      // Module was added
      const change = createModuleChange(prModule, null, 'added');
      added.push(change);
      allChanges.push(change);
    } else if (baseModule.size !== prModule.size) {
      // Module changed size
      const change = createModuleChange(prModule, baseModule, 'changed');
      allChanges.push(change);
    }
  }

  // Find removed modules
  for (const [name, baseModule] of baseModules) {
    if (!prModules.has(name)) {
      const change = createModuleChange(null, baseModule, 'removed');
      removed.push(change);
      allChanges.push(change);
    }
  }

  // Sort by absolute change magnitude
  const sortedChanges = [...allChanges].sort(
    (a, b) => Math.abs(b.change) - Math.abs(a.change)
  );

  // Get top contributors (top 20 or all significant changes)
  const topChanges = sortedChanges
    .filter(c => Math.abs(c.change) > 100) // Ignore changes < 100 bytes
    .slice(0, 20);

  // Compute asset-level and entrypoint-level diffs using pre-minify module sizes
  const assetDiff = computeAssetDiff(baseStats.assets || [], prStats.assets || []);
  const entrypointDiff = computeEntrypointDiff(baseStats.entrypoints || [], prStats.entrypoints || []);

  // Compute module-level reasons for each asset's size change
  computeAssetReasons(
    assetDiff,
    allChanges,
    baseStats.chunkIdToAssets || {},
    prStats.chunkIdToAssets || {},
    3,
    baseStats.chunkNameToAssets || {},
    prStats.chunkNameToAssets || {},
  );

  // Compute module-level reasons for each entrypoint's size change
  computeEntrypointReasons(
    entrypointDiff,
    allChanges,
    baseStats.entrypoints || [],
    prStats.entrypoints || [],
  );

  // Now that reasons are computed, replace asset/entrypoint sizes with pre-minify
  // module-level sizes so that Change = sum of Top Contributors.
  applyPreMinifySizes(
    assetDiff,
    baseStats.modules || [],
    prStats.modules || [],
    baseStats.chunkIdToAssets || {},
    prStats.chunkIdToAssets || {},
    baseStats.chunkNameToAssets || {},
    prStats.chunkNameToAssets || {},
  );
  applyPreMinifySizesEntrypoints(
    entrypointDiff,
    baseStats.modules || [],
    prStats.modules || [],
    baseStats.entrypoints || [],
    prStats.entrypoints || [],
  );

  // Compute totals from pre-minify asset sizes
  const totalAssetDiff = assetDiff
    .filter(a => a.type !== 'unchanged')
    .reduce((sum, a) => sum + a.change, 0);
  const baseAssetSize = assetDiff.reduce((sum, a) => sum + a.baseSize, 0);
  const prAssetSize = assetDiff.reduce((sum, a) => sum + a.prSize, 0);

  // Compute new duplicate dependencies (PR vs base)
  const newDuplicates = computeNewDuplicates(
    baseStats.duplicates || [],
    prStats.duplicates || [],
  );

  return {
    totalDiff: prStats.totalSize - baseStats.totalSize,
    totalDiffFormatted: formatSignedBytes(prStats.totalSize - baseStats.totalSize),
    nodeModulesDiff: prStats.nodeModulesSize - baseStats.nodeModulesSize,
    allChanges: sortedChanges,
    topChanges,
    added,
    removed,
    packageDiffs: computePackageDiffs(allChanges),
    baseSize: baseStats.totalSize,
    prSize: prStats.totalSize,
    baseSizeFormatted: formatBytes(baseStats.totalSize),
    prSizeFormatted: formatBytes(prStats.totalSize),
    assetDiff,
    entrypointDiff,
    totalAssetDiff,
    baseAssetSize,
    prAssetSize,
    baseAssetSizeFormatted: formatBytes(baseAssetSize),
    prAssetSizeFormatted: formatBytes(prAssetSize),
    newDuplicates,
  };
}

/**
 * Create a module change record
 * @param {import('./stats-parser').ParsedModule|null} newModule
 * @param {import('./stats-parser').ParsedModule|null} oldModule
 * @param {string} type - 'added' | 'removed' | 'changed'
 * @returns {ModuleChange}
 */
function createModuleChange(newModule, oldModule, type) {
  const name = newModule?.name || oldModule?.name || 'unknown';
  const newSize = newModule?.size || 0;
  const oldSize = oldModule?.size || 0;
  const change = newSize - oldSize;

  return {
    name,
    oldSize,
    newSize,
    change,
    changeFormatted: formatSignedBytes(change),
    importChain: buildImportChain(newModule || oldModule),
    type,
    isNodeModule: isNodeModule(name),
    packageName: extractPackageName(name),
    chunks: (newModule?.chunks || oldModule?.chunks || []),
    chunkNames: (newModule?.chunkNames || oldModule?.chunkNames || []),
  };
}

/**
 * Build import chain for a module.
 * Deduplicates repeated entries — webpack often lists the same parent module
 * multiple times in reasons (e.g. a concatenated module appearing 3x), which
 * produces chains like "index.js + 113 modules ← index.js + 113 modules ← …".
 * @param {import('./stats-parser').ParsedModule} module
 * @returns {string[]}
 */
function buildImportChain(module) {
  if (!module) return [];

  const chain = [];
  const seen = new Set();

  // Start with direct importers (deduplicated)
  if (module.reasons && module.reasons.length > 0) {
    for (const reason of module.reasons) {
      if (!seen.has(reason)) {
        seen.add(reason);
        chain.push(reason);
        if (chain.length >= 3) break; // Limit to first 3 unique importers
      }
    }
  }

  // Add the module itself
  if (!seen.has(module.name)) {
    chain.push(module.name);
  }

  return chain;
}

// Ignore asset/entrypoint changes smaller than this (webpack noise: hash diffs, module IDs)
const NOISE_THRESHOLD_BYTES = 10;

/**
 * Compute diff between base and PR assets (output files).
 * Compares assets by filename, categorizing as added/removed/changed/unchanged.
 * @param {import('./stats-parser').ParsedAsset[]} baseAssets
 * @param {import('./stats-parser').ParsedAsset[]} prAssets
 * @returns {AssetChange[]}
 */
function computeAssetDiff(baseAssets, prAssets) {
  const baseMap = new Map(baseAssets.map(a => [a.name, a]));
  const prMap = new Map(prAssets.map(a => [a.name, a]));
  const changes = [];

  // Find changed, unchanged, and added assets
  for (const [name, prAsset] of prMap) {
    const baseAsset = baseMap.get(name);
    if (!baseAsset) {
      changes.push({
        name,
        baseSize: 0,
        prSize: prAsset.size,
        change: prAsset.size,
        changeFormatted: formatSignedBytes(prAsset.size),
        type: 'added',
        baseGzip: 0,
        prGzip: prAsset.compressed?.gzip || 0,
        gzipChange: prAsset.compressed?.gzip || 0,
        chunkNames: prAsset.chunkNames || [],
        chunks: [...(prAsset.chunks || [])],
      });
    } else {
      const diff = prAsset.size - baseAsset.size;
      const baseGzip = baseAsset.compressed?.gzip || 0;
      const prGzip = prAsset.compressed?.gzip || 0;
      // Treat tiny changes as noise (webpack hash/ID churn)
      const isNoise = Math.abs(diff) > 0 && Math.abs(diff) <= NOISE_THRESHOLD_BYTES;
      if (diff !== 0 && !isNoise) {
        changes.push({
          name,
          baseSize: baseAsset.size,
          prSize: prAsset.size,
          change: diff,
          changeFormatted: formatSignedBytes(diff),
          type: 'changed',
          baseGzip,
          prGzip,
          gzipChange: prGzip - baseGzip,
          chunkNames: prAsset.chunkNames || [],
          chunks: [...new Set([...(baseAsset.chunks || []), ...(prAsset.chunks || [])])],
        });
      } else {
        const gzip = prAsset.compressed?.gzip || 0;
        changes.push({
          name,
          baseSize: baseAsset.size,
          prSize: prAsset.size,
          change: 0,
          changeFormatted: formatSignedBytes(0),
          type: 'unchanged',
          baseGzip: gzip,
          prGzip: gzip,
          gzipChange: 0,
          chunkNames: prAsset.chunkNames || [],
          chunks: [...new Set([...(baseAsset.chunks || []), ...(prAsset.chunks || [])])],
        });
      }
    }
  }

  // Find removed assets
  for (const [name, baseAsset] of baseMap) {
    if (!prMap.has(name)) {
      changes.push({
        name,
        baseSize: baseAsset.size,
        prSize: 0,
        change: -baseAsset.size,
        changeFormatted: formatSignedBytes(-baseAsset.size),
        type: 'removed',
        baseGzip: baseAsset.compressed?.gzip || 0,
        prGzip: 0,
        gzipChange: -(baseAsset.compressed?.gzip || 0),
        chunkNames: baseAsset.chunkNames || [],
        chunks: [...(baseAsset.chunks || [])],
      });
    }
  }

  // Sort: added first, then by absolute change descending, unchanged last
  return changes.sort((a, b) => {
    if (a.type === 'unchanged' && b.type !== 'unchanged') return 1;
    if (a.type !== 'unchanged' && b.type === 'unchanged') return -1;
    if (a.type === 'added' && b.type !== 'added') return -1;
    if (a.type !== 'added' && b.type === 'added') return 1;
    if (a.type === 'removed' && b.type !== 'removed') return -1;
    if (a.type !== 'removed' && b.type === 'removed') return 1;
    return Math.abs(b.change) - Math.abs(a.change);
  });
}

/**
 * Compute diff between base and PR entrypoints.
 * @param {import('./stats-parser').ParsedEntrypoint[]} baseEntrypoints
 * @param {import('./stats-parser').ParsedEntrypoint[]} prEntrypoints
 * @returns {EntrypointChange[]}
 */
function computeEntrypointDiff(baseEntrypoints, prEntrypoints) {
  const baseMap = new Map(baseEntrypoints.map(e => [e.name, e]));
  const prMap = new Map(prEntrypoints.map(e => [e.name, e]));
  const changes = [];

  // Find changed, unchanged, and added entrypoints
  for (const [name, prEp] of prMap) {
    const baseEp = baseMap.get(name);
    if (!baseEp) {
      changes.push({
        name,
        baseSize: 0,
        prSize: prEp.assetsSize,
        change: prEp.assetsSize,
        changeFormatted: formatSignedBytes(prEp.assetsSize),
        type: 'added',
        baseGzip: 0,
        prGzip: prEp.compressed?.gzip || 0,
        gzipChange: prEp.compressed?.gzip || 0,
      });
    } else {
      const diff = prEp.assetsSize - baseEp.assetsSize;
      const baseGzip = baseEp.compressed?.gzip || 0;
      const prGzip = prEp.compressed?.gzip || 0;
      // Treat tiny changes as noise (webpack hash/ID churn)
      const isNoise = Math.abs(diff) > 0 && Math.abs(diff) <= NOISE_THRESHOLD_BYTES;
      if (diff !== 0 && !isNoise) {
        changes.push({
          name,
          baseSize: baseEp.assetsSize,
          prSize: prEp.assetsSize,
          change: diff,
          changeFormatted: formatSignedBytes(diff),
          type: 'changed',
          baseGzip,
          prGzip,
          gzipChange: prGzip - baseGzip,
        });
      } else {
        const gzip = prEp.compressed?.gzip || 0;
        changes.push({
          name,
          baseSize: baseEp.assetsSize,
          prSize: prEp.assetsSize,
          change: 0,
          changeFormatted: formatSignedBytes(0),
          type: 'unchanged',
          baseGzip: gzip,
          prGzip: gzip,
          gzipChange: 0,
        });
      }
    }
  }

  // Find removed entrypoints
  for (const [name, baseEp] of baseMap) {
    if (!prMap.has(name)) {
      changes.push({
        name,
        baseSize: baseEp.assetsSize,
        prSize: 0,
        change: -baseEp.assetsSize,
        changeFormatted: formatSignedBytes(-baseEp.assetsSize),
        type: 'removed',
        baseGzip: baseEp.compressed?.gzip || 0,
        prGzip: 0,
        gzipChange: -(baseEp.compressed?.gzip || 0),
      });
    }
  }

  // Sort: added first, then by absolute change descending
  return changes.sort((a, b) => {
    if (a.type === 'added' && b.type !== 'added') return -1;
    if (a.type !== 'added' && b.type === 'added') return 1;
    if (a.type === 'removed' && b.type !== 'removed') return -1;
    if (a.type !== 'removed' && b.type === 'removed') return 1;
    return Math.abs(b.change) - Math.abs(a.change);
  });
}

/**
 * Select top N contributors from grouped changes, ensuring both positive and
 * negative directions are represented when they exist. This prevents the
 * misleading case where an asset grew +1 KB but all top contributors are
 * negative (because the largest absolute changes happen to be removals).
 *
 * @param {Map<string, number>} grouped - Map of name → total change
 * @param {number} topN - Number of contributors to return
 * @returns {Array<[string, number]>} Selected [name, change] pairs
 */
function selectBalancedTopContributors(grouped, topN) {
  const allEntries = [...grouped.entries()].filter(([, v]) => v !== 0);
  if (allEntries.length <= topN) return allEntries.sort(([, a], [, b]) => Math.abs(b) - Math.abs(a));

  const positives = allEntries.filter(([, v]) => v > 0).sort(([, a], [, b]) => Math.abs(b) - Math.abs(a));
  const negatives = allEntries.filter(([, v]) => v < 0).sort(([, a], [, b]) => Math.abs(b) - Math.abs(a));

  // If only one direction exists, just take top N by absolute value
  if (positives.length === 0 || negatives.length === 0) {
    return allEntries.sort(([, a], [, b]) => Math.abs(b) - Math.abs(a)).slice(0, topN);
  }

  // Both directions exist: guarantee at least one from each side
  const result = [positives[0], negatives[0]];
  const used = new Set([positives[0][0], negatives[0][0]]);

  // Fill remaining slots from all entries by absolute magnitude
  const remaining = allEntries
    .filter(([name]) => !used.has(name))
    .sort(([, a], [, b]) => Math.abs(b) - Math.abs(a));

  for (const entry of remaining) {
    if (result.length >= topN) break;
    result.push(entry);
  }

  // Sort final result by absolute magnitude for consistent display
  return result.sort(([, a], [, b]) => Math.abs(b) - Math.abs(a));
}

/**
 * Compute module-level reasons (contributors) for each asset's size change.
 * Maps module changes to assets using chunk names (stable across builds) as the
 * primary matching strategy, with fallback to chunk IDs for backward compatibility.
 *
 * Chunk names (e.g. "main", "vendor") are semantically stable across webpack builds,
 * whereas numeric chunk IDs can shift when modules are added/removed. Using names
 * prevents modules from being attributed to the wrong assets.
 *
 * @param {AssetChange[]} assetDiff - Asset-level changes
 * @param {ModuleChange[]} moduleChanges - All module changes
 * @param {Object.<number, string[]>} baseChunkToAssets - Base branch chunk ID→asset map
 * @param {Object.<number, string[]>} prChunkToAssets - PR branch chunk ID→asset map
 * @param {number} [topN=3] - Number of top contributors to return per asset
 * @param {Object.<string, string[]>} [baseChunkNameToAssets={}] - Base branch chunk name→asset map
 * @param {Object.<string, string[]>} [prChunkNameToAssets={}] - PR branch chunk name→asset map
 */
function computeAssetReasons(assetDiff, moduleChanges, baseChunkToAssets, prChunkToAssets, topN = 3, baseChunkNameToAssets = {}, prChunkNameToAssets = {}) {
  // Strategy 1 (preferred): Build reverse map using chunk NAMES (stable across builds)
  // asset name → set of chunk names
  const assetToChunkNames = new Map();
  for (const [chunkName, assetNames] of Object.entries(baseChunkNameToAssets)) {
    for (const assetName of assetNames) {
      if (!assetToChunkNames.has(assetName)) assetToChunkNames.set(assetName, new Set());
      assetToChunkNames.get(assetName).add(chunkName);
    }
  }
  for (const [chunkName, assetNames] of Object.entries(prChunkNameToAssets)) {
    for (const assetName of assetNames) {
      if (!assetToChunkNames.has(assetName)) assetToChunkNames.set(assetName, new Set());
      assetToChunkNames.get(assetName).add(chunkName);
    }
  }

  // Strategy 2 (fallback): Build reverse map using chunk IDs (legacy, may be unstable)
  // asset name → set of chunk IDs
  const assetToChunkIds = new Map();
  for (const [chunkId, assetNames] of Object.entries(baseChunkToAssets)) {
    for (const assetName of assetNames) {
      if (!assetToChunkIds.has(assetName)) assetToChunkIds.set(assetName, new Set());
      assetToChunkIds.get(assetName).add(Number(chunkId));
    }
  }
  for (const [chunkId, assetNames] of Object.entries(prChunkToAssets)) {
    for (const assetName of assetNames) {
      if (!assetToChunkIds.has(assetName)) assetToChunkIds.set(assetName, new Set());
      assetToChunkIds.get(assetName).add(Number(chunkId));
    }
  }

  // Check if chunk-name data is available (modules have chunkNames populated)
  const hasChunkNames = moduleChanges.some(mc => mc.chunkNames && mc.chunkNames.length > 0);

  for (const asset of assetDiff) {
    // Skip new/removed — no module-level attribution needed
    if (asset.type === 'added' || asset.type === 'removed' || asset.type === 'unchanged') {
      asset.reasons = [];
      continue;
    }

    let relevant;

    if (hasChunkNames) {
      // Preferred: match by chunk names (stable across builds)
      const chunkNames = assetToChunkNames.get(asset.name);
      if (chunkNames && chunkNames.size > 0) {
        relevant = moduleChanges.filter(mc =>
          mc.chunkNames && mc.chunkNames.some(cn => chunkNames.has(cn))
        );
      }
    }

    if (!relevant) {
      // Fallback: match by chunk IDs (legacy path)
      let chunkIds = assetToChunkIds.get(asset.name);
      // Extra fallback: use asset-level chunk IDs from the asset diff itself
      if ((!chunkIds || chunkIds.size === 0) && asset.chunks && asset.chunks.length > 0) {
        chunkIds = new Set(asset.chunks);
      }
      if (!chunkIds || chunkIds.size === 0) {
        asset.reasons = [];
        continue;
      }
      relevant = moduleChanges.filter(mc =>
        mc.chunks.some(cid => chunkIds.has(cid))
      );
    }

    // Group by package name (for node_modules) or use module name for source files
    const grouped = new Map();
    for (const mc of relevant) {
      const key = normalizeGroupingKey(mc.packageName || mc.name);
      if (!grouped.has(key)) grouped.set(key, 0);
      grouped.set(key, grouped.get(key) + mc.change);
    }

    // Select top N with balanced positive/negative representation
    const sorted = selectBalancedTopContributors(grouped, topN);

    asset.reasons = sorted.map(([name, change]) => ({
      name,
      change,
      changeFormatted: formatSignedBytes(change),
      type: change > 0 ? 'added' : change < 0 ? 'removed' : 'changed',
    }));

    // Attach metadata about all contributors so reporters can show "... and N others"
    const allEntries = [...grouped.entries()].filter(([, v]) => v !== 0);
    const netChange = allEntries.reduce((sum, [, v]) => sum + v, 0);
    asset.reasonsMeta = {
      totalCount: allEntries.length,
      netChange,
    };
  }
}

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
      const key = normalizeGroupingKey(mc.packageName || mc.name);
      if (!grouped.has(key)) grouped.set(key, 0);
      grouped.set(key, grouped.get(key) + mc.change);
    }

    // Select top N with balanced positive/negative representation
    const sorted = selectBalancedTopContributors(grouped, topN);

    ep.reasons = sorted.map(([name, change]) => ({
      name,
      change,
      changeFormatted: formatSignedBytes(change),
      type: change > 0 ? 'added' : change < 0 ? 'removed' : 'changed',
    }));

    // Attach metadata about all contributors so reporters can show "... and N others"
    const allEntries = [...grouped.entries()].filter(([, v]) => v !== 0);
    const netChange = allEntries.reduce((sum, [, v]) => sum + v, 0);
    ep.reasonsMeta = {
      totalCount: allEntries.length,
      netChange,
    };
  }
}

/**
 * Replace post-minification asset sizes with pre-minification module-level sizes.
 * After computeAssetReasons has run, each asset has a reasonsMeta.netChange that
 * represents the pre-minify sum of all module changes. This function computes
 * per-asset base and PR sizes from module sizes so that:
 *   Change = prSize - baseSize = reasonsMeta.netChange = sum of all contributors
 *
 * @param {AssetChange[]} assetDiff - Asset-level changes (will be mutated)
 * @param {import('./stats-parser').ParsedModule[]} baseModules - Base branch modules
 * @param {import('./stats-parser').ParsedModule[]} prModules - PR branch modules
 * @param {Object.<number, string[]>} baseChunkToAssets - Base branch chunk ID→asset map
 * @param {Object.<number, string[]>} prChunkToAssets - PR branch chunk ID→asset map
 * @param {Object.<string, string[]>} baseChunkNameToAssets - Base branch chunk name→asset map
 * @param {Object.<string, string[]>} prChunkNameToAssets - PR branch chunk name→asset map
 */
function applyPreMinifySizes(assetDiff, baseModules, prModules, baseChunkToAssets, prChunkToAssets, baseChunkNameToAssets, prChunkNameToAssets) {
  // Build asset → chunk names maps (same logic as computeAssetReasons)
  const assetToChunkNames = new Map();
  for (const [chunkName, assetNames] of Object.entries(baseChunkNameToAssets)) {
    for (const assetName of assetNames) {
      if (!assetToChunkNames.has(assetName)) assetToChunkNames.set(assetName, new Set());
      assetToChunkNames.get(assetName).add(chunkName);
    }
  }
  for (const [chunkName, assetNames] of Object.entries(prChunkNameToAssets)) {
    for (const assetName of assetNames) {
      if (!assetToChunkNames.has(assetName)) assetToChunkNames.set(assetName, new Set());
      assetToChunkNames.get(assetName).add(chunkName);
    }
  }

  // Build asset → chunk IDs maps (fallback)
  const assetToChunkIds = new Map();
  for (const [chunkId, assetNames] of Object.entries(baseChunkToAssets)) {
    for (const assetName of assetNames) {
      if (!assetToChunkIds.has(assetName)) assetToChunkIds.set(assetName, new Set());
      assetToChunkIds.get(assetName).add(Number(chunkId));
    }
  }
  for (const [chunkId, assetNames] of Object.entries(prChunkToAssets)) {
    for (const assetName of assetNames) {
      if (!assetToChunkIds.has(assetName)) assetToChunkIds.set(assetName, new Set());
      assetToChunkIds.get(assetName).add(Number(chunkId));
    }
  }

  const hasChunkNames = baseModules.some(m => m.chunkNames && m.chunkNames.length > 0)
    || prModules.some(m => m.chunkNames && m.chunkNames.length > 0);

  for (const asset of assetDiff) {
    if (asset.type === 'unchanged') continue;

    // Find which chunks belong to this asset
    let chunkNames = null;
    let chunkIds = null;

    if (hasChunkNames) {
      chunkNames = assetToChunkNames.get(asset.name);
    }
    if (!chunkNames || chunkNames.size === 0) {
      chunkIds = assetToChunkIds.get(asset.name);
      if ((!chunkIds || chunkIds.size === 0) && asset.chunks && asset.chunks.length > 0) {
        chunkIds = new Set(asset.chunks);
      }
    }

    // Compute base size from base modules in these chunks
    let baseSizePreMinify = 0;
    for (const mod of baseModules) {
      if (chunkNames && chunkNames.size > 0) {
        if (mod.chunkNames && mod.chunkNames.some(cn => chunkNames.has(cn))) {
          baseSizePreMinify += mod.size;
        }
      } else if (chunkIds && chunkIds.size > 0) {
        if (mod.chunks && mod.chunks.some(cid => chunkIds.has(cid))) {
          baseSizePreMinify += mod.size;
        }
      }
    }

    // Compute PR size from PR modules in these chunks
    let prSizePreMinify = 0;
    for (const mod of prModules) {
      if (chunkNames && chunkNames.size > 0) {
        if (mod.chunkNames && mod.chunkNames.some(cn => chunkNames.has(cn))) {
          prSizePreMinify += mod.size;
        }
      } else if (chunkIds && chunkIds.size > 0) {
        if (mod.chunks && mod.chunks.some(cid => chunkIds.has(cid))) {
          prSizePreMinify += mod.size;
        }
      }
    }

    if (asset.type === 'added') {
      asset.baseSize = 0;
      asset.prSize = prSizePreMinify;
      asset.change = prSizePreMinify;
      asset.changeFormatted = formatSignedBytes(prSizePreMinify);
    } else if (asset.type === 'removed') {
      asset.baseSize = baseSizePreMinify;
      asset.prSize = 0;
      asset.change = -baseSizePreMinify;
      asset.changeFormatted = formatSignedBytes(-baseSizePreMinify);
    } else {
      // changed
      const diff = prSizePreMinify - baseSizePreMinify;
      asset.baseSize = baseSizePreMinify;
      asset.prSize = prSizePreMinify;
      asset.change = diff;
      asset.changeFormatted = formatSignedBytes(diff);
    }
  }
}

/**
 * Replace post-minification entrypoint sizes with pre-minification module-level sizes.
 * Same concept as applyPreMinifySizes but for entrypoints.
 *
 * @param {EntrypointChange[]} entrypointDiff - Entrypoint-level changes (will be mutated)
 * @param {import('./stats-parser').ParsedModule[]} baseModules - Base branch modules
 * @param {import('./stats-parser').ParsedModule[]} prModules - PR branch modules
 * @param {import('./stats-parser').ParsedEntrypoint[]} baseEntrypoints - Base branch entrypoints
 * @param {import('./stats-parser').ParsedEntrypoint[]} prEntrypoints - PR branch entrypoints
 */
function applyPreMinifySizesEntrypoints(entrypointDiff, baseModules, prModules, baseEntrypoints, prEntrypoints) {
  // Build entrypoint name → chunk IDs (separate for base and PR)
  const baseEpChunks = new Map();
  for (const ep of baseEntrypoints) {
    baseEpChunks.set(ep.name, new Set(ep.chunks || []));
  }
  const prEpChunks = new Map();
  for (const ep of prEntrypoints) {
    prEpChunks.set(ep.name, new Set(ep.chunks || []));
  }

  for (const ep of entrypointDiff) {
    if (ep.type === 'unchanged') continue;

    const baseChunkIds = baseEpChunks.get(ep.name) || new Set();
    const prChunkIds = prEpChunks.get(ep.name) || new Set();

    // Compute base size from base modules
    let baseSizePreMinify = 0;
    for (const mod of baseModules) {
      if (mod.chunks && mod.chunks.some(cid => baseChunkIds.has(cid))) {
        baseSizePreMinify += mod.size;
      }
    }

    // Compute PR size from PR modules
    let prSizePreMinify = 0;
    for (const mod of prModules) {
      if (mod.chunks && mod.chunks.some(cid => prChunkIds.has(cid))) {
        prSizePreMinify += mod.size;
      }
    }

    if (ep.type === 'added') {
      ep.baseSize = 0;
      ep.prSize = prSizePreMinify;
      ep.change = prSizePreMinify;
      ep.changeFormatted = formatSignedBytes(prSizePreMinify);
    } else if (ep.type === 'removed') {
      ep.baseSize = baseSizePreMinify;
      ep.prSize = 0;
      ep.change = -baseSizePreMinify;
      ep.changeFormatted = formatSignedBytes(-baseSizePreMinify);
    } else {
      const diff = prSizePreMinify - baseSizePreMinify;
      ep.baseSize = baseSizePreMinify;
      ep.prSize = prSizePreMinify;
      ep.change = diff;
      ep.changeFormatted = formatSignedBytes(diff);
    }
  }
}

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

/**
 * Compute size changes grouped by package
 * @param {ModuleChange[]} changes - All module changes
 * @returns {Object.<string, number>}
 */
function computePackageDiffs(changes) {
  const diffs = {};

  for (const change of changes) {
    if (!change.packageName) continue;

    diffs[change.packageName] = (diffs[change.packageName] || 0) + change.change;
  }

  // Sort by absolute change
  return Object.fromEntries(
    Object.entries(diffs).sort(([, a], [, b]) => Math.abs(b) - Math.abs(a))
  );
}

/**
 * Format bytes with sign (+/-)
 * @param {number} bytes
 * @returns {string}
 */
function formatSignedBytes(bytes) {
  const formatted = formatBytes(Math.abs(bytes));
  return bytes >= 0 ? `+${formatted}` : `-${formatted}`;
}

/**
 * Generate a summary of the diff
 * @param {BundleDiff} diff
 * @returns {Object}
 */
function generateSummary(diff) {
  const significantIncrease = diff.totalDiff > 50 * 1024; // > 50KB
  const significantDecrease = diff.totalDiff < -50 * 1024; // < -50KB

  return {
    hasChanges: diff.allChanges.length > 0,
    isSignificant: significantIncrease || significantDecrease,
    direction: diff.totalDiff > 0 ? 'increase' : diff.totalDiff < 0 ? 'decrease' : 'unchanged',
    nodeModulesImpact: diff.nodeModulesDiff,
    topAdded: diff.added
      .sort((a, b) => b.newSize - a.newSize)
      .slice(0, 5)
      .map(m => ({
        name: m.name,
        size: m.newSize,
        sizeFormatted: formatBytes(m.newSize),
      })),
    topIncreased: diff.allChanges
      .filter(c => c.type === 'changed' && c.change > 0)
      .sort((a, b) => b.change - a.change)
      .slice(0, 5)
      .map(m => ({
        name: m.name,
        change: m.change,
        changeFormatted: m.changeFormatted,
      })),
    packagesAdded: Object.entries(diff.packageDiffs)
      .filter(([, change]) => change > 0)
      .slice(0, 5),
  };
}

module.exports = {
  computeDiff,
  createModuleChange,
  buildImportChain,
  computePackageDiffs,
  computeNewDuplicates,
  computeAssetDiff,
  computeEntrypointDiff,
  computeAssetReasons,
  computeEntrypointReasons,
  applyPreMinifySizes,
  applyPreMinifySizesEntrypoints,
  selectBalancedTopContributors,
  normalizeGroupingKey,
  formatSignedBytes,
  generateSummary,
  formatBytes,
};
