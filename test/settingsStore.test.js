'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { SettingsStore } = require('../src/settingsStore');

function tmpSettingsPath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wakfu-settings-')), 'settings.json');
}

test('persists the overlay port across restarts', () => {
  const file = tmpSettingsPath();
  new SettingsStore(file).setOverlayPort(4000);
  assert.equal(new SettingsStore(file).overlayPort, 4000);
});

test('falls back to the backup when settings.json is corrupt', () => {
  const file = tmpSettingsPath();
  const store = new SettingsStore(file);
  store.setOverlayPort(4000);
  store.setOverlayPort(4001); // second write creates the .bak holding 4000

  fs.writeFileSync(file, ''); // simulates a write interrupted by a crash/shutdown

  assert.equal(new SettingsStore(file).overlayPort, 4000);
});

test('leaves no temp file behind', () => {
  const file = tmpSettingsPath();
  new SettingsStore(file).setOverlayPort(4000);
  assert.equal(fs.existsSync(`${file}.tmp`), false);
});
