'use strict';

const api = window.settingsAPI;

const CLASSES = [
  ['feca', 'Féca'], ['osamodas', 'Osamodas'], ['enutrof', 'Enutrof'], ['sram', 'Sram'],
  ['xelor', 'Xélor'], ['ecaflip', 'Ecaflip'], ['eniripsa', 'Eniripsa'], ['iop', 'Iop'],
  ['cra', 'Cra'], ['sadida', 'Sadida'], ['sacrieur', 'Sacrieur'], ['pandawa', 'Pandawa'],
  ['roublard', 'Roublard'], ['zobal', 'Zobal'], ['ouginak', 'Ouginak'], ['steamer', 'Steamer'],
  ['eliotrope', 'Eliotrope'], ['huppermage', 'Huppermage'],
].sort((a, b) => a[1].localeCompare(b[1], 'fr'));

const CLASS_LABELS = new Map(CLASSES);

const PALETTE = ['#4a90e2', '#43d1c1', '#22c55e', '#facc15', '#f2994a', '#e53935', '#d946ef', '#9b8cff'];

const LAYOUTS = [
  { id: 'h-fwd', orientation: 'horizontal', direction: 'left-to-right', label: 'Horizontal', sub: 'gauche → droite', flex: 'row' },
  { id: 'h-rev', orientation: 'horizontal', direction: 'right-to-left', label: 'Horizontal', sub: 'droite → gauche', flex: 'row-reverse' },
  { id: 'v-fwd', orientation: 'vertical', direction: 'top-to-bottom', label: 'Vertical', sub: 'haut → bas', flex: 'column' },
  { id: 'v-rev', orientation: 'vertical', direction: 'bottom-to-top', label: 'Vertical', sub: 'bas → haut', flex: 'column-reverse' },
];

// Mirrors electron/overlay/style.css + client.js: .cast-entry padding (4px * 2)
// + border (2px * 2) around the icon, the gap between entries, the wrapper's
// offset from the page edge, and the class icon (icon size + 12px) with its gap.
const ENTRY_CHROME_PX = 4 * 2 + 2 * 2;
const ENTRY_GAP_PX = 6;
const EDGE_OFFSET_PX = 16;
const CLASS_ICON_GAP_PX = 8;
const CLASS_ICON_EXTRA_PX = 12;

// The page lives in electron/settings/, the icons in <root>/assets/.
const ASSET_PREFIX = '../../';

const $ = (id) => document.getElementById(id);

const state = {
  heroes: [],
  tracked: new Set(),
  layout: {},
  maxVisibleRange: { min: 1, max: 20 },
  classIcons: {},
  previewPool: [],
  diag: null,
  editing: null, // characterName being edited, NEW_HERO for the add form, or null
  draft: null, // { characterName, class, color } while the edit form is open
};

const NEW_HERO = Symbol('new-hero');

// ── Helpers ──────────────────────────────────────────────────────────────

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key === 'style') node.style.cssText = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) {
    if (child !== null && child !== undefined) node.append(child);
  }
  return node;
}

function svg(markup, size = 16, extra = '') {
  const wrap = document.createElement('span');
  wrap.style.display = 'contents';
  wrap.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true" ${extra}>${markup}</svg>`;
  return wrap.firstChild;
}

function hexToRgb(hex) {
  const match = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!match) return { r: 120, g: 120, b: 120 };
  return { r: parseInt(match[1], 16), g: parseInt(match[2], 16), b: parseInt(match[3], 16) };
}

function rgbToHex({ r = 120, g = 120, b = 120 } = {}) {
  const toHex = (n) => Math.max(0, Math.min(255, Number(n) || 0)).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function assetUrl(relPath) {
  return relPath ? ASSET_PREFIX + relPath.replace(/\\/g, '/') : null;
}

function classEmblem(heroClass) {
  return assetUrl(state.classIcons[heroClass]);
}

function formatLifetime(ms) {
  const seconds = ms / 1000;
  return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)} s`;
}

function formatAgo(timestamp) {
  if (!timestamp) return 'aucun pour l\'instant';
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `il y a ${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `il y a ${minutes} min`;
  return `il y a ${Math.round(minutes / 60)} h`;
}

async function copyText(text, button) {
  try {
    await navigator.clipboard.writeText(text);
    if (button) {
      button.textContent = 'Copié';
      button.classList.add('copied');
      clearTimeout(button._copiedTimer);
      button._copiedTimer = setTimeout(() => {
        button.textContent = 'Copier';
        button.classList.remove('copied');
      }, 1500);
    }
  } catch {
    showToast('Impossible de copier.', { error: true });
  }
}

function setSwitch(button, on) {
  button.setAttribute('aria-checked', on ? 'true' : 'false');
}

function setSegmented(container, value, attr = 'aria-pressed') {
  for (const button of container.querySelectorAll('button')) {
    button.setAttribute(attr, button.dataset.value === value ? 'true' : 'false');
  }
}

// ── Toast ────────────────────────────────────────────────────────────────

let toastTimer = null;
let toastUndo = null;

function showToast(text, { undo = null, error = false, duration } = {}) {
  $('toast-text').textContent = text;
  $('toast').classList.toggle('error', error);
  $('toast-undo').hidden = !undo;
  toastUndo = undo;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, duration ?? (undo ? 8000 : 2500));
}

function hideToast() {
  $('toast').hidden = true;
  toastUndo = null;
  clearTimeout(toastTimer);
}

$('toast-close').addEventListener('click', hideToast);
$('toast-undo').addEventListener('click', async () => {
  const undo = toastUndo;
  hideToast();
  if (undo) await undo();
});

// ── Navigation ───────────────────────────────────────────────────────────

const VIEWS = ['heros', 'affichage', 'obs'];

function showView(name) {
  const view = VIEWS.includes(name) ? name : 'heros';
  for (const v of VIEWS) $(`view-${v}`).hidden = v !== view;
  for (const link of document.querySelectorAll('.nav-link')) {
    link.setAttribute('aria-current', link.dataset.view === view ? 'page' : 'false');
  }
  if (view === 'affichage') renderPreview();
}

window.addEventListener('hashchange', () => showView(location.hash.slice(1)));

// ── Héros ────────────────────────────────────────────────────────────────

async function refreshHeroes() {
  const s = await api.getState();
  state.heroes = s.heroes;
  state.tracked = new Set(s.trackedCharacterNames);
  renderHeroes();
  renderPreview();
}

function avatarFor(hero) {
  const emblem = classEmblem(hero.class);
  const initials = (CLASS_LABELS.get(hero.class) || hero.characterName || '?').slice(0, 2);
  const avatar = el('div', { class: 'avatar', 'aria-hidden': 'true', style: `--ring: ${rgbToHex(hero.color)}` });
  if (emblem) {
    const img = el('img', { src: emblem, alt: '' });
    img.onerror = () => { avatar.textContent = initials; };
    avatar.append(img);
  } else {
    avatar.textContent = initials;
  }
  return avatar;
}

function heroRow(hero) {
  const active = state.tracked.has(hero.characterName);
  const classLabel = CLASS_LABELS.get(hero.class) || 'Classe inconnue';
  const alias = hero.name && hero.name !== hero.characterName ? ` · ${hero.name}` : '';

  const toggle = el('button', {
    type: 'button', class: 'switch', role: 'switch',
    'aria-checked': active ? 'true' : 'false',
    'aria-label': `Suivre ${hero.characterName}`,
    onclick: () => {
      if (active) state.tracked.delete(hero.characterName); else state.tracked.add(hero.characterName);
      api.setTrackedHeroes([...state.tracked]);
      renderHeroes();
      renderPreview();
    },
  }, el('span'));

  return el('li', {}, el('div', { class: `hero-row${active ? '' : ' paused'}` }, [
    toggle,
    el('div', { class: 'hero-main' }, [
      avatarFor(hero),
      el('div', { class: 'hero-text' }, [
        el('span', { class: 'hero-name', text: hero.characterName, title: hero.characterName }),
        el('span', { class: 'hero-meta', text: `${classLabel} · ${active ? 'suivi' : 'en pause'}${alias}` }),
      ]),
    ]),
    el('button', {
      type: 'button', class: 'btn row',
      title: 'Envoyer un sort factice de ce héros à l\'overlay',
      onclick: () => api.sendTestCast(hero.characterName),
    }, [svg('<path d="M6 4l14 8-14 8z" fill="currentColor"/>', 12), el('span', { text: 'Tester' })]),
    el('button', {
      type: 'button', class: 'icon-btn', 'aria-label': `Modifier ${hero.characterName}`, title: 'Modifier',
      onclick: () => openEditor(hero),
    }, svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>', 16,
      'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"')),
    el('button', {
      type: 'button', class: 'icon-btn', 'aria-label': `Retirer ${hero.characterName}`, title: 'Retirer',
      onclick: () => removeHero(hero),
    }, svg('<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/>', 16,
      'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"')),
  ]));
}

function heroEditor() {
  const draft = state.draft;
  const isNew = state.editing === NEW_HERO;
  const idSuffix = isNew ? 'new' : 'edit';

  const nameInput = el('input', {
    id: `name-${idSuffix}`, type: 'text', class: 'input', placeholder: 'ex. Lueur Ocre', spellcheck: 'false',
  });
  nameInput.value = draft.characterName;
  nameInput.addEventListener('input', () => { draft.characterName = nameInput.value; });

  const classSelect = el('select', { id: `cls-${idSuffix}`, class: 'input' }, [
    el('option', { value: '', text: 'Choisir…' }),
    ...CLASSES.map(([slug, label]) => el('option', { value: slug, text: label })),
  ]);
  classSelect.value = draft.class || '';
  classSelect.addEventListener('change', () => { draft.class = classSelect.value; });

  const error = el('p', { class: 'error' });

  const currentHex = draft.color.toLowerCase();
  const isCustom = !PALETTE.includes(currentHex);
  const swatches = PALETTE.map((c) => el('button', {
    type: 'button', class: 'swatch', style: `--c: ${c}`,
    'aria-label': `Couleur ${c}`, 'aria-pressed': c === currentHex ? 'true' : 'false',
    onclick: () => pickColor(c),
  }));
  const custom = el('button', {
    type: 'button', class: 'swatch custom', style: isCustom ? `--c: ${currentHex}` : null,
    'aria-label': 'Couleur personnalisée', title: 'Couleur personnalisée',
    'aria-pressed': isCustom ? 'true' : 'false',
    onclick: () => {
      const input = $('custom-color-input');
      input.value = draft.color;
      input.onchange = () => pickColor(input.value);
      input.click();
    },
  }, svg('<path d="M12 5v14M5 12h14"/>', 12, 'fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"'));

  async function save() {
    error.textContent = '';
    const characterName = draft.characterName.trim();
    if (!characterName) { error.textContent = 'Indique le nom exact du personnage.'; nameInput.focus(); return; }
    if (!draft.class) { error.textContent = 'Choisis une classe.'; classSelect.focus(); return; }

    if (isNew) {
      const ok = await api.addHero({ characterName, class: draft.class, color: hexToRgb(draft.color) });
      if (!ok) { error.textContent = 'Ce nom de personnage existe déjà.'; return; }
    } else {
      const ok = await api.updateHero(state.editing, { characterName, class: draft.class });
      if (!ok) { error.textContent = 'Ce nom de personnage existe déjà.'; return; }
    }
    closeEditor();
    await refreshHeroes();
  }

  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });

  return el('li', {}, el('div', { class: 'hero-edit' }, [
    el('div', { class: 'hero-edit-grid' }, [
      el('div', { class: 'field tight' }, [
        el('label', { for: `name-${idSuffix}`, class: 'sub-label', text: 'Nom du personnage (exact, comme dans les logs)' }),
        nameInput,
      ]),
      el('div', { class: 'field tight' }, [
        el('label', { for: `cls-${idSuffix}`, class: 'sub-label', text: 'Classe' }),
        el('div', { class: 'select-wrap' }, [
          classSelect,
          svg('<path d="m6 9 6 6 6-6"/>', 16, 'fill="none" stroke="#a0b0b7" stroke-width="2" stroke-linecap="round"'),
        ]),
      ]),
    ]),
    error,
    el('div', { class: 'hero-edit-foot' }, [
      el('div', { class: 'swatches', role: 'group', 'aria-label': 'Couleur' }, [
        el('span', { class: 'sub-label', text: 'Couleur', style: 'margin-right: 4px' }),
        ...swatches,
        custom,
      ]),
      el('div', { class: 'hero-edit-actions' }, [
        el('button', { type: 'button', class: 'btn ghost done', text: 'Annuler', onclick: () => { closeEditor(); renderHeroes(); } }),
        el('button', { type: 'button', class: 'btn primary done', text: isNew ? 'Ajouter' : 'Terminé', onclick: save }),
      ]),
    ]),
  ]));
}

async function pickColor(hex) {
  state.draft.color = hex;
  // Color changes on an existing hero apply right away, like the rest of the page.
  if (state.editing !== NEW_HERO) {
    await api.setHeroColor(state.editing, hexToRgb(hex));
    const hero = state.heroes.find((h) => h.characterName === state.editing);
    if (hero) hero.color = hexToRgb(hex);
    renderPreview();
  }
  const focused = document.activeElement?.id;
  renderHeroes();
  if (focused) $(focused)?.focus();
}

function openEditor(hero) {
  if (hero) {
    state.editing = hero.characterName;
    state.draft = { characterName: hero.characterName, class: hero.class || '', color: rgbToHex(hero.color) };
  } else {
    const used = new Set(state.heroes.map((h) => rgbToHex(h.color)));
    state.editing = NEW_HERO;
    state.draft = { characterName: '', class: '', color: PALETTE.find((c) => !used.has(c)) || PALETTE[0] };
  }
  renderHeroes();
  $(hero ? 'name-edit' : 'name-new')?.focus();
}

function closeEditor() {
  state.editing = null;
  state.draft = null;
}

async function removeHero(hero) {
  const index = state.heroes.findIndex((h) => h.characterName === hero.characterName);
  const wasTracked = state.tracked.has(hero.characterName);
  await api.removeHero(hero.characterName);
  if (state.editing === hero.characterName) closeEditor();
  await refreshHeroes();
  const classLabel = CLASS_LABELS.get(hero.class);
  showToast(`« ${hero.characterName}${classLabel ? ` — ${classLabel}` : ''} » a été retiré de la liste.`, {
    undo: async () => {
      await api.addHero(hero, { index, tracked: wasTracked });
      await refreshHeroes();
    },
  });
}

function renderHeroes() {
  const list = $('hero-list');
  list.innerHTML = '';
  if (state.editing === NEW_HERO) list.append(heroEditor());
  for (const hero of state.heroes) {
    list.append(hero.characterName === state.editing ? heroEditor() : heroRow(hero));
  }
  if (!state.heroes.length && state.editing !== NEW_HERO) {
    list.append(el('li', { class: 'empty-state', text: 'Aucun personnage pour l\'instant — ajoute le tien avec « Ajouter un héros » (nom exact en jeu).' }));
  }
}

$('add-hero-btn').addEventListener('click', () => openEditor(null));

// ── Affichage ────────────────────────────────────────────────────────────

function layoutId(layout) {
  return LAYOUTS.find((l) => l.orientation === layout.orientation && l.direction === layout.direction)?.id || 'v-fwd';
}

/** Size of the OBS browser source that fits the whole overlay (matches the preview box). */
function overlaySize(layout = state.layout) {
  const n = layout.maxVisibleCasts || 8;
  const icon = layout.iconSize || 32;
  const entry = icon + ENTRY_CHROME_PX;
  const lead = icon + CLASS_ICON_EXTRA_PX;
  const logLen = n * entry + (n - 1) * ENTRY_GAP_PX;
  const horizontal = layout.orientation === 'horizontal';
  const width = EDGE_OFFSET_PX * 2 + lead + CLASS_ICON_GAP_PX + (horizontal ? logLen : entry);
  const height = EDGE_OFFSET_PX * 2 + (horizontal ? Math.max(entry, lead) : Math.max(logLen, lead));
  return { width, height };
}

function renderLayoutPicker() {
  const picker = $('layout-picker');
  picker.innerHTML = '';
  const current = layoutId(state.layout);
  for (const def of LAYOUTS) {
    picker.append(el('button', {
      type: 'button', class: 'layout-option', 'aria-pressed': def.id === current ? 'true' : 'false',
      onclick: () => {
        state.layout = { ...state.layout, orientation: def.orientation, direction: def.direction };
        api.setComboLayout({ orientation: def.orientation, direction: def.direction });
        renderLayout();
      },
    }, [
      el('div', { class: 'layout-glyph', 'aria-hidden': 'true', style: `flex-direction: ${def.flex}` },
        [el('span'), el('span'), el('span')]),
      el('span', { class: 'layout-name' }, [el('b', { text: def.label }), el('small', { text: def.sub })]),
    ]));
  }
}

function renderLayout() {
  const layout = state.layout;
  renderLayoutPicker();
  setSegmented($('class-icon-side'), layout.classIconSide || 'left');
  $('icon-size').value = layout.iconSize;
  $('icon-size-value').textContent = `${layout.iconSize} px`;
  $('cast-lifetime').value = layout.castLifetimeMs / 1000;
  $('cast-lifetime-value').textContent = formatLifetime(layout.castLifetimeMs);
  $('max-visible-value').textContent = layout.maxVisibleCasts;
  $('max-dec').disabled = layout.maxVisibleCasts <= state.maxVisibleRange.min;
  $('max-inc').disabled = layout.maxVisibleCasts >= state.maxVisibleRange.max;
  setSwitch($('preview-enabled'), layout.previewEnabled);
  renderPreview();
}

/** Casts shown in the preview: the tracked heroes' colors and classes, two casts each. */
function previewEntries(count) {
  const pool = state.previewPool;
  const tracked = state.heroes.filter((h) => state.tracked.has(h.characterName));
  const heroes = tracked.length ? tracked : state.heroes;
  const entries = [];
  for (let i = 0; i < count; i += 1) {
    if (heroes.length) {
      const hero = heroes[Math.floor(i / 2) % heroes.length];
      const sample = pool.find((p) => p.class === hero.class) || pool[i % (pool.length || 1)];
      entries.push({ heroClass: hero.class, color: rgbToHex(hero.color), icon: sample?.icon });
    } else if (pool.length) {
      const sample = pool[i % pool.length];
      entries.push({ heroClass: sample.class, color: rgbToHex(sample.color), icon: sample.icon });
    } else {
      entries.push({ heroClass: null, color: PALETTE[i % PALETTE.length], icon: null });
    }
  }
  return entries;
}

function renderPreview() {
  const layout = state.layout;
  if (!layout.iconSize) return;
  const iconSize = layout.iconSize;
  const { width, height } = overlaySize(layout);
  const sizeText = `${width} × ${height}`;
  $('obs-size').textContent = `${sizeText} px`;
  for (const node of document.querySelectorAll('.obs-size-inline')) node.textContent = sizeText;

  if ($('view-affichage').hidden) return;

  const stage = $('preview-stage');
  const availW = stage.clientWidth - 28;
  const availH = stage.clientHeight - 28;
  const k = Math.min(1, availW / width, availH / height);

  const box = $('preview-box');
  box.style.width = `${Math.round(width * k)}px`;
  box.style.height = `${Math.round(height * k)}px`;
  const scale = $('preview-scale');
  scale.style.width = `${width}px`;
  scale.style.height = `${height}px`;
  scale.style.transform = `scale(${k})`;

  $('pv-overlay').dataset.side = layout.classIconSide || 'left';
  const flex = LAYOUTS.find((l) => l.id === layoutId(layout)).flex;
  const log = $('pv-log');
  log.style.flexDirection = flex;
  log.innerHTML = '';

  const entries = previewEntries(layout.maxVisibleCasts);
  for (const entry of entries) {
    const box = el('div', { class: 'pv-entry', style: `--c: ${entry.color}` });
    const src = assetUrl(entry.icon);
    const fill = el('div', { class: 'pv-fill', style: `width: ${iconSize}px; height: ${iconSize}px` });
    if (src) {
      const img = el('img', { src, alt: '', style: `width: ${iconSize}px; height: ${iconSize}px` });
      img.onerror = () => img.replaceWith(fill);
      box.append(img);
    } else {
      box.append(fill);
    }
    log.append(box);
  }

  // The class icon shows the class of the most recent cast (the last one).
  const lead = $('pv-lead');
  const leadSize = iconSize + CLASS_ICON_EXTRA_PX;
  lead.style.width = `${leadSize}px`;
  lead.style.height = `${leadSize}px`;
  lead.innerHTML = '';
  const emblem = classEmblem(entries[entries.length - 1]?.heroClass);
  if (emblem) lead.append(el('img', { src: emblem, alt: '' }));
}

window.addEventListener('resize', renderPreview);

$('class-icon-side').addEventListener('click', (e) => {
  const value = e.target.closest('button')?.dataset.value;
  if (!value) return;
  state.layout.classIconSide = value;
  api.setComboLayout({ classIconSide: value });
  renderLayout();
});

// `input` keeps the label and preview live while dragging; the setting itself
// is only persisted/broadcast on `change` (pointer release), so a drag doesn't
// write the file once per pixel.
$('icon-size').addEventListener('input', (e) => {
  state.layout.iconSize = Number(e.target.value);
  $('icon-size-value').textContent = `${state.layout.iconSize} px`;
  renderPreview();
});
$('icon-size').addEventListener('change', () => api.setComboLayout({ iconSize: state.layout.iconSize }));

$('cast-lifetime').addEventListener('input', (e) => {
  state.layout.castLifetimeMs = Number(e.target.value) * 1000;
  $('cast-lifetime-value').textContent = formatLifetime(state.layout.castLifetimeMs);
});
$('cast-lifetime').addEventListener('change', () => api.setComboLayout({ castLifetimeMs: state.layout.castLifetimeMs }));

function stepMaxVisible(delta) {
  const { min, max } = state.maxVisibleRange;
  const value = Math.max(min, Math.min(max, state.layout.maxVisibleCasts + delta));
  if (value === state.layout.maxVisibleCasts) return;
  state.layout.maxVisibleCasts = value;
  api.setComboLayout({ maxVisibleCasts: value });
  renderLayout();
}
$('max-dec').addEventListener('click', () => stepMaxVisible(-1));
$('max-inc').addEventListener('click', () => stepMaxVisible(1));

$('preview-enabled').addEventListener('click', () => {
  state.layout.previewEnabled = !state.layout.previewEnabled;
  api.setComboLayout({ previewEnabled: state.layout.previewEnabled });
  setSwitch($('preview-enabled'), state.layout.previewEnabled);
});

$('copy-size').addEventListener('click', (e) => {
  const { width, height } = overlaySize();
  copyText(`${width}x${height}`, e.currentTarget);
});

// ── OBS & diagnostic ─────────────────────────────────────────────────────

const ICON_CHECK = '<path d="M20 6 9 17l-5-5" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>';
const ICON_ALERT = '<path d="M12 7v6" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/><path d="M12 17h.01" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/>';

function setDiagCard(id, { tone, label, value, title }) {
  const card = $(id);
  card.classList.toggle('warn', tone === 'warn');
  card.classList.toggle('bad', tone === 'bad');
  card.querySelector('.diag-icon').innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">${tone === 'ok' ? ICON_CHECK : ICON_ALERT}</svg>`;
  if (label !== undefined) card.querySelector('.diag-label').textContent = label;
  const valueEl = card.querySelector('.diag-value');
  valueEl.textContent = value;
  valueEl.title = title || value;
}

function setSideStatus(dotId, valueId, tone, text) {
  const dot = $(dotId);
  dot.className = `dot ${tone === 'ok' ? 'ok' : tone === 'bad' ? 'err' : 'warn'}`;
  const value = $(valueId);
  value.textContent = text;
  value.className = `status-value ${tone === 'ok' ? 'ok-text' : tone === 'bad' ? 'err-text' : 'warn-text'}`;
}

async function loadDiagnostics() {
  const diag = await api.getDiagnostics();
  state.diag = diag;

  setDiagCard('card-logs', diag.logsDirExists
    ? { tone: 'ok', value: 'Dossier trouvé', title: diag.logsDir }
    : { tone: 'bad', value: 'Dossier introuvable', title: diag.logsDir });
  setSideStatus('side-logs-dot', 'side-logs-value', diag.logsDirExists ? 'ok' : 'bad', diag.logsDirExists ? 'trouvés' : 'introuvables');

  const clients = diag.overlayClients;
  if (diag.overlayError) {
    setDiagCard('card-obs', { tone: 'bad', label: 'Overlay hors ligne', value: diag.overlayError });
    setSideStatus('side-obs-dot', 'side-obs-value', 'bad', 'overlay HS');
  } else {
    setDiagCard('card-obs', {
      tone: clients > 0 ? 'ok' : 'warn',
      label: `Overlay · ${clients} client${clients > 1 ? 's' : ''}`,
      value: clients > 0 ? 'OBS connecté' : 'OBS non connecté',
    });
    setSideStatus('side-obs-dot', 'side-obs-value', clients > 0 ? 'ok' : 'warn', clients > 0 ? 'connecté' : 'non connecté');
  }
  $('last-cast').textContent = formatAgo(diag.lastCastAt);

  $('overlay-url').textContent = diag.overlayUrl;
  $('obs-loader-path').textContent = diag.obsLoaderPath || 'indisponible (écriture impossible)';
  $('overlay-error').textContent = diag.overlayError
    ? `L'overlay est hors ligne (${diag.overlayError}) : change le port ci-dessous.`
    : '';

  // Don't clobber what the user is actively typing.
  if (document.activeElement !== $('overlay-port-input')) $('overlay-port-input').value = diag.overlayPort;
  if (document.activeElement !== $('logs-dir-input')) $('logs-dir-input').value = diag.logsDir;

  renderWizardObsStatus();
}

setInterval(loadDiagnostics, 2000);

$('obs-method').addEventListener('click', (e) => {
  const value = e.target.closest('button')?.dataset.value;
  if (!value) return;
  setSegmented($('obs-method'), value, 'aria-selected');
  for (const panel of document.querySelectorAll('.method-panel')) panel.hidden = panel.dataset.method !== value;
});

$('copy-url').addEventListener('click', (e) => state.diag && copyText(state.diag.overlayUrl, e.currentTarget));
$('copy-file').addEventListener('click', (e) => state.diag?.obsLoaderPath && copyText(state.diag.obsLoaderPath, e.currentTarget));
$('show-obs-loader').addEventListener('click', () => api.showObsLoader());

async function applyOverlayPort() {
  const input = $('overlay-port-input');
  if (!state.diag || (String(state.diag.overlayPort) === input.value.trim() && !state.diag.overlayError)) return;
  $('overlay-port-error').textContent = '';
  const result = await api.setOverlayPort(input.value.trim());
  input.classList.toggle('invalid', !result.ok);
  if (!result.ok) {
    $('overlay-port-error').textContent = result.error || 'Port invalide.';
    return;
  }
  showToast('Port changé — pense à mettre à jour l\'URL dans OBS.');
  await loadDiagnostics();
}

$('overlay-port-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });
$('overlay-port-input').addEventListener('change', applyOverlayPort);

async function applyLogsDir() {
  const input = $('logs-dir-input');
  if (!state.diag || state.diag.logsDir === input.value) return;
  $('logs-dir-error').textContent = '';
  const result = await api.setLogsDir(input.value);
  input.classList.toggle('invalid', !result.ok);
  if (!result.ok) {
    $('logs-dir-error').textContent = result.error || 'Chemin invalide.';
    return;
  }
  showToast('Dossier de logs changé.');
  await loadDiagnostics();
}

$('logs-dir-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });
$('logs-dir-input').addEventListener('change', applyLogsDir);
$('logs-dir-browse').addEventListener('click', async () => {
  const picked = await api.browseLogsDir();
  if (!picked) return;
  $('logs-dir-input').value = picked;
  await applyLogsDir();
});

function renderLaunchAtLogin({ available, enabled }) {
  setSwitch($('launch-at-login'), enabled);
  $('launch-at-login').disabled = !available;
  $('launch-at-login-hint').hidden = available;
}

$('launch-at-login').addEventListener('click', async (e) => {
  const enabled = e.currentTarget.getAttribute('aria-checked') !== 'true';
  renderLaunchAtLogin(await api.setLaunchAtLogin(enabled));
});

// ── Activité en temps réel ───────────────────────────────────────────────

const MAX_DEBUG_ENTRIES = 50;
const debugLog = $('debug-log');

function debugEntryView(entry) {
  const heroClass = CLASS_LABELS.get(entry.heroClass);
  const who = heroClass ? `${entry.characterName} (${heroClass})` : entry.characterName;
  const spell = entry.spellName ? ` · ${entry.spellName}` : '';
  switch (entry.status) {
    case 'broadcast':
      return entry.iconMissing
        ? { tone: 'err', kind: 'erreur', msg: `${who}${spell} — sort sans icône connue` }
        : { tone: 'ok', kind: 'affiché', msg: `${who}${spell}` };
    case 'test':
      return { tone: 'ok', kind: 'test', msg: `${who}${spell}` };
    case 'ignored-untracked':
      return { tone: 'muted', kind: 'ignoré', msg: `${entry.characterName} · héros en pause` };
    case 'ignored-unmatched':
      return { tone: 'muted', kind: 'ignoré', msg: `${entry.characterName} · personnage non suivi` };
    default:
      return { tone: 'muted', kind: entry.status, msg: who };
  }
}

function showEmptyDebugLog() {
  debugLog.innerHTML = '';
  debugLog.append(el('li', { class: 'empty', text: 'En attente d\'un sort détecté dans les logs…' }));
}

function addDebugEntry(entry) {
  debugLog.querySelector('.empty')?.remove();
  const view = debugEntryView(entry);
  const time = new Date(entry.timestamp || Date.now()).toLocaleTimeString('fr-FR');
  debugLog.prepend(el('li', { class: view.tone }, [
    el('span', { class: 't', text: time }),
    el('span', { class: 'k', text: view.kind }),
    el('span', { class: 'm', text: view.msg }),
  ]));
  while (debugLog.children.length > MAX_DEBUG_ENTRIES) debugLog.lastChild.remove();

  if (entry.status === 'broadcast' && state.diag) {
    state.diag.lastCastAt = entry.timestamp || Date.now();
    $('last-cast').textContent = formatAgo(state.diag.lastCastAt);
  }
}

$('clear-debug-log').addEventListener('click', showEmptyDebugLog);

// ── Mises à jour ─────────────────────────────────────────────────────────

const UPDATE_STATUS_LABELS = {
  checking: 'Recherche…',
  available: (p) => `v${p.version} disponible`,
  'not-available': 'À jour',
  downloading: (p) => `Téléchargement ${Math.round(p.percent || 0)} %`,
  downloaded: (p) => `v${p.version} prête — redémarre`,
  error: 'Erreur de vérification',
};

function renderUpdateStatus(payload) {
  const label = UPDATE_STATUS_LABELS[payload.status];
  const text = typeof label === 'function' ? label(payload) : (label || '');
  $('update-status').textContent = text;
  $('update-status').title = payload.status === 'error' ? (payload.message || '') : text;
  $('update-check-btn').disabled = payload.status === 'checking' || payload.status === 'downloading';
}

$('update-check-btn').addEventListener('click', () => api.checkForUpdates());
api.onUpdateStatus(renderUpdateStatus);

// ── Assistant de premier lancement ───────────────────────────────────────

const WIZARD_STEPS = ['Ton personnage', 'Ajouter à OBS', 'Tester'];
const wizard = { step: 1, name: '', cls: '', heroName: null, tested: false };

function openWizard() {
  Object.assign(wizard, { step: 1, name: '', cls: '', heroName: null, tested: false });
  $('wz-name').value = '';
  $('wz-error').textContent = '';
  hideToast();
  $('wizard').hidden = false;
  renderWizard();
  $('wz-name').focus();
}

async function closeWizard() {
  await api.setOnboardingDone();
  $('wizard').hidden = true;
  await refreshHeroes();
  location.hash = '#heros';
  showView('heros');
}

function renderWizardClasses() {
  const grid = $('wz-classes');
  grid.innerHTML = '';
  for (const [slug, label] of CLASSES) {
    const emblem = classEmblem(slug);
    const mark = emblem ? el('img', { src: emblem, alt: '' }) : el('span', { text: label.slice(0, 2) });
    grid.append(el('button', {
      type: 'button', class: 'class-option', role: 'radio',
      'aria-checked': wizard.cls === slug ? 'true' : 'false',
      onclick: () => { wizard.cls = slug; renderWizardClasses(); },
    }, [mark, el('span', { text: label })]));
  }
}

function renderWizardObsStatus() {
  if ($('wizard').hidden || !state.diag) return;
  const connected = state.diag.overlayClients > 0;
  $('wz-obs').classList.toggle('connected', connected);
  $('wz-obs-text').textContent = connected ? 'OBS est connecté à l’overlay.' : 'En attente de la connexion d’OBS…';
  $('wz-url').textContent = state.diag.overlayUrl;
  if (wizard.step === 3) renderWizardChecks();
}

function renderWizardChecks() {
  const connected = state.diag?.overlayClients > 0;
  const checks = [
    { ok: Boolean(wizard.heroName), label: wizard.heroName ? 'Personnage ajouté' : 'Aucun personnage ajouté' },
    { ok: connected, label: connected ? 'OBS connecté à l’overlay' : 'OBS pas encore connecté' },
    { ok: wizard.tested, label: wizard.tested ? 'Sort de test envoyé' : 'Sort de test pas encore envoyé' },
  ];
  const list = $('wz-checks');
  list.innerHTML = '';
  for (const check of checks) {
    list.append(el('li', { class: check.ok ? 'ok' : '' }, [
      el('span', { class: 'tick' }, svg('<path d="M20 6 9 17l-5-5"/>', 12,
        'fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"')),
      el('span', { text: check.label }),
    ]));
  }
}

function renderWizard() {
  const steps = $('wizard-steps');
  steps.innerHTML = '';
  WIZARD_STEPS.forEach((label, i) => {
    const n = i + 1;
    const done = n < wizard.step;
    const current = n === wizard.step;
    steps.append(el('li', { class: done ? 'done' : current ? 'current' : '', 'aria-current': current ? 'step' : 'false' }, [
      el('span', { class: 'mark', text: done ? '✓' : String(n) }),
      el('span', { text: label }),
    ]));
  });

  for (const section of document.querySelectorAll('.wizard-step')) {
    section.hidden = Number(section.dataset.step) !== wizard.step;
  }
  $('wz-back').style.visibility = wizard.step > 1 ? 'visible' : 'hidden';
  $('wz-next').hidden = wizard.step === 3;
  $('wz-finish').hidden = wizard.step !== 3;

  const { width, height } = overlaySize();
  $('wz-w').textContent = width;
  $('wz-h').textContent = height;

  if (wizard.step === 1) renderWizardClasses();
  if (wizard.step === 3) renderWizardChecks();
  renderWizardObsStatus();
}

/** Step 1 → 2: adds the hero (or updates the one added earlier in this run). */
async function saveWizardHero() {
  const name = $('wz-name').value.trim();
  $('wz-error').textContent = '';
  if (!name) { $('wz-error').textContent = 'Indique le nom exact de ton personnage.'; $('wz-name').focus(); return false; }
  if (!wizard.cls) { $('wz-error').textContent = 'Choisis sa classe.'; return false; }

  if (wizard.heroName) {
    const ok = await api.updateHero(wizard.heroName, { characterName: name, class: wizard.cls });
    if (!ok) { $('wz-error').textContent = 'Ce nom de personnage existe déjà.'; return false; }
  } else if (state.heroes.some((h) => h.characterName === name)) {
    // Already in the roster (assistant re-run): just make sure it's tracked with that class.
    await api.updateHero(name, { class: wizard.cls });
    if (!state.tracked.has(name)) await api.setTrackedHeroes([...state.tracked, name]);
  } else {
    const used = new Set(state.heroes.map((h) => rgbToHex(h.color)));
    const color = PALETTE.find((c) => !used.has(c)) || PALETTE[0];
    const ok = await api.addHero({ characterName: name, class: wizard.cls, color: hexToRgb(color) });
    if (!ok) { $('wz-error').textContent = 'Ce nom de personnage existe déjà.'; return false; }
  }
  wizard.heroName = name;
  await refreshHeroes();
  return true;
}

$('wz-next').addEventListener('click', async () => {
  if (wizard.step === 1 && !(await saveWizardHero())) return;
  wizard.step = Math.min(3, wizard.step + 1);
  renderWizard();
});
$('wz-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('wz-next').click(); });
$('wz-back').addEventListener('click', () => {
  wizard.step = Math.max(1, wizard.step - 1);
  renderWizard();
});
$('wz-copy').addEventListener('click', (e) => state.diag && copyText(state.diag.overlayUrl, e.currentTarget));
$('wz-test').addEventListener('click', async () => {
  await api.sendTestCast(wizard.heroName);
  wizard.tested = true;
  renderWizardChecks();
});
$('wz-finish').addEventListener('click', closeWizard);
$('wizard-skip').addEventListener('click', closeWizard);
$('rerun-wizard').addEventListener('click', openWizard);

// ── Init ─────────────────────────────────────────────────────────────────

async function init() {
  const s = await api.getState();
  state.heroes = s.heroes;
  state.tracked = new Set(s.trackedCharacterNames);
  state.layout = { ...s.comboLayout };
  state.classIcons = s.classIcons || {};
  state.previewPool = s.previewPool || [];

  if (s.iconSizeRange) {
    $('icon-size').min = s.iconSizeRange.min;
    $('icon-size').max = s.iconSizeRange.max;
  }
  if (s.castLifetimeRange) {
    $('cast-lifetime').min = s.castLifetimeRange.min / 1000;
    $('cast-lifetime').max = s.castLifetimeRange.max / 1000;
  }
  if (s.maxVisibleCastsRange) {
    state.maxVisibleRange = { min: s.maxVisibleCastsRange.min, max: s.maxVisibleCastsRange.max };
  }

  showView(location.hash.slice(1));
  renderHeroes();
  renderLayout();
  setSegmented($('obs-method'), 'url', 'aria-selected');
  showEmptyDebugLog();
  api.onDebugEvent(addDebugEntry);
  renderLaunchAtLogin(await api.getLaunchAtLogin());
  $('app-version').textContent = `v${await api.getAppVersion()}`;
  await loadDiagnostics();

  if (s.showOnboarding) openWizard();
}

init();
