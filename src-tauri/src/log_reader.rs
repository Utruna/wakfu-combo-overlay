//! Tails Wakfu's main combat log file and turns what gets appended into lines
//! and spell-cast events.
//!
//! Only wakfu.log is read. Wakfu also echoes combat lines into wakfu_chat.log
//! (the in-game chat mirrors combat info) — watching every *.log file was
//! tried first but double-counts every single cast because of that echo, so
//! wakfu.log is the one authoritative source here.
//!
//! Polling only: filesystem notifications are unreliable on Windows for a file
//! another process keeps open and appends to, and a stat every few hundred ms
//! costs nothing.

use regex::Regex;
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::time::{SystemTime, UNIX_EPOCH};

pub const MAIN_LOG_FILE_NAME: &str = "wakfu.log";

// When two local Wakfu clients share the same fight, each client's own
// process logs the whole fight's combat feed — so the same cast can appear as
// two near-simultaneous real lines in wakfu.log (observed a few ms to ~20ms
// apart). A human can't legitimately recast the identical spell that fast, so
// a short suppression window filters the game's own duplicate without needing
// to know which client "really" cast it.
const DEDUPE_WINDOW_MS: i64 = 500;

// Size of a single read, so a huge burst (or a file that was rotated while we
// weren't looking) is processed piecewise instead of in one unbounded buffer.
const READ_CHUNK_BYTES: usize = 64 * 1024;

// Combat cast line format: "[Information (combat)] Lueur Pourpre lance le sort Saignée mortelle"
static COMBAT_SPELL_CAST: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?im)\[Information\s+\(combat\)\]\s+([^:]+?)\s+lance\s+le\s+sort\s+(.+?)(?:\s*\(|$)")
        .expect("valid regex")
});

/// `%APPDATA%\zaap\gamesLogs\wakfu\logs`, where the Ankama launcher puts them.
pub fn default_logs_dir() -> PathBuf {
    let roaming = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Users\Default\AppData\Roaming"));
    roaming.join("zaap").join("gamesLogs").join("wakfu").join("logs")
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64)
}

#[derive(Debug, Clone)]
pub struct CastEvent {
    pub character_name: String,
    pub spell_name: String,
    pub timestamp: i64,
}

/// In log order: every complete line, each followed by the cast it holds (if any).
#[derive(Debug)]
pub enum LogEvent {
    Line(String),
    Cast(CastEvent),
}

struct FileState {
    /// In bytes, so only newly appended bytes are ever read instead of
    /// re-reading the whole — ever-growing — log on every tick.
    position: u64,
    /// The tail of a line the game is still writing. Kept as bytes: a
    /// multi-byte UTF-8 character (é, è… are everywhere in French spell
    /// names) may be split across two reads, but never across a '\n'.
    pending: Vec<u8>,
}

pub struct WakfuCombatLogReader {
    logs_dir: PathBuf,
    files: HashMap<PathBuf, FileState>,
    last_emitted: Option<(String, String)>,
    last_emitted_at: i64,
}

impl WakfuCombatLogReader {
    /// Seeds every existing log file at EOF, so only content appended from
    /// now on is ever emitted (no replay of past casts as "just happened").
    pub fn new(logs_dir: impl Into<PathBuf>) -> Self {
        let mut reader = Self {
            logs_dir: logs_dir.into(),
            files: HashMap::new(),
            last_emitted: None,
            last_emitted_at: 0,
        };
        for path in reader.list_log_files() {
            let size = file_size(&path);
            reader.files.insert(path, FileState { position: size, pending: Vec::new() });
        }
        reader
    }

    pub fn logs_dir(&self) -> &Path {
        &self.logs_dir
    }

    /// Read whatever was appended since the last scan. Works even if the
    /// directory doesn't exist yet — e.g. Wakfu never launched on this
    /// machine — so it's picked up as soon as it appears.
    pub fn scan(&mut self) -> Vec<LogEvent> {
        let mut events = Vec::new();
        for path in self.list_log_files() {
            self.read_incremental(&path, &mut events);
        }
        events
    }

    fn list_log_files(&self) -> Vec<PathBuf> {
        let Ok(entries) = fs::read_dir(&self.logs_dir) else {
            return Vec::new();
        };
        entries
            .filter_map(Result::ok)
            .filter(|e| e.file_name().to_string_lossy().eq_ignore_ascii_case(MAIN_LOG_FILE_NAME))
            .map(|e| e.path())
            .collect()
    }

    fn read_incremental(&mut self, path: &Path, events: &mut Vec<LogEvent>) {
        let Some(state) = self.files.get_mut(path) else {
            // Newly-discovered file — seed at EOF too, don't replay its
            // existing content as new casts.
            let size = file_size(path);
            self.files.insert(path.to_path_buf(), FileState { position: size, pending: Vec::new() });
            return;
        };

        // Nothing new: the common case on every tick, settled by a stat alone.
        let size = file_size(path);
        if size == state.position {
            return;
        }
        // std opens with FILE_SHARE_READ | WRITE | DELETE: the game can keep
        // writing (and rotating) the log while it's open here.
        let Ok(mut file) = File::open(path) else { return };
        if size < state.position {
            // Shorter than last time: the log was truncated/recreated (e.g.
            // the client restarted). Everything in it was written since our
            // last tick, so read it from the start rather than skipping it.
            state.position = 0;
            state.pending.clear();
        }
        if file.seek(SeekFrom::Start(state.position)).is_err() {
            return;
        }

        // Read until EOF rather than up to `size`: the game may still be
        // appending, and whatever lands meanwhile is simply picked up now.
        let mut chunk = vec![0u8; READ_CHUNK_BYTES];
        let mut lines = Vec::new();
        loop {
            let read = match file.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => n,
            };
            state.position += read as u64;
            state.pending.extend_from_slice(&chunk[..read]);
            // Only complete lines are parsed. A line the game is still in
            // the middle of writing is kept for the next read, so a cast is
            // never missed or emitted with a truncated spell name.
            if let Some(last_newline) = state.pending.iter().rposition(|&b| b == b'\n') {
                let rest = state.pending.split_off(last_newline + 1);
                let complete = std::mem::replace(&mut state.pending, rest);
                for raw in complete.split(|&b| b == b'\n') {
                    let line = String::from_utf8_lossy(raw);
                    let line = line.trim_end_matches('\r');
                    if !line.is_empty() {
                        lines.push(line.to_string());
                    }
                }
            }
        }
        for line in lines {
            self.process_line(line, events);
        }
    }

    fn process_line(&mut self, line: String, events: &mut Vec<LogEvent>) {
        let mut casts = Vec::new();
        for m in COMBAT_SPELL_CAST.captures_iter(&line) {
            let character_name = m[1].trim().to_string();
            let spell_name = m[2].trim().to_string();
            if character_name.is_empty() || spell_name.is_empty() {
                continue;
            }
            let now = now_ms();
            let key = (character_name, spell_name);
            if self.last_emitted.as_ref() == Some(&key) && now - self.last_emitted_at < DEDUPE_WINDOW_MS {
                continue;
            }
            self.last_emitted_at = now;
            self.last_emitted = Some(key.clone());
            casts.push(CastEvent { character_name: key.0, spell_name: key.1, timestamp: now });
        }
        events.push(LogEvent::Line(line));
        events.extend(casts.into_iter().map(LogEvent::Cast));
    }
}

fn file_size(path: &Path) -> u64 {
    fs::metadata(path).map_or(0, |m| m.len())
}
