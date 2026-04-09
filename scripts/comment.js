#!/usr/bin/env node
/**
 * @fileoverview Comment Script
 * Generates PR comment markdown from analysis results
 */

const fs = require('fs');
const { formatBytes } = require('../lib/utils');

/**
 * Generate PR comment markdown
 * @param {Object} analysis - Analysis results from analyze.js
 * @param {Object} options
 * @returns {string} Markdown comment
 */
function generateComment(analysis, options = {}) {
  // Handle both raw analysis object (from cli.js) and JSON serialized format (from analyze.js --json).
  // When called from cli.js, analysis.summary is the generateSummary() result which lacks size fields;
  // the size fields live on analysis.diff. When called with JSON, analysis.summary has everything.
  const diff = analysis.diff || {};
  const summary = {
    ...(analysis.summary || {}),
    // Prefer summary fields, fall back to diff fields for size data
    baseSize: analysis.summary?.baseSize ?? diff.baseSize ?? 0,
    prSize: analysis.summary?.prSize ?? diff.prSize ?? 0,
    totalDiff: analysis.summary?.totalDiff ?? diff.totalDiff ?? 0,
    baseSizeFormatted: analysis.summary?.baseSizeFormatted ?? diff.baseSizeFormatted,
    prSizeFormatted: analysis.summary?.prSizeFormatted ?? diff.prSizeFormatted,
    totalDiffFormatted: analysis.summary?.totalDiffFormatted ?? diff.totalDiffFormatted,
    nodeModulesDiff: analysis.summary?.nodeModulesDiff ?? diff.nodeModulesDiff ?? 0,
  };
  const ai = analysis.aiAnalysis || analysis.ai || {};
  const detections = analysis.issues || analysis.detections || { violations: [], critical: [], warnings: [], info: [] };
  // When called from cli.js, changes are on analysis.diff (topChanges, packageDiffs).
  // When called with JSON, they're on analysis.changes (top, packages).
  const changes = analysis.changes || {
    top: diff.topChanges || [],
    packages: diff.packageDiffs
      ? Object.entries(diff.packageDiffs).map(([name, change]) => ({ name, change }))
      : [],
  };

  const lines = [];

  // Header
  lines.push('## 📦 Bundle Analysis Report');
  lines.push('');

  // Summary table
  const baseSizeFormatted = summary.baseSizeFormatted || formatBytes(summary.baseSize || 0);
  const prSizeFormatted = summary.prSizeFormatted || formatBytes(summary.prSize || 0);
  const totalDiff = summary.totalDiff || (summary.prSize || 0) - (summary.baseSize || 0);
  const totalDiffFormatted = summary.totalDiffFormatted || formatBytes(totalDiff, { signed: true });
  const nodeModulesDiff = summary.nodeModulesDiff || 0;

  lines.push('| Metric | Value |');
  lines.push('|--------|-------|');
  lines.push(`| Base Size | ${baseSizeFormatted} |`);
  lines.push(`| PR Size | ${prSizeFormatted} |`);
  lines.push(`| Change | ${renderSizeChange(totalDiff, totalDiffFormatted)} |`);
  lines.push(`| node_modules | ${renderSizeChange(nodeModulesDiff, formatBytes(nodeModulesDiff, { signed: true }))} |`);
  lines.push('');

  // Asset comparison table (output files)
  const assetDiff = diff.assetDiff || [];
  const significantAssets = assetDiff.filter(a => a.type !== 'unchanged');

  if (significantAssets.length > 0) {
    lines.push('### 📁 Output Files');
    lines.push('');
    lines.push('| Output File | Base | PR | Change | Top Contributors |');
    lines.push('|-------------|------|-----|--------|-----------------|');

    for (const asset of significantAssets) {
      const baseSizeStr = asset.baseSize > 0 ? formatBytes(asset.baseSize) : '-';
      const prSizeStr = asset.prSize > 0 ? formatBytes(asset.prSize) : '-';
      let changeStr;
      if (asset.type === 'added') {
        changeStr = '🆕 new';
      } else if (asset.type === 'removed') {
        changeStr = '🗑️ removed';
      } else {
        changeStr = renderSizeChange(asset.change, formatBytes(asset.change, { signed: true }));
      }
      const reasonsStr = formatAssetReasons(asset);
      lines.push(`| \`${truncate(asset.name, 40)}\` | ${baseSizeStr} | ${prSizeStr} | ${changeStr} | ${reasonsStr} |`);
    }

    // Show total asset size summary
    const baseAssetSize = diff.baseAssetSize || 0;
    const prAssetSize = diff.prAssetSize || 0;
    const totalAssetDiff = diff.totalAssetDiff || (prAssetSize - baseAssetSize);
    if (baseAssetSize > 0 || prAssetSize > 0) {
      lines.push(`| **Total** | **${formatBytes(baseAssetSize)}** | **${formatBytes(prAssetSize)}** | **${renderSizeChange(totalAssetDiff, formatBytes(totalAssetDiff, { signed: true }))}** | |`);
    }

    lines.push('');
  }

  // Entrypoint comparison
  const entrypointDiff = diff.entrypointDiff || [];
  const significantEntrypoints = entrypointDiff.filter(e => e.type !== 'unchanged');

  if (significantEntrypoints.length > 0) {
    lines.push('<details>');
    lines.push('<summary><b>🚪 Entrypoint Changes</b></summary>');
    lines.push('');
    lines.push('| Entrypoint | Base | PR | Change |');
    lines.push('|------------|------|-----|--------|');

    for (const ep of significantEntrypoints) {
      const baseSizeStr = ep.baseSize > 0 ? formatBytes(ep.baseSize) : '-';
      const prSizeStr = ep.prSize > 0 ? formatBytes(ep.prSize) : '-';
      let changeStr;
      if (ep.type === 'added') {
        changeStr = '🆕 new';
      } else if (ep.type === 'removed') {
        changeStr = '🗑️ removed';
      } else {
        changeStr = renderSizeChange(ep.change, formatBytes(ep.change, { signed: true }));
      }
      lines.push(`| \`${ep.name}\` | ${baseSizeStr} | ${prSizeStr} | ${changeStr} |`);
    }

    lines.push('');
    lines.push('</details>');
    lines.push('');
  }

  // AI Verdict
  lines.push('### 🤖 AI Verdict');
  lines.push('');

  const verdictBadge = getVerdictBadge(ai.verdict || 'needs_review');
  lines.push(`**Status:** ${verdictBadge}`);
  lines.push(`**Confidence:** ${((ai.confidence || 0) * 100).toFixed(0)}%`);
  lines.push('');
  lines.push(`**Explanation:** ${ai.explanation || 'No explanation available'}`);
  lines.push('');
  lines.push(`**Root Cause:** ${ai.rootCause || 'Unknown'}`);
  lines.push('');

  // Suggested Fixes
  const suggestedFixes = ai.suggestedFixes || [];
  if (suggestedFixes.length > 0) {
    lines.push('<details>');
    lines.push('<summary><b>💡 Suggested Fixes</b></summary>');
    lines.push('');
    lines.push('');
    suggestedFixes.forEach((fix, i) => {
      lines.push(`${i + 1}. ${fix}`);
    });
    lines.push('');
    lines.push('</details>');
    lines.push('');
  }

  // Issues
  const violations = detections.details || detections.violations || [];
  const critical = detections.critical || [];
  const warnings = detections.warnings || [];

  if (violations.length > 0) {
    lines.push('### 🚨 Issues');
    lines.push('');

    if (critical.length > 0) {
      lines.push('#### 🔴 Critical');
      lines.push('');
      for (const v of critical) {
        lines.push(`- **${v.id}**: ${v.message}`);
        if (v.details?.module) {
          lines.push(`  - Module: \`${v.details.module}\``);
        }
      }
      lines.push('');
    }

    if (warnings.length > 0) {
      lines.push('#### 🟡 Warnings');
      lines.push('');
      for (const v of warnings.slice(0, 10)) {
        lines.push(`- **${v.id}**: ${v.message}`);
        if (v.details?.suggestion) {
          lines.push(`  - 💡 ${v.details.suggestion}`);
        }
      }
      lines.push('');
    }
  }

  // Package Changes
  const packages = changes.packages || [];
  const pkgChanges = packages
    .filter(p => Math.abs(p.change) > 1024)
    .slice(0, 10);

  if (pkgChanges.length > 0) {
    lines.push('<details>');
    lines.push('<summary><b>📦 Package Changes</b></summary>');
    lines.push('');
    lines.push('| Package | Change |');
    lines.push('|---------|--------|');

    for (const pkg of pkgChanges) {
      const formatted = formatBytes(pkg.change, { signed: true });
      const icon = pkg.change > 0 ? '📈' : '📉';
      lines.push(`| ${pkg.name} | ${icon} ${formatted} |`);
    }

    lines.push('');
    lines.push('</details>');
    lines.push('');
  }

  // Footer
  lines.push('---');
  lines.push('*Generated by Hyperswitch Bundle Analyzer*');

  return lines.join('\n');
}

/**
 * Generate compact comment for minimal output
 * @param {Object} analysis
 * @returns {string}
 */
function generateCompactComment(analysis) {
  const diff = analysis.diff || {};
  const summary = {
    ...(analysis.summary || {}),
    baseSize: analysis.summary?.baseSize ?? diff.baseSize ?? 0,
    prSize: analysis.summary?.prSize ?? diff.prSize ?? 0,
    totalDiff: analysis.summary?.totalDiff ?? diff.totalDiff ?? 0,
    totalDiffFormatted: analysis.summary?.totalDiffFormatted ?? diff.totalDiffFormatted,
    nodeModulesDiff: analysis.summary?.nodeModulesDiff ?? diff.nodeModulesDiff ?? 0,
  };
  const ai = analysis.aiAnalysis || analysis.ai || {};
  const detections = analysis.issues || analysis.detections || {};

  const lines = [];

  const totalDiff = summary.totalDiff || (summary.prSize || 0) - (summary.baseSize || 0);
  const totalDiffFormatted = summary.totalDiffFormatted || formatBytes(totalDiff, { signed: true });

  lines.push('## 📦 Bundle Analysis');
  lines.push('');
  lines.push(`**Change:** ${renderSizeChange(totalDiff, totalDiffFormatted)}`);
  lines.push(`**Verdict:** ${getVerdictBadge(ai.verdict || 'needs_review')} (${((ai.confidence || 0) * 100).toFixed(0)}% confidence)`);

  const criticalCount = detections.critical?.length || 0;
  const warningCount = detections.warnings?.length || 0;

  if (criticalCount > 0) {
    lines.push(`**Issues:** 🔴 ${criticalCount} critical`);
  } else if (warningCount > 0) {
    lines.push(`**Issues:** 🟡 ${warningCount} warnings`);
  }

  return lines.join('\n');
}

/**
 * Post comment to GitHub PR
 * @param {string} comment - Comment body
 * @param {Object} options
 * @returns {Promise<void>}
 */
async function postComment(comment, options = {}) {
  const { GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_EVENT_PATH } = process.env;

  if (!GITHUB_TOKEN || !GITHUB_REPOSITORY) {
    throw new Error('GITHUB_TOKEN and GITHUB_REPOSITORY environment variables required');
  }

  // Get PR number from event
  let prNumber = options.prNumber;

  if (!prNumber && GITHUB_EVENT_PATH) {
    try {
      const event = JSON.parse(fs.readFileSync(GITHUB_EVENT_PATH, 'utf-8'));
      prNumber = event.pull_request?.number;
    } catch {
      // Ignore
    }
  }

  if (!prNumber) {
    throw new Error('Could not determine PR number');
  }

  const [owner, repo] = GITHUB_REPOSITORY.split('/');
  const url = `https://api.github.com/repos/${owner}/${repo}/issues/${prNumber}/comments`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `token ${GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ body: comment }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`GitHub API error: ${response.status} - ${error}`);
  }

  console.log(`✓ Comment posted to PR #${prNumber}`);
}

/**
 * Update existing comment or create new one
 * @param {string} comment - Comment body
 * @param {Object} options
 * @returns {Promise<void>}
 */
async function upsertComment(comment, options = {}) {
  const { GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_EVENT_PATH } = process.env;

  if (!GITHUB_TOKEN || !GITHUB_REPOSITORY) {
    throw new Error('Missing required environment variables');
  }

  // Get PR number
  let prNumber = options.prNumber;

  if (!prNumber && GITHUB_EVENT_PATH) {
    try {
      const event = JSON.parse(fs.readFileSync(GITHUB_EVENT_PATH, 'utf-8'));
      prNumber = event.pull_request?.number;
    } catch {
      // Ignore
    }
  }

  if (!prNumber) {
    throw new Error('Could not determine PR number');
  }

  const [owner, repo] = GITHUB_REPOSITORY.split('/');
  const marker = options.marker || '<!-- bundle-ai -->';
  const fullComment = `${marker}\n${comment}`;

  // Find existing comment
  const listUrl = `https://api.github.com/repos/${owner}/${repo}/issues/${prNumber}/comments`;

  const listResponse = await fetch(listUrl, {
    headers: {
      'Authorization': `token ${GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github.v3+json',
    },
  });

  if (!listResponse.ok) {
    throw new Error(`Failed to list comments: ${listResponse.status}`);
  }

  const comments = await listResponse.json();
  const existingComment = comments.find(c => c.body?.includes(marker));

  if (existingComment) {
    // Update existing comment
    const updateUrl = `https://api.github.com/repos/${owner}/${repo}/issues/comments/${existingComment.id}`;

    const updateResponse = await fetch(updateUrl, {
      method: 'PATCH',
      headers: {
        'Authorization': `token ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ body: fullComment }),
    });

    if (!updateResponse.ok) {
      throw new Error(`Failed to update comment: ${updateResponse.status}`);
    }

    console.log(`✓ Updated existing comment #${existingComment.id}`);
  } else {
    // Create new comment
    await postComment(fullComment, options);
  }
}

/**
 * Get verdict badge markdown
 * @param {string} verdict
 * @returns {string}
 */
function getVerdictBadge(verdict) {
  switch (verdict) {
    case 'expected':
      return '![expected](https://img.shields.io/badge/-expected-success)';
    case 'unexpected':
      return '![unexpected](https://img.shields.io/badge/-unexpected-critical)';
    case 'needs_review':
      return '![needs_review](https://img.shields.io/badge/-needs_review-yellow)';
    default:
      return '![unknown](https://img.shields.io/badge/-unknown-lightgrey)';
  }
}

/**
 * Render size change with color
 * @param {number} bytes
 * @param {string} formatted
 * @returns {string}
 */
function renderSizeChange(bytes, formatted) {
  if (bytes > 0) {
    return `🔺 ${formatted}`;
  } else if (bytes < 0) {
    return `🟢 ${formatted}`;
  }
  return `➖ ${formatted}`;
}

/**
 * Truncate string with ellipsis
 * @param {string} str
 * @param {number} maxLen
 * @returns {string}
 */
function truncate(str, maxLen) {
  if (str.length <= maxLen) return str;
  return str.substring(0, maxLen - 3) + '...';
}

/**
 * Format asset reasons (top contributors) for display in a table cell.
 * Returns a concise string like "lodash (+684 KB), App.js (+512 B)"
 * @param {Object} asset - AssetChange with reasons
 * @returns {string}
 */
function formatAssetReasons(asset) {
  if (asset.type === 'added') return '*(new asset)*';
  if (asset.type === 'removed') return '*(removed)*';

  const reasons = asset.reasons || [];
  if (reasons.length === 0) return '-';

  return reasons
    .map(r => `\`${truncate(r.name, 25)}\` (${r.changeFormatted})`)
    .join(', ');
}

/**
 * CLI entry point
 */
if (require.main === module) {
  const args = process.argv.slice(2);
  const options = parseArgs(args);

  if (!options.input) {
    console.error('Error: --input is required');
    console.log(`
Usage: node comment.js --input <analysis.json> [options]

Options:
  --input <path>      Path to analysis JSON file (required)
  --output <path>     Save comment to file instead of posting
  --compact           Generate compact comment
  --post              Post to GitHub PR
  --upsert            Update existing comment or create new
  --pr <number>       PR number (auto-detected in CI)
  --marker <text>     Comment marker for upsert
`);
    process.exit(1);
  }

  try {
    const analysis = JSON.parse(fs.readFileSync(options.input, 'utf-8'));

    let comment;
    if (options.compact) {
      comment = generateCompactComment(analysis);
    } else {
      comment = generateComment(analysis, options);
    }

    if (options.output) {
      fs.writeFileSync(options.output, comment);
      console.log(`Comment saved to: ${options.output}`);
    } else if (options.post || options.upsert) {
      if (options.upsert) {
        upsertComment(comment, options)
          .then(() => process.exit(0))
          .catch(error => {
            console.error('Error:', error.message);
            process.exit(1);
          });
      } else {
        postComment(comment, options)
          .then(() => process.exit(0))
          .catch(error => {
            console.error('Error:', error.message);
            process.exit(1);
          });
      }
    } else {
      console.log(comment);
    }
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

/**
 * Parse CLI arguments
 * @param {string[]} args
 * @returns {Object}
 */
function parseArgs(args) {
  const options = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    switch (arg) {
      case '--input':
      case '-i':
        options.input = args[++i];
        break;
      case '--output':
      case '-o':
        options.output = args[++i];
        break;
      case '--pr':
        options.prNumber = args[++i];
        break;
      case '--marker':
        options.marker = args[++i];
        break;
      case '--compact':
        options.compact = true;
        break;
      case '--post':
        options.post = true;
        break;
      case '--upsert':
        options.upsert = true;
        break;
      case '--help':
      case '-h':
        console.log(`
Usage: node comment.js --input <analysis.json> [options]

Generate PR comment from bundle analysis results.

Options:
  -i, --input <path>    Path to analysis JSON (required)
  -o, --output <path>   Save comment to file
  --pr <number>         PR number (auto-detected in CI)
  --marker <text>       Comment marker for upsert
  --compact             Generate compact comment
  --post                Post to GitHub PR
  --upsert              Update existing or create new
  -h, --help            Show this help
`);
        process.exit(0);
    }
  }

  return options;
}

module.exports = {
  generateComment,
  generateCompactComment,
  postComment,
  upsertComment,
};
