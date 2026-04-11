'use strict';

const { validateGitRef } = require('./utils');

/**
 * Parse unified diff output into per-file stats.
 * @param {string} diffText - Raw git diff output
 * @returns {{ filePath: string, linesAdded: number, linesRemoved: number, isBinary: boolean }[]}
 */
function parseDiffStats(diffText) {
  if (!diffText || !diffText.trim()) return [];

  const files = [];
  const fileDiffs = diffText.split(/^(?=diff --git )/m);

  for (const fileDiff of fileDiffs) {
    if (!fileDiff.trim()) continue;

    const headerMatch = fileDiff.match(/^diff --git a\/(.+?) b\/(.+)/m);
    if (!headerMatch) continue;

    const filePath = headerMatch[2];

    if (/^Binary files /m.test(fileDiff)) {
      files.push({ filePath, linesAdded: 0, linesRemoved: 0, isBinary: true });
      continue;
    }

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

const DEFAULT_CHUNK_MAX_BYTES = 50000;

/**
 * Split a unified diff into chunks for parallel AI analysis.
 * @param {string} diffText - Full unified diff
 * @param {number} [maxBytes] - Max bytes per chunk
 * @returns {string[]} Array of diff chunks
 */
function chunkDiff(diffText, maxBytes) {
  if (!diffText || !diffText.trim()) return [];

  const limit = maxBytes || parseInt(process.env.CODE_DIFF_CHUNK_MAX_BYTES, 10) || DEFAULT_CHUNK_MAX_BYTES;

  const fileDiffs = diffText.split(/^(?=diff --git )/m).filter(s => s.trim());
  if (fileDiffs.length === 0) return [];

  const chunks = [];
  let currentChunk = '';

  for (const fileDiff of fileDiffs) {
    const fileDiffBytes = Buffer.byteLength(fileDiff, 'utf-8');

    if (currentChunk && Buffer.byteLength(currentChunk, 'utf-8') + fileDiffBytes > limit) {
      chunks.push(currentChunk);
      currentChunk = '';
    }

    if (!currentChunk && fileDiffBytes > limit) {
      chunks.push(fileDiff);
      continue;
    }

    currentChunk += (currentChunk ? '\n' : '') + fileDiff;
  }

  if (currentChunk) {
    chunks.push(currentChunk);
  }

  return chunks;
}

/**
 * Collect code diff between two branches in a git repo.
 * @param {string} repoDir - Path to the cloned repo
 * @param {string} baseBranch - Base branch name
 * @param {string} prBranch - PR branch name
 * @param {{ baseCompiledDir?: string, prCompiledDir?: string }} [dirs]
 * @returns {{ sourceDiff: string, compiledDiff: string, linesChanged: number, fileStats: object[], repoDir: string, baseBranch: string, prBranch: string }}
 */
function collectCodeDiff(repoDir, baseBranch, prBranch, dirs = {}) {
  const childProcess = require('child_process');

  validateGitRef(baseBranch);
  validateGitRef(prBranch);

  let sourceDiff = '';
  try {
    sourceDiff = childProcess.execSync(
      `git diff ${baseBranch}...${prBranch} -- ':!lib/js/' ':!lib/es6/' ':!node_modules/' ':!dist/'`,
      { cwd: repoDir, encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 }
    );
  } catch (err) {
    console.warn(`Warning: git diff failed: ${err.message}`);
  }

  let compiledDiff = '';
  if (dirs.baseCompiledDir && dirs.prCompiledDir) {
    try {
      childProcess.execSync(
        `git diff --no-index ${dirs.baseCompiledDir} ${dirs.prCompiledDir}`,
        { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 }
      );
    } catch (err) {
      if (err.status === 1 && err.stdout) {
        compiledDiff = err.stdout.toString();
      }
    }

    // git diff --no-index produces output with a/ and b/ prefixes followed by the
    // absolute paths passed as arguments. We replace these with repo-relative lib/js/
    // paths so the AI sees clean file paths instead of temp directory paths.
    if (compiledDiff) {
      const escapedBase = dirs.baseCompiledDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const escapedPr = dirs.prCompiledDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      compiledDiff = compiledDiff
        .replace(new RegExp(`a/${escapedBase}/`, 'g'), 'a/lib/js/')
        .replace(new RegExp(`b/${escapedPr}/`, 'g'), 'b/lib/js/');
    }
  }

  const fileStats = parseDiffStats(sourceDiff);
  const linesChanged = fileStats.reduce((sum, f) => sum + f.linesAdded + f.linesRemoved, 0);

  return { sourceDiff, compiledDiff, linesChanged, fileStats, repoDir, baseBranch, prBranch };
}

module.exports = { parseDiffStats, chunkDiff, collectCodeDiff };
