# Code Quality Cleanup Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consolidate duplicated code into shared utilities, remove dead code, and add missing error handling across the bundle-ai codebase.

**Architecture:** Create a new `lib/utils.js` module that exports `formatBytes`, `loadEnv`, and `getRootCause`. Update all 9 consumer files to import from this single source. Remove 5 dead code items. Add API timeout, CLI arg validation, and stats JSON validation.

**Tech Stack:** Node.js (zero dependencies), custom test runner

---

## Chunk 1: Shared Utilities + Dead Code Removal

### Task 1: Create `lib/utils.js` with `formatBytes`

**Files:**
- Create: `lib/utils.js`
- Test: `test/test-runner.js`

- [ ] **Step 1: Write failing tests for `formatBytes` in utils.js**

Add to `test/test-runner.js` after the existing imports (line ~8). Replace the existing `formatBytes` import from stats-parser with one from utils, and add new test cases:

```js
// At top of file, replace:
//   const { ..., formatBytes } = require('../lib/stats-parser');
// with:
//   const { formatBytes, loadEnv, getRootCause } = require('../lib/utils');
// Keep all other stats-parser imports intact.

// Replace existing test at line 77-82 with:
test('utils formatBytes formats correctly', () => {
  assertEqual(formatBytes(0), '0 B', 'Zero bytes');
  assertEqual(formatBytes(1024), '1 KB', '1 kilobyte');
  assertEqual(formatBytes(1024 * 1024), '1 MB', '1 megabyte');
  assertTrue(formatBytes(1536).includes('1.5'), '1.5 KB');
});

test('utils formatBytes signed option', () => {
  assertTrue(formatBytes(1024, { signed: true }).startsWith('+'), 'Positive signed');
  assertTrue(formatBytes(-1024, { signed: true }).startsWith('-'), 'Negative signed');
  assertTrue(!formatBytes(1024).startsWith('+'), 'Unsigned by default');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node test/test-runner.js`
Expected: FAIL — `Cannot find module '../lib/utils'`

- [ ] **Step 3: Create `lib/utils.js` with `formatBytes`**

```js
/**
 * @fileoverview Shared utilities for bundle-ai
 */

const fs = require('fs');

/**
 * Format byte count to human-readable string.
 * @param {number} bytes
 * @param {{ signed?: boolean }} options
 * @returns {string}
 */
function formatBytes(bytes, { signed = false } = {}) {
  if (bytes === 0) return '0 B';

  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const absBytes = Math.abs(bytes);
  const i = Math.floor(Math.log(absBytes) / Math.log(k));
  const value = parseFloat((absBytes / Math.pow(k, i)).toFixed(2));

  if (signed) {
    const sign = bytes >= 0 ? '+' : '-';
    return `${sign}${value} ${sizes[i]}`;
  }

  return `${value} ${sizes[i]}`;
}

module.exports = {
  formatBytes,
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node test/test-runner.js`
Expected: All tests pass including the new `formatBytes` tests

- [ ] **Step 5: Commit**

```bash
git add lib/utils.js test/test-runner.js
git commit -m "feat: create lib/utils.js with unified formatBytes"
```

---

### Task 2: Add `loadEnv` to `lib/utils.js`

**Files:**
- Modify: `lib/utils.js`
- Test: `test/test-runner.js`

- [ ] **Step 1: Write failing test for `loadEnv`**

Add to `test/test-runner.js`:

```js
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
```

- [ ] **Step 2: Run tests to verify it fails**

Run: `node test/test-runner.js`
Expected: FAIL — `loadEnv is not a function`

- [ ] **Step 3: Add `loadEnv` to `lib/utils.js`**

```js
/**
 * Load .env file and set process.env entries.
 * Parses KEY=VALUE lines, ignores comments (#) and empty lines.
 * Does not override existing env vars.
 * @param {string} filePath - Path to .env file
 */
function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) return;

  const content = fs.readFileSync(filePath, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}
```

Add `loadEnv` to `module.exports`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node test/test-runner.js`
Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add lib/utils.js test/test-runner.js
git commit -m "feat: add loadEnv to lib/utils.js"
```

---

### Task 3: Add `getRootCause` to `lib/utils.js`

**Files:**
- Modify: `lib/utils.js`
- Test: `test/test-runner.js`

- [ ] **Step 1: Write failing test for `getRootCause`**

Add to `test/test-runner.js`:

```js
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
```

- [ ] **Step 2: Run tests to verify it fails**

Run: `node test/test-runner.js`
Expected: FAIL — `getRootCause is not a function` (or wrong result)

- [ ] **Step 3: Add `getRootCause` to `lib/utils.js`**

```js
/**
 * Extract root cause source file from a module change's import chain.
 * Walks the importChain and returns the first non-node_modules entry,
 * stripping loader prefixes (everything before last !).
 * Note: inlines the node_modules check to avoid circular dependency with stats-parser.
 * @param {{ importChain: string[] }} change - Module change object with importChain
 * @returns {string}
 */
function getRootCause(change) {
  if (change.importChain.length === 0) return 'Unknown';

  for (const item of change.importChain) {
    if (!item.includes('node_modules')) {
      return item.split('!').pop();
    }
  }

  return change.importChain[0];
}
```

Add `getRootCause` to `module.exports`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node test/test-runner.js`
Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add lib/utils.js test/test-runner.js
git commit -m "feat: add getRootCause to lib/utils.js"
```

---

### Task 4: Update all `formatBytes` consumers

**Files:**
- Modify: `lib/stats-parser.js:357-369,371-383`
- Modify: `lib/diff-engine.js:6,448-456,541-554`
- Modify: `scripts/diff.js:305-315`
- Modify: `scripts/comment.js:425-433,440-447`
- Modify: `scripts/analyze.js:407-413,420-426`

- [ ] **Step 1: Update `lib/stats-parser.js`**

Remove `formatBytes` function (lines 357-369). Remove `formatBytes` from `module.exports` (line 377). Keep everything else. Add re-export of formatBytes from utils for backward compatibility:

```js
// At top of file, add:
const { formatBytes } = require('./utils');

// In module.exports, keep formatBytes (now it's the re-exported version from utils)
```

Actually, since stats-parser already exports formatBytes and other files import it from there, the cleanest approach is:
1. Remove the local `formatBytes` definition (lines 357-369)
2. Import `formatBytes` from `./utils` at the top
3. Keep `formatBytes` in `module.exports` so existing consumers don't break during migration

- [ ] **Step 2: Update `lib/diff-engine.js`**

Change line 6 from:
```js
const { isNodeModule, extractPackageName, formatBytes } = require('./stats-parser');
```
to:
```js
const { isNodeModule, extractPackageName } = require('./stats-parser');
const { formatBytes } = require('./utils');
```

Keep `formatSignedBytes` (lines 448-456, JSDoc + function body) — it wraps `formatBytes` internally and still works since it calls `formatBytes(Math.abs(bytes))` which is unsigned.

Keep `formatBytes` in `module.exports` (line 553) — consumers of diff-engine that use its `formatBytes` export continue to work.

- [ ] **Step 3: Update `scripts/diff.js`**

Remove local `formatBytes` function (lines 305-315). Add at the top of file:
```js
const { formatBytes } = require('../lib/utils');
```

Update call sites: `diff.js` calls `formatBytes(bytes, { signed: false })` and `formatBytes(bytes)` (default signed=true in original). Check each call site:
- The original `diff.js` `formatBytes` defaults `signed` to `true`. The new `utils.formatBytes` defaults `signed` to `false`. So calls that previously relied on the default signed behavior need explicit `{ signed: true }`. Grep all `formatBytes(` calls in diff.js and update accordingly.

- [ ] **Step 4: Update `scripts/comment.js`**

Remove local `formatBytes` (lines 425-433) and `formatAbsoluteBytes` (lines 440-447). Add at top:
```js
const { formatBytes } = require('../lib/utils');
```

Replace call sites:
- `formatBytes(bytes)` (always signed in original) → `formatBytes(bytes, { signed: true })`
- `formatAbsoluteBytes(bytes)` → `formatBytes(bytes)` (unsigned is the default)

- [ ] **Step 5: Update `scripts/analyze.js`**

Remove local `formatBytes` (lines 407-413) and `formatBytesAbs` (lines 420-426). Add at top:
```js
const { formatBytes } = require('../lib/utils');
```

Replace call sites:
- `formatBytes(bytes)` (always signed in original) → `formatBytes(bytes, { signed: true })`
- `formatBytesAbs(bytes)` → `formatBytes(bytes)` (unsigned is the default)

- [ ] **Step 6: Run all tests**

Run: `node test/test-runner.js`
Expected: All tests pass

- [ ] **Step 7: Commit**

```bash
git add lib/stats-parser.js lib/diff-engine.js scripts/diff.js scripts/comment.js scripts/analyze.js
git commit -m "refactor: consolidate all formatBytes to lib/utils.js"
```

---

### Task 5: Update `.env` parsing consumers

**Files:**
- Modify: `cli.js:15-30`
- Modify: `scripts/analyze.js:10-25`

- [ ] **Step 1: Update `cli.js`**

Replace lines 15-30 (inline .env parsing) with:
```js
const { loadEnv } = require('./lib/utils');
loadEnv(path.join(__dirname, '.env'));
```

- [ ] **Step 2: Update `scripts/analyze.js`**

Replace lines 10-25 (inline .env parsing) with:
```js
const { loadEnv } = require('../lib/utils');
loadEnv(path.join(__dirname, '..', '.env'));
```

- [ ] **Step 3: Run all tests**

Run: `node test/test-runner.js`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add cli.js scripts/analyze.js
git commit -m "refactor: consolidate .env parsing to lib/utils.js loadEnv"
```

---

### Task 6: Update `getRootCause` consumers

**Files:**
- Modify: `lib/diff-engine.js:463-474,541-554`
- Modify: `lib/rule-engine.js:571-581`

- [ ] **Step 1: Update `lib/diff-engine.js`**

Remove local `getRootCause` function (lines 463-474). Add import at top:
```js
const { getRootCause } = require('./utils');
```
(Can be combined with the existing `formatBytes` import from utils added in Task 4.)

Remove `getRootCause` from `module.exports` (line 550). Consumers of `diff-engine.getRootCause` should import from `utils` instead — but check if any file imports it from diff-engine first. If so, keep the re-export.

- [ ] **Step 2: Update `lib/rule-engine.js`**

Remove local `getRootCause` function (lines 571-581). Add import at top:
```js
const { getRootCause } = require('./utils');
```

- [ ] **Step 3: Run all tests**

Run: `node test/test-runner.js`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add lib/diff-engine.js lib/rule-engine.js
git commit -m "refactor: consolidate getRootCause to lib/utils.js"
```

---

### Task 7: Remove dead code

**Files:**
- Modify: `lib/stats-parser.js:339-349,371-383` (remove `findMainChunk`)
- Modify: `lib/diff-engine.js:81,95,482-502,541-554` (remove `changed` array, `filterChanges`)
- Modify: `lib/rescript-analyzer.js:283-299,352-362` (remove `getLinesChanged`, remove `correlateWithBundleChanges` from exports)

- [ ] **Step 1: Remove `findMainChunk` from `stats-parser.js`**

Delete the function (lines 339-349). Remove `findMainChunk` from `module.exports` (line 378).

- [ ] **Step 2: Remove `changed` array and `filterChanges` from `diff-engine.js`**

In `computeDiff()`:
- Remove `const changed = [];` (line 81)
- Remove `changed.push(change);` (line 95)

Delete `filterChanges` function (lines 482-502). Remove `filterChanges` from `module.exports` (line 551).

- [ ] **Step 3: Remove dead exports from `rescript-analyzer.js`**

Delete `getLinesChanged` function (lines 283-299). Remove `getLinesChanged` from `module.exports` (line 360). Remove `correlateWithBundleChanges` from `module.exports` (line 357) — keep the function itself (it's called internally by `generateReScriptSummary`).

- [ ] **Step 4: Run all tests**

Run: `node test/test-runner.js`
Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add lib/stats-parser.js lib/diff-engine.js lib/rescript-analyzer.js
git commit -m "refactor: remove dead code (findMainChunk, filterChanges, changed array, getLinesChanged)"
```

---

## Chunk 2: Error Handling

### Task 8: Add AI API timeout (5 minutes)

**Files:**
- Modify: `lib/ai-client.js:55-77`

- [ ] **Step 1: Add `AbortSignal.timeout(300000)` to fetch call**

In `ai-client.js`, modify the `fetch()` call at line 55 to add `signal`:

```js
const response = await fetch(`${client.baseURL}/chat/completions`, {
  method: 'POST',
  signal: AbortSignal.timeout(300000), // 5 minute timeout
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${client.apiKey}`,
  },
  body: JSON.stringify({
    // ... existing body unchanged
  }),
});
```

- [ ] **Step 2: Add AbortError handling**

The existing catch block (lines 92-97) already catches errors and calls `generateFallbackAnalysis`. Add a specific timeout check before the existing handler:

```js
  } catch (error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      console.warn('⚠ AI API request timed out after 5 minutes, falling back to rule-based analysis');
      return generateFallbackAnalysis(diff, detections);
    }
    console.error('AI analysis failed:', error.message);

    // Return fallback analysis
    return generateFallbackAnalysis(diff, detections);
  }
```

Note: The parameter is named `detections` (line 51 of `ai-client.js`), not `detectionResults`.

- [ ] **Step 3: Run all tests**

Run: `node test/test-runner.js`
Expected: All tests pass (AI client tests don't actually call fetch)

- [ ] **Step 4: Commit**

```bash
git add lib/ai-client.js
git commit -m "fix: add 5-minute timeout to AI API calls with fallback to offline analysis"
```

---

### Task 9: Add CLI argument validation

**Files:**
- Modify: `cli.js:385-465`

- [ ] **Step 1: Add validation to `parseArgs` for all value-requiring flags**

In `cli.js`, add a validation helper at the top of `parseArgs`, then apply it to each flag that takes a required value. Replace the entire `parseArgs` function (lines 385-465) with:

```js
function parseArgs(args) {
  const options = {
    base: "main",
    head: "HEAD",
    model: "kimi-latest",
  };

  function requireValue(flag, i, args) {
    if (!args[i + 1] || args[i + 1].startsWith("--")) {
      console.error(`Error: ${flag} requires a value`);
      process.exit(1);
    }
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    switch (arg) {
      // Branch mode
      case "--base":
      case "-b":
        requireValue(arg, i, args);
        options.base = args[++i];
        break;
      case "--head":
        requireValue(arg, i, args);
        options.head = args[++i];
        break;

      // File mode
      case "--base-stats":
        requireValue(arg, i, args);
        options.baseStats = args[++i];
        break;
      case "--pr-stats":
        requireValue(arg, i, args);
        options.prStats = args[++i];
        break;

      // Options
      case "--lines":
      case "-l":
        requireValue(arg, i, args);
        options.lines = args[++i];
        break;
      case "--skip-ai":
        options.skipAI = true;
        break;
      case "--model":
      case "-m":
        requireValue(arg, i, args);
        options.model = args[++i];
        break;
      case "--comment-file":
        requireValue(arg, i, args);
        options.commentFile = args[++i];
        break;
      case "--json":
      case "-j":
        options.json = true;
        // If next arg doesn't start with --, it's a file path
        if (args[i + 1] && !args[i + 1].startsWith("--")) {
          options.json = args[++i];
        }
        break;
      case "--post-comment":
        options.postComment = true;
        break;
      case "--pr":
        requireValue(arg, i, args);
        options.prNumber = args[++i];
        break;
      case "--verbose":
      case "-v":
        options.verbose = true;
        break;

      // Meta
      case "--version":
        options.version = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;

      default:
        if (arg.startsWith("-")) {
          console.warn(`Unknown option: ${arg}`);
        }
    }
  }

  return options;
}
```

Note: `--json` keeps its special dual behavior (boolean or file path). `--skip-ai`, `--post-comment`, `--verbose`, `--version`, `--help` are boolean flags and don't need validation.

- [ ] **Step 2: Run all tests**

Run: `node test/test-runner.js`
Expected: All tests pass

- [ ] **Step 3: Commit**

```bash
git add cli.js
git commit -m "fix: validate CLI arguments that require values"
```

---

### Task 10: Add stats JSON validation

**Files:**
- Modify: `lib/stats-parser.js:53-56`
- Test: `test/test-runner.js`

- [ ] **Step 1: Write failing test for malformed stats**

Add to `test/test-runner.js`:

```js
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
```

- [ ] **Step 2: Run tests to verify it fails**

Run: `node test/test-runner.js`
Expected: The `parseStats({ modules: 'not-an-array' })` test should fail — current guard only checks `!stats.modules` (truthy), not `Array.isArray`.

- [ ] **Step 3: Update guard in `stats-parser.js`**

Replace lines 54-55:
```js
  if (!stats || !stats.modules) {
    throw new Error('Invalid webpack stats: missing modules array');
  }
```
with:
```js
  if (!stats || !Array.isArray(stats.modules)) {
    throw new Error('Invalid webpack stats: expected object with "modules" array');
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node test/test-runner.js`
Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add lib/stats-parser.js test/test-runner.js
git commit -m "fix: validate stats.modules is an array to prevent silent NaN propagation"
```

---

### Task 11: Final verification

- [ ] **Step 1: Run full test suite**

Run: `node test/test-runner.js`
Expected: All tests pass (original 33 adjusted + new tests)

- [ ] **Step 2: Verify no duplicate `formatBytes` definitions remain**

Run: `grep -rn "function formatBytes" lib/ scripts/`
Expected: Only `lib/utils.js` should define it. `stats-parser.js` may re-export but should not define.

- [ ] **Step 3: Verify no duplicate `.env` parsing remains**

Run: `grep -rn "envContent.split" cli.js scripts/`
Expected: No matches (all replaced by `loadEnv`)

- [ ] **Step 4: Verify no duplicate `getRootCause` remains**

Run: `grep -rn "function getRootCause" lib/`
Expected: Only `lib/utils.js`

- [ ] **Step 5: Verify dead code removed**

Run: `grep -rn "findMainChunk\|filterChanges\|getLinesChanged" lib/ --include="*.js"`
Expected: No function definitions, no exports for these names.

- [ ] **Step 6: Commit all remaining changes (if any)**

```bash
git add -A
git commit -m "chore: final cleanup after code quality improvements"
```
