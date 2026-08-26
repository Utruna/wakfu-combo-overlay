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
    const row = document.createElement('label');
    row.className = 'hero-row';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = tracked.has(hero.characterName);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) tracked.add(hero.characterName); else tracked.delete(hero.characterName);
      window.settingsAPI.setTrackedHeroes([...tracked]);
      showStatus('Réglages enregistrés');
    });

    const swatch = document.createElement('span');
    swatch.className = 'hero-swatch';
    const { r = 120, g = 120, b = 120 } = hero.color || {};
    swatch.style.background = `rgb(${r}, ${g}, ${b})`;

    const label = document.createElement('span');
    const baseLabel = hero.name && hero.name !== hero.characterName
      ? `${hero.name} (${hero.characterName})`
      : hero.characterName;
    const classLabel = CLASS_LABELS.get(hero.class);
    label.textContent = classLabel ? `${baseLabel} — ${classLabel}` : baseLabel;

    const testBtn = document.createElement('button');
    testBtn.type = 'button';
    testBtn.className = 'test-btn';
    testBtn.textContent = 'Tester';
    testBtn.addEventListener('click', (e) => {
      e.preventDefault();
      window.settingsAPI.sendTestCast(hero.characterName);
    });

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'remove-btn';
    removeBtn.textContent = '✕';
    removeBtn.title = 'Retirer ce héros';
    removeBtn.addEventListener('click', async (e) => {
      e.preventDefault();
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

// Mirrors overlay/style.css: .cast-icon (32px) + .cast-entry padding (4px * 2) + border (2px * 2).
const CAST_ENTRY_BOX_PX = 32 + 4 * 2 + 2 * 2;
const CAST_ENTRY_GAP_PX = 6;
const MAX_VISIBLE_CASTS = 8; // mirrors electron/overlay/client.js

const layoutSizeHint = document.getElementById('layout-size-hint');

function updateLayoutSizeHint(orientation) {
  const along = MAX_VISIBLE_CASTS * CAST_ENTRY_BOX_PX + (MAX_VISIBLE_CASTS - 1) * CAST_ENTRY_GAP_PX;
  const across = CAST_ENTRY_BOX_PX;
  const [width, height] = orientation === 'horizontal' ? [along, across] : [across, along];
  layoutSizeHint.textContent =
    `Taille recommandée pour la source navigateur OBS : ${width} × ${height} px `
    + `(fond transparent — un peu plus large ne pose aucun problème).`;
}

function renderLayout(layout) {
  const orientation = layout?.orientation || 'vertical';
  const direction = layout?.direction || 'top-to-bottom';

  for (const input of orientationField.querySelectorAll('input[name="orientation"]')) {
    input.checked = input.value === orientation;
  }
  for (const input of document.querySelectorAll('input[name="direction"]')) {
    input.checked = input.value === direction;
  }
  updateDirectionVisibility(orientation);
  updateLayoutSizeHint(orientation);
}

function defaultDirectionFor(orientation) {
  return orientation === 'horizontal' ? 'left-to-right' : 'top-to-bottom';
}

orientationField.addEventListener('change', (e) => {
  if (e.target.name !== 'orientation') return;
  const orientation = e.target.value;
  const direction = defaultDirectionFor(orientation);
  updateDirectionVisibility(orientation);
  renderLayout({ orientation, direction });
  window.settingsAPI.setComboLayout({ orientation, direction });
  showStatus('Réglages enregistrés');
});

document.getElementById('direction-field').addEventListener('change', (e) => {
  if (e.target.name !== 'direction') return;
  window.settingsAPI.setComboLayout({ direction: e.target.value });
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

  while (debugLog.children.length > 50) debugLog.removeChild(debugLog.lastChild);
}

document.getElementById('clear-debug-log').addEventListener('click', () => {
  debugLog.innerHTML = '<div class="debug-empty">Aucune activité pour l\'instant.</div>';
});

async function init() {
  const state = await window.settingsAPI.getState();
  renderHeroes(state.heroes, state.trackedCharacterNames);
  renderLayout(state.comboLayout);
  await loadDiagnostics();
  debugLog.innerHTML = '<div class="debug-empty">En attente d\'un sort détecté dans les logs…</div>';
  window.settingsAPI.onDebugEvent(addDebugEntry);
}

init();
