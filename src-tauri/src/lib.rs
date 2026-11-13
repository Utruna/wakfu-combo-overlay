//! Taktik: tails the Wakfu combat log, filters casts down to the
//! tracked heroes, and serves a live combo-list overlay for OBS. Lives in the
//! tray; the settings window is only created while it's open, so that the
//! web view — by far the heaviest part — costs nothing the rest of the time.

pub mod app_state;
pub mod autostart;
pub mod catalog;
pub mod fight_recap;
pub mod commands;
pub mod ingame_window;
pub mod loader_page;
pub mod log_reader;
pub mod matcher;
pub mod overlay_server;
pub mod saved_fights;
pub mod settings;
pub mod turn_tracker;
pub mod updates;
pub mod user_dirs;
pub mod whats_new;

use crate::app_state::LockExt;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

use app_state::{AppState, Core, LogReaderThread, RECAP_WINDOW, SETTINGS_WINDOW};
use catalog::Catalog;
use ingame_window::IngameMenuItem;
use overlay_server::{FileSource, HudHandler, HudRequest, OverlayHub};
use saved_fights::SavedFights;
use settings::{Defaults, SettingsStore, DEFAULT_OVERLAY_PORT};
use turn_tracker::CombatTurnTracker;
use updates::UpdateState;

/// See `user_dirs::app_dir`. TAKTIK_DATA_DIR points it elsewhere
/// (tests, demo captures).
fn data_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("TAKTIK_DATA_DIR") {
        return PathBuf::from(dir);
    }
    user_dirs::migrate_legacy_app_dir();
    user_dirs::app_dir()
}

/// Whoever restarts the app (an update on Linux or macOS) starts the new one
/// just as the old one quits: give it a moment to free the port.
const PORT_RETRY_DELAY: Duration = Duration::from_millis(250);
const PORT_RETRIES: u32 = 8;

pub fn show_settings_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(SETTINGS_WINDOW) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }
    // Closing really destroys the window (instead of hiding it), so the web
    // view's processes — nearly all of the app's memory — are freed while
    // the app sits in the tray. It's rebuilt from the settings on reopen.
    let built = WebviewWindowBuilder::new(app, SETTINGS_WINDOW, WebviewUrl::App("settings/index.html".into()))
        .title("Réglages — Taktik")
        .inner_size(980.0, 680.0)
        .min_inner_size(900.0, 620.0)
        .background_color(tauri::window::Color(0x13, 0x1a, 0x1e, 0xff))
        .center()
        .build();
    match built {
        Ok(window) => {
            // Built after the settings, so it opens on top of them.
            whats_new::show_if_updated(window.app_handle());
        }
        Err(err) => eprintln!("[main] Failed to open the settings window: {err}"),
    }
}

/// The "Récap des combats" window (ui/recap). Like the settings, it's
/// destroyed on close, so it costs nothing while the app sits in the tray.
pub fn show_recap_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(RECAP_WINDOW) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }
    let built = WebviewWindowBuilder::new(app, RECAP_WINDOW, WebviewUrl::App("recap/index.html".into()))
        .title("Récap des combats — Taktik")
        .inner_size(1200.0, 820.0)
        .min_inner_size(960.0, 600.0)
        .background_color(tauri::window::Color(0x13, 0x1a, 0x1e, 0xff))
        .center()
        .build();
    if let Err(err) = built {
        eprintln!("[main] Failed to open the recap window: {err}");
    }
}

fn quit(app: &AppHandle) {
    // A downloaded update is installed on the way out; the installer closes
    // the app itself (and doesn't start it again: the user asked to quit).
    if !updates::install_pending(app, false) {
        app.exit(0);
    }
}

fn create_tray(app: &AppHandle) -> tauri::Result<()> {
    let ingame = CheckMenuItem::with_id(app, "ingame", "Affichage tête haute", true, false, None::<&str>)?;
    app.manage(IngameMenuItem(ingame.clone()));
    let menu = Menu::with_items(
        app,
        &[
            &MenuItem::with_id(app, "open", "Ouvrir les réglages", true, None::<&str>)?,
            &MenuItem::with_id(app, "recap", "Récap des combats", true, None::<&str>)?,
            &ingame,
            &MenuItem::with_id(app, "updates", "Vérifier les mises à jour", true, None::<&str>)?,
            &MenuItem::with_id(app, "whatsnew", "Nouveautés", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "quit", "Quitter", true, None::<&str>)?,
        ],
    )?;
    TrayIconBuilder::with_id("main")
        .icon(Image::from_bytes(include_bytes!("../../ui/assets/tray-icon.png"))?)
        .tooltip("Taktik")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_settings_window(app),
            "recap" => show_recap_window(app),
            "ingame" => {
                let enabled = ingame_window::status(app)["enabled"] == true;
                ingame_window::set_enabled(app, !enabled);
            }
            "updates" => updates::check(app, true),
            "whatsnew" => whats_new::show(app, None),
            "quit" => quit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_settings_window(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

fn setup(app: &AppHandle, launched_at_login: bool) -> Result<(), Box<dyn std::error::Error>> {
    let data_dir = data_dir();
    let mut settings = SettingsStore::open(data_dir.join("settings.json"));
    settings.ensure_defaults(&Defaults {
        overlay_port: DEFAULT_OVERLAY_PORT,
        logs_dir: log_reader::default_logs_dir().display().to_string(),
    });
    if let Some(found) = log_reader::redetected_logs_dir(&settings.logs_dir(), &log_reader::logs_dir_candidates()) {
        println!("[main] Wakfu's logs found in {}", found.display());
        settings.set_logs_dir(&found.display().to_string());
    }
    let port = settings.overlay_port();
    let logs_dir = settings.logs_dir();
    let layout = settings.combo_layout();

    // Written before the server even tries to bind, so the file OBS points at
    // exists (and targets the right port) whatever happens next.
    let obs_loader_path = loader_page::write_loader_page(&data_dir, port);

    // The overlay's files are the ones embedded in the exe for the settings
    // window (frontendDist = ui/): one copy serves both.
    let resolver = app.asset_resolver();
    let files: FileSource = Arc::new(move |path: &str| resolver.get(path.to_string()).map(|asset| asset.bytes));
    let catalog = Catalog::load(|path| files(path).is_some());

    let handle = app.clone();
    let hud: HudHandler = Arc::new(move |request| match request {
        HudRequest::ControlsRect(rect) => {
            ingame_window::set_controls_rect(rect);
            // The bar may have moved within the window (new orientation).
            ingame_window::ensure_visible(&handle);
        }
        HudRequest::Size { width, height, keep_left, keep_bottom } => {
            ingame_window::fit(&handle, width, height, keep_left, keep_bottom)
        }
        HudRequest::Drag => ingame_window::start_drag(&handle),
        HudRequest::Recap => show_recap_window(&handle),
        HudRequest::CounterMode(mode) => {
            let mut change = serde_json::Map::new();
            change.insert("damageCounterMode".into(), mode.into());
            let layout = handle.state::<AppState>().change_combo_layout(&change);
            // The settings page shows the mode too: keep it in step.
            if handle.get_webview_window(SETTINGS_WINDOW).is_some() {
                let _ = handle.emit_to(SETTINGS_WINDOW, "layout:changed", layout);
            }
        }
    });

    app.manage(AppState {
        core: Mutex::new(Core {
            settings,
            tracker: CombatTurnTracker::new(),
            last_cast_at: None,
            overlay_error: None,
            obs_loader_path,
            saved_fights: SavedFights::open(data_dir.join("saved_fights.json")),
        }),
        catalog,
        hub: Arc::new(OverlayHub::default()),
        files,
        hud,
        overlay: Mutex::new(None),
        port_change: tokio::sync::Mutex::new(()),
        reader: Mutex::new(None),
        data_dir,
    });
    let state = app.state::<AppState>();
    state.hub.broadcast_config(&state.overlay_config(&layout));

    let started = tauri::async_runtime::block_on(async {
        let mut attempt = 0;
        loop {
            match state.start_overlay(port).await {
                Err(_) if attempt < PORT_RETRIES => {
                    attempt += 1;
                    tokio::time::sleep(PORT_RETRY_DELAY).await;
                }
                result => break result,
            }
        }
    });
    match started {
        Ok(server) => *state.overlay.lock_safe() = Some(server),
        Err(error) => {
            eprintln!("[main] Overlay server failed to start: {error}");
            app.dialog()
                .message(format!(
                    "Impossible de démarrer le serveur overlay sur le port {port} ({error}).\n\
                     Change le port dans les réglages, panneau Diagnostic."
                ))
                .title("Port de l'overlay indisponible")
                .kind(MessageDialogKind::Error)
                .show(|_| {});
            state.core.lock_safe().overlay_error = Some(error);
        }
    }

    *state.reader.lock_safe() = Some(LogReaderThread::start(app.clone(), logs_dir));

    autostart::migrate_legacy_entries();
    create_tray(app)?;
    ingame_window::refresh(app);
    // At login the app starts straight in the tray: don't even create the
    // web view until the user opens the settings.
    if !launched_at_login {
        show_settings_window(app);
    }

    // Silent check a few seconds after launch — never interrupts startup, and
    // stays quiet unless a newer version actually exists.
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(3)).await;
        updates::check(&handle, false);
    });
    Ok(())
}

/// The in-game overlay places its own window, lets clicks through it and asks
/// which window is in front — none of which Wayland lets an app do. On a
/// Wayland desktop the app runs through XWayland instead, like Wakfu itself
/// (a Java game). Has to happen before GTK starts, so first thing.
#[cfg(target_os = "linux")]
fn prepare_linux_display() {
    let unset = |key: &str| std::env::var_os(key).is_none();
    if unset("GDK_BACKEND") && !unset("DISPLAY") {
        std::env::set_var("GDK_BACKEND", "x11");
    }
    // The AppImage carries a WebKitGTK built against older graphics libraries
    // than a recent distro's: its DMA-BUF renderer then draws blank windows.
    if !unset("APPIMAGE") && unset("WEBKIT_DISABLE_DMABUF_RENDERER") {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
}

pub fn run() {
    #[cfg(target_os = "linux")]
    prepare_linux_display();

    let launched_at_login = std::env::args().any(|arg| arg == autostart::HIDDEN_ARG);
    // An isolated profile (demo captures) runs next to the user's own instance.
    let isolated_profile = std::env::var_os("TAKTIK_DATA_DIR").is_some();

    let mut builder = tauri::Builder::default();
    if !isolated_profile {
        // Only one instance may run at a time — a second launch (e.g.
        // double-clicking the exe while it's already in the tray) would
        // otherwise fail to bind the overlay port. It just opens the settings.
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_settings_window(app)));
    }
    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(UpdateState::default())
        .invoke_handler(tauri::generate_handler![
            commands::get_state,
            commands::set_tracked_heroes,
            commands::set_combo_layout,
            commands::add_hero,
            commands::update_hero,
            commands::set_onboarding_done,
            commands::set_hero_color,
            commands::remove_hero,
            commands::get_diagnostics,
            commands::set_logs_dir,
            commands::browse_logs_dir,
            commands::show_obs_loader,
            commands::set_overlay_port,
            commands::send_test_cast,
            commands::get_launch_at_login,
            commands::set_launch_at_login,
            commands::check_for_updates,
            commands::get_update_status,
            commands::get_app_version,
            commands::get_release_notes,
            commands::show_whats_new,
            commands::get_recap,
            commands::follow_fighter,
            commands::mark_fight_seen,
            commands::delete_fight,
            commands::save_fight,
            commands::delete_saved_fight,
            commands::has_unseen_fights,
            commands::show_recap,
            commands::get_ingame_overlay,
            commands::set_ingame_overlay,
            commands::set_ingame_overlay_only_over_wakfu,
        ])
        .setup(move |app| setup(app.handle(), launched_at_login))
        .build(tauri::generate_context!())
        .expect("error while building the app")
        .run(|_app, event| match event {
            // Closing the settings window must not quit: the log reader and
            // the overlay keep running in the tray. Only "Quitter" exits.
            RunEvent::ExitRequested { code: None, api, .. } => api.prevent_exit(),
            // A click on the Dock icon.
            #[cfg(target_os = "macos")]
            RunEvent::Reopen { .. } if !ingame_window::clicking_the_bar() => show_settings_window(_app),
            _ => {}
        });
}
