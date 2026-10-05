'use strict';

const comboLog = document.getElementById('combo-log');
const comboOverlay = document.getElementById('combo-overlay');
const classLeadIcon = document.getElementById('class-lead-icon');
const leadWrap = document.getElementById('lead-wrap');
const turnDamageEl = document.getElementById('turn-damage');
const turnDamageValue = turnDamageEl.querySelector('.td-value');

// Mirrors style.css: .cast-entry padding (4px * 2) + border (2px * 2), and
// the wrapper edge offset.
const ENTRY_CHROME_PX = 4 * 2 + 2 * 2;
const ENTRY_GAP_PX = 6;
const EDGE_OFFSET_PX = 16;
const CLASS_ICON_GAP_PX = 8;
const CLASS_ICON_EXTRA_PX = 12; // calc(var(--icon-size) + 12px) in style.css

// Overridden by the `config` SSE event.
let castLifetimeMs = 6000;
let iconSize = 32;
let maxVisibleCasts = 8;
let previewEnabled = false;
let classIcons = {};
let previewPool = [];
let damageCounterEnabled = true;

// Latest `turn-damage` event, and the value currently drawn (it counts up to
// the event's total rather than jumping).
let turnDamage = null;
let shownDamage = 0;
let damageAnimFrame = null;
let pendingSwapTurnId = null; // new turn waiting for the old total to fold away
const DAMAGE_COUNT_UP_MS = 500;
const TURN_SWAP_MS = 200; // the fold-out third of `td-swap` in style.css
const PREVIEW_DAMAGE = 87412;

const liveCasts = []; // { cast, addedAt, el }
let previewCasts = []; // { cast, addedAt, el }

// Must outlast the `cast-leave` animation in style.css — fallback in case
// animationend never fires (element hidden, animations disabled…).
const LEAVE_FALLBACK_MS = 1000;

function activeCasts() {
  return previewEnabled ? previewCasts : liveCasts;
}

function effectiveCapacity() {
  const horizontal = comboOverlay.dataset.orientation === 'horizontal';
  const classIconSize = iconSize + CLASS_ICON_EXTRA_PX;
  const counter = counterMetrics();
  // Horizontal: icon and counter sit in line with the casts. Vertical (V3):
  // they sit beside the column, but the counter hangs below the newest cast.
  const alongExtra = horizontal
    ? classIconSize + CLASS_ICON_GAP_PX + (damageCounterEnabled ? counter.horizontalWidth + CLASS_ICON_GAP_PX : 0)
    : (damageCounterEnabled ? CLASS_ICON_GAP_PX + counter.verticalHeight : 0);
  const available =
    (horizontal ? window.innerWidth : window.innerHeight) - EDGE_OFFSET_PX * 2 - alongExtra;
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

/** Shows the class of the most recent cast; `animate` replays the swap-in (new cast). */
function updateClassLeadIcon({ animate = false, leaving = false } = {}) {
  const list = activeCasts();
  updateLeadPosition({ leaving });
  if (!list.length) {
    classLeadIcon.classList.remove('visible', 'swap');
    classLeadIcon.innerHTML = '';
    renderTurnDamage();
    return;
  }

  const latestClass = list[list.length - 1].cast.class;
  const explicitClassIcon = list[list.length - 1].cast.classIcon;
  const icon = explicitClassIcon || (latestClass ? classIcons[latestClass] : null);

  classLeadIcon.innerHTML = '';
  classLeadIcon.classList.add('visible');
  renderTurnDamage();
  if (animate) {
    classLeadIcon.classList.remove('swap');
    void classLeadIcon.offsetWidth; // restart the animation
    classLeadIcon.classList.add('swap');
  }

  if (!latestClass || !icon) {
    const placeholder = document.createElement('div');
    placeholder.className = 'placeholder';
    placeholder.textContent = '•';
    classLeadIcon.appendChild(placeholder);
    return;
  }

  const img = document.createElement('img');
  img.src = '/' + icon.replace(/\\/g, '/');
  img.alt = '';
  img.onerror = () => {
    classLeadIcon.innerHTML = '<div class="placeholder">•</div>';
  };
  classLeadIcon.appendChild(img);
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

/** The counter lives and dies with the class icon it's attached to. */
function renderTurnDamage() {
  if (!damageCounterEnabled || !classLeadIcon.classList.contains('visible')) {
    turnDamageEl.hidden = true;
    return;
  }
  turnDamageEl.hidden = false;
  if (previewEnabled) {
    const list = activeCasts();
    setDamageColor(list[list.length - 1]?.cast.color);
    turnDamageEl.classList.remove('idle');
    turnDamageValue.textContent = formatDamage(PREVIEW_DAMAGE);
    return;
  }
  turnDamageEl.classList.toggle('idle', !turnDamage);
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

function applyTurnDamage(event) {
  const previous = turnDamage;
  turnDamage = event;
  if (previewEnabled) return;

  if (previous?.turnId !== event.turnId) {
    const showingPrevious = previous && !turnDamageEl.hidden && !turnDamageEl.classList.contains('idle');
    if (showingPrevious) {
      // The old total folds away first (see `td-swap`), then the new turn's frame comes in.
      pendingSwapTurnId = event.turnId;
      replayClass(turnDamageEl, 'swap');
      setTimeout(() => {
        if (pendingSwapTurnId !== event.turnId) return;
        pendingSwapTurnId = null;
        resetCounterTo(turnDamage);
        countDamageTo(turnDamage.total);
      }, TURN_SWAP_MS);
    } else {
      pendingSwapTurnId = null;
      resetCounterTo(event);
    }
  }
  renderTurnDamage();
  if (pendingSwapTurnId !== null) return;
  countDamageTo(event.total);
  if (event.amount > 0 && damageCounterEnabled) showHitAmount(event.amount);
}

// ── Layout (V3 + counter room) ────────────────────────────────────────────────

/** Mirrors the #turn-damage sizes in style.css (mockup drawn at 48 px icons). */
function counterMetrics() {
  const k = iconSize / 48;
  return {
    k,
    horizontalWidth: 136 * k,
    verticalHeight: 2 * 7 * k + 1.2 * Math.max(8, 10 * k) + 1 + 1.2 * Math.max(10, 15 * k),
    deltaRoom: 6 + 1.2 * 15 * k + 14,
  };
}

function applyCounterLayout() {
  const { k, deltaRoom } = counterMetrics();
  document.documentElement.style.setProperty('--k', k.toFixed(4));
  document.documentElement.style.setProperty('--delta-room', `${Math.ceil(deltaRoom)}px`);
  comboOverlay.dataset.counter = damageCounterEnabled ? 'on' : 'off';
}

/**
 * V3 — vertical lists: the class icon slides to stay level with the newest
 * cast (the last one top-to-bottom; bottom-to-top it is always at the top).
 */
function updateLeadPosition({ leaving = false } = {}) {
  const n = activeCasts().length;
  if (!n) return; // fading out: stay where it was
  const followsDown = comboOverlay.dataset.orientation === 'vertical'
    && comboOverlay.dataset.direction !== 'bottom-to-top';
  const slot = iconSize + ENTRY_CHROME_PX + ENTRY_GAP_PX;
  // A cast folding away takes as long as `cast-leave`; a new one, a quick glide.
  leadWrap.style.setProperty('--lead-move', leaving ? '0.77s ease-in' : '0.3s ease-out');
  leadWrap.style.setProperty('--lead-y', `${followsDown ? (n - 1) * slot : 0}px`);
}

/** Same hero behind both casts — a summon counts as its summoner (same heroName). */
const sameHero = (a, b) => Boolean(a && b) && (a.heroName ?? a.characterName) === (b.heroName ?? b.characterName);

function addLiveCast(cast) {
  const previous = liveCasts[liveCasts.length - 1]?.cast;
  const entry = { cast, addedAt: cast.timestamp || Date.now() };
  liveCasts.push(entry);
  const removed = pruneLiveCasts();
  if (previewEnabled) return;

  // Only the new cast is added and the dropped ones animated out — the rest
  // stay untouched so their own animations aren't restarted.
  if (liveCasts.includes(entry)) {
    entry.el = createCastElement(cast);
    entry.el.classList.add('entering');
    comboLog.appendChild(entry.el);
  }
  for (const old of removed) animateOut(old.el);
  updateEntryStyles();
  // The class icon only swaps in when another hero takes over, not on each cast.
  updateClassLeadIcon({ animate: !sameHero(previous, cast) });
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
}

function rerenderForCurrentMode() {
  if (previewEnabled) {
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
  if (config.classIcons && typeof config.classIcons === 'object') classIcons = config.classIcons;
  if (Array.isArray(config.previewPool)) previewPool = config.previewPool;
  applyCounterLayout();
  rerenderForCurrentMode();
}

setInterval(() => {
  if (previewEnabled) return;
  const removed = pruneLiveCasts();
  if (!removed.length) return;
  for (const old of removed) animateOut(old.el);
  updateEntryStyles();
  // Keep the class icon until the last cast has finished folding away.
  if (!liveCasts.length) {
    setTimeout(() => { if (!liveCasts.length && !previewEnabled) updateClassLeadIcon(); }, LEAVE_FALLBACK_MS);
  } else {
    updateClassLeadIcon({ leaving: true });
  }
}, 500);

window.addEventListener('resize', rerenderForCurrentMode);

// ── SSE connection ────────────────────────────────────────────────────────────

function connect() {
  const source = new EventSource('/events');

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
