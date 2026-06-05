#!/usr/bin/env node
/**
 * One-command setup for cupid player.
 *
 *   npm run setup
 *
 * Does everything a fresh clone needs and self-heals the two failures
 * people hit most on Windows:
 *
 *   1. Electron's prebuilt binary never extracts, so `npm run dev` dies with
 *        Error: ENOENT ... node_modules\electron\path.txt
 *        Error: Electron failed to install correctly ...
 *      Cause: a too-new Node version and/or a corrupted Electron download
 *      cache. We detect the missing binary, clear the cache, and reinstall.
 *
 *   2. The yt-dlp binary in ./bin is missing (its install is non-fatal), so
 *      streaming silently doesn't work. We detect and re-fetch it.
 *
 * Cross-platform: uses Node APIs, no shell-specific syntax.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const NM = path.join(ROOT, 'node_modules');
const ELECTRON_DIR = path.join(NM, 'electron');
const BIN_DIR = path.join(ROOT, 'bin');

// --- tiny pretty logger -----------------------------------------------------
const c = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m',
};
const step = (m) => console.log(`\n${c.bold}${c.cyan}▶ ${m}${c.reset}`);
const ok = (m) => console.log(`  ${c.green}✓${c.reset} ${m}`);
const warn = (m) => console.log(`  ${c.yellow}!${c.reset} ${m}`);
const fail = (m) => console.log(`  ${c.red}✗${c.reset} ${m}`);
const info = (m) => console.log(`  ${c.dim}${m}${c.reset}`);

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { stdio: 'inherit', cwd: ROOT, shell: process.platform === 'win32', ...opts });
  return res.status === 0;
}

// --- 1. Node version sanity check ------------------------------------------
function checkNode() {
  step('Checking Node.js version');
  const major = parseInt(process.versions.node.split('.')[0], 10);
  info(`Node ${process.versions.node}`);
  if (major < 18) {
    fail(`Node ${major} is too old. Install Node 18+ (24.x LTS recommended) and re-run.`);
    process.exit(1);
  }
  if (major >= 25) {
    warn(`Node ${major} is newer than what this app is tested on.`);
    warn('Bleeding-edge Node can fail to install Electron\'s binary. If setup');
    warn('can\'t repair it below, switch to Node 24.x (LTS) and try again.');
  } else {
    ok('Node version looks good');
  }
}

// --- 2. install dependencies ------------------------------------------------
function installDeps() {
  step('Installing dependencies (npm install)');
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  if (!run(npm, ['install'])) {
    fail('npm install failed. Scroll up for the error, fix it, and re-run `npm run setup`.');
    process.exit(1);
  }
  ok('Dependencies installed');
}

// --- 3. verify + repair Electron binary ------------------------------------
function electronBinaryOk() {
  const pathFile = path.join(ELECTRON_DIR, 'path.txt');
  if (!fs.existsSync(pathFile)) return false;
  const rel = fs.readFileSync(pathFile, 'utf-8').trim();
  if (!rel) return false;
  return fs.existsSync(path.join(ELECTRON_DIR, 'dist', rel));
}

function electronCacheDir() {
  // Matches @electron/get's default cache locations per platform.
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'electron', 'Cache');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Caches', 'electron');
  }
  return path.join(os.homedir(), '.cache', 'electron');
}

function rmrf(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch {}
}

function electronVersion() {
  try {
    return require(path.join(ELECTRON_DIR, 'package.json')).version;
  } catch {
    return null;
  }
}

function platformExePath() {
  // Mirrors electron/install.js getPlatformPath().
  switch (process.platform) {
    case 'darwin': return 'Electron.app/Contents/MacOS/Electron';
    case 'win32': return 'electron.exe';
    default: return 'electron';
  }
}

// Find the electron zip @electron/get cached during the (failed) install.
// Layout: <cacheRoot>/<sha>/electron-v<ver>-<platform>-<arch>.zip
function findCachedElectronZip(version) {
  const cache = electronCacheDir();
  const arch = process.arch;
  const wanted = `electron-v${version}-${process.platform}-${arch}.zip`;
  const found = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name === wanted) found.push(full);
    }
  };
  walk(cache);
  return found[0] || null;
}

// The proven manual fix: when a too-new Node makes electron's installer
// download the zip but choke on the extract step (so dist/ + path.txt never
// appear), unzip the cached artifact ourselves and write path.txt by hand.
async function manualExtractElectron() {
  const version = electronVersion();
  if (!version) return false;

  const zip = findCachedElectronZip(version);
  if (!zip) {
    info('No cached Electron zip to extract — the download itself likely failed.');
    return false;
  }

  let extract;
  try {
    extract = require('extract-zip');
  } catch {
    info('extract-zip not available; skipping manual extraction.');
    return false;
  }

  info(`Manually extracting ${path.basename(zip)} ...`);
  const distPath = path.join(ELECTRON_DIR, 'dist');
  rmrf(distPath);
  try {
    await extract(zip, { dir: distPath });
    // electron/install.js also writes path.txt pointing at the executable.
    fs.writeFileSync(path.join(ELECTRON_DIR, 'path.txt'), platformExePath());
    return electronBinaryOk();
  } catch (err) {
    info(`Manual extraction failed: ${err.message}`);
    return false;
  }
}

async function repairElectron() {
  step('Verifying Electron binary');
  if (electronBinaryOk()) {
    ok('Electron binary present');
    return;
  }

  warn('Electron binary missing — this is the "path.txt / failed to install" error.');
  info('Auto-repairing: clearing the download cache and reinstalling Electron...');

  // 1. nuke the corrupted/partial download cache
  const cache = electronCacheDir();
  rmrf(cache);
  info(`Cleared cache: ${cache}`);

  // 2. remove the broken install
  rmrf(ELECTRON_DIR);

  // 3. reinstall just electron (re-downloads the binary cleanly)
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  run(npm, ['install', 'electron']);

  // 4. run electron's own installer directly. On a too-new Node this still
  //    downloads the zip into the cache but can fail to extract it — that's
  //    fine, step 5 finishes the job.
  if (!electronBinaryOk()) {
    const installer = path.join(ELECTRON_DIR, 'install.js');
    if (fs.existsSync(installer)) {
      info('Running Electron\'s installer directly...');
      run(process.execPath, [installer]);
    }
  }

  // 5. last resort — extract the cached zip ourselves. This is the manual fix
  //    that gets people past a too-new Node rejecting the binary install.
  if (!electronBinaryOk()) {
    info('Installer couldn\'t unpack the binary; extracting it manually...');
    await manualExtractElectron();
  }

  if (electronBinaryOk()) {
    ok('Electron binary repaired');
  } else {
    fail('Could not install Electron\'s binary automatically.');
    warn('This is almost always a too-new Node version. Switch to Node 24.x');
    warn('(LTS), then run `npm run setup` again. See README → Troubleshooting.');
    process.exit(1);
  }
}

// --- 4. verify + repair yt-dlp binary --------------------------------------
function ytDlpOk() {
  const name = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
  return fs.existsSync(path.join(BIN_DIR, name));
}

function repairYtDlp() {
  step('Verifying yt-dlp binary (powers streaming)');
  if (ytDlpOk()) {
    ok('yt-dlp binary present');
    return;
  }
  warn('yt-dlp binary missing — re-fetching...');
  run(process.execPath, [path.join(__dirname, 'install-yt-dlp.cjs')]);
  if (ytDlpOk()) {
    ok('yt-dlp binary installed');
  } else {
    warn('yt-dlp still missing. Streaming will be unavailable until it\'s installed.');
    warn('Download it manually from https://github.com/yt-dlp/yt-dlp/releases into ./bin');
  }
}

// --- go ---------------------------------------------------------------------
async function main() {
  console.log(`${c.bold}cupid player — setup${c.reset}`);
  checkNode();
  installDeps();
  await repairElectron();
  repairYtDlp();

  console.log(`\n${c.green}${c.bold}✓ Setup complete.${c.reset} Start the app with:\n`);
  console.log(`    ${c.cyan}npm run dev${c.reset}\n`);
}

main().catch((err) => {
  fail(`Setup crashed: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
