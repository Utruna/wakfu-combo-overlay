'use strict';

const CLASSES = [
  ['feca', 'Féca'], ['osamodas', 'Osamodas'], ['enutrof', 'Enutrof'], ['sram', 'Sram'],
  ['xelor', 'Xélor'], ['ecaflip', 'Ecaflip'], ['eniripsa', 'Eniripsa'], ['iop', 'Iop'],
  ['cra', 'Cra'], ['sadida', 'Sadida'], ['sacrieur', 'Sacrieur'], ['pandawa', 'Pandawa'],
  ['roublard', 'Roublard'], ['zobal', 'Zobal'], ['ouginak', 'Ouginak'], ['steamer', 'Steamer'],
  ['eliotrope', 'Eliotrope'], ['huppermage', 'Huppermage'],
];

const CLASS_LABELS = new Map(CLASSES);

const addHeroClassSelect = document.getElementById('add-hero-class');
for (const [slug, label] of CLASSES) {
  const option = document.createElement('option');
  option.value = slug;
  option.textContent = label;
  addHeroClassSelect.appendChild(option);
}

const heroList = document.getElementById('hero-list');
const statusEl = document.getElementById('status');
const orientationField = document.getElementById('orientation-field');
const directionVertical = document.getElementById('direction-vertical');
const directionHorizontal = document.getElementById('direction-horizontal');
const iconSizeInput = document.getElementById('icon-size');
const iconSizeValue = document.getElementById('icon-size-value');
const castLifetimeInput = document.getElementById('cast-lifetime');
const castLifetimeValue = document.getElementById('cast-lifetime-value');

// Overwritten by the main process's authoritative ranges on init (see
// `iconSizeRange` / `castLifetimeRange` in settings:getState); the markup
// values are only the fallback for the brief moment before that resolves.
let defaultIconSize = Number(iconSizeInput.value) || 32;
let defaultCastLifetimeMs = Number(castLifetimeInput.value) * 1000 || 6000;

// The slider is in seconds — milliseconds are an awkward thing to drag.
function formatLifetime(ms) {
  const seconds = ms / 1000;
  return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)} s`;
}

let showStatusTimer = null;
function showStatus(text) {
  statusEl.textContent = text;
  clearTimeout(showStatusTimer);
  showStatusTimer = setTimeout(() => { statusEl.textContent = ''; }, 1500);
}

function renderHeroes(heroes, trackedCharacterNames) {
  heroList.innerHTML = '';
  const tracked = new Set(trackedCharacterNames);

  heroes.forEach((hero) => {
    // A plain div, not a <label> — wrapping the whole row in a label makes
    // ANY click inside it (padding, the color swatch, gaps between buttons)
    // toggle the checkbox. Only the checkbox itself and the name text should
    // do that, so the checkbox stays natively clickable and the name gets an
    // explicit click handler below instead of relying on label-forwarding.
    const row = document.createElement('div');
    row.className = 'hero-row';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = tracked.has(hero.characterName);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) tracked.add(hero.characterName); else tracked.delete(hero.characterName);
      window.settingsAPI.setTrackedHeroes([...tracked]);
      showStatus('Réglages enregistrés');
    });

    const swatch = document.createElement('input');
    swatch.type = 'color';
    swatch.className = 'hero-swatch';
    swatch.title = 'Changer la couleur';
    swatch.value = rgbToHex(hero.color);
    swatch.addEventListener('change', async () => {
      await window.settingsAPI.setHeroColor(hero.characterName, hexToRgb(swatch.value));
      showStatus('Couleur mise à jour');
    });

    const label = document.createElement('span');
    label.className = 'hero-label';
    const baseLabel = hero.name && hero.name !== hero.characterName
      ? `${hero.name} (${hero.characterName})`
      : hero.characterName;
    const classLabel = CLASS_LABELS.get(hero.class);
    label.textContent = classLabel ? `${baseLabel} — ${classLabel}` : baseLabel;
    label.addEventListener('click', () => {
      checkbox.checked = !checkbox.checked;
      checkbox.dispatchEvent(new Event('change'));
    });

    const testBtn = document.createElement('button');
    testBtn.type = 'button';
    testBtn.className = 'test-btn';
    testBtn.textContent = 'Tester';
    testBtn.addEventListener('click', () => {
      window.settingsAPI.sendTestCast(hero.characterName);
    });

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'remove-btn';
    removeBtn.textContent = '✕';
    removeBtn.title = 'Retirer ce héros';
    removeBtn.addEventListener('click', async () => {
      await window.settingsAPI.removeHero(hero.characterName);
      await refreshHeroes();
      showStatus('Héros retiré');
    });

    row.append(checkbox, swatch, label, testBtn, removeBtn);
    heroList.appendChild(row);
  });
}

async function refreshHeroes() {
  const state = await window.settingsAPI.getState();
  renderHeroes(state.heroes, state.trackedCharacterNames);
}

// ── Add hero form ────────────────────────────────────────────────────────────

function hexToRgb(hex) {
  const match = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!match) return { r: 120, g: 120, b: 120 };
  return { r: parseInt(match[1], 16), g: parseInt(match[2], 16), b: parseInt(match[3], 16) };
}

function rgbToHex({ r = 120, g = 120, b = 120 } = {}) {
  const toHex = (n) => Math.max(0, Math.min(255, Number(n) || 0)).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

const addHeroForm = document.getElementById('add-hero-form');
const addHeroError = document.getElementById('add-hero-error');

addHeroForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  addHeroError.textContent = '';

  const characterName = document.getElementById('add-hero-character-name').value.trim();
  const heroClass = addHeroClassSelect.value;
  const color = hexToRgb(document.getElementById('add-hero-color').value);

  if (!heroClass) {
    addHeroError.textContent = 'Choisis une classe.';
    return;
  }

  const ok = await window.settingsAPI.addHero({ characterName, color, class: heroClass });
  if (!ok) {
    addHeroError.textContent = 'Ce nom de personnage existe déjà (ou est vide).';
    return;
  }

  addHeroForm.reset();
  document.getElementById('add-hero-color').value = '#4a90e2';
  await refreshHeroes();
  showStatus('Héros ajouté');
});

function updateDirectionVisibility(orientation) {
  directionVertical.classList.toggle('active', orientation === 'vertical');
  directionHorizontal.classList.toggle('active', orientation === 'horizontal');
}

// Mirrors overlay/style.css: .cast-entry padding (4px * 2) + border (2px * 2)
// around the icon itself.
const CAST_ENTRY_CHROME_PX = 4 * 2 + 2 * 2;
const CAST_ENTRY_GAP_PX = 6;
const MAX_VISIBLE_CASTS = 8; // mirrors electron/overlay/client.js

const layoutSizeHint = document.getElementById('layout-size-hint');

function updateLayoutSizeHint(orientation, iconSize) {
  const box = iconSize + CAST_ENTRY_CHROME_PX;
  const along = MAX_VISIBLE_CASTS * box + (MAX_VISIBLE_CASTS - 1) * CAST_ENTRY_GAP_PX;
  const across = box;
  const [width, height] = orientation === 'horizontal' ? [along, across] : [across, along];
  layoutSizeHint.textContent =
    `Taille recommandée pour la source navigateur OBS : ${width} × ${height} px `
    + `(fond transparent — un peu plus large ne pose aucun problème).`;
}

function renderLayout(layout) {
  const orientation = layout?.orientation || 'vertical';
  const direction = layout?.direction || 'top-to-bottom';
  const iconSize = layout?.iconSize || defaultIconSize;
  const castLifetimeMs = layout?.castLifetimeMs || defaultCastLifetimeMs;

  for (const input of orientationField.querySelectorAll('input[name="orientation"]')) {
    input.checked = input.value === orientation;
  }
  for (const input of document.querySelectorAll('input[name="direction"]')) {
    input.checked = input.value === direction;
  }
  iconSizeInput.value = iconSize;
  iconSizeValue.textContent = `${iconSize} px`;
  castLifetimeInput.value = castLifetimeMs / 1000;
  castLifetimeValue.textContent = formatLifetime(castLifetimeMs);
  updateDirectionVisibility(orientation);
  updateLayoutSizeHint(orientation, iconSize);
}

function defaultDirectionFor(orientation) {
  return orientation === 'horizontal' ? 'left-to-right' : 'top-to-bottom';
}

orientationField.addEventListener('change', (e) => {
  if (e.target.name !== 'orientation') return;
  const orientation = e.target.value;
  const direction = defaultDirectionFor(orientation);
  updateDirectionVisibility(orientation);
  // Carry the current slider values through, so re-rendering doesn't snap
  // them back to the defaults.
  renderLayout({
    orientation,
    direction,
    iconSize: Number(iconSizeInput.value),
    castLifetimeMs: Number(castLifetimeInput.value) * 1000,
  });
  window.settingsAPI.setComboLayout({ orientation, direction });
  showStatus('Réglages enregistrés');
});

document.getElementById('direction-field').addEventListener('change', (e) => {
  if (e.target.name !== 'direction') return;
  window.settingsAPI.setComboLayout({ direction: e.target.value });
  showStatus('Réglages enregistrés');
});

// `input` keeps the label and the OBS size hint live while dragging; the
// setting itself is only persisted/broadcast on `change` (pointer release),
// so a drag doesn't write the file once per pixel.
iconSizeInput.addEventListener('input', () => {
  const iconSize = Number(iconSizeInput.value);
  const orientation = orientationField.querySelector('input[name="orientation"]:checked')?.value || 'vertical';
  iconSizeValue.textContent = `${iconSize} px`;
  updateLayoutSizeHint(orientation, iconSize);
});

iconSizeInput.addEventListener('change', () => {
  window.settingsAPI.setComboLayout({ iconSize: Number(iconSizeInput.value) });
  showStatus('Réglages enregistrés');
});

castLifetimeInput.addEventListener('input', () => {
  castLifetimeValue.textContent = formatLifetime(Number(castLifetimeInput.value) * 1000);
});

castLifetimeInput.addEventListener('change', () => {
  window.settingsAPI.setComboLayout({ castLifetimeMs: Number(castLifetimeInput.value) * 1000 });
  showStatus('Réglages enregistrés');
});

// ── Diagnostics ────────────────────────────────────────────────────────────

const diagOverlayUrl = document.getElementById('diag-overlay-url');
const diagLogsDir = document.getElementById('diag-logs-dir');
const diagLogsStatus = document.getElementById('diag-logs-status');
const diagClients = document.getElementById('diag-clients');
const debugLog = document.getElementById('debug-log');

let currentOverlayUrl = '';

async function loadDiagnostics() {
  const diag = await window.settingsAPI.getDiagnostics();
  currentOverlayUrl = diag.overlayUrl;
  diagOverlayUrl.textContent = diag.overlayUrl;
  diagLogsDir.textContent = diag.logsDir;
  diagLogsStatus.textContent = diag.logsDirExists ? 'trouvé' : 'introuvable';
  diagLogsStatus.className = diag.logsDirExists ? 'diag-ok' : 'diag-bad';
  diagClients.textContent = diag.overlayClients > 0
    ? `${diag.overlayClients} connecté(s)`
    : 'aucun — OBS (ou le navigateur) n\'est pas connecté à la page overlay';
  diagClients.className = diag.overlayClients > 0 ? 'diag-ok' : 'diag-bad';

  // Don't clobber what the user is actively typing.
  if (document.activeElement !== overlayPortInput) {
    overlayPortInput.value = diag.overlayPort;
  }
  if (document.activeElement !== logsDirInput) {
    logsDirInput.value = diag.logsDir;
  }
}

setInterval(loadDiagnostics, 2000);

// ── Click-to-copy overlay URL ───────────────────────────────────────────────

diagOverlayUrl.addEventListener('click', async () => {
  if (!currentOverlayUrl) return;
  try {
    await navigator.clipboard.writeText(currentOverlayUrl);
    showStatus('URL copiée');
  } catch {
    showStatus('Impossible de copier');
  }
});

// ── Overlay port ─────────────────────────────────────────────────────────────

const overlayPortInput = document.getElementById('overlay-port-input');
const overlayPortError = document.getElementById('overlay-port-error');

document.getElementById('overlay-port-apply').addEventListener('click', async () => {
  overlayPortError.textContent = '';
  const result = await window.settingsAPI.setOverlayPort(overlayPortInput.value);
  if (!result.ok) {
    overlayPortError.textContent = result.error || 'Port invalide.';
    return;
  }
  showStatus('Port changé — pense à mettre à jour l\'URL dans OBS');
  await loadDiagnostics();
});

// ── Logs directory ───────────────────────────────────────────────────────────

const logsDirInput = document.getElementById('logs-dir-input');
const logsDirError = document.getElementById('logs-dir-error');

document.getElementById('logs-dir-browse').addEventListener('click', async () => {
  const picked = await window.settingsAPI.browseLogsDir();
  if (picked) logsDirInput.value = picked;
});

document.getElementById('logs-dir-apply').addEventListener('click', async () => {
  logsDirError.textContent = '';
  const result = await window.settingsAPI.setLogsDir(logsDirInput.value);
  if (!result.ok) {
    logsDirError.textContent = result.error || 'Chemin invalide.';
    return;
  }
  showStatus('Dossier de logs changé');
  await loadDiagnostics();
});

const MAX_DEBUG_ENTRIES = 50;

const DEBUG_LABELS = {
  broadcast: 'Envoyé à l\'overlay',
  'ignored-untracked': 'Ignoré (héros non suivi)',
  'ignored-unmatched': 'Ignoré (joueur/mob inconnu)',
  test: 'Test manuel',
};

function addDebugEntry(entry) {
  const empty = debugLog.querySelector('.debug-empty');
  if (empty) empty.remove();

  const el = document.createElement('div');
  el.className = `debug-entry ${entry.status}`;
  const time = new Date(entry.timestamp).toLocaleTimeString('fr-FR');
  const who = entry.heroName ? `${entry.characterName} (${entry.heroName})` : entry.characterName;
  el.textContent = `[${time}] ${DEBUG_LABELS[entry.status] ?? entry.status} — ${who}${entry.spellName ? ' : ' + entry.spellName : ''}`;
  debugLog.prepend(el);

  while (debugLog.children.length > MAX_DEBUG_ENTRIES) debugLog.removeChild(debugLog.lastChild);
}

document.getElementById('clear-debug-log').addEventListener('click', () => {
  debugLog.innerHTML = '<div class="debug-empty">Aucune activité pour l\'instant.</div>';
});

// ── Mises à jour ─────────────────────────────────────────────────────────

const updateVersionEl = document.getElementById('update-version');
const updateStatusEl = document.getElementById('update-status');
const updateCheckBtn = document.getElementById('update-check-btn');

const UPDATE_STATUS_LABELS = {
  checking: 'Recherche en cours…',
  available: (p) => `Nouvelle version disponible : v${p.version}`,
  'not-available': 'À jour.',
  downloading: (p) => `Téléchargement… ${Math.round(p.percent || 0)}%`,
  downloaded: (p) => `Prêt à installer (v${p.version}) — redémarre l'application.`,
  error: (p) => `Erreur : ${p.message || 'inconnue'}`,
};

function renderUpdateStatus(payload) {
  const label = UPDATE_STATUS_LABELS[payload.status];
  updateStatusEl.textContent = typeof label === 'function' ? label(payload) : (label || '—');
  updateCheckBtn.disabled = payload.status === 'checking' || payload.status === 'downloading';
}

updateCheckBtn.addEventListener('click', () => window.settingsAPI.checkForUpdates());
window.settingsAPI.onUpdateStatus(renderUpdateStatus);

function applyIconSizeRange(range) {
  if (!range) return;
  iconSizeInput.min = range.min;
  iconSizeInput.max = range.max;
  defaultIconSize = range.default;
}

function applyCastLifetimeRange(range) {
  if (!range) return;
  castLifetimeInput.min = range.min / 1000;
  castLifetimeInput.max = range.max / 1000;
  defaultCastLifetimeMs = range.default;
}

async function init() {
  const state = await window.settingsAPI.getState();
  renderHeroes(state.heroes, state.trackedCharacterNames);
  applyIconSizeRange(state.iconSizeRange);
  applyCastLifetimeRange(state.castLifetimeRange);
  renderLayout(state.comboLayout);
  await loadDiagnostics();
  debugLog.innerHTML = '<div class="debug-empty">En attente d\'un sort détecté dans les logs…</div>';
  window.settingsAPI.onDebugEvent(addDebugEntry);
  updateVersionEl.textContent = `v${await window.settingsAPI.getAppVersion()}`;
}

init();
