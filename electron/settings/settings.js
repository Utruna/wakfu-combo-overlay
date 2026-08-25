'use strict';

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
    label.textContent = `${hero.name} (${hero.characterName})`;

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

  const name = document.getElementById('add-hero-name').value.trim();
  const characterName = document.getElementById('add-hero-character-name').value.trim();
  const color = hexToRgb(document.getElementById('add-hero-color').value);

  const ok = await window.settingsAPI.addHero({ name, characterName, color });
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

async function loadDiagnostics() {
  const diag = await window.settingsAPI.getDiagnostics();
  diagOverlayUrl.textContent = diag.overlayUrl;
  diagLogsDir.textContent = diag.logsDir;
  diagLogsStatus.textContent = diag.logsDirExists ? 'trouvé' : 'introuvable';
  diagLogsStatus.className = diag.logsDirExists ? 'diag-ok' : 'diag-bad';
  diagClients.textContent = diag.overlayClients > 0
    ? `${diag.overlayClients} connecté(s)`
    : 'aucun — OBS (ou le navigateur) n\'est pas connecté à la page overlay';
  diagClients.className = diag.overlayClients > 0 ? 'diag-ok' : 'diag-bad';
}

setInterval(loadDiagnostics, 2000);

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
