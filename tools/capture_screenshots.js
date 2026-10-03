/**
 * tools/capture_screenshots.js
 * Regenerates the README screenshots (doc/app-*.png, doc/overlay-rendu.png)
 * by launching the real app on an isolated demo profile (fake heroes, fake
 * wakfu.log, port 3499 so a running instance isn't disturbed).
 *
 * Usage: npx electron tools/capture_screenshots.js
 * (from a VS Code terminal, unset ELECTRON_RUN_AS_NODE first)
 */

'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, BrowserWindow } = require('electron');

const REPO = path.resolve(__dirname, '..');
const OUT = path.join(REPO, 'doc');
const WORK = path.join(os.tmpdir(), 'wakfu-combo-overlay-capture');
const USER_DATA = path.join(WORK, 'userData');
const LOGS = path.join(WORK, 'logs');
const LOG_FILE = path.join(LOGS, 'wakfu.log');
const PORT = 3499;

fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(USER_DATA, { recursive: true });
fs.mkdirSync(LOGS, { recursive: true });
fs.writeFileSync(LOG_FILE, '');

const hero = (n, cls, r, g, b) => ({ name: n, characterName: n, class: cls, color: { r, g, b } });
const heroes = [
  hero('Lueur Ocre', 'iop', 74, 144, 226),
  hero('Lueur Pourpre', 'sram', 220, 50, 50),
  hero('Lueur Grenat', 'eniripsa', 76, 175, 80),
  hero('Lueur Acérée', 'cra', 255, 167, 38),
  hero('Lueur Etherique', 'huppermage', 171, 71, 188),
];
fs.writeFileSync(path.join(USER_DATA, 'settings.json'), JSON.stringify({
  heroes,
  trackedCharacterNames: heroes.slice(0, 4).map((h) => h.characterName),
  comboLayout: {
    orientation: 'horizontal', direction: 'left-to-right', iconSize: 48,
    castLifetimeMs: 60000, maxVisibleCasts: 8, previewEnabled: false, classIconSide: 'left',
  },
  overlayPort: PORT,
  logsDir: LOGS,
  onboardingDone: true,
}, null, 2));

app.setPath('userData', USER_DATA);
// main.js calls app.setName, which must not move userData away from the demo profile.
const realSetName = app.setName.bind(app);
app.setName = (n) => { realSetName(n); app.setPath('userData', USER_DATA); };

const PKG_VERSION = require(path.join(REPO, 'package.json')).version;
app.getVersion = () => PKG_VERSION;
require(path.join(REPO, 'electron', 'main.js'));

// Cosmetic: show the default port / logs path instead of the demo profile's.
const POLISH = `
  for (const id of ['overlay-url', 'wz-url']) { const e = document.getElementById(id); if (e) e.textContent = e.textContent.replace('${PORT}', '3457'); }
  document.getElementById('overlay-port-input').value = '3457';
  document.getElementById('logs-dir-input').value = 'C:\\\\Users\\\\toi\\\\AppData\\\\Roaming\\\\zaap\\\\gamesLogs\\\\wakfu\\\\logs';
  document.getElementById('obs-loader-path').textContent = 'C:\\\\Users\\\\toi\\\\AppData\\\\Roaming\\\\Wakfu Combo Overlay\\\\overlay-obs.html';
  document.getElementById('update-status').textContent = 'À jour';
`;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const cast = (who, spell) => fs.appendFileSync(LOG_FILE,
  `INFO 21:14:03,512 [AWT-EventQueue-0] (eQo:174) - [Information (combat)] ${who} lance le sort ${spell}\n`);

async function shot(win, name, js) {
  if (js) await win.webContents.executeJavaScript(js);
  await wait(700);
  await win.webContents.executeJavaScript(POLISH);
  await wait(100);
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, name), img.toPNG());
  console.log('[capture] wrote', name, img.getSize());
}

app.whenReady().then(async () => {
  let win;
  while (!(win = BrowserWindow.getAllWindows()[0])) await wait(100);
  await new Promise((r) => (win.webContents.isLoading() ? win.webContents.once('did-finish-load', r) : r()));
  await wait(1500);

  // Overlay "OBS" client, so the diagnostics show a connected source.
  const overlayWin = new BrowserWindow({
    width: 622, height: 92, useContentSize: true, show: false, backgroundColor: '#1b1f24',
    webPreferences: { offscreen: false },
  });
  await overlayWin.loadURL(`http://localhost:${PORT}`);
  await wait(1000);

  // Casts: tracked heroes, an untracked hero, a random player.
  const seq = [
    ['Lueur Ocre', 'Épée céleste'], ['Lueur Pourpre', 'Saignée mortelle'],
    ['Lueur Grenat', 'Mot soignant'], ['Lueur Acérée', 'Flèche tempête'],
    ['Lueur Etherique', 'Résonance'], ['Kralamoure Pas-Content', 'Tentacule'],
    ['Lueur Ocre', 'Fulgur'], ['Lueur Pourpre', 'Mise à mort'],
  ];
  for (const [who, spell] of seq) { cast(who, spell); await wait(800); }
  await wait(1200);

  await shot(win, 'app-1-heros.png', "location.hash = '#heros'");
  await shot(win, 'app-2-affichage.png', "location.hash = '#affichage'");
  await shot(win, 'app-3-obs.png', "location.hash = '#obs'");
  await shot(win, 'app-4-obs-fichier.png',
    "document.querySelector('#obs-method [data-value=file]').click()");

  const ov = await overlayWin.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, 'overlay-rendu.png'), ov.toPNG());
  console.log('[capture] wrote overlay-rendu.png', ov.getSize());

  // Assistant: step 1 filled in, then step 2.
  await shot(win, 'app-0-assistant-1.png', `
    document.querySelector('#obs-method [data-value=url]').click();
    document.getElementById('rerun-wizard').click();
    const n = document.getElementById('wz-name'); n.value = 'Lueur Ocre'; n.dispatchEvent(new Event('input'));
    [...document.querySelectorAll('#wz-classes [role=radio], #wz-classes button')].find((b) => /iop/i.test(b.textContent + (b.dataset.value||'') + (b.getAttribute('aria-label')||'')))?.click();
  `);
  await shot(win, 'app-0-assistant-2.png', "document.getElementById('wz-next').click()");

  app.isQuitting = true;
  app.exit(0);
});
