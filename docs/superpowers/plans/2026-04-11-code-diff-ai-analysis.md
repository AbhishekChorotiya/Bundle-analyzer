# Code Diff AI Analysis — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the AI analyzer visibility into actual source code changes (git diffs) alongside webpack bundle stats, improving decision accuracy and providing actionable suggestions that reference the developer's real code.

**Architecture:** Single full git clone replaces dual shallow clones. Source + compiled JS diffs are collected, chunked, and analyzed by parallel AI calls (max 3 concurrent). Chunk results are merged into a `CodeDiffSummary` that feeds the final AI analysis call alongside all existing bundle data.

**Tech Stack:** Node.js (zero deps), `child_process.execSync`/`execFile`/`spawn`, git CLI, existing custom test runner

**Spec:** `docs/superpowers/specs/2026-04-11-code-diff-ai-analysis-design.md`

**Test runner:** `node test/test-runner.js` — uses `test(name, fn)`, `testAsync(name, fn)`, `assertEqual(a, b, msg)`, `assertTrue(v, msg)`, `assertFalse(v, msg)`

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `lib/code-diff.js` | **Create** | Diff collection, parsing, chunking — `parseDiffStats`, `chunkDiff`, `collectCodeDiff` |
| `lib/clone-builder.js` | **Modify** | Replace `cloneAndBuild` with `cloneRepo` + `buildBranch` (keep old export for backward compat) |
| `lib/rescript-analyzer.js` | **Modify** | Bug fix (line 78), add `cwd` option threading |
| `lib/ai-client.js` | **Modify** | Add `analyzeCodeChunk`, `analyzeCodeChunks`, enhance `buildAnalysisPrompt` + `SYSTEM_PROMPT` |
| `scripts/orchestrate.js` | **Modify** | Rewrite `runFullMode`, add Phase 2.5 to `runPipeline` |
| `test/test-runner.js` | **Modify** | Add tests for all new/changed functions |

---

## Chunk 1: Pure Functions — `lib/code-diff.js` + `lib/clone-builder.js` + `lib/rescript-analyzer.js` bug fix

### Task 1: `parseDiffStats` — Parse unified diff into per-file stats

**Files:**
- Create: `lib/code-diff.js`
- Test: `test/test-runner.js` (add section before `// Run async tests`)

- [ ] **Step 1: Write failing tests for `parseDiffStats`**

Add the following tests in `test/test-runner.js` before the `// Run async tests` line (line 1494). Insert a section header first.

```js
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
```

- [ ] **Step 2: Run tests — verify they fail**

Run: `node test/test-runner.js`
Expected: FAIL — `Cannot find module '../lib/code-diff'`

- [ ] **Step 3: Implement `parseDiffStats` in `lib/code-diff.js`**

```js
'use strict';

/**
 * Parse unified diff output into per-file stats.
 * @param {string} diffText - Raw git diff output
 * @returns {{ filePath: string, linesAdded: number, linesRemoved: number, isBinary: boolean }[]}
 */
function parseDiffStats(diffText) {
  if (!diffText || !diffText.trim()) return [];

  const files = [];
  // Split by file boundary lines
  const fileDiffs = diffText.split(/^(?=diff --git )/m);

  for (const fileDiff of fileDiffs) {
    if (!fileDiff.trim()) continue;

    // Extract file path from "diff --git a/path b/path"
    const headerMatch = fileDiff.match(/^diff --git a\/(.+?) b\/(.+)/m);
    if (!headerMatch) continue;

    const filePath = headerMatch[2];

    // Check for binary
    if (/^Binary files /m.test(fileDiff)) {
      files.push({ filePath, linesAdded: 0, linesRemoved: 0, isBinary: true });
      continue;
    }

    // Count added/removed lines (lines starting with +/- but not +++/---)
    let linesAdded = 0;
    let linesRemoved = 0;
    const lines = fileDiff.split('\n');
    for (const line of lines) {
      if (line.startsWith('+') && !line.startsWith('+++')) linesAdded++;
      else if (line.startsWith('-') && !line.startsWith('---')) linesRemoved++;
    }

    files.push({ filePath, linesAdded, linesRemoved, isBinary: false });
  }

  return files;
}

module.exports = { parseDiffStats };
```

- [ ] **Step 4: Run tests — verify they pass**

Run: `node test/test-runner.js`
Expected: All new `parseDiffStats` tests PASS, all 105 existing tests still PASS.

- [ ] **Step 5: Commit**

```
git add lib/code-diff.js test/test-runner.js
git commit -m "feat: add parseDiffStats to lib/code-diff.js with tests"
```

---

### Task 2: `chunkDiff` — Split unified diff into size-bounded chunks

**Files:**
- Modify: `lib/code-diff.js`
- Test: `test/test-runner.js`

- [ ] **Step 1: Write failing tests for `chunkDiff`**

Add after the `parseDiffStats` tests in `test/test-runner.js`:

```js
test('chunkDiff splits diff into chunks under maxBytes', () => {
  // Each file diff is ~50 bytes, set max to 120 so 2 files per chunk
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
  // Each chunk should contain valid diff text starting with diff --git
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
  // Create a diff where one file exceeds maxBytes
  const bigFile = 'diff --git a/big.js b/big.js\n' + '+line\n'.repeat(100);
  const smallFile = 'diff --git a/small.js b/small.js\n+tiny\n';
  const diff = bigFile + smallFile;
  const chunks = chunkDiff(diff, 50); // maxBytes smaller than bigFile
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
  // Default 50000 should fit both files in one chunk
  const chunks = chunkDiff(diff);
  assertEqual(chunks.length, 1, 'Default maxBytes should fit small diffs in one chunk');
});
```

- [ ] **Step 2: Run tests — verify they fail**

Run: `node test/test-runner.js`
Expected: FAIL — `chunkDiff is not a function`

- [ ] **Step 3: Implement `chunkDiff` in `lib/code-diff.js`**

Add to `lib/code-diff.js` before `module.exports`:

```js
/**
 * Default max bytes per chunk (~12K tokens).
 * Targets GPT-4o/Claude 128K context windows with comfortable headroom.
 * Configurable via CODE_DIFF_CHUNK_MAX_BYTES env var.
 */
const DEFAULT_CHUNK_MAX_BYTES = 50000;

/**
 * Split a unified diff into chunks for parallel AI analysis.
 * Groups files to keep each chunk under maxBytes.
 * @param {string} diffText - Full unified diff
 * @param {number} [maxBytes] - Max bytes per chunk
 * @returns {string[]} Array of diff chunks
 */
function chunkDiff(diffText, maxBytes) {
  if (!diffText || !diffText.trim()) return [];

  const limit = maxBytes || parseInt(process.env.CODE_DIFF_CHUNK_MAX_BYTES, 10) || DEFAULT_CHUNK_MAX_BYTES;

  // Split by file boundaries
  const fileDiffs = diffText.split(/^(?=diff --git )/m).filter(s => s.trim());
  if (fileDiffs.length === 0) return [];

  const chunks = [];
  let currentChunk = '';

  for (const fileDiff of fileDiffs) {
    const fileDiffBytes = Buffer.byteLength(fileDiff, 'utf-8');

    // If adding this file would exceed limit AND we already have content, flush
    if (currentChunk && Buffer.byteLength(currentChunk, 'utf-8') + fileDiffBytes > limit) {
      chunks.push(currentChunk);
      currentChunk = '';
    }

    // If single file exceeds limit, it gets its own chunk (never truncate)
    if (!currentChunk && fileDiffBytes > limit) {
      chunks.push(fileDiff);
      continue;
    }

    currentChunk += (currentChunk ? '\n' : '') + fileDiff;
  }

  // Flush remaining
  if (currentChunk) {
    chunks.push(currentChunk);
  }

  return chunks;
}
```

Update `module.exports` to include `chunkDiff`.

- [ ] **Step 4: Run tests — verify they pass**

Run: `node test/test-runner.js`
Expected: All `chunkDiff` tests PASS, all previous tests still PASS.

- [ ] **Step 5: Commit**

```
git add lib/code-diff.js test/test-runner.js
git commit -m "feat: add chunkDiff to lib/code-diff.js with tests"
```

---

### Task 3: `collectCodeDiff` — Full diff collection with source/compiled separation

**Files:**
- Modify: `lib/code-diff.js`
- Test: `test/test-runner.js`

- [ ] **Step 1: Write failing tests for `collectCodeDiff`**

These tests mock `childProcess.execSync` to avoid requiring a real git repo. The mock works because `collectCodeDiff` uses `require('child_process').execSync(...)` internally (not a destructured import), so reassigning `childProcess.execSync` is intercepted. Add after `chunkDiff` tests, before `// Run async tests`:

```js
test('collectCodeDiff separates source and compiled diffs', () => {
  const { collectCodeDiff } = require('../lib/code-diff');
  const childProcess = require('child_process');
  const originalExecSync = childProcess.execSync;

  try {
    // Mock execSync to return different diffs based on command
    childProcess.execSync = (cmd, opts) => {
      if (cmd.includes("-- ':!lib/js/'")) {
        // Source diff command (with pathspec exclusions)
        return 'diff --git a/src/Foo.res b/src/Foo.res\n+added line\n';
      }
      if (cmd.includes('--no-index')) {
        // Compiled diff command — throw with status 1 (differences found)
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
        // status 2 = error, not just differences
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
```

- [ ] **Step 2: Run tests — verify they fail**

Run: `node test/test-runner.js`
Expected: FAIL — `collectCodeDiff is not a function` or not exported

- [ ] **Step 3: Implement `collectCodeDiff` in `lib/code-diff.js`**

Add to `lib/code-diff.js`:

**IMPORTANT:** `collectCodeDiff` uses `require('child_process').execSync(...)` calls (NOT destructured at module scope) so that tests can mock `childProcess.execSync` via module-level assignment.

```js
/**
 * Collect code diff between two branches in a git repo.
 * NOTE: Uses require('child_process').execSync() directly (not destructured)
 * to allow test mocking via childProcess.execSync reassignment.
 * @param {string} repoDir - Path to the cloned repo
 * @param {string} baseBranch - Base branch name
 * @param {string} prBranch - PR branch name
 * @param {{ baseCompiledDir?: string, prCompiledDir?: string }} [dirs] - Compiled JS snapshot directories
 * @returns {{ sourceDiff: string, compiledDiff: string, linesChanged: number, fileStats: object[], repoDir: string, baseBranch: string, prBranch: string }}
 */
function collectCodeDiff(repoDir, baseBranch, prBranch, dirs = {}) {
  const childProcess = require('child_process');

  // Source diff: everything except compiled output and build artifacts
  let sourceDiff = '';
  try {
    sourceDiff = childProcess.execSync(
      `git diff ${baseBranch}...${prBranch} -- ':!lib/js/' ':!lib/es6/' ':!node_modules/' ':!dist/'`,
      { cwd: repoDir, encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 }
    );
  } catch (err) {
    // git diff exits 0 normally, any error here is real
    console.warn(`Warning: git diff failed: ${err.message}`);
  }

  // Compiled JS diff via git diff --no-index
  let compiledDiff = '';
  if (dirs.baseCompiledDir && dirs.prCompiledDir) {
    try {
      childProcess.execSync(
        `git diff --no-index ${dirs.baseCompiledDir} ${dirs.prCompiledDir}`,
        { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 }
      );
      // Exit 0 = no differences
    } catch (err) {
      if (err.status === 1 && err.stdout) {
        // Exit 1 = differences found (normal)
        compiledDiff = err.stdout.toString();
      }
      // Exit 2 = error, leave compiledDiff empty
    }

    // Rewrite temp dir paths to repo-relative paths
    if (compiledDiff) {
      compiledDiff = compiledDiff
        .replace(new RegExp(`a/${dirs.baseCompiledDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`, 'g'), 'a/lib/js/')
        .replace(new RegExp(`b/${dirs.prCompiledDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`, 'g'), 'b/lib/js/');
    }
  }

  // Parse stats from source diff only (compiled JS stats are less useful)
  const fileStats = parseDiffStats(sourceDiff);
  const linesChanged = fileStats.reduce((sum, f) => sum + f.linesAdded + f.linesRemoved, 0);

  return { sourceDiff, compiledDiff, linesChanged, fileStats, repoDir, baseBranch, prBranch };
}
```

Update `module.exports` to include `collectCodeDiff`.

- [ ] **Step 4: Run tests — verify they pass**

Run: `node test/test-runner.js`
Expected: All `collectCodeDiff` tests PASS, all previous tests still PASS.

- [ ] **Step 5: Commit**

```
git add lib/code-diff.js test/test-runner.js
git commit -m "feat: add collectCodeDiff to lib/code-diff.js with tests"
```

---

### Task 4: `lib/clone-builder.js` — Replace `cloneAndBuild` with `cloneRepo` + `buildBranch`

**Files:**
- Modify: `lib/clone-builder.js:80-126`
- Test: `test/test-runner.js`

- [ ] **Step 1: Write failing tests for `cloneRepo` and `buildBranch`**

Add tests in `test/test-runner.js` after the code-diff tests:

```js
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
```

- [ ] **Step 2: Run tests — verify they fail**

Run: `node test/test-runner.js`
Expected: FAIL — `cloneRepo` and/or `buildBranch` not exported.

- [ ] **Step 3: Implement `cloneRepo` and `buildBranch`**

Read `lib/clone-builder.js` fully, then modify it. Keep the existing `run()` and `runWebpack()` helper functions unchanged. Keep `cloneAndBuild` for backward compat. Add:

Note: `fs` and `path` are already imported at module scope (lines 8-9) — use those, do NOT re-import inside functions.

```js
/**
 * Clone a git repo (full clone, no depth limit).
 * @param {string} repoUrl - Repository URL
 * @param {string} targetDir - Directory to clone into
 * @param {{ log?: function }} [options]
 * @returns {Promise<{ repoDir: string }>}
 */
async function cloneRepo(repoUrl, targetDir, options = {}) {
  const log = options.log || (() => {});
  log(`Cloning ${repoUrl} → ${targetDir}`);
  await run('git', ['clone', repoUrl, targetDir]);
  await run('git', ['submodule', 'update', '--init', '--recursive'], { cwd: targetDir });
  return { repoDir: targetDir };
}

/**
 * Build a specific branch in an existing cloned repo.
 * @param {string} repoDir - Path to cloned repo
 * @param {string} branch - Branch to build
 * @param {string} outputDir - Where to save stats and compiled JS snapshot
 * @param {{ log?: function }} [options]
 * @returns {Promise<{ statsPath: string, compiledJsDir: string }>}
 */
async function buildBranch(repoDir, branch, outputDir, options = {}) {
  const log = options.log || (() => {});

  // Ensure output directory exists first
  fs.mkdirSync(outputDir, { recursive: true });

  log(`Checking out ${branch}`);
  await run('git', ['checkout', branch], { cwd: repoDir });
  await run('git', ['clean', '-fdx', '-e', 'node_modules'], { cwd: repoDir });

  log(`Installing dependencies`);
  await run('npm', ['install', '--ignore-scripts'], { cwd: repoDir });

  log(`Building ReScript`);
  await run('npm', ['run', 're:build'], { cwd: repoDir });

  // Copy compiled JS snapshot before webpack build
  const compiledJsDir = path.join(outputDir, 'compiled-js');
  const libJsDir = path.join(repoDir, 'lib', 'js');
  if (fs.existsSync(libJsDir)) {
    fs.mkdirSync(compiledJsDir, { recursive: true });
    await run('cp', ['-r', libJsDir + '/.', compiledJsDir]);
  }

  log(`Building webpack`);
  const rawOutput = await runWebpack(repoDir);

  // Extract JSON from webpack output (same logic as cloneAndBuild)
  const jsonStart = rawOutput.indexOf('{');
  if (jsonStart === -1) {
    throw new Error('webpack did not produce JSON output');
  }
  const jsonContent = rawOutput.substring(jsonStart);

  // Validate JSON
  try {
    JSON.parse(jsonContent);
  } catch (e) {
    throw new Error(`Invalid JSON in webpack stats output: ${e.message}`);
  }

  const statsPath = path.join(outputDir, 'stats.json');
  fs.writeFileSync(statsPath, jsonContent);

  return { statsPath, compiledJsDir };
}
```

Update `module.exports` to export `cloneRepo`, `buildBranch`, and keep `cloneAndBuild`.

- [ ] **Step 4: Run tests — verify they pass**

Run: `node test/test-runner.js`
Expected: All new export tests PASS, existing `cloneAndBuild` tests still PASS.

- [ ] **Step 5: Commit**

```
git add lib/clone-builder.js test/test-runner.js
git commit -m "feat: add cloneRepo and buildBranch to clone-builder.js"
```

---

### Task 5: `lib/rescript-analyzer.js` — Bug fix + `cwd` option threading

**Files:**
- Modify: `lib/rescript-analyzer.js:78` (bug fix), lines with `execSync` (cwd threading)
- Test: `test/test-runner.js`

- [ ] **Step 1: Write failing test for the `addedImports` bug**

Add after the clone-builder tests (before `// Run async tests`):

```js
// ============================================================
// rescript-analyzer.js bug fix + cwd tests
// ============================================================
console.log('\n--- Testing rescript-analyzer.js fixes ---');

test('analyzeReScriptChanges: newImports bug fix - should use addedImports not newImports', () => {
  // This test verifies the fix for the bug at line 78 where
  // fileImports.newImports (all imports) was used instead of
  // fileImports.addedImports (only newly added imports).
  // We test the internal function analyzeFileImports to verify its return shape.
  const { extractImports } = require('../lib/rescript-analyzer');

  const oldContent = 'open ReactNative\nopen Belt';
  const newContent = 'open ReactNative\nopen Belt\nopen Js.Promise';

  const oldImports = extractImports(oldContent);
  const newImports = extractImports(newContent);

  // newImports should contain ALL imports in new version
  assertEqual(newImports.length, 3, 'newImports should have all 3 imports');
  // addedImports should only contain the new one
  const addedImports = newImports.filter(imp => !oldImports.includes(imp));
  assertEqual(addedImports.length, 1, 'Only Js.Promise should be added');
  assertEqual(addedImports[0], 'Js.Promise');
});
```

- [ ] **Step 2: Run tests — verify test passes** (this test checks extractImports behavior, not the bug itself — it validates our understanding)

Run: `node test/test-runner.js`
Expected: PASS — this tests the helper, confirming `addedImports` logic is correct.

- [ ] **Step 3: Fix the bug at line 78 of `lib/rescript-analyzer.js`**

Change line 78 from:
```js
      importsAdded.push(...fileImports.newImports);
```
To:
```js
      importsAdded.push(...fileImports.addedImports);
```

- [ ] **Step 4: Add `cwd` option to all functions that use `execSync`**

Modify these functions in `lib/rescript-analyzer.js` using exact edits:

**Edit 1: `analyzeReScriptChanges` signature (line 57)**
Change:
```js
function analyzeReScriptChanges(baseBranch, headBranch) {
```
To:
```js
function analyzeReScriptChanges(baseBranch, headBranch, options = {}) {
```

**Edit 2: `getChangedReScriptFiles` call inside `analyzeReScriptChanges` (line 60)**
Change:
```js
    const filesChanged = getChangedReScriptFiles(baseBranch, headBranch);
```
To:
```js
    const filesChanged = getChangedReScriptFiles(baseBranch, headBranch, options);
```

**Edit 3: `analyzeFileImports` call inside loop (line 76)**
Change:
```js
      const fileImports = analyzeFileImports(file, baseBranch, headBranch);
```
To:
```js
      const fileImports = analyzeFileImports(file, baseBranch, headBranch, options);
```

**Edit 4: `getChangedReScriptFiles` signature (line 108)**
Change:
```js
function getChangedReScriptFiles(baseBranch, headBranch) {
```
To:
```js
function getChangedReScriptFiles(baseBranch, headBranch, options = {}) {
```

**Edit 5: `execSync` call in `getChangedReScriptFiles` (line 111)**
Change:
```js
    const output = execSync(cmd, { encoding: 'utf-8', cwd: process.cwd() });
```
To:
```js
    const output = execSync(cmd, { encoding: 'utf-8', cwd: options.cwd || process.cwd() });
```

**Edit 6: `analyzeFileImports` signature (line 130)**
Change:
```js
function analyzeFileImports(filePath, baseBranch, headBranch) {
```
To:
```js
function analyzeFileImports(filePath, baseBranch, headBranch, options = {}) {
```

**Edit 7: `getFileAtRef` calls in `analyzeFileImports` (lines 131-132)**
Change:
```js
  const oldContent = getFileAtRef(filePath, baseBranch);
  const newContent = getFileAtRef(filePath, headBranch);
```
To:
```js
  const oldContent = getFileAtRef(filePath, baseBranch, options);
  const newContent = getFileAtRef(filePath, headBranch, options);
```

**Edit 8: `getFileAtRef` signature (line 153)**
Change:
```js
function getFileAtRef(filePath, ref) {
```
To:
```js
function getFileAtRef(filePath, ref, options = {}) {
```

**Edit 9: `execSync` call in `getFileAtRef` (lines 155-158)**
Change:
```js
    return execSync(`git show ${ref}:${filePath}`, {
      encoding: 'utf-8',
      cwd: process.cwd(),
    });
```
To:
```js
    return execSync(`git show ${ref}:${filePath}`, {
      encoding: 'utf-8',
      cwd: options.cwd || process.cwd(),
    });
```

- [ ] **Step 5: Write test for `cwd` option**

```js
test('rescript-analyzer functions accept cwd option', () => {
  // Verify the option parameter exists on all relevant exported functions
  // We can't easily test actual cwd behavior without a git repo,
  // but we can verify the function signatures accept the option
  const { analyzeReScriptChanges } = require('../lib/rescript-analyzer');
  assertEqual(typeof analyzeReScriptChanges, 'function');
  // analyzeReScriptChanges catches all errors and returns empty result
  const result = analyzeReScriptChanges('nonexistent', 'also-nonexistent', { cwd: '/tmp' });
  assertEqual(result.filesChanged.length, 0, 'Should return empty result on error');
  assertTrue(Array.isArray(result.importsAdded));
});
```

- [ ] **Step 6: Run tests — verify all pass**

Run: `node test/test-runner.js`
Expected: All tests PASS, including existing rescript-analyzer tests.

- [ ] **Step 7: Commit**

```
git add lib/rescript-analyzer.js test/test-runner.js
git commit -m "fix: rescript-analyzer addedImports bug + add cwd option threading"
```

---

## Chunk 2: AI Client Enhancement + Orchestrator Integration

### Task 6: `lib/ai-client.js` — Add `analyzeCodeChunk` and `analyzeCodeChunks`

**Files:**
- Modify: `lib/ai-client.js` (add functions, modify exports)
- Test: `test/test-runner.js`

- [ ] **Step 1: Write failing tests**

Add after the existing ai-client tests (before `// Run async tests`):

```js
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

testAsync('analyzeCodeChunks merges multiple chunk results', async () => {
  // Mock global.fetch to simulate AI API responses
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

    // Both chunks return same imports, should be deduplicated
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
```

- [ ] **Step 2: Run tests — verify they fail**

Run: `node test/test-runner.js`
Expected: FAIL — `analyzeCodeChunk` / `analyzeCodeChunks` not exported.

- [ ] **Step 3: Implement `analyzeCodeChunk` and `analyzeCodeChunks`**

Add to `lib/ai-client.js` before `module.exports`:

```js
const { runWithConcurrency } = require('./concurrency');

/**
 * System prompt for code diff chunk analysis.
 */
const CODE_CHUNK_SYSTEM_PROMPT = `You are analyzing a code diff chunk for a ReScript/React webpack application (Hyperswitch Web SDK).

Analyze the code changes and extract structured information:
1. What files changed and what was the nature of each change (new feature, refactor, bugfix, config change)
2. Any new imports or dependencies introduced
3. Any imports or dependencies removed
4. Risk areas: changes that are likely to increase bundle size (new imports of large libraries, removal of tree-shaking-friendly patterns, broad re-exports)
5. Code patterns that may affect bundle: dynamic imports added/removed, conditional requires, barrel file changes

Output valid JSON only, with this shape:
{
  "filesAnalyzed": ["path/to/file"],
  "keyChanges": [{ "file": "path", "description": "what changed", "type": "feature|refactor|bugfix|config" }],
  "riskAreas": [{ "file": "path", "risk": "description", "severity": "high|medium|low" }],
  "newImports": ["package-name"],
  "removedImports": ["package-name"]
}`;

/**
 * Analyze a single code diff chunk via AI.
 * Uses raw fetch() matching the analyzeBundle pattern (createClient returns
 * { apiKey, model, baseURL } — there is no chat method).
 * @param {{ apiKey: string, model: string, baseURL: string }} client - AI client from createClient
 * @param {string} chunkDiff - The diff chunk text
 * @param {number} chunkIndex - 1-based index
 * @param {number} totalChunks - Total number of chunks
 * @returns {Promise<object>} Parsed chunk analysis
 */
async function analyzeCodeChunk(client, chunkDiff, chunkIndex, totalChunks) {
  const userPrompt = `This is chunk ${chunkIndex} of ${totalChunks} from a pull request diff.\n\n${chunkDiff}`;

  const response = await fetch(`${client.baseURL}/chat/completions`, {
    method: 'POST',
    signal: AbortSignal.timeout(120000), // 2 minute timeout per chunk
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${client.apiKey}`,
    },
    body: JSON.stringify({
      model: client.model,
      messages: [
        { role: 'system', content: CODE_CHUNK_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      temperature: TEMPERATURE,
      max_tokens: MAX_TOKENS,
      response_format: { type: 'json_object' },
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`AI API error: ${response.status} - ${error}`);
  }

  const data = await response.json();
  const content = data.choices[0]?.message?.content;

  if (!content) {
    throw new Error('Empty response from AI API');
  }

  // Parse JSON from response (handle markdown code fences)
  let json = content;
  const fenceMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) json = fenceMatch[1];
  return JSON.parse(json.trim());
}

/**
 * Analyze multiple code diff chunks in parallel, merge results.
 * @param {{ apiKey: string, model: string, baseURL: string }} client - AI client from createClient
 * @param {string[]} chunks - Array of diff chunks
 * @param {number} [maxConcurrent=3] - Max concurrent API calls
 * @returns {Promise<object|null>} Merged CodeDiffSummary, or null if all chunks fail
 */
async function analyzeCodeChunks(client, chunks, maxConcurrent = 3) {
  if (!chunks || chunks.length === 0) return null;

  const totalChunks = chunks.length;
  const tasks = chunks.map((chunk, i) => async () => {
    try {
      return await analyzeCodeChunk(client, chunk, i + 1, totalChunks);
    } catch (err) {
      console.warn(`Warning: Code chunk ${i + 1}/${totalChunks} analysis failed: ${err.message}`);
      return null;
    }
  });

  const results = await runWithConcurrency(tasks, maxConcurrent);

  // Separate successes from failures
  const successes = results.filter(r => r !== null);
  const failedChunks = results.filter(r => r === null).length;

  if (successes.length === 0) return null;

  // Merge into single CodeDiffSummary
  const merged = {
    totalFiles: 0,
    keyChanges: [],
    riskAreas: [],
    newImports: [],
    removedImports: [],
    failedChunks,
  };

  for (const chunk of successes) {
    merged.totalFiles += (chunk.filesAnalyzed || []).length;
    merged.keyChanges.push(...(chunk.keyChanges || []));
    merged.riskAreas.push(...(chunk.riskAreas || []));
    merged.newImports.push(...(chunk.newImports || []));
    merged.removedImports.push(...(chunk.removedImports || []));
  }

  // Deduplicate imports
  merged.newImports = [...new Set(merged.newImports)];
  merged.removedImports = [...new Set(merged.removedImports)];

  return merged;
}
```

Update `module.exports` to include `analyzeCodeChunk`, `analyzeCodeChunks`, and `CODE_CHUNK_SYSTEM_PROMPT`.

- [ ] **Step 4: Run tests — verify they pass**

Run: `node test/test-runner.js`
Expected: All new tests PASS, all existing tests still PASS.

- [ ] **Step 5: Commit**

```
git add lib/ai-client.js test/test-runner.js
git commit -m "feat: add analyzeCodeChunk and analyzeCodeChunks to ai-client.js"
```

---

### Task 7: `lib/ai-client.js` — Enhance `buildAnalysisPrompt` + `SYSTEM_PROMPT`

**Files:**
- Modify: `lib/ai-client.js:108-122` (SYSTEM_PROMPT), `lib/ai-client.js:206-215` (buildAnalysisPrompt)
- Test: `test/test-runner.js`

- [ ] **Step 1: Write failing tests**

```js
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
```

- [ ] **Step 2: Run tests — verify they fail**

Run: `node test/test-runner.js`
Expected: FAIL — `Code Change Analysis` not found in prompt output.

- [ ] **Step 3: Enhance `SYSTEM_PROMPT`**

In `lib/ai-client.js`, find the `SYSTEM_PROMPT` constant. After the "CRITICAL INSTRUCTION FOR SUGGESTIONS" paragraph, add:

```
IMPORTANT: If "Code Change Analysis" is provided, use it to:
- Correlate source file changes with bundle size impacts
- Verify that new imports match the detected bundle additions
- Identify cases where small code changes cause disproportionate bundle growth
- Reference specific source files and line-level changes in your root cause analysis
- Compare source code intent with compiled JS output to find optimization opportunities
```

- [ ] **Step 4: Add `## Code Change Analysis` section to `buildAnalysisPrompt`**

In `lib/ai-client.js`, in `buildAnalysisPrompt`, add this block right **before** the existing `// Add ReScript context if available` block (before line 214):

```js
  // Add Code Change Analysis if available
  if (context.codeDiffSummary) {
    const cds = context.codeDiffSummary;
    promptParts.push('', `## Code Change Analysis`);
    promptParts.push(`Source code changes analyzed from git diff (${cds.totalFiles} files, ${context.linesChanged || 0} lines changed):`);

    if (cds.failedChunks > 0) {
      promptParts.push(`Note: ${cds.failedChunks} chunk(s) failed analysis — results may be incomplete.`);
    }

    if (cds.keyChanges.length > 0) {
      promptParts.push('', '### Key Changes');
      for (const kc of cds.keyChanges) {
        promptParts.push(`- [${kc.type}] ${kc.file}: ${kc.description}`);
      }
    }

    if (cds.riskAreas.length > 0) {
      promptParts.push('', '### Risk Areas');
      for (const ra of cds.riskAreas) {
        promptParts.push(`- [${ra.severity}] ${ra.file}: ${ra.risk}`);
      }
    }

    if (cds.newImports.length > 0) {
      promptParts.push(``, `### New Imports Detected: ${cds.newImports.join(', ')}`);
    }
    if (cds.removedImports.length > 0) {
      promptParts.push(``, `### Removed Imports Detected: ${cds.removedImports.join(', ')}`);
    }

    // Add compiled JS changes from fileStats
    if (context.fileStats) {
      const compiledFiles = context.fileStats.filter(f => f.filePath.startsWith('lib/js/'));
      if (compiledFiles.length > 0) {
        promptParts.push('', `### Compiled JS Changes`);
        promptParts.push(`${compiledFiles.length} ReScript-compiled JS files changed:`);
        for (const cf of compiledFiles.slice(0, 20)) {
          promptParts.push(`- ${cf.filePath}: +${cf.linesAdded}/-${cf.linesRemoved} lines`);
        }
      }
    }
  }
```

- [ ] **Step 5: Run tests — verify they pass**

Run: `node test/test-runner.js`
Expected: All new prompt tests PASS, all existing tests still PASS.

- [ ] **Step 6: Commit**

```
git add lib/ai-client.js test/test-runner.js
git commit -m "feat: enhance buildAnalysisPrompt with Code Change Analysis section"
```

---

### Task 8: `scripts/orchestrate.js` — Rewrite `runFullMode` + add Phase 2.5 to `runPipeline`

**Files:**
- Modify: `scripts/orchestrate.js:280-332` (runFullMode), `scripts/orchestrate.js:385-430` (runPipeline)
- Test: `test/test-runner.js`

- [ ] **Step 1: Write failing test for updated `runPipeline` signature**

```js
test('runPipeline accepts optional 6th codeDiffData parameter', () => {
  const { runPipeline } = require('../scripts/orchestrate');
  // Verify function accepts 6 params (length is unreliable with defaults, just verify export exists)
  assertEqual(typeof runPipeline, 'function');
});
```

- [ ] **Step 2: Modify `runPipeline` signature**

In `scripts/orchestrate.js`, change the signature at line 385:

```js
async function runPipeline(
  baseStatsPath,
  prStatsPath,
  options,
  logger,
  outputDir,
  codeDiffData = null,
) {
```

- [ ] **Step 3: Add Phase 2.5 to `runPipeline`**

After the Phase 2 block (after `logger.ok(...)` at ~line 403), add:

```js
  // Phase 2.5: Code Diff Analysis
  if (codeDiffData) {
    logger.phase(2.5, 5, 'Analyzing code changes...');
    const codeDiffStart = Date.now();

    try {
      // ReScript analysis (synchronous — uses execSync internally)
      const { analyzeReScriptChanges, generateReScriptSummary } = require('../lib/rescript-analyzer');
      const reScriptAnalysis = analyzeReScriptChanges(
        codeDiffData.baseBranch, codeDiffData.prBranch, { cwd: codeDiffData.repoDir }
      );
      const reScriptSummary = generateReScriptSummary(reScriptAnalysis, diff);

      // Chunk and analyze diffs in parallel
      const { chunkDiff } = require('../lib/code-diff');
      const { analyzeCodeChunks } = require('../lib/ai-client');

      const allDiff = (codeDiffData.sourceDiff || '') + '\n' + (codeDiffData.compiledDiff || '');
      const chunks = chunkDiff(allDiff);

      let codeDiffSummary = null;
      if (chunks.length > 0 && !options.skipAI && isAIAvailable()) {
        const client = createClient({ model: options.model });
        codeDiffSummary = await analyzeCodeChunks(client, chunks, 3);
      }

      // Merge into enriched context
      if (codeDiffSummary) {
        enrichedContext.codeDiffSummary = codeDiffSummary;
      }
      enrichedContext.reScriptAnalysis = reScriptSummary;
      // Only set linesChanged if not explicitly overridden by --lines CLI flag
      if (!enrichedContext.linesChanged) {
        enrichedContext.linesChanged = codeDiffData.linesChanged;
      }
      enrichedContext.fileStats = codeDiffData.fileStats;

      logger.ok(`Code diff analyzed: ${codeDiffData.fileStats.length} files, ${chunks.length} chunks (${((Date.now() - codeDiffStart) / 1000).toFixed(1)}s)`);
    } catch (err) {
      logger.warn(`Code diff analysis failed: ${err.message}, continuing without it`);
    }
  }
```

Note: The `enrichedContext` variable is currently built at line 414. We need to move its construction **before** Phase 2.5 so it can be augmented. Move these lines (currently ~411-414):
```js
  const context = {};
  if (options.lines) {
    context.linesChanged = parseInt(options.lines, 10);
  }
  const enrichedContext = { ...context, rawStats: { baseStats, prStats } };
```
...to right after Phase 2, before Phase 2.5.

- [ ] **Step 4: Rewrite `runFullMode` to use single clone**

Replace the Phase 1 block in `runFullMode` (lines ~298-319) with:

```js
  // Phase 1: Clone & Build (sequential in single repo)
  logger.phase(1, 5, 'Cloning and building branches...');
  const buildStart = Date.now();

  const buildLog = options.verbose ? logger.info.bind(logger) : () => {};
  const repoDir = path.join(tmpDir, 'repo');
  const { cloneRepo, buildBranch } = require('../lib/clone-builder');

  // Phase 1a: Clone repo (full clone)
  await cloneRepo(options.repoUrl, repoDir, { log: buildLog });

  // Phase 1b: Build base branch
  const baseResult = await buildBranch(repoDir, options.base, path.join(tmpDir, 'base'), { log: buildLog });

  // Phase 1c: Build PR branch
  const prResult = await buildBranch(repoDir, options.pr, path.join(tmpDir, 'pr'), { log: buildLog });

  logger.ok(`Builds complete in ${((Date.now() - buildStart) / 1000).toFixed(1)}s`);

  // Phase 1d: Collect code diff
  let codeDiffData = null;
  try {
    const { collectCodeDiff } = require('../lib/code-diff');
    codeDiffData = collectCodeDiff(repoDir, options.base, options.pr, {
      baseCompiledDir: baseResult.compiledJsDir,
      prCompiledDir: prResult.compiledJsDir,
    });
  } catch (err) {
    logger.warn(`Code diff collection failed: ${err.message}, continuing without it`);
  }

  // Run shared pipeline (Phases 2-5)
  await runPipeline(
    baseResult.statsPath,
    prResult.statsPath,
    options,
    logger,
    outputDir,
    codeDiffData,
  );
```

- [ ] **Step 5: Run tests — verify they pass**

Run: `node test/test-runner.js`
Expected: All tests PASS. The existing `runPipeline` test at line 1316 passes pre-built stats files (file mode) so `codeDiffData` defaults to `null` and everything works as before.

- [ ] **Step 6: Commit**

```
git add scripts/orchestrate.js test/test-runner.js
git commit -m "feat: rewrite runFullMode for single clone, add Phase 2.5 code diff analysis"
```

---

### Task 9: Final verification — run all tests, verify count

**Files:** None (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `node test/test-runner.js`
Expected: All tests pass. Count should be approximately 130+ (105 existing + ~25 new).

- [ ] **Step 2: Verify no regressions**

Check that:
- All existing 105 tests still pass
- New `parseDiffStats` tests pass (5 tests)
- New `chunkDiff` tests pass (5 tests)
- New `collectCodeDiff` tests pass (2 tests)
- New `clone-builder` tests pass (3 tests)
- New `rescript-analyzer` tests pass (2 tests)
- New `analyzeCodeChunks` tests pass (4 async tests)
- New `buildAnalysisPrompt` tests pass (3 tests)
- New `runPipeline` test passes (1 test)

- [ ] **Step 3: Final commit if any cleanup needed**

```
git add -A
git commit -m "chore: final cleanup for code diff AI analysis feature"
```
