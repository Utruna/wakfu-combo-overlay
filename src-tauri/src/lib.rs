//! Wakfu Combo Overlay: tails the Wakfu combat log, filters casts down to the
//! tracked heroes, and serves a live combo-list overlay for OBS. Lives in the
//! tray; the settings window is only created while it's open, so that the
//! web view — by far the heaviest part — costs nothing the rest of the time.

pub mod app_state;
pub mod autostart;
pub mod catalog;
pub mod commands;
pub mod loader_page;
pub mod log_reader;
pub mod matcher;
pub mod overlay_server;
pub mod settings;
pub mod turn_tracker;
pub mod updates;

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

use app_state::{AppState, Core, LogReaderThread, SETTINGS_WINDOW};
use catalog::Catalog;
use overlay_server::{FileSource, OverlayHub};
use settings::{Defaults, SettingsStore, DEFAULT_OVERLAY_PORT};
use turn_tracker::CombatTurnTracker;
use updates::UpdateState;

/// Same folder as the 1.x (Electron) versions, so their settings — and the
/// OBS loader page path users pasted into OBS — carry over.
/// WAKFU_OVERLAY_DATA_DIR points it elsewhere (tests, demo captures).
fn data_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("WAKFU_OVERLAY_DATA_DIR") {
        return PathBuf::from(dir);
    }
    std::env::var_os("APPDATA").map(PathBuf::from).unwrap_or_default().join("Wakfu Combo Overlay")
}

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
        .title("Réglages — Wakfu Combo Overlay")
        .inner_size(980.0, 680.0)
        .min_inner_size(900.0, 620.0)
        .background_color(tauri::window::Color(0x13, 0x1a, 0x1e, 0xff))
        .center()
        .build();
    if let Err(err) = built {
        eprintln!("[main] Failed to open the settings window: {err}");
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
    let menu = Menu::with_items(
        app,
        &[
            &MenuItem::with_id(app, "open", "Ouvrir les réglages", true, None::<&str>)?,
            &MenuItem::with_id(app, "updates", "Vérifier les mises à jour", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "quit", "Quitter", true, None::<&str>)?,
        ],
    )?;
    TrayIconBuilder::with_id("main")
        .icon(Image::from_bytes(include_bytes!("../../ui/assets/tray-icon.png"))?)
        .tooltip("Wakfu Combo Overlay")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_settings_window(app),
            "updates" => updates::check(app, true),
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

    app.manage(AppState {
        core: Mutex::new(Core {
            settings,
            tracker: CombatTurnTracker::new(),
            last_cast_at: None,
            overlay_error: None,
            obs_loader_path,
        }),
        catalog,
        hub: Arc::new(OverlayHub::default()),
        files,
        overlay: Mutex::new(None),
        reader: Mutex::new(None),
        data_dir,
    });
    let state = app.state::<AppState>();
    state.hub.broadcast_config(&state.overlay_config(&layout));

    match tauri::async_runtime::block_on(state.start_overlay(port)) {
        Ok(server) => *state.overlay.lock().unwrap() = Some(server),
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
            state.core.lock().unwrap().overlay_error = Some(error);
        }
    }

    *state.reader.lock().unwrap() = Some(LogReaderThread::start(app.clone(), logs_dir));

    autostart::migrate_from_electron();
    create_tray(app)?;
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

pub fn run() {
    let launched_at_login = std::env::args().any(|arg| arg == autostart::HIDDEN_ARG);
    // An isolated profile (demo captures) runs next to the user's own instance.
    let isolated_profile = std::env::var_os("WAKFU_OVERLAY_DATA_DIR").is_some();

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
        ])
        .setup(move |app| setup(app.handle(), launched_at_login))
        .build(tauri::generate_context!())
        .expect("error while building the app")
        .run(|_app, event| {
            // Closing the settings window must not quit: the log reader and
            // the overlay keep running in the tray. Only "Quitter" exits.
            if let RunEvent::ExitRequested { code: None, api, .. } = event {
                api.prevent_exit();
            }
        });
}
