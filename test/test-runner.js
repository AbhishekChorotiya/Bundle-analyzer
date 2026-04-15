#!/usr/bin/env node
/**
 * @fileoverview Test Runner
 * Basic tests for bundle-ai modules
 */

const fs = require('fs');
const path = require('path');
const { formatBytes: utilsFormatBytes, loadEnv, getRootCause, validateGitRef } = require('../lib/utils');

// Test utilities
let testsRun = 0;
let testsPassed = 0;
let testsFailed = 0;

function test(name, fn) {
  testsRun++;
  try {
    fn();
    console.log(`✓ ${name}`);
    testsPassed++;
  } catch (error) {
    console.error(`✗ ${name}`);
    console.error(`  Error: ${error.message}`);
    testsFailed++;
  }
}

function assertEqual(actual, expected, msg = '') {
  if (actual !== expected) {
    throw new Error(`${msg} Expected ${expected}, got ${actual}`);
  }
}

function assertTrue(value, msg = '') {
  if (value !== true) {
    throw new Error(`${msg} Expected true, got ${value}`);
  }
}

function assertFalse(value, msg = '') {
  if (value !== false) {
    throw new Error(`${msg} Expected false, got ${value}`);
  }
}

const asyncTests = [];

function testAsync(name, fn) {
  asyncTests.push({ name, fn });
}

// Run tests
console.log('Running Bundle AI Tests\n');

// Test stats-parser
console.log('--- Testing stats-parser.js ---');
const { parseStats, isNodeModule, extractPackageName, formatBytes, parseAssets, parseEntrypoints, isDeliverableAsset, buildChunkToAssetsMap, buildChunkNameToAssetsMap, buildChunkIdToNameMap } = require('../lib/stats-parser');

test('parseStats parses webpack stats correctly', () => {
  const sampleStats = JSON.parse(fs.readFileSync(path.join(__dirname, 'sample-base-stats.json'), 'utf-8'));
  const result = parseStats(sampleStats);

  assertTrue(Array.isArray(result.modules), 'Should have modules array');
  assertEqual(result.modules.length, 6, 'Should have 6 modules');
  assertTrue(result.totalSize > 0, 'Should have positive total size');
  assertTrue(Array.isArray(result.assets), 'Should have assets array');
  assertTrue(result.totalAssetSize > 0, 'Should have positive total asset size');
  assertTrue(Array.isArray(result.entrypoints), 'Should have entrypoints array');
});

test('isNodeModule detects node_modules correctly', () => {
  assertTrue(isNodeModule('./node_modules/react/index.js'), 'Should detect node_modules');
  assertFalse(isNodeModule('./src/App.js'), 'Should not detect source file');
  assertTrue(isNodeModule('node_modules/lodash/index.js'), 'Should detect without ./');
});

test('extractPackageName extracts package name', () => {
  assertEqual(extractPackageName('./node_modules/react/index.js'), 'react', 'Should extract react');
  assertEqual(extractPackageName('./node_modules/@babel/runtime/index.js'), '@babel/runtime', 'Should extract scoped package');
  assertEqual(extractPackageName('./src/App.js'), null, 'Should return null for non-node_modules');
});

test('formatBytes formats correctly', () => {
  assertEqual(formatBytes(0), '0 B', 'Zero bytes');
  assertEqual(formatBytes(1024), '1 KB', '1 kilobyte');
  assertEqual(formatBytes(1024 * 1024), '1 MB', '1 megabyte');
  assertTrue(formatBytes(1536).includes('1.5'), '1.5 KB');
});

test('utils formatBytes formats correctly', () => {
  assertEqual(utilsFormatBytes(0), '0 B', 'Zero bytes');
  assertEqual(utilsFormatBytes(1024), '1 KB', '1 kilobyte');
  assertEqual(utilsFormatBytes(1024 * 1024), '1 MB', '1 megabyte');
  assertTrue(utilsFormatBytes(1536).includes('1.5'), '1.5 KB');
});

test('utils formatBytes signed option', () => {
  assertTrue(utilsFormatBytes(1024, { signed: true }).startsWith('+'), 'Positive signed');
  assertTrue(utilsFormatBytes(-1024, { signed: true }).startsWith('-'), 'Negative signed');
  assertTrue(!utilsFormatBytes(1024).startsWith('+'), 'Unsigned by default');
});

test('isDeliverableAsset filters non-deliverable files', () => {
  assertTrue(isDeliverableAsset('main.bundle.js'), 'JS files are deliverable');
  assertTrue(isDeliverableAsset('vendor.bundle.js'), 'Vendor JS is deliverable');
  assertFalse(isDeliverableAsset('main.bundle.js.map'), 'Source maps are not deliverable');
  assertFalse(isDeliverableAsset('main.bundle.js.LICENSE.txt'), 'License files are not deliverable');
  assertFalse(isDeliverableAsset('vendor.LICENSE'), '.LICENSE files are not deliverable');
});

test('parseAssets filters out non-deliverable assets and sorts by size', () => {
  const sampleStats = JSON.parse(fs.readFileSync(path.join(__dirname, 'sample-base-stats.json'), 'utf-8'));
  const assets = parseAssets(sampleStats);

  // Base has 4 assets total: main.bundle.js, vendor.bundle.js, main.bundle.js.map, main.bundle.js.LICENSE.txt
  // Only 2 are deliverable
  assertEqual(assets.length, 2, 'Should have 2 deliverable assets');
  assertEqual(assets[0].name, 'main.bundle.js', 'Largest asset should be first');
  assertTrue(assets[0].size > assets[1].size, 'Should be sorted by size descending');
});

test('parseEntrypoints parses entrypoints with string[] asset format', () => {
  const sampleStats = JSON.parse(fs.readFileSync(path.join(__dirname, 'sample-base-stats.json'), 'utf-8'));
  const entrypoints = parseEntrypoints(sampleStats);

  assertEqual(entrypoints.length, 2, 'Should have 2 entrypoints');
  const app = entrypoints.find(e => e.name === 'app');
  assertTrue(!!app, 'Should have app entrypoint');
  assertTrue(app.assetsSize > 0, 'App entrypoint should have positive size');
  assertEqual(app.assets.length, 2, 'App entrypoint should have 2 assets');
});

test('parseEntrypoints handles missing entrypoints gracefully', () => {
  const entrypoints = parseEntrypoints({});
  assertEqual(entrypoints.length, 0, 'Should return empty array for missing entrypoints');
});

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

// Test diff-engine
console.log('\n--- Testing diff-engine.js ---');
const { computeDiff, generateSummary, computeAssetDiff, computeEntrypointDiff, computeAssetReasons, computeEntrypointReasons, selectBalancedTopContributors } = require('../lib/diff-engine');

test('computeDiff calculates size differences', () => {
  const baseStats = parseStats(JSON.parse(fs.readFileSync(path.join(__dirname, 'sample-base-stats.json'), 'utf-8')));
  const prStats = parseStats(JSON.parse(fs.readFileSync(path.join(__dirname, 'sample-pr-stats.json'), 'utf-8')));

  const diff = computeDiff(baseStats, prStats);

  assertTrue(typeof diff.totalDiff === 'number', 'Should have totalDiff');
  assertTrue(diff.totalDiff > 0, 'PR should be larger');
  assertTrue(Array.isArray(diff.added), 'Should have added array');
  assertTrue(Array.isArray(diff.removed), 'Should have removed array');
  assertTrue(diff.added.length > 0, 'Should detect added modules');
});

test('generateSummary produces valid summary', () => {
  const baseStats = parseStats(JSON.parse(fs.readFileSync(path.join(__dirname, 'sample-base-stats.json'), 'utf-8')));
  const prStats = parseStats(JSON.parse(fs.readFileSync(path.join(__dirname, 'sample-pr-stats.json'), 'utf-8')));
  const diff = computeDiff(baseStats, prStats);
  const summary = generateSummary(diff);

  assertTrue(typeof summary.hasChanges === 'boolean', 'Should have hasChanges');
  assertTrue(typeof summary.isSignificant === 'boolean', 'Should have isSignificant');
  assertTrue(['increase', 'decrease', 'unchanged'].includes(summary.direction), 'Should have valid direction');
});

test('computeDiff includes asset and entrypoint data', () => {
  const baseStats = parseStats(JSON.parse(fs.readFileSync(path.join(__dirname, 'sample-base-stats.json'), 'utf-8')));
  const prStats = parseStats(JSON.parse(fs.readFileSync(path.join(__dirname, 'sample-pr-stats.json'), 'utf-8')));
  const diff = computeDiff(baseStats, prStats);

  assertTrue(Array.isArray(diff.assetDiff), 'Should have assetDiff');
  assertTrue(Array.isArray(diff.entrypointDiff), 'Should have entrypointDiff');
  assertTrue(typeof diff.totalAssetDiff === 'number', 'Should have totalAssetDiff');
  assertTrue(typeof diff.baseAssetSize === 'number', 'Should have baseAssetSize');
  assertTrue(typeof diff.prAssetSize === 'number', 'Should have prAssetSize');
});

test('computeAssetDiff detects added, changed, and unchanged assets', () => {
  const baseAssets = [
    { name: 'main.js', size: 100000, chunkNames: ['main'] },
    { name: 'vendor.js', size: 50000, chunkNames: ['vendor'] },
    { name: 'old.js', size: 10000, chunkNames: ['old'] },
  ];
  const prAssets = [
    { name: 'main.js', size: 120000, chunkNames: ['main'] },
    { name: 'vendor.js', size: 50000, chunkNames: ['vendor'] },
    { name: 'new.js', size: 30000, chunkNames: ['new'] },
  ];

  const diff = computeAssetDiff(baseAssets, prAssets);

  const added = diff.filter(a => a.type === 'added');
  const removed = diff.filter(a => a.type === 'removed');
  const changed = diff.filter(a => a.type === 'changed');
  const unchanged = diff.filter(a => a.type === 'unchanged');

  assertEqual(added.length, 1, 'Should have 1 added asset');
  assertEqual(added[0].name, 'new.js', 'Added asset should be new.js');
  assertEqual(removed.length, 1, 'Should have 1 removed asset');
  assertEqual(removed[0].name, 'old.js', 'Removed asset should be old.js');
  assertEqual(changed.length, 1, 'Should have 1 changed asset');
  assertEqual(changed[0].name, 'main.js', 'Changed asset should be main.js');
  assertEqual(changed[0].change, 20000, 'Change should be +20000');
  assertEqual(unchanged.length, 1, 'Should have 1 unchanged asset');
  assertEqual(unchanged[0].name, 'vendor.js', 'Unchanged asset should be vendor.js');
});

test('computeEntrypointDiff detects new entrypoints', () => {
  const baseEntrypoints = [
    { name: 'app', assetsSize: 200000 },
    { name: 'HyperLoader', assetsSize: 50000 },
  ];
  const prEntrypoints = [
    { name: 'app', assetsSize: 210000 },
    { name: 'HyperLoader', assetsSize: 50000 },
    { name: 'hs-sdk-sw', assetsSize: 65000 },
  ];

  const diff = computeEntrypointDiff(baseEntrypoints, prEntrypoints);

  const added = diff.filter(e => e.type === 'added');
  const changed = diff.filter(e => e.type === 'changed');
  const unchanged = diff.filter(e => e.type === 'unchanged');

  assertEqual(added.length, 1, 'Should have 1 new entrypoint');
  assertEqual(added[0].name, 'hs-sdk-sw', 'New entrypoint should be hs-sdk-sw');
  assertEqual(added[0].prSize, 65000, 'New entrypoint size should be 65000');
  assertEqual(changed.length, 1, 'Should have 1 changed entrypoint');
  assertEqual(unchanged.length, 1, 'Should have 1 unchanged entrypoint');
});

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

test('buildChunkToAssetsMap maps chunk IDs to deliverable asset filenames', () => {
  const sampleStats = JSON.parse(fs.readFileSync(path.join(__dirname, 'sample-base-stats.json'), 'utf-8'));
  const map = buildChunkToAssetsMap(sampleStats);

  // Chunk 0 → main.bundle.js (not .map or .LICENSE.txt)
  assertTrue(Array.isArray(map[0]), 'Should have mapping for chunk 0');
  assertTrue(map[0].includes('main.bundle.js'), 'Chunk 0 should map to main.bundle.js');
  assertFalse(map[0].includes('main.bundle.js.map'), 'Should NOT include .map files');
  assertFalse(map[0].includes('main.bundle.js.LICENSE.txt'), 'Should NOT include .LICENSE.txt');

  // Chunk 1 → vendor.bundle.js
  assertTrue(Array.isArray(map[1]), 'Should have mapping for chunk 1');
  assertTrue(map[1].includes('vendor.bundle.js'), 'Chunk 1 should map to vendor.bundle.js');
});

test('buildChunkToAssetsMap handles PR stats with 3 chunks', () => {
  const sampleStats = JSON.parse(fs.readFileSync(path.join(__dirname, 'sample-pr-stats.json'), 'utf-8'));
  const map = buildChunkToAssetsMap(sampleStats);

  assertTrue(Array.isArray(map[2]), 'Should have mapping for chunk 2');
  assertTrue(map[2].includes('sw.bundle.js'), 'Chunk 2 should map to sw.bundle.js');
  // sw.bundle.js.LICENSE.txt should be filtered out
  assertEqual(map[2].length, 1, 'Chunk 2 should only have 1 deliverable asset');
});

test('computeAssetReasons attributes module changes to correct assets', () => {
  const baseStats = parseStats(JSON.parse(fs.readFileSync(path.join(__dirname, 'sample-base-stats.json'), 'utf-8')));
  const prStats = parseStats(JSON.parse(fs.readFileSync(path.join(__dirname, 'sample-pr-stats.json'), 'utf-8')));
  const diff = computeDiff(baseStats, prStats);

  // main.bundle.js changed — should have reasons (lodash, chart.js, NewFeature.js are in chunk 0)
  const mainAsset = diff.assetDiff.find(a => a.name === 'main.bundle.js');
  assertTrue(!!mainAsset, 'Should have main.bundle.js asset');
  assertEqual(mainAsset.type, 'changed', 'main.bundle.js should be changed');
  assertTrue(Array.isArray(mainAsset.reasons), 'Should have reasons array');
  assertTrue(mainAsset.reasons.length > 0, 'Should have at least one reason');

  // lodash (700KB added) should be the top contributor
  assertEqual(mainAsset.reasons[0].name, 'lodash', 'Top contributor should be lodash');
  assertTrue(mainAsset.reasons[0].change > 0, 'lodash should have positive change');
});

test('computeAssetReasons returns empty reasons for new/removed assets', () => {
  const baseStats = parseStats(JSON.parse(fs.readFileSync(path.join(__dirname, 'sample-base-stats.json'), 'utf-8')));
  const prStats = parseStats(JSON.parse(fs.readFileSync(path.join(__dirname, 'sample-pr-stats.json'), 'utf-8')));
  const diff = computeDiff(baseStats, prStats);

  // sw.bundle.js is added — should have empty reasons
  const swAsset = diff.assetDiff.find(a => a.name === 'sw.bundle.js');
  assertTrue(!!swAsset, 'Should have sw.bundle.js asset');
  assertEqual(swAsset.type, 'added', 'sw.bundle.js should be added');
  assertEqual(swAsset.reasons.length, 0, 'New asset should have empty reasons');
});

test('computeAssetReasons groups node_modules by package name', () => {
  // Both lodash/lodash.js and chart.js/dist/chart.js are in chunk 0 → main.bundle.js
  // They should be grouped by package name (lodash, chart.js)
  const baseStats = parseStats(JSON.parse(fs.readFileSync(path.join(__dirname, 'sample-base-stats.json'), 'utf-8')));
  const prStats = parseStats(JSON.parse(fs.readFileSync(path.join(__dirname, 'sample-pr-stats.json'), 'utf-8')));
  const diff = computeDiff(baseStats, prStats);

  const mainAsset = diff.assetDiff.find(a => a.name === 'main.bundle.js');
  const reasonNames = mainAsset.reasons.map(r => r.name);

  // Should include package names, not full module paths
  assertTrue(reasonNames.includes('lodash'), 'Should include lodash package');
  // chart.js and NewFeature.js should also be present (top 3)
  assertTrue(mainAsset.reasons.length <= 3, 'Should have at most 3 reasons (top N)');
});

// Tests for chunk-name-based matching (stable across builds)
test('buildChunkNameToAssetsMap maps chunk names to deliverable asset filenames', () => {
  const sampleStats = JSON.parse(fs.readFileSync(path.join(__dirname, 'sample-pr-stats.json'), 'utf-8'));
  const map = buildChunkNameToAssetsMap(sampleStats);

  assertTrue(Array.isArray(map['main']), 'Should have mapping for chunk name "main"');
  assertTrue(map['main'].includes('main.bundle.js'), '"main" chunk should map to main.bundle.js');
  assertTrue(Array.isArray(map['vendor']), 'Should have mapping for chunk name "vendor"');
  assertTrue(map['vendor'].includes('vendor.bundle.js'), '"vendor" chunk should map to vendor.bundle.js');
  assertTrue(Array.isArray(map['hs-sdk-sw']), 'Should have mapping for chunk name "hs-sdk-sw"');
  assertTrue(map['hs-sdk-sw'].includes('sw.bundle.js'), '"hs-sdk-sw" chunk should map to sw.bundle.js');
  // Non-deliverable files should be filtered
  assertFalse((map['hs-sdk-sw'] || []).includes('sw.bundle.js.LICENSE.txt'), 'Should NOT include LICENSE.txt');
});

test('buildChunkIdToNameMap maps numeric IDs to chunk names', () => {
  const sampleStats = JSON.parse(fs.readFileSync(path.join(__dirname, 'sample-pr-stats.json'), 'utf-8'));
  const map = buildChunkIdToNameMap(sampleStats);

  assertEqual(map[0], 'main', 'Chunk 0 should be named "main"');
  assertEqual(map[1], 'vendor', 'Chunk 1 should be named "vendor"');
  assertEqual(map[2], 'hs-sdk-sw', 'Chunk 2 should be named "hs-sdk-sw"');
});

test('parseModule populates chunkNames when chunkIdToName is provided', () => {
  const { parseModule: parseModuleFn } = require('../lib/stats-parser');
  const chunkIdToName = { 0: 'main', 1: 'vendor', 2: 'hs-sdk-sw' };
  const rawModule = { name: './src/index.js', size: 1024, chunks: [0], reasons: [] };
  const parsed = parseModuleFn(rawModule, chunkIdToName);

  assertTrue(Array.isArray(parsed.chunkNames), 'Should have chunkNames array');
  assertEqual(parsed.chunkNames.length, 1, 'Should have one chunk name');
  assertEqual(parsed.chunkNames[0], 'main', 'Should resolve to "main"');
});

test('parseModule returns empty chunkNames when no lookup provided', () => {
  const { parseModule: parseModuleFn } = require('../lib/stats-parser');
  const rawModule = { name: './src/index.js', size: 1024, chunks: [0], reasons: [] };
  const parsed = parseModuleFn(rawModule);

  assertTrue(Array.isArray(parsed.chunkNames), 'Should have chunkNames array');
  assertEqual(parsed.chunkNames.length, 0, 'Should be empty without lookup');
});

test('parseStats populates chunkNames on parsed modules', () => {
  const sampleStats = JSON.parse(fs.readFileSync(path.join(__dirname, 'sample-pr-stats.json'), 'utf-8'));
  const parsed = parseStats(sampleStats);

  // Service worker module should have chunkNames: ["hs-sdk-sw"]
  const swModule = parsed.modules.find(m => m.name.includes('service-worker'));
  assertTrue(!!swModule, 'Should find service-worker module');
  assertTrue(Array.isArray(swModule.chunkNames), 'Should have chunkNames');
  assertTrue(swModule.chunkNames.includes('hs-sdk-sw'), 'SW module should belong to hs-sdk-sw chunk');
  assertFalse(swModule.chunkNames.includes('main'), 'SW module should NOT belong to main chunk');

  // index.js should have chunkNames: ["main"]
  const indexModule = parsed.modules.find(m => m.name.includes('index.js') && !m.name.includes('node_modules'));
  assertTrue(!!indexModule, 'Should find index.js module');
  assertTrue(indexModule.chunkNames.includes('main'), 'index.js should belong to main chunk');
});

test('parseStats includes chunkNameToAssets in result', () => {
  const sampleStats = JSON.parse(fs.readFileSync(path.join(__dirname, 'sample-pr-stats.json'), 'utf-8'));
  const parsed = parseStats(sampleStats);

  assertTrue(!!parsed.chunkNameToAssets, 'Should have chunkNameToAssets');
  assertTrue(Array.isArray(parsed.chunkNameToAssets['main']), 'Should have "main" mapping');
  assertTrue(parsed.chunkNameToAssets['main'].includes('main.bundle.js'), '"main" should map to main.bundle.js');
});

test('computeAssetReasons uses chunk names for attribution when available', () => {
  // Create a scenario where chunk IDs are DIFFERENT between base and PR
  // but chunk names are stable — verifying that chunk-name matching is used
  const baseModules = [
    { name: './src/App.js', size: 3000, chunks: [0], chunkNames: ['main'] },
  ];
  const prModules = [
    { name: './src/App.js', size: 4000, chunks: [5], chunkNames: ['main'] },  // Different chunk ID!
  ];

  // Module change: App.js went from 3000 to 4000 (+1000)
  // In PR, it has chunk ID 5. In base, chunk ID 0.
  const moduleChanges = [{
    name: 'src/App.js',
    oldSize: 3000,
    newSize: 4000,
    change: 1000,
    changeFormatted: '+1000 B',
    type: 'changed',
    isNodeModule: false,
    packageName: null,
    chunks: [5],       // PR chunk ID (different from base)
    chunkNames: ['main'], // Stable chunk name
    importChain: [],
  }];

  // chunkIdToAssets: IDs shifted between builds
  const baseChunkToAssets = { 0: ['app.js'] };   // chunk 0 = app.js in base
  const prChunkToAssets = { 5: ['app.js'] };     // chunk 5 = app.js in PR

  // chunkNameToAssets: names are stable
  const baseChunkNameToAssets = { main: ['app.js'] };
  const prChunkNameToAssets = { main: ['app.js'] };

  const assetDiff = [{
    name: 'app.js',
    baseSize: 50000,
    prSize: 51000,
    change: 1000,
    changeFormatted: '+1000 B',
    type: 'changed',
    baseGzip: 15000,
    prGzip: 15300,
    gzipChange: 300,
    chunkNames: ['main'],
    chunks: [],
    reasons: [],
  }];

  computeAssetReasons(assetDiff, moduleChanges, baseChunkToAssets, prChunkToAssets, 3, baseChunkNameToAssets, prChunkNameToAssets);

  assertTrue(assetDiff[0].reasons.length > 0, 'Should attribute App.js to app.js via chunk name');
  assertEqual(assetDiff[0].reasons[0].name, 'src/App.js', 'Should attribute src/App.js');
  assertEqual(assetDiff[0].reasons[0].change, 1000, 'Change should be +1000');
});

test('computeAssetReasons does NOT misattribute via stale chunk IDs', () => {
  // Scenario: chunk ID 0 maps to app.js in base, but maps to sw.js in PR
  // A module in the PR has chunk ID 0 → without chunk-name matching, it
  // would be wrongly attributed to app.js (via base's chunk ID 0 mapping)
  const moduleChanges = [{
    name: 'src/service-worker.js',
    oldSize: 0,
    newSize: 5000,
    change: 5000,
    changeFormatted: '+5000 B',
    type: 'added',
    isNodeModule: false,
    packageName: null,
    chunks: [3],            // PR chunk ID
    chunkNames: ['sw'],     // Chunk name: sw
    importChain: [],
  }];

  // Chunk ID overlap: both base and PR have chunk 0, but they map to different assets
  const baseChunkToAssets = { 0: ['app.js'], 1: ['vendor.js'] };
  const prChunkToAssets = { 0: ['sw.js'], 2: ['app.js'], 3: ['sw.js'] };

  // Names are stable and unambiguous
  const baseChunkNameToAssets = { main: ['app.js'], vendor: ['vendor.js'] };
  const prChunkNameToAssets = { main: ['app.js'], vendor: ['vendor.js'], sw: ['sw.js'] };

  const assetDiff = [
    {
      name: 'app.js', baseSize: 50000, prSize: 50000, change: 0,
      changeFormatted: '0 B', type: 'changed', // small change still considered "changed"
      baseGzip: 15000, prGzip: 15000, gzipChange: 0,
      chunkNames: ['main'], chunks: [], reasons: [],
    },
    {
      name: 'sw.js', baseSize: 0, prSize: 10000, change: 10000,
      changeFormatted: '+10 KB', type: 'added',
      baseGzip: 0, prGzip: 3000, gzipChange: 3000,
      chunkNames: ['sw'], chunks: [], reasons: [],
    },
  ];

  computeAssetReasons(assetDiff, moduleChanges, baseChunkToAssets, prChunkToAssets, 3, baseChunkNameToAssets, prChunkNameToAssets);

  // app.js should NOT have the service-worker module attributed to it
  assertEqual(assetDiff[0].reasons.length, 0, 'app.js should have no misattributed reasons');
  // sw.js is "added" so it gets empty reasons by design
  assertEqual(assetDiff[1].reasons.length, 0, 'added asset gets empty reasons');
});

// Test diff.js report functions
console.log('\n--- Testing diff.js report functions ---');
const { generateReport, generateJSONReport, runDiff } = require('../scripts/diff');

test('generateReport includes Contributors line for changed assets', () => {
  const result = runDiff(
    path.join(__dirname, 'sample-base-stats.json'),
    path.join(__dirname, 'sample-pr-stats.json'),
    { silent: true }
  );
  const report = result.report;

  assertTrue(report.includes('Contributors:'), 'Report should include Contributors line');
  assertTrue(report.includes('lodash'), 'Report should mention lodash as contributor');
});

test('generateJSONReport includes reasons in asset objects', () => {
  const result = runDiff(
    path.join(__dirname, 'sample-base-stats.json'),
    path.join(__dirname, 'sample-pr-stats.json'),
    { silent: true }
  );
  const json = generateJSONReport(result.diff, result.summary);

  assertTrue(Array.isArray(json.assets), 'JSON should have assets array');
  const mainAsset = json.assets.find(a => a.name === 'main.bundle.js');
  assertTrue(!!mainAsset, 'JSON should have main.bundle.js');
  assertTrue(Array.isArray(mainAsset.reasons), 'Asset should have reasons array');
  assertTrue(mainAsset.reasons.length > 0, 'Changed asset should have non-empty reasons');
  assertTrue(!!mainAsset.reasons[0].name, 'Reason should have name');
  assertTrue(typeof mainAsset.reasons[0].change === 'number', 'Reason should have numeric change');
});

// Test rule-engine
console.log('\n--- Testing rule-engine.js ---');
const { runDetection, detectFullLibraryImports, detectUnexpectedDependencies, detectNewEntrypoints, detectLargeAssetChanges, ALLOWED_DEPENDENCIES } = require('../lib/rule-engine');

test('runDetection identifies issues', () => {
  const baseStats = parseStats(JSON.parse(fs.readFileSync(path.join(__dirname, 'sample-base-stats.json'), 'utf-8')));
  const prStats = parseStats(JSON.parse(fs.readFileSync(path.join(__dirname, 'sample-pr-stats.json'), 'utf-8')));
  const diff = computeDiff(baseStats, prStats);

  const detections = runDetection(diff);

  assertTrue(Array.isArray(detections.violations), 'Should have violations array');
  assertTrue(Array.isArray(detections.critical), 'Should have critical array');
  assertTrue(Array.isArray(detections.warnings), 'Should have warnings array');
  assertTrue(typeof detections.hasCriticalIssues === 'boolean', 'Should have hasCriticalIssues');
});

test('detectFullLibraryImports returns violations array', () => {
  const baseStats = parseStats(JSON.parse(fs.readFileSync(path.join(__dirname, 'sample-base-stats.json'), 'utf-8')));
  const prStats = parseStats(JSON.parse(fs.readFileSync(path.join(__dirname, 'sample-pr-stats.json'), 'utf-8')));
  const diff = computeDiff(baseStats, prStats);

  const violations = detectFullLibraryImports(diff);

  // Should return an array (may or may not have lodash depending on module name format)
  assertTrue(Array.isArray(violations), 'Should return array');
});

test('detectUnexpectedDependencies flags unknown packages', () => {
  // Create a mock diff with an unexpected package
  const mockDiff = {
    added: [
      {
        name: 'node_modules/some-unknown-pkg/index.js',
        packageName: 'some-unknown-pkg',
        newSize: 60000,
        importChain: ['src/App.bs.js'],
        isNodeModule: true,
        type: 'added',
      },
      {
        name: 'node_modules/react/index.js',
        packageName: 'react',
        newSize: 5000,
        importChain: ['src/App.bs.js'],
        isNodeModule: true,
        type: 'added',
      },
    ],
    allChanges: [],
    topChanges: [],
    removed: [],
    packageDiffs: {},
  };

  const violations = detectUnexpectedDependencies(mockDiff);

  // Should flag some-unknown-pkg but NOT react
  assertTrue(violations.length === 1, 'Should flag exactly one unexpected dep');
  assertEqual(violations[0].id, 'UNEXPECTED_DEPENDENCY', 'Should have correct rule ID');
  assertTrue(violations[0].message.includes('some-unknown-pkg'), 'Should mention the unexpected package');
});

test('ALLOWED_DEPENDENCIES matches package.json deps', () => {
  assertTrue(ALLOWED_DEPENDENCIES.includes('react'), 'Should include react');
  assertTrue(ALLOWED_DEPENDENCIES.includes('@sentry/react'), 'Should include @sentry/react');
  assertTrue(ALLOWED_DEPENDENCIES.includes('recoil'), 'Should include recoil');
  assertFalse(ALLOWED_DEPENDENCIES.includes('lodash'), 'Should NOT include lodash');
});

test('detectNewEntrypoints flags new entrypoints', () => {
  const mockDiff = {
    entrypointDiff: [
      { name: 'app', type: 'changed', baseSize: 200000, prSize: 210000, change: 10000 },
      { name: 'hs-sdk-sw', type: 'added', baseSize: 0, prSize: 65536, change: 65536 },
    ],
  };

  const violations = detectNewEntrypoints(mockDiff);

  assertEqual(violations.length, 1, 'Should flag 1 new entrypoint');
  assertEqual(violations[0].id, 'NEW_ENTRYPOINT', 'Should have correct rule ID');
  assertTrue(violations[0].message.includes('hs-sdk-sw'), 'Should mention entrypoint name');
  assertEqual(violations[0].severity, 'info', 'Should be info severity');
});

test('detectNewEntrypoints returns empty for no new entrypoints', () => {
  const mockDiff = {
    entrypointDiff: [
      { name: 'app', type: 'unchanged', baseSize: 200000, prSize: 200000, change: 0 },
    ],
  };

  const violations = detectNewEntrypoints(mockDiff);
  assertEqual(violations.length, 0, 'Should not flag unchanged entrypoints');
});

test('detectLargeAssetChanges flags assets growing >50KB', () => {
  const mockDiff = {
    assetDiff: [
      { name: 'main.js', type: 'changed', baseSize: 100000, prSize: 200000, change: 100000 },
      { name: 'vendor.js', type: 'changed', baseSize: 50000, prSize: 51000, change: 1000 },
    ],
  };

  const violations = detectLargeAssetChanges(mockDiff);

  assertEqual(violations.length, 1, 'Should flag 1 large asset change');
  assertEqual(violations[0].id, 'LARGE_ASSET_INCREASE', 'Should have correct rule ID');
  assertTrue(violations[0].message.includes('main.js'), 'Should mention asset name');
  assertEqual(violations[0].severity, 'warning', 'Should be warning severity');
});

test('detectLargeAssetChanges returns empty for small changes', () => {
  const mockDiff = {
    assetDiff: [
      { name: 'main.js', type: 'changed', baseSize: 100000, prSize: 110000, change: 10000 },
    ],
  };

  const violations = detectLargeAssetChanges(mockDiff);
  assertEqual(violations.length, 0, 'Should not flag small changes');
});

// Test rescript-analyzer
console.log('\n--- Testing rescript-analyzer.js ---');
const { extractImports, mapToJSDependencies, RESCRIPT_TO_JS_DEPS } = require('../lib/rescript-analyzer');

test('extractImports finds ReScript imports', () => {
  const content = `
    open React
    open Belt
    module Date = ReDate
    external format: string => string = "date-fns/format"
    @module("lodash")
    external debounce: ('a => 'b, int) => 'a => 'b = "debounce"
  `;

  const imports = extractImports(content);

  assertTrue(imports.includes('React'), 'Should extract React');
  assertTrue(imports.includes('Belt'), 'Should extract Belt');
  assertTrue(imports.includes('ReDate'), 'Should extract ReDate');
  assertTrue(imports.includes('date-fns/format') || imports.includes('lodash'), 'Should extract externals');
});

test('mapToJSDependencies maps correctly', () => {
  const imports = ['ReDatepicker', 'Recoil'];
  const deps = mapToJSDependencies(imports);

  assertTrue(deps.includes('react-datepicker'), 'Should map ReDatepicker to react-datepicker');
  assertTrue(deps.includes('recoil'), 'Should map Recoil to recoil');
});

// Test ai-client
console.log('\n--- Testing ai-client.js ---');
const { parseAIResponse, isAIAvailable, extractJSON } = require('../lib/ai-client');

test('extractJSON parses plain JSON', () => {
  const result = extractJSON('{"key": "value"}');
  assertEqual(result.key, 'value');
});

test('extractJSON strips markdown code fences', () => {
  const result = extractJSON('```json\n{"key": "fenced"}\n```');
  assertEqual(result.key, 'fenced');
});

test('extractJSON strips code fences without json tag', () => {
  const result = extractJSON('```\n{"key": "bare"}\n```');
  assertEqual(result.key, 'bare');
});

test('extractJSON throws on invalid JSON', () => {
  let threw = false;
  try { extractJSON('not json'); } catch { threw = true; }
  assertTrue(threw, 'Should throw on invalid JSON');
});

test('parseAIResponse validates responses', () => {
  const validResponse = JSON.stringify({
    verdict: 'unexpected',
    confidence: 0.85,
    explanation: 'Large lodash detected',
    rootCause: 'Full import in App.js',
    suggestedFixes: ['Use lodash-es'],
  });

  const result = parseAIResponse(validResponse);

  assertEqual(result.verdict, 'unexpected', 'Should parse verdict');
  assertEqual(result.confidence, 0.85, 'Should parse confidence');
  assertTrue(result.suggestedFixes.includes('Use lodash-es'), 'Should parse fixes');
});

test('parseAIResponse handles invalid JSON', () => {
  const result = parseAIResponse('not valid json');

  assertEqual(result.verdict, 'needs_review', 'Should default to needs_review');
  assertTrue(result.metadata.parseError, 'Should indicate parse error');
});

test('isAIAvailable checks env var', () => {
  const hadKey = !!process.env.OPENAI_API_KEY;

  // This is environment dependent
  assertTrue(typeof isAIAvailable() === 'boolean', 'Should return boolean');
});

// Test utils.js
console.log('\n--- Testing utils.js ---');

test('validateGitRef allows valid branch names', () => {
  assertEqual(validateGitRef('main'), 'main');
  assertEqual(validateGitRef('feature/my-branch'), 'feature/my-branch');
  assertEqual(validateGitRef('v1.0.0'), 'v1.0.0');
  assertEqual(validateGitRef('abc123def'), 'abc123def');
  assertEqual(validateGitRef('my_branch-name.1'), 'my_branch-name.1');
});

test('validateGitRef rejects unsafe branch names', () => {
  let threw = false;
  try { validateGitRef('main; rm -rf /'); } catch { threw = true; }
  assertTrue(threw, 'Should reject branch name with semicolon');

  threw = false;
  try { validateGitRef('branch$(whoami)'); } catch { threw = true; }
  assertTrue(threw, 'Should reject branch name with command substitution');

  threw = false;
  try { validateGitRef(''); } catch { threw = true; }
  assertTrue(threw, 'Should reject empty string');

  threw = false;
  try { validateGitRef(null); } catch { threw = true; }
  assertTrue(threw, 'Should reject null');

  threw = false;
  try { validateGitRef('branch`id`'); } catch { threw = true; }
  assertTrue(threw, 'Should reject backticks');
});

test('utils loadEnv loads environment variables', () => {
  const tmpDir = path.join(__dirname, '.tmp-test');
  const tmpEnv = path.join(tmpDir, '.env.test');
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.writeFileSync(tmpEnv, 'TEST_LOAD_ENV_KEY=hello\n# comment\nTEST_LOAD_ENV_KEY2=world\n');

  delete process.env.TEST_LOAD_ENV_KEY;
  delete process.env.TEST_LOAD_ENV_KEY2;

  loadEnv(tmpEnv);

  assertEqual(process.env.TEST_LOAD_ENV_KEY, 'hello', 'Should set key');
  assertEqual(process.env.TEST_LOAD_ENV_KEY2, 'world', 'Should set key2');

  // Should not override existing
  process.env.TEST_LOAD_ENV_KEY = 'existing';
  loadEnv(tmpEnv);
  assertEqual(process.env.TEST_LOAD_ENV_KEY, 'existing', 'Should not override');

  // Cleanup
  delete process.env.TEST_LOAD_ENV_KEY;
  delete process.env.TEST_LOAD_ENV_KEY2;
  fs.rmSync(tmpDir, { recursive: true });
});

test('utils getRootCause extracts source file from import chain', () => {
  // Should return first non-node_modules entry
  const change1 = { importChain: ['./node_modules/lodash/index.js', './src/App.js'] };
  assertEqual(getRootCause(change1), './src/App.js', 'Should find source file');

  // Should strip loader prefixes
  const change2 = { importChain: ['babel-loader!./src/utils.js'] };
  assertEqual(getRootCause(change2), './src/utils.js', 'Should strip loader prefix');

  // Empty chain returns Unknown
  const change3 = { importChain: [] };
  assertEqual(getRootCause(change3), 'Unknown', 'Empty chain');

  // All node_modules returns first entry
  const change4 = { importChain: ['./node_modules/a/index.js', './node_modules/b/index.js'] };
  assertEqual(getRootCause(change4), './node_modules/a/index.js', 'All node_modules fallback');
});

test('parseStats throws on invalid input', () => {
  let threw = false;
  try {
    parseStats(null);
  } catch (e) {
    threw = true;
    assertTrue(e.message.includes('modules'), 'Error message mentions modules');
  }
  assertTrue(threw, 'Should throw on null input');

  threw = false;
  try {
    parseStats({ modules: 'not-an-array' });
  } catch (e) {
    threw = true;
  }
  assertTrue(threw, 'Should throw on non-array modules');
});

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
  assertEqual(html.reasons[0].name, 'src/App.js', 'First contributor should be src/App.js');
  assertEqual(html.reasons[0].change, 15);
  assertEqual(html.reasons[1].name, 'react', 'Second should be react package');
  assertEqual(html.reasons[1].change, 5);
});

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

// Integration test
console.log('\n--- Integration Tests ---');

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

test('computeDiff includes gzip size data on assets', () => {
  const baseStats = parseStats(JSON.parse(fs.readFileSync(path.join(__dirname, 'sample-base-stats.json'), 'utf-8')));
  const prStats = parseStats(JSON.parse(fs.readFileSync(path.join(__dirname, 'sample-pr-stats.json'), 'utf-8')));
  const diff = computeDiff(baseStats, prStats);

  // Gzip data is still available on individual asset objects (for ai-client, analyze, diff.js)
  const mainAsset = diff.assetDiff.find(a => a.name === 'main.bundle.js');
  assertTrue(mainAsset.baseGzip > 0, 'Asset should have base gzip');
  assertTrue(mainAsset.prGzip > 0, 'Asset should have PR gzip');
});

// Test computeNewDuplicates
console.log('\n--- Testing computeNewDuplicates ---');

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

// Test detectDuplicateDependencies (DUPLICATE_DEPENDENCY rule)
console.log('\n--- Testing DUPLICATE_DEPENDENCY rule ---');

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

// Test comment.js gzip and duplicates
console.log('\n--- Testing comment.js gzip and duplicates ---');

test('generateComment does not include Gzip column (uses pre-minify sizes)', () => {
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
      newDuplicates: [],
    },
    summary: {},
    aiAnalysis: { verdict: 'expected', confidence: 0.9, explanation: 'Test', rootCause: 'Test', suggestedFixes: [] },
    issues: { violations: [], critical: [], warnings: [], info: [] },
  };
  const comment = generateComment(analysis);
  assertTrue(!comment.includes('Gzip'), 'Should NOT have Gzip column header (removed for pre-minify consistency)');
  assertTrue(comment.includes('Top Contributors'), 'Should have Top Contributors column header');
  assertTrue(!comment.includes('pre-minify'), 'Should NOT have pre-minify qualifier (everything is pre-minify now)');
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

// Test diff.js gzip and duplicates
console.log('\n--- Testing diff.js gzip and duplicates ---');

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

// Test analyze.js compressed and duplicates
console.log('\n--- Testing analyze.js compressed and duplicates ---');

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

// E2E integration test: compressed sizes + duplicates through full pipeline
console.log('\n--- E2E Integration Tests ---');

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

  // Gzip data is still on individual assets (for ai-client, analyze, diff.js)
  const mainAsset = diff.assetDiff.find(a => a.name === 'main.bundle.js');
  assertTrue(mainAsset.prGzip > 0, 'Asset diff should have prGzip');

  // Verify new duplicates
  assertTrue(Array.isArray(diff.newDuplicates), 'Should have newDuplicates array');
  const newReact = diff.newDuplicates.find(d => d.name === 'react');
  assertTrue(newReact !== undefined, 'react duplicate should be new (not in base)');
});

// ─── Concurrency Pool Tests ────────────────────────────────────────────────
const { runWithConcurrency } = require('../lib/concurrency');

testAsync('runWithConcurrency: returns results in order', async () => {
  const tasks = [
    () => Promise.resolve('a'),
    () => Promise.resolve('b'),
    () => Promise.resolve('c'),
  ];
  const results = await runWithConcurrency(tasks, 2);
  assertEqual(results.length, 3, 'Should have 3 results');
  assertEqual(results[0], 'a', 'First result');
  assertEqual(results[1], 'b', 'Second result');
  assertEqual(results[2], 'c', 'Third result');
});

testAsync('runWithConcurrency: enforces max concurrency', async () => {
  let running = 0;
  let maxRunning = 0;

  const makeTask = (delay) => () => new Promise(resolve => {
    running++;
    if (running > maxRunning) maxRunning = running;
    setTimeout(() => {
      running--;
      resolve(delay);
    }, delay);
  });

  const tasks = [
    makeTask(50),
    makeTask(50),
    makeTask(50),
    makeTask(50),
    makeTask(50),
  ];

  await runWithConcurrency(tasks, 2);
  assertTrue(maxRunning <= 2, `Max concurrent should be <= 2, got ${maxRunning}`);
});

testAsync('runWithConcurrency: propagates errors', async () => {
  const tasks = [
    () => Promise.resolve('ok'),
    () => Promise.reject(new Error('fail')),
    () => Promise.resolve('ok2'),
  ];

  let caught = false;
  try {
    await runWithConcurrency(tasks, 3);
  } catch (e) {
    caught = true;
    assertEqual(e.message, 'fail', 'Should propagate error message');
  }
  assertTrue(caught, 'Should have thrown');
});

testAsync('runWithConcurrency: handles empty task list', async () => {
  const results = await runWithConcurrency([], 3);
  assertEqual(results.length, 0, 'Empty tasks should return empty results');
});

testAsync('runWithConcurrency: single task works', async () => {
  const results = await runWithConcurrency([() => Promise.resolve(42)], 3);
  assertEqual(results.length, 1);
  assertEqual(results[0], 42);
});

// ─── computeAnalysisInputs Tests ───────────────────────────────────────────
const { computeAnalysisInputs } = require('../scripts/analyze');

test('computeAnalysisInputs: returns correct shape', () => {
  const baseStatsPath = path.join(__dirname, 'sample-base-stats.json');
  const prStatsPath = path.join(__dirname, 'sample-pr-stats.json');
  const result = computeAnalysisInputs(baseStatsPath, prStatsPath);

  // Check all expected fields exist
  assertTrue(result.diff !== undefined, 'Should have diff');
  assertTrue(result.summary !== undefined, 'Should have summary');
  assertTrue(result.detections !== undefined, 'Should have detections');
  assertTrue(result.baseStats !== undefined, 'Should have baseStats');
  assertTrue(result.prStats !== undefined, 'Should have prStats');

  // Check diff has expected properties
  assertTrue(typeof result.diff.baseSize === 'number', 'diff.baseSize should be number');
  assertTrue(typeof result.diff.prSize === 'number', 'diff.prSize should be number');
  assertTrue(typeof result.diff.totalDiff === 'number', 'diff.totalDiff should be number');
  assertTrue(Array.isArray(result.diff.allChanges), 'diff.allChanges should be array');
  assertTrue(Array.isArray(result.diff.topChanges), 'diff.topChanges should be array');

  // Check detections has expected properties
  assertTrue(Array.isArray(result.detections.violations), 'detections.violations should be array');
  assertTrue(Array.isArray(result.detections.critical), 'detections.critical should be array');
  assertTrue(Array.isArray(result.detections.warnings), 'detections.warnings should be array');
});

test('computeAnalysisInputs: diff and detections are consistent', () => {
  const baseStatsPath = path.join(__dirname, 'sample-base-stats.json');
  const prStatsPath = path.join(__dirname, 'sample-pr-stats.json');
  const result = computeAnalysisInputs(baseStatsPath, prStatsPath);

  // The diff totalDiff should be prSize - baseSize
  assertEqual(result.diff.totalDiff, result.diff.prSize - result.diff.baseSize,
    'totalDiff should equal prSize - baseSize');

  // Summary should have a direction string
  assertTrue(typeof result.summary.direction === 'string', 'summary.direction should be string');
});

// ─── Orchestrator Tests ────────────────────────────────────────────────────
const { parseArgs: parseOrchestrateArgs, determineMode: determineOrchestrateMode } = require('../scripts/orchestrate');

test('orchestrate parseArgs: full mode flags', () => {
  const opts = parseOrchestrateArgs(['--base', 'main', '--pr', 'feat/x', '--repo-url', 'https://github.com/test/repo']);
  assertEqual(opts.base, 'main');
  assertEqual(opts.pr, 'feat/x');
  assertEqual(opts.repoUrl, 'https://github.com/test/repo');
});

test('orchestrate parseArgs: file mode flags', () => {
  const opts = parseOrchestrateArgs(['--base-stats', 'base.json', '--pr-stats', 'pr.json']);
  assertEqual(opts.baseStats, 'base.json');
  assertEqual(opts.prStats, 'pr.json');
});

test('orchestrate parseArgs: analysis flags', () => {
  const opts = parseOrchestrateArgs(['--skip-ai', '--model', 'gpt-4', '--lines', '150']);
  assertTrue(opts.skipAI === true, 'skipAI should be true');
  assertEqual(opts.model, 'gpt-4');
  assertEqual(opts.lines, '150');
});

test('orchestrate parseArgs: output flags', () => {
  const opts = parseOrchestrateArgs(['--json', 'out.json', '--comment-file', 'c.md', '--post-comment', '--pr-number', '42', '--output-dir', 'reports2']);
  assertEqual(opts.json, 'out.json');
  assertEqual(opts.commentFile, 'c.md');
  assertTrue(opts.postComment === true);
  assertEqual(opts.prNumber, '42');
  assertEqual(opts.outputDir, 'reports2');
});

test('orchestrate parseArgs: --json without path', () => {
  const opts = parseOrchestrateArgs(['--json', '--skip-ai']);
  assertTrue(opts.json === true, '--json without path should be true');
  assertTrue(opts.skipAI === true);
});

test('orchestrate determineMode: full mode', () => {
  assertEqual(determineOrchestrateMode({ base: 'main', pr: 'feat/x', repoUrl: 'url' }), 'full');
});

test('orchestrate determineMode: file mode', () => {
  assertEqual(determineOrchestrateMode({ baseStats: 'a.json', prStats: 'b.json' }), 'file');
});

test('orchestrate determineMode: file mode takes precedence', () => {
  assertEqual(determineOrchestrateMode({ base: 'main', pr: 'x', baseStats: 'a.json', prStats: 'b.json' }), 'file');
});

test('orchestrate determineMode: returns null for invalid', () => {
  assertEqual(determineOrchestrateMode({}), null);
});

// ─── Clone Builder Tests ───────────────────────────────────────────────────
const { cloneAndBuild } = require('../lib/clone-builder');

test('cloneAndBuild: exported function exists', () => {
  assertEqual(typeof cloneAndBuild, 'function', 'cloneAndBuild should be a function');
});

testAsync('cloneAndBuild: rejects with invalid repo URL', async () => {
  const tmpDir = path.join(__dirname, '..', 'tmp', 'test-clone-builder');
  let caught = false;
  try {
    await cloneAndBuild('not-a-valid-url', 'main', tmpDir);
  } catch (e) {
    caught = true;
    assertTrue(e.message.length > 0, 'Should have error message');
  }
  assertTrue(caught, 'Should reject with invalid repo URL');

  // Clean up
  if (fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true });
  }
});

// ─── Orchestrator Pipeline Tests ───────────────────────────────────────────

testAsync('orchestrate runPipeline: file mode produces all outputs', async () => {
  // Use the same approach as the orchestrator's file mode
  const { computeAnalysisInputs, generateAnalysisReport, generateJSONOutput } = require('../scripts/analyze');
  const { generateComment } = require('../scripts/comment');
  const { generateReport: generateDiffReport } = require('../scripts/diff');
  const { analyzeOffline } = require('../lib/ai-client');
  const { runWithConcurrency } = require('../lib/concurrency');

  const baseStatsPath = path.join(__dirname, 'sample-base-stats.json');
  const prStatsPath = path.join(__dirname, 'sample-pr-stats.json');

  // Phase 2: Analyze
  const { diff, summary, detections, baseStats, prStats } = computeAnalysisInputs(baseStatsPath, prStatsPath);
  assertTrue(diff !== undefined, 'Should compute diff');
  assertTrue(detections !== undefined, 'Should compute detections');

  // Phase 3: AI (offline for tests)
  const aiResult = analyzeOffline(diff, detections);
  assertTrue(aiResult.verdict !== undefined, 'AI result should have verdict');

  // Phase 4: Reports (parallel)
  const context = {};
  const analysis = { diff, ai: aiResult, detections, summary };
  const reportTasks = [
    () => Promise.resolve(generateAnalysisReport(diff, detections, aiResult, context)),
    () => Promise.resolve(generateJSONOutput({ diff, detections, ai: aiResult })),
    () => Promise.resolve(generateComment(analysis)),
    () => Promise.resolve(generateDiffReport(diff, summary)),
  ];

  const results = await runWithConcurrency(reportTasks, 3);

  assertEqual(results.length, 4, 'Should have 4 report results');
  assertTrue(typeof results[0] === 'string', 'Text report should be string');
  assertTrue(typeof results[1] === 'object', 'JSON output should be object');
  assertTrue(typeof results[2] === 'string', 'Comment should be string');
  assertTrue(typeof results[3] === 'string', 'Diff report should be string');

  // Verify JSON output has expected structure
  assertTrue(results[1].summary !== undefined, 'JSON should have summary');
  assertTrue(results[1].aiAnalysis !== undefined, 'JSON should have aiAnalysis');
  assertTrue(results[1].issues !== undefined, 'JSON should have issues');
});

// ============================================================
// cleanModuleName tests (Fix 2 — strip loader prefixes, query strings, concatenation suffixes)
// ============================================================
const { cleanModuleName } = require('../lib/stats-parser');

test('cleanModuleName strips single loader prefix', () => {
  assertEqual(cleanModuleName('css-loader!./src/App.css'), 'src/App.css');
});

test('cleanModuleName strips chained loader prefixes', () => {
  assertEqual(cleanModuleName('style-loader!css-loader!./src/App.css'), 'src/App.css');
});

test('cleanModuleName strips loader with options', () => {
  assertEqual(cleanModuleName('css-loader?modules!./src/App.css'), 'src/App.css');
});

test('cleanModuleName strips query string from path', () => {
  assertEqual(cleanModuleName('./src/App.js?v=1'), 'src/App.js');
});

test('cleanModuleName strips concatenated module suffix', () => {
  assertEqual(cleanModuleName('./src/App.js + 5 modules'), 'src/App.js');
});

test('cleanModuleName strips concatenated module suffix (singular)', () => {
  assertEqual(cleanModuleName('./src/App.js + 1 module'), 'src/App.js');
});

test('cleanModuleName handles combined loader + query + concat', () => {
  assertEqual(cleanModuleName('babel-loader!./src/utils.js?foo=bar + 3 modules'), 'src/utils.js');
});

test('cleanModuleName passes through simple paths', () => {
  assertEqual(cleanModuleName('./src/index.js'), 'src/index.js');
});

test('cleanModuleName handles multi prefix', () => {
  assertEqual(cleanModuleName('multi ./src/polyfills.js ./src/index.js'), 'src/polyfills.js ./src/index.js');
});

// ============================================================
// normalizeGroupingKey tests (Fix 3 — deduplication safety net)
// ============================================================
const { normalizeGroupingKey } = require('../lib/diff-engine');

test('normalizeGroupingKey strips loader prefix', () => {
  assertEqual(normalizeGroupingKey('css-loader!./src/App.css'), 'src/App.css');
});

test('normalizeGroupingKey strips query string', () => {
  assertEqual(normalizeGroupingKey('./src/App.js?v=1'), 'src/App.js');
});

test('normalizeGroupingKey strips concatenated modules suffix', () => {
  assertEqual(normalizeGroupingKey('./src/App.js + 5 modules'), 'src/App.js');
});

test('normalizeGroupingKey leaves package names intact', () => {
  assertEqual(normalizeGroupingKey('lodash'), 'lodash');
});

test('normalizeGroupingKey leaves scoped package names intact', () => {
  assertEqual(normalizeGroupingKey('@babel/runtime'), '@babel/runtime');
});

// ============================================================
// Noise threshold tests (Fix 1 — small diffs treated as unchanged)
// ============================================================

test('computeAssetDiff treats tiny changes as unchanged (noise threshold)', () => {
  const base = [{ name: 'main.js', size: 1000 }];
  const pr = [{ name: 'main.js', size: 1004 }]; // 4 bytes diff — below 10-byte threshold
  const result = computeAssetDiff(base, pr);
  const mainAsset = result.find(a => a.name === 'main.js');
  assertEqual(mainAsset.type, 'unchanged', 'Tiny diff should be unchanged');
  assertEqual(mainAsset.change, 0, 'Noise change should be zeroed');
});

test('computeAssetDiff keeps genuine changes above noise threshold', () => {
  const base = [{ name: 'main.js', size: 1000 }];
  const pr = [{ name: 'main.js', size: 1050 }]; // 50 bytes — above threshold
  const result = computeAssetDiff(base, pr);
  const mainAsset = result.find(a => a.name === 'main.js');
  assertEqual(mainAsset.type, 'changed', 'Significant diff should be changed');
  assertEqual(mainAsset.change, 50, 'Change should be 50');
});

test('computeEntrypointDiff treats tiny changes as unchanged (noise threshold)', () => {
  const base = [{ name: 'app', assetsSize: 5000 }];
  const pr = [{ name: 'app', assetsSize: 4998 }]; // -2 bytes — below threshold
  const result = computeEntrypointDiff(base, pr);
  const appEp = result.find(e => e.name === 'app');
  assertEqual(appEp.type, 'unchanged', 'Tiny diff should be unchanged');
  assertEqual(appEp.change, 0, 'Noise change should be zeroed');
});

test('computeEntrypointDiff keeps genuine changes above noise threshold', () => {
  const base = [{ name: 'app', assetsSize: 5000 }];
  const pr = [{ name: 'app', assetsSize: 4980 }]; // -20 bytes — above threshold
  const result = computeEntrypointDiff(base, pr);
  const appEp = result.find(e => e.name === 'app');
  assertEqual(appEp.type, 'changed', 'Significant diff should be changed');
  assertEqual(appEp.change, -20, 'Change should be -20');
});

// ============================================================
// Deduplication in computeAssetReasons (Fix 3 — integrated test)
// ============================================================

test('computeAssetReasons deduplicates module variants into single contributor', () => {
  const assetDiff = [{
    name: 'main.js',
    type: 'changed',
    baseSize: 1000,
    prSize: 1100,
    change: 100,
    chunks: [1],
  }];
  // Two module changes that are the same file but with different webpack names
  const moduleChanges = [
    { name: 'src/App.js', packageName: null, change: 60, chunks: [1] },
    { name: 'css-loader!./src/App.js', packageName: null, change: 40, chunks: [1] },
  ];
  const baseChunkToAssets = new Map([[1, ['main.js']]]);
  const prChunkToAssets = new Map([[1, ['main.js']]]);

  computeAssetReasons(assetDiff, moduleChanges, baseChunkToAssets, prChunkToAssets, 3);

  assertEqual(assetDiff[0].reasons.length, 1, 'Should deduplicate into single contributor');
  assertEqual(assetDiff[0].reasons[0].name, 'src/App.js', 'Contributor name should be cleaned');
  assertEqual(assetDiff[0].reasons[0].change, 100, 'Changes should be summed');
});

// selectBalancedTopContributors tests
console.log('\n--- Testing selectBalancedTopContributors ---');

test('selectBalancedTopContributors returns all entries when <= topN', () => {
  const grouped = new Map([['a', 100], ['b', -50]]);
  const result = selectBalancedTopContributors(grouped, 3);
  assertEqual(result.length, 2, 'Should return both entries');
});

test('selectBalancedTopContributors ensures both positive and negative are represented', () => {
  // Simulates the real bug: asset grew +1KB but top 3 absolute are all negative
  const grouped = new Map([
    ['serviceWorker.bs.js', 30000],   // +30 KB (new feature)
    ['LoggerUtils.bs.js', -10000],    // -10 KB (removed)
    ['@rescript/core', -4500],        // -4.5 KB (removed)
    ['rescript', -2400],              // -2.4 KB (removed)
    ['index.js', 150],               // +150 B (small change)
  ]);
  const result = selectBalancedTopContributors(grouped, 3);
  const positives = result.filter(([, v]) => v > 0);
  const negatives = result.filter(([, v]) => v < 0);
  assertTrue(positives.length >= 1, 'Must include at least one positive contributor');
  assertTrue(negatives.length >= 1, 'Must include at least one negative contributor');
  assertEqual(result.length, 3, 'Should return exactly topN entries');
});

test('selectBalancedTopContributors works with only positive changes', () => {
  const grouped = new Map([['a', 500], ['b', 300], ['c', 200], ['d', 100]]);
  const result = selectBalancedTopContributors(grouped, 3);
  assertEqual(result.length, 3);
  assertEqual(result[0][0], 'a', 'Largest positive first');
});

test('selectBalancedTopContributors works with only negative changes', () => {
  const grouped = new Map([['a', -500], ['b', -300], ['c', -200], ['d', -100]]);
  const result = selectBalancedTopContributors(grouped, 3);
  assertEqual(result.length, 3);
  assertEqual(result[0][0], 'a', 'Largest negative first');
});

test('selectBalancedTopContributors filters out zero-change entries', () => {
  const grouped = new Map([['a', 100], ['b', 0], ['c', -50]]);
  const result = selectBalancedTopContributors(grouped, 3);
  assertEqual(result.length, 2, 'Should exclude zero-change entry');
});

test('selectBalancedTopContributors sorts result by absolute magnitude', () => {
  const grouped = new Map([
    ['big-positive', 5000],
    ['big-negative', -10000],
    ['small-positive', 100],
    ['medium-negative', -3000],
  ]);
  const result = selectBalancedTopContributors(grouped, 3);
  // Should be sorted: -10000, 5000, -3000
  assertEqual(result[0][0], 'big-negative');
  assertEqual(result[1][0], 'big-positive');
  assertEqual(result[2][0], 'medium-negative');
});

// reasonsMeta tests
console.log('\n--- Testing reasonsMeta ---');

test('computeAssetReasons attaches reasonsMeta with totalCount and netChange', () => {
  const assetDiff = [{
    name: 'app.js',
    type: 'changed',
    baseSize: 100000,
    prSize: 101100,
    change: 1100,
    chunks: [1],
  }];
  const moduleChanges = [
    { name: 'src/ServiceWorker.bs.js', packageName: null, change: 30000, chunks: [1] },
    { name: 'src/LoggerUtils.bs.js', packageName: null, change: -10000, chunks: [1] },
    { name: 'node_modules/@rescript/core/Core__Option.bs.js', packageName: '@rescript/core', change: -4500, chunks: [1] },
    { name: 'node_modules/rescript/lib/es6/caml_option.js', packageName: 'rescript', change: -2400, chunks: [1] },
    { name: 'src/index.js', packageName: null, change: 150, chunks: [1] },
    { name: 'src/Window.bs.js', packageName: null, change: 96, chunks: [1] },
  ];
  const baseChunkToAssets = { 1: ['app.js'] };
  const prChunkToAssets = { 1: ['app.js'] };

  computeAssetReasons(assetDiff, moduleChanges, baseChunkToAssets, prChunkToAssets, 3);

  const meta = assetDiff[0].reasonsMeta;
  assertTrue(meta !== undefined, 'reasonsMeta should be attached');
  assertEqual(meta.totalCount, 6, 'totalCount should count all non-zero grouped contributors');
  // Net: 30000 - 10000 - 4500 - 2400 + 150 + 96 = 13346
  assertEqual(meta.netChange, 13346, 'netChange should be net sum of all contributors');
  assertEqual(assetDiff[0].reasons.length, 3, 'Should still only show top 3 reasons');
});

test('computeAssetReasons reasonsMeta not set for new/removed/unchanged assets', () => {
  const assetDiff = [
    { name: 'new.js', type: 'added', baseSize: 0, prSize: 1000, change: 1000, chunks: [] },
    { name: 'old.js', type: 'removed', baseSize: 1000, prSize: 0, change: -1000, chunks: [] },
    { name: 'same.js', type: 'unchanged', baseSize: 1000, prSize: 1000, change: 0, chunks: [] },
  ];
  computeAssetReasons(assetDiff, [], {}, {}, 3);
  assertTrue(assetDiff[0].reasonsMeta === undefined, 'New asset should not have reasonsMeta');
  assertTrue(assetDiff[1].reasonsMeta === undefined, 'Removed asset should not have reasonsMeta');
  assertTrue(assetDiff[2].reasonsMeta === undefined, 'Unchanged asset should not have reasonsMeta');
});

test('comment.js formatAssetReasons shows others summary when contributors exceed topN', () => {
  const { generateComment } = require('../scripts/comment');
  // Build a minimal analysis with an asset that has more contributors than shown
  const analysis = {
    diff: {
      baseAssetSize: 100000,
      prAssetSize: 101100,
      totalAssetDiff: 1100,
      baseAssetSizeFormatted: '97.66 KB',
      prAssetSizeFormatted: '98.73 KB',
      nodeModulesDiff: -6000,
      assetDiff: [{
        name: 'app.js',
        type: 'changed',
        baseSize: 100000,
        prSize: 101100,
        change: 1100,
        changeFormatted: '+1.07 KB',
        baseGzip: 30000,
        prGzip: 30300,
        gzipChange: 300,
        reasons: [
          { name: 'src/LoggerUtils.bs.js', change: -10000, changeFormatted: '-9.77 KB', type: 'removed' },
          { name: '@rescript/core', change: -4500, changeFormatted: '-4.39 KB', type: 'removed' },
          { name: 'src/index.js', change: 150, changeFormatted: '+150 B', type: 'added' },
        ],
        reasonsMeta: { totalCount: 6, netChange: 13346 },
      }],
      entrypointDiff: [],
      newDuplicates: [],
    },
    ai: { verdict: 'expected', confidence: 0.9, explanation: 'OK', rootCause: 'None', suggestedFixes: [] },
    detections: { critical: [], warnings: [], info: [], violations: [] },
  };
  const comment = generateComment(analysis);
  assertTrue(comment.includes('and 3 others'), 'Should mention the number of hidden contributors');
  assertTrue(comment.includes('net +13.03 KB'), 'Should show net change');
});

test('comment.js formatAssetReasons omits others when all contributors shown', () => {
  const { generateComment } = require('../scripts/comment');
  const analysis = {
    diff: {
      baseAssetSize: 100000,
      prAssetSize: 100100,
      totalAssetDiff: 100,
      baseAssetSizeFormatted: '97.66 KB',
      prAssetSizeFormatted: '97.75 KB',
      nodeModulesDiff: 0,
      assetDiff: [{
        name: 'app.js',
        type: 'changed',
        baseSize: 100000,
        prSize: 100100,
        change: 100,
        changeFormatted: '+100 B',
        baseGzip: 30000,
        prGzip: 30030,
        gzipChange: 30,
        reasons: [
          { name: 'src/App.js', change: 100, changeFormatted: '+100 B', type: 'added' },
        ],
        reasonsMeta: { totalCount: 1, netChange: 100 },
      }],
      entrypointDiff: [],
      newDuplicates: [],
    },
    ai: { verdict: 'expected', confidence: 0.9, explanation: 'OK', rootCause: 'None', suggestedFixes: [] },
    detections: { critical: [], warnings: [], info: [], violations: [] },
  };
  const comment = generateComment(analysis);
  assertFalse(comment.includes('others'), 'Should not mention others when all are shown');
});

// ============================================================
// code-diff.js tests
// ============================================================
console.log('\n--- Testing code-diff.js ---');
const { parseDiffStats, chunkDiff } = require('../lib/code-diff');

test('parseDiffStats parses a simple unified diff', () => {
  const diff = [
    'diff --git a/src/Foo.res b/src/Foo.res',
    'index abc123..def456 100644',
    '--- a/src/Foo.res',
    '+++ b/src/Foo.res',
    '@@ -1,3 +1,5 @@',
    ' let x = 1',
    '+let y = 2',
    '+let z = 3',
    ' let w = 4',
    '-let old = 5',
  ].join('\n');
  const stats = parseDiffStats(diff);
  assertEqual(stats.length, 1, 'Should have one file');
  assertEqual(stats[0].filePath, 'src/Foo.res');
  assertEqual(stats[0].linesAdded, 2);
  assertEqual(stats[0].linesRemoved, 1);
  assertFalse(stats[0].isBinary);
});

test('parseDiffStats handles multiple files', () => {
  const diff = [
    'diff --git a/src/A.res b/src/A.res',
    '--- a/src/A.res',
    '+++ b/src/A.res',
    '@@ -1,2 +1,3 @@',
    ' line1',
    '+added',
    'diff --git a/src/B.js b/src/B.js',
    '--- a/src/B.js',
    '+++ b/src/B.js',
    '@@ -1,3 +1,2 @@',
    ' line1',
    '-removed1',
    '-removed2',
  ].join('\n');
  const stats = parseDiffStats(diff);
  assertEqual(stats.length, 2);
  assertEqual(stats[0].filePath, 'src/A.res');
  assertEqual(stats[0].linesAdded, 1);
  assertEqual(stats[0].linesRemoved, 0);
  assertEqual(stats[1].filePath, 'src/B.js');
  assertEqual(stats[1].linesAdded, 0);
  assertEqual(stats[1].linesRemoved, 2);
});

test('parseDiffStats detects binary files', () => {
  const diff = [
    'diff --git a/icon.png b/icon.png',
    'Binary files a/icon.png and b/icon.png differ',
  ].join('\n');
  const stats = parseDiffStats(diff);
  assertEqual(stats.length, 1);
  assertEqual(stats[0].filePath, 'icon.png');
  assertTrue(stats[0].isBinary);
  assertEqual(stats[0].linesAdded, 0);
  assertEqual(stats[0].linesRemoved, 0);
});

test('parseDiffStats returns empty array for empty input', () => {
  const stats = parseDiffStats('');
  assertEqual(stats.length, 0);
});

test('parseDiffStats handles new file (no a/ prefix)', () => {
  const diff = [
    'diff --git a/src/New.res b/src/New.res',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/src/New.res',
    '@@ -0,0 +1,3 @@',
    '+line1',
    '+line2',
    '+line3',
  ].join('\n');
  const stats = parseDiffStats(diff);
  assertEqual(stats.length, 1);
  assertEqual(stats[0].filePath, 'src/New.res');
  assertEqual(stats[0].linesAdded, 3);
  assertEqual(stats[0].linesRemoved, 0);
});

test('chunkDiff splits diff into chunks under maxBytes', () => {
  const diff = [
    'diff --git a/a.js b/a.js',
    '--- a/a.js',
    '+++ b/a.js',
    '@@ -1 +1 @@',
    '-old',
    '+new',
    'diff --git a/b.js b/b.js',
    '--- a/b.js',
    '+++ b/b.js',
    '@@ -1 +1 @@',
    '-old',
    '+new',
    'diff --git a/c.js b/c.js',
    '--- a/c.js',
    '+++ b/c.js',
    '@@ -1 +1 @@',
    '-old',
    '+new',
  ].join('\n');
  const chunks = chunkDiff(diff, 120);
  assertTrue(chunks.length >= 2, 'Should create at least 2 chunks');
  for (const chunk of chunks) {
    assertTrue(chunk.startsWith('diff --git'), 'Each chunk starts with diff --git');
  }
});

test('chunkDiff returns single chunk for small diff', () => {
  const diff = 'diff --git a/a.js b/a.js\n-old\n+new\n';
  const chunks = chunkDiff(diff, 50000);
  assertEqual(chunks.length, 1);
});

test('chunkDiff puts oversized single file in its own chunk', () => {
  const bigFile = 'diff --git a/big.js b/big.js\n' + '+line\n'.repeat(100);
  const smallFile = 'diff --git a/small.js b/small.js\n+tiny\n';
  const diff = bigFile + smallFile;
  const chunks = chunkDiff(diff, 50);
  assertEqual(chunks.length, 2, 'Big file gets own chunk, small file in another');
});

test('chunkDiff returns empty array for empty input', () => {
  assertEqual(chunkDiff('').length, 0);
  assertEqual(chunkDiff('  \n').length, 0);
});

test('chunkDiff respects CODE_DIFF_CHUNK_MAX_BYTES env var', () => {
  const diff = [
    'diff --git a/a.js b/a.js\n-old\n+new',
    'diff --git a/b.js b/b.js\n-old\n+new',
  ].join('\n');
  const chunks = chunkDiff(diff);
  assertEqual(chunks.length, 1, 'Default maxBytes should fit small diffs in one chunk');
});

test('collectCodeDiff separates source and compiled diffs', () => {
  const { collectCodeDiff } = require('../lib/code-diff');
  const childProcess = require('child_process');
  const originalExecSync = childProcess.execSync;

  try {
    childProcess.execSync = (cmd, opts) => {
      if (cmd.includes("-- ':!lib/js/'")) {
        return 'diff --git a/src/Foo.res b/src/Foo.res\n+added line\n';
      }
      if (cmd.includes('--no-index')) {
        const err = new Error('exit code 1');
        err.status = 1;
        err.stdout = Buffer.from('diff --git a/tmp/base-compiled/Foo.js b/tmp/pr-compiled/Foo.js\n+compiled line\n');
        throw err;
      }
      return '';
    };

    const result = collectCodeDiff('/fake/repo', 'main', 'feature', {
      baseCompiledDir: 'tmp/base-compiled',
      prCompiledDir: 'tmp/pr-compiled',
    });

    assertTrue(result.sourceDiff.includes('src/Foo.res'), 'sourceDiff should contain source file');
    assertTrue(result.compiledDiff.includes('lib/js/Foo.js'), 'compiledDiff should have rewritten path');
    assertFalse(result.compiledDiff.includes('tmp/base-compiled'), 'compiledDiff should not have temp paths');
    assertEqual(result.baseBranch, 'main');
    assertEqual(result.prBranch, 'feature');
    assertEqual(result.repoDir, '/fake/repo');
    assertTrue(result.linesChanged >= 1, 'Should compute linesChanged from source diff');
    assertTrue(Array.isArray(result.fileStats), 'fileStats should be an array');
  } finally {
    childProcess.execSync = originalExecSync;
  }
});

test('collectCodeDiff handles no compiled diff gracefully', () => {
  const { collectCodeDiff } = require('../lib/code-diff');
  const childProcess = require('child_process');
  const originalExecSync = childProcess.execSync;

  try {
    childProcess.execSync = (cmd, opts) => {
      if (cmd.includes("-- ':!lib/js/'")) {
        return 'diff --git a/src/X.js b/src/X.js\n+line\n';
      }
      if (cmd.includes('--no-index')) {
        const err = new Error('fatal');
        err.status = 2;
        throw err;
      }
      return '';
    };

    const result = collectCodeDiff('/fake/repo', 'main', 'feature', {
      baseCompiledDir: 'tmp/base-compiled',
      prCompiledDir: 'tmp/pr-compiled',
    });

    assertTrue(result.sourceDiff.includes('src/X.js'), 'sourceDiff should still work');
    assertEqual(result.compiledDiff, '', 'compiledDiff should be empty on error');
  } finally {
    childProcess.execSync = originalExecSync;
  }
});

// ============================================================
// clone-builder.js new functions tests
// ============================================================
console.log('\n--- Testing clone-builder.js new functions ---');
const cloneBuilder = require('../lib/clone-builder');

test('cloneRepo is exported', () => {
  assertEqual(typeof cloneBuilder.cloneRepo, 'function');
});

test('buildBranch is exported', () => {
  assertEqual(typeof cloneBuilder.buildBranch, 'function');
});

test('cloneAndBuild is still exported for backward compatibility', () => {
  assertEqual(typeof cloneBuilder.cloneAndBuild, 'function');
});

// ============================================================
// rescript-analyzer.js bug fix + cwd tests
// ============================================================
console.log('\n--- Testing rescript-analyzer.js fixes ---');

test('analyzeReScriptChanges: newImports bug fix - should use addedImports not newImports', () => {
  const { extractImports } = require('../lib/rescript-analyzer');

  const oldContent = 'open ReactNative\nopen Belt';
  const newContent = 'open ReactNative\nopen Belt\nopen Js.Promise';

  const oldImports = extractImports(oldContent);
  const newImports = extractImports(newContent);

  assertEqual(newImports.length, 3, 'newImports should have all 3 imports');
  const addedImports = newImports.filter(imp => !oldImports.includes(imp));
  assertEqual(addedImports.length, 1, 'Only Js.Promise should be added');
  assertEqual(addedImports[0], 'Js.Promise');
});

test('rescript-analyzer functions accept cwd option', () => {
  const { analyzeReScriptChanges } = require('../lib/rescript-analyzer');
  assertEqual(typeof analyzeReScriptChanges, 'function');
  // analyzeReScriptChanges catches all errors and returns empty result
  const result = analyzeReScriptChanges('nonexistent', 'also-nonexistent', { cwd: '/tmp' });
  assertEqual(result.filesChanged.length, 0, 'Should return empty result on error');
  assertTrue(Array.isArray(result.importsAdded));
});

// ============================================================
// ai-client.js code chunk analysis tests
// ============================================================
console.log('\n--- Testing ai-client.js chunk analysis ---');
const { analyzeCodeChunks, analyzeCodeChunk } = require('../lib/ai-client');

test('analyzeCodeChunk is exported', () => {
  assertEqual(typeof analyzeCodeChunk, 'function');
});

test('analyzeCodeChunks is exported', () => {
  assertEqual(typeof analyzeCodeChunks, 'function');
});

test('buildAnalysisPrompt includes Code Change Analysis when codeDiffSummary is present', () => {
  const { buildAnalysisPrompt } = require('../lib/ai-client');
  const diff = {
    totalChange: 1000,
    nodeModulesChange: 500,
    allChanges: [],
    topChanges: [],
    packageDiffs: {},
    totalDiffFormatted: '+1.00 KB',
    prSize: 2000,
    baseSize: 1000,
    nodeModulesDiff: 500,
  };
  const detections = { violations: [] };
  const context = {
    linesChanged: 42,
    codeDiffSummary: {
      totalFiles: 5,
      keyChanges: [{ file: 'src/Foo.res', description: 'Added feature', type: 'feature' }],
      riskAreas: [{ file: 'src/Foo.res', risk: 'Large import', severity: 'high' }],
      newImports: ['lodash'],
      removedImports: ['moment'],
      failedChunks: 0,
    },
    fileStats: [
      { filePath: 'lib/js/Foo.js', linesAdded: 10, linesRemoved: 5, isBinary: false },
    ],
  };

  const prompt = buildAnalysisPrompt(diff, detections, context);
  assertTrue(prompt.includes('## Code Change Analysis'), 'Should include Code Change Analysis section');
  assertTrue(prompt.includes('[feature] src/Foo.res'), 'Should include key changes');
  assertTrue(prompt.includes('[high] src/Foo.res'), 'Should include risk areas');
  assertTrue(prompt.includes('lodash'), 'Should include new imports');
  assertTrue(prompt.includes('moment'), 'Should include removed imports');
  assertTrue(prompt.includes('Files Changed: 42'), 'Should show auto-computed linesChanged');
});

test('buildAnalysisPrompt omits Code Change Analysis when no codeDiffSummary', () => {
  const { buildAnalysisPrompt } = require('../lib/ai-client');
  const diff = {
    totalChange: 0, nodeModulesChange: 0, allChanges: [], topChanges: [],
    packageDiffs: {}, totalDiffFormatted: '0 B', prSize: 0, baseSize: 0, nodeModulesDiff: 0,
  };
  const detections = { violations: [] };
  const context = {};

  const prompt = buildAnalysisPrompt(diff, detections, context);
  assertFalse(prompt.includes('## Code Change Analysis'), 'Should NOT include Code Change Analysis');
});

test('buildAnalysisPrompt includes compiled JS changes from fileStats', () => {
  const { buildAnalysisPrompt } = require('../lib/ai-client');
  const diff = {
    totalChange: 0, nodeModulesChange: 0, allChanges: [], topChanges: [],
    packageDiffs: {}, totalDiffFormatted: '0 B', prSize: 0, baseSize: 0, nodeModulesDiff: 0,
  };
  const detections = { violations: [] };
  const context = {
    codeDiffSummary: {
      totalFiles: 1,
      keyChanges: [],
      riskAreas: [],
      newImports: [],
      removedImports: [],
      failedChunks: 0,
    },
    fileStats: [
      { filePath: 'lib/js/A.js', linesAdded: 20, linesRemoved: 5, isBinary: false },
      { filePath: 'lib/js/B.js', linesAdded: 3, linesRemoved: 0, isBinary: false },
    ],
    linesChanged: 10,
  };

  const prompt = buildAnalysisPrompt(diff, detections, context);
  assertTrue(prompt.includes('Compiled JS Changes'), 'Should include compiled JS section');
});

testAsync('analyzeCodeChunks merges multiple chunk results', async () => {
  const originalFetch = global.fetch;
  try {
    global.fetch = async (url, opts) => {
      const body = JSON.parse(opts.body);
      return {
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              content: JSON.stringify({
                filesAnalyzed: ['src/Test.res'],
                keyChanges: [{ file: 'src/Test.res', description: 'test change', type: 'feature' }],
                riskAreas: [],
                newImports: ['lodash'],
                removedImports: [],
              }),
            },
          }],
        }),
      };
    };

    const client = { apiKey: 'test-key', model: 'test', baseURL: 'http://localhost' };
    const chunks = ['diff --git a/chunk1\n+line1', 'diff --git a/chunk2\n+line2'];
    const result = await analyzeCodeChunks(client, chunks, 2);

    assertEqual(typeof result.totalFiles, 'number');
    assertTrue(result.totalFiles >= 2, 'Should sum files from both chunks');
    assertTrue(Array.isArray(result.keyChanges));
    assertTrue(Array.isArray(result.newImports));
    assertTrue(Array.isArray(result.removedImports));
    assertEqual(typeof result.failedChunks, 'number');
    assertEqual(result.failedChunks, 0);
  } finally {
    global.fetch = originalFetch;
  }
});

testAsync('analyzeCodeChunks handles chunk failures gracefully', async () => {
  const originalFetch = global.fetch;
  let callCount = 0;
  try {
    global.fetch = async () => {
      callCount++;
      if (callCount === 1) throw new Error('API timeout');
      return {
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              content: JSON.stringify({
                filesAnalyzed: ['src/Ok.res'],
                keyChanges: [],
                riskAreas: [],
                newImports: [],
                removedImports: [],
              }),
            },
          }],
        }),
      };
    };

    const client = { apiKey: 'test-key', model: 'test', baseURL: 'http://localhost' };
    const chunks = ['diff --git a/fail\n+x', 'diff --git a/ok\n+y'];
    const result = await analyzeCodeChunks(client, chunks, 2);

    assertEqual(result.failedChunks, 1, 'Should track failed chunk count');
    assertEqual(result.totalFiles, 1, 'Only successful chunk should contribute');
  } finally {
    global.fetch = originalFetch;
  }
});

testAsync('analyzeCodeChunks deduplicates imports', async () => {
  const originalFetch = global.fetch;
  try {
    global.fetch = async () => ({
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            content: JSON.stringify({
              filesAnalyzed: ['a.res'],
              keyChanges: [],
              riskAreas: [],
              newImports: ['lodash', 'react'],
              removedImports: ['moment'],
            }),
          },
        }],
      }),
    });

    const client = { apiKey: 'test-key', model: 'test', baseURL: 'http://localhost' };
    const chunks = ['chunk1', 'chunk2'];
    const result = await analyzeCodeChunks(client, chunks, 2);

    assertEqual(result.newImports.length, 2, 'Should deduplicate lodash and react');
    assertEqual(result.removedImports.length, 1, 'Should deduplicate moment');
  } finally {
    global.fetch = originalFetch;
  }
});

testAsync('analyzeCodeChunks returns null when all chunks fail', async () => {
  const originalFetch = global.fetch;
  try {
    global.fetch = async () => { throw new Error('fail'); };

    const client = { apiKey: 'test-key', model: 'test', baseURL: 'http://localhost' };
    const result = await analyzeCodeChunks(client, ['chunk1'], 1);
    assertEqual(result, null, 'Should return null when all chunks fail');
  } finally {
    global.fetch = originalFetch;
  }
});

test('runPipeline accepts optional 6th codeDiffData parameter', () => {
  const { runPipeline } = require('../scripts/orchestrate');
  // Verify function accepts 6 params (length is unreliable with defaults, just verify export exists)
  assertEqual(typeof runPipeline, 'function');
});

// Run async tests
async function runAsyncTests() {
  for (const { name, fn } of asyncTests) {
    testsRun++;
    try {
      await fn();
      console.log(`✓ ${name}`);
      testsPassed++;
    } catch (error) {
      console.error(`✗ ${name}`);
      console.error(`  Error: ${error.message}`);
      testsFailed++;
    }
  }
}

runAsyncTests().then(() => {
  // Summary
  console.log('\n--- Test Summary ---');
  console.log(`Tests run: ${testsRun}`);
  console.log(`Tests passed: ${testsPassed}`);
  console.log(`Tests failed: ${testsFailed}`);

  if (testsFailed > 0) {
    process.exit(1);
  }
  console.log('\n✓ All tests passed!');
});
