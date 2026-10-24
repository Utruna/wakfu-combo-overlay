/**
 * tools/demo_app.js
 * Shared by the README capture tools: an isolated demo profile (fake heroes,
 * fake wakfu.log, its own port) and the real app running on it, so a running
 * instance isn't disturbed.
 *
 * The app is the release build (`npm run tauri build -- --no-bundle` first).
 */

'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const APP_EXE = path.join(REPO, 'src-tauri', 'target', 'release', 'wakfu-combo-overlay.exe');

const hero = (n, cls, r, g, b) => ({ name: n, characterName: n, class: cls, color: { r, g, b } });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Resolves once something answers on the port. */
async function waitForPort(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const up = await new Promise((resolve) => {
      http.get(`http://127.0.0.1:${port}/`, (res) => { res.resume(); resolve(true); })
        .on('error', () => resolve(false));
    });
    if (up) return;
    await wait(200);
  }
  throw new Error(`The demo app never answered on port ${port}`);
}

/**
 * Writes the demo profile under %TEMP%/<name>.
 *
 * @param {object} options
 * @param {string} options.name - Work folder name.
 * @param {number} options.port
 * @param {object[]} options.heroes - Built with `hero()`.
 * @param {string[]} [options.tracked] - Character names tracked (default: all).
 * @param {object} options.comboLayout
 * @returns {{work: string, dataDir: string, logsDir: string, logFile: string, settings: object}}
 */
function createDemoProfile({ name, port, heroes, tracked, comboLayout }) {
  const work = path.join(os.tmpdir(), name);
  const dataDir = path.join(work, 'userData');
  const logsDir = path.join(work, 'logs');
  const logFile = path.join(logsDir, 'wakfu.log');
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(logsDir, { recursive: true });
  fs.writeFileSync(logFile, '');

  const settings = {
    heroes,
    trackedCharacterNames: tracked ?? heroes.map((h) => h.characterName),
    comboLayout,
    overlayPort: port,
    logsDir,
    onboardingDone: true,
  };
  fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify(settings, null, 2));
  return { work, dataDir, logsDir, logFile, settings };
}

/** Starts the real app, in the tray, on the demo profile. Resolves to the child process. */
async function startDemoApp(profile) {
  if (!fs.existsSync(APP_EXE)) {
    throw new Error(`${path.relative(REPO, APP_EXE)} is missing — run \`npm run tauri build -- --no-bundle\` first.`);
  }
  const child = spawn(APP_EXE, ['--hidden'], {
    env: { ...process.env, WAKFU_OVERLAY_DATA_DIR: profile.dataDir },
    stdio: 'ignore',
  });
  process.on('exit', () => child.kill());
  await waitForPort(profile.settings.overlayPort);
  return child;
}

module.exports = { REPO, hero, wait, createDemoProfile, startDemoApp };
