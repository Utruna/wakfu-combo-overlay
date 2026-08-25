/**
 * wakfuCombatLogReader.js
 * Tails Wakfu's main combat log file and emits one event per spell cast.
 *
 * Only wakfu.log is read. Wakfu also echoes combat lines into wakfu_chat.log
 * (the in-game chat mirrors combat info) — watching every *.log file was
 * tried first but double-counts every single cast because of that echo, so
 * wakfu.log is the one authoritative source here. If a second simultaneous
 * game client ever turns out to write a differently-named sibling file, that
 * will need to be verified empirically and added back deliberately (not by
 * reverting to "watch everything", which is what caused the duplicate-cast
 * bug in the first place).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

class WakfuCombatLogReader {
  static DEFAULT_LOGS_DIR = path.join(
    os.homedir(),
    'AppData\\Roaming\\zaap\\gamesLogs\\wakfu\\logs'
  );

  static MAIN_LOG_FILE_NAME = 'wakfu.log';

  // Combat cast line format: "[Information (combat)] Lueur Pourpre lance le sort Saignée mortelle"
  // Turn-boundary patterns (fightJoin/localLeaderChanged/turnFighterEffects) from the old
  // wakfuLogReader.js are intentionally not revived here — this reader only cares about
  // discrete cast events, not who the "active" character is.
  static COMBAT_SPELL_CAST_PATTERN =
    /\[Information\s+\(combat\)\]\s+([^:]+?)\s+lance\s+le\s+sort\s+(.+?)(?:\s*\(|$)/gim;

  /**
   * @param {Function} onCastEvent - ({characterName, spellName, timestamp, sourceFile}) => void
   * @param {object} [options]
   * @param {string} [options.logsDir] - Directory to watch (defaults to Wakfu's logs dir).
   * @param {number} [options.pollIntervalMs] - Fallback poll interval (fs.watch is unreliable on Windows).
   */
  constructor(onCastEvent, { logsDir = WakfuCombatLogReader.DEFAULT_LOGS_DIR, pollIntervalMs = 700 } = {}) {
    this._onCastEvent = onCastEvent;
    this._logsDir = logsDir;
    this._pollIntervalMs = pollIntervalMs;
    this._watcher = null;
    this._pollTimer = null;
    this._isWatching = false;
    this._filePositions = new Map(); // filePath -> lastReadPosition (chars)
  }

  /**
   * Start watching the logs directory.
   *
   * @returns {Promise<boolean>} true if watching started, false if the directory doesn't exist.
   */
  async start() {
    if (this._isWatching) {
      console.warn('[WakfuCombatLogReader] Already watching.');
      return false;
    }

    if (!fs.existsSync(this._logsDir)) {
      console.warn(`[WakfuCombatLogReader] Logs dir not found: ${this._logsDir}`);
      return false;
    }

    // Seed every existing file at EOF so only content appended after start()
    // is ever emitted (no replay of past casts as "just happened").
    for (const filePath of this._listLogFiles()) {
      this._filePositions.set(filePath, this._safeLength(filePath));
    }

    this._watcher = fs.watch(this._logsDir, { recursive: false }, () => this._scan());

    this._pollTimer = setInterval(() => this._scan(), this._pollIntervalMs);
    this._pollTimer.unref?.();

    this._isWatching = true;
    console.log(`[WakfuCombatLogReader] Watching ${this._logsDir}`);
    return true;
  }

  /**
   * Stop watching the logs directory.
   */
  stop() {
    if (this._watcher) {
      this._watcher.close();
      this._watcher = null;
    }
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
    this._isWatching = false;
    console.log('[WakfuCombatLogReader] Stopped.');
  }

  // ── Private ──────────────────────────────────────────────────────────────

  _listLogFiles() {
    try {
      return fs.readdirSync(this._logsDir)
        .filter((name) => name.toLowerCase() === WakfuCombatLogReader.MAIN_LOG_FILE_NAME)
        .map((name) => path.join(this._logsDir, name));
    } catch {
      return [];
    }
  }

  _safeLength(filePath) {
    try {
      return fs.readFileSync(filePath, 'utf-8').length;
    } catch {
      return 0;
    }
  }

  _scan() {
    for (const filePath of this._listLogFiles()) {
      this._readIncremental(filePath);
    }
  }

  _readIncremental(filePath) {
    try {
      const position = this._filePositions.get(filePath);

      if (position === undefined) {
        // Newly-discovered file (log rotation) — seed at EOF too, don't
        // replay its existing content as new casts.
        this._filePositions.set(filePath, this._safeLength(filePath));
        return;
      }

      // Deliberately a single read as the only source of truth for length —
      // comparing fs.statSync's byte size against a position derived from
      // content.length (UTF-16 code units) can disagree for any non-ASCII
      // text, and the two syscalls can also observe the file at slightly
      // different instants while another process is actively writing to it.
      const content = fs.readFileSync(filePath, 'utf-8');

      if (content.length < position) {
        // Genuinely shorter than last time (rotated/truncated) — resync, don't replay.
        this._filePositions.set(filePath, content.length);
        return;
      }
      if (content.length === position) return; // nothing new

      const newContent = content.substring(position);
      this._filePositions.set(filePath, content.length);

      this._emitCastsFrom(newContent, filePath);
    } catch (err) {
      console.error('[WakfuCombatLogReader] Error reading', filePath, err.message);
    }
  }

  _emitCastsFrom(text, sourceFile) {
    const pattern = new RegExp(
      WakfuCombatLogReader.COMBAT_SPELL_CAST_PATTERN.source,
      WakfuCombatLogReader.COMBAT_SPELL_CAST_PATTERN.flags
    );

    for (const match of text.matchAll(pattern)) {
      const characterName = String(match[1] || '').trim();
      const spellName = String(match[2] || '').trim();
      if (!characterName || !spellName) continue;

      this._onCastEvent({
        characterName,
        spellName,
        timestamp: Date.now(),
        sourceFile,
      });
    }
  }
}

module.exports = { WakfuCombatLogReader };
