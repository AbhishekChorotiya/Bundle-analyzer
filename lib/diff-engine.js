/**
 * @fileoverview Bundle Diff Engine
 * Computes differences between base and PR bundle stats
 */

const { isNodeModule, extractPackageName } = require('./stats-parser');
const { formatBytes } = require('./utils');

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
 * @property {string[]} chunkNames - Chunk names this asset belongs to
 * @property {AssetContributor[]} reasons - Top module/package contributors to size change
 */

/**
 * @typedef {Object} EntrypointChange
 * @property {string} name - Entrypoint name
 * @property {number} baseSize - Total assets size in base branch (0 if new)
 * @property {number} prSize - Total assets size in PR branch (0 if removed)
 * @property {number} change - Size difference in bytes
 * @property {string} changeFormatted - Human readable change
 * @property {string} type - 'added' | 'removed' | 'changed' | 'unchanged'
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
 * @property {AssetChange[]} assetDiff - Asset-level changes (output files)
 * @property {EntrypointChange[]} entrypointDiff - Entrypoint-level changes
 * @property {number} totalAssetDiff - Total deliverable asset size change
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
  const changed = [];

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
      changed.push(change);
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

  // Compute asset-level and entrypoint-level diffs
  const assetDiff = computeAssetDiff(baseStats.assets || [], prStats.assets || []);
  const entrypointDiff = computeEntrypointDiff(baseStats.entrypoints || [], prStats.entrypoints || []);
  const totalAssetDiff = (prStats.totalAssetSize || 0) - (baseStats.totalAssetSize || 0);

  // Compute module-level reasons for each asset's size change
  computeAssetReasons(
    assetDiff,
    allChanges,
    baseStats.chunkIdToAssets || {},
    prStats.chunkIdToAssets || {},
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
    baseAssetSize: baseStats.totalAssetSize || 0,
    prAssetSize: prStats.totalAssetSize || 0,
    baseAssetSizeFormatted: formatBytes(baseStats.totalAssetSize || 0),
    prAssetSizeFormatted: formatBytes(prStats.totalAssetSize || 0),
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
        chunkNames: prAsset.chunkNames || [],
      });
    } else if (baseAsset.size !== prAsset.size) {
      const diff = prAsset.size - baseAsset.size;
      changes.push({
        name,
        baseSize: baseAsset.size,
        prSize: prAsset.size,
        change: diff,
        changeFormatted: formatSignedBytes(diff),
        type: 'changed',
        chunkNames: prAsset.chunkNames || [],
      });
    } else {
      changes.push({
        name,
        baseSize: baseAsset.size,
        prSize: prAsset.size,
        change: 0,
        changeFormatted: formatSignedBytes(0),
        type: 'unchanged',
        chunkNames: prAsset.chunkNames || [],
      });
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
        chunkNames: baseAsset.chunkNames || [],
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
      });
    } else if (baseEp.assetsSize !== prEp.assetsSize) {
      const diff = prEp.assetsSize - baseEp.assetsSize;
      changes.push({
        name,
        baseSize: baseEp.assetsSize,
        prSize: prEp.assetsSize,
        change: diff,
        changeFormatted: formatSignedBytes(diff),
        type: 'changed',
      });
    } else {
      changes.push({
        name,
        baseSize: baseEp.assetsSize,
        prSize: prEp.assetsSize,
        change: 0,
        changeFormatted: formatSignedBytes(0),
        type: 'unchanged',
      });
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
 * Compute module-level reasons (contributors) for each asset's size change.
 * Maps module changes to assets using chunk IDs, then groups by package
 * and returns the top N contributors per asset.
 *
 * @param {AssetChange[]} assetDiff - Asset-level changes
 * @param {ModuleChange[]} moduleChanges - All module changes
 * @param {Object.<number, string[]>} baseChunkToAssets - Base branch chunk→asset map
 * @param {Object.<number, string[]>} prChunkToAssets - PR branch chunk→asset map
 * @param {number} [topN=3] - Number of top contributors to return per asset
 */
function computeAssetReasons(assetDiff, moduleChanges, baseChunkToAssets, prChunkToAssets, topN = 3) {
  // Build reverse map: asset name → set of chunk IDs (union of base and PR)
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

  for (const asset of assetDiff) {
    // Skip new/removed — no module-level attribution needed
    if (asset.type === 'added' || asset.type === 'removed' || asset.type === 'unchanged') {
      asset.reasons = [];
      continue;
    }

    const chunkIds = assetToChunkIds.get(asset.name);
    if (!chunkIds || chunkIds.size === 0) {
      asset.reasons = [];
      continue;
    }

    // Find module changes that belong to this asset's chunks
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

    asset.reasons = sorted.map(([name, change]) => ({
      name,
      change,
      changeFormatted: formatSignedBytes(change),
      type: change > 0 ? 'added' : change < 0 ? 'removed' : 'changed',
    }));
  }
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
 * Extract top-level import chain (what file caused the dependency)
 * @param {ModuleChange} change
 * @returns {string}
 */
function getRootCause(change) {
  if (change.importChain.length === 0) return 'Unknown';

  // First non-node_modules entry in chain is likely the source
  for (const item of change.importChain) {
    if (!isNodeModule(item)) {
      return item;
    }
  }

  return change.importChain[0];
}

/**
 * Filter changes by various criteria
 * @param {BundleDiff} diff
 * @param {Object} filters
 * @returns {ModuleChange[]}
 */
function filterChanges(diff, filters = {}) {
  let filtered = diff.allChanges;

  if (filters.onlyNodeModules) {
    filtered = filtered.filter(c => c.isNodeModule);
  }

  if (filters.minSize) {
    filtered = filtered.filter(c => Math.abs(c.change) >= filters.minSize);
  }

  if (filters.packageName) {
    filtered = filtered.filter(c => c.packageName === filters.packageName);
  }

  if (filters.type) {
    filtered = filtered.filter(c => c.type === filters.type);
  }

  return filtered;
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
  computeAssetDiff,
  computeEntrypointDiff,
  computeAssetReasons,
  formatSignedBytes,
  getRootCause,
  filterChanges,
  generateSummary,
  formatBytes,
};
