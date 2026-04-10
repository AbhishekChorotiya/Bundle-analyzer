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
