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

module.exports = { parseDiffStats };
