'use strict';

const comboLog = document.getElementById('combo-log');

const MAX_VISIBLE_CASTS = 8;
const CAST_LIFETIME_MS  = 6000;

const castEntries = []; // { el, expiresAt }

function addCastEntry(cast) {
  if (!cast.icon) return; // icon-only display — nothing to show without one

  const el = document.createElement('div');
  el.className = 'cast-entry';
  const { r = 120, g = 120, b = 120 } = cast.color || {};
  el.style.setProperty('--cast-r', r);
  el.style.setProperty('--cast-g', g);
  el.style.setProperty('--cast-b', b);

  const img = document.createElement('img');
  img.className = 'cast-icon';
  img.src = '/' + cast.icon.replace(/\\/g, '/');
  img.alt = '';
  img.onerror = () => {
    el.remove();
    const idx = castEntries.findIndex((entry) => entry.el === el);
    if (idx !== -1) castEntries.splice(idx, 1);
  };

  el.appendChild(img);
  comboLog.appendChild(el);
  requestAnimationFrame(() => el.classList.add('visible'));

  castEntries.push({ el, expiresAt: Date.now() + CAST_LIFETIME_MS });
  while (castEntries.length > MAX_VISIBLE_CASTS) castEntries.shift().el.remove();
}

function pruneCastEntries() {
  const now = Date.now();
  while (castEntries.length && castEntries[0].expiresAt <= now) {
    const old = castEntries.shift();
    old.el.classList.add('fading');
    old.el.addEventListener('transitionend', () => old.el.remove(), { once: true });
  }
}
setInterval(pruneCastEntries, 500);

function applyConfig(config) {
  if (config.orientation) comboLog.dataset.orientation = config.orientation;
  if (config.direction) comboLog.dataset.direction = config.direction;
}

// ── SSE connection ────────────────────────────────────────────────────────────

function connect() {
  const source = new EventSource('/events');

  source.addEventListener('cast', (e) => {
    try { addCastEntry(JSON.parse(e.data)); } catch { /* ignore */ }
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
