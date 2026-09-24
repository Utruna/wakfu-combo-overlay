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

test('class icon style only accepts known values', () => {
  const store = new SettingsStore(tmpSettingsPath());
  store.setComboLayout({ classIconStyle: 'head' });
  store.setComboLayout({ classIconStyle: 'nimportequoi' });
  assert.equal(store.comboLayout.classIconStyle, 'head');
});

test('hero gender defaults to male and can be switched', () => {
  const store = new SettingsStore(tmpSettingsPath());
  store.addHero({ characterName: 'Perso', class: 'osamodas', color: { r: 1, g: 2, b: 3 } });
  assert.equal(store.heroes[0].gender, 'm');
  store.setHeroGender('Perso', 'f');
  assert.equal(store.heroes[0].gender, 'f');
});

test('every class has both head icons', () => {
  const dir = path.join(__dirname, '..', 'assets', 'icons', 'class-heads');
  const classes = fs.readdirSync(path.join(__dirname, '..', 'assets', 'icons', 'classes'))
    .map((f) => path.basename(f, '.png'));
  for (const heroClass of classes) {
    for (const gender of ['m', 'f']) {
      assert.ok(fs.existsSync(path.join(dir, `${heroClass}-${gender}.png`)), `${heroClass}-${gender}.png`);
    }
  }
});
