'use strict';

const comboLog = document.getElementById('combo-log');
const comboOverlay = document.getElementById('combo-overlay');
const classLeadIcon = document.getElementById('class-lead-icon');
const leadWrap = document.getElementById('lead-wrap');
const turnDamageEl = document.getElementById('turn-damage');
const turnDamageValue = turnDamageEl.querySelector('.td-value');
const turnDamageTag = turnDamageEl.querySelector('.td-tag');
const supportEl = document.getElementById('support');
// Heals and armour the hero gave, beside the counter: the value drawn on each.
const supportCounters = {
  heal: { el: supportEl.querySelector('.sp-heal'), shown: 0 },
  armor: { el: supportEl.querySelector('.sp-armor'), shown: 0 },
};
// The app's own in-game window loads the page with `?ingame`.
const isHud = new URLSearchParams(window.location.search).has('ingame');

// Mirrors style.css: .cast-entry padding (4px * 2) + border (2px * 2), and
// the wrapper edge offset.
const ENTRY_CHROME_PX = 4 * 2 + 2 * 2;
const ENTRY_GAP_PX = 6;
const EDGE_OFFSET_PX = 16;
const CLASS_ICON_GAP_PX = 8;
const CLASS_ICON_EXTRA_PX = 12; // calc(var(--icon-size) + 12px) in style.css
// In-game window: the gap between the control bar and the overlay under it
// (#hud-bar in style.css)…
const HUD_BAR_GAP_PX = 8;
// …and the room kept around everything, so nothing ever gets cut.
const HUD_MARGIN_PX = 16;

// Overridden by the `config` SSE event.
let castLifetimeMs = 6000;
let iconSize = 32;
let maxVisibleCasts = 8;
let previewEnabled = false;
let classIcons = {};
let previewPool = [];
let damageCounterEnabled = true;
let damageCounterMode = 'turn'; // 'turn' or 'fight': what the counter adds up
let renderedListLayout = null; // the config the cast list was last rebuilt for (see applyConfig)

// Latest `turn-damage` event, and the value currently drawn (it counts up to
// the event's total rather than jumping).
let turnDamage = null;
let shownDamage = 0;
let damageAnimFrame = null;
let pendingSwapKey = null; // new total waiting for the old one to fold away
const DAMAGE_COUNT_UP_MS = 500;
const TURN_SWAP_MS = 200; // the fold-out third of `td-swap` in style.css
const PREVIEW_DAMAGE = 87412;
const PREVIEW_SUPPORT = { heal: 12400, armor: 3500 };

const liveCasts = []; // { cast, addedAt, el }
let previewCasts = []; // { cast, addedAt, el }

// Must outlast the `cast-leave` animation in style.css — fallback in case
// animationend never fires (element hidden, animations disabled…).
const LEAVE_FALLBACK_MS = 1000;

/**
 * The demo casts ("sorts factices") show while nothing real is: a real or
 * test cast takes their place until it fades, then they come back.
 */
const showingPreview = () => previewEnabled && !liveCasts.length;

function activeCasts() {
  return showingPreview() ? previewCasts : liveCasts;
}

function effectiveCapacity() {
  const horizontal = comboOverlay.dataset.orientation === 'horizontal';
  const classIconSize = iconSize + CLASS_ICON_EXTRA_PX;
  const counter = counterMetrics();
  // Horizontal: icon and counter sit in line with the casts. Vertical: they
  // sit beside the column, so it has the whole height.
  const alongExtra = horizontal
    ? classIconSize + CLASS_ICON_GAP_PX + (damageCounterEnabled ? counter.horizontalWidth + counter.supportWidth + 2 * CLASS_ICON_GAP_PX : 0)
    : 0;
  // In-game, the bar sits above the overlay (see hudRoom).
  const available = (horizontal ? window.innerWidth : window.innerHeight - (isHud ? barRoom() + HUD_MARGIN_PX : 0))
    - EDGE_OFFSET_PX * 2 - alongExtra;
  const entry = iconSize + ENTRY_CHROME_PX;
  const fits = Math.floor((available + ENTRY_GAP_PX) / (entry + ENTRY_GAP_PX));
  return Math.max(1, Math.min(maxVisibleCasts, fits));
}

function createCastElement(cast) {
  const el = document.createElement('div');
  el.className = cast.summon ? 'cast-entry summon' : 'cast-entry';
  const { r = 120, g = 120, b = 120 } = cast.color || {};
  el.style.setProperty('--cast-r', r);
  el.style.setProperty('--cast-g', g);
  el.style.setProperty('--cast-b', b);

  if (cast.icon) {
    const img = document.createElement('img');
    img.className = 'cast-icon';
    img.src = '/' + cast.icon.replace(/\\/g, '/');
    img.alt = '';
    img.onerror = () => {
      img.replaceWith(Object.assign(document.createElement('div'), {
        className: 'cast-icon-placeholder', textContent: '•',
      }));
    };
    el.appendChild(img);
  } else {
    const placeholder = document.createElement('div');
    placeholder.className = 'cast-icon-placeholder';
    placeholder.textContent = '•';
    el.appendChild(placeholder);
  }
  return el;
}

/** Older casts fade slightly; the newest one stays fully opaque and glows. */
function updateEntryStyles() {
  const list = activeCasts();
  const n = list.length;
  list.forEach((entry, index) => {
    if (!entry.el) return;
    const newest = index === n - 1;
    entry.el.classList.toggle('newest', newest);
    entry.el.style.opacity = newest ? '1' : (0.6 + 0.4 * (index + 1) / n).toFixed(2);
  });
}

/** Folds a cast away (see `cast-leave` in style.css), then drops its element. */
function animateOut(el) {
  if (!el || el.classList.contains('leaving')) return;
  el.classList.remove('newest', 'entering');
  el.classList.add('leaving');
  const done = () => el.remove();
  el.addEventListener('animationend', (e) => { if (e.animationName === 'cast-leave') done(); });
  setTimeout(done, LEAVE_FALLBACK_MS);
}

/** Full, unanimated rebuild — used on config changes, resizes and preview toggles. */
function renderActiveCasts() {
  comboLog.innerHTML = '';
  for (const entry of activeCasts()) {
    entry.el = createCastElement(entry.cast);
    comboLog.appendChild(entry.el);
  }
  updateEntryStyles();
  updateClassLeadIcon();
}

/** @returns {object[]} The entries dropped from `model`, oldest first. */
function trimModelToCapacity(model) {
  const capacity = effectiveCapacity();
  const removed = [];
  while (model.length > capacity) removed.push(model.shift());
  return removed;
}

/** @returns {object[]} The expired or overflowing entries removed from liveCasts. */
function pruneLiveCasts() {
  const now = Date.now();
  const removed = [];
  while (liveCasts.length && liveCasts[0].addedAt + castLifetimeMs <= now) removed.push(liveCasts.shift());
  return removed.concat(trimModelToCapacity(liveCasts));
}

function buildPreviewCasts() {
  const capacity = effectiveCapacity();
  const pool = previewPool.length ? previewPool : [
    { class: null, spellName: 'Preview', icon: null, color: { r: 120, g: 120, b: 120 } },
  ];
  previewCasts = [];
  for (let i = 0; i < capacity; i += 1) {
    const sample = pool[i % pool.length];
    previewCasts.push({
      cast: {
        class: sample.class ?? null,
        classIcon: sample.class ? classIcons[sample.class] ?? null : null,
        spellName: sample.spellName || 'Preview',
        icon: sample.icon ?? null,
        color: sample.color ?? { r: 120, g: 120, b: 120 },
        timestamp: Date.now(),
      },
      addedAt: Date.now(),
    });
  }
}

// What the class icon box currently holds: the icon's path, PLACEHOLDER, or
// null when it's empty.
const PLACEHOLDER = '•';
let leadIconKey = null;

/**
 * Shows the class of the most recent cast. The icon is only rebuilt when it
 * actually changes (another hero) — rebuilding it on every cast or expiry made
 * it flicker. `animate` replays the swap-in: the first cast of a turn.
 */
function updateClassLeadIcon({ animate = false } = {}) {
  const list = activeCasts();
  // A cast arriving while it folds away (or the fold-out being over) cancels it.
  leadWrap.classList.remove('leaving');
  if (!list.length) {
    classLeadIcon.classList.remove('visible', 'swap');
    classLeadIcon.innerHTML = '';
    leadIconKey = null;
    renderTurnDamage();
    return;
  }

  const latest = list[list.length - 1].cast;
  const icon = latest.classIcon || (latest.class ? classIcons[latest.class] : null);
  const key = latest.class && icon ? icon : PLACEHOLDER;

  classLeadIcon.classList.add('visible');
  renderTurnDamage();
  if (key !== leadIconKey) {
    leadIconKey = key;
    classLeadIcon.innerHTML = '';
    if (key === PLACEHOLDER) {
      classLeadIcon.appendChild(Object.assign(document.createElement('div'), { className: 'placeholder', textContent: PLACEHOLDER }));
    } else {
      const img = document.createElement('img');
      img.src = '/' + icon.replace(/\\/g, '/');
      img.alt = '';
      img.onerror = () => {
        classLeadIcon.innerHTML = `<div class="placeholder">${PLACEHOLDER}</div>`;
      };
      classLeadIcon.appendChild(img);
    }
  }
  if (animate) replayClass(classLeadIcon, 'swap');
}

// ── Turn damage counter (K1) ──────────────────────────────────────────────────

/** "210 750"; past 999 999, "1,04 M" (truncated, never rounded up). */
function formatDamage(n) {
  if (n >= 1e6) {
    return `${(Math.floor(n / 1e4) / 100).toLocaleString('fr-FR', {
      minimumFractionDigits: 2, maximumFractionDigits: 2,
    })}\u00a0M`;
  }
  return Math.round(n).toLocaleString('fr-FR');
}

/** The hero colour, and the same mixed 55 % towards white for the frame's highlights. */
function setDamageColor({ r = 120, g = 120, b = 120 } = {}) {
  const light = [r, g, b].map((v) => Math.round(v + (255 - v) * 0.55)).join(', ');
  turnDamageEl.style.setProperty('--td-rgb', `${r}, ${g}, ${b}`);
  turnDamageEl.style.setProperty('--td-light', light);
}

function countDamageTo(target) {
  cancelAnimationFrame(damageAnimFrame);
  const from = shownDamage;
  const start = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - start) / DAMAGE_COUNT_UP_MS);
    shownDamage = from + (target - from) * (1 - (1 - t) ** 3);
    turnDamageValue.textContent = formatDamage(shownDamage);
    if (t < 1) damageAnimFrame = requestAnimationFrame(step);
  };
  damageAnimFrame = requestAnimationFrame(step);
}

/** What the counter shows of a `turn-damage` event: the turn's total, or the hero's whole fight. */
const counterValue = (event) => (damageCounterMode === 'fight' ? event.fightTotal ?? event.total : event.total);

/** Events adding to the same total: one turn, or one hero over the fight. */
const counterKey = (event) => (damageCounterMode === 'fight' ? `fight:${event.characterName}` : `turn:${event.turnId}`);

function resetCounterTo(event) {
  cancelAnimationFrame(damageAnimFrame);
  shownDamage = 0;
  turnDamageValue.textContent = formatDamage(0);
  setDamageColor(event.color);
}

/** Restarts a one-shot CSS animation class. */
function replayClass(el, className) {
  el.classList.remove(className);
  void el.offsetWidth;
  el.classList.add(className);
}

/** "8 412"; "12,4 k" past 9 999; "1,23 M" past 999 999 (truncated). */
function formatShort(n) {
  if (n >= 1e6) return formatDamage(n);
  if (n >= 1e4) {
    return `${(Math.floor(n / 100) / 10).toLocaleString('fr-FR', {
      minimumFractionDigits: 1, maximumFractionDigits: 1,
    })}\u00a0k`;
  }
  return Math.round(n).toLocaleString('fr-FR');
}

/** What the heal and armour frames show of a `turn-damage` event, in the counter's mode. */
const supportValues = (event) => (damageCounterMode === 'fight'
  ? { heal: event.fightHeal ?? 0, armor: event.fightArmor ?? 0 }
  : { heal: event.heal ?? 0, armor: event.armor ?? 0 });

/** Draws the heal and armour frames; `pulse` flares the ones that went up. */
function renderSupport(values, { pulse = false } = {}) {
  for (const [key, counter] of Object.entries(supportCounters)) {
    const value = values?.[key] || 0;
    counter.el.classList.toggle('empty', !value);
    counter.el.querySelector('.sp-value').textContent = formatShort(value);
    if (pulse && value > counter.shown) replayClass(counter.el, 'gain');
    counter.shown = value;
  }
}

/** The counter lives and dies with the class icon it's attached to. */
function renderTurnDamage() {
  if (!damageCounterEnabled || !classLeadIcon.classList.contains('visible')) {
    turnDamageEl.hidden = true;
    supportEl.hidden = true;
    return;
  }
  turnDamageEl.hidden = false;
  supportEl.hidden = false;
  turnDamageTag.textContent = damageCounterMode === 'fight' ? 'Combat' : 'Tour';
  if (showingPreview()) {
    const list = activeCasts();
    setDamageColor(list[list.length - 1]?.cast.color);
    turnDamageEl.classList.remove('idle');
    turnDamageValue.textContent = formatDamage(PREVIEW_DAMAGE);
    renderSupport(PREVIEW_SUPPORT);
    return;
  }
  turnDamageEl.classList.toggle('idle', !turnDamage);
  if (!turnDamage) renderSupport(null);
}

function showHitAmount(amount) {
  replayClass(turnDamageEl, 'hit');
  // One "+N" at a time: a quick follow-up hit replaces the previous one.
  for (const old of turnDamageEl.querySelectorAll('.td-hit')) old.remove();
  const hit = document.createElement('span');
  hit.className = 'td-hit';
  hit.textContent = `+${formatDamage(amount)}`;
  hit.addEventListener('animationend', () => hit.remove());
  setTimeout(() => hit.remove(), LEAVE_FALLBACK_MS);
  turnDamageEl.appendChild(hit);
}

/** Folds the shown total away, then counts the latest event's total up from 0. */
function swapCounter(key) {
  pendingSwapKey = key;
  replayClass(turnDamageEl, 'swap');
  replayClass(supportEl, 'swap');
  setTimeout(() => {
    if (pendingSwapKey !== key) return;
    pendingSwapKey = null;
    resetCounterTo(turnDamage);
    countDamageTo(counterValue(turnDamage));
    renderSupport(supportValues(turnDamage));
  }, TURN_SWAP_MS);
}

/** Turn or fight total — from the settings, or the in-game window's switch. */
function setCounterMode(mode) {
  if (mode !== 'turn' && mode !== 'fight') return;
  if (hudBar) {
    for (const button of hudBar.querySelectorAll('[data-mode]')) button.setAttribute('aria-checked', String(button.dataset.mode === mode));
  }
  if (mode === damageCounterMode) return;
  damageCounterMode = mode;
  turnDamageTag.textContent = mode === 'fight' ? 'Combat' : 'Tour';
  const showing = turnDamage && !showingPreview() && !turnDamageEl.hidden && !turnDamageEl.classList.contains('idle');
  if (showing) swapCounter(counterKey(turnDamage));
}

function applyTurnDamage(event) {
  const previous = turnDamage;
  turnDamage = event;
  if (showingPreview()) return;

  const key = counterKey(event);
  const sameCounter = previous && counterKey(previous) === key;
  if (!sameCounter) {
    const showingPrevious = previous && !turnDamageEl.hidden && !turnDamageEl.classList.contains('idle');
    if (showingPrevious) {
      // The old total folds away first (see `td-swap`), then the new one comes in.
      swapCounter(key);
    } else {
      pendingSwapKey = null;
      resetCounterTo(event);
    }
  } else if (counterValue(event) < shownDamage) {
    // Same hero, new fight: its fight total starts over.
    resetCounterTo(event);
  }
  renderTurnDamage();
  if (pendingSwapKey !== null) return;
  countDamageTo(counterValue(event));
  renderSupport(supportValues(event), { pulse: sameCounter });
  if (event.amount > 0 && damageCounterEnabled) showHitAmount(event.amount);
}

// ── Layout (V3 + counter room) ────────────────────────────────────────────────

/** Mirrors the #turn-damage sizes in style.css (mockup drawn at 48 px icons). */
function counterMetrics() {
  const k = iconSize / 48;
  return {
    k,
    horizontalWidth: 136 * k,
    verticalWidth: 88 * k,
    verticalHeight: 2 * 7 * k + 1.2 * Math.max(8, 10 * k) + 1 + 1.2 * Math.max(10, 15 * k),
    deltaRoom: 6 + 1.2 * 15 * k + 14, // the "+N" dropping below (horizontal)
    // The heal and armour frames (#support): beside the counter, or under it.
    supportWidth: 80 * k, // wide enough for "123,4 k"
    supportHeight: 2 * 24 * k + 6 * k,
  };
}

function applyCounterLayout() {
  document.documentElement.style.setProperty('--k', counterMetrics().k.toFixed(4));
  comboOverlay.dataset.counter = damageCounterEnabled ? 'on' : 'off';
}

/** Same hero behind both casts — a summon counts as its summoner (same heroName). */
const sameHero = (a, b) => Boolean(a && b) && (a.heroName ?? a.characterName) === (b.heroName ?? b.characterName);

/**
 * The first cast of a turn (or the first since every cast faded away). Test
 * casts carry no turn: for them, a change of hero counts as a new turn.
 */
const startsTurn = (previous, cast) => (cast.turnId != null
  ? previous?.turnId !== cast.turnId
  : !sameHero(previous, cast));

function addLiveCast(cast) {
  const previous = liveCasts[liveCasts.length - 1]?.cast;
  const entry = { cast, addedAt: cast.timestamp || Date.now() };
  // The demo casts make way for the real one.
  if (showingPreview()) comboLog.innerHTML = '';
  liveCasts.push(entry);
  const removed = pruneLiveCasts();

  // Only the new cast is added and the dropped ones animated out — the rest
  // stay untouched so their own animations aren't restarted.
  if (liveCasts.includes(entry)) {
    entry.el = createCastElement(cast);
    entry.el.classList.add('entering');
    comboLog.appendChild(entry.el);
  }
  for (const old of removed) animateOut(old.el);
  updateEntryStyles();
  // The class icon swaps in on a turn's first cast only, not on each cast.
  updateClassLeadIcon({ animate: startsTurn(previous, cast) });
}

function applyOrientationAndDirection(config) {
  if (config.orientation) {
    comboOverlay.dataset.orientation = config.orientation;
    comboLog.dataset.orientation = config.orientation;
  }
  if (config.direction) {
    comboOverlay.dataset.direction = config.direction;
    comboLog.dataset.direction = config.direction;
  }
  if (config.classIconSide) comboOverlay.dataset.classIconSide = config.classIconSide;
  if (hudBar) {
    hudBar.dataset.orientation = comboOverlay.dataset.orientation || 'horizontal';
    hudBar.dataset.direction = comboOverlay.dataset.direction || '';
    hudBar.dataset.side = anchorSide();
    document.documentElement.style.setProperty('--bar-room', `${barRoom()}px`);
  }
}

/**
 * The side the overlay is pinned to (see #combo-overlay in style.css): the
 * class icon's when horizontal, the cast column's when vertical.
 */
function anchorSide() {
  const iconRight = comboOverlay.dataset.classIconSide === 'right';
  const vertical = comboOverlay.dataset.orientation === 'vertical';
  return iconRight !== vertical ? 'right' : 'left';
}

function rerenderForCurrentMode() {
  if (showingPreview()) {
    buildPreviewCasts();
    renderActiveCasts();
    return;
  }
  pruneLiveCasts();
  renderActiveCasts();
}

function applyConfig(config) {
  applyOrientationAndDirection(config);
  if (config.iconSize !== undefined) {
    iconSize = config.iconSize;
    document.documentElement.style.setProperty('--icon-size', `${iconSize}px`);
  }
  if (config.castLifetimeMs !== undefined) {
    castLifetimeMs = config.castLifetimeMs;
  }
  if (config.maxVisibleCasts !== undefined) maxVisibleCasts = Math.max(1, config.maxVisibleCasts);
  if (typeof config.previewEnabled === 'boolean') previewEnabled = config.previewEnabled;
  if (typeof config.damageCounterEnabled === 'boolean') damageCounterEnabled = config.damageCounterEnabled;
  if (config.damageCounterMode) setCounterMode(config.damageCounterMode);
  if (config.classIcons && typeof config.classIcons === 'object') classIcons = config.classIcons;
  if (Array.isArray(config.previewPool)) previewPool = config.previewPool;
  applyCounterLayout();
  rerenderIfLayoutChanged();
}

/**
 * Every config push (a counter mode switch, say) used to rebuild the whole
 * list, whose fresh icons then blinked out while they loaded: it's only
 * rebuilt when something it depends on changed.
 */
function rerenderIfLayoutChanged() {
  const listLayout = JSON.stringify([
    comboOverlay.dataset.orientation, comboOverlay.dataset.direction, comboOverlay.dataset.classIconSide,
    iconSize, maxVisibleCasts, previewEnabled, damageCounterEnabled, previewPool.length,
  ]);
  if (listLayout !== renderedListLayout) {
    renderedListLayout = listLayout;
    rerenderForCurrentMode();
  } else {
    renderTurnDamage();
  }
}

setInterval(() => {
  if (showingPreview()) return;
  const removed = pruneLiveCasts();
  if (!removed.length) return;
  for (const old of removed) animateOut(old.el);
  updateEntryStyles();
  // The last real cast is gone: the demo casts come back once it has folded away.
  if (showingPreview()) {
    setTimeout(() => { if (showingPreview()) rerenderForCurrentMode(); }, LEAVE_FALLBACK_MS);
    return;
  }
  // The class icon folds away together with the last cast, then goes.
  if (!liveCasts.length) {
    leadWrap.classList.add('leaving');
    setTimeout(() => { if (!liveCasts.length && !previewEnabled) updateClassLeadIcon(); }, LEAVE_FALLBACK_MS);
  } else {
    updateClassLeadIcon();
  }
}, 500);

window.addEventListener('resize', rerenderForCurrentMode);

// ── In-game window: the control bar ──────────────────────────────────────────

/**
 * Only in the app's in-game window, which lets every click through to the game
 * except on this bar: the page tells the app where it is, and the app makes
 * just that spot clickable (src-tauri/src/ingame_window.rs). The handle drags
 * the window, Tour / Combat switches the counter, "Récap" opens the recap.
 */
const hudBar = isHud ? document.createElement('div') : null;

/** What the bar above the overlay takes up, with the gap under it. */
const barRoom = () => (hudBar ? hudBar.offsetHeight + HUD_BAR_GAP_PX : 0);

// Marks the in-game window's own requests: a web page can't add a header like
// this without a CORS preflight, which the server never answers.
const hudFetch = (url) => fetch(url, { headers: { 'X-Wakfu-Overlay': '1' } });

/**
 * What the overlay can take up at most with the current layout — every cast
 * slot filled, the counter at its widest — plus the bar and margins: the
 * window is sized to it, so nothing ever gets cut. Mirrors overlaySize() in
 * ui/settings/settings.js.
 */
function hudRoom() {
  const icon = iconSize;
  const entry = icon + ENTRY_CHROME_PX;
  const lead = icon + CLASS_ICON_EXTRA_PX;
  const logLen = maxVisibleCasts * entry + (maxVisibleCasts - 1) * ENTRY_GAP_PX;
  const c = counterMetrics();
  // A fight total runs to 8–9 digits: room beyond the counter's base width.
  const counterSlack = 64 * c.k;
  let width;
  let height;
  if (comboOverlay.dataset.orientation === 'horizontal') {
    const counterW = damageCounterEnabled
      ? c.horizontalWidth + counterSlack + CLASS_ICON_GAP_PX + c.supportWidth + counterSlack / 2 + CLASS_ICON_GAP_PX
      : 0;
    width = EDGE_OFFSET_PX * 2 + lead + CLASS_ICON_GAP_PX + counterW + logLen;
    height = EDGE_OFFSET_PX * 2 + Math.max(entry, lead) + (damageCounterEnabled ? c.deltaRoom : 0);
  } else {
    // The icon, counter, heals and armour stacked beside the column, from its newest end.
    const leadW = damageCounterEnabled ? Math.max(lead, c.verticalWidth + counterSlack) : lead;
    const leadH = lead + (damageCounterEnabled
      ? CLASS_ICON_GAP_PX + c.verticalHeight + CLASS_ICON_GAP_PX + c.supportHeight
      : 0);
    width = EDGE_OFFSET_PX * 2 + leadW + CLASS_ICON_GAP_PX + entry;
    height = EDGE_OFFSET_PX * 2 + Math.max(logLen, leadH);
  }
  const bar = hudBar.getBoundingClientRect();
  return {
    width: Math.ceil(Math.max(width, bar.width + EDGE_OFFSET_PX * 2) + HUD_MARGIN_PX * 2),
    // The bar beside the overlay (above it, or below it bottom to top), and the margin.
    height: Math.ceil(height + barRoom() + HUD_MARGIN_PX),
  };
}

if (hudBar) {
  document.documentElement.classList.add('hud');
  hudBar.id = 'hud-bar';
  hudBar.setAttribute('role', 'toolbar');
  hudBar.setAttribute('aria-label', 'Contrôles de l\'affichage tête haute');
  hudBar.innerHTML = `
    <span class="hud-handle" title="Glisser pour déplacer" aria-label="Déplacer">${'<span></span>'.repeat(6)}</span>
    <span class="hud-modes" role="radiogroup" aria-label="Période du compteur">
      <button type="button" role="radio" data-mode="turn" aria-checked="true">Tour</button>
      <button type="button" role="radio" data-mode="fight" aria-checked="false">Combat</button>
    </span>
    <button type="button" class="hud-recap">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3v18h18"/><path d="M7 15v-4"/><path d="M12 15V7"/><path d="M17 15v-6"/></svg>
      Récap
    </button>`;
  document.body.appendChild(hudBar);

  hudBar.querySelector('.hud-handle').addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    // The app moves the window with the mouse until the button is released.
    hudFetch('/hud/drag').catch(() => {});
  });
  for (const button of hudBar.querySelectorAll('[data-mode]')) {
    button.addEventListener('click', () => {
      setCounterMode(button.dataset.mode);
      // Saved by the app, which also passes it on to OBS and the settings.
      hudFetch(`/hud/counter-mode?mode=${button.dataset.mode}`).catch(() => {});
    });
  }
  hudBar.querySelector('.hud-recap').addEventListener('click', () => hudFetch('/hud/recap').catch(() => {}));
  setCounterMode(damageCounterMode);

  // Where the bar is, and how big the window must be — reported on change.
  let reportedRect = null;
  let reportedSize = null;
  setInterval(() => {
    document.documentElement.style.setProperty('--bar-room', `${barRoom()}px`);
    const r = hudBar.getBoundingClientRect();
    const rect = `x=${Math.floor(r.left)}&y=${Math.floor(r.top)}&w=${Math.ceil(r.width)}&h=${Math.ceil(r.height)}`;
    if (rect !== reportedRect) {
      reportedRect = rect;
      hudFetch(`/hud/controls-rect?${rect}`).catch(() => { reportedRect = null; });
    }
    const { width, height } = hudRoom();
    // The window grows away from the corner the overlay is pinned to.
    const upward = comboOverlay.dataset.orientation === 'vertical' && comboOverlay.dataset.direction === 'bottom-to-top';
    const size = `w=${width}&h=${height}&side=${anchorSide()}&edge=${upward ? 'bottom' : 'top'}`;
    if (size !== reportedSize) {
      reportedSize = size;
      hudFetch(`/hud/size?${size}`).catch(() => { reportedSize = null; });
    }
  }, 150);
}

// ── SSE connection ────────────────────────────────────────────────────────────

function connect() {
  // `?ingame` (the app's own window) is passed on, so it isn't counted as OBS.
  const source = new EventSource(`/events${window.location.search}`);

  source.addEventListener('cast', (e) => {
    try { addLiveCast(JSON.parse(e.data)); } catch { /* ignore */ }
  });

  source.addEventListener('turn-damage', (e) => {
    try { applyTurnDamage(JSON.parse(e.data)); } catch { /* ignore */ }
  });

  source.addEventListener('config', (e) => {
    try { applyConfig(JSON.parse(e.data)); } catch { /* ignore */ }
  });

  source.onerror = () => {
    source.close();
    setTimeout(connect, 3000);
  };
}

connect();
