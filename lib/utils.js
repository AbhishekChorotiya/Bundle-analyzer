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

module.exports = {
  formatBytes,
  loadEnv,
  getRootCause,
};
