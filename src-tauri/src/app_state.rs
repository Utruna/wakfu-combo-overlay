//! Runtime state shared by the log-reader thread, the overlay server and the
//! settings window's commands — and what turns log events into overlay events.

use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

use crate::catalog::Catalog;
use crate::log_reader::{now_ms, CastEvent, LogEvent, WakfuCombatLogReader};
use crate::matcher::find_hero_index;
use crate::overlay_server::{FileSource, OverlayHub, OverlayServer};
use crate::settings::SettingsStore;
use crate::turn_tracker::{CombatTurnTracker, TurnUpdateKind};

/// How often the log is checked for new lines.
const LOG_POLL_INTERVAL: Duration = Duration::from_millis(300);

pub const SETTINGS_WINDOW: &str = "settings";

pub struct Core {
    pub settings: SettingsStore,
    pub tracker: CombatTurnTracker,
    /// When a tracked hero's cast last reached the overlay, for diagnostics.
    pub last_cast_at: Option<i64>,
    /// Why the overlay server isn't listening, or None when it is.
    pub overlay_error: Option<String>,
    pub obs_loader_path: Option<PathBuf>,
}

pub struct AppState {
    pub core: Mutex<Core>,
    pub catalog: Catalog,
    pub hub: Arc<OverlayHub>,
    pub files: FileSource,
    pub overlay: Mutex<Option<OverlayServer>>,
    pub reader: Mutex<Option<LogReaderThread>>,
    /// %APPDATA%\Wakfu Combo Overlay — settings.json and the OBS loader page.
    pub data_dir: PathBuf,
}

impl AppState {
    /// The display config the overlay needs: the layout plus the icons.
    pub fn overlay_config(&self, layout: &Value) -> Value {
        let mut config = layout.as_object().cloned().unwrap_or_default();
        config.insert("classIcons".into(), Value::Object(self.catalog.class_icons.clone()));
        config.insert("previewPool".into(), self.catalog.preview_pool.clone());
        Value::Object(config)
    }

    pub async fn start_overlay(&self, port: u16) -> Result<OverlayServer, String> {
        OverlayServer::start(port, self.hub.clone(), self.files.clone()).await
    }
}

/// The configured, currently tracked hero playing under this name.
fn tracked_hero<'a>(settings: &'a SettingsStore, character_name: &str) -> Option<&'a Value> {
    let heroes = settings.heroes();
    let hero = &heroes[find_hero_index(character_name, heroes)?];
    let key = hero.get("characterName").and_then(Value::as_str)?;
    settings.is_tracked(key).then_some(hero)
}

fn str_field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

/// Sends an entry to the settings window's live activity panel (if open).
pub fn push_debug_event(app: &AppHandle, entry: Value) {
    if entry["status"] == "broadcast" {
        if let Some(state) = app.try_state::<AppState>() {
            let at = entry["timestamp"].as_i64().unwrap_or_else(now_ms);
            state.core.lock().unwrap().last_cast_at = Some(at);
        }
    }
    println!(
        "[debug] {} — {} -> {}",
        entry["status"].as_str().unwrap_or_default(),
        entry["characterName"].as_str().unwrap_or_default(),
        entry["spellName"].as_str().unwrap_or_default()
    );
    if app.get_webview_window(SETTINGS_WINDOW).is_some() {
        let _ = app.emit_to(SETTINGS_WINDOW, "debug:event", entry);
    }
}

fn handle_events(app: &AppHandle, state: &AppState, events: Vec<LogEvent>) {
    let mut debug_events = Vec::new();
    {
        let mut core = state.core.lock().unwrap();
        let Core { settings, tracker, .. } = &mut *core;
        let is_ally = |name: &str| find_hero_index(name, settings.heroes()).is_some();
        for event in events {
            match event {
                LogEvent::Line(line) => {
                    // Only the tracked heroes' turns reach the overlay: a
                    // monster's or another player's turn leaves the last
                    // hero's total on screen until it fades.
                    for update in tracker.process_line(&line, &is_ally) {
                        let Some(hero) = tracked_hero(settings, &update.character_name) else { continue };
                        state.hub.broadcast_turn_damage(&json!({
                            "characterName": update.character_name,
                            "heroName": hero.get("name"),
                            "class": hero.get("class"),
                            "color": hero.get("color"),
                            "turnId": update.turn_id,
                            "total": update.total,
                            "amount": update.amount.unwrap_or(0),
                            "ended": update.kind == TurnUpdateKind::End,
                            "timestamp": now_ms(),
                        }));
                    }
                }
                LogEvent::Cast(cast) => {
                    debug_events.push(handle_cast(state, settings, tracker, cast));
                }
            }
        }
    }
    for entry in debug_events {
        push_debug_event(app, entry);
    }
}

/// Sends a tracked hero's cast to the overlay. Returns the activity-panel
/// entry describing what happened to it.
fn handle_cast(state: &AppState, settings: &SettingsStore, tracker: &CombatTurnTracker, cast: CastEvent) -> Value {
    // A summon's casts (Osamodas creature, Double Sram…) show up as its
    // summoner's — the tracker has already seen the summon line by now.
    let summoner = tracker.owner_of(&cast.character_name);
    let heroes = settings.heroes();
    let Some(index) = find_hero_index(summoner.as_deref().unwrap_or(&cast.character_name), heroes) else {
        // A random player or mob.
        return json!({
            "status": "ignored-unmatched",
            "characterName": cast.character_name,
            "spellName": cast.spell_name,
            "timestamp": cast.timestamp,
        });
    };
    let hero = &heroes[index];
    let hero_name = hero.get("name").cloned().unwrap_or(Value::Null);
    if !settings.is_tracked(str_field(hero, "characterName").unwrap_or_default()) {
        return json!({
            "status": "ignored-untracked",
            "characterName": cast.character_name,
            "heroName": hero_name,
            "spellName": cast.spell_name,
            "timestamp": cast.timestamp,
        });
    }

    let hero_class = str_field(hero, "class");
    // Summon spells (monster spells) mostly have no icon of their own: fall
    // back to the summoner's spell that brought the creature in.
    let icon = state.catalog.spell_icon(hero_class, &cast.spell_name).or_else(|| {
        summoner.as_ref()?;
        let spell = tracker.summoning_spell_of(&cast.character_name)?;
        state.catalog.spell_icon(hero_class, &spell)
    });

    state.hub.broadcast_cast(&json!({
        "characterName": cast.character_name,
        "heroName": hero_name,
        "class": hero_class,
        "classIcon": state.catalog.class_icon(hero_class),
        "spellName": cast.spell_name,
        "summon": summoner.is_some(),
        "color": hero.get("color"),
        "timestamp": cast.timestamp,
        "icon": icon,
    }));
    json!({
        "status": "broadcast",
        "characterName": cast.character_name,
        "heroName": hero_name,
        "heroClass": hero_class,
        "spellName": cast.spell_name,
        "summonOf": summoner,
        "iconMissing": icon.is_none(),
        "timestamp": cast.timestamp,
    })
}

/// The thread tailing wakfu.log. Stops (within one poll interval) when dropped.
pub struct LogReaderThread {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl LogReaderThread {
    pub fn start(app: AppHandle, logs_dir: PathBuf) -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let stop_flag = stop.clone();
        let thread = thread::Builder::new()
            .name("log-reader".into())
            .stack_size(256 * 1024)
            .spawn(move || {
                let mut reader = WakfuCombatLogReader::new(&logs_dir);
                if logs_dir.is_dir() {
                    println!("[WakfuCombatLogReader] Watching {}", logs_dir.display());
                } else {
                    println!("[WakfuCombatLogReader] Logs dir not found (will keep polling): {}", logs_dir.display());
                }
                while !stop_flag.load(Ordering::Relaxed) {
                    let events = reader.scan();
                    if !events.is_empty() {
                        if let Some(state) = app.try_state::<AppState>() {
                            handle_events(&app, &state, events);
                        }
                    }
                    thread::park_timeout(LOG_POLL_INTERVAL);
                }
            })
            .expect("spawn log-reader thread");
        Self { stop, thread: Some(thread) }
    }
}

impl Drop for LogReaderThread {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(thread) = self.thread.take() {
            thread.thread().unpark();
            let _ = thread.join();
        }
    }
}
