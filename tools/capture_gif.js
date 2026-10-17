/**
 * tools/capture_gif.js
 * Records doc/overlay-demo.gif: the real overlay replaying a scripted fight
 * (casts, damage counter, an Osamodas summon), written to a fake wakfu.log in
 * the same format as the game's. Isolated demo profile on port 3498, so a
 * running instance isn't disturbed.
 *
 * Usage: npx electron tools/capture_gif.js [horizontal|vertical]
 * (from a VS Code terminal, unset ELECTRON_RUN_AS_NODE first)
 */

'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, BrowserWindow } = require('electron');
const { GIFEncoder, quantize, applyPalette } = require('gifenc');

const REPO = path.resolve(__dirname, '..');
const ORIENTATION = process.argv.includes('vertical') ? 'vertical' : 'horizontal';
const OUT = path.join(REPO, 'doc', ORIENTATION === 'vertical' ? 'overlay-demo-vertical.gif' : 'overlay-demo.gif');
const WORK = path.join(os.tmpdir(), 'wakfu-combo-overlay-gif');
const USER_DATA = path.join(WORK, 'userData');
const LOGS = path.join(WORK, 'logs');
const LOG_FILE = path.join(LOGS, 'wakfu.log');
const PORT = 3498;
const ICON_SIZE = 48;
const FPS = 15;
const BACKGROUND = '#1b1f24';
// Overlay size for 8 casts at 48 px with the damage counter (see overlaySize() in settings.js).
const SIZE = ORIENTATION === 'vertical' ? { width: 188, height: 643 } : { width: 766, height: 130 };

fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(USER_DATA, { recursive: true });
fs.mkdirSync(LOGS, { recursive: true });
fs.writeFileSync(LOG_FILE, '');

const hero = (n, cls, r, g, b) => ({ name: n, characterName: n, class: cls, color: { r, g, b } });
const heroes = [
  hero('Lueur Ocre', 'iop', 74, 144, 226),
  hero('Lueur Pourpre', 'sram', 220, 50, 50),
  hero('Lueur Émeraude', 'osamodas', 76, 175, 80),
  hero('Lueur Acérée', 'cra', 255, 167, 38),
];
fs.writeFileSync(path.join(USER_DATA, 'settings.json'), JSON.stringify({
  heroes,
  trackedCharacterNames: heroes.map((h) => h.characterName),
  comboLayout: {
    orientation: ORIENTATION, direction: ORIENTATION === 'vertical' ? 'top-to-bottom' : 'left-to-right',
    iconSize: ICON_SIZE, castLifetimeMs: 9000, maxVisibleCasts: 8, previewEnabled: false,
    // Like the "gauche → droite" layout preset: icon and counter where new casts arrive.
    classIconSide: 'right', damageCounterEnabled: true,
  },
  overlayPort: PORT,
  logsDir: LOGS,
  onboardingDone: true,
}, null, 2));

app.setPath('userData', USER_DATA);
// main.js calls app.setName, which must not move userData away from the demo profile.
const realSetName = app.setName.bind(app);
app.setName = (n) => { realSetName(n); app.setPath('userData', USER_DATA); };
require(path.join(REPO, 'electron', 'main.js'));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const FIGHT_ID = '1552999001';

function stamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())},${p(d.getMilliseconds(), 3)}`;
}
const write = (line) => fs.appendFileSync(LOG_FILE, `${line}\n`);
const combat = (message) => write(` INFO ${stamp()} [AWT-EventQueue-0] (aOb:174) - [Information (combat)] ${message}`);
const join = (name, breed, ai) => write(` INFO ${stamp()} [AWT-EventQueue-0] (fcd:1399) - [_FL_] fightId=${FIGHT_ID} `
  + `${name} breed : ${breed} [-1706442040160133] isControlledByAI=${ai} obstacleId : -1 join the fight at {Point3 : (0, -14, 0)}`);

// [delay before the line in ms, writer]
const cast = (who, spell) => () => combat(`${who} lance le sort ${spell}`);
const hit = (pv, element) => () => combat(`Sac à patates: -${pv} PV  (${element})`);
const turnEnd = (s) => () => combat(`${s} secondes reportées pour le tour suivant.`);
const SCRIPT = [
  [0, () => join('Sac à patates', 2335, true)],
  [0, () => join('Lueur Ocre', 8, false)],
  [0, () => join('Lueur Pourpre', 4, false)],
  [0, () => join('Lueur Émeraude', 2, false)],
  [0, () => join('Lueur Acérée', 9, false)],
  [600, cast('Lueur Ocre', 'Épée céleste')], [450, hit('2 431', 'Feu')],
  [700, cast('Lueur Ocre', 'Fulgur')], [450, hit('3 108', 'Feu')],
  [700, cast('Lueur Ocre', 'Super Iop Punch')], [450, hit('5 874', 'Terre')],
  [900, turnEnd(21)],
  [400, cast('Lueur Pourpre', 'Saignée mortelle')], [450, hit('1 962', 'Eau')],
  [700, cast('Lueur Pourpre', 'Attaque perfide (Critiques)')], [450, hit('4 320', 'Eau')],
  [700, cast('Lueur Pourpre', 'Mise à mort')], [450, hit('6 715', 'Air')],
  [900, turnEnd(18)],
  [400, cast('Lueur Émeraude', 'Invocation')],
  [300, () => combat('Lueur Émeraude: Invoque une créature du Gobgob')],
  [0, () => join('Dragoeuf Guerrier', 4210, true)],
  [700, cast('Lueur Émeraude', 'Fouet')], [450, hit('1 845', 'Feu')],
  [700, turnEnd(25)],
  [400, cast('Dragoeuf Guerrier', 'Griffure')], [450, hit('2 290', 'Feu')],
  [900, cast('Lueur Acérée', 'Flèche tempête')], [450, hit('2 604', 'Air')],
  [700, cast('Lueur Acérée', 'Flèche explosive')], [450, hit('3 377', 'Feu')],
  [700, cast('Lueur Acérée', 'Pluie de flèches')], [450, hit('4 912', 'Terre')],
  [2200, turnEnd(14)],
];

/** NativeImage → RGBA pixels (Windows bitmaps are BGRA). */
function rgba(image) {
  const px = Buffer.from(image.toBitmap());
  for (let i = 0; i < px.length; i += 4) { const b = px[i]; px[i] = px[i + 2]; px[i + 2] = b; }
  return px;
}

app.whenReady().then(async () => {
  while (!BrowserWindow.getAllWindows()[0]) await wait(100);
  await wait(1500);

  const overlayWin = new BrowserWindow({
    ...SIZE, useContentSize: true, show: false, backgroundColor: BACKGROUND,
    webPreferences: { offscreen: true },
  });
  overlayWin.webContents.setFrameRate(30);
  let latest = null;
  overlayWin.webContents.on('paint', (_e, _dirty, image) => { latest = image; });
  await overlayWin.loadURL(`http://localhost:${PORT}`);
  await wait(1000);

  const frames = [];
  const timer = setInterval(() => { if (latest) frames.push(latest); }, 1000 / FPS);
  for (const [delay, run] of SCRIPT) { await wait(delay); run(); }
  clearInterval(timer);

  if (process.env.GIF_FRAMES_DIR) {
    frames.forEach((f, i) => { if (i % 20 === 0) fs.writeFileSync(path.join(process.env.GIF_FRAMES_DIR, `f${i}.png`), f.toPNG()); });
  }
  const { width, height } = frames[0].getSize();
  const pixels = frames.map(rgba);
  // One palette for the whole clip, so colours don't shimmer between frames.
  const sample = Buffer.concat(pixels.filter((_, i) => i % 6 === 0));
  const palette = quantize(sample, 256);
  const gif = GIFEncoder();
  for (const px of pixels) {
    gif.writeFrame(applyPalette(px, palette), width, height, { palette, delay: 1000 / FPS });
  }
  gif.finish();
  fs.writeFileSync(OUT, gif.bytes());
  console.log(`[gif] wrote ${path.relative(REPO, OUT)} — ${frames.length} frames, ${width}×${height}, `
    + `${Math.round(gif.bytes().length / 1024)} KB`);

  app.isQuitting = true;
  app.exit(0);
});
