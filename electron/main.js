/**
 * electron/main.js — Wakfu Combo Overlay
 *
 * Standalone desktop app: tails the Wakfu combat log, filters casts down to
 * the tracked heroes, and serves a live combo-list overlay for OBS. Has
 * nothing to do with the Stream Deck tool (index.js) — no shared runtime
 * state. The tracked-character roster lives entirely in this app's own
 * settings (SettingsStore), keyed by characterName, and starts empty.
 */

'use strict';

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, Tray, Menu, ipcMain, dialog, shell } = require('electron');
const { autoUpdater } = require('electron-updater');

const { OverlayServer } = require('../overlay/server');
const { WakfuCombatLogReader } = require('../src/wakfuCombatLogReader');
const { CharacterMatcher } = require('../src/characterMatcher');
const { writeLoaderPage } = require('../src/obsLoaderPage');
const {
  SettingsStore,
  DEFAULT_ICON_SIZE, MIN_ICON_SIZE, MAX_ICON_SIZE,
  DEFAULT_CAST_LIFETIME_MS, MIN_CAST_LIFETIME_MS, MAX_CAST_LIFETIME_MS,
  DEFAULT_MAX_VISIBLE_CASTS, MIN_MAX_VISIBLE_CASTS, MAX_MAX_VISIBLE_CASTS,
} = require('../src/settingsStore');

const DEFAULT_OVERLAY_PORT = 3457;

app.setName('Wakfu Combo Overlay'); // keeps userData path consistent between dev and packaged runs

// The only UI is a plain settings form, so the dedicated GPU process
// Chromium spawns for hardware acceleration is pure memory overhead here.
app.disableHardwareAcceleration();

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
let overlayError = null; // why the overlay server isn't listening, or null when it is
let lastCastAt = null; // when a tracked hero's cast last reached the overlay, for the diagnostics panel

// Passed by the Windows login item (see setLaunchAtLogin): starts straight in
// the tray instead of popping the settings window at every session start.
const LAUNCHED_AT_LOGIN_ARG = '--hidden';
const launchedAtLogin = process.argv.includes(LAUNCHED_AT_LOGIN_ARG);

/**
 * Starting with Windows is what keeps the overlay reachable when OBS opens
 * first: a browser source whose first load fails shows an error page and
 * never retries by itself, so the server has to be up before OBS is.
 */
function getLaunchAtLogin() {
  if (!app.isPackaged) return { available: false, enabled: false };
  const { openAtLogin } = app.getLoginItemSettings({ args: [LAUNCHED_AT_LOGIN_ARG] });
  return { available: true, enabled: openAtLogin };
}

function setLaunchAtLogin(enabled) {
  if (!app.isPackaged) return getLaunchAtLogin();
  app.setLoginItemSettings({ openAtLogin: Boolean(enabled), args: [LAUNCHED_AT_LOGIN_ARG] });
  return getLaunchAtLogin();
}

app.on('second-instance', () => {
  // A second launch during our own startup would otherwise try to create a
  // BrowserWindow before the app is ready, which throws.
  if (app.isReady()) showSettingsWindow();
});

/** class -> {spellName -> {iconId, icon}} table built by tools/scrape_spell_icons.js. Missing file = no icons, nothing displayed. */
function loadSpellIcons() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'data', 'spellIcons.json'), 'utf-8'));
  } catch {
    return {};
  }
}

/**
 * Look up a spell's icon, scoped to the caster's class when known (this is what
 * correctly resolves same-named spells across classes, e.g. "Rafale" for both
 * Iop and Cra). Falls back to a best-effort search across every class when the
 * hero's class isn't set (e.g. a hero added before this field existed).
 */
function findSpellIcon(spellIcons, heroClass, spellName) {
  const direct = heroClass && spellIcons[heroClass]?.[spellName];
  if (direct) return direct;

  for (const classSpells of Object.values(spellIcons)) {
    if (classSpells[spellName]) return classSpells[spellName];
  }
  return null;
}

const CLASS_LOGOS_DIR = path.join(ROOT_DIR, 'assets', 'icons', 'classes');

/** class -> official class/god emblem path (assets/icons/classes/<class>.png), scraped by tools/scrape_spell_icons.js from wakfu.com. */
function buildClassIconMap() {
  const classIcons = {};
  let files = [];
  try {
    files = fs.readdirSync(CLASS_LOGOS_DIR);
  } catch {
    return classIcons;
  }
  for (const file of files) {
    if (!file.endsWith('.png')) continue;
    classIcons[path.basename(file, '.png')] = `assets/icons/classes/${file}`;
  }
  return classIcons;
}

function buildPreviewPool(spellIcons) {
  const colors = [
    { r: 74, g: 144, b: 226 },
    { r: 220, g: 50, b: 50 },
    { r: 76, g: 175, b: 80 },
    { r: 171, g: 71, b: 188 },
    { r: 255, g: 167, b: 38 },
    { r: 38, g: 198, b: 218 },
  ];
  const pool = [];
  let colorIndex = 0;
  for (const [heroClass, spells] of Object.entries(spellIcons || {})) {
    const [spellName, iconEntry] = Object.entries(spells || {})[0] || [];
    if (!spellName || !iconEntry?.icon) continue;
    pool.push({
      class: heroClass,
      spellName,
      icon: iconEntry.icon,
      color: colors[colorIndex % colors.length],
    });
    colorIndex += 1;
  }
  return pool;
}

/**
 * (Re)creates the overlay HTTP/SSE server on the given port, preserving the current layout.
 *
 * @returns {Promise<{server: OverlayServer, ok: boolean, error?: string}>} `server` is
 *   returned even on failure so the caller can dispose of it — it just never bound.
 */
async function startOverlay(port, comboLayout) {
  const server = new OverlayServer({ rootDir: ROOT_DIR, staticDir: path.join(__dirname, 'overlay') });
  const result = await server.start(port);
  if (result.ok) server.broadcastConfig(comboLayout);
  return { server, ok: result.ok, error: result.error };
}

function pushDebugEvent(entry) {
  if (entry.status === 'broadcast') lastCastAt = entry.timestamp || Date.now();
  console.log(`[debug] ${entry.status} — ${entry.characterName} -> ${entry.spellName ?? ''}`);
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send('debug:event', entry);
  }
}

// ── Auto-update ──────────────────────────────────────────────────────────
// Checks the app's own GitHub Releases (same ones .github/workflows/release.yml
// publishes) via electron-updater. Downloads only on explicit confirmation —
// never silently, so a background check never surprises the user mid-stream.

autoUpdater.autoDownload = false;

// Set only while a manually-triggered check is in flight, so "up to date" is
// only announced when someone actually asked — the silent startup check must
// stay silent when there's nothing new.
let manualUpdateCheckPending = false;

// Kept so a settings window opened later (it's destroyed when closed, see
// createSettingsWindow) still shows the result of the last check.
let lastUpdateStatus = null;

function pushUpdateStatus(status, extra = {}) {
  lastUpdateStatus = { status, ...extra };
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send('update:status', lastUpdateStatus);
  }
}

/** Attached to the settings window when it's open, standalone otherwise (it may not exist). */
function showMessageBox(options) {
  return settingsWindow && !settingsWindow.isDestroyed()
    ? dialog.showMessageBox(settingsWindow, options)
    : dialog.showMessageBox(options);
}

autoUpdater.on('checking-for-update', () => pushUpdateStatus('checking'));

autoUpdater.on('update-available', (info) => {
  pushUpdateStatus('available', { version: info.version });
  showMessageBox({
    type: 'info',
    buttons: ['Télécharger', 'Plus tard'],
    defaultId: 0,
    cancelId: 1,
    title: 'Mise à jour disponible',
    message: `Une nouvelle version (${info.version}) est disponible.`,
    detail: 'Télécharger maintenant ? L\'installation se fera au redémarrage de l\'application.',
  }).then(({ response }) => {
    if (response === 0) autoUpdater.downloadUpdate();
  });
});

autoUpdater.on('update-not-available', () => {
  pushUpdateStatus('not-available');
  if (manualUpdateCheckPending) {
    showMessageBox({
      type: 'info',
      title: 'Mises à jour',
      message: `Tu es déjà à jour (v${app.getVersion()}).`,
    });
  }
  manualUpdateCheckPending = false;
});

autoUpdater.on('error', (err) => {
  pushUpdateStatus('error', { message: err?.message });
  if (manualUpdateCheckPending) {
    showMessageBox({
      type: 'error',
      title: 'Mises à jour',
      message: 'Erreur lors de la recherche de mise à jour.',
      detail: err?.message || '',
    });
  }
  manualUpdateCheckPending = false;
});

autoUpdater.on('download-progress', (progress) => pushUpdateStatus('downloading', { percent: progress.percent }));

autoUpdater.on('update-downloaded', (info) => {
  pushUpdateStatus('downloaded', { version: info.version });
  showMessageBox({
    type: 'info',
    buttons: ['Redémarrer maintenant', 'Plus tard'],
    defaultId: 0,
    cancelId: 1,
    title: 'Mise à jour prête',
    message: `La mise à jour vers la version ${info.version} est prête.`,
    detail: 'Redémarre l\'application pour l\'installer.',
  }).then(({ response }) => {
    if (response === 0) {
      app.isQuitting = true;
      autoUpdater.quitAndInstall();
    }
  });
});

function checkForUpdates({ manual = false } = {}) {
  if (!app.isPackaged) {
    if (manual) {
      showMessageBox({
        type: 'info',
        title: 'Mises à jour',
        message: 'Recherche de mise à jour indisponible en développement (build non packagé).',
      });
    }
    return;
  }

  manualUpdateCheckPending = manual;
  autoUpdater.checkForUpdates().catch((err) => {
    pushUpdateStatus('error', { message: err?.message });
    if (manualUpdateCheckPending) {
      showMessageBox({
        type: 'error',
        title: 'Mises à jour',
        message: 'Erreur lors de la recherche de mise à jour.',
        detail: err?.message || '',
      });
    }
    manualUpdateCheckPending = false;
  });
}

function createSettingsWindow() {
  settingsWindow = new BrowserWindow({
    width: 980,
    height: 680,
    minWidth: 900,
    minHeight: 620,
    useContentSize: true,
    backgroundColor: '#131a1e',
    show: true,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  const win = settingsWindow;
  win.loadFile(path.join(__dirname, 'settings', 'index.html'));
  win.webContents.on('did-finish-load', () => {
    if (lastUpdateStatus) win.webContents.send('update:status', lastUpdateStatus);
  });
  // Closing really destroys the window (instead of hiding it) so its renderer
  // process — the biggest share of the app's RAM — is freed while the app
  // sits in the tray. It's rebuilt from the persisted settings on reopen;
  // 'window-all-closed' below keeps the app itself alive.
  win.on('closed', () => {
    if (settingsWindow === win) settingsWindow = null;
  });
}

function showSettingsWindow() {
  if (!settingsWindow || settingsWindow.isDestroyed()) createSettingsWindow();
  if (settingsWindow.isMinimized()) settingsWindow.restore();
  settingsWindow.show();
  settingsWindow.focus();
}

function createTray() {
  tray = new Tray(path.join(ROOT_DIR, 'assets', 'tray-icon.png'));
  tray.setToolTip('Wakfu Combo Overlay');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Ouvrir les réglages', click: showSettingsWindow },
    { label: 'Vérifier les mises à jour', click: () => checkForUpdates({ manual: true }) },
    { type: 'separator' },
    { label: 'Quitter', click: () => { app.isQuitting = true; app.quit(); } },
  ]));
  tray.on('click', showSettingsWindow);
}

app.whenReady().then(async () => {
  const spellIcons = loadSpellIcons();
  const classIcons = buildClassIconMap();
  const previewPool = buildPreviewPool(spellIcons);

  const settingsStore = new SettingsStore(path.join(app.getPath('userData'), 'settings.json'));
  settingsStore.ensureDefaults({
    heroes: [],
    trackedCharacterNames: [],
    comboLayout: {
      orientation: 'vertical',
      direction: 'top-to-bottom',
      iconSize: DEFAULT_ICON_SIZE,
      castLifetimeMs: DEFAULT_CAST_LIFETIME_MS,
      maxVisibleCasts: DEFAULT_MAX_VISIBLE_CASTS,
      previewEnabled: false,
      classIconSide: 'left',
    },
    overlayPort: DEFAULT_OVERLAY_PORT,
    logsDir: WakfuCombatLogReader.DEFAULT_LOGS_DIR,
  });

  // Written before the server even tries to bind, so the file OBS points at
  // exists (and targets the right port) whatever happens next.
  let obsLoaderPath = writeLoaderPage(app.getPath('userData'), settingsStore.overlayPort);

  const overlayStart = await startOverlay(settingsStore.overlayPort, {
    ...settingsStore.comboLayout,
    classIcons,
    previewPool,
  });
  overlay = overlayStart.server;
  overlayError = overlayStart.ok ? null : overlayStart.error;
  if (!overlayStart.ok) {
    console.error('[main] Overlay server failed to start:', overlayStart.error);
    dialog.showErrorBox(
      'Port de l\'overlay indisponible',
      `Impossible de démarrer le serveur overlay sur le port ${settingsStore.overlayPort} (${overlayStart.error}).\n`
      + 'Change le port dans les réglages, panneau Diagnostic.'
    );
  }

  const pushOverlayConfig = (layout) => overlay.broadcastConfig({ ...layout, classIcons, previewPool });
  settingsStore.on('comboLayoutChanged', (layout) => pushOverlayConfig(layout));

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

    const iconEntry = findSpellIcon(spellIcons, hero.class, castEvent.spellName.trim());

    pushDebugEvent({
      status: 'broadcast',
      characterName: castEvent.characterName,
      heroName: hero.name,
      heroClass: hero.class,
      spellName: castEvent.spellName,
      iconMissing: !iconEntry,
      timestamp: castEvent.timestamp,
    });

    overlay.broadcastCast({
      characterName: castEvent.characterName,
      heroName: hero.name,
      class: hero.class,
      classIcon: classIcons[hero.class] ?? null,
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
    iconSizeRange: { min: MIN_ICON_SIZE, max: MAX_ICON_SIZE, default: DEFAULT_ICON_SIZE },
    castLifetimeRange: {
      min: MIN_CAST_LIFETIME_MS, max: MAX_CAST_LIFETIME_MS, default: DEFAULT_CAST_LIFETIME_MS,
    },
    maxVisibleCastsRange: {
      min: MIN_MAX_VISIBLE_CASTS, max: MAX_MAX_VISIBLE_CASTS, default: DEFAULT_MAX_VISIBLE_CASTS,
    },
    classIcons,
    previewPool,
    // First launch only: an existing roster means the app was already set up
    // before the assistant existed.
    showOnboarding: !settingsStore.onboardingDone && settingsStore.heroes.length === 0,
  }));
  ipcMain.handle('settings:setTrackedHeroes', (_e, characterNames) => settingsStore.setTrackedHeroes(characterNames));
  ipcMain.handle('settings:setComboLayout', (_e, layout) => settingsStore.setComboLayout(layout));
  ipcMain.handle('settings:addHero', (_e, hero, options) => settingsStore.addHero(hero, options));
  ipcMain.handle('settings:updateHero', (_e, characterName, changes) => settingsStore.updateHero(characterName, changes));
  ipcMain.handle('settings:setOnboardingDone', () => settingsStore.setOnboardingDone(true));
  ipcMain.handle('settings:setHeroColor', (_e, characterName, color) => settingsStore.setHeroColor(characterName, color));
  ipcMain.handle('settings:removeHero', (_e, characterName) => settingsStore.removeHero(characterName));

  ipcMain.handle('settings:getDiagnostics', () => ({
    logsDir: settingsStore.logsDir,
    logsDirExists: fs.existsSync(settingsStore.logsDir),
    overlayUrl: `http://localhost:${settingsStore.overlayPort}`,
    overlayPort: settingsStore.overlayPort,
    overlayClients: overlay.clientCount,
    overlayError,
    obsLoaderPath,
    lastCastAt,
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

  ipcMain.handle('settings:showObsLoader', () => {
    if (obsLoaderPath) shell.showItemInFolder(obsLoaderPath);
  });

  ipcMain.handle('settings:setOverlayPort', async (_e, port) => {
    // Same port only short-circuits when it's actually listening — after a
    // failed bind at startup, re-applying the same port is how to retry it.
    if (Number(port) === settingsStore.overlayPort && !overlayError) {
      return { ok: true, overlayUrl: `http://localhost:${settingsStore.overlayPort}` };
    }
    if (!SettingsStore.isValidPort(port)) {
      return { ok: false, error: 'Port invalide (doit être entre 1024 et 65535).' };
    }

    // Bind the new port BEFORE touching the old server or persisting anything:
    // if it's already taken, the current overlay keeps running untouched and
    // settings.json still points at the port that actually works.
    const value = Number(port);
    const attempt = await startOverlay(value, { ...settingsStore.comboLayout, classIcons, previewPool });
    if (!attempt.ok) {
      attempt.server.stop();
      return { ok: false, error: attempt.error };
    }

    overlay.stop();
    overlay = attempt.server;
    overlayError = null;
    settingsStore.setOverlayPort(value);
    obsLoaderPath = writeLoaderPage(app.getPath('userData'), value);
    return { ok: true, overlayUrl: `http://localhost:${value}` };
  });

  ipcMain.handle('settings:sendTestCast', (_e, characterName) => {
    const hero = settingsStore.heroes.find((h) => h.characterName === characterName) ?? settingsStore.heroes[0];
    if (!hero) return;

    // Prefer a real spell from the hero's own class; fall back to any class's
    // spell if the hero has none set (heroes added before the class field existed).
    const classSpells = spellIcons[hero.class] || {};
    const namesToPickFrom = Object.keys(classSpells).length
      ? Object.keys(classSpells)
      : Object.keys(spellIcons).flatMap((cls) => Object.keys(spellIcons[cls]));
    const sampleSpellName = namesToPickFrom.length
      ? namesToPickFrom[Math.floor(Math.random() * namesToPickFrom.length)]
      : null;
    const spellName = sampleSpellName ?? 'Sort de test';

    const testEvent = {
      characterName: hero.characterName,
      heroName: hero.name,
      class: hero.class,
      classIcon: classIcons[hero.class] ?? null,
      spellName,
      color: hero.color,
      timestamp: Date.now(),
      icon: sampleSpellName ? findSpellIcon(spellIcons, hero.class, sampleSpellName)?.icon : null,
    };
    pushDebugEvent({ status: 'test', characterName: hero.characterName, heroName: hero.name, heroClass: hero.class, spellName: testEvent.spellName, timestamp: testEvent.timestamp });
    overlay.broadcastCast(testEvent);
  });

  ipcMain.handle('app:getLaunchAtLogin', () => getLaunchAtLogin());
  ipcMain.handle('app:setLaunchAtLogin', (_e, enabled) => setLaunchAtLogin(enabled));

  ipcMain.handle('updates:check', () => checkForUpdates({ manual: true }));
  ipcMain.handle('updates:getVersion', () => app.getVersion());

  createTray();
  // At login the app starts straight in the tray: don't even spawn the
  // window's renderer process until the user opens it.
  if (!launchedAtLogin) createSettingsWindow();

  // Silent check a few seconds after launch — never interrupts startup, and
  // stays quiet unless a newer version actually exists (see update-not-available above).
  setTimeout(() => checkForUpdates({ manual: false }), 3000);
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
