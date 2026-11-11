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

// How much of a file's beginning is remembered to tell a recreated log from
// the same one that merely grew (each line starts with a timestamp, so two
// different logs never begin alike).
const HEAD_BYTES: usize = 64;

// Combat cast line format: "[Information (combat)] Lueur Pourpre lance le sort Saignée mortelle"
static COMBAT_SPELL_CAST: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?im)\[Information\s+\(combat\)\]\s+([^:]+?)\s+lance\s+le\s+sort\s+(.+?)(?:\s*\(|$)")
        .expect("valid regex")
});

/// Where the Ankama launcher has the game write its logs, under its own data
/// folder ("zaap", an Electron app).
const ZAAP_LOGS: [&str; 4] = ["zaap", "gamesLogs", "wakfu", "logs"];

fn zaap_logs_in(app_data: PathBuf) -> PathBuf {
    ZAAP_LOGS.iter().fold(app_data, |dir, part| dir.join(part))
}

/// The folder watched until the user picks another: the likeliest of
/// `logs_dir_candidates`.
pub fn default_logs_dir() -> PathBuf {
    pick_logs_dir(&logs_dir_candidates())
}

/// `%APPDATA%\zaap\gamesLogs\wakfu\logs`.
#[cfg(windows)]
pub fn logs_dir_candidates() -> Vec<PathBuf> {
    vec![zaap_logs_in(crate::user_dirs::app_data())]
}

#[cfg(not(windows))]
pub fn logs_dir_candidates() -> Vec<PathBuf> {
    logs_dir_candidates_in(&crate::user_dirs::home(), crate::user_dirs::app_data())
}

/// Where Wakfu's logs can be, most likely first: the native launcher's folder
/// (`app_data`, where Electron keeps an app's data: `~/.config/zaap` on Linux,
/// `~/Library/Application Support/zaap` on macOS), then the Windows
/// launcher's, inside each Wine prefix found — Wine, Steam's Proton, Lutris,
/// Bottles, CrossOver, Whisky. Not all of them exist.
#[cfg(not(windows))]
pub fn logs_dir_candidates_in(home: &Path, app_data: PathBuf) -> Vec<PathBuf> {
    let mut candidates = vec![zaap_logs_in(app_data)];
    let mut seen = Vec::new();
    for prefix in wine_prefixes(home) {
        // ~/.steam/steam is a link to ~/.local/share/Steam: one prefix, two paths.
        let real = fs::canonicalize(&prefix).unwrap_or_else(|_| prefix.clone());
        if seen.contains(&real) {
            continue;
        }
        seen.push(real);
        for user in subdirs(&prefix.join("drive_c").join("users")) {
            candidates.push(zaap_logs_in(user.join("AppData").join("Roaming")));
        }
    }
    candidates
}

#[cfg(not(windows))]
fn wine_prefixes(home: &Path) -> Vec<PathBuf> {
    let mut prefixes = vec![home.join(".wine")];
    for steam in [".steam/steam", ".local/share/Steam", ".var/app/com.valvesoftware.Steam/.local/share/Steam"] {
        let compatdata = home.join(steam).join("steamapps").join("compatdata");
        prefixes.extend(subdirs(&compatdata).into_iter().map(|game| game.join("pfx")));
    }
    for bottles in [
        "Games", // Lutris: one prefix per game
        ".local/share/bottles/bottles",
        ".var/app/com.usebottles.bottles/data/bottles/bottles",
        "Library/Application Support/CrossOver/Bottles",
        "Library/Containers/com.isaacmarovitz.Whisky/Bottles",
    ] {
        prefixes.extend(subdirs(&home.join(bottles)));
    }
    prefixes
}

#[cfg(not(windows))]
fn subdirs(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(dir) else { return Vec::new() };
    let mut dirs: Vec<PathBuf> = entries.filter_map(Result::ok).map(|e| e.path()).filter(|p| p.is_dir()).collect();
    dirs.sort();
    dirs
}

/// The candidate whose wakfu.log was written last — the game in use, when
/// several are installed. Failing that, the first that exists (the game was
/// installed but never played), and failing that the first: the folder the
/// game will create once launched.
pub fn pick_logs_dir(candidates: &[PathBuf]) -> PathBuf {
    let written_at = |dir: &PathBuf| fs::metadata(dir.join(MAIN_LOG_FILE_NAME)).and_then(|m| m.modified()).ok();
    candidates
        .iter()
        .filter_map(|dir| Some((written_at(dir)?, dir)))
        .max_by_key(|(at, _)| *at)
        .map(|(_, dir)| dir)
        .or_else(|| candidates.iter().find(|dir| dir.is_dir()))
        .or(candidates.first())
        .cloned()
        .unwrap_or_default()
}

/// The folder to switch to when `current` was a default picked before the
/// game wrote any log there (installed later, or run some other way) and
/// another candidate now has them. A folder the user chose is left alone.
pub fn redetected_logs_dir(current: &Path, candidates: &[PathBuf]) -> Option<PathBuf> {
    let has_log = |dir: &Path| dir.join(MAIN_LOG_FILE_NAME).is_file();
    if !candidates.iter().any(|c| c == current) || has_log(current) {
        return None;
    }
    Some(pick_logs_dir(candidates)).filter(|picked| has_log(picked))
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
    /// The file's first bytes (up to HEAD_BYTES) as last seen.
    head: Vec<u8>,
}

/// The first bytes of the file, or None if it can't be read.
fn read_head(path: &Path) -> Option<Vec<u8>> {
    let mut head = Vec::new();
    File::open(path).ok()?.take(HEAD_BYTES as u64).read_to_end(&mut head).ok()?;
    Some(head)
}

impl FileState {
    fn at_end(path: &Path) -> Self {
        Self { position: file_size(path), pending: Vec::new(), head: read_head(path).unwrap_or_default() }
    }
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
            let state = FileState::at_end(&path);
            reader.files.insert(path, state);
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
            self.files.insert(path.to_path_buf(), FileState::at_end(path));
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
        // Recreated by the game (new session) with a log already longer than
        // the old position: only its beginning tells it from the old one.
        let Some(head) = read_head(path) else { return };
        let common = state.head.len().min(head.len());
        let recreated = head.len() < state.head.len() || head[..common] != state.head[..common];
        state.head = head;
        if size < state.position || recreated {
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
