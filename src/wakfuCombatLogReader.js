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
const { StringDecoder } = require('string_decoder');

class WakfuCombatLogReader {
  static DEFAULT_LOGS_DIR = path.join(
    os.homedir(),
    'AppData\\Roaming\\zaap\\gamesLogs\\wakfu\\logs'
  );

  static MAIN_LOG_FILE_NAME = 'wakfu.log';

  // When two local Wakfu clients share the same fight, each client's own
  // process logs the whole fight's combat feed — so the same cast can appear
  // as two near-simultaneous real lines in wakfu.log (observed a few ms to
  // ~20ms apart). A human can't legitimately recast the identical spell that
  // fast, so a short suppression window filters the game's own duplicate
  // without needing to know which client "really" cast it.
  static DEDUPE_WINDOW_MS = 500;

  // Upper bound for a single read, so a huge burst (or a file that was
  // rotated while we weren't looking) never allocates an unbounded buffer.
  static READ_CHUNK_BYTES = 256 * 1024;

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
   * @param {Function} [options.onLine] - (line) => void, called with every complete new line, in
   *   order, before that line's cast (if any) is emitted — for consumers that need more than casts.
   */
  constructor(onCastEvent, { logsDir = WakfuCombatLogReader.DEFAULT_LOGS_DIR, pollIntervalMs = 700, onLine = null } = {}) {
    this._onCastEvent = onCastEvent;
    this._onLine = onLine;
    this._logsDir = logsDir;
    this._pollIntervalMs = pollIntervalMs;
    this._watcher = null;
    this._pollTimer = null;
    this._isWatching = false;
    // filePath -> { position (bytes), decoder, pendingLine }. Positions are in
    // bytes (not decoded chars) so only the newly appended bytes are ever read,
    // instead of re-reading the whole — ever-growing — log on every tick.
    this._files = new Map();
    this._lastEmittedKey = null;
    this._lastEmittedAt = 0;
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

    // Seed every existing file at EOF so only content appended after start()
    // is ever emitted (no replay of past casts as "just happened").
    for (const filePath of this._listLogFiles()) {
      this._files.set(filePath, this._newFileState(this._safeSize(filePath)));
    }

    // Polling is the source of truth (fs.watch is unreliable on Windows) and
    // runs even if the directory doesn't exist yet — e.g. Wakfu never launched
    // on this machine — so the reader picks it up as soon as it appears
    // instead of staying dead until the app is restarted.
    this._pollTimer = setInterval(() => this._tick(), this._pollIntervalMs);
    this._pollTimer.unref?.();
    this._attachWatcher();

    this._isWatching = true;
    const dirExists = fs.existsSync(this._logsDir);
    if (dirExists) {
      console.log(`[WakfuCombatLogReader] Watching ${this._logsDir}`);
    } else {
      console.warn(`[WakfuCombatLogReader] Logs dir not found (will keep polling): ${this._logsDir}`);
    }
    return dirExists;
  }

  /**
   * Stop watching the logs directory.
   */
  stop() {
    this._detachWatcher();
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

  _attachWatcher() {
    if (this._watcher || !fs.existsSync(this._logsDir)) return;
    try {
      this._watcher = fs.watch(this._logsDir, { recursive: false }, () => this._scan());
      // Without this listener, an FSWatcher error (e.g. EPERM when the folder
      // is deleted/moved on Windows) is an uncaught exception that takes down
      // the whole main process. Polling keeps working on its own meanwhile.
      this._watcher.on('error', (err) => {
        console.warn('[WakfuCombatLogReader] Watcher error, falling back to polling:', err.message);
        this._detachWatcher();
      });
    } catch (err) {
      console.warn('[WakfuCombatLogReader] fs.watch unavailable, polling only:', err.message);
      this._watcher = null;
    }
  }

  _detachWatcher() {
    if (!this._watcher) return;
    try { this._watcher.close(); } catch { /* already closed */ }
    this._watcher = null;
  }

  _tick() {
    this._attachWatcher(); // no-op once attached; re-attaches after an error or late-created dir
    this._scan();
  }

  _newFileState(position) {
    return { position, decoder: new StringDecoder('utf8'), pendingLine: '' };
  }

  _safeSize(filePath) {
    try {
      return fs.statSync(filePath).size;
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
    let state = this._files.get(filePath);

    if (state === undefined) {
      // Newly-discovered file — seed at EOF too, don't replay its existing
      // content as new casts.
      this._files.set(filePath, this._newFileState(this._safeSize(filePath)));
      return;
    }

    let fd;
    try {
      fd = fs.openSync(filePath, 'r');
      const size = fs.fstatSync(fd).size;

      if (size < state.position) {
        // Shorter than last time: the log was truncated/recreated (e.g. the
        // client restarted). Everything in it was written since our last
        // tick, so read it from the start rather than skipping it.
        state = this._newFileState(0);
        this._files.set(filePath, state);
      }

      // Read until EOF rather than up to `size`: the game may still be
      // appending, and whatever lands after fstat is simply picked up now
      // instead of on the next tick.
      const buffer = Buffer.allocUnsafe(WakfuCombatLogReader.READ_CHUNK_BYTES);
      let text = '';
      for (;;) {
        const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, state.position);
        if (bytesRead === 0) break;
        state.position += bytesRead;
        // StringDecoder holds back a multi-byte UTF-8 character split across
        // two reads (é, è… are everywhere in French spell names).
        text += state.decoder.write(buffer.subarray(0, bytesRead));
      }
      if (!text) return;

      // Only complete lines are parsed. A line the game is still in the
      // middle of writing is kept for the next read, so a cast is never
      // missed or emitted with a truncated spell name.
      const combined = state.pendingLine + text;
      const lastNewline = combined.lastIndexOf('\n');
      if (lastNewline === -1) {
        state.pendingLine = combined;
        return;
      }
      state.pendingLine = combined.slice(lastNewline + 1);
      this._processLines(combined.slice(0, lastNewline + 1), filePath);
    } catch (err) {
      console.error('[WakfuCombatLogReader] Error reading', filePath, err.message);
    } finally {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch { /* ignore */ }
      }
    }
  }

  _processLines(text, sourceFile) {
    for (const line of text.split(/\r?\n/)) {
      if (!line) continue;
      if (this._onLine) {
        try {
          this._onLine(line);
        } catch (err) {
          console.error('[WakfuCombatLogReader] onLine handler failed:', err.message);
        }
      }
      this._emitCastFrom(line, sourceFile);
    }
  }

  _emitCastFrom(line, sourceFile) {
    const pattern = new RegExp(
      WakfuCombatLogReader.COMBAT_SPELL_CAST_PATTERN.source,
      WakfuCombatLogReader.COMBAT_SPELL_CAST_PATTERN.flags
    );

    for (const match of line.matchAll(pattern)) {
      const characterName = String(match[1] || '').trim();
      const spellName = String(match[2] || '').trim();
      if (!characterName || !spellName) continue;

      const now = Date.now();
      const key = `${characterName}\u0000${spellName}`;
      if (key === this._lastEmittedKey && now - this._lastEmittedAt < WakfuCombatLogReader.DEDUPE_WINDOW_MS) {
        continue;
      }
      this._lastEmittedKey = key;
      this._lastEmittedAt = now;

      this._onCastEvent({
        characterName,
        spellName,
        timestamp: now,
        sourceFile,
      });
    }
  }
}

module.exports = { WakfuCombatLogReader };
