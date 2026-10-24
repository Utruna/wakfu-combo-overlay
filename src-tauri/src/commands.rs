//! What the settings window can ask of the app (ui/settings/tauri-api.js
//! exposes these as `window.settingsAPI`).

use serde_json::{json, Map, Value};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tokio::sync::oneshot;

use crate::app_state::{push_debug_event, AppState, LogReaderThread, SETTINGS_WINDOW};
use crate::log_reader::now_ms;
use crate::settings::{
    parse_port, DEFAULT_CAST_LIFETIME_MS, DEFAULT_ICON_SIZE, DEFAULT_MAX_VISIBLE_CASTS, MAX_CAST_LIFETIME_MS,
    MAX_ICON_SIZE, MAX_MAX_VISIBLE_CASTS, MIN_CAST_LIFETIME_MS, MIN_ICON_SIZE, MIN_MAX_VISIBLE_CASTS,
};
use crate::{autostart, loader_page, updates};

fn overlay_url(port: u16) -> String {
    format!("http://localhost:{port}")
}

#[tauri::command]
pub fn get_state(state: State<AppState>) -> Value {
    let core = state.core.lock().unwrap();
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
    state.core.lock().unwrap().settings.set_tracked_heroes(&character_names);
}

#[tauri::command]
pub fn set_combo_layout(state: State<AppState>, layout: Map<String, Value>) {
    let layout = state.core.lock().unwrap().settings.set_combo_layout(&layout);
    state.hub.broadcast_config(&state.overlay_config(&layout));
}

#[tauri::command]
pub fn add_hero(state: State<AppState>, hero: Value, options: Option<Value>) -> bool {
    let options = options.unwrap_or(Value::Null);
    let index = options.get("index").and_then(Value::as_u64).map(|i| i as usize);
    let tracked = options.get("tracked").and_then(Value::as_bool).unwrap_or(true);
    state.core.lock().unwrap().settings.add_hero(&hero, index, tracked)
}

#[tauri::command]
pub fn update_hero(state: State<AppState>, character_name: String, changes: Value) -> bool {
    state.core.lock().unwrap().settings.update_hero(&character_name, &changes)
}

#[tauri::command]
pub fn set_onboarding_done(state: State<AppState>) {
    state.core.lock().unwrap().settings.set_onboarding_done();
}

#[tauri::command]
pub fn set_hero_color(state: State<AppState>, character_name: String, color: Value) -> bool {
    state.core.lock().unwrap().settings.set_hero_color(&character_name, color)
}

#[tauri::command]
pub fn remove_hero(state: State<AppState>, character_name: String) {
    state.core.lock().unwrap().settings.remove_hero(&character_name);
}

#[tauri::command]
pub fn get_diagnostics(state: State<AppState>) -> Value {
    let core = state.core.lock().unwrap();
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
        let mut core = state.core.lock().unwrap();
        let current = core.settings.logs_dir();
        if current.as_os_str() == dir.as_str() {
            return json!({ "ok": true, "logsDir": current, "logsDirExists": current.exists() });
        }
        if !core.settings.set_logs_dir(&dir) {
            return json!({ "ok": false, "error": "Chemin invalide." });
        }
        core.settings.logs_dir()
    };
    let mut reader = state.reader.lock().unwrap();
    // The old reader must be gone before the new one starts reading.
    drop(reader.take());
    *reader = Some(LogReaderThread::start(app, logs_dir.clone()));
    json!({ "ok": true, "logsDir": logs_dir, "logsDirExists": logs_dir.exists() })
}

#[tauri::command]
pub async fn browse_logs_dir(app: AppHandle, state: State<'_, AppState>) -> Result<Option<String>, ()> {
    let current = state.core.lock().unwrap().settings.logs_dir();
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
    let Some(path) = state.core.lock().unwrap().obs_loader_path.clone() else { return };
    use std::os::windows::process::CommandExt;
    let _ = std::process::Command::new("explorer")
        .raw_arg(format!("/select,\"{}\"", path.display()))
        .spawn();
}

#[tauri::command]
pub async fn set_overlay_port(state: State<'_, AppState>, port: Value) -> Result<Value, ()> {
    let (current, failed) = {
        let core = state.core.lock().unwrap();
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
    *state.overlay.lock().unwrap() = Some(server);
    let mut core = state.core.lock().unwrap();
    core.overlay_error = None;
    core.settings.set_overlay_port(port);
    core.obs_loader_path = loader_page::write_loader_page(&state.data_dir, port);
    Ok(json!({ "ok": true, "overlayUrl": overlay_url(port) }))
}

#[tauri::command]
pub fn send_test_cast(app: AppHandle, state: State<AppState>, character_name: String) {
    let hero = {
        let core = state.core.lock().unwrap();
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
    json!({ "available": autostart::available(), "enabled": autostart::is_enabled() })
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
