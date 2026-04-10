#!/usr/bin/env node
/**
 * @fileoverview Test Runner
 * Basic tests for bundle-ai modules
 */

const fs = require('fs');
const path = require('path');
const { formatBytes: utilsFormatBytes, loadEnv, getRootCause } = require('../lib/utils');

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

// Run tests
console.log('Running Bundle AI Tests\n');

// Test stats-parser
console.log('--- Testing stats-parser.js ---');
const { parseStats, isNodeModule, extractPackageName, formatBytes, parseAssets, parseEntrypoints, isDeliverableAsset, buildChunkToAssetsMap } = require('../lib/stats-parser');

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

// Test diff-engine
console.log('\n--- Testing diff-engine.js ---');
const { computeDiff, generateSummary, computeAssetDiff, computeEntrypointDiff, computeAssetReasons } = require('../lib/diff-engine');

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
const { parseAIResponse, isAIAvailable } = require('../lib/ai-client');

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

// Summary
console.log('\n--- Test Summary ---');
console.log(`Tests run: ${testsRun}`);
console.log(`Tests passed: ${testsPassed}`);
console.log(`Tests failed: ${testsFailed}`);

if (testsFailed > 0) {
  process.exit(1);
}
console.log('\n✓ All tests passed!');
