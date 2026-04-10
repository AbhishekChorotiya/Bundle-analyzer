# AI Orchestration Refactor — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the sequential shell-based pipeline with a parallelized Node.js orchestrator that makes a single AI call and enforces max-3 concurrency.

**Architecture:** A 5-phase pipeline in `scripts/orchestrate.js` — Build (parallel clones), Analyze (diff + detection), AI (single call), Report (parallel generation), Output (parallel writes). A concurrency pool utility enforces the max-3 constraint. `run.sh` and `cli.js` become thin shims.

**Tech Stack:** Vanilla Node.js (zero npm deps), child_process for builds, custom test runner.

**Spec:** `docs/superpowers/specs/2026-04-11-ai-orchestration-refactor-design.md`

---

## Chunk 1: Foundation Libraries & analyze.js Refactor

### Task 1: Create `lib/concurrency.js` with tests

**Files:**
- Create: `lib/concurrency.js`
- Modify: `test/test-runner.js`

- [ ] **Step 1: Write concurrency pool tests**

Add to `test/test-runner.js` before the summary section (before line 1120):

```js
// ─── Concurrency Pool Tests ────────────────────────────────────────────────
const { runWithConcurrency } = require('../lib/concurrency');

test('runWithConcurrency: returns results in order', async () => {
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

test('runWithConcurrency: enforces max concurrency', async () => {
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

test('runWithConcurrency: propagates errors', async () => {
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

test('runWithConcurrency: handles empty task list', async () => {
  const results = await runWithConcurrency([], 3);
  assertEqual(results.length, 0, 'Empty tasks should return empty results');
});

test('runWithConcurrency: single task works', async () => {
  const results = await runWithConcurrency([() => Promise.resolve(42)], 3);
  assertEqual(results.length, 1);
  assertEqual(results[0], 42);
});
```

Note: The test runner uses synchronous `test()` but these are async tests. We need to handle this. The existing test runner's `test()` function doesn't await async functions. We need to collect async tests and run them separately. Add this async test wrapper right after the `assertFalse` function (around line 46):

```js
const asyncTests = [];

function testAsync(name, fn) {
  asyncTests.push({ name, fn });
}
```

Then change the concurrency tests above to use `testAsync` instead of `test`.

Finally, at the end of the file (replacing the existing summary section at line 1120-1129), run async tests before printing summary:

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node test/test-runner.js`
Expected: FAIL — `Cannot find module '../lib/concurrency'`

- [ ] **Step 3: Implement `lib/concurrency.js`**

```js
/**
 * @fileoverview Concurrency Pool
 * Runs async tasks with bounded parallelism.
 */

/**
 * Run tasks with a maximum concurrency limit.
 * @param {Array<() => Promise>} tasks - Array of thunks returning promises
 * @param {number} maxConcurrency - Max tasks in-flight at once (default 3)
 * @returns {Promise<Array>} Results in original task order
 */
async function runWithConcurrency(tasks, maxConcurrency = 3) {
  const results = [];
  const executing = new Set();

  for (const task of tasks) {
    const p = task().then(result => {
      executing.delete(p);
      return result;
    });
    executing.add(p);
    results.push(p);

    if (executing.size >= maxConcurrency) {
      await Promise.race(executing);
    }
  }

  return Promise.all(results);
}

module.exports = { runWithConcurrency };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node test/test-runner.js`
Expected: All tests pass (67 existing + 5 new = 72)

- [ ] **Step 5: Commit**

```bash
git add lib/concurrency.js test/test-runner.js
git commit -m "Add concurrency pool utility with max-N parallelism"
```

---

### Task 2: Create `lib/clone-builder.js` with tests

**Files:**
- Create: `lib/clone-builder.js`
- Modify: `test/test-runner.js`

- [ ] **Step 1: Write clone-builder tests**

Add to `test/test-runner.js` using `testAsync`, before the async runner section:

```js
// ─── Clone Builder Tests ───────────────────────────────────────────────────
const { cloneAndBuild } = require('../lib/clone-builder');

test('cloneAndBuild: exported function exists', () => {
  assertEqual(typeof cloneAndBuild, 'function', 'cloneAndBuild should be a function');
});

testAsync('cloneAndBuild: rejects with invalid repo URL', async () => {
  // We can't test real clones in unit tests, but we can test error handling
  // for invalid inputs
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
```

Note: The second test uses `testAsync` since it's async.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node test/test-runner.js`
Expected: FAIL — `Cannot find module '../lib/clone-builder'`

- [ ] **Step 3: Implement `lib/clone-builder.js`**

```js
/**
 * @fileoverview Clone Builder
 * Programmatic clone + build for a git branch.
 * Produces webpack stats JSON in an isolated directory.
 */

const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

/**
 * Run a command via execFile and return a promise.
 * @param {string} cmd - Command to run
 * @param {string[]} args - Arguments
 * @param {Object} options - execFile options
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
function run(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 50 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${cmd} ${args.join(' ')} failed: ${error.message}\n${stderr}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

/**
 * Run webpack via spawn and capture stdout (stats JSON can be very large).
 * @param {string} cwd - Working directory
 * @param {Object} options - Build options
 * @returns {Promise<string>} Raw stdout
 */
function runWebpack(cwd, options = {}) {
  return new Promise((resolve, reject) => {
    const webpackBin = path.join(cwd, 'node_modules', '.bin', 'webpack');
    const args = ['--config', 'webpack.common.js', '--profile', '--json'];

    const child = spawn(webpackBin, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        NODE_ENV: 'production',
        sdkEnv: 'prod',
        SENTRY_DSN: process.env.SENTRY_DSN || 'https://dummy@o0.ingest.sentry.io/0',
      },
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });

    child.on('close', code => {
      if (code !== 0 && !stdout.includes('{')) {
        reject(new Error(`webpack exited with code ${code}: ${stderr}`));
        return;
      }
      resolve(stdout);
    });

    child.on('error', err => {
      reject(new Error(`Failed to spawn webpack: ${err.message}`));
    });
  });
}

/**
 * Clone a branch and build webpack stats.
 * @param {string} repoUrl - Git clone URL
 * @param {string} branch - Branch name to clone
 * @param {string} targetDir - Directory to clone into
 * @param {Object} options
 * @param {Function} [options.log] - Logging function (default: console.log)
 * @returns {Promise<{statsPath: string, cloneDir: string}>}
 */
async function cloneAndBuild(repoUrl, branch, targetDir, options = {}) {
  const log = options.log || console.log;

  // Step 1: Clone
  log(`  Cloning ${branch}...`);
  await run('git', ['clone', '--depth', '1', '--branch', branch, '--single-branch', repoUrl, targetDir]);

  // Step 2: Init submodules
  log(`  Initializing submodules...`);
  await run('git', ['-C', targetDir, 'submodule', 'update', '--init', '--recursive', '--depth', '1']);

  // Step 3: Install dependencies
  log(`  Installing dependencies...`);
  await run('npm', ['install', '--ignore-scripts', '--loglevel=error'], { cwd: targetDir });

  // Step 4: ReScript build
  log(`  Compiling ReScript sources...`);
  await run('npm', ['run', 're:build'], { cwd: targetDir });

  // Step 5: Webpack build
  log(`  Building production bundle...`);
  const rawOutput = await runWebpack(targetDir, options);

  // Extract JSON from webpack output
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

  const statsPath = path.join(targetDir, 'stats.json');
  fs.writeFileSync(statsPath, jsonContent);

  log(`  Stats saved: ${statsPath}`);

  return { statsPath, cloneDir: targetDir };
}

module.exports = { cloneAndBuild };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node test/test-runner.js`
Expected: All tests pass (72 + 2 = 74). The invalid URL test will fail fast on git clone error.

- [ ] **Step 5: Commit**

```bash
git add lib/clone-builder.js test/test-runner.js
git commit -m "Add clone-builder for programmatic branch clone and build"
```

---

### Task 3: Add `computeAnalysisInputs()` to `scripts/analyze.js` with tests

**Files:**
- Modify: `scripts/analyze.js:24-77` (add new function, update exports)
- Modify: `test/test-runner.js`

- [ ] **Step 1: Write tests for computeAnalysisInputs**

Add to `test/test-runner.js` (sync tests, before async section):

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node test/test-runner.js`
Expected: FAIL — `computeAnalysisInputs is not a function` (not exported yet)

- [ ] **Step 3: Add `computeAnalysisInputs()` to `scripts/analyze.js`**

Add the function before the `runAnalysis` function (after line 14, before line 16):

```js
/**
 * Compute diff and run detection rules — the non-AI steps of analysis.
 * Used by the orchestrator to separate data computation from AI + report generation.
 * @param {string} baseStatsPath - Path to base stats
 * @param {string} prStatsPath - Path to PR stats
 * @param {Object} options
 * @returns {Object} { diff, summary, detections, baseStats, prStats }
 */
function computeAnalysisInputs(baseStatsPath, prStatsPath, options = {}) {
  const { diff, summary, baseStats, prStats } = runDiff(baseStatsPath, prStatsPath, { ...options, silent: true });
  const detections = runDetection(diff, { baseStats: diff.baseStats });
  return { diff, summary, detections, baseStats, prStats };
}
```

Update the exports at the bottom of the file (line 567-571):

```js
module.exports = {
  runAnalysis,
  computeAnalysisInputs,
  generateAnalysisReport,
  generateJSONOutput,
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node test/test-runner.js`
Expected: All tests pass (74 + 2 = 76)

- [ ] **Step 5: Commit**

```bash
git add scripts/analyze.js test/test-runner.js
git commit -m "Extract computeAnalysisInputs from runAnalysis for orchestrator use"
```

---

## Chunk 2: The Orchestrator

### Task 4: Create `scripts/orchestrate.js` — argument parsing and mode detection

**Files:**
- Create: `scripts/orchestrate.js`
- Modify: `test/test-runner.js`

- [ ] **Step 1: Write tests for parseArgs and mode detection**

Add to `test/test-runner.js` (sync tests):

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node test/test-runner.js`
Expected: FAIL — `Cannot find module '../scripts/orchestrate'`

- [ ] **Step 3: Create `scripts/orchestrate.js` with arg parsing and mode detection**

```js
#!/usr/bin/env node
/**
 * @fileoverview Orchestrator
 * Single entry point for bundle analysis pipeline.
 * Replaces run.sh and cli.js with parallelized Node.js orchestration.
 *
 * Modes:
 *   Full:  node orchestrate.js --base main --pr feat/x --repo-url <url>
 *   File:  node orchestrate.js --base-stats base.json --pr-stats pr.json
 */

const fs = require('fs');
const path = require('path');
const { loadEnv } = require('../lib/utils');

loadEnv(path.join(__dirname, '..', '.env'));

// ── Colors (only on TTY) ─────────────────────────────────────────────────
const isTTY = process.stdout.isTTY === true;
const C = {
  bold: isTTY ? '\x1b[1m' : '',
  cyan: isTTY ? '\x1b[36m' : '',
  green: isTTY ? '\x1b[32m' : '',
  yellow: isTTY ? '\x1b[33m' : '',
  red: isTTY ? '\x1b[31m' : '',
  reset: isTTY ? '\x1b[0m' : '',
};

/**
 * Parse CLI arguments.
 * @param {string[]} args
 * @returns {Object}
 */
function parseArgs(args) {
  const options = {
    base: 'main',
    model: 'kimi-latest',
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = () => {
      if (!args[i + 1] || args[i + 1].startsWith('--')) return null;
      return args[++i];
    };

    switch (arg) {
      // Build mode
      case '--base': case '-b': options.base = args[++i]; break;
      case '--pr': case '-p': options.pr = args[++i]; break;
      case '--repo-url': options.repoUrl = args[++i]; break;

      // File mode
      case '--base-stats': options.baseStats = args[++i]; break;
      case '--pr-stats': options.prStats = args[++i]; break;

      // Analysis
      case '--skip-ai': options.skipAI = true; break;
      case '--model': case '-m': options.model = args[++i]; break;
      case '--lines': case '-l': options.lines = args[++i]; break;

      // Output
      case '--json': case '-j': {
        const val = next();
        options.json = val || true;
        break;
      }
      case '--comment-file': options.commentFile = args[++i]; break;
      case '--post-comment': options.postComment = true; break;
      case '--pr-number': options.prNumber = args[++i]; break;
      case '--output-dir': options.outputDir = args[++i]; break;

      // Other
      case '--verbose': case '-v': options.verbose = true; break;
      case '--help': case '-h': options.help = true; break;
      case '--version': options.version = true; break;
    }
  }

  return options;
}

/**
 * Determine pipeline mode from parsed options.
 * @param {Object} options
 * @returns {'full'|'file'|null}
 */
function determineMode(options) {
  if (options.baseStats && options.prStats) return 'file';
  if (options.base && options.pr && options.repoUrl) return 'full';
  if (options.base && options.pr) {
    // Check env for REPO_URL
    if (process.env.REPO_URL) return 'full';
  }
  return null;
}

/**
 * Create a logger that respects --json (stdout-only) mode.
 * @param {Object} options
 * @returns {Object} Logger with info, ok, warn, fail methods
 */
function createLogger(options) {
  const silent = options.json === true; // --json with no path = stdout mode
  const log = silent ? () => {} : console.log;
  const err = silent ? () => {} : console.error;

  return {
    info: (msg) => log(`${C.cyan}${C.bold}▸${C.reset} ${msg}`),
    ok: (msg) => log(`${C.green}✓${C.reset} ${msg}`),
    warn: (msg) => log(`${C.yellow}⚠${C.reset} ${msg}`),
    fail: (msg) => { err(`${C.red}✗${C.reset} ${msg}`); },
    phase: (n, total, msg) => log(`\n${C.cyan}[Phase ${n}/${total}]${C.reset} ${msg}`),
    log,
  };
}

/**
 * Print help message.
 */
function printHelp() {
  console.log(`
Hyperswitch Bundle AI — Orchestrator

Usage:
  Full mode:  node orchestrate.js --base main --pr feat/x --repo-url <url>
  File mode:  node orchestrate.js --base-stats base.json --pr-stats pr.json

Build:
  --base <branch>         Base branch (default: main)
  --pr <branch>           PR branch (default: current git branch)
  --repo-url <url>        Git clone URL (or REPO_URL env)

File mode:
  --base-stats <path>     Pre-built base stats JSON
  --pr-stats <path>       Pre-built PR stats JSON

Analysis:
  --skip-ai               Skip AI, use offline analysis
  --model <model>         AI model (default: kimi-latest)
  --lines <n>             Lines changed in PR

Output:
  --json [path]           Output JSON (stdout if no path)
  --comment-file <path>   Save PR comment markdown
  --post-comment          Post/update comment on GitHub PR
  --pr-number <n>         PR number for posting
  --output-dir <path>     Reports directory (default: reports/)

Other:
  -v, --verbose           Detailed output
  -h, --help              Help
  --version               Version
`);
}

/**
 * Main entry point.
 */
async function main() {
  const args = process.argv.slice(2);
  const options = parseArgs(args);

  if (options.help) {
    printHelp();
    process.exit(0);
  }

  if (options.version) {
    console.log('Bundle AI v1.0.0');
    process.exit(0);
  }

  const mode = determineMode(options);

  if (!mode) {
    console.error('Error: Provide --base-stats/--pr-stats for file mode, or --base/--pr/--repo-url for full mode.');
    printHelp();
    process.exit(1);
  }

  // Resolve repo URL from env if not provided via flag
  if (mode === 'full' && !options.repoUrl) {
    options.repoUrl = process.env.REPO_URL;
  }

  // Auto-detect PR branch from git if not provided
  if (mode === 'full' && !options.pr) {
    try {
      const { execSync } = require('child_process');
      options.pr = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf-8' }).trim();
    } catch {
      console.error('Error: Could not detect current branch. Use --pr <branch>.');
      process.exit(1);
    }
  }

  if (mode === 'full') {
    await runFullMode(options);
  } else {
    await runFileMode(options);
  }
}

// Placeholder — implemented in Task 5
async function runFullMode(options) {
  throw new Error('runFullMode not yet implemented');
}

// Placeholder — implemented in Task 5
async function runFileMode(options) {
  throw new Error('runFileMode not yet implemented');
}

// CLI entry
if (require.main === module) {
  main().catch(error => {
    console.error(`\n${C.red}✗${C.reset} Fatal: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { parseArgs, determineMode, createLogger, main };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node test/test-runner.js`
Expected: All tests pass (76 + 9 = 85)

- [ ] **Step 5: Commit**

```bash
git add scripts/orchestrate.js test/test-runner.js
git commit -m "Add orchestrator with arg parsing and mode detection"
```

---

### Task 5: Implement `runPipeline`, `runFullMode`, and `runFileMode` in orchestrate.js

**Files:**
- Modify: `scripts/orchestrate.js` (replace placeholders with full implementation)

- [ ] **Step 1: Write integration-style test for runPipeline (file mode)**

Add to `test/test-runner.js` using `testAsync`:

```js
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
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `node test/test-runner.js`
Expected: PASS — this test uses existing modules directly, not orchestrate.js's pipeline. It validates the Phase 2-4 flow works.

- [ ] **Step 3: Implement `runPipeline` in `scripts/orchestrate.js`**

Replace the placeholder `runFullMode` and `runFileMode` functions and add `runPipeline`:

```js
const { runWithConcurrency } = require('../lib/concurrency');
const { cloneAndBuild } = require('../lib/clone-builder');
const { computeAnalysisInputs, generateAnalysisReport, generateJSONOutput } = require('./analyze');
const { generateComment, upsertComment } = require('./comment');
const { generateReport: generateDiffReport } = require('./diff');
const { createClient, analyzeBundle, analyzeOffline, isAIAvailable } = require('../lib/ai-client');

/**
 * Run full mode: clone + build + pipeline.
 * @param {Object} options
 */
async function runFullMode(options) {
  const logger = createLogger(options);
  const outputDir = path.resolve(options.outputDir || 'reports');
  const tmpDir = path.resolve('tmp');

  // Banner
  logger.log('');
  logger.log(`${C.cyan}╔══════════════════════════════════════════════════════════╗${C.reset}`);
  logger.log(`${C.cyan}║        HYPERSWITCH BUNDLE AI — ORCHESTRATOR             ║${C.reset}`);
  logger.log(`${C.cyan}╚══════════════════════════════════════════════════════════╝${C.reset}`);
  logger.log('');
  logger.log(`Base: ${options.base}`);
  logger.log(`PR:   ${options.pr}`);
  logger.log(`Repo: ${options.repoUrl}`);
  logger.log('');

  // Clean tmp
  if (fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true });
  }
  fs.mkdirSync(tmpDir, { recursive: true });

  // Phase 1: Build (max 2 parallel)
  logger.phase(1, 5, 'Building base and PR branches...');
  const buildStart = Date.now();

  const buildLog = options.verbose ? logger.info.bind(logger) : () => {};

  const [baseResult, prResult] = await runWithConcurrency([
    () => cloneAndBuild(options.repoUrl, options.base, path.join(tmpDir, 'base'), { log: buildLog }),
    () => cloneAndBuild(options.repoUrl, options.pr, path.join(tmpDir, 'pr'), { log: buildLog }),
  ], 2);

  logger.ok(`Builds complete in ${((Date.now() - buildStart) / 1000).toFixed(1)}s`);

  // Run shared pipeline (Phases 2-5)
  await runPipeline(baseResult.statsPath, prResult.statsPath, options, logger, outputDir);
}

/**
 * Run file mode: skip builds, run pipeline on pre-built stats.
 * @param {Object} options
 */
async function runFileMode(options) {
  const logger = createLogger(options);
  const outputDir = path.resolve(options.outputDir || 'reports');

  // Verify files exist
  if (!fs.existsSync(options.baseStats)) {
    throw new Error(`Base stats file not found: ${options.baseStats}`);
  }
  if (!fs.existsSync(options.prStats)) {
    throw new Error(`PR stats file not found: ${options.prStats}`);
  }

  if (options.json !== true) {
    logger.log('');
    logger.log(`${C.cyan}╔══════════════════════════════════════════════════════════╗${C.reset}`);
    logger.log(`${C.cyan}║        HYPERSWITCH BUNDLE AI — ORCHESTRATOR             ║${C.reset}`);
    logger.log(`${C.cyan}╚══════════════════════════════════════════════════════════╝${C.reset}`);
    logger.log('');
    logger.info(`Base stats: ${options.baseStats}`);
    logger.info(`PR stats: ${options.prStats}`);
    logger.log('');
  }

  await runPipeline(options.baseStats, options.prStats, options, logger, outputDir);
}

/**
 * Run the shared analysis pipeline (Phases 2-5).
 * @param {string} baseStatsPath
 * @param {string} prStatsPath
 * @param {Object} options
 * @param {Object} logger
 * @param {string} outputDir
 */
async function runPipeline(baseStatsPath, prStatsPath, options, logger, outputDir) {
  const errors = [];

  // Phase 2: Analyze
  logger.phase(2, 5, 'Computing diff and running detection rules...');
  const analyzeStart = Date.now();

  const { diff, summary, detections, baseStats, prStats } = computeAnalysisInputs(baseStatsPath, prStatsPath);

  logger.ok(`${diff.allChanges.length} changes, ${detections.violations.length} issues (${((Date.now() - analyzeStart) / 1000).toFixed(1)}s)`);

  // Phase 3: AI
  logger.phase(3, 5, 'Running AI analysis...');
  const aiStart = Date.now();

  let aiResult;
  const context = {};
  if (options.lines) {
    context.linesChanged = parseInt(options.lines, 10);
  }
  const enrichedContext = { ...context, rawStats: { baseStats, prStats } };

  if (!options.skipAI && isAIAvailable()) {
    try {
      const client = createClient({ model: options.model });
      aiResult = await analyzeBundle(client, diff, detections, enrichedContext);
      logger.ok(`AI: ${aiResult.verdict} (${(aiResult.confidence * 100).toFixed(0)}% confidence, ${((Date.now() - aiStart) / 1000).toFixed(1)}s)`);
    } catch (error) {
      logger.warn(`AI failed: ${error.message}, using offline analysis`);
      aiResult = analyzeOffline(diff, detections);
    }
  } else {
    logger.info('Offline analysis (no AI available)');
    aiResult = analyzeOffline(diff, detections);
  }

  // Phase 4: Reports (max 3 parallel)
  logger.phase(4, 5, 'Generating reports...');
  const reportStart = Date.now();

  const analysis = { diff, ai: aiResult, detections, summary };

  const reportTasks = [
    () => {
      try { return { key: 'text', value: generateAnalysisReport(diff, detections, aiResult, context) }; }
      catch (e) { errors.push({ phase: 'report', name: 'text', error: e }); return { key: 'text', value: null }; }
    },
    () => {
      try { return { key: 'json', value: generateJSONOutput({ diff, detections, ai: aiResult }) }; }
      catch (e) { errors.push({ phase: 'report', name: 'json', error: e }); return { key: 'json', value: null }; }
    },
    () => {
      try { return { key: 'comment', value: generateComment(analysis) }; }
      catch (e) { errors.push({ phase: 'report', name: 'comment', error: e }); return { key: 'comment', value: null }; }
    },
    () => {
      try { return { key: 'diff', value: generateDiffReport(diff, summary) }; }
      catch (e) { errors.push({ phase: 'report', name: 'diff', error: e }); return { key: 'diff', value: null }; }
    },
  ].map(fn => () => Promise.resolve(fn()));

  const reportResults = await runWithConcurrency(reportTasks, 3);
  const reports = {};
  for (const r of reportResults) {
    reports[r.key] = r.value;
  }

  logger.ok(`Reports generated (${((Date.now() - reportStart) / 1000).toFixed(1)}s)`);

  // If --json with no path (stdout mode), output JSON and return
  if (options.json === true) {
    if (reports.json) {
      process.stdout.write(JSON.stringify(reports.json, null, 2) + '\n');
    }
    process.exit(detections.hasCriticalIssues ? 1 : 0);
    return;
  }

  // Print text report to console
  if (reports.text) {
    logger.log('');
    logger.log(reports.text);
  }

  // Phase 5: Output (max 3 parallel)
  logger.phase(5, 5, 'Saving reports...');
  const outputStart = Date.now();

  fs.mkdirSync(outputDir, { recursive: true });

  const outputTasks = [];

  if (reports.text) {
    outputTasks.push(() => {
      try {
        fs.writeFileSync(path.join(outputDir, 'analyze-report.txt'), reports.text);
        return { name: 'analyze-report.txt', ok: true };
      } catch (e) { errors.push({ phase: 'output', name: 'analyze-report.txt', error: e }); return { name: 'analyze-report.txt', ok: false }; }
    });
  }

  if (reports.json) {
    outputTasks.push(() => {
      try {
        fs.writeFileSync(path.join(outputDir, 'analyze-output.json'), JSON.stringify(reports.json, null, 2));
        return { name: 'analyze-output.json', ok: true };
      } catch (e) { errors.push({ phase: 'output', name: 'analyze-output.json', error: e }); return { name: 'analyze-output.json', ok: false }; }
    });
  }

  if (reports.comment) {
    outputTasks.push(() => {
      try {
        const commentPath = options.commentFile || path.join(outputDir, 'comment-report.md');
        fs.writeFileSync(commentPath, reports.comment);
        return { name: 'comment-report.md', ok: true };
      } catch (e) { errors.push({ phase: 'output', name: 'comment-report.md', error: e }); return { name: 'comment-report.md', ok: false }; }
    });
  }

  if (reports.diff) {
    outputTasks.push(() => {
      try {
        fs.writeFileSync(path.join(outputDir, 'diff-report.txt'), reports.diff);
        return { name: 'diff-report.txt', ok: true };
      } catch (e) { errors.push({ phase: 'output', name: 'diff-report.txt', error: e }); return { name: 'diff-report.txt', ok: false }; }
    });
  }

  // Save JSON to custom path if specified
  if (typeof options.json === 'string' && reports.json) {
    outputTasks.push(() => {
      try {
        fs.writeFileSync(options.json, JSON.stringify(reports.json, null, 2));
        return { name: options.json, ok: true };
      } catch (e) { errors.push({ phase: 'output', name: options.json, error: e }); return { name: options.json, ok: false }; }
    });
  }

  // Post comment to GitHub
  if (options.postComment && reports.comment) {
    outputTasks.push(async () => {
      try {
        await upsertComment(reports.comment, { prNumber: options.prNumber });
        return { name: 'GitHub comment', ok: true };
      } catch (e) { errors.push({ phase: 'output', name: 'GitHub comment', error: e }); return { name: 'GitHub comment', ok: false }; }
    });
  }

  const outputResults = await runWithConcurrency(outputTasks.map(fn => () => Promise.resolve(fn())), 3);

  for (const r of outputResults) {
    if (r.ok) {
      logger.ok(`Saved: ${r.name}`);
    } else {
      logger.warn(`Failed: ${r.name}`);
    }
  }

  logger.ok(`Output complete (${((Date.now() - outputStart) / 1000).toFixed(1)}s)`);

  // Summary
  logger.log('');
  if (aiResult) {
    logger.log(`AI Verdict: ${C.bold}${aiResult.verdict}${C.reset} (${(aiResult.confidence * 100).toFixed(0)}% confidence)`);
  }

  // Report errors
  if (errors.length > 0) {
    logger.log('');
    logger.warn(`${errors.length} non-fatal error(s):`);
    for (const e of errors) {
      logger.warn(`  [${e.phase}] ${e.name}: ${e.error.message}`);
    }
  }

  logger.log('');
  process.exit(detections.hasCriticalIssues ? 1 : 0);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node test/test-runner.js`
Expected: All tests pass (85 + 1 = 86)

- [ ] **Step 5: Commit**

```bash
git add scripts/orchestrate.js test/test-runner.js
git commit -m "Implement orchestrator pipeline with parallel report generation"
```

---

## Chunk 3: Shims & Final Integration

### Task 6: Replace `run.sh` and `cli.js` with shims

**Files:**
- Modify: `run.sh`
- Modify: `cli.js`

- [ ] **Step 1: Replace `run.sh` with shim**

Replace the entire contents of `run.sh` with:

```bash
#!/usr/bin/env bash
# Shim — delegates to Node.js orchestrator.
# See scripts/orchestrate.js for the actual implementation.
exec node "$(dirname "$0")/scripts/orchestrate.js" "$@"
```

- [ ] **Step 2: Replace `cli.js` with shim**

Replace the entire contents of `cli.js` with:

```js
#!/usr/bin/env node
/**
 * @fileoverview CLI shim — delegates to orchestrator.
 * See scripts/orchestrate.js for the actual implementation.
 */
require('./scripts/orchestrate').main();
```

- [ ] **Step 3: Run tests to verify nothing broke**

Run: `node test/test-runner.js`
Expected: All tests pass (86). The test file imports from `scripts/analyze`, `scripts/comment`, `scripts/diff`, `lib/*` — not from `cli.js`, so the shim change is safe.

- [ ] **Step 4: Verify orchestrator help works**

Run: `node scripts/orchestrate.js --help`
Expected: Prints help text with usage examples.

Run: `node cli.js --help`
Expected: Same help text (via shim).

- [ ] **Step 5: Commit**

```bash
git add run.sh cli.js
git commit -m "Replace run.sh and cli.js with shims delegating to orchestrator"
```

---

### Task 7: Final verification

**Files:** None (verification only)

- [ ] **Step 1: Run all tests**

Run: `node test/test-runner.js`
Expected: All 86 tests pass.

- [ ] **Step 2: Verify file mode works end-to-end**

Run: `node scripts/orchestrate.js --base-stats test/sample-base-stats.json --pr-stats test/sample-pr-stats.json --skip-ai --output-dir tmp/test-reports`
Expected: Phases 2-5 run, reports are generated in `tmp/test-reports/`.

- [ ] **Step 3: Verify JSON stdout mode works**

Run: `node scripts/orchestrate.js --base-stats test/sample-base-stats.json --pr-stats test/sample-pr-stats.json --skip-ai --json 2>/dev/null | node -e "const j=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); console.log(j.aiAnalysis.verdict)"`
Expected: Prints `expected` or `unexpected` or `needs_review` (clean JSON, no logging mixed in).

- [ ] **Step 4: Clean up test artifacts**

```bash
rm -rf tmp/test-reports
```
