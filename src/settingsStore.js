/**
 * settingsStore.js
 * Persists and broadcasts user-editable combo-overlay settings:
 * which heroes are currently tracked, and how the combo list is laid out.
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
    this._trackedSet = new Set(this._state.trackedHeroIndexes || []);
  }

  /**
   * Fill in any missing fields with defaults (e.g. on first run), persisting
   * only if something was actually missing.
   *
   * @param {object} defaults
   * @param {number[]} defaults.trackedHeroIndexes
   * @param {{orientation: string, direction: string}} defaults.comboLayout
   */
  ensureDefaults(defaults) {
    let changed = false;
    if (!this._state.trackedHeroIndexes) {
      this._state.trackedHeroIndexes = defaults.trackedHeroIndexes;
      this._trackedSet = new Set(this._state.trackedHeroIndexes);
      changed = true;
    }
    if (!this._state.comboLayout) {
      this._state.comboLayout = defaults.comboLayout;
      changed = true;
    }
    if (changed) this._persist();
  }

  get trackedHeroIndexes() {
    return [...this._trackedSet];
  }

  get comboLayout() {
    return this._state.comboLayout;
  }

  isTracked(heroIndex) {
    return this._trackedSet.has(heroIndex);
  }

  setTrackedHeroes(indexes) {
    this._trackedSet = new Set((indexes || []).filter((n) => Number.isInteger(n)));
    this._state.trackedHeroIndexes = [...this._trackedSet];
    this._persist();
    this.emit('trackedHeroesChanged', this.trackedHeroIndexes);
  }

  setComboLayout(layout) {
    this._state.comboLayout = { ...this._state.comboLayout, ...layout };
    this._persist();
    this.emit('comboLayoutChanged', this._state.comboLayout);
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
