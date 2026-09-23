/**
 * settingsStore.js
 * Persists and broadcasts user-editable combo-overlay settings: the tracked
 * character roster, which of them are currently tracked, and how the combo
 * list is laid out.
 *
 * Heroes are keyed by `characterName` (the exact in-game name, already
 * required to be unique for combat-log matching) rather than array position,
 * so adding/removing a character never invalidates other stored references.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

// Spell icons are 32x32 source PNGs; larger sizes upscale with
// `image-rendering: pixelated` (see electron/overlay/style.css), which is the
// intended crisp-pixel look rather than a blurry stretch.
const DEFAULT_ICON_SIZE = 32;
const MIN_ICON_SIZE = 16;
const MAX_ICON_SIZE = 128;

// How long a cast icon stays on the overlay before fading out.
const DEFAULT_CAST_LIFETIME_MS = 6000;
const MIN_CAST_LIFETIME_MS = 1000;
const MAX_CAST_LIFETIME_MS = 60000;

const DEFAULT_MAX_VISIBLE_CASTS = 8;
const MIN_MAX_VISIBLE_CASTS = 1;
const MAX_MAX_VISIBLE_CASTS = 20;

class SettingsStore extends EventEmitter {
  /** @param {string} filePath - Where to persist settings as JSON. */
  constructor(filePath) {
    super();
    this._filePath = filePath;
    this._state = this._readOrEmpty();
    this._trackedSet = new Set(this._state.trackedCharacterNames || []);
  }

  /**
   * Fill in any missing fields with defaults (e.g. on first run), persisting
   * only if something was actually missing.
   *
   * @param {object} defaults
   * @param {{name: string, characterName: string, color: object}[]} defaults.heroes
   * @param {string[]} defaults.trackedCharacterNames
   * @param {{orientation: string, direction: string, iconSize: number, castLifetimeMs: number, maxVisibleCasts: number, previewEnabled: boolean, classIconSide: string}} defaults.comboLayout
   * @param {number} defaults.overlayPort
   * @param {string} defaults.logsDir
   */
  ensureDefaults(defaults) {
    let changed = false;
    if (!this._state.heroes) {
      this._state.heroes = defaults.heroes;
      changed = true;
    }
    if (!this._state.trackedCharacterNames) {
      this._state.trackedCharacterNames = defaults.trackedCharacterNames;
      this._trackedSet = new Set(this._state.trackedCharacterNames);
      changed = true;
    }
    if (!this._state.comboLayout) {
      this._state.comboLayout = defaults.comboLayout;
      changed = true;
    } else {
      // Added after the first releases — settings files from those versions
      // have a comboLayout without these.
      if (!this._state.comboLayout.iconSize) {
        this._state.comboLayout.iconSize = defaults.comboLayout.iconSize;
        changed = true;
      }
      if (!this._state.comboLayout.castLifetimeMs) {
        this._state.comboLayout.castLifetimeMs = defaults.comboLayout.castLifetimeMs;
        changed = true;
      }
      if (!this._state.comboLayout.maxVisibleCasts) {
        this._state.comboLayout.maxVisibleCasts = defaults.comboLayout.maxVisibleCasts;
        changed = true;
      }
      if (this._state.comboLayout.previewEnabled === undefined) {
        this._state.comboLayout.previewEnabled = defaults.comboLayout.previewEnabled;
        changed = true;
      }
      // Before this was a setting, the class icon's side followed the list
      // direction — derive it from that so existing overlays don't move.
      if (!SettingsStore.isValidClassIconSide(this._state.comboLayout.classIconSide)) {
        const { direction } = this._state.comboLayout;
        this._state.comboLayout.classIconSide =
          direction === 'bottom-to-top' || direction === 'right-to-left' ? 'right' : 'left';
        changed = true;
      }
    }
    if (!this._state.overlayPort) {
      this._state.overlayPort = defaults.overlayPort;
      changed = true;
    }
    if (!this._state.logsDir) {
      this._state.logsDir = defaults.logsDir;
      changed = true;
    }
    if (changed) this._persist();
  }

  get heroes() {
    return this._state.heroes || [];
  }

  get trackedCharacterNames() {
    return [...this._trackedSet];
  }

  get comboLayout() {
    return this._state.comboLayout;
  }

  get overlayPort() {
    return this._state.overlayPort;
  }

  /** @param {*} side @returns {boolean} true if `side` is a supported class-icon position. */
  static isValidClassIconSide(side) {
    return side === 'left' || side === 'right';
  }

  /** @param {*} port @returns {boolean} true if `port` is an integer in the unprivileged TCP range. */
  static isValidPort(port) {
    const value = Number(port);
    return Number.isInteger(value) && value >= 1024 && value <= 65535;
  }

  /**
   * @param {number} port - Must be an integer in the unprivileged TCP range.
   * @returns {boolean} true if valid and applied, false otherwise (caller keeps the old port).
   */
  setOverlayPort(port) {
    if (!SettingsStore.isValidPort(port)) return false;
    this._state.overlayPort = Number(port);
    this._persist();
    this.emit('overlayPortChanged', this._state.overlayPort);
    return true;
  }

  get logsDir() {
    return this._state.logsDir;
  }

  /**
   * @param {string} dir - Non-empty path. Existence isn't checked here — the
   *   diagnostics panel reports found/not-found separately, since the user
   *   may be pointing at a location Wakfu hasn't written to yet.
   * @returns {boolean} true if valid and applied, false otherwise.
   */
  setLogsDir(dir) {
    const value = String(dir || '').trim();
    if (!value) return false;
    this._state.logsDir = value;
    this._persist();
    this.emit('logsDirChanged', value);
    return true;
  }

  isTracked(characterName) {
    return this._trackedSet.has(characterName);
  }

  setTrackedHeroes(characterNames) {
    this._trackedSet = new Set((characterNames || []).filter((n) => typeof n === 'string' && n));
    this._state.trackedCharacterNames = [...this._trackedSet];
    this._persist();
    this.emit('trackedHeroesChanged', this.trackedCharacterNames);
  }

  /**
   * Merge a partial layout change into the stored one. Out-of-range numeric
   * values are clamped rather than rejected, so a stray value can't leave the
   * overlay with unreadable icons or casts that never disappear.
   *
   * @param {{orientation?: string, direction?: string, iconSize?: number, castLifetimeMs?: number, maxVisibleCasts?: number, previewEnabled?: boolean, classIconSide?: 'left'|'right'}} layout
   */
  setComboLayout(layout) {
    const merged = { ...this._state.comboLayout, ...layout };
    if (layout.iconSize !== undefined) {
      merged.iconSize = SettingsStore.clampIconSize(layout.iconSize, this._state.comboLayout?.iconSize);
    }
    if (layout.castLifetimeMs !== undefined) {
      merged.castLifetimeMs = SettingsStore.clampCastLifetime(
        layout.castLifetimeMs, this._state.comboLayout?.castLifetimeMs);
    }
    if (layout.maxVisibleCasts !== undefined) {
      merged.maxVisibleCasts = SettingsStore.clampMaxVisibleCasts(
        layout.maxVisibleCasts, this._state.comboLayout?.maxVisibleCasts);
    }
    if (layout.previewEnabled !== undefined) {
      merged.previewEnabled = Boolean(layout.previewEnabled);
    }
    if (layout.classIconSide !== undefined && !SettingsStore.isValidClassIconSide(layout.classIconSide)) {
      merged.classIconSide = this._state.comboLayout?.classIconSide ?? 'left';
    }
    this._state.comboLayout = merged;
    this._persist();
    this.emit('comboLayoutChanged', this._state.comboLayout);
  }

  /**
   * Add a new tracked character. Rejects a duplicate/blank characterName
   * (it's the matching key, so it must stay unique) — returns false in that
   * case, true on success.
   *
   * @param {{name: string, characterName: string, color: {r:number,g:number,b:number}, class: string}} hero
   */
  addHero(hero) {
    const characterName = String(hero.characterName || '').trim();
    if (!characterName) return false;
    if (this.heroes.some((h) => h.characterName === characterName)) return false;

    const name = String(hero.name || '').trim() || characterName;
    const heroClass = String(hero.class || '').trim() || null;
    const heroes = [...this.heroes, { name, characterName, color: hero.color, class: heroClass }];
    this._state.heroes = heroes;

    this._trackedSet.add(characterName);
    this._state.trackedCharacterNames = [...this._trackedSet];

    this._persist();
    this.emit('heroesChanged', this.heroes);
    this.emit('trackedHeroesChanged', this.trackedCharacterNames);
    return true;
  }

  /**
   * Update an existing hero's overlay color.
   *
   * @param {string} characterName
   * @param {{r:number,g:number,b:number}} color
   * @returns {boolean} true if the hero was found and updated, false otherwise.
   */
  setHeroColor(characterName, color) {
    const index = this.heroes.findIndex((h) => h.characterName === characterName);
    if (index === -1) return false;

    const heroes = [...this.heroes];
    heroes[index] = { ...heroes[index], color };
    this._state.heroes = heroes;

    this._persist();
    this.emit('heroesChanged', this.heroes);
    return true;
  }

  /** Remove a tracked character by characterName. */
  removeHero(characterName) {
    this._state.heroes = this.heroes.filter((h) => h.characterName !== characterName);
    if (this._trackedSet.delete(characterName)) {
      this._state.trackedCharacterNames = [...this._trackedSet];
    }
    this._persist();
    this.emit('heroesChanged', this.heroes);
    this.emit('trackedHeroesChanged', this.trackedCharacterNames);
  }

  /**
   * @param {*} size - Candidate icon size in px.
   * @param {number} [fallback] - Used when `size` isn't a number at all.
   * @returns {number} An integer within [MIN_ICON_SIZE, MAX_ICON_SIZE].
   */
  static clampIconSize(size, fallback = DEFAULT_ICON_SIZE) {
    const value = Math.round(Number(size));
    if (!Number.isFinite(value)) return fallback;
    return Math.min(MAX_ICON_SIZE, Math.max(MIN_ICON_SIZE, value));
  }

  /**
   * @param {*} ms - Candidate cast lifetime in milliseconds.
   * @param {number} [fallback] - Used when `ms` isn't a number at all.
   * @returns {number} An integer within [MIN_CAST_LIFETIME_MS, MAX_CAST_LIFETIME_MS].
   */
  static clampCastLifetime(ms, fallback = DEFAULT_CAST_LIFETIME_MS) {
    const value = Math.round(Number(ms));
    if (!Number.isFinite(value)) return fallback;
    return Math.min(MAX_CAST_LIFETIME_MS, Math.max(MIN_CAST_LIFETIME_MS, value));
  }

  /**
   * @param {*} value - Candidate max visible casts.
   * @param {number} [fallback] - Used when `value` isn't a number at all.
   * @returns {number} An integer within [MIN_MAX_VISIBLE_CASTS, MAX_MAX_VISIBLE_CASTS].
   */
  static clampMaxVisibleCasts(value, fallback = DEFAULT_MAX_VISIBLE_CASTS) {
    const parsed = Math.round(Number(value));
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(MAX_MAX_VISIBLE_CASTS, Math.max(MIN_MAX_VISIBLE_CASTS, parsed));
  }

  // ── Private ──────────────────────────────────────────────────────────────

  _persist() {
    try {
      fs.mkdirSync(path.dirname(this._filePath), { recursive: true });
      // Write-then-rename: writing settings.json in place leaves it empty or
      // half-written if the app is killed mid-write (PC shutdown, update
      // install, crash) — and an unreadable file silently resets every
      // setting (port, heroes…) on the next launch. A rename is atomic, so the
      // file is always either the old or the new version, never a mix.
      const tmpPath = `${this._filePath}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(this._state, null, 2));
      if (fs.existsSync(this._filePath)) {
        fs.copyFileSync(this._filePath, this._backupPath);
      }
      fs.renameSync(tmpPath, this._filePath);
    } catch (err) {
      console.error('[SettingsStore] Failed to persist settings:', err.message);
    }
  }

  get _backupPath() {
    return `${this._filePath}.bak`;
  }

  _readOrEmpty() {
    for (const candidate of [this._filePath, this._backupPath]) {
      try {
        const parsed = JSON.parse(fs.readFileSync(candidate, 'utf-8'));
        if (parsed && typeof parsed === 'object') {
          if (candidate !== this._filePath) {
            console.warn('[SettingsStore] settings.json unreadable, restored from backup.');
          }
          return parsed;
        }
      } catch {
        // Missing or corrupt — try the next candidate.
      }
    }
    return {};
  }
}

module.exports = {
  SettingsStore,
  DEFAULT_ICON_SIZE, MIN_ICON_SIZE, MAX_ICON_SIZE,
  DEFAULT_CAST_LIFETIME_MS, MIN_CAST_LIFETIME_MS, MAX_CAST_LIFETIME_MS,
  DEFAULT_MAX_VISIBLE_CASTS, MIN_MAX_VISIBLE_CASTS, MAX_MAX_VISIBLE_CASTS,
};
