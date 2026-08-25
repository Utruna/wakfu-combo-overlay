/**
 * electron/main.js — Wakfu Combo Overlay
 *
 * Standalone desktop app: tails the Wakfu combat log, filters casts down to
 * the tracked heroes, and serves a live combo-list overlay for OBS. Has
 * nothing to do with the Stream Deck tool (index.js) — no shared runtime
 * state. The tracked-character roster lives entirely in this app's own
 * settings (SettingsStore), keyed by characterName; heroes.json is only
 * consulted once, on first run, to seed that roster so nothing already
 * configured for the Stream Deck tool is lost.
 */

'use strict';

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, Tray, Menu, ipcMain, dialog } = require('electron');

const { OverlayServer } = require('../overlay/server');
const { WakfuCombatLogReader } = require('../src/wakfuCombatLogReader');
const { CharacterMatcher } = require('../src/characterMatcher');
const { SettingsStore } = require('../src/settingsStore');

const DEFAULT_OVERLAY_PORT = 3457;

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

let tray = null;
let settingsWindow = null;
let combatLogReader = null;
let overlay = null;

app.on('second-instance', () => {
  showSettingsWindow();
});

/** One-time seed for first run only — heroes.json stays the Stream Deck tool's own file. */
function loadHeroesJsonSeed() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'heroes.json'), 'utf-8'));
    return (raw.heroes || []).map((h) => ({
      name: h.name,
      characterName: h.characterName,
      color: h.color,
    }));
  } catch {
    return [];
  }
}

/** name -> {class, iconId, icon} lookup built by tools/scrape_spell_icons.js. Missing file = no icons, text-only fallback. */
function loadSpellIcons() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'data', 'spellIcons.json'), 'utf-8'));
  } catch {
    return {};
  }
}

/** (Re)creates the overlay HTTP/SSE server on the given port, preserving the current layout. */
function startOverlay(port, comboLayout) {
  const server = new OverlayServer({ rootDir: ROOT_DIR, staticDir: path.join(__dirname, 'overlay') });
  server.start(port);
  server.broadcastConfig(comboLayout);
  return server;
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
    height: 700,
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
  const spellIcons = loadSpellIcons();

  const settingsStore = new SettingsStore(path.join(app.getPath('userData'), 'settings.json'));
  const seedHeroes = loadHeroesJsonSeed();
  settingsStore.ensureDefaults({
    heroes: seedHeroes,
    trackedCharacterNames: seedHeroes.map((h) => h.characterName),
    comboLayout: { orientation: 'vertical', direction: 'top-to-bottom' },
    overlayPort: DEFAULT_OVERLAY_PORT,
    logsDir: WakfuCombatLogReader.DEFAULT_LOGS_DIR,
  });

  overlay = startOverlay(settingsStore.overlayPort, settingsStore.comboLayout);

  settingsStore.on('comboLayoutChanged', (layout) => overlay.broadcastConfig(layout));

  function handleCastEvent(castEvent) {
    // Read the roster live on every event — it can change at runtime via add/remove.
    const heroes = settingsStore.heroes;
    const heroIndex = CharacterMatcher.findHeroIndexByName(
      castEvent.characterName,
      heroes,
      { strict: true }
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

    const hero = heroes[heroIndex];

    if (!settingsStore.isTracked(hero.characterName)) {
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
      heroName: hero.name,
      spellName: castEvent.spellName,
      color: hero.color,
      timestamp: castEvent.timestamp,
      icon: iconEntry?.icon ?? null,
    });
  }

  async function startCombatLogReader(logsDir) {
    const reader = new WakfuCombatLogReader(handleCastEvent, { logsDir });
    await reader.start();
    return reader;
  }

  combatLogReader = await startCombatLogReader(settingsStore.logsDir);

  ipcMain.handle('settings:getState', () => ({
    heroes: settingsStore.heroes,
    trackedCharacterNames: settingsStore.trackedCharacterNames,
    comboLayout: settingsStore.comboLayout,
  }));
  ipcMain.handle('settings:setTrackedHeroes', (_e, characterNames) => settingsStore.setTrackedHeroes(characterNames));
  ipcMain.handle('settings:setComboLayout', (_e, layout) => settingsStore.setComboLayout(layout));
  ipcMain.handle('settings:addHero', (_e, hero) => settingsStore.addHero(hero));
  ipcMain.handle('settings:removeHero', (_e, characterName) => settingsStore.removeHero(characterName));

  ipcMain.handle('settings:getDiagnostics', () => ({
    logsDir: settingsStore.logsDir,
    logsDirExists: fs.existsSync(settingsStore.logsDir),
    overlayUrl: `http://localhost:${settingsStore.overlayPort}`,
    overlayPort: settingsStore.overlayPort,
    overlayClients: overlay.clientCount,
  }));

  ipcMain.handle('settings:setLogsDir', async (_e, dir) => {
    if (dir === settingsStore.logsDir) {
      return { ok: true, logsDir: settingsStore.logsDir, logsDirExists: fs.existsSync(settingsStore.logsDir) };
    }

    const applied = settingsStore.setLogsDir(dir);
    if (!applied) {
      return { ok: false, error: 'Chemin invalide.' };
    }

    combatLogReader.stop();
    combatLogReader = await startCombatLogReader(settingsStore.logsDir);
    return { ok: true, logsDir: settingsStore.logsDir, logsDirExists: fs.existsSync(settingsStore.logsDir) };
  });

  ipcMain.handle('settings:browseLogsDir', async () => {
    const result = await dialog.showOpenDialog(settingsWindow, {
      properties: ['openDirectory'],
      defaultPath: settingsStore.logsDir,
      title: 'Choisir le dossier de logs Wakfu',
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('settings:setOverlayPort', (_e, port) => {
    if (Number(port) === settingsStore.overlayPort) {
      return { ok: true, overlayUrl: `http://localhost:${settingsStore.overlayPort}` };
    }

    const applied = settingsStore.setOverlayPort(port);
    if (!applied) {
      return { ok: false, error: 'Port invalide (doit être entre 1024 et 65535).' };
    }

    overlay.stop();
    overlay = startOverlay(settingsStore.overlayPort, settingsStore.comboLayout);
    return { ok: true, overlayUrl: `http://localhost:${settingsStore.overlayPort}` };
  });

  ipcMain.handle('settings:sendTestCast', (_e, characterName) => {
    const hero = settingsStore.heroes.find((h) => h.characterName === characterName) ?? settingsStore.heroes[0];
    if (!hero) return;

    // Class isn't tracked for user-added heroes, so just grab any icon as a
    // visual smoke test rather than trying to match the hero's real spells.
    const spellNames = Object.keys(spellIcons);
    const sampleSpellName = spellNames.length
      ? spellNames[Math.floor(Math.random() * spellNames.length)]
      : null;
    const spellName = sampleSpellName ?? 'Sort de test';

    const testEvent = {
      characterName: hero.characterName,
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
