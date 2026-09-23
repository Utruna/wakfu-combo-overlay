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

const liveCasts = []; // { cast, addedAt }
let previewCasts = []; // { cast, addedAt }

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
      el.innerHTML = '<div class="cast-icon-placeholder">•</div>';
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

function renderActiveCasts({ animateNewest = false } = {}) {
  const list = activeCasts();
  comboLog.innerHTML = '';
  list.forEach((entry, index) => {
    const el = createCastElement(entry.cast);
    comboLog.appendChild(el);
    if (animateNewest && index === list.length - 1) {
      requestAnimationFrame(() => el.classList.add('visible'));
    } else {
      el.classList.add('visible');
    }
  });
  updateClassLeadIcon();
}

function trimModelToCapacity(model) {
  const capacity = effectiveCapacity();
  while (model.length > capacity) model.shift();
}

function pruneLiveCasts() {
  const now = Date.now();
  while (liveCasts.length && liveCasts[0].addedAt + castLifetimeMs <= now) liveCasts.shift();
  trimModelToCapacity(liveCasts);
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

function updateClassLeadIcon() {
  const list = activeCasts();
  if (!list.length) {
    classLeadIcon.classList.remove('visible');
    classLeadIcon.innerHTML = '';
    return;
  }

  const latestClass = list[list.length - 1].cast.class;
  const explicitClassIcon = list[list.length - 1].cast.classIcon;
  const icon = explicitClassIcon || (latestClass ? classIcons[latestClass] : null);

  classLeadIcon.innerHTML = '';
  classLeadIcon.classList.add('visible');

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
  liveCasts.push({ cast, addedAt: cast.timestamp || Date.now() });
  pruneLiveCasts();
  if (previewEnabled) return;
  renderActiveCasts({ animateNewest: true });
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
  const before = liveCasts.length;
  pruneLiveCasts();
  if (before !== liveCasts.length) renderActiveCasts();
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
