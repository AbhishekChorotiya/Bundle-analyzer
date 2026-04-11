'use strict';

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

module.exports = { parseDiffStats, chunkDiff };
