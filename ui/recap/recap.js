'use strict';

// The "Récap des combats" window. The app sends each fight's raw record
// (src-tauri/src/fight_recap.rs: turns, spells, hits); everything shown is
// worked out here.

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const CLASS_LABELS = new Map([
  ['feca', 'Féca'], ['osamodas', 'Osamodas'], ['enutrof', 'Enutrof'], ['sram', 'Sram'],
  ['xelor', 'Xélor'], ['ecaflip', 'Ecaflip'], ['eniripsa', 'Eniripsa'], ['iop', 'Iop'],
  ['cra', 'Cra'], ['sadida', 'Sadida'], ['sacrieur', 'Sacrieur'], ['pandawa', 'Pandawa'],
  ['roublard', 'Roublard'], ['zobal', 'Zobal'], ['ouginak', 'Ouginak'], ['steamer', 'Steamer'],
  ['eliotrope', 'Eliotrope'], ['huppermage', 'Huppermage'],
]);
const ELEMENT_COLORS = {
  Feu: '#f97316', Eau: '#38bdf8', Terre: '#b08850', Air: '#a3e635', Neutre: '#9ca3af', Lumière: '#fde68a', Stasis: '#a78bfa',
};
const TABS = [
  { key: 'dmg', label: 'Dégâts', dot: '#e8eef0' },
  { key: 'heal', label: 'Soins', dot: '#ff5c8a' },
  { key: 'armor', label: 'Armure', dot: '#34d27b' },
  { key: 'taken', label: 'Subis', dot: '#8fa1a9' },
];
const OTHER_PLAYER_COLOR = '#6f8089';
// The settings page's hero palette (ui/settings/settings.js PALETTE).
const UNTRACKED_PALETTE = ['#4a90e2', '#43d1c1', '#22c55e', '#facc15', '#f2994a', '#e53935', '#d946ef', '#9b8cff']
  .map((hex) => ({ r: parseInt(hex.slice(1, 3), 16), g: parseInt(hex.slice(3, 5), 16), b: parseInt(hex.slice(5, 7), 16) }));
const REFRESH_MS = 1000;
/** How long the bin waits for its second click. */
const DELETE_ARMED_MS = 4000;

const state = {
  fights: [],
  fightId: null,
  tab: 'dmg',
  open: null, // name of the expanded row
  hover: 0, // spell of its best turn under the mouse
  search: '', // monster searched for in the fight list
  target: null, // foe whose damage alone is shown (null: all of them)
  turn: null, // turn picked with the curve's slider (null: each player's best)
  armed: null, // fight whose bin waits for its second click
  saveError: null,
};

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Builds an element: h('span', { class: 'x', text: 'y' }, child…). */
function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'text') node.textContent = value;
    else if (key === 'style') {
      for (const [prop, v] of Object.entries(value)) {
        // Custom properties ("--spell-tint") only go through setProperty.
        if (prop.startsWith('--')) node.style.setProperty(prop, v);
        else node.style[prop] = v;
      }
    }
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child !== null && child !== undefined && child !== false) node.append(child);
  }
  return node;
}

const fmt = (n) => Math.round(n).toLocaleString('fr-FR');
const pct = (x) => `${Math.round(x)} %`;
const sum = (list, f = (x) => x) => list.reduce((a, x) => a + f(x), 0);
const time = (ms) => new Date(ms).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
/** The time, with the day when it isn't today ("12/10 21:04"). */
function when(ms) {
  const today = new Date().toDateString() === new Date(ms).toDateString();
  return today ? time(ms) : `${new Date(ms).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' })} ${time(ms)}`;
}
const rgb = (color) => (color ? `rgb(${color.r}, ${color.g}, ${color.b})` : OTHER_PLAYER_COLOR);
const rgba = (color, alpha) => (color ? `rgba(${color.r}, ${color.g}, ${color.b}, ${alpha})` : `rgba(111, 128, 137, ${alpha})`);

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * When the fight started and ended (or its latest line, while it goes on).
 * From the log's own stamps when there are some (ms since midnight): they're
 * the fight's real times even if the log was read late.
 */
function fightTimes(fight) {
  if (fight.startedClock == null) {
    return { start: fight.startedAt, end: fight.endedAt ?? Date.now() };
  }
  // A fight saved on an earlier day: counted from that day.
  const now = fight.savedAt ?? Date.now();
  const midnight = new Date(now).setHours(0, 0, 0, 0);
  let start = midnight + fight.startedClock;
  if (start > now + 60000) start -= DAY_MS; // started the day before
  const endClock = fight.endedClock ?? fight.startedClock;
  return { start, end: start + ((endClock - fight.startedClock + DAY_MS) % DAY_MS) };
}

function duration(ms, short = false) {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  if (short) return m ? `${Math.round(s / 60)} min` : `${s} s`;
  return m ? `${m} min ${String(s % 60).padStart(2, '0')} s` : `${s} s`;
}

const CROWN = () => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', '20');
  svg.setAttribute('height', '20');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'currentColor');
  svg.setAttribute('aria-label', 'Premier');
  svg.innerHTML = '<path d="M3 8l4.5 3.5L12 5l4.5 6.5L21 8l-2 11H5z"></path>';
  return svg;
};
const TRASH = () => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', '14');
  svg.setAttribute('height', '14');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = '<path d="M4 7h16"></path><path d="M10 11v6M14 11v6"></path><path d="M6 7l1 13h10l1-13"></path><path d="M9 7V4h6v3"></path>';
  return svg;
};
const icon = (paths, size = 14) => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = paths;
  return svg;
};
const SAVE = () => icon('<path d="M5 3h11l3 3v15H5z"></path><path d="M8 3v5h7V3"></path><path d="M8 21v-7h8v7"></path>');
const SAVED = () => icon('<path d="M6 3h12v18l-6-4-6 4z"></path>', 12);
const CHEVRON = () => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', '#6f8089');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('class', 'rc-chevron');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = '<path d="m9 6 6 6-6 6"></path>';
  return svg;
};

// ── Stats ────────────────────────────────────────────────────────────────────

// Three measures have spells behind them: damage ('dmg'), heals ('heal') and
// armour given ('armor'). Damage taken doesn't: its tab shows the damage detail.
const MODES = {
  dmg: {
    lines: 'hits', others: 'others', outside: null, units: 'coups', none: 'Aucun dégât',
    best: 'Meilleur tour', bestOfFight: 'Meilleur tour du combat', spells: 'Sorts du combat',
    noTurn: 'Aucun tour joué.', noSpell: 'Aucun dégât.', curve: 'Dégâts',
  },
  heal: {
    lines: 'heals', others: 'healOthers', outside: 'healOutside', units: 'soins', none: 'Aucun soin',
    best: 'Meilleur tour de soins', bestOfFight: 'Meilleur tour de soins', spells: 'Soins du combat',
    noTurn: 'Aucun soin pendant ses tours.', noSpell: 'Aucun soin.', targets: 'Cibles soignées', kind: 'sorts de soin', curve: 'Soins',
  },
  armor: {
    lines: 'shields', others: 'shieldOthers', outside: 'shieldOutside', units: 'armures', none: 'Aucune armure',
    best: 'Meilleur tour d\'armure', bestOfFight: 'Meilleur tour d\'armure', spells: 'Armure du combat',
    noTurn: 'Aucune armure donnée pendant ses tours.', noSpell: 'Aucune armure donnée.', targets: 'Cibles protégées', kind: 'sorts d\'armure', curve: 'Armure',
  },
};

/** A record's list (empty when absent: fights saved by an older version). */
const listOf = (record, key) => (key && record[key]) || [];
const spellTotal = (spell, mode) => sum(listOf(spell, MODES[mode].lines), (line) => line.amount);
const turnTotal = (turn, mode) => sum(turn.spells, (s) => spellTotal(s, mode)) + sum(listOf(turn, MODES[mode].others), (o) => o.amount);

/** Labelled amounts ("Vol de vie", "Marque Husse"…) added up by label. */
function byLabel(lists) {
  const totals = new Map();
  for (const item of lists.flat()) totals.set(item.label, (totals.get(item.label) || 0) + item.amount);
  return [...totals].map(([label, amount]) => ({ label, amount })).sort((a, b) => b.amount - a.amount);
}

/** One measure's detail: turn totals, best turn, spells, what no spell explains. */
function measureOf(fighter, mode) {
  const turns = fighter.turns;
  const totals = turns.map((t) => turnTotal(t, mode));
  const bestIndex = totals.reduce((best, total, i) => (total > totals[best] ? i : best), 0);
  const bySpell = new Map();
  for (const spell of turns.flatMap((t) => t.spells)) {
    const entry = bySpell.get(spell.name) || { name: spell.name, casts: 0, total: 0, crits: 0 };
    entry.casts += 1;
    entry.total += spellTotal(spell, mode);
    entry.crits += spell.crit ? 1 : 0;
    bySpell.set(spell.name, entry);
  }
  // Heals and armour landing outside the giver's turns (lifesteal, marks…) count too.
  const outside = listOf(fighter, MODES[mode].outside);
  const others = byLabel([...turns.map((t) => listOf(t, MODES[mode].others)), outside]);
  const best = turns.length && totals[bestIndex] > 0 ? { turn: turns[bestIndex], number: bestIndex + 1, total: totals[bestIndex] } : null;
  return {
    total: sum(totals) + sum(outside, (o) => o.amount),
    best,
    // Every spell cast for damage, the ones that did none (buffs, summons…)
    // last; only the ones that gave some for heals and armour.
    spellRows: [...bySpell.values()].filter((r) => mode === 'dmg' || r.total > 0)
      .sort((a, b) => b.total - a.total || b.casts - a.casts || a.name.localeCompare(b.name, 'fr')),
    others,
    othersTotal: sum(others, (o) => o.amount),
  };
}

/** Everything the window shows about one fighter, from its raw record. */
function statsOf(fighter) {
  const spells = fighter.turns.flatMap((t) => t.spells);
  const dmg = measureOf(fighter, 'dmg');
  const heal = measureOf(fighter, 'heal');
  const armor = measureOf(fighter, 'armor');

  const shares = (lines, key) => {
    const totals = new Map();
    for (const line of lines) if (line[key]) totals.set(line[key], (totals.get(line[key]) || 0) + line.amount);
    const all = sum([...totals.values()]) || 1;
    return [...totals].sort((a, b) => b[1] - a[1])
      .map(([name, total]) => ({ name, total, share: Math.round((100 * total) / all) }))
      .filter((e) => e.share > 0);
  };

  return {
    measures: { dmg, heal, armor },
    dmg: dmg.total,
    heal: heal.total,
    armor: armor.total,
    taken: fighter.taken,
    turnCount: fighter.turns.length,
    casts: spells.length,
    critShare: spells.length ? (100 * spells.filter((s) => s.crit).length) / spells.length : 0,
    best: dmg.best,
    elements: shares(spells.flatMap((s) => s.hits), 'element').map((e) => ({ ...e, color: ELEMENT_COLORS[e.name] })),
    // Who was healed / given armour.
    targets: {
      heal: shares(spells.flatMap((s) => listOf(s, 'heals')), 'target'),
      armor: shares(spells.flatMap((s) => listOf(s, 'shields')), 'target'),
      // Damage the spells did, per foe (what no spell explains has no target).
      dmg: shares(spells.flatMap((s) => s.hits), 'target'),
    },
  };
}

/** A best turn's tiles: its spells in order, then what no spell explains. */
function tilesOf(turn, mode) {
  const tiles = turn.spells.map((spell) => ({ spell }));
  const others = listOf(turn, MODES[mode].others);
  if (others.length) tiles.push({ others });
  return tiles;
}

function tipOf(tile, mode) {
  const m = MODES[mode];
  if (tile.others) {
    return {
      name: 'Autres (non rattachés à un sort)',
      total: fmt(sum(tile.others, (o) => o.amount)),
      line: tile.others.map((o) => `${o.label} ${fmt(o.amount)}`).join(' · '),
    };
  }
  const { spell } = tile;
  const lines = listOf(spell, m.lines);
  const elements = [...new Set(lines.map((x) => x.element).filter(Boolean))];
  const targets = [...new Set(lines.map((x) => x.target))];
  const parts = [];
  if (lines.length > 1) parts.push(`${lines.length} ${m.units} : ${lines.map((x) => fmt(x.amount)).join(' + ')}`);
  if (mode === 'dmg' && elements.length) parts.push(elements.join(', '));
  if (targets.length) parts.push(targets.join(', '));
  return {
    name: spell.name + (spell.crit ? ' · critique' : '') + (spell.summon ? ' · invocation' : ''),
    total: fmt(spellTotal(spell, mode)),
    line: lines.length ? parts.join(' · ') : m.none,
  };
}

// ── Rendering ────────────────────────────────────────────────────────────────

function spellTile(tile, color, size, extra = {}) {
  const img = tile.spell?.icon
    ? h('img', { class: 'rc-spell-img', src: `../${tile.spell.icon}`, alt: '' })
    : h('span', { class: 'rc-spell-img blank', style: { '--spell-tint': rgba(color, 0.55) } });
  if (size) Object.assign(img.style, { width: `${size}px`, height: `${size}px` });
  return h(extra.tag || 'span', {
    class: `rc-spell${tile.others ? ' others' : ''}${extra.on ? ' on' : ''}`,
    style: tile.others ? undefined : { borderColor: rgb(color) },
    ...extra.attrs,
  }, img, tile.spell?.crit ? h('span', { class: 'rc-crit', 'aria-hidden': 'true' }) : null);
}

/**
 * The fight as if the allies had only ever hit one foe: spells that missed
 * it are dropped, and so is damage no spell explains (it has no target).
 */
function onlyTarget(fight, target) {
  const keep = (spell) => ({ ...spell, hits: listOf(spell, 'hits').filter((hit) => hit.target === target) });
  return {
    ...fight,
    fighters: fight.fighters.map((f) => ({
      ...f,
      turns: f.turns.map((t) => ({ ...t, others: [], spells: t.spells.map(keep).filter((sp) => sp.hits.length) })),
    })),
  };
}

const SVG_NS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs = {}, ...children) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  node.append(...children);
  return node;
}

/**
 * Running total after each of the fighter's turns (their n-th turn is about
 * the n-th round), one line per fighter plus the group's.
 */
function renderCurve(team, mode, label) {
  const series = team.map(({ fighter }) => {
    let total = 0;
    return { name: fighter.name, color: fighter.color, points: fighter.turns.map((t) => (total += turnTotal(t, mode))) };
  });
  const rounds = Math.max(0, ...series.map((sr) => sr.points.length));
  const at = (sr, i) => sr.points[Math.min(i, sr.points.length - 1)] ?? 0;
  const group = { name: 'Équipe', color: null, group: true,
    points: Array.from({ length: rounds }, (_, i) => sum(series, (sr) => at(sr, i))) };
  const lines = series.length > 1 ? [...series, group] : series;
  const top = Math.max(0, ...lines.map((sr) => sr.points.at(-1) ?? 0));
  if (rounds < 2 || !top) return null;

  const W = 640, H = 150, L = 8, R = 8, T = 10, B = 22;
  const x = (i) => L + ((W - L - R) * i) / (rounds - 1);
  const y = (v) => T + (H - T - B) * (1 - v / top);
  const svg = svgEl('svg', { class: 'rc-curve-svg', viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', role: 'img',
    'aria-label': `${label} cumulés par tour` });
  svg.append(svgEl('line', { x1: L, x2: W - R, y1: y(0), y2: y(0), class: 'rc-curve-axis' }));
  const step = Math.max(1, Math.ceil(rounds / 10));
  for (let i = 0; i < rounds; i += step) {
    svg.append(svgEl('text', { x: x(i), y: H - 6, class: 'rc-curve-tick', 'text-anchor': i === 0 ? 'start' : 'middle' }, String(i + 1)));
  }
  for (const sr of lines) {
    const stroke = sr.group ? '#e8eef0' : rgb(sr.color);
    svg.append(svgEl('polyline', {
      points: sr.points.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' '),
      fill: 'none', stroke, 'stroke-width': sr.group ? 2.5 : 1.8, 'stroke-linejoin': 'round', 'stroke-linecap': 'round',
      'stroke-dasharray': sr.group ? '5 4' : 'none', 'vector-effect': 'non-scaling-stroke', opacity: sr.group ? 0.9 : 1,
    }, svgEl('title', {}, `${sr.name} : ${fmt(sr.points.at(-1))}`)));
  }
  // Hover a turn: each line's running total there, and what that turn added.
  const guide = svgEl('line', { y1: T, y2: y(0), class: 'rc-curve-guide', visibility: 'hidden' });
  svg.append(guide);
  const tip = h('div', { class: 'rc-curve-tip', hidden: true });
  const plot = h('div', { class: 'rc-curve-plot' }, svg, tip);
  // Shows each line's running total at turn i (0-based), and what that turn added.
  const showTurn = (i) => {
    guide.setAttribute('x1', x(i));
    guide.setAttribute('x2', x(i));
    guide.setAttribute('visibility', 'visible');
    tip.replaceChildren(
      h('div', { class: 'rc-curve-tip-top', text: `Tour ${i + 1}` }),
      ...[...lines].sort((p, q) => at(q, i) - at(p, i)).map((sr) => {
        const gained = at(sr, i) - (i ? at(sr, i - 1) : 0);
        return h('div', { class: 'rc-curve-tip-row' },
          h('span', { class: 'rc-swatch', style: { background: sr.group ? '#e8eef0' : rgb(sr.color) } }),
          h('span', { class: 'rc-curve-tip-name', text: sr.name }),
          h('span', { class: 'num', text: fmt(at(sr, i)) }),
          h('span', { class: 'rc-curve-tip-gain', text: gained ? `+${fmt(gained)}` : '' }));
      }));
    tip.hidden = false;
    // Beside the guide, flipped to its left in the right half so it stays inside.
    const ratio = x(i) / W;
    const left = ratio * svg.getBoundingClientRect().width;
    tip.style.left = ratio < 0.55 ? `${left + 12}px` : 'auto';
    tip.style.right = ratio < 0.55 ? 'auto' : `${svg.getBoundingClientRect().width - left + 12}px`;
  };
  // The turn picked with the slider stays shown (and drives the players' detail) when the mouse leaves.
  const picked = state.turn && state.turn <= rounds ? state.turn - 1 : null;
  const settle = () => (picked === null ? (tip.hidden = true, guide.setAttribute('visibility', 'hidden')) : showTurn(picked));
  plot.addEventListener('mousemove', (event) => {
    const box = svg.getBoundingClientRect();
    const ratio = (event.clientX - box.left) / box.width;
    showTurn(Math.min(rounds - 1, Math.max(0, Math.round(((ratio * W - L) / (W - L - R)) * (rounds - 1)))));
  });
  plot.addEventListener('mouseleave', settle);
  // A click pins the turn under the mouse (a second click on it lets go).
  plot.addEventListener('click', (event) => {
    const box = svg.getBoundingClientRect();
    const ratio = (event.clientX - box.left) / box.width;
    const turn = Math.min(rounds, Math.max(1, Math.round(((ratio * W - L) / (W - L - R)) * (rounds - 1)) + 1));
    state.turn = state.turn === turn ? null : turn;
    state.hover = 0;
    render();
  });

  // The slider: goes to a turn; its detail shows in the players' rows. "Meilleur tour" lets go.
  const slider = h('input', {
    type: 'range', class: 'rc-curve-slider', min: 1, max: rounds, step: 1, value: picked === null ? rounds : picked + 1,
    'aria-label': 'Aller au tour', 'aria-valuetext': picked === null ? 'meilleur tour' : `tour ${picked + 1}`,
    oninput: () => showTurn(Number(slider.value) - 1),
    onchange: () => {
      state.turn = Number(slider.value);
      state.hover = 0;
      render();
      document.querySelector('.rc-curve-slider')?.focus();
    },
  });
  const reset = picked === null ? null : h('button', {
    type: 'button', class: 'btn sm', text: 'Meilleur tour',
    onclick: () => { state.turn = null; state.hover = 0; render(); },
  });
  settle();
  return h('section', { class: 'rc-curve', 'aria-label': `Courbe : ${label}` },
    h('div', { class: 'rc-sec-head' },
      h('span', { class: 'cap' }, `${label} cumulés `, h('span', { class: 'cap-note', text: '· par tour' })),
      h('span', { class: 'cap-note', text: `${fmt(top)} max` })),
    plot,
    h('div', { class: 'rc-curve-scrub' }, h('span', { class: 'cap-note', text: 'Tour' }), slider, reset),
    h('div', { class: 'rc-legend' }, lines.map((sr) => h('span', {},
      h('span', { class: 'rc-swatch', style: { background: sr.group ? '#e8eef0' : rgb(sr.color) } }),
      `${sr.name} ${fmt(sr.points.at(-1))}`))));
}

/** For searching: no case, no accents ("Bouftou Royal" ~ "bouftou royal"). */
const fold = (text) => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/** The monster of this fight matching the search, if any (the first one when no search). */
function matchingFoe(fight) {
  const query = fold(state.search.trim());
  return query ? fight.foes.find((foe) => fold(foe).includes(query)) : fight.foes[0];
}

/** The fights the list shows: those against the searched monster. */
const visibleFights = () => (state.search.trim() ? state.fights.filter(matchingFoe) : state.fights);

/** A monster's name with the searched part highlighted. */
function highlighted(name) {
  const query = fold(state.search.trim());
  const at = query ? fold(name).indexOf(query) : -1;
  if (at < 0) return [name];
  return [name.slice(0, at), h('mark', { text: name.slice(at, at + query.length) }), name.slice(at + query.length)];
}

function renderSide() {
  const list = document.getElementById('fight-list');
  list.replaceChildren();
  if (!state.fights.length) {
    list.append(h('li', {}, h('p', { class: 'rc-side-empty', text: 'Aucun combat enregistré pour l\'instant.' })));
    return;
  }
  const fights = visibleFights();
  if (!fights.length) {
    list.append(h('li', {}, h('p', { class: 'rc-side-empty', text: `Aucun combat contre « ${state.search.trim()} ».` })));
    return;
  }
  for (const fight of fights) {
    if (typeof fight.id === 'string' && fight === fights.find((f) => typeof f.id === 'string')) {
      list.append(h('li', { class: 'rc-fights-cap' }, h('span', { class: 'cap', text: 'Sauvegardés' })));
    }
    const team = sum(fight.fighters, (f) => statsOf(f).dmg);
    const { start, end } = fightTimes(fight);
    const title = fight.foes[0] || (fight.live ? 'Combat en cours' : 'Combat');
    const match = matchingFoe(fight);
    const armed = state.armed === fight.id;
    list.append(h('li', {}, h('button', {
      type: 'button',
      class: 'rc-fight',
      'aria-current': fight.id === state.fightId ? 'page' : 'false',
      onclick: () => selectFight(fight.id),
    },
    h('span', { class: 'rc-fight-top' },
      h('span', { class: 'rc-fight-foe' }, ...(match === fight.foes[0] ? highlighted(title) : [title])),
      fight.live ? h('span', { class: 'rc-live', text: 'EN DIRECT' })
        : fight.isNew ? h('span', { class: 'rc-dot-new', 'aria-label': 'nouveau' })
          : fight.saved ? h('span', { class: 'rc-saved-mark', title: 'Sauvegardé' }, SAVED()) : null),
    // Found among the other monsters: says which.
    match && match !== fight.foes[0] ? h('span', { class: 'rc-fight-match' }, 'avec ', ...highlighted(match)) : null,
    h('span', { class: 'rc-fight-meta' },
      `${when(start)} · ${fight.live ? 'en cours' : duration(end - start, true)} · `,
      h('span', { class: 'num', text: fmt(team) }))),
    // The fight being played can't go.
    fight.live ? null : h('button', {
      type: 'button',
      class: `rc-del${armed ? ' armed' : ''}`,
      title: armed ? 'Cliquer encore pour supprimer' : 'Supprimer ce combat',
      'aria-label': armed ? `Confirmer la suppression du combat contre ${title}` : `Supprimer le combat contre ${title}`,
      onclick: () => (armed ? deleteFight(fight.id) : armDelete(fight.id)),
    }, TRASH(), armed ? 'Supprimer ?' : null)));
  }
}

function renderMain() {
  const main = document.getElementById('main');
  main.replaceChildren();
  const fight = state.fights.find((f) => f.id === state.fightId);
  if (!fight) {
    main.append(h('div', { class: 'rc-empty' },
      h('strong', { text: 'Pas encore de combat' }),
      h('span', { text: 'Lance un combat avec un de tes héros : le récap se remplit tout seul, tour après tour.' })));
    return;
  }

  const tab = TABS.find((t) => t.key === state.tab);
  // One foe's damage alone: only on the damage tabs, and only a foe of this fight.
  const canTarget = tab.key === 'dmg' || tab.key === 'taken';
  if (state.target && !fight.foes.includes(state.target)) state.target = null;
  const shown = canTarget && state.target ? onlyTarget(fight, state.target) : fight;
  // The whole group, followed heroes or not: the players who aren't carry a
  // "non suivi" tag but count like the others.
  const team = shown.fighters.map((f) => ({ fighter: f, stats: statsOf(f) }))
    .sort((a, b) => b.stats[tab.key] - a.stats[tab.key]);
  const teamTotal = sum(team, (x) => x.stats[tab.key]);
  const max = Math.max(1, ...team.map((x) => x.stats[tab.key]));

  // Header.
  const { start, end } = fightTimes(fight);
  const more = fight.foes.slice(1, 4);
  // The group's turns (rounds), not every fighter's: monsters play too.
  const rounds = Math.max(0, ...team.map((x) => x.stats.turnCount));
  const meta = fight.live
    ? [`Commencé à ${time(start)} · ${duration(end - start)} écoulées · ${rounds} tours joués`]
    : [`${when(start)} → ${time(end)} · ${duration(end - start)} · ${rounds} tours`];
  if (fight.victory) {
    meta.push(' · ', h('span', { class: 'rc-victory', title: 'Déduit du butin ramassé ou de l\'XP gagnée en fin de combat', text: 'Victoire' }),
      ' ', h('span', { class: 'rc-deduced', text: '(déduit)' }));
  } else if (!fight.live) {
    meta.push(' · ', h('span', { class: 'rc-defeat', title: 'Ni butin ni XP en fin de combat', text: 'Défaite' }),
      ' ', h('span', { class: 'rc-deduced', text: '(déduit)' }));
  }
  main.append(h('div', { class: 'rc-head' },
    h('div', { class: 'rc-head-text' },
      h('h1', {}, fight.foes[0] || 'Combat', more.length ? h('span', { class: 'rc-more-foes', text: ` + ${more.join(', ')}` }) : null),
      state.saveError ? h('p', { class: 'error', role: 'alert', text: state.saveError }) : null,
      h('span', { class: 'rc-head-meta' }, ...meta)),
    h('div', { class: 'rc-head-total' },
      h('span', { class: 'cap', text: `${tab.label} de l'équipe${canTarget && state.target ? ` · ${state.target}` : ''}` }),
      h('span', { class: 'num', text: fmt(teamTotal) }))));

  // Tabs and, always at the far right, the save button.
  main.append(h('div', { class: 'rc-bar' },
    h('div', { class: 'segmented rc-tabs', role: 'tablist', 'aria-label': 'Mesure' },
      TABS.map((t) => h('button', {
        type: 'button', role: 'tab', 'aria-selected': String(t.key === state.tab),
        onclick: () => { state.tab = t.key; render(); },
      }, h('span', { class: 'rc-tab-dot', style: { background: t.dot } }), t.label))),
    h('div', { class: 'rc-bar-end' }, targetPicker(fight, canTarget), saveButton(fight))));

  // Running total, turn after turn.
  const mode = modeOf(tab);
  if (tab.key !== 'taken') {
    const curve = renderCurve(team, mode, MODES[mode].curve);
    if (curve) main.append(curve);
  }

  // Rows.
  const rows = h('ul', { class: 'rc-rows' });
  team.forEach((x, i) => rows.append(renderRow(x, i, tab, teamTotal, max)));
  main.append(rows);

  // Best turn of the fight, while no row is open.
  if (!team.some((x) => x.fighter.name === state.open)) {
    const bestOf = (x) => x.stats.measures[mode].best;
    const best = team.filter(bestOf).sort((a, b) => bestOf(b).total - bestOf(a).total)[0];
    if (best) {
      const color = best.fighter.color;
      const turn = bestOf(best);
      main.append(h('button', {
        type: 'button',
        class: 'rc-moment',
        'aria-label': `Meilleur tour du combat : voir le détail de ${best.fighter.name}`,
        onclick: () => {
          state.open = best.fighter.name;
          state.hover = 0;
          render();
          document.querySelector('.rc-row.open')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        },
      },
        h('div', { class: 'rc-moment-text' },
          h('span', { class: 'cap', text: MODES[mode].bestOfFight }),
          h('span', { text: `${best.fighter.name} · tour ${turn.number}` }),
          h('span', { class: 'num', style: { color: rgb(color) }, text: fmt(turn.total) })),
        h('div', { class: 'rc-spells' }, tilesOf(turn.turn, mode).map((tile) => spellTile(tile, color, 40))),
        h('span', { class: 'rc-moment-hint', text: `Voir le détail de ${best.fighter.name}` })));
    }
  }
}

/** Chooses the foe whose damage alone is shown (damage tabs only). */
function targetPicker(fight, canTarget) {
  if (!canTarget || fight.foes.length < 2) return null;
  const select = h('select', {
    class: 'input sm rc-target', 'aria-label': 'Cible des dégâts',
    onchange: () => { state.target = select.value || null; state.hover = 0; render(); },
  }, h('option', { value: '', text: 'Toutes les cibles' }),
    fight.foes.map((foe) => h('option', { value: foe, text: foe, selected: foe === state.target })));
  return select;
}

/** Keeps the fight after the app quits (the bin, in the list, removes it). */
function saveButton(fight) {
  if (fight.saved) {
    return h('span', {
      class: 'rc-save done',
      title: 'Ce combat restera dans le récap après la fermeture de l\'appli. La corbeille de la liste le retire.',
    }, SAVED(), 'Sauvegardé');
  }
  return h('button', {
    type: 'button',
    class: 'btn xs rc-save',
    // Still there while the fight goes on, so it never moves.
    disabled: fight.live,
    title: fight.live ? 'Disponible à la fin du combat' : 'Garder ce combat dans le récap après la fermeture de l\'appli',
    onclick: () => saveFight(fight.id),
  }, SAVE(), 'Sauvegarder');
}

/** The measure whose spells a tab shows: its own, damage on "Subis". */
const modeOf = (tab) => (MODES[tab.key] ? tab.key : 'dmg');

/** What a player not among the heroes is: one of the user's own (XP earned), or another player. */
const untrackedLabel = (fighter) => (fighter.local ? 'Ton perso · non suivi' : 'Non suivi');

/** The class line: deduced classes say so. */
function classLine(fighter) {
  const label = CLASS_LABELS.get(fighter.class);
  if (!label) return 'Classe inconnue';
  return fighter.classGuessed ? `${label} (déduit)` : label;
}

function renderRow({ fighter, stats }, index, tab, teamTotal, max) {
  const untracked = !fighter.hero;
  const open = state.open === fighter.name;
  const value = stats[tab.key];
  const first = index === 0 && value > 0;
  const color = fighter.color;
  const avg = stats.turnCount ? value / stats.turnCount : 0;
  let sub = `${stats.turnCount} tours · moy. ${fmt(avg)} / tour`;
  const support = MODES[tab.key]?.kind ? stats.measures[tab.key] : null; // heals or armour
  if (tab.key === 'dmg' && stats.best) {
    sub += ` · meilleur tour ${fmt(stats.best.total)} (t${stats.best.number}) · ${stats.casts} sorts · ${pct(stats.critShare)} crit.`;
  } else if (support?.best) {
    sub += ` · meilleur tour ${fmt(support.best.total)} (t${support.best.number}) · ${support.spellRows.length} ${MODES[tab.key].kind}`;
  }

  // Not followed: the same ring, dashed.
  const avatar = h('span', {
    class: `rc-avatar${untracked ? ' untracked' : ''}`, 'aria-hidden': 'true',
    style: untracked ? { outlineColor: rgb(color) } : { boxShadow: `0 0 0 2px #182127, 0 0 0 4px ${rgb(color)}` },
  }, fighter.classIcon ? h('img', { src: `../${fighter.classIcon}`, alt: '' })
    : (CLASS_LABELS.get(fighter.class) || fighter.name || '?').slice(0, 2));

  const li = h('li', { class: `rc-row${untracked ? ' untracked' : ''}${open ? ' open' : ''}`, style: open ? { borderColor: rgb(color) } : undefined },
    h('button', {
      type: 'button', class: 'rc-row-btn', 'aria-expanded': String(open),
      'aria-label': `${fighter.name}${untracked ? ` (${untrackedLabel(fighter).toLowerCase()})` : ''} : ${fmt(value)}`,
      onclick: () => {
        state.open = open ? null : fighter.name;
        state.hover = 0;
        render();
      },
    },
    h('span', { class: 'rc-rank' }, first ? CROWN() : h('span', { class: 'num', text: String(index + 1) })),
    avatar,
    h('span', { class: 'rc-who' },
      h('span', { class: 'rc-who-name', text: fighter.name }),
      h('span', { class: 'rc-who-class' },
        classLine(fighter),
        untracked ? h('span', { class: `rc-tag${fighter.local ? ' local' : ''}`, text: untrackedLabel(fighter) }) : null)),
    h('span', { class: 'rc-measure' },
      h('span', { class: 'rc-measure-line' },
        h('span', { class: 'rc-track' }, h('span', { style: { width: `${((100 * value) / max).toFixed(1)}%`, background: rgb(color) } })),
        h('span', { class: 'num rc-value', text: fmt(value) }),
        h('span', { class: 'rc-share', text: pct(teamTotal ? (100 * value) / teamTotal : 0) })),
      h('span', { class: 'rc-sub', text: sub })),
    CHEVRON()));

  if (open) li.append(renderDetail(fighter, stats, modeOf(tab)));
  return li;
}

/** In a player's detail, when not among the heroes: says so, and offers to add them. */
function followBanner(fighter) {
  const text = fighter.local
    ? `${fighter.name} est un de tes persos (il a gagné de l'XP en fin de combat) mais n'est pas dans tes héros : ses sorts n'apparaissent pas sur l'overlay.`
    : `${fighter.name} n'est pas dans tes héros : ses sorts et ses dégâts sont relevés pour le récap, pas affichés sur l'overlay.`;
  const button = h('button', {
    type: 'button',
    class: `btn sm${fighter.local ? ' primary' : ''}`,
    onclick: async () => {
      button.disabled = true;
      await invoke('follow_fighter', { characterName: fighter.name, class: fighter.class || null });
      load();
    },
  }, 'Ajouter à mes héros');
  return h('div', { class: `rc-follow${fighter.local ? ' local' : ''}` }, h('span', { text }), button);
}

function renderDetail(fighter, stats, mode) {
  const color = fighter.color;
  const detail = h('div', { class: 'rc-detail' });
  if (!fighter.hero) detail.append(followBanner(fighter));
  const m = MODES[mode];
  // A turn picked on the curve replaces the best turn.
  const chosen = state.turn ? fighter.turns[state.turn - 1] : null;
  const measure = chosen
    ? { ...stats.measures[mode], best: { turn: chosen, number: state.turn, total: turnTotal(chosen, mode), picked: true } }
    : stats.measures[mode];

  // Best turn, with each spell's damage (or heals) on hover.
  const bestSection = h('section', { 'aria-label': 'Meilleur tour' });
  if (measure.best) {
    const tiles = tilesOf(measure.best.turn, mode);
    const tileTotal = (tile) => (tile.others ? sum(tile.others, (o) => o.amount) : spellTotal(tile.spell, mode));
    // Starts on the first spell that did something (a turn often opens on a buff).
    const hover = state.hover || Math.max(0, tiles.findIndex((tile) => tileTotal(tile) > 0));
    const tip = h('div', { class: 'rc-tip', 'aria-live': 'polite' });
    const showTip = (i) => {
      state.hover = i;
      const t = tipOf(tiles[i], mode);
      tip.replaceChildren(
        h('div', { class: 'rc-tip-top' }, h('span', { text: t.name }), h('span', { class: 'num', text: t.total })),
        h('span', { class: 'rc-tip-line', text: t.line }));
      buttons.forEach((b, j) => b.classList.toggle('on', j === i));
    };
    const buttons = tiles.map((tile, i) => spellTile(tile, color, 0, {
      tag: 'button',
      attrs: {
        type: 'button',
        'aria-label': tile.others ? 'Autres' : tile.spell.name + (tile.spell.crit ? ', critique' : ''),
        onmouseenter: () => showTip(i),
        onfocus: () => showTip(i),
        onclick: () => showTip(i),
      },
    }));
    bestSection.append(
      h('div', { class: 'rc-sec-head' },
        h('span', { class: 'cap', text: measure.best.picked ? `Tour ${measure.best.number}` : `${m.best} · tour ${measure.best.number}` }),
        h('span', { class: 'num', style: { color: rgb(color), fontSize: '16px' }, text: fmt(measure.best.total) })),
      tiles.length ? h('div', { class: 'rc-spells' }, buttons) : h('p', { class: 'rc-none', text: 'Aucun sort lancé.' }),
      tiles.length ? tip : null);
    if (tiles.length) showTip(Math.min(hover, tiles.length - 1));
  } else {
    bestSection.append(h('span', { class: 'cap', text: m.best }),
      h('p', { class: 'rc-none', text: m.noTurn }));
  }
  detail.append(bestSection);

  // The fight's spells.
  const rowsMax = Math.max(1, ...measure.spellRows.map((r) => r.total), measure.othersTotal);
  const spellSection = h('section', { 'aria-label': 'Sorts du combat' },
    h('span', { class: 'cap', text: m.spells }));
  if (!measure.spellRows.length && !measure.othersTotal) spellSection.append(h('p', { class: 'rc-none', text: m.noSpell }));
  for (const row of measure.spellRows) {
    const casts = `${row.casts} lancer${row.casts > 1 ? 's' : ''}`;
    if (!row.total) {
      spellSection.append(h('div', { class: 'rc-spell-row none' },
        h('div', { class: 'rc-spell-row-top' }, h('span', { text: row.name }), h('span', { class: 'rc-spell-row-sub', text: `${casts} · sans dégâts` }))));
      continue;
    }
    spellSection.append(h('div', { class: 'rc-spell-row' },
      h('div', { class: 'rc-spell-row-top' }, h('span', { text: row.name }), h('span', { class: 'num', text: fmt(row.total) })),
      h('span', { class: 'rc-track' }, h('span', { style: { width: `${((100 * row.total) / rowsMax).toFixed(1)}%`, background: rgb(color) } })),
      h('span', { class: 'rc-spell-row-sub', text: `${casts} · moy. ${fmt(row.total / row.casts)} · ${pct((100 * row.crits) / row.casts)} crit.` })));
  }
  if (measure.othersTotal) {
    spellSection.append(h('div', { class: 'rc-spell-row others' },
      h('div', { class: 'rc-spell-row-top' }, h('span', { text: 'Autres' }), h('span', { class: 'num', text: fmt(measure.othersTotal) })),
      h('span', { class: 'rc-track' }, h('span', { style: { width: `${((100 * measure.othersTotal) / rowsMax).toFixed(1)}%`, background: '#5b6c74' } })),
      // What's behind it, by name: "Vol de vie 12 000 · Marque Husse 3 400".
      h('span', { class: 'rc-spell-row-sub', text: measure.others.map((o) => `${o.label} ${fmt(o.amount)}`).join(' · ') })));
  }
  detail.append(spellSection);

  // Elements (who was healed / given armour, on those tabs), defence and support.
  const elemSection = h('section', { 'aria-label': m.targets ? `${m.targets} et défense` : 'Éléments et défense' });
  if (m.targets) {
    const targets = stats.targets[mode];
    elemSection.append(h('span', { class: 'cap', text: m.targets }));
    if (!targets.length) elemSection.append(h('p', { class: 'rc-none', text: 'Aucune cible connue.' }));
    for (const target of targets) {
      elemSection.append(h('div', { class: 'rc-def' },
        h('span', { class: 'rc-def-label', text: target.name }),
        h('span', { class: 'num', text: `${fmt(target.total)} · ${target.share} %` })));
    }
  } else if (stats.elements.length) {
    elemSection.append(
      h('span', { class: 'cap' }, 'Éléments ', h('span', { class: 'cap-note', text: '· approx.' })),
      h('div', { class: 'rc-elems', role: 'img', 'aria-label': stats.elements.map((e) => `${e.name} ${e.share} %`).join(', ') },
        stats.elements.map((e) => h('span', { style: { width: `${e.share}%`, background: e.color } }))),
      h('div', { class: 'rc-legend' }, stats.elements.map((e) => h('span', {},
        h('span', { class: 'rc-swatch', style: { background: e.color } }), `${e.name} ${e.share} %`))));
  } else {
    elemSection.append(h('span', { class: 'cap', text: 'Éléments' }), h('p', { class: 'rc-none', text: 'Aucun dégât élémentaire.' }));
  }
  // Which foes the spells hit, and how hard (the target filter shows one alone).
  if (mode === 'dmg' && !state.target && stats.targets.dmg.length > 1) {
    elemSection.append(h('span', { class: 'cap', style: { marginTop: '6px' } }, 'Cibles touchées ', h('span', { class: 'cap-note', text: '· sorts' })));
    for (const target of stats.targets.dmg) {
      elemSection.append(h('div', { class: 'rc-def' },
        h('span', { class: 'rc-def-label', text: target.name }),
        h('span', { class: 'num', text: `${fmt(target.total)} · ${target.share} %` })));
    }
  }
  elemSection.append(h('span', { class: 'cap', style: { marginTop: '6px' }, text: 'Défense & soutien' }));
  for (const [label, value, swatch] of [
    ['Soins donnés', stats.heal, '#ff5c8a'], ['Armure donnée', stats.armor, '#34d27b'], ['Dégâts subis', stats.taken, '#8fa1a9'],
  ]) {
    elemSection.append(h('div', { class: 'rc-def' },
      h('span', { class: 'rc-def-label' }, h('span', { class: 'rc-swatch', style: { background: swatch } }), label),
      h('span', { class: 'num', text: fmt(value) })));
  }
  detail.append(elemSection);
  return detail;
}

function render() {
  renderSide();
  renderMain();
}

// ── Data ─────────────────────────────────────────────────────────────────────

function selectFight(id) {
  state.fightId = id;
  state.saveError = null;
  state.open = null;
  state.hover = 0;
  state.turn = null;
  const fight = state.fights.find((f) => f.id === id);
  if (fight?.isNew) {
    fight.isNew = false;
    invoke('mark_fight_seen', { id });
  }
  render();
}

async function saveFight(id) {
  try {
    await invoke('save_fight', { id });
    state.saveError = null;
  } catch (err) {
    state.saveError = String(err);
  }
  load();
}

let disarmTimer = null;
function armDelete(id) {
  state.armed = id;
  clearTimeout(disarmTimer);
  disarmTimer = setTimeout(() => { state.armed = null; renderSide(); }, DELETE_ARMED_MS);
  renderSide();
  document.querySelector('.rc-del.armed')?.focus();
}

async function deleteFight(id) {
  clearTimeout(disarmTimer);
  state.armed = null;
  const index = visibleFights().findIndex((f) => f.id === id);
  const fight = state.fights.find((f) => f.id === id);
  if (typeof id === 'string') await invoke('delete_saved_fight', { savedId: fight.savedId });
  else await invoke('delete_fight', { id });
  state.fights = state.fights.filter((f) => f.id !== id);
  if (state.fightId !== id) {
    renderSide();
    return;
  }
  // The deleted fight was on screen: show its neighbour in the list.
  const rest = visibleFights();
  const next = rest[Math.min(index, rest.length - 1)] || state.fights[0];
  state.fightId = null;
  if (next) selectFight(next.id);
  else render();
}

// ── Search by monster, with the monsters met as suggestions ─────────────────

const search = document.getElementById('fight-search');
const suggest = document.getElementById('fight-suggest');
let suggestIndex = -1; // suggestion picked with the arrow keys

function applySearch() {
  state.search = search.value;
  // Shows the first fight found if the one on screen isn't among them.
  const fights = visibleFights();
  if (fights.length && !fights.some((f) => f.id === state.fightId)) selectFight(fights[0].id);
  else renderSide();
}

/** Every monster of the session's fights, with how many fights it was in: most met first. */
function knownFoes() {
  const counts = new Map();
  for (const fight of state.fights) {
    for (const foe of new Set(fight.foes)) counts.set(foe, (counts.get(foe) || 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'fr'));
}

function closeSuggest() {
  suggestIndex = -1;
  suggest.hidden = true;
  search.setAttribute('aria-expanded', 'false');
  search.removeAttribute('aria-activedescendant');
}

function renderSuggest() {
  const query = fold(search.value.trim());
  const foes = knownFoes().filter(([foe]) => fold(foe).includes(query));
  if (!foes.length) {
    closeSuggest();
    return;
  }
  suggestIndex = Math.min(suggestIndex, foes.length - 1);
  suggest.replaceChildren(...foes.map(([foe, count], i) => h('li', {
    id: `foe-${i}`,
    role: 'option',
    class: i === suggestIndex ? 'on' : undefined,
    'aria-selected': String(i === suggestIndex),
    'data-foe': foe,
    // Before the field loses focus (which closes the list).
    onmousedown: (event) => { event.preventDefault(); pickFoe(foe); },
  }, h('span', { class: 'rc-suggest-name' }, ...highlighted(foe)),
  h('span', { class: 'rc-suggest-count', text: `${count} combat${count > 1 ? 's' : ''}` }))));
  suggest.hidden = false;
  search.setAttribute('aria-expanded', 'true');
  if (suggestIndex >= 0) {
    search.setAttribute('aria-activedescendant', `foe-${suggestIndex}`);
    suggest.children[suggestIndex].scrollIntoView({ block: 'nearest' });
  } else search.removeAttribute('aria-activedescendant');
}

function pickFoe(foe) {
  search.value = foe;
  applySearch();
  closeSuggest();
}

search.addEventListener('input', () => {
  suggestIndex = -1;
  applySearch();
  if (document.activeElement === search) renderSuggest();
});
search.addEventListener('focus', renderSuggest);
search.addEventListener('click', () => { if (suggest.hidden) renderSuggest(); });
search.addEventListener('blur', closeSuggest);
search.addEventListener('keydown', (event) => {
  const count = suggest.hidden ? 0 : suggest.children.length;
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    if (!count) {
      renderSuggest();
      return;
    }
    const step = event.key === 'ArrowDown' ? 1 : -1;
    suggestIndex = (suggestIndex + step + count + (suggestIndex < 0 && step < 0 ? 1 : 0)) % count;
    renderSuggest();
  } else if (event.key === 'Enter' && count && suggestIndex >= 0) {
    event.preventDefault();
    pickFoe(suggest.children[suggestIndex].dataset.foe);
  } else if (event.key === 'Escape' && count) {
    event.preventDefault(); // keeps the text (Escape on a search field clears it)
    closeSuggest();
  }
});

/**
 * Gives the players who aren't heroes a colour of their own for the fight,
 * like the heroes have: the settings page's palette, minus the colours the
 * fight's heroes already use, in order of appearance.
 */
function colourUntracked(fight) {
  const key = (c) => `${c.r},${c.g},${c.b}`;
  const used = new Set(fight.fighters.filter((f) => f.color).map((f) => key(f.color)));
  const free = UNTRACKED_PALETTE.filter((c) => !used.has(key(c)));
  const pool = free.length ? free : UNTRACKED_PALETTE;
  fight.fighters.filter((f) => !f.color).forEach((f, i) => { f.color = pool[i % pool.length]; });
}

async function load() {
  const { fights } = await invoke('get_recap');
  fights.forEach(colourUntracked);
  state.fights = fights;
  if (!fights.some((f) => f.id === state.fightId)) {
    // Newest first: show the latest fight.
    if (fights.length) selectFight(fights[0].id);
    else render();
    return;
  }
  const current = fights.find((f) => f.id === state.fightId);
  if (current.isNew) {
    current.isNew = false;
    invoke('mark_fight_seen', { id: current.id });
  }
  render();
}

// Redraws while a fight goes on, at most once a second (hits come in bursts).
let refreshTimer = null;
listen('recap:changed', () => {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    load();
  }, REFRESH_MS);
});
load();
