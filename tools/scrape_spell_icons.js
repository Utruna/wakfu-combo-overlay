/**
 * scrape_spell_icons.js
 *
 * Builds a spell-name -> icon lookup table for the combo overlay, by reading
 * the official Wakfu encyclopedia class pages (public content — the site
 * only redirects once through Ankama's SSO to hand out a session cookie,
 * no login required) and downloading each spell's icon from Ankama's static
 * asset CDN, reusing the same assets/icons/<class>/<id>.png convention
 * already used by profiles/*.json.
 *
 * Deliberately slow/sequential (a delay between every single HTTP request,
 * page or icon) — this is a one-off personal-use fetch, not a crawler, and
 * there is no reason to hit Ankama's servers any faster than a person
 * clicking through the site by hand would.
 *
 * Usage: node tools/scrape_spell_icons.js
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const OUTPUT_PATH = path.join(ROOT_DIR, 'data', 'spellIcons.json');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// All 18 classes — heroes can now be added freely from the settings UI
// (any class), not just the 4 originally hardcoded in heroes.json.
const CLASSES = [
  { slug: '1-feca', class: 'feca' },
  { slug: '2-osamodas', class: 'osamodas' },
  { slug: '3-enutrof', class: 'enutrof' },
  { slug: '4-sram', class: 'sram' },
  { slug: '5-xelor', class: 'xelor' },
  { slug: '6-ecaflip', class: 'ecaflip' },
  { slug: '7-eniripsa', class: 'eniripsa' },
  { slug: '8-iop', class: 'iop' },
  { slug: '9-cra', class: 'cra' },
  { slug: '10-sadida', class: 'sadida' },
  { slug: '11-sacrieur', class: 'sacrieur' },
  { slug: '12-pandawa', class: 'pandawa' },
  { slug: '13-roublard', class: 'roublard' },
  { slug: '14-zobal', class: 'zobal' },
  { slug: '15-ouginak', class: 'ouginak' },
  { slug: '16-steamer', class: 'steamer' },
  { slug: '18-eliotrope', class: 'eliotrope' },
  { slug: '19-huppermage', class: 'huppermage' },
];

const PAGE_DELAY_MS = 3000;
const ICON_DELAY_MS = 2000;

const SPELL_IMG_PATTERN =
  /<img src="https:\/\/static\.ankama\.com\/wakfu\/portal\/game\/spell\/(\d+)\.png" alt="([^"]*)"/g;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const NAMED_ENTITIES = {
  amp: '&', quot: '"', apos: "'", lt: '<', gt: '>',
  eacute: 'é', egrave: 'è', ecirc: 'ê', euml: 'ë',
  agrave: 'à', acirc: 'â', auml: 'ä',
  ccedil: 'ç',
  ocirc: 'ô', ouml: 'ö', ograve: 'ò',
  ucirc: 'û', ugrave: 'ù', uuml: 'ü',
  icirc: 'î', iuml: 'ï', igrave: 'ì',
  oelig: 'œ',
  Eacute: 'É', Egrave: 'È', Ecirc: 'Ê', Euml: 'Ë',
  Agrave: 'À', Acirc: 'Â', Auml: 'Ä',
  Ccedil: 'Ç',
  Ocirc: 'Ô', Ouml: 'Ö', Ograve: 'Ò',
  Ucirc: 'Û', Ugrave: 'Ù', Uuml: 'Ü',
  Icirc: 'Î', Iuml: 'Ï', Igrave: 'Ì',
  OElig: 'Œ',
};

function decodeHtmlEntities(text) {
  return text
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&([A-Za-z]+);/g, (full, name) => (name in NAMED_ENTITIES ? NAMED_ENTITIES[name] : full));
}

function parseSetCookies(res, jar) {
  const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const entry of raw) {
    const [pair] = entry.split(';');
    const idx = pair.indexOf('=');
    if (idx === -1) continue;
    const name = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    jar.set(name, value);
  }
}

function cookieHeader(jar) {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

/** Manual redirect-follow with a cookie jar — Node's fetch has no cookie jar of its own. */
async function fetchWithCookies(url, jar, { maxHops = 6 } = {}) {
  let currentUrl = url;
  for (let hop = 0; hop < maxHops; hop++) {
    const res = await fetch(currentUrl, {
      redirect: 'manual',
      headers: {
        'User-Agent': USER_AGENT,
        'Accept-Language': 'fr-FR,fr;q=0.9',
        Cookie: cookieHeader(jar),
      },
    });
    parseSetCookies(res, jar);

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) return res;
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }
    return res;
  }
  throw new Error(`Too many redirects fetching ${url}`);
}

async function scrapeClass(entry, jar) {
  const url = `https://www.wakfu.com/fr/mmorpg/encyclopedie/classes/${entry.slug}`;
  console.log(`[scrape] ${entry.class}: ${url}`);

  const res = await fetchWithCookies(url, jar);
  if (!res.ok) {
    console.warn(`[scrape] ${entry.class}: HTTP ${res.status}, skipping.`);
    return [];
  }

  const html = await res.text();
  const spells = [];
  const seen = new Set();
  for (const match of html.matchAll(SPELL_IMG_PATTERN)) {
    const iconId = match[1];
    const name = decodeHtmlEntities(match[2]).trim();
    if (!name || seen.has(iconId)) continue;
    seen.add(iconId);
    spells.push({ name, iconId, class: entry.class });
  }
  console.log(`[scrape] ${entry.class}: ${spells.length} sort(s) trouvé(s).`);
  return spells;
}

/** @returns {boolean} true if an actual network request was made (caller uses this to decide whether to sleep). */
async function downloadIcon(spell) {
  const destDir = path.join(ROOT_DIR, 'assets', 'icons', spell.class);
  const destPath = path.join(destDir, `${spell.iconId}.png`);

  if (fs.existsSync(destPath)) {
    console.log(`[icon] ${spell.class}/${spell.iconId}.png déjà présent — skip.`);
    return false;
  }

  const url = `https://static.ankama.com/wakfu/portal/game/spell/${spell.iconId}.png`;
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) {
    console.warn(`[icon] ${spell.name}: HTTP ${res.status} pour ${url}`);
    return true;
  }

  fs.mkdirSync(destDir, { recursive: true });
  const buffer = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(destPath, buffer);
  console.log(`[icon] ${spell.name} -> ${spell.class}/${spell.iconId}.png`);
  return true;
}

async function main() {
  const jar = new Map();
  const allSpells = [];

  for (const entry of CLASSES) {
    const spells = await scrapeClass(entry, jar);
    allSpells.push(...spells);
    await sleep(PAGE_DELAY_MS);
  }

  console.log(`\n[scrape] ${allSpells.length} sort(s) au total. Téléchargement des icônes (doux, ~${ICON_DELAY_MS}ms entre chaque)...\n`);

  for (const spell of allSpells) {
    const didNetworkRequest = await downloadIcon(spell);
    if (didNetworkRequest) await sleep(ICON_DELAY_MS);
  }

  const lookup = {};
  for (const spell of allSpells) {
    lookup[spell.name] = {
      class: spell.class,
      iconId: spell.iconId,
      icon: `assets/icons/${spell.class}/${spell.iconId}.png`,
    };
  }

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(lookup, null, 2));
  console.log(`\n[scrape] Terminé. Table écrite dans ${OUTPUT_PATH} (${Object.keys(lookup).length} entrées).`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[scrape] Erreur:', err);
    process.exitCode = 1;
  });
}
