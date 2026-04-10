# AI Orchestration Refactor — Design Spec

## Problem

The current pipeline (`run.sh`) runs 8 steps sequentially, making **3 duplicate AI API calls** with identical inputs (analyze.js text, analyze.js JSON, cli.js). The two build phases (base + PR) are also sequential despite being independent. This wastes time and API quota.

## Goal

Replace the sequential shell-based pipeline with a Node.js orchestrator that:

1. Eliminates duplicate AI calls — single AI call, result shared across all report generators
2. Parallelizes independent work — builds run concurrently, reports generate concurrently
3. Enforces max 3 parallel tasks at any time
4. Merges `run.sh` and `cli.js` into a single entry point

## Approach

**Pipeline with Phases** — a single `scripts/orchestrate.js` structured as 5 named phases. Tasks within each phase run in parallel (bounded by a concurrency pool). Phases run sequentially since each depends on the previous.

## Pipeline

```
Phase 1 — Build (max 2 parallel)
  ├── cloneAndBuild(repoUrl, baseRef, "tmp/base") → baseStatsPath
  └── cloneAndBuild(repoUrl, prRef, "tmp/pr")     → prStatsPath

Phase 2 — Analyze (single call, fast ~ms)
  └── computeAnalysisInputs(baseStatsPath, prStatsPath) → { diff, summary, detections, baseStats, prStats }

Phase 3 — AI (single call, ~30s-5min)
  └── analyzeBundle(client, diff, detections, context) → aiResult
      (or analyzeOffline() if AI unavailable)

Phase 4 — Report (max 3 parallel)
  ├── generateAnalysisReport(diff, detections, aiResult, context)       → textReport (string)
  ├── generateJSONOutput({ diff, detections, ai: aiResult })            → jsonObject (Object, needs JSON.stringify for file output)
  ├── generateComment(analysis, options)                                → commentMarkdown (string)
  │     where analysis = { diff, ai: aiResult, detections, summary }
  │     (assembled by orchestrator to match comment.js's expected shape)
  └── diff.generateReport(diff, summary)                               → diffReport (string)
        (from scripts/diff.js, not analyze.js's generateAnalysisReport)

Phase 5 — Output (max 3 parallel)
  ├── writeFile(textReport → reports/analyze-report.txt)
  ├── writeFile(JSON.stringify(jsonOutput) → reports/analyze-output.json)
  ├── writeFile(commentMarkdown → reports/comment-report.md)
  ├── writeFile(diffReport → reports/diff-report.txt)
  └── upsertComment(commentMarkdown, { prNumber }) if --post-comment flag set
```

## Modes

### Full mode (replaces `run.sh`)

```
node scripts/orchestrate.js --base main --pr feat/x --repo-url <url>
```

Runs all 5 phases. Requires `REPO_URL` (from .env or `--repo-url`). Outputs all reports to `reports/`.

### File mode (replaces `cli.js --base-stats/--pr-stats`)

```
node scripts/orchestrate.js --base-stats base.json --pr-stats pr.json
```

Skips Phase 1, starts at Phase 2. For CI or when stats are pre-built.

## CLI Flags

```
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
```

## New Files

### `lib/concurrency.js`

A small utility (~20 lines) exporting `runWithConcurrency(tasks, maxConcurrency)`.

- `tasks`: array of `() => Promise` thunks
- `maxConcurrency`: number (default 3)
- Returns `Promise<results[]>` in original order
- Guarantees no more than `maxConcurrency` tasks in-flight at once
- Propagates errors — if a task throws, the pool rejects

```js
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
```

### `lib/clone-builder.js`

Programmatic equivalent of `run.sh`'s `clone_and_build` function.

```js
async function cloneAndBuild(repoUrl, branch, targetDir, options = {})
```

Steps (all via `child_process.execFile` for safety, except webpack via `spawn`):

1. `git clone --depth 1 --branch <branch> --single-branch <url> <dir>`
2. `git -C <dir> submodule update --init --recursive --depth 1`
3. `npm install --ignore-scripts --loglevel=error` (cwd: targetDir)
4. `npm run re:build` (cwd: targetDir) — ReScript compilation
5. Webpack build: `node_modules/.bin/webpack --config webpack.common.js --profile --json` with `NODE_ENV=production`, `sdkEnv=prod`, `SENTRY_DSN` defaulting. Captures stdout, extracts JSON, writes to `<targetDir>/stats.json`.

Returns `{ statsPath: string, cloneDir: string }`.

Uses `execFile` (not `exec`) — no shell injection risk. Webpack uses `spawn` for streaming large stdout.

**Cleanup:** The orchestrator is responsible for cleaning up the `tmp/` directory. It removes `tmp/` at the start of a full-mode run (same as current `run.sh`). Cloned directories are not removed after the run — they can be inspected for debugging. Users can manually delete `tmp/` or it gets cleaned on the next run.

### `scripts/orchestrate.js`

Single entry point. Merges `run.sh` + `cli.js`. Structure:

- `main()` — parses args, determines mode, runs pipeline
- `runFullMode(options)` — Phase 1-5
- `runFileMode(options)` — Phase 2-5
- `runPipeline(baseStatsPath, prStatsPath, options)` — Phases 2-5 (shared by both modes)
- Phase-based logging: `[Phase 1/5] Building base...`, timing per phase
- Colors only on TTY
- `--json` with no path suppresses all non-JSON output

## Modified Files

### `scripts/analyze.js`

Add `computeAnalysisInputs()` — extracts the diff + detection steps from `runAnalysis()`:

```js
function computeAnalysisInputs(baseStatsPath, prStatsPath, options = {}) {
  const { diff, summary, baseStats, prStats } = runDiff(baseStatsPath, prStatsPath, { ...options, silent: true });
  const detections = runDetection(diff, { baseStats: diff.baseStats });
  return { diff, summary, detections, baseStats, prStats };
}
```

New exports:

```js
module.exports = {
  runAnalysis,              // existing (kept for backward compat)
  computeAnalysisInputs,   // NEW
  generateAnalysisReport,  // existing
  generateJSONOutput,      // existing
};
```

`runAnalysis()` stays intact — it still works independently for any callers that use it directly.

## Deprecated Files

### `run.sh`

Becomes a 1-line shim for backward compatibility:

```bash
#!/usr/bin/env bash
exec node "$(dirname "$0")/scripts/orchestrate.js" "$@"
```

### `cli.js`

Becomes a shim:

```js
#!/usr/bin/env node
require('./scripts/orchestrate').main();
```

## Error Handling

- **Phase 1 (build):** If either build fails, report the error and exit immediately. No point continuing without both stats files.
- **Phase 2 (analyze):** Fatal — if `computeAnalysisInputs()` throws (corrupt stats JSON, missing file, detection error), report error and exit. These are synchronous and fast; failure means bad input data.
- **Phase 3 (AI):** Failure falls back to `analyzeOffline()`. Not fatal — same as current behavior.
- **Phase 4 (reports):** The orchestrator wraps each report generator in try/catch before passing to the concurrency pool. Failures are collected (not thrown). All report tasks run to completion. Failures summarized at the end. The pool itself still fail-fast rejects on errors — the try/catch wrapper prevents that from happening.
- **Phase 5 (output):** Same pattern as Phase 4 — tasks wrapped in try/catch, failures collected, non-fatal.
- Exit code 1 if critical bundle issues detected (from detections), same as current.
- Concurrency pool propagates errors — if a task throws, the pool rejects. Phases that need collect-errors semantics wrap tasks in try/catch before passing to the pool.

## Intentionally Removed from Pipeline

The current `run.sh` has two steps that are **not** carried forward:

- **Step 6 (CLI report):** `run.sh` runs `cli.js` which calls `runAnalysis()` a 3rd time, producing `cli-with-ai.txt` and `cli-json-output.json`. These are redundant with the text report and JSON output already generated in Phases 4-5. Eliminating this duplicate AI call is a primary goal of this refactor.
- **Step 8 (test execution):** `run.sh` runs `test/test-runner.js` as part of the pipeline. Tests are a development concern, not a report generation step. They should be run separately (e.g., `node test/test-runner.js`), not as part of every orchestrator run.

## Logging

- Structured phase-based: `[Phase 1/5] Building base and PR branches...`
- Each phase logs start/end time for performance visibility
- Colors only on TTY (same approach as current run.sh)
- `--json` flag with no path → stdout is clean JSON only, all logging suppressed

## Test Plan

Tests added to `test/test-runner.js` using existing custom test framework:

- **`lib/concurrency.js`:** max concurrency enforcement (verify no more than N run simultaneously), error propagation, empty task list, results in correct order
- **`lib/clone-builder.js`:** test with mock/stub (actual clone+build is integration-level)
- **`scripts/analyze.js`:** test `computeAnalysisInputs()` returns correct shape using existing sample fixtures
- **`scripts/orchestrate.js`:** test mode detection (full vs file), phase ordering, verify AI called exactly once

## Constraints

- Zero npm dependencies (vanilla Node.js)
- Max 3 parallel tasks at any time
- AI API timeout: 5 minutes (300,000ms)
- Single AI call per run — result shared across all report generators
