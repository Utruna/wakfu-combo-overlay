/**
 * tools/demo_settings_preload.js
 * Preload for capture_screenshots.js: renders ui/settings in a plain Electron
 * window by standing in for the app's Tauri commands (what
 * ui/settings/tauri-api.js calls) with the demo profile's data. Only the
 * screenshots need it — it never ships.
 *
 * Gets the demo settings path through DEMO_SETTINGS_FILE, and the activity
 * panel's entries from the capture script ('demo:debug' messages).
 */

/* eslint-env browser, node */

'use strict';

const fs = require('fs');
const path = require('path');
const { ipcRenderer } = require('electron');

const REPO = path.resolve(__dirname, '..');
const settings = JSON.parse(fs.readFileSync(process.env.DEMO_SETTINGS_FILE, 'utf8'));
const spellIcons = JSON.parse(fs.readFileSync(path.join(REPO, 'data', 'spellIcons.json'), 'utf8'));
const version = require(path.join(REPO, 'package.json')).version;

// Same data the app builds (src-tauri/src/catalog.rs).
const classIcons = Object.fromEntries(fs.readdirSync(path.join(REPO, 'ui', 'assets', 'icons', 'classes'))
  .filter((f) => f.endsWith('.png'))
  .map((f) => [path.basename(f, '.png'), `assets/icons/classes/${f}`]));
const COLORS = [[74, 144, 226], [220, 50, 50], [76, 175, 80], [171, 71, 188], [255, 167, 38], [38, 198, 218]];
const previewPool = Object.entries(spellIcons).map(([cls, spells], i) => {
  const [spellName, entry] = Object.entries(spells)[0];
  const [r, g, b] = COLORS[i % COLORS.length];
  return { class: cls, spellName, icon: entry.icon, color: { r, g, b } };
});

// Shown as the real defaults would be, not the demo profile's temp paths.
const SHOWN_LOGS_DIR = 'C:\\Users\\toi\\AppData\\Roaming\\zaap\\gamesLogs\\wakfu\\logs';
const SHOWN_LOADER = 'C:\\Users\\toi\\AppData\\Roaming\\Wakfu Combo Overlay\\overlay-obs.html';

const handlers = {
  get_state: () => ({
    heroes: settings.heroes,
    trackedCharacterNames: settings.trackedCharacterNames,
    comboLayout: settings.comboLayout,
    iconSizeRange: { min: 16, max: 128, default: 32 },
    castLifetimeRange: { min: 1000, max: 60000, default: 6000 },
    maxVisibleCastsRange: { min: 1, max: 20, default: 8 },
    classIcons,
    previewPool,
    showOnboarding: false,
  }),
  get_diagnostics: () => ({
    logsDir: SHOWN_LOGS_DIR,
    logsDirExists: true,
    overlayUrl: 'http://localhost:3457',
    overlayPort: 3457,
    overlayClients: 1,
    overlayError: null,
    obsLoaderPath: SHOWN_LOADER,
    lastCastAt: Date.now() - 2000,
  }),
  get_launch_at_login: () => ({ available: true, enabled: true }),
  get_app_version: () => version,
  get_update_status: () => ({ status: 'not-available' }),
  set_tracked_heroes: ({ characterNames }) => { settings.trackedCharacterNames = characterNames; },
  set_combo_layout: ({ layout }) => { Object.assign(settings.comboLayout, layout); },
  add_hero: () => true,
  update_hero: () => true,
};

const listeners = new Map();
ipcRenderer.on('demo:debug', (_e, entry) => {
  for (const callback of listeners.get('debug:event') ?? []) callback({ payload: entry });
});

window.__TAURI__ = {
  core: {
    invoke: async (command, args = {}) => (handlers[command] ? handlers[command](args) : null),
  },
  event: {
    listen: async (eventName, callback) => {
      if (!listeners.has(eventName)) listeners.set(eventName, new Set());
      listeners.get(eventName).add(callback);
      return () => listeners.get(eventName).delete(callback);
    },
  },
};
