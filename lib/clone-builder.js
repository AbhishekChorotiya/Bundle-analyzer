/**
 * @fileoverview Clone Builder
 * Programmatic clone + build for a git branch.
 * Produces webpack stats JSON in an isolated directory.
 */

const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

/**
 * Run a command via execFile and return a promise.
 * @param {string} cmd - Command to run
 * @param {string[]} args - Arguments
 * @param {Object} options - execFile options
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
function run(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 50 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${cmd} ${args.join(' ')} failed: ${error.message}\n${stderr}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

/**
 * Run webpack via spawn and capture stdout (stats JSON can be very large).
 * @param {string} cwd - Working directory
 * @returns {Promise<string>} Raw stdout
 */
function runWebpack(cwd) {
  return new Promise((resolve, reject) => {
    const webpackBin = path.join(cwd, 'node_modules', '.bin', 'webpack');
    const args = ['--config', 'webpack.common.js', '--profile', '--json'];

    const child = spawn(webpackBin, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        NODE_ENV: 'production',
        sdkEnv: 'prod',
        SENTRY_DSN: process.env.SENTRY_DSN || 'https://dummy@o0.ingest.sentry.io/0',
      },
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });

    child.on('close', code => {
      if (code !== 0 && !stdout.includes('{')) {
        reject(new Error(`webpack exited with code ${code}: ${stderr}`));
        return;
      }
      resolve(stdout);
    });

    child.on('error', err => {
      reject(new Error(`Failed to spawn webpack: ${err.message}`));
    });
  });
}

/**
 * Clone a branch and build webpack stats.
 * @param {string} repoUrl - Git clone URL
 * @param {string} branch - Branch name to clone
 * @param {string} targetDir - Directory to clone into
 * @param {Object} options
 * @param {Function} [options.log] - Logging function (default: console.log)
 * @returns {Promise<{statsPath: string, cloneDir: string}>}
 */
async function cloneAndBuild(repoUrl, branch, targetDir, options = {}) {
  const log = options.log || console.log;

  // Step 1: Clone
  log(`  Cloning ${branch}...`);
  await run('git', ['clone', '--depth', '1', '--branch', branch, '--single-branch', repoUrl, targetDir]);

  // Step 2: Init submodules
  log(`  Initializing submodules...`);
  await run('git', ['-C', targetDir, 'submodule', 'update', '--init', '--recursive', '--depth', '1']);

  // Step 3: Install dependencies
  log(`  Installing dependencies...`);
  await run('npm', ['install', '--ignore-scripts', '--loglevel=error'], { cwd: targetDir });

  // Step 4: ReScript build
  log(`  Compiling ReScript sources...`);
  await run('npm', ['run', 're:build'], { cwd: targetDir });

  // Step 5: Webpack build
  log(`  Building production bundle...`);
  const rawOutput = await runWebpack(targetDir);

  // Extract JSON from webpack output
  const jsonStart = rawOutput.indexOf('{');
  if (jsonStart === -1) {
    throw new Error('webpack did not produce JSON output');
  }

  const jsonContent = rawOutput.substring(jsonStart);

  // Validate JSON
  try {
    JSON.parse(jsonContent);
  } catch (e) {
    throw new Error(`Invalid JSON in webpack stats output: ${e.message}`);
  }

  const statsPath = path.join(targetDir, 'stats.json');
  fs.writeFileSync(statsPath, jsonContent);

  log(`  Stats saved: ${statsPath}`);

  return { statsPath, cloneDir: targetDir };
}

module.exports = { cloneAndBuild };
