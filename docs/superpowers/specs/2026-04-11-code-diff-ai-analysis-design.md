# Code Diff AI Analysis — Design Spec

## Problem

The AI analyzer operates exclusively on webpack bundle stats — module sizes, import chains, and tree-shaking data. It never sees the actual code changes that caused the bundle diff. This limits accuracy in three ways:

1. **Cannot determine developer intent** — knows "lodash was added (+72 KB)" but can't see that the developer only called `cloneDeep` once, so it can't suggest `structuredClone` as an alternative.
2. **Cannot correlate source changes to bundle impact** — a 3-line ReScript change might pull in a 200 KB dependency, but the AI only sees the dependency appear with no link to the source edit.
3. **Cannot assess proportionality** — the `detectSuddenSizeSpike` rule uses a `linesChanged` number, but that's a manual CLI flag (`--lines <n>`) that nobody passes. The AI prompt shows "Files Changed: Unknown" for almost every run.

Additionally, `lib/rescript-analyzer.js` exists with working ReScript import analysis and bundle correlation logic, but was never wired into the pipeline because the architecture (two separate shallow clones) made `git diff` impossible.

## Goal

Give the AI full visibility into what code actually changed, so it can:

1. Correlate source edits to bundle impact with file-level precision
2. Identify unnecessary imports, unused dependency additions, and over-broad changes
3. Auto-compute `linesChanged` instead of requiring a manual flag
4. Provide suggestions that reference the developer's actual code, not just webpack module names

## Constraints

- Zero npm dependencies — all git/diff operations via `child_process`
- Full mode only — file mode (pre-built stats) skips code diff gracefully
- Existing AI output format unchanged (verdict, confidence, rootCause, fixes, metadata)
- Existing report formats unchanged (comment, text, JSON, diff)
- Cost is not a concern — multiple AI API calls are acceptable

## Approach

**Parallel chunked analysis** — collect the full git diff (source + compiled JS), split into file-group chunks, analyze each chunk via concurrent AI calls (max 3 in-flight, using `runWithConcurrency` pool), then feed merged chunk summaries into the final bundle analysis call alongside all existing bundle data.

## Architecture

### New Pipeline (Full Mode)

```
Phase 1 — Clone & Build (sequential within single repo)
  ├── git clone <url> tmp/repo            (full clone, no --depth 1)
  ├── git checkout <baseBranch>
  │   ├── npm install + re:build + webpack → baseStats
  │   └── save compiled JS snapshot: tmp/base-compiled/
  ├── git checkout <prBranch>
  │   ├── npm install + re:build + webpack → prStats  
  │   └── save compiled JS snapshot: tmp/pr-compiled/
  └── git diff <baseBranch>...<prBranch>   → codeDiff

Phase 2 — Analyze (unchanged)
  └── computeAnalysisInputs(baseStats, prStats) → { diff, summary, detections }

Phase 2.5 — Code Diff Analysis (NEW, parallel)
  ├── collectCodeDiff(repoDir, base, pr)  → { sourceDiff, compiledDiff, linesChanged, fileStats }
  ├── analyzeReScriptChanges(base, pr)    → reScriptAnalysis (existing, now wired in)
  ├── chunkDiff(sourceDiff + compiledDiff) → chunks[]
  └── analyzeCodeChunks(chunks, max3)     → CodeDiffSummary (merged)
      Concurrent pool (max 3 in-flight), each chunk returns:
        { filesAnalyzed, keyChanges[], riskAreas[], newImports[], removedImports[] }

Phase 3 — AI Final Analysis (enhanced)
  └── analyzeBundle(client, diff, detections, enrichedContext)
      enrichedContext now includes:
        - codeDiffSummary: merged chunk summaries
        - reScriptAnalysis: ReScript import/correlation data
        - linesChanged: auto-computed from diff stats
        - rawStats: unchanged

Phase 4 — Reports (unchanged)
Phase 5 — Output (unchanged)
```

### File Mode (unchanged)

File mode skips Phase 1 and Phase 2.5 entirely. The AI receives the same data as today — no code diff, `linesChanged` from `--lines` flag or "Unknown". All existing behavior preserved.

## Components

### 1. `lib/clone-builder.js` — Replace dual shallow clone with single full clone

**Current:** `cloneAndBuild(url, branch, dir)` — shallow clones a single branch, builds, returns `{ statsPath, cloneDir }`.

**New:** Two functions.

`cloneRepo(repoUrl, targetDir, options)`:
- `git clone <url> <dir>` (no `--depth 1`, no `--single-branch`)
- `git submodule update --init --recursive`
- Returns `{ repoDir }`

`buildBranch(repoDir, branch, outputDir, options)`:
- `git checkout <branch>` (in the cloned repo)
- `git clean -fdx -e node_modules` (remove build artifacts but preserve `node_modules/` for faster sequential builds — npm install will reconcile via lockfile)
- `npm install --ignore-scripts`
- `npm run re:build`
- Copy `lib/js/` → `outputDir/compiled-js/` using `cp -r` (ReScript compiles to `lib/js/` in this project)
- `webpack --config webpack.common.js --profile --json` → save stats
- Returns `{ statsPath, compiledJsDir }`

**Why split:** We need to build both branches sequentially in the same repo (can't parallel-build in a single working tree), and we need the compiled JS snapshots for diffing.

**Trade-off:** Slower than parallel shallow clones (sequential builds in one repo vs parallel builds in two repos). Necessary cost for `git diff` capability. Using `-e node_modules` on `git clean` preserves the dependency tree between branch switches, so the second `npm install` only reconciles lockfile differences rather than installing from scratch.

### 2. New `lib/code-diff.js` — Diff collection, parsing, and chunking

**Exports:**

```js
/**
 * Collect code diff between two branches in a git repo.
 * @param {string} repoDir - Path to the cloned repo
 * @param {string} baseBranch - Base branch name
 * @param {string} prBranch - PR branch name  
 * @returns {{ sourceDiff: string, compiledDiff: string, linesChanged: number, fileStats: FileStats[], repoDir: string, baseBranch: string, prBranch: string }}
 */
function collectCodeDiff(repoDir, baseBranch, prBranch)

/**
 * Split a unified diff into chunks for parallel AI analysis.
 * Groups files to keep each chunk under maxBytes.
 * @param {string} diffText - Full unified diff
 * @param {number} [maxBytes=50000] - Max bytes per chunk (~12K tokens, targets GPT-4o/Claude 128K context windows with comfortable headroom. Configurable via `CODE_DIFF_CHUNK_MAX_BYTES` env var.)
 * @returns {string[]} Array of diff chunks
 */
function chunkDiff(diffText, maxBytes)

/**
 * Parse unified diff output into per-file stats.
 * @param {string} diffText - Raw git diff output
 * @returns {FileStats[]} Per-file line counts
 */
function parseDiffStats(diffText)
```

**`FileStats` shape:**
```js
{ filePath: string, linesAdded: number, linesRemoved: number, isBinary: boolean }
```

**`collectCodeDiff` implementation:**

1. Run `git diff <baseBranch>...<prBranch>` in `repoDir` → full source diff
2. Separate the diff into:
   - `sourceDiff`: `git diff baseBranch...prBranch -- ':!lib/js/' ':!lib/es6/' ':!node_modules/' ':!dist/'` — everything except compiled output and build artifacts
   - `compiledDiff`: changes to `lib/js/**` and `lib/es6/**` only (ReScript compiled output) — produced separately via `git diff --no-index` on saved snapshots (see below)
3. Parse diff stats from the full output to compute `linesChanged` (sum of additions + deletions across source files)
4. Return all four pieces

**`chunkDiff` implementation:**

1. Split the unified diff by file boundaries (`^diff --git` lines)
2. Group files into chunks, each staying under `maxBytes`
3. If a single file exceeds `maxBytes`, include it as its own chunk (never truncate)
4. Return array of chunk strings

**Diff for compiled JS:**
Instead of `git diff` (which requires both builds in the same repo's working tree — they aren't, since we clean between builds), we diff the saved snapshots:
- After building base: copy `lib/js/` → `tmp/base-compiled/`
- After building PR: copy `lib/js/` → `tmp/pr-compiled/`
- Use `git diff --no-index tmp/base-compiled/ tmp/pr-compiled/` to produce a unified diff of the compiled JS

**Why `git diff --no-index` instead of `diff -ruN`:** `chunkDiff` splits on `^diff --git` boundary lines, which is git diff output format. System `diff -ruN` produces `diff -ruN a/file b/file` headers instead, so the entire compiled diff would be treated as one giant chunk. `git diff --no-index` works on arbitrary filesystem paths (no git repo needed) and produces git-format output with `diff --git a/... b/...` headers that `chunkDiff` can split correctly. Note: `git diff --no-index` exits with code 1 when differences are found (not an error), so the `execSync` call must handle this (e.g., wrap in try/catch or use `spawnSync` and check `status !== 2`).

**Path rewriting for compiled JS diff:** `git diff --no-index tmp/base-compiled/ tmp/pr-compiled/` produces paths like `a/tmp/base-compiled/Foo.js` and `b/tmp/pr-compiled/Foo.js`. These temp directory paths are meaningless to the AI. After generating the compiled diff, `collectCodeDiff` must rewrite paths to repo-relative form by replacing `a/tmp/base-compiled/` → `a/lib/js/` and `b/tmp/pr-compiled/` → `b/lib/js/` (simple string replacement on the diff output). This ensures the AI sees `lib/js/Foo.js` and can correlate compiled JS files back to the project structure.

### 3. `lib/ai-client.js` — New chunk analysis prompt + enhanced final prompt

**New function: `analyzeCodeChunk(client, chunkDiff, chunkIndex, totalChunks)`**

System prompt for chunk analysis (separate from the existing `SYSTEM_PROMPT`):

```
You are analyzing a code diff chunk for a ReScript/React webpack application (Hyperswitch Web SDK).
This is chunk {chunkIndex} of {totalChunks} from a pull request diff.

Analyze the code changes and extract structured information:
1. What files changed and what was the nature of each change (new feature, refactor, bugfix, config change)
2. Any new imports or dependencies introduced
3. Any imports or dependencies removed  
4. Risk areas: changes that are likely to increase bundle size (new imports of large libraries, removal of tree-shaking-friendly patterns, broad re-exports)
5. Code patterns that may affect bundle: dynamic imports added/removed, conditional requires, barrel file changes

Output valid JSON only.
```

Response format:
```json
{
  "filesAnalyzed": ["src/Foo.res", "src/Bar.res"],
  "keyChanges": [
    { "file": "src/Foo.res", "description": "Added DatePicker import for new date field", "type": "feature" }
  ],
  "riskAreas": [
    { "file": "src/Foo.res", "risk": "Imports full react-datepicker which is 200KB+", "severity": "high" }
  ],
  "newImports": ["react-datepicker", "date-fns/format"],
  "removedImports": ["moment"]
}
```

**New function: `analyzeCodeChunks(client, chunks, maxConcurrent=3)`**

- Takes array of diff chunks and max concurrency
- Calls `analyzeCodeChunk` for each, using `runWithConcurrency` with max 3 parallel
- Collects all individual chunk results (each is `{ filesAnalyzed, keyChanges, riskAreas, newImports, removedImports }`)
- Merges all chunk results into a single `CodeDiffSummary` and returns it:

```js
// Return type: CodeDiffSummary (merged from all chunks)
{
  totalFiles: number,           // sum of all filesAnalyzed.length
  keyChanges: { file, description, type }[],   // concatenated from all chunks
  riskAreas: { file, risk, severity }[],       // concatenated from all chunks
  newImports: string[],         // deduplicated union from all chunks
  removedImports: string[],     // deduplicated union from all chunks
  failedChunks: number,         // count of chunks that failed AI analysis (0 if all succeeded)
}
```

The caller (`runPipeline`) receives a single merged object and assigns it directly to `context.codeDiffSummary`.

**Enhanced `buildAnalysisPrompt`:**

New section added before `## ReScript Changes` (independent of the conditional `## Detected Issues` section):

```
## Code Change Analysis
The following is a summary of actual source code changes in this PR,
analyzed from the git diff:

### Key Changes
- [feature] src/Foo.res: Added DatePicker import for new date field
- [refactor] src/Bar.res: Consolidated utility functions

### Risk Areas  
- [high] src/Foo.res: Imports full react-datepicker which is 200KB+

### New Imports: react-datepicker, date-fns/format
### Removed Imports: moment

### Compiled JS Changes Summary
- 12 files changed in ReScript compiled output (lib/js/)
- Key changes: new DatePicker_bs.js (+180 lines), modified Utils_bs.js (-20 lines)
```

The existing `## ReScript Changes` section (lines 215-234 of `ai-client.js`) stays as-is — it will now actually receive data.

`context.linesChanged` will be auto-populated, so "Files Changed: Unknown" goes away.

### 4. `scripts/orchestrate.js` — Updated pipeline

**`runFullMode` changes:**

```
Before:
  Phase 1: parallel [ cloneAndBuild(base), cloneAndBuild(pr) ]
  → runPipeline(baseStatsPath, prStatsPath, options, logger, outputDir)

After:
  Phase 1a: cloneRepo(url, tmp/repo)
  Phase 1b: buildBranch(tmp/repo, base, tmp/base) → { statsPath, compiledJsDir }
  Phase 1c: buildBranch(tmp/repo, pr, tmp/pr) → { statsPath, compiledJsDir }
  Phase 1d: collectCodeDiff(tmp/repo, base, pr) → { sourceDiff, compiledDiff, linesChanged, fileStats }
  → runPipeline(baseStatsPath, prStatsPath, options, logger, outputDir, codeDiffData)
```

**`runPipeline` signature change:**

The existing signature is `runPipeline(baseStatsPath, prStatsPath, options, logger, outputDir)` (5 params). `codeDiffData` is added as an **optional 6th parameter** — `null` in file mode, populated in full mode. This avoids restructuring all existing callers.

```js
async function runPipeline(baseStatsPath, prStatsPath, options, logger, outputDir, codeDiffData = null)
```

**`runPipeline` Phase 2.5 insertion:**

After Phase 2 (computeAnalysisInputs), insert Phase 2.5. Note: `codeDiffData` carries `repoDir`, `baseBranch`, and `prBranch` from `runFullMode` so that `runPipeline` doesn't need separate parameters for them.

```js
// Phase 2.5: Code Diff Analysis (parallel, max 3 concurrent)
if (codeDiffData) {
  // ReScript analysis (synchronous — uses execSync internally)
  const reScriptAnalysis = analyzeReScriptChanges(
    codeDiffData.baseBranch, codeDiffData.prBranch, { cwd: codeDiffData.repoDir }
  );
  const reScriptSummary = generateReScriptSummary(reScriptAnalysis, diff);

  // Chunk and analyze diffs in parallel
  const allDiff = codeDiffData.sourceDiff + '\n' + codeDiffData.compiledDiff;
  const chunks = chunkDiff(allDiff);
  const codeDiffSummary = await analyzeCodeChunks(client, chunks, 3);

  // Merge into enriched context
  context.codeDiffSummary = codeDiffSummary;
  context.reScriptAnalysis = reScriptSummary;
  context.linesChanged = codeDiffData.linesChanged;
  context.fileStats = codeDiffData.fileStats;
}
```

Phase 3 (AI Final Analysis) is unchanged — `analyzeBundle` already receives `enrichedContext` and `buildAnalysisPrompt` already checks for `context.reScriptAnalysis`. We just need to add the new `codeDiffSummary` rendering.

### 5. Wire in `lib/rescript-analyzer.js`

The existing `analyzeReScriptChanges(baseBranch, headBranch)` uses `git diff --name-only baseBranch...headBranch` and `git show ref:filepath`. With the single full clone, both branches exist in the same repo, so these commands will work.

**Changes needed:**
- **Bug fix (line 78):** `importsAdded.push(...fileImports.newImports)` should be `importsAdded.push(...fileImports.addedImports)`. Currently it pushes _all_ imports in the new version instead of only the _newly added_ ones. `analyzeFileImports` returns `{ oldImports, newImports, addedImports }` — `newImports` is the full set from `extractImports(newContent)`, while `addedImports` is the filtered diff. This bug means `importsAdded` would contain every import in the file, not just what was added by the PR.
- Pass `cwd: repoDir` to all `execSync` calls instead of `process.cwd()`. Currently hardcoded to `process.cwd()`.
- Add `cwd` parameter to `analyzeReScriptChanges`, `getChangedReScriptFiles`, `analyzeFileImports`, and `getFileAtRef`.
- Call from orchestrator: `analyzeReScriptChanges(baseBranch, prBranch, { cwd: repoDir })`
- Feed result into `generateReScriptSummary(analysis, diff)` → `context.reScriptAnalysis`

## Data Flow

```
                  ┌─────────────────────────┐
                  │  git clone (full)        │
                  │  tmp/repo/               │
                  └─────────┬───────────────┘
                            │
              ┌─────────────┼─────────────┐
              ▼             ▼             ▼
      buildBranch(base)  buildBranch(pr)  git diff base...pr
      ├─ baseStats       ├─ prStats       ├─ sourceDiff
      └─ base-compiled/  └─ pr-compiled/  ├─ compiledDiff (via git diff --no-index)
                                          ├─ linesChanged
                                          └─ fileStats[]
              │             │
              ▼             ▼
        computeAnalysisInputs()
        ├─ diff (BundleDiff)
        ├─ detections
        └─ summary
                            │
              ┌─────────────┼─────────────┐
              ▼             ▼             ▼
        chunkDiff()    reScriptAnalysis  (existing data)
        ├─ chunk 1                        ├─ diff
        ├─ chunk 2                        ├─ detections
        └─ chunk 3                        └─ rawStats
              │
              ▼ (parallel, max 3)
        analyzeCodeChunks()
        ├─ chunk 1 → { keyChanges, risks, imports }
        ├─ chunk 2 → { keyChanges, risks, imports }
        └─ chunk 3 → { keyChanges, risks, imports }
              │
              ▼
        merged into single CodeDiffSummary
              │
              ▼
        enrichedContext = {
          codeDiffSummary,       ← NEW
          reScriptAnalysis,      ← WIRED IN (was dead)
          linesChanged,          ← AUTO-COMPUTED (was manual)
          rawStats,              ← unchanged
          fileStats,             ← NEW
        }
              │
              ▼
        analyzeBundle() → final AI call
        buildAnalysisPrompt() renders:
          - existing 10 sections (unchanged)
          - NEW: ## Code Change Analysis
          - WIRED IN: ## ReScript Changes (now has data)
```

## AI Prompt Changes

### New Section: `## Code Change Analysis`

Inserted **before** `## ReScript Changes` in `buildAnalysisPrompt`. Placement is independent of `## Detected Issues` — the detected issues section is conditional (only rendered when `detections.violations.length > 0`), but `## Code Change Analysis` is rendered whenever `context.codeDiffSummary` is present, regardless of whether detected issues exist. In the prompt builder code, add the code change analysis block right before the existing ReScript Changes block (line 214 of current `ai-client.js`). Rendered from `context.codeDiffSummary`:

```markdown
## Code Change Analysis
Source code changes analyzed from git diff ({totalFiles} files, {linesChanged} lines changed):

### Key Changes
- [{type}] {file}: {description}
...

### Risk Areas
- [{severity}] {file}: {risk}
...

### New Imports Detected: {imports}
### Removed Imports Detected: {imports}

### Compiled JS Changes
{count} ReScript-compiled JS files changed:
- {file}: +{added}/-{removed} lines
...
```

### Enhanced System Prompt

Add to the existing `SYSTEM_PROMPT` after the "CRITICAL INSTRUCTION FOR SUGGESTIONS" block:

```
IMPORTANT: If "Code Change Analysis" is provided, use it to:
- Correlate source file changes with bundle size impacts
- Verify that new imports match the detected bundle additions
- Identify cases where small code changes cause disproportionate bundle growth
- Reference specific source files and line-level changes in your root cause analysis
- Compare source code intent with compiled JS output to find optimization opportunities
```

### `linesChanged` Auto-Population

`buildAnalysisPrompt` line 192 currently shows `Files Changed: ${context.linesChanged || 'Unknown'}`. After this change, `context.linesChanged` will be auto-computed in full mode, so this line will show actual data. The `--lines` CLI flag can still override it.

## Error Handling

- **Clone fails:** Same as today — error propagates, pipeline aborts
- **`git diff` fails:** Log warning, skip code diff analysis, continue with bundle-only AI (graceful degradation)
- **Chunk AI call fails:** Log warning for that chunk, continue with remaining chunks. Failed chunks contribute zero entries to the merged `CodeDiffSummary` (their `keyChanges`, `riskAreas`, `newImports`, `removedImports` are simply absent from the merge). The summary includes a `failedChunks: number` field so the final AI prompt can note incomplete analysis. If all chunks fail, skip code diff summary entirely (graceful degradation).
- **ReScript analysis fails:** Already has try/catch returning empty result (line 91-99 of rescript-analyzer.js). No change needed.
- **Compiled JS snapshot copy fails:** Log warning, skip compiled diff, continue with source diff only

## Testing

### Unit Tests

1. **`lib/code-diff.js`:**
   - `parseDiffStats` — parse unified diff into per-file stats
   - `chunkDiff` — chunk splitting respects maxBytes, single large files get own chunk, empty input returns empty array
   - `collectCodeDiff` — separates source vs compiled diffs (mock `execSync`)

2. **`lib/clone-builder.js`:**
   - `cloneRepo` — calls correct git commands
   - `buildBranch` — calls checkout, clean, install, re:build, webpack in order

3. **`lib/ai-client.js`:**
   - `analyzeCodeChunk` — returns parsed JSON from AI response
   - `analyzeCodeChunks` — merges multiple chunk results, respects concurrency limit
   - `buildAnalysisPrompt` — includes code change analysis section when `codeDiffSummary` present, omits when absent

4. **`lib/rescript-analyzer.js`:**
   - Existing tests for `extractImports`, `mapToJSDependencies` remain
   - New: `analyzeReScriptChanges` accepts `cwd` option and passes it through

### Integration Tests

5. **Orchestrator:**
   - `runFullMode` in test uses mock git/npm commands, verifies code diff data flows to `enrichedContext`
   - File mode skips code diff gracefully

## Performance Impact

| Metric | Before | After |
|--------|--------|-------|
| Clone time | ~30s (2x shallow, parallel) | ~60-90s (1x full, sequential builds) |
| AI API calls | 1 | 1 + N chunk calls (N depends on diff size, max 3 concurrent) |
| Pipeline total | ~3-6 min | ~5-8 min |
| AI accuracy | Bundle stats only | Bundle stats + code changes + ReScript analysis |

The increased time is acceptable given the accuracy improvement and the stated constraint that cost is not a concern.

## Non-Goals

- File mode code diff support (would require GitHub API integration)
- Streaming/incremental diff analysis
- Caching diffs across runs
- Changes to report output formats (comment, text, JSON, diff reports)
