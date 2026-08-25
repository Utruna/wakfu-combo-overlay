/**
 * electron/main.js — Wakfu Combo Overlay
 *
 * Standalone desktop app: tails the Wakfu combat log, filters casts down to
 * the tracked heroes, and serves a live combo-list overlay for OBS. Has
 * nothing to do with the Stream Deck tool (index.js) — no shared runtime
 * state, just the same heroes.json roster and two small reusable modules.
 */

'use strict';

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, Tray, Menu, ipcMain, dialog } = require('electron');

const { OverlayServer } = require('../overlay/server');
const { WakfuCombatLogReader } = require('../src/wakfuCombatLogReader');
const { CharacterMatcher } = require('../src/characterMatcher');
const { SettingsStore } = require('../src/settingsStore');

const OVERLAY_PORT = 3457;

app.setName('Wakfu Combo Overlay'); // keeps userData path consistent between dev and packaged runs

// Only one instance may run at a time — a second launch (e.g. double-clicking the
// exe while it's already running in the tray) would otherwise crash trying to bind
// the same overlay port. Instead, just focus the settings window of the existing one.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
  return;
}

const ROOT_DIR = app.isPackaged ? app.getAppPath() : path.resolve(__dirname, '..');
const HEROES_CONFIG_PATH = path.join(ROOT_DIR, 'heroes.json');

let tray = null;
let settingsWindow = null;
let combatLogReader = null;
let overlay = null;

app.on('second-instance', () => {
  showSettingsWindow();
});

function loadHeroesConfig() {
  return JSON.parse(fs.readFileSync(HEROES_CONFIG_PATH, 'utf-8'));
}

/** name -> {class, iconId, icon} lookup built by tools/scrape_spell_icons.js. Missing file = no icons, text-only fallback. */
function loadSpellIcons() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'data', 'spellIcons.json'), 'utf-8'));
  } catch {
    return {};
  }
}

function findSampleSpellForClass(spellIcons, classSlug) {
  for (const [name, info] of Object.entries(spellIcons)) {
    if (info.class === classSlug) return name;
  }
  return null;
}

function pushDebugEvent(entry) {
  console.log(`[debug] ${entry.status} — ${entry.characterName} -> ${entry.spellName ?? ''}`);
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send('debug:event', entry);
  }
}

function createSettingsWindow() {
  settingsWindow = new BrowserWindow({
    width: 480,
    height: 640,
    show: true,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  settingsWindow.loadFile(path.join(__dirname, 'settings', 'index.html'));
  settingsWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      settingsWindow.hide();
    }
  });
}

function showSettingsWindow() {
  if (!settingsWindow || settingsWindow.isDestroyed()) createSettingsWindow();
  settingsWindow.show();
  settingsWindow.focus();
}

function createTray() {
  tray = new Tray(path.join(ROOT_DIR, 'assets', 'tray-icon.png'));
  tray.setToolTip('Wakfu Combo Overlay');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Ouvrir les réglages', click: showSettingsWindow },
    { type: 'separator' },
    { label: 'Quitter', click: () => { app.isQuitting = true; app.quit(); } },
  ]));
  tray.on('click', showSettingsWindow);
}

app.whenReady().then(async () => {
  let heroesConfig;
  try {
    heroesConfig = loadHeroesConfig();
  } catch (err) {
    dialog.showErrorBox('Wakfu Combo Overlay', `Impossible de charger heroes.json :\n${err.message}`);
    app.quit();
    return;
  }
  const characterMap = heroesConfig.settings?.characterMap || {};
  const spellIcons = loadSpellIcons();

  const settingsStore = new SettingsStore(path.join(app.getPath('userData'), 'settings.json'));
  settingsStore.ensureDefaults({
    trackedHeroIndexes: heroesConfig.heroes.map((_, i) => i),
    comboLayout: { orientation: 'vertical', direction: 'top-to-bottom' },
  });

  overlay = new OverlayServer({ rootDir: ROOT_DIR, staticDir: path.join(__dirname, 'overlay') });
  overlay.start(OVERLAY_PORT);
  overlay.broadcastConfig(settingsStore.comboLayout);

  settingsStore.on('comboLayoutChanged', (layout) => overlay.broadcastConfig(layout));

  combatLogReader = new WakfuCombatLogReader((castEvent) => {
    const heroIndex = CharacterMatcher.findHeroIndexByName(
      castEvent.characterName,
      heroesConfig.heroes,
      { characterMap, strict: true }
    );
    if (heroIndex === null) {
      pushDebugEvent({
        status: 'ignored-unmatched',
        characterName: castEvent.characterName,
        spellName: castEvent.spellName,
        timestamp: castEvent.timestamp,
      });
      return; // random player or mob — excluded
    }

    const hero = heroesConfig.heroes[heroIndex];

    if (!settingsStore.isTracked(heroIndex)) {
      pushDebugEvent({
        status: 'ignored-untracked',
        characterName: castEvent.characterName,
        heroName: hero.name,
        spellName: castEvent.spellName,
        timestamp: castEvent.timestamp,
      });
      return; // configured but not currently tracked
    }

    pushDebugEvent({
      status: 'broadcast',
      characterName: castEvent.characterName,
      heroName: hero.name,
      spellName: castEvent.spellName,
      timestamp: castEvent.timestamp,
    });

    const iconEntry = spellIcons[castEvent.spellName.trim()];

    overlay.broadcastCast({
      characterName: castEvent.characterName,
      heroIndex,
      heroName: hero.name,
      spellName: castEvent.spellName,
      color: hero.color,
      timestamp: castEvent.timestamp,
      icon: iconEntry?.icon ?? null,
    });
  });
  await combatLogReader.start();

  ipcMain.handle('settings:getState', () => ({
    heroes: heroesConfig.heroes,
    trackedHeroIndexes: settingsStore.trackedHeroIndexes,
    comboLayout: settingsStore.comboLayout,
  }));
  ipcMain.handle('settings:setTrackedHeroes', (_e, indexes) => settingsStore.setTrackedHeroes(indexes));
  ipcMain.handle('settings:setComboLayout', (_e, layout) => settingsStore.setComboLayout(layout));

  ipcMain.handle('settings:getDiagnostics', () => ({
    logsDir: WakfuCombatLogReader.DEFAULT_LOGS_DIR,
    logsDirExists: fs.existsSync(WakfuCombatLogReader.DEFAULT_LOGS_DIR),
    overlayUrl: `http://localhost:${OVERLAY_PORT}`,
    overlayClients: overlay.clientCount,
  }));

  ipcMain.handle('settings:sendTestCast', (_e, heroIndex) => {
    const hero = heroesConfig.heroes[heroIndex] ?? heroesConfig.heroes[0];
    if (!hero) return;
    const classSlug = path.basename(hero.profile ?? '', '.json');
    const sampleSpellName = findSampleSpellForClass(spellIcons, classSlug);
    const spellName = sampleSpellName ?? 'Sort de test';
    const testEvent = {
      characterName: hero.characterName,
      heroIndex: heroesConfig.heroes.indexOf(hero),
      heroName: hero.name,
      spellName,
      color: hero.color,
      timestamp: Date.now(),
      icon: sampleSpellName ? spellIcons[sampleSpellName].icon : null,
    };
    pushDebugEvent({ status: 'test', characterName: hero.characterName, heroName: hero.name, spellName: testEvent.spellName, timestamp: testEvent.timestamp });
    overlay.broadcastCast(testEvent);
  });

  createTray();
  createSettingsWindow();
});

app.on('window-all-closed', () => {
  // Keep running in the tray — the combat-log reader and overlay must survive
  // the settings window closing.
});

app.on('before-quit', () => {
  app.isQuitting = true;
  combatLogReader?.stop();
  overlay?.stop();
});
