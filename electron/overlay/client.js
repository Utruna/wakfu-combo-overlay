'use strict';

const comboLog = document.getElementById('combo-log');
const comboOverlay = document.getElementById('combo-overlay');
const classLeadIcon = document.getElementById('class-lead-icon');

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
  const alongExtra = classIconSize + CLASS_ICON_GAP_PX;
  const available =
    (horizontal ? window.innerWidth : window.innerHeight) - EDGE_OFFSET_PX * 2 - alongExtra;
  const entry = iconSize + ENTRY_CHROME_PX;
  const fits = Math.floor((available + ENTRY_GAP_PX) / (entry + ENTRY_GAP_PX));
  return Math.max(1, Math.min(maxVisibleCasts, fits));
}

function createCastElement(cast) {
  const el = document.createElement('div');
  el.className = 'cast-entry';
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
function updateClassLeadIcon({ animate = false } = {}) {
  const list = activeCasts();
  if (!list.length) {
    classLeadIcon.classList.remove('visible', 'swap');
    classLeadIcon.innerHTML = '';
    return;
  }

  const latestClass = list[list.length - 1].cast.class;
  const explicitClassIcon = list[list.length - 1].cast.classIcon;
  const icon = explicitClassIcon || (latestClass ? classIcons[latestClass] : null);

  classLeadIcon.innerHTML = '';
  classLeadIcon.classList.add('visible');
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

function addLiveCast(cast) {
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
  updateClassLeadIcon({ animate: true });
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
  if (config.classIcons && typeof config.classIcons === 'object') classIcons = config.classIcons;
  if (Array.isArray(config.previewPool)) previewPool = config.previewPool;
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
    updateClassLeadIcon();
  }
}, 500);

window.addEventListener('resize', rerenderForCurrentMode);

// ── SSE connection ────────────────────────────────────────────────────────────

function connect() {
  const source = new EventSource('/events');

  source.addEventListener('cast', (e) => {
    try { addLiveCast(JSON.parse(e.data)); } catch { /* ignore */ }
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
