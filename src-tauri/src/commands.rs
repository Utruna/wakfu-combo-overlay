//! What the settings window can ask of the app (ui/settings/tauri-api.js
//! exposes these as `window.settingsAPI`).

use crate::app_state::LockExt;
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tokio::sync::oneshot;

use crate::app_state::{push_debug_event, AppState, LogReaderThread, SETTINGS_WINDOW};
use crate::log_reader::now_ms;
use crate::settings::{
    parse_port, DEFAULT_CAST_LIFETIME_MS, DEFAULT_ICON_SIZE, DEFAULT_MAX_VISIBLE_CASTS, MAX_CAST_LIFETIME_MS,
    MAX_ICON_SIZE, MAX_MAX_VISIBLE_CASTS, MIN_CAST_LIFETIME_MS, MIN_ICON_SIZE, MIN_MAX_VISIBLE_CASTS,
};
use crate::{autostart, ingame_window, loader_page, updates, whats_new};

fn overlay_url(port: u16) -> String {
    format!("http://localhost:{port}")
}

#[tauri::command]
pub fn get_state(state: State<AppState>) -> Value {
    let core = state.core.lock_safe();
    let settings = &core.settings;
    json!({
        "heroes": settings.heroes(),
        "trackedCharacterNames": settings.tracked_character_names(),
        "comboLayout": settings.combo_layout(),
        "iconSizeRange": { "min": MIN_ICON_SIZE, "max": MAX_ICON_SIZE, "default": DEFAULT_ICON_SIZE },
        "castLifetimeRange": {
            "min": MIN_CAST_LIFETIME_MS, "max": MAX_CAST_LIFETIME_MS, "default": DEFAULT_CAST_LIFETIME_MS,
        },
        "maxVisibleCastsRange": {
            "min": MIN_MAX_VISIBLE_CASTS, "max": MAX_MAX_VISIBLE_CASTS, "default": DEFAULT_MAX_VISIBLE_CASTS,
        },
        "classIcons": state.catalog.class_icons,
        "previewPool": state.catalog.preview_pool,
        // First launch only: an existing roster means the app was already set
        // up before the assistant existed.
        "showOnboarding": !settings.onboarding_done() && settings.heroes().is_empty(),
    })
}

#[tauri::command]
pub fn set_tracked_heroes(state: State<AppState>, character_names: Vec<Value>) {
    state.core.lock_safe().settings.set_tracked_heroes(&character_names);
}

#[tauri::command]
pub fn set_combo_layout(state: State<AppState>, layout: Map<String, Value>) {
    state.change_combo_layout(&layout);
}

#[tauri::command]
pub fn add_hero(state: State<AppState>, hero: Value, options: Option<Value>) -> bool {
    let options = options.unwrap_or(Value::Null);
    let index = options.get("index").and_then(Value::as_u64).map(|i| i as usize);
    let tracked = options.get("tracked").and_then(Value::as_bool).unwrap_or(true);
    state.core.lock_safe().settings.add_hero(&hero, index, tracked)
}

/// The settings page's hero colours (ui/settings/settings.js PALETTE).
const HERO_PALETTE: [(u8, u8, u8); 8] = [
    (0x4a, 0x90, 0xe2), (0x43, 0xd1, 0xc1), (0x22, 0xc5, 0x5e), (0xfa, 0xcc, 0x15),
    (0xf2, 0x99, 0x4a), (0xe5, 0x39, 0x35), (0xd9, 0x46, 0xef), (0x9b, 0x8c, 0xff),
];

/// The recap's "Ajouter à mes héros": a player of the fight becomes a tracked
/// hero, with the class the recap worked out and the first colour no hero has.
#[tauri::command]
pub fn follow_fighter(app: AppHandle, state: State<AppState>, character_name: String, class: Option<String>) -> bool {
    let added = {
        let mut core = state.core.lock_safe();
        let used: Vec<Value> = core.settings.heroes().iter().filter_map(|h| h.get("color").cloned()).collect();
        let (r, g, b) = HERO_PALETTE
            .iter()
            .copied()
            .find(|&(r, g, b)| !used.contains(&json!({ "r": r, "g": g, "b": b })))
            .unwrap_or(HERO_PALETTE[0]);
        let hero = json!({ "characterName": character_name, "class": class, "color": { "r": r, "g": g, "b": b } });
        core.settings.add_hero(&hero, None, true)
    };
    if added {
        let _ = app.emit_to(SETTINGS_WINDOW, "heroes:changed", ());
    }
    added
}

#[tauri::command]
pub fn update_hero(state: State<AppState>, character_name: String, changes: Value) -> bool {
    state.core.lock_safe().settings.update_hero(&character_name, &changes)
}

#[tauri::command]
pub fn set_onboarding_done(state: State<AppState>) {
    state.core.lock_safe().settings.set_onboarding_done();
}

#[tauri::command]
pub fn set_hero_color(state: State<AppState>, character_name: String, color: Value) -> bool {
    state.core.lock_safe().settings.set_hero_color(&character_name, color)
}

#[tauri::command]
pub fn remove_hero(state: State<AppState>, character_name: String) {
    state.core.lock_safe().settings.remove_hero(&character_name);
}

#[tauri::command]
pub fn get_diagnostics(state: State<AppState>) -> Value {
    let core = state.core.lock_safe();
    let logs_dir = core.settings.logs_dir();
    let port = core.settings.overlay_port();
    json!({
        "logsDir": logs_dir,
        "logsDirExists": logs_dir.exists(),
        "overlayUrl": overlay_url(port),
        "overlayPort": port,
        "overlayClients": state.hub.client_count(),
        "overlayError": core.overlay_error,
        "obsLoaderPath": core.obs_loader_path,
        "lastCastAt": core.last_cast_at,
    })
}

#[tauri::command]
pub fn set_logs_dir(app: AppHandle, state: State<AppState>, dir: String) -> Value {
    let logs_dir = {
        let mut core = state.core.lock_safe();
        let current = core.settings.logs_dir();
        if current.as_os_str() == dir.as_str() {
            return json!({ "ok": true, "logsDir": current, "logsDirExists": current.exists() });
        }
        if !core.settings.set_logs_dir(&dir) {
            return json!({ "ok": false, "error": "Chemin invalide." });
        }
        core.settings.logs_dir()
    };
    let mut reader = state.reader.lock_safe();
    // The old reader must be gone before the new one starts reading.
    drop(reader.take());
    *reader = Some(LogReaderThread::start(app, logs_dir.clone()));
    json!({ "ok": true, "logsDir": logs_dir, "logsDirExists": logs_dir.exists() })
}

#[tauri::command]
pub async fn browse_logs_dir(app: AppHandle, state: State<'_, AppState>) -> Result<Option<String>, ()> {
    let current = state.core.lock_safe().settings.logs_dir();
    let (tx, rx) = oneshot::channel();
    let mut dialog = app.dialog().file().set_title("Choisir le dossier de logs Wakfu");
    if current.is_dir() {
        dialog = dialog.set_directory(current);
    }
    if let Some(window) = app.get_webview_window(SETTINGS_WINDOW) {
        dialog = dialog.set_parent(&window);
    }
    dialog.pick_folder(move |picked| {
        let _ = tx.send(picked);
    });
    Ok(rx.await.ok().flatten().and_then(|p| p.into_path().ok()).map(|p| p.display().to_string()))
}

#[tauri::command]
pub fn show_obs_loader(state: State<AppState>) {
    let Some(path) = state.core.lock_safe().obs_loader_path.clone() else { return };
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = std::process::Command::new("explorer")
            .raw_arg(format!("/select,\"{}\"", path.display()))
            .spawn();
    }
    // Finder, or the desktop's file manager (its D-Bus interface, else the
    // folder opened with xdg-open).
    #[cfg(not(windows))]
    if let Err(err) = tauri_plugin_opener::reveal_item_in_dir(&path) {
        eprintln!("[main] Failed to show {}: {err}", path.display());
    }
}

#[tauri::command]
pub async fn set_overlay_port(app: AppHandle, state: State<'_, AppState>, port: Value) -> Result<Value, ()> {
    let _one_change_at_a_time = state.port_change.lock().await;
    let (current, failed) = {
        let core = state.core.lock_safe();
        (core.settings.overlay_port(), core.overlay_error.is_some())
    };
    let requested = parse_port(&port);
    // Same port only short-circuits when it's actually listening — after a
    // failed bind at startup, re-applying the same port is how to retry it.
    if requested == Some(current) && !failed {
        return Ok(json!({ "ok": true, "overlayUrl": overlay_url(current) }));
    }
    let Some(port) = requested else {
        return Ok(json!({ "ok": false, "error": "Port invalide (doit être entre 1024 et 65535)." }));
    };

    // Bind the new port BEFORE touching the old server or persisting
    // anything: if it's already taken, the current overlay keeps running
    // untouched and settings.json still points at the port that works.
    let server = match state.start_overlay(port).await {
        Ok(server) => server,
        Err(error) => return Ok(json!({ "ok": false, "error": error })),
    };
    *state.overlay.lock_safe() = Some(server);
    {
        let mut core = state.core.lock_safe();
        core.overlay_error = None;
        core.settings.set_overlay_port(port);
        core.obs_loader_path = loader_page::write_loader_page(&state.data_dir, port);
    }
    ingame_window::refresh(&app);
    Ok(json!({ "ok": true, "overlayUrl": overlay_url(port) }))
}

#[tauri::command]
pub fn send_test_cast(app: AppHandle, state: State<AppState>, character_name: String) {
    let hero = {
        let core = state.core.lock_safe();
        let heroes = core.settings.heroes();
        let found = heroes.iter().find(|h| h.get("characterName").and_then(Value::as_str) == Some(&character_name));
        match found.or(heroes.first()) {
            Some(hero) => hero.clone(),
            None => return,
        }
    };
    let hero_class = hero.get("class").and_then(Value::as_str);

    // Prefer a real spell from the hero's own class; fall back to any class's
    // spell if the hero has none set.
    let names = state.catalog.spell_names(hero_class);
    let sample = (!names.is_empty()).then(|| names[now_ms().unsigned_abs() as usize % names.len()]);
    let spell_name = sample.unwrap_or("Sort de test");
    let timestamp = now_ms();

    push_debug_event(
        &app,
        json!({
            "status": "test",
            "characterName": hero.get("characterName"),
            "heroName": hero.get("name"),
            "heroClass": hero_class,
            "spellName": spell_name,
            "timestamp": timestamp,
        }),
    );
    state.hub.broadcast_cast(&json!({
        "characterName": hero.get("characterName"),
        "heroName": hero.get("name"),
        "class": hero_class,
        "classIcon": state.catalog.class_icon(hero_class),
        "spellName": spell_name,
        "color": hero.get("color"),
        "timestamp": timestamp,
        "icon": sample.and_then(|s| state.catalog.spell_icon(hero_class, s)),
    }));
}

fn launch_at_login_state() -> Value {
    json!({
        "available": autostart::available(),
        "enabled": autostart::is_enabled(),
        "reason": autostart::unavailable_reason(),
    })
}

#[tauri::command]
pub fn get_launch_at_login() -> Value {
    launch_at_login_state()
}

#[tauri::command]
pub fn set_launch_at_login(enabled: bool) -> Value {
    if let Err(err) = autostart::set_enabled(enabled) {
        eprintln!("[autostart] {err}");
    }
    launch_at_login_state()
}

#[tauri::command]
pub fn check_for_updates(app: AppHandle) {
    updates::check(&app, true);
}

#[tauri::command]
pub fn get_update_status(app: AppHandle) -> Option<Value> {
    updates::last_status(&app)
}

#[tauri::command]
pub fn get_app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

/// For the "Nouveautés" window (ui/whatsnew).
#[tauri::command]
pub fn get_release_notes(app: AppHandle, since: Option<String>) -> Value {
    whats_new::release_notes(&app, since.as_deref())
}

// Async: a window built from a synchronous command (run on the main thread)
// never gets its web view on Windows.
#[tauri::command]
pub async fn show_whats_new(app: AppHandle) {
    whats_new::show(&app, None);
}

/// For the "Récap des combats" window (ui/recap).
#[tauri::command]
pub fn get_recap(state: State<AppState>) -> Value {
    let core = state.core.lock_safe();
    let mut recap = core.tracker.recorder.to_json(&core.settings, &state.catalog);
    core.saved_fights.merge_into(&mut recap);
    recap
}

/// The recap's "Sauvegarder": keeps a finished fight across sessions.
#[tauri::command]
pub fn save_fight(state: State<AppState>, id: u64) -> Result<(), String> {
    let mut core = state.core.lock_safe();
    let recap = core.tracker.recorder.to_json(&core.settings, &state.catalog);
    let fight = recap["fights"]
        .as_array()
        .and_then(|fights| fights.iter().find(|f| f["id"] == id))
        .ok_or("Ce combat n'est plus dans le récap.")?;
    core.saved_fights.save(fight)
}

/// The bin on a fight of an earlier session: forgets its saved copy.
#[tauri::command]
pub fn delete_saved_fight(state: State<AppState>, saved_id: u64) -> bool {
    state.core.lock_safe().saved_fights.delete(saved_id)
}

/// The recap showed this fight: it's no longer "nouveau".
#[tauri::command]
pub fn mark_fight_seen(app: AppHandle, state: State<AppState>, id: u64) {
    let unseen = {
        let mut core = state.core.lock_safe();
        core.tracker.recorder.mark_seen(id);
        core.tracker.recorder.has_unseen()
    };
    if app.get_webview_window(SETTINGS_WINDOW).is_some() {
        let _ = app.emit_to(SETTINGS_WINDOW, "recap:unseen", unseen);
    }
}

/// The recap's bin: forgets a finished fight.
#[tauri::command]
pub fn delete_fight(app: AppHandle, state: State<AppState>, id: u64) -> bool {
    let (deleted, unseen) = {
        let mut core = state.core.lock_safe();
        let deleted = core.tracker.recorder.delete(id);
        // A saved fight goes from the disk too.
        if let Some(saved) = core.saved_fights.saved_id_of(id) {
            core.saved_fights.delete(saved);
        }
        (deleted, core.tracker.recorder.has_unseen())
    };
    if app.get_webview_window(SETTINGS_WINDOW).is_some() {
        let _ = app.emit_to(SETTINGS_WINDOW, "recap:unseen", unseen);
    }
    deleted
}

#[tauri::command]
pub fn has_unseen_fights(state: State<AppState>) -> bool {
    state.core.lock_safe().tracker.recorder.has_unseen()
}

#[tauri::command]
pub async fn show_recap(app: AppHandle) {
    crate::show_recap_window(&app);
}

#[tauri::command]
pub fn get_ingame_overlay(app: AppHandle) -> Value {
    ingame_window::status(&app)
}

// Async: a sync command runs on the main thread, and creating a window from
// there deadlocks on Windows.
#[tauri::command]
pub async fn set_ingame_overlay(app: AppHandle, enabled: bool) -> Value {
    ingame_window::set_enabled(&app, enabled);
    ingame_window::status(&app)
}


#[tauri::command]
pub async fn set_ingame_overlay_only_over_wakfu(app: AppHandle, only: bool) -> Value {
    ingame_window::set_only_over_wakfu(&app, only);
    ingame_window::status(&app)
}
