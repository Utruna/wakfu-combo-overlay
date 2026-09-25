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

const LAYOUT_DEFAULTS = {
  heroes: [],
  trackedCharacterNames: [],
  comboLayout: {
    orientation: 'vertical',
    direction: 'top-to-bottom',
    iconSize: 32,
    castLifetimeMs: 6000,
    maxVisibleCasts: 8,
    previewEnabled: false,
    classIconSide: 'left',
  },
  overlayPort: 3456,
  logsDir: 'logs',
};

test('keeps the class icon where it was for layouts saved before the setting existed', () => {
  const file = tmpSettingsPath();
  fs.writeFileSync(file, JSON.stringify({
    comboLayout: { ...LAYOUT_DEFAULTS.comboLayout, direction: 'bottom-to-top', classIconSide: undefined },
  }));
  const store = new SettingsStore(file);
  store.ensureDefaults(LAYOUT_DEFAULTS);
  assert.equal(store.comboLayout.classIconSide, 'right');
});

test('ignores an invalid class icon side', () => {
  const file = tmpSettingsPath();
  const store = new SettingsStore(file);
  store.ensureDefaults(LAYOUT_DEFAULTS);
  store.setComboLayout({ classIconSide: 'right' });
  store.setComboLayout({ classIconSide: 'middle' });
  assert.equal(store.comboLayout.classIconSide, 'right');
});

const BLUE = { r: 74, g: 144, b: 226 };

test('re-inserts a removed hero at its old position and tracked state', () => {
  const store = new SettingsStore(tmpSettingsPath());
  store.ensureDefaults(LAYOUT_DEFAULTS);
  store.addHero({ characterName: 'A', color: BLUE, class: 'iop' });
  store.addHero({ characterName: 'B', color: BLUE, class: 'cra' });
  store.addHero({ characterName: 'C', color: BLUE, class: 'sram' });
  store.setTrackedHeroes(['A', 'C']);

  store.removeHero('B');
  assert.equal(store.addHero({ characterName: 'B', color: BLUE, class: 'cra' }, { index: 1, tracked: false }), true);

  assert.deepEqual(store.heroes.map((h) => h.characterName), ['A', 'B', 'C']);
  assert.equal(store.isTracked('B'), false);
});

test('renames a hero, keeping it tracked under its new name', () => {
  const store = new SettingsStore(tmpSettingsPath());
  store.ensureDefaults(LAYOUT_DEFAULTS);
  store.addHero({ characterName: 'Old', color: BLUE, class: 'iop' });

  assert.equal(store.updateHero('Old', { characterName: 'New', class: 'cra' }), true);

  assert.deepEqual(store.heroes, [{ name: 'New', characterName: 'New', color: BLUE, class: 'cra' }]);
  assert.deepEqual(store.trackedCharacterNames, ['New']);
});

test('refuses to rename a hero to a blank or already used name', () => {
  const store = new SettingsStore(tmpSettingsPath());
  store.ensureDefaults(LAYOUT_DEFAULTS);
  store.addHero({ characterName: 'A', color: BLUE, class: 'iop' });
  store.addHero({ characterName: 'B', color: BLUE, class: 'cra' });

  assert.equal(store.updateHero('A', { characterName: 'B' }), false);
  assert.equal(store.updateHero('A', { characterName: '  ' }), false);
  assert.deepEqual(store.heroes.map((h) => h.characterName), ['A', 'B']);
});

test('persists the onboarding flag', () => {
  const file = tmpSettingsPath();
  assert.equal(new SettingsStore(file).onboardingDone, false);
  new SettingsStore(file).setOnboardingDone();
  assert.equal(new SettingsStore(file).onboardingDone, true);
});
