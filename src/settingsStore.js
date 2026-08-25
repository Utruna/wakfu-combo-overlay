/**
 * settingsStore.js
 * Persists and broadcasts user-editable combo-overlay settings: the tracked
 * character roster (own to this app, independent of the Stream Deck tool's
 * heroes.json), which of them are currently tracked, and how the combo list
 * is laid out.
 *
 * Heroes are keyed by `characterName` (the exact in-game name, already
 * required to be unique for combat-log matching) rather than array position,
 * so adding/removing a character never invalidates other stored references.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

class SettingsStore extends EventEmitter {
  /** @param {string} filePath - Where to persist settings as JSON. */
  constructor(filePath) {
    super();
    this._filePath = filePath;
    this._state = this._readOrEmpty();
    this._trackedSet = new Set(this._state.trackedCharacterNames || []);
  }

  /**
   * Fill in any missing fields with defaults (e.g. on first run — importing
   * the existing heroes.json roster so nothing is lost), persisting only if
   * something was actually missing.
   *
   * @param {object} defaults
   * @param {{name: string, characterName: string, color: object}[]} defaults.heroes
   * @param {string[]} defaults.trackedCharacterNames
   * @param {{orientation: string, direction: string}} defaults.comboLayout
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

  isTracked(characterName) {
    return this._trackedSet.has(characterName);
  }

  setTrackedHeroes(characterNames) {
    this._trackedSet = new Set((characterNames || []).filter((n) => typeof n === 'string' && n));
    this._state.trackedCharacterNames = [...this._trackedSet];
    this._persist();
    this.emit('trackedHeroesChanged', this.trackedCharacterNames);
  }

  setComboLayout(layout) {
    this._state.comboLayout = { ...this._state.comboLayout, ...layout };
    this._persist();
    this.emit('comboLayoutChanged', this._state.comboLayout);
  }

  /**
   * Add a new tracked character. Rejects a duplicate/blank characterName
   * (it's the matching key, so it must stay unique) — returns false in that
   * case, true on success.
   *
   * @param {{name: string, characterName: string, color: {r:number,g:number,b:number}}} hero
   */
  addHero(hero) {
    const characterName = String(hero.characterName || '').trim();
    if (!characterName) return false;
    if (this.heroes.some((h) => h.characterName === characterName)) return false;

    const name = String(hero.name || '').trim() || characterName;
    const heroes = [...this.heroes, { name, characterName, color: hero.color }];
    this._state.heroes = heroes;

    this._trackedSet.add(characterName);
    this._state.trackedCharacterNames = [...this._trackedSet];

    this._persist();
    this.emit('heroesChanged', this.heroes);
    this.emit('trackedHeroesChanged', this.trackedCharacterNames);
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

  // ── Private ──────────────────────────────────────────────────────────────

  _persist() {
    try {
      fs.mkdirSync(path.dirname(this._filePath), { recursive: true });
      fs.writeFileSync(this._filePath, JSON.stringify(this._state, null, 2));
    } catch (err) {
      console.error('[SettingsStore] Failed to persist settings:', err.message);
    }
  }

  _readOrEmpty() {
    try {
      return JSON.parse(fs.readFileSync(this._filePath, 'utf-8'));
    } catch {
      return {};
    }
  }
}

module.exports = { SettingsStore };
