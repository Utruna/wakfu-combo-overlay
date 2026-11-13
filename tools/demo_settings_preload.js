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

/**
 * Demo fights for ui/recap, in the shape get_recap returns
 * (src-tauri/src/fight_recap.rs): an Ogrest fight, then a training dummy.
 * Seeded, so every capture shows the same numbers.
 */
function demoFights() {
  let seed = 7;
  const rand = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const between = (lo, hi) => Math.round(lo + rand() * (hi - lo));
  const ELEMENTS = { iop: ['Feu', 'Terre'], sram: ['Air', 'Eau'], cra: ['Feu', 'Air'], eniripsa: ['Eau'] };
  const tracked = settings.heroes.filter((h) => settings.trackedCharacterNames.includes(h.characterName));
  const allies = tracked.map((h) => h.characterName);

  function fighter(h, foes, rounds, power) {
    const spells = Object.entries(spellIcons[h.class] || {}).slice(0, 9);
    const healer = h.class === 'eniripsa';
    const turns = [];
    for (let t = 0; t < rounds; t++) {
      const turn = { turnId: t + 1, spells: [], others: [], healOthers: [], shieldOthers: [] };
      for (let i = between(2, 5); i > 0; i--) {
        const [name, entry] = pick(spells);
        const crit = rand() < 0.3;
        const spell = { name, crit, summon: false, icon: entry.icon, hits: [], heals: [], shields: [] };
        if (healer && rand() < 0.65) {
          for (const target of allies.filter(() => rand() < 0.6)) {
            spell.heals.push({ amount: between(1800, 9000) * (crit ? 1.5 : 1), element: 'Eau', target });
          }
        } else {
          for (let n = pick([1, 1, 2, 3]); n > 0; n--) {
            spell.hits.push({ amount: Math.round(between(6000, 30000) * power * (crit ? 1.5 : 1)), element: pick(ELEMENTS[h.class] || ['Neutre']), target: pick(foes) });
          }
        }
        // An Iop's spells sometimes shield the group.
        if (h.class === 'iop' && rand() < 0.3) {
          for (const target of allies) spell.shields.push({ amount: between(3000, 12000), element: null, target });
        }
        turn.spells.push(spell);
      }
      if (h.class === 'sram' && rand() < 0.5) turn.others.push({ label: 'Hémorragie', amount: between(4000, 12000) });
      if (healer && rand() < 0.6) turn.healOthers.push({ label: 'Radiance', amount: between(2000, 6000) });
      turns.push(turn);
    }
    return {
      name: h.characterName, hero: true, class: h.class, classIcon: classIcons[h.class], color: h.color, turns,
      healOutside: h.class === 'sram' ? [{ label: 'Vol de vie', amount: between(3000, 9000) }] : [],
      shieldOutside: [],
      taken: between(30000, 160000),
    };
  }

  const today = new Date().setHours(0, 0, 0, 0);
  const at = (h, m) => (h * 60 + m) * 60000;
  const fight = (id, foes, rounds, power, start, end, isNew) => ({
    id, live: false, victory: true, isNew, foes,
    startedAt: today + start, endedAt: today + end, startedClock: start, endedClock: end,
    fighters: tracked.map((h) => fighter(h, foes, rounds, power)),
  });
  const ogrest = fight(2, ['Ogrest', "Pousse d'Ogrest", "Larme d'Ogrest"], 9, 1, at(21, 4), at(21, 16) + 12000, true);
  // Someone else in the group, for the "Autres joueurs du groupe" switch.
  const other = fighter({ characterName: 'Pépin-Lumière', class: 'cra' }, ogrest.foes, 9, 0.8);
  ogrest.fighters.push({ ...other, hero: false, class: null, classIcon: null, color: null });
  return [ogrest, fight(1, ['Sac à patates'], 2, 0.4, at(20, 48), at(20, 51) + 5000, false)];
}

/** The latest section of CHANGELOG.md, for ui/whatsnew. */
function releaseNotes() {
  const changelog = fs.readFileSync(path.join(REPO, 'CHANGELOG.md'), 'utf8').replace(/\r/g, '');
  const [heading, ...body] = changelog.split(/^## v/m)[1].split('\n');
  const version = heading.trim();
  return { version, notes: [{ version, markdown: body.join('\n').trim() }] };
}

// Shown as the real defaults would be, not the demo profile's temp paths.
const SHOWN_LOGS_DIR = 'C:\\Users\\toi\\AppData\\Roaming\\zaap\\gamesLogs\\wakfu\\logs';
const SHOWN_LOADER = 'C:\\Users\\toi\\AppData\\Roaming\\Taktik\\overlay-obs.html';

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
  get_ingame_overlay: () => ({ enabled: true, onlyOverWakfu: true, online: true }),
  set_ingame_overlay: ({ enabled }) => ({ enabled, onlyOverWakfu: true, online: true }),
  has_unseen_fights: () => true,
  get_recap: () => ({ fights: demoFights() }),
  mark_fight_seen: () => {},
  delete_fight: () => true,
  save_fight: () => {},
  delete_saved_fight: () => true,
  get_release_notes: () => releaseNotes(),
};

const listeners = new Map();
ipcRenderer.on('demo:debug', (_e, entry) => {
  for (const callback of listeners.get('debug:event') ?? []) callback({ payload: entry });
});

window.__TAURI__ = {
  core: {
    invoke: async (command, args = {}) => (handlers[command] ? handlers[command](args) : null),
  },
  // ui/whatsnew closes its own window.
  window: { getCurrentWindow: () => ({ close: () => {} }) },
  event: {
    listen: async (eventName, callback) => {
      if (!listeners.has(eventName)) listeners.set(eventName, new Set());
      listeners.get(eventName).add(callback);
      return () => listeners.get(eventName).delete(callback);
    },
  },
};
