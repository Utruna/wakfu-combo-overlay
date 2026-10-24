//! Persists user-editable combo-overlay settings: the tracked character
//! roster, which of them are currently tracked, and how the combo list is laid
//! out.
//!
//! Same settings.json as the 1.x (Electron) versions, same place: the state is
//! kept as plain JSON, so fields this version doesn't know about survive a
//! rewrite.
//!
//! Heroes are keyed by `characterName` (the exact in-game name, already
//! required to be unique for combat-log matching) rather than array position,
//! so adding/removing a character never invalidates other stored references.

use serde_json::{json, Map, Value};
use std::fs;
use std::path::{Path, PathBuf};

// Spell icons are 32x32 source PNGs; larger sizes upscale with
// `image-rendering: pixelated` (see ui/overlay/style.css), which is the
// intended crisp-pixel look rather than a blurry stretch.
pub const DEFAULT_ICON_SIZE: i64 = 32;
pub const MIN_ICON_SIZE: i64 = 16;
pub const MAX_ICON_SIZE: i64 = 128;

// How long a cast icon stays on the overlay before fading out.
pub const DEFAULT_CAST_LIFETIME_MS: i64 = 6000;
pub const MIN_CAST_LIFETIME_MS: i64 = 1000;
pub const MAX_CAST_LIFETIME_MS: i64 = 60000;

pub const DEFAULT_MAX_VISIBLE_CASTS: i64 = 8;
pub const MIN_MAX_VISIBLE_CASTS: i64 = 1;
pub const MAX_MAX_VISIBLE_CASTS: i64 = 20;

pub const DEFAULT_OVERLAY_PORT: u16 = 3457;

/// JavaScript's truthiness, for values written by the settings page.
fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// JavaScript's `Number(value)`, or None where it would give NaN.
fn to_number(value: &Value) -> Option<f64> {
    match value {
        Value::Number(n) => n.as_f64(),
        Value::String(s) if s.trim().is_empty() => Some(0.0),
        Value::String(s) => s.trim().parse().ok(),
        Value::Bool(b) => Some(f64::from(u8::from(*b))),
        Value::Null => Some(0.0),
        _ => None,
    }
    .filter(|f| f.is_finite())
}

/// JavaScript's `String(value || '').trim()`.
fn to_trimmed_string(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(s)) => s.trim().to_string(),
        Some(v) if truthy(Some(v)) => v.to_string().trim().to_string(),
        _ => String::new(),
    }
}

fn clamp_rounded(value: &Value, fallback: i64, min: i64, max: i64) -> i64 {
    match to_number(value) {
        // Math.round: halves go up.
        Some(f) => ((f + 0.5).floor() as i64).clamp(min, max),
        None => fallback,
    }
}

pub fn clamp_icon_size(value: &Value, fallback: i64) -> i64 {
    clamp_rounded(value, fallback, MIN_ICON_SIZE, MAX_ICON_SIZE)
}

pub fn clamp_cast_lifetime(value: &Value, fallback: i64) -> i64 {
    clamp_rounded(value, fallback, MIN_CAST_LIFETIME_MS, MAX_CAST_LIFETIME_MS)
}

pub fn clamp_max_visible_casts(value: &Value, fallback: i64) -> i64 {
    clamp_rounded(value, fallback, MIN_MAX_VISIBLE_CASTS, MAX_MAX_VISIBLE_CASTS)
}

fn is_valid_class_icon_side(side: Option<&Value>) -> bool {
    matches!(side.and_then(Value::as_str), Some("left" | "right"))
}

/// An integer in the unprivileged TCP range.
pub fn parse_port(value: &Value) -> Option<u16> {
    let f = to_number(value)?;
    (f.fract() == 0.0 && (1024.0..=65535.0).contains(&f)).then_some(f as u16)
}

pub struct Defaults {
    pub overlay_port: u16,
    pub logs_dir: String,
}

pub fn default_combo_layout() -> Value {
    json!({
        "orientation": "vertical",
        "direction": "top-to-bottom",
        "iconSize": DEFAULT_ICON_SIZE,
        "castLifetimeMs": DEFAULT_CAST_LIFETIME_MS,
        "maxVisibleCasts": DEFAULT_MAX_VISIBLE_CASTS,
        "previewEnabled": false,
        "damageCounterEnabled": true,
        "classIconSide": "left",
    })
}

pub struct SettingsStore {
    path: PathBuf,
    state: Map<String, Value>,
}

impl SettingsStore {
    pub fn open(path: impl Into<PathBuf>) -> Self {
        let path = path.into();
        let state = read_or_empty(&path);
        Self { path, state }
    }

    /// Fill in any missing fields with defaults (e.g. on first run),
    /// persisting only if something was actually missing.
    pub fn ensure_defaults(&mut self, defaults: &Defaults) {
        let mut changed = false;
        let mut fill = |state: &mut Map<String, Value>, key: &str, value: Value| {
            if !truthy(state.get(key)) {
                state.insert(key.to_string(), value);
                changed = true;
            }
        };
        fill(&mut self.state, "heroes", json!([]));
        fill(&mut self.state, "trackedCharacterNames", json!([]));
        fill(&mut self.state, "overlayPort", json!(defaults.overlay_port));
        fill(&mut self.state, "logsDir", json!(defaults.logs_dir));

        match self.state.get_mut("comboLayout").and_then(Value::as_object_mut) {
            None => {
                self.state.insert("comboLayout".into(), default_combo_layout());
                changed = true;
            }
            Some(layout) => {
                // Added after the first releases — settings files from those
                // versions have a comboLayout without these.
                let defaults = default_combo_layout();
                for key in ["iconSize", "castLifetimeMs", "maxVisibleCasts"] {
                    if !truthy(layout.get(key)) {
                        layout.insert(key.into(), defaults[key].clone());
                        changed = true;
                    }
                }
                for key in ["previewEnabled", "damageCounterEnabled"] {
                    if layout.get(key).is_none_or(Value::is_null) {
                        layout.insert(key.into(), defaults[key].clone());
                        changed = true;
                    }
                }
                // Before this was a setting, the class icon's side followed
                // the list direction — derive it from that so existing
                // overlays don't move.
                if !is_valid_class_icon_side(layout.get("classIconSide")) {
                    let reversed = matches!(
                        layout.get("direction").and_then(Value::as_str),
                        Some("bottom-to-top" | "right-to-left")
                    );
                    layout.insert("classIconSide".into(), json!(if reversed { "right" } else { "left" }));
                    changed = true;
                }
            }
        }
        if changed {
            self.persist();
        }
    }

    pub fn heroes(&self) -> &[Value] {
        self.state.get("heroes").and_then(Value::as_array).map_or(&[], Vec::as_slice)
    }

    pub fn tracked_character_names(&self) -> Vec<String> {
        self.state
            .get("trackedCharacterNames")
            .and_then(Value::as_array)
            .map(|names| names.iter().filter_map(Value::as_str).map(str::to_string).collect())
            .unwrap_or_default()
    }

    pub fn is_tracked(&self, character_name: &str) -> bool {
        self.state
            .get("trackedCharacterNames")
            .and_then(Value::as_array)
            .is_some_and(|names| names.iter().any(|n| n.as_str() == Some(character_name)))
    }

    pub fn combo_layout(&self) -> Value {
        self.state.get("comboLayout").cloned().unwrap_or_else(default_combo_layout)
    }

    pub fn overlay_port(&self) -> u16 {
        self.state.get("overlayPort").and_then(parse_port).unwrap_or(DEFAULT_OVERLAY_PORT)
    }

    pub fn logs_dir(&self) -> PathBuf {
        PathBuf::from(self.state.get("logsDir").and_then(Value::as_str).unwrap_or_default())
    }

    pub fn onboarding_done(&self) -> bool {
        truthy(self.state.get("onboardingDone"))
    }

    pub fn set_overlay_port(&mut self, port: u16) {
        self.state.insert("overlayPort".into(), json!(port));
        self.persist();
    }

    /// Existence isn't checked here — the diagnostics panel reports
    /// found/not-found separately, since the user may be pointing at a
    /// location Wakfu hasn't written to yet.
    pub fn set_logs_dir(&mut self, dir: &str) -> bool {
        let dir = dir.trim();
        if dir.is_empty() {
            return false;
        }
        self.state.insert("logsDir".into(), json!(dir));
        self.persist();
        true
    }

    pub fn set_tracked_heroes(&mut self, names: &[Value]) {
        let mut tracked: Vec<String> = Vec::new();
        for name in names.iter().filter_map(Value::as_str).filter(|n| !n.is_empty()) {
            if !tracked.iter().any(|t| t == name) {
                tracked.push(name.to_string());
            }
        }
        self.state.insert("trackedCharacterNames".into(), json!(tracked));
        self.persist();
    }

    fn set_tracked(&mut self, character_name: &str, tracked: bool) {
        let mut names = self.tracked_character_names();
        names.retain(|n| n != character_name);
        if tracked {
            names.push(character_name.to_string());
        }
        self.state.insert("trackedCharacterNames".into(), json!(names));
    }

    /// Merge a partial layout change into the stored one. Out-of-range
    /// numeric values are clamped rather than rejected, so a stray value can't
    /// leave the overlay with unreadable icons or casts that never disappear.
    pub fn set_combo_layout(&mut self, change: &Map<String, Value>) -> Value {
        let current = self.combo_layout();
        let mut merged = current.as_object().cloned().unwrap_or_default();
        merged.extend(change.clone());

        let old_int = |key: &str, fallback: i64| current.get(key).and_then(Value::as_i64).unwrap_or(fallback);
        if let Some(v) = change.get("iconSize") {
            merged.insert("iconSize".into(), json!(clamp_icon_size(v, old_int("iconSize", DEFAULT_ICON_SIZE))));
        }
        if let Some(v) = change.get("castLifetimeMs") {
            let fallback = old_int("castLifetimeMs", DEFAULT_CAST_LIFETIME_MS);
            merged.insert("castLifetimeMs".into(), json!(clamp_cast_lifetime(v, fallback)));
        }
        if let Some(v) = change.get("maxVisibleCasts") {
            let fallback = old_int("maxVisibleCasts", DEFAULT_MAX_VISIBLE_CASTS);
            merged.insert("maxVisibleCasts".into(), json!(clamp_max_visible_casts(v, fallback)));
        }
        for key in ["previewEnabled", "damageCounterEnabled"] {
            if let Some(v) = change.get(key) {
                merged.insert(key.into(), json!(truthy(Some(v))));
            }
        }
        if change.contains_key("classIconSide") && !is_valid_class_icon_side(change.get("classIconSide")) {
            let old = current.get("classIconSide").cloned().unwrap_or_else(|| json!("left"));
            merged.insert("classIconSide".into(), old);
        }

        let merged = Value::Object(merged);
        self.state.insert("comboLayout".into(), merged.clone());
        self.persist();
        merged
    }

    /// Remembers that the first-launch assistant was completed or skipped.
    pub fn set_onboarding_done(&mut self) {
        self.state.insert("onboardingDone".into(), json!(true));
        self.persist();
    }

    fn heroes_mut(&mut self) -> &mut Vec<Value> {
        let heroes = self.state.entry("heroes").or_insert_with(|| json!([]));
        if !heroes.is_array() {
            *heroes = json!([]);
        }
        heroes.as_array_mut().expect("just made an array")
    }

    fn hero_index(&self, character_name: &str) -> Option<usize> {
        self.heroes()
            .iter()
            .position(|h| h.get("characterName").and_then(Value::as_str) == Some(character_name))
    }

    /// Add a new tracked character. Rejects a duplicate/blank characterName
    /// (it's the matching key, so it must stay unique). `index` and `tracked`
    /// put a just-removed hero back exactly as it was.
    pub fn add_hero(&mut self, hero: &Value, index: Option<usize>, tracked: bool) -> bool {
        let character_name = to_trimmed_string(hero.get("characterName"));
        if character_name.is_empty() || self.hero_index(&character_name).is_some() {
            return false;
        }
        let name = Some(to_trimmed_string(hero.get("name")))
            .filter(|n| !n.is_empty())
            .unwrap_or_else(|| character_name.clone());
        let class = Some(to_trimmed_string(hero.get("class"))).filter(|c| !c.is_empty());
        let entry = json!({
            "name": name,
            "characterName": character_name,
            "color": hero.get("color").cloned().unwrap_or(Value::Null),
            "class": class,
        });

        let heroes = self.heroes_mut();
        let at = index.map_or(heroes.len(), |i| i.min(heroes.len()));
        heroes.insert(at, entry);
        if tracked {
            self.set_tracked(&character_name, true);
        }
        self.persist();
        true
    }

    /// Update an existing hero's overlay color.
    pub fn set_hero_color(&mut self, character_name: &str, color: Value) -> bool {
        let Some(index) = self.hero_index(character_name) else { return false };
        self.heroes_mut()[index]["color"] = color;
        self.persist();
        true
    }

    /// Rename a hero and/or change its class. The characterName is the
    /// matching key, so a rename is rejected when blank or already taken; its
    /// tracked state carries over to the new name.
    pub fn update_hero(&mut self, character_name: &str, changes: &Value) -> bool {
        let Some(index) = self.hero_index(character_name) else { return false };
        let mut hero = self.heroes()[index].clone();
        let mut renamed_to = None;

        if changes.get("characterName").is_some() {
            let new_name = to_trimmed_string(changes.get("characterName"));
            if new_name.is_empty() {
                return false;
            }
            if new_name != character_name {
                if self.hero_index(&new_name).is_some() {
                    return false;
                }
                // `name` is only a display alias; keep it in sync unless it was customized.
                if hero.get("name").and_then(Value::as_str) == Some(character_name) {
                    hero["name"] = json!(new_name);
                }
                hero["characterName"] = json!(new_name);
                renamed_to = Some(new_name);
            }
        }
        if changes.get("class").is_some() {
            let class = to_trimmed_string(changes.get("class"));
            hero["class"] = if class.is_empty() { Value::Null } else { json!(class) };
        }

        self.heroes_mut()[index] = hero;
        if let Some(new_name) = renamed_to {
            if self.is_tracked(character_name) {
                let names: Vec<String> = self
                    .tracked_character_names()
                    .into_iter()
                    .map(|n| if n == character_name { new_name.clone() } else { n })
                    .collect();
                self.state.insert("trackedCharacterNames".into(), json!(names));
            }
        }
        self.persist();
        true
    }

    pub fn remove_hero(&mut self, character_name: &str) {
        self.heroes_mut()
            .retain(|h| h.get("characterName").and_then(Value::as_str) != Some(character_name));
        self.set_tracked(character_name, false);
        self.persist();
    }

    fn backup_path(&self) -> PathBuf {
        with_suffix(&self.path, ".bak")
    }

    fn persist(&self) {
        // Write-then-rename: writing settings.json in place leaves it empty or
        // half-written if the app is killed mid-write (PC shutdown, update
        // install, crash) — and an unreadable file silently resets every
        // setting (port, heroes…) on the next launch. A rename is atomic, so
        // the file is always either the old or the new version, never a mix.
        let result = (|| -> std::io::Result<()> {
            if let Some(dir) = self.path.parent() {
                fs::create_dir_all(dir)?;
            }
            let tmp = with_suffix(&self.path, ".tmp");
            let text = serde_json::to_string_pretty(&self.state).map_err(std::io::Error::other)?;
            fs::write(&tmp, text)?;
            if self.path.exists() {
                fs::copy(&self.path, self.backup_path())?;
            }
            fs::rename(&tmp, &self.path)
        })();
        if let Err(err) = result {
            eprintln!("[SettingsStore] Failed to persist settings: {err}");
        }
    }
}

fn with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(suffix);
    PathBuf::from(name)
}

fn read_or_empty(path: &Path) -> Map<String, Value> {
    for (i, candidate) in [path.to_path_buf(), with_suffix(path, ".bak")].iter().enumerate() {
        let parsed = fs::read_to_string(candidate)
            .ok()
            .and_then(|text| serde_json::from_str::<Value>(text.trim_start_matches('\u{feff}')).ok());
        if let Some(Value::Object(map)) = parsed {
            if i > 0 {
                eprintln!("[SettingsStore] settings.json unreadable, restored from backup.");
            }
            return map;
        }
    }
    Map::new()
}
