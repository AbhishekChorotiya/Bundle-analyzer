/**
 * @fileoverview Webpack Stats Parser
 * Parses webpack --json --profile output into structured module data
 */

const { formatBytes } = require('./utils');

/**
 * @typedef {Object} ParsedModule
 * @property {string} id - Module identifier
 * @property {string} name - Module name (path)
 * @property {number} size - Module size in bytes
 * @property {string[]} reasons - Import reasons
 * @property {string[]} usedExports - Exported symbols that are actually used
 * @property {string} issuer - The module that imported this module
 * @property {boolean} isNodeModule - Whether this is from node_modules
 * @property {number[]} chunks - Chunk IDs this module belongs to
 */

/**
 * @typedef {Object} CompressedSize
 * @property {number} gzip - Estimated gzip compressed size in bytes
 * @property {number} brotli - Estimated brotli compressed size in bytes
 */

/**
 * @typedef {Object} ParsedAsset
 * @property {string} name - Output file name (e.g. "app.js")
 * @property {number} size - Asset size in bytes (post-minification)
 * @property {string[]} chunkNames - Chunk names this asset belongs to
 * @property {number[]} chunks - Chunk IDs this asset belongs to (for module attribution)
 * @property {CompressedSize} compressed - Estimated compressed sizes
 */

/**
 * @typedef {Object} ParsedEntrypoint
 * @property {string} name - Entrypoint name (e.g. "app", "HyperLoader")
 * @property {ParsedAsset[]} assets - Assets belonging to this entrypoint
 * @property {number} assetsSize - Total size of all assets in this entrypoint
 * @property {number[]} chunks - Chunk IDs belonging to this entrypoint
 * @property {CompressedSize} compressed - Estimated compressed entrypoint sizes
 */

/**
 * @typedef {Object} BundleStats
 * @property {ParsedModule[]} modules - All parsed modules
 * @property {number} totalSize - Total bundle size in bytes
 * @property {number} nodeModulesSize - Size of all node_modules
 * @property {Object.<string, number>} byPackage - Size grouped by package name
 * @property {string[]} entryPoints - Entry point names
 * @property {ParsedAsset[]} assets - Parsed output assets (deliverable files only)
 * @property {number} totalAssetSize - Total size of all deliverable assets
 * @property {ParsedEntrypoint[]} entrypoints - Parsed entrypoints with asset data
 * @property {Object.<number, string[]>} chunkIdToAssets - Maps chunk ID to output asset file names
 * @property {number} totalGzipSize - Total estimated gzip size of all deliverable assets
 */

/**
 * Parse webpack stats JSON into structured data.
 * Deduplicates modules that appear both inside concatenated parents
 * (e.g. "./index.js + 113 modules") and as separate top-level entries,
 * which would otherwise inflate total sizes by ~2x.
 * @param {Object} stats - Raw webpack stats from --json output
 * @returns {BundleStats} Parsed bundle statistics
 */
function parseStats(stats) {
  if (!stats || !Array.isArray(stats.modules)) {
    throw new Error('Invalid webpack stats: expected object with "modules" array');
  }

  // Build a set of module names that are nested inside concatenated parents.
  // Webpack 5's ModuleConcatenationPlugin emits entries like
  //   { name: "./index.js + 113 modules", size: 923504, modules: [...] }
  // AND also lists the 113 sub-modules individually at the top level.
  // Summing all top-level entries therefore double-counts these sub-modules.
  const nestedNames = new Set();
  for (const mod of stats.modules) {
    if (mod.modules && mod.modules.length > 0) {
      for (const sub of mod.modules) {
        if (sub.name && sub.name !== mod.name) {
          nestedNames.add(sub.name);
        }
      }
    }
  }

  const modules = stats.modules
    .filter(m => !nestedNames.has(m.name))
    .map(parseModule);
  const nodeModules = modules.filter(m => m.isNodeModule);
  const assets = parseAssets(stats);
  const entrypoints = parseEntrypoints(stats);
  const chunkIdToAssets = buildChunkToAssetsMap(stats);

  return {
    modules,
    totalSize: calculateTotalSize(modules),
    nodeModulesSize: calculateTotalSize(nodeModules),
    byPackage: groupByPackage(modules),
    entryPoints: extractEntryPoints(stats),
    assets,
    totalAssetSize: assets.reduce((sum, a) => sum + a.size, 0),
    totalGzipSize: assets.reduce((sum, a) => sum + a.compressed.gzip, 0),
    entrypoints,
    chunkIdToAssets,
  };
}

/**
 * Parse a single module from webpack stats
 * @param {Object} module - Raw module data from webpack
 * @returns {ParsedModule}
 */
function parseModule(module) {
  const name = cleanModuleName(module.name || module.identifier || 'unknown');
  const size = module.size || 0;
  const reasons = parseReasons(module.reasons || []);
  const usedExports = parseUsedExports(module.usedExports);

  return {
    id: module.id?.toString() || name,
    name,
    size,
    reasons,
    usedExports,
    issuer: extractIssuer(module.reasons),
    isNodeModule: isNodeModule(name),
    chunks: Array.isArray(module.chunks) ? module.chunks : [],
  };
}

/**
 * Clean module name/path for display
 * @param {string} name - Raw module name
 * @returns {string}
 */
function cleanModuleName(name) {
  // Remove webpack internal prefixes
  return name
    .replace(/\.\/\.\//g, './')
    .replace(/^multi\s+/, '')
    .replace(/^\.+\//, '')
    .trim();
}

/**
 * Parse module reasons into simplified import chain
 * @param {Array} reasons - Raw reasons from webpack
 * @returns {string[]}
 */
function parseReasons(reasons) {
  if (!Array.isArray(reasons)) return [];

  return reasons
    .map(r => {
      const moduleName = r.moduleName || r.module || r.resolvedModule || '';
      return cleanModuleName(moduleName);
    })
    .filter(Boolean);
}

/**
 * Extract the immediate issuer (direct importer) from reasons
 * @param {Array} reasons - Raw reasons from webpack
 * @returns {string|null}
 */
function extractIssuer(reasons) {
  if (!Array.isArray(reasons) || reasons.length === 0) return null;
  const firstReason = reasons[0];
  return cleanModuleName(firstReason.moduleName || firstReason.module || '');
}

/**
 * Parse used exports information
 * @param {*} usedExports - Webpack's usedExports value
 * @returns {string[]}
 */
function parseUsedExports(usedExports) {
  if (usedExports === null || usedExports === undefined) return [];
  if (usedExports === false) return []; // Tree-shaking disabled
  if (usedExports === true) return ['*']; // All exports used
  if (Array.isArray(usedExports)) return usedExports;
  return [String(usedExports)];
}

/**
 * Check if module is from node_modules
 * @param {string} name - Module name
 * @returns {boolean}
 */
function isNodeModule(name) {
  return name.includes('node_modules');
}

/**
 * Extract package name from module path
 * @param {string} name - Module name/path
 * @returns {string|null}
 */
function extractPackageName(name) {
  if (!isNodeModule(name)) return null;

  const match = name.match(/node_modules[/\\](?:@[^/\\]+[/\\][^/\\]+|[^/\\]+)/);
  if (!match) return null;

  // Remove 'node_modules/' prefix
  return match[0].replace(/^node_modules[/\\]/, '');
}

/**
 * Group modules by their package name
 * @param {ParsedModule[]} modules - Parsed modules
 * @returns {Object.<string, number>}
 */
function groupByPackage(modules) {
  const groups = {};

  for (const module of modules) {
    if (!module.isNodeModule) continue;

    const pkgName = extractPackageName(module.name);
    if (!pkgName) continue;

    groups[pkgName] = (groups[pkgName] || 0) + module.size;
  }

  return groups;
}

/**
 * Calculate total size from modules
 * @param {ParsedModule[]} modules - Modules to sum
 * @returns {number}
 */
function calculateTotalSize(modules) {
  return modules.reduce((sum, m) => sum + m.size, 0);
}

/**
 * Extract entry points from webpack stats
 * @param {Object} stats - Raw webpack stats
 * @returns {string[]}
 */
function extractEntryPoints(stats) {
  if (!stats.entrypoints) return [];
  return Object.keys(stats.entrypoints);
}

/**
 * Load and parse webpack stats from file
 * @param {string} filePath - Path to stats JSON file
 * @returns {BundleStats}
 */
function loadStatsFromFile(filePath) {
  const fs = require('fs');
  const content = fs.readFileSync(filePath, 'utf-8');
  const stats = JSON.parse(content);
  return parseStats(stats);
}

/**
 * Build a mapping from chunk ID to output asset file names.
 * Uses stats.chunks[].id and stats.chunks[].files.
 * @param {Object} stats - Raw webpack stats
 * @returns {Object.<number, string[]>}
 */
function buildChunkToAssetsMap(stats) {
  const map = {};
  if (!stats.chunks || !Array.isArray(stats.chunks)) return map;

  for (const chunk of stats.chunks) {
    if (chunk.id != null && Array.isArray(chunk.files)) {
      // Only include deliverable files in the mapping
      map[chunk.id] = chunk.files.filter(f => isDeliverableAsset(f));
    }
  }
  return map;
}

/**
 * Non-deliverable file extensions to filter out of asset comparisons.
 * These are build artifacts (source maps, license files) not served to users.
 */
const NON_DELIVERABLE_EXTENSIONS = ['.map', '.LICENSE.txt', '.LICENSE', '.txt'];

/**
 * Check if an asset is a deliverable file (served to end users).
 * Filters out source maps, license files, and other build artifacts.
 * @param {string} name - Asset file name
 * @returns {boolean}
 */
function isDeliverableAsset(name) {
  return !NON_DELIVERABLE_EXTENSIONS.some(ext => name.endsWith(ext));
}

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

/**
 * Parse webpack assets into structured data.
 * Only includes deliverable assets (filters out .map, .LICENSE.txt, etc.)
 * @param {Object} stats - Raw webpack stats
 * @returns {ParsedAsset[]}
 */
function parseAssets(stats) {
  if (!stats.assets || !Array.isArray(stats.assets)) return [];

  return stats.assets
    .filter(a => isDeliverableAsset(a.name))
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
    .sort((a, b) => b.size - a.size); // Sort by size descending
}

/**
 * Parse webpack entrypoints into structured data with asset sizes.
 * @param {Object} stats - Raw webpack stats
 * @returns {ParsedEntrypoint[]}
 */
function parseEntrypoints(stats) {
  if (!stats.entrypoints) return [];

  return Object.entries(stats.entrypoints).map(([name, ep]) => {
    const assets = (ep.assets || [])
      .filter(a => {
        const assetName = typeof a === 'string' ? a : a.name;
        return isDeliverableAsset(assetName);
      })
      .map(a => {
        if (typeof a === 'string') {
          // Older webpack format: assets is string[]
          // Look up size from stats.assets
          const match = (stats.assets || []).find(sa => sa.name === a);
          return { name: a, size: match?.size || 0, chunkNames: [] };
        }
        // Newer webpack format: assets is { name, size }[]
        return { name: a.name, size: a.size || 0, chunkNames: [] };
      });

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
  });
}

module.exports = {
  parseStats,
  parseModule,
  loadStatsFromFile,
  extractPackageName,
  isNodeModule,
  formatBytes,
  parseAssets,
  parseEntrypoints,
  isDeliverableAsset,
  buildChunkToAssetsMap,
  estimateCompressedSize,
};
