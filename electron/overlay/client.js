'use strict';

const comboLog = document.getElementById('combo-log');

// Hard ceiling on how many casts are kept, whatever the available space.
const MAX_VISIBLE_CASTS = 8;

// Mirrors style.css: .cast-entry padding (4px * 2) + border (2px * 2), and the
// #combo-log gap / edge offset.
const ENTRY_CHROME_PX = 4 * 2 + 2 * 2;
const ENTRY_GAP_PX = 6;
const EDGE_OFFSET_PX = 16;
// .cast-entry enters from translate(12px); an entry still animating in sits
// that much further along the axis, so it must be budgeted for or the last
// one gets clipped by the container's overflow.
const ENTER_OFFSET_PX = 12;

// Overridden by the `config` SSE event (comboLayout.castLifetimeMs / iconSize).
let castLifetimeMs = 6000;
let iconSize = 32;

/**
 * How many entries actually fit along the overlay's axis.
 *
 * The cap can't just be MAX_VISIBLE_CASTS: at a large icon size the list is
 * taller (or wider) than the browser source, and since new casts are appended,
 * it's the newest ones that end up rendered past the edge — the user casts a
 * spell and sees nothing. Trimming to what fits keeps the most recent casts
 * visible, which is the whole point of the overlay.
 */
function visibleCapacity() {
  const horizontal = comboLog.dataset.orientation === 'horizontal';
  const available =
    (horizontal ? window.innerWidth : window.innerHeight) - EDGE_OFFSET_PX * 2 - ENTER_OFFSET_PX;
  const entry = iconSize + ENTRY_CHROME_PX;
  const fits = Math.floor((available + ENTRY_GAP_PX) / (entry + ENTRY_GAP_PX));
  return Math.max(1, Math.min(MAX_VISIBLE_CASTS, fits));
}

const castEntries = []; // { el, addedAt }

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

  // Age from the cast's own timestamp, not from now: on (re)connect the
  // server replays its recent-cast buffer, and those are already old — dating
  // them from the connection would park a wall of stale icons on screen for a
  // full lifetime each time OBS reloads the page.
  castEntries.push({ el, addedAt: cast.timestamp || Date.now() });
  trimToCapacity();
  pruneCastEntries();
}

// Mirrors the .cast-entry transition in style.css.
const FADE_MS = 250;

/**
 * Fade an entry out, then drop it from the DOM.
 *
 * `transitionend` alone isn't enough: a background tab (an OBS browser source
 * that isn't being rendered, say) doesn't run CSS transitions, so the event
 * never fires and the nodes pile up forever. The timer is the guarantee; the
 * event just removes it promptly when the animation did play.
 */
function removeEntryElement(el) {
  el.classList.add('fading');
  let done = false;
  const drop = () => {
    if (done) return;
    done = true;
    el.remove();
  };
  el.addEventListener('transitionend', drop, { once: true });
  setTimeout(drop, FADE_MS + 50);
}

/** Drop the oldest entries until the rest fit on screen. */
function trimToCapacity() {
  const capacity = visibleCapacity();
  while (castEntries.length > capacity) castEntries.shift().el.remove();
}

// Expiry is derived from `addedAt` on each pass rather than stored per entry,
// so changing the duration also re-times the casts already on screen.
function pruneCastEntries() {
  const now = Date.now();
  while (castEntries.length && castEntries[0].addedAt + castLifetimeMs <= now) {
    removeEntryElement(castEntries.shift().el);
  }
}
setInterval(pruneCastEntries, 500);

// The browser source can be resized after the page loads.
window.addEventListener('resize', trimToCapacity);

function applyConfig(config) {
  if (config.orientation) comboLog.dataset.orientation = config.orientation;
  if (config.direction) comboLog.dataset.direction = config.direction;
  if (config.iconSize) {
    iconSize = config.iconSize;
    document.documentElement.style.setProperty('--icon-size', `${iconSize}px`);
    trimToCapacity(); // a bigger icon means fewer of them fit
  }
  if (config.castLifetimeMs) {
    castLifetimeMs = config.castLifetimeMs;
    pruneCastEntries(); // a shortened duration may already have expired entries
  }
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
