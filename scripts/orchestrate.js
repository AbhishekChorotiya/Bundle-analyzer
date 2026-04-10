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
const { runWithConcurrency } = require('../lib/concurrency');
const { cloneAndBuild } = require('../lib/clone-builder');
const { computeAnalysisInputs, generateAnalysisReport, generateJSONOutput } = require('./analyze');
const { generateComment, upsertComment } = require('./comment');
const { generateReport: generateDiffReport } = require('./diff');
const { createClient, analyzeBundle, analyzeOffline, isAIAvailable } = require('../lib/ai-client');

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
      if (!args[i + 1] || args[i + 1].startsWith('-')) return null;
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

// CLI entry
if (require.main === module) {
  main().catch(error => {
    console.error(`\n${C.red}✗${C.reset} Fatal: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { parseArgs, determineMode, createLogger, main, runFullMode, runFileMode, runPipeline };
