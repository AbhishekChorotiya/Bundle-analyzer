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
