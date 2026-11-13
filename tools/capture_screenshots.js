/**
 * tools/capture_screenshots.js
 * Regenerates the README screenshots (doc/app-*.png, doc/overlay-rendu.png):
 * settings, fight recap, release notes and in-game window.
 *
 * The overlay is the real app's, running on an isolated demo profile (fake
 * heroes, fake wakfu.log, port 3499 — see demo_app.js). The settings page is
 * rendered by Electron with its Tauri commands stood in for by
 * demo_settings_preload.js, fed the same demo profile.
 *
 * Usage: npx --yes electron@44 tools/capture_screenshots.js
 * (release build first; from a VS Code terminal, unset ELECTRON_RUN_AS_NODE;
 * if captures keep failing with UnknownVizError, add --disable-gpu)
 */

'use strict';

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');
const { REPO, hero, wait, createDemoProfile, startDemoApp } = require('./demo_app');

const OUT = path.join(REPO, 'doc');
const PORT = 3499;

const heroes = [
  hero('Lueur Ocre', 'iop', 74, 144, 226),
  hero('Lueur Pourpre', 'sram', 220, 50, 50),
  hero('Lueur Grenat', 'eniripsa', 76, 175, 80),
  hero('Lueur Acérée', 'cra', 255, 167, 38),
  hero('Lueur Etherique', 'huppermage', 171, 71, 188),
];
const tracked = heroes.slice(0, 4).map((h) => h.characterName);
const profile = createDemoProfile({
  name: 'taktik-capture',
  port: PORT,
  heroes,
  tracked,
  comboLayout: {
    orientation: 'horizontal', direction: 'left-to-right', iconSize: 48,
    castLifetimeMs: 60000, maxVisibleCasts: 8, previewEnabled: false, classIconSide: 'left',
    damageCounterEnabled: true,
  },
});
const LOG_FILE = profile.logFile;

function stamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())},${p(d.getMilliseconds(), 3)}`;
}
const combat = (message) => fs.appendFileSync(LOG_FILE,
  `INFO ${stamp()} [AWT-EventQueue-0] (eQo:174) - [Information (combat)] ${message}
`);
const cast = (who, spell) => combat(`${who} lance le sort ${spell}`);

async function shot(win, name, js) {
  if (js) await win.webContents.executeJavaScript(js);
  await wait(800);
  // Chromium sometimes refuses a capture (UnknownVizError): try again.
  let img;
  for (let attempt = 1; !img; attempt += 1) {
    try {
      img = await win.webContents.capturePage();
    } catch (err) {
      if (attempt === 5) throw err;
      win.show();
      await wait(1000);
    }
  }
  fs.writeFileSync(path.join(OUT, name), img.toPNG());
  console.log('[capture] wrote', name, img.getSize());
}

/** What the app's activity panel would show for a cast (see handle_cast in app_state.rs). */
function debugEntry(who, spell) {
  const h = heroes.find((x) => x.characterName === who);
  const status = !h ? 'ignored-unmatched' : tracked.includes(who) ? 'broadcast' : 'ignored-untracked';
  return {
    status, characterName: who, heroName: h?.name, heroClass: h?.class,
    spellName: spell, iconMissing: false, timestamp: Date.now(),
  };
}

app.whenReady().then(async () => {
  const demoApp = await startDemoApp(profile);

  process.env.DEMO_SETTINGS_FILE = path.join(profile.dataDir, 'settings.json');
  const win = new BrowserWindow({
    width: 980, height: 680, useContentSize: true, backgroundColor: '#131a1e', autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'demo_settings_preload.js'),
      contextIsolation: false, sandbox: false, nodeIntegration: false,
    },
  });
  await win.loadFile(path.join(REPO, 'ui', 'settings', 'index.html'));
  await wait(1500);

  // Overlay "OBS" client, so the diagnostics show a connected source.
  const overlayWin = new BrowserWindow({
    // Overlay size for 8 casts at 48 px with the counters (see overlaySize() in settings.js).
    width: 854, height: 130, useContentSize: true, show: false, backgroundColor: '#1b1f24',
    webPreferences: { offscreen: false },
  });
  await overlayWin.loadURL(`http://localhost:${PORT}`);
  await wait(1000);

  // Casts (and what they hit, then any other line): tracked heroes, an
  // untracked hero, a random player. The last hero also heals (lifesteal)
  // and gains armour, for the heal and armour counters.
  const seq = [
    ['Lueur Ocre', 'Épée céleste', '2 431'], ['Lueur Pourpre', 'Saignée mortelle', '1 962'],
    ['Lueur Grenat', 'Mot soignant'], ['Lueur Acérée', 'Flèche tempête', '2 604'],
    ['Lueur Etherique', 'Résonance', '3 377'], ['Kralamoure Pas-Content', 'Tentacule'],
    ['Lueur Ocre', 'Fulgur', '3 108'],
    ['Lueur Pourpre', 'Mise à mort', '6 715', ['Lueur Pourpre: +4 210 PV (Neutre - Vol de vie)', 'Lueur Pourpre: 2 150 Armure']],
  ];
  for (const [who, spell, damage, then = []] of seq) {
    cast(who, spell);
    win.webContents.send('demo:debug', debugEntry(who, spell));
    await wait(300);
    if (damage) combat(`Sac à patates: -${damage} PV  (Feu)`);
    for (const line of then) combat(line);
    await wait(500);
  }
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
  await shot(win, 'app-0-assistant-2.png', `
    document.getElementById('wz-next').click();
    setTimeout(() => document.querySelector('#wz-modes [data-mode=hud]').click(), 300);
  `);
  await shot(win, 'app-0-assistant-3.png', "document.getElementById('wz-next').click()");

  // The other windows, with the same stand-in commands (demo fights, release notes).
  const page = async (file, width, height) => {
    const w = new BrowserWindow({
      width, height, useContentSize: true, backgroundColor: '#131a1e', autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, 'demo_settings_preload.js'),
        contextIsolation: false, sandbox: false, nodeIntegration: false,
      },
    });
    await w.loadFile(path.join(REPO, 'ui', file));
    await wait(1200);
    return w;
  };
  // Opens a hero's row in the recap, then hovers its best turn's `n`th spell.
  const openHero = (name, n) => `
    [...document.querySelectorAll('.rc-row-btn')].find((b) => b.getAttribute('aria-label').startsWith('${name} :')).click();
    document.querySelectorAll('.rc-detail .rc-spells button')[${n}]?.dispatchEvent(new MouseEvent('mouseenter'));
  `;
  const recapWin = await page(path.join('recap', 'index.html'), 1200, 1180);
  await shot(recapWin, 'app-5-recap.png', openHero('Lueur Pourpre', 1));
  // One foe only, and a turn pinned on the curve (the fight's 5th, mid-way along it).
  await recapWin.webContents.executeJavaScript(`
    const pick = document.querySelector('.rc-target');
    pick.value = pick.options[1].value;
    pick.dispatchEvent(new Event('change'));
  `);
  await wait(400);
  await shot(recapWin, 'app-5b-recap-cible.png', `
    const box = document.querySelector('.rc-curve-svg').getBoundingClientRect();
    document.querySelector('.rc-curve-plot').dispatchEvent(new MouseEvent('click', { clientX: box.left + box.width * 0.5, clientY: box.top + 40, bubbles: true }));
  `);
  await recapWin.webContents.executeJavaScript(`
    const all = document.querySelector('.rc-target');
    all.value = '';
    all.dispatchEvent(new Event('change'));
  `);
  await wait(400);
  await shot(recapWin, 'app-6-recap-soins.png', `
    [...document.querySelectorAll('[role=tab]')].find((b) => b.textContent.includes('Soins')).click();
    ${openHero('Lueur Grenat', 0)}
  `);
  await shot(recapWin, 'app-6b-recap-armure.png', `
    document.querySelector('.rc-row.open .rc-row-btn')?.click();
    [...document.querySelectorAll('[role=tab]')].find((b) => b.textContent.includes('Armure')).click();
    ${openHero('Lueur Ocre', -1)} // no hover: the first spell that gave some armour
  `);
  await shot(await page(path.join('whatsnew', 'index.html'), 560, 600), 'app-7-nouveautes.png');

  // The in-game window: the overlay page as the app shows it (`?ingame`),
  // sized like the app sizes it, over a stand-in for the game.
  const hudWin = new BrowserWindow({ width: 600, height: 300, useContentSize: true, show: false });
  await hudWin.loadURL(`http://localhost:${PORT}/?ingame`);
  await wait(1500);
  const room = await hudWin.webContents.executeJavaScript('hudRoom()');
  hudWin.setContentSize(room.width + 120, room.height);
  await shot(hudWin, 'app-8-tete-haute.png', `
    document.documentElement.style.background = 'radial-gradient(90% 120% at 30% 80%, #1d2a22, #0e1412 75%)';
  `);

  demoApp.kill();
  app.exit(0);
});
