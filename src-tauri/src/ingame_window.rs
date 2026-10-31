//! The in-game overlay ("Affichage tête haute" in the app): the OBS overlay page shown straight over Wakfu, in a
//! transparent, always-on-top window that lets every click through — for
//! players who don't stream. Opt-in, and the window only exists while it's
//! on: like the settings window, its web view is most of what it costs.
//!
//! "Edit mode" gives it a title bar and borders for a while, to move and
//! resize it; its place is remembered when it's locked again.
//!
//! By default it only shows while a Wakfu window ("Pseudo - WAKFU") — or one
//! of the app's own — is in front, so it doesn't sit over everything else.
//! It stays over a windowed or borderless game, not over exclusive fullscreen.

use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;
use tauri::menu::CheckMenuItem;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent, Wry};

use crate::app_state::{AppState, SETTINGS_WINDOW};

pub const INGAME_WINDOW: &str = "ingame";

/// Room for the longest default list; the page is transparent and lets
/// clicks through, so a window larger than the overlay costs nothing.
const DEFAULT_WIDTH: f64 = 400.0;
const DEFAULT_HEIGHT: f64 = 640.0;
/// Moves and resizes come in bursts while dragging: save once it settles.
const SAVE_DELAY: Duration = Duration::from_millis(500);
/// How often the window in front is checked.
const FOREGROUND_POLL: Duration = Duration::from_millis(250);

static EDITING: AtomicBool = AtomicBool::new(false);
static SAVE_GENERATION: AtomicU64 = AtomicU64::new(0);

/// The tray's "Affichage tête haute" item, kept in step with the setting.
pub struct IngameMenuItem(pub CheckMenuItem<Wry>);

/// `?ingame` keeps the window out of the OBS client count (see overlay_server).
fn page_url(port: u16) -> tauri::Url {
    format!("http://127.0.0.1:{port}/?ingame").parse().expect("valid overlay URL")
}

fn flag(app: &AppHandle, key: &str, default: bool) -> bool {
    let state = app.state::<AppState>();
    let core = state.core.lock().unwrap();
    core.settings.ingame_overlay().get(key).and_then(Value::as_bool).unwrap_or(default)
}

fn is_enabled(app: &AppHandle) -> bool {
    flag(app, "enabled", false)
}

fn only_over_wakfu(app: &AppHandle) -> bool {
    flag(app, "onlyOverWakfu", true)
}

pub fn status(app: &AppHandle) -> Value {
    let state = app.state::<AppState>();
    let online = state.core.lock().unwrap().overlay_error.is_none();
    json!({
        "enabled": is_enabled(app),
        "onlyOverWakfu": only_over_wakfu(app),
        "editing": EDITING.load(Ordering::Relaxed),
        "online": online,
    })
}

fn notify(app: &AppHandle) {
    if let Some(item) = app.try_state::<IngameMenuItem>() {
        let _ = item.0.set_checked(is_enabled(app));
    }
    if app.get_webview_window(SETTINGS_WINDOW).is_some() {
        let _ = app.emit_to(SETTINGS_WINDOW, "ingame:status", status(app));
    }
}

/// Turns the in-game overlay on or off, and remembers it for the next launch.
pub fn set_enabled(app: &AppHandle, enabled: bool) {
    app.state::<AppState>().core.lock().unwrap().settings.set_ingame_overlay_flag("enabled", enabled);
    if enabled {
        open(app);
    } else {
        close(app);
    }
    notify(app);
}

pub fn set_only_over_wakfu(app: &AppHandle, only: bool) {
    app.state::<AppState>().core.lock().unwrap().settings.set_ingame_overlay_flag("onlyOverWakfu", only);
    notify(app);
}

/// Opens the window if the setting says so (at launch, after a port change…)
/// and points it at the current port.
pub fn refresh(app: &AppHandle) {
    let state = app.state::<AppState>();
    let (port, online) = {
        let core = state.core.lock().unwrap();
        (core.settings.overlay_port(), core.overlay_error.is_none())
    };
    match app.get_webview_window(INGAME_WINDOW) {
        Some(window) if online => {
            set_editing(app, false);
            let _ = window.navigate(page_url(port));
        }
        Some(_) => close(app),
        None if is_enabled(app) => open(app),
        None => {}
    }
    notify(app);
}

fn open(app: &AppHandle) {
    if app.get_webview_window(INGAME_WINDOW).is_some() {
        return;
    }
    let state = app.state::<AppState>();
    let (port, online, geometry) = {
        let core = state.core.lock().unwrap();
        (core.settings.overlay_port(), core.overlay_error.is_none(), core.settings.ingame_overlay())
    };
    // Without the server the window would show the browser's error page —
    // opaque, over the game. It opens once the port is fixed (`refresh`).
    if !online {
        return;
    }
    EDITING.store(false, Ordering::Relaxed);
    let built = WebviewWindowBuilder::new(app, INGAME_WINDOW, WebviewUrl::External(page_url(port)))
        .title("Wakfu Combo Overlay — tête haute")
        .inner_size(DEFAULT_WIDTH, DEFAULT_HEIGHT)
        .transparent(true)
        .decorations(false)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        // Never activated, even when shown or clicked: the game keeps the focus.
        .focusable(false)
        .minimizable(false)
        .maximizable(false)
        .closable(false)
        .build();
    let window = match built {
        Ok(window) => window,
        Err(err) => {
            eprintln!("[ingame] Failed to open the in-game overlay: {err}");
            return;
        }
    };
    let _ = window.set_ignore_cursor_events(true);
    place(&window, &geometry);

    let handle = window.clone();
    window.on_window_event(move |event| match event {
        WindowEvent::Moved(_) | WindowEvent::Resized(_) => schedule_save(&handle),
        // Only "off" closes it (Alt+F4 while moving it, say, would leave
        // the setting on with no window).
        WindowEvent::CloseRequested { api, .. } => api.prevent_close(),
        _ => {}
    });
    tauri::async_runtime::spawn(follow_foreground(app.clone()));
}

/// Shows the window while Wakfu is in front, hides it otherwise — until the
/// window is closed.
async fn follow_foreground(app: AppHandle) {
    while let Some(window) = app.get_webview_window(INGAME_WINDOW) {
        if let Ok(hwnd) = window.hwnd() {
            let show = !only_over_wakfu(&app) || EDITING.load(Ordering::Relaxed) || foreground::wakfu_or_settings_in_front(hwnd.0);
            foreground::set_shown(hwnd.0, show);
        }
        tokio::time::sleep(FOREGROUND_POLL).await;
    }
}

fn close(app: &AppHandle) {
    set_editing(app, false);
    if let Some(window) = app.get_webview_window(INGAME_WINDOW) {
        let _ = window.destroy();
    }
}

/// Edit mode: title bar, borders, clicks caught, and sample casts so the
/// overlay's extent shows. Locking again saves where it was left.
pub fn set_editing(app: &AppHandle, editing: bool) {
    let Some(window) = app.get_webview_window(INGAME_WINDOW) else {
        EDITING.store(false, Ordering::Relaxed);
        return;
    };
    if EDITING.swap(editing, Ordering::Relaxed) == editing {
        return;
    }
    if !editing {
        SAVE_GENERATION.fetch_add(1, Ordering::Relaxed);
        save_geometry(&window);
    }
    let _ = window.set_decorations(editing);
    let _ = window.set_ignore_cursor_events(!editing);
    // No focus taken: the settings window keeps it, so its "lock" button
    // answers the first click.
    let _ = window.eval(format!("window.setIngameEditMode && window.setIngameEditMode({editing})"));
    notify(app);
}

/// Back where it was left — unless that was on a monitor that's gone since,
/// in which case top-right of the main screen, like in OBS.
fn place(window: &WebviewWindow, geometry: &Value) {
    let field = |key: &str| geometry.get(key).and_then(Value::as_i64);
    let saved = (|| Some((field("x")? as i32, field("y")? as i32, field("width")? as u32, field("height")? as u32)))();
    if let Some((x, y, width, height)) = saved.filter(|&(x, y, ..)| on_screen(window, x, y)) {
        let _ = window.set_size(PhysicalSize::new(width, height));
        let _ = window.set_position(PhysicalPosition::new(x, y));
        return;
    }
    let (Ok(Some(monitor)), Ok(size)) = (window.primary_monitor(), window.outer_size()) else { return };
    let scale = monitor.scale_factor();
    let x = monitor.position().x + monitor.size().width as i32 - size.width as i32 - (24.0 * scale) as i32;
    let y = monitor.position().y + (96.0 * scale) as i32;
    let _ = window.set_position(PhysicalPosition::new(x, y));
}

/// Whether the window's top-left corner would land on a connected monitor.
fn on_screen(window: &WebviewWindow, x: i32, y: i32) -> bool {
    let Ok(monitors) = window.available_monitors() else { return true };
    monitors.iter().any(|monitor| {
        let (pos, size) = (monitor.position(), monitor.size());
        (pos.x - 40..pos.x + size.width as i32 - 40).contains(&x) && (pos.y..pos.y + size.height as i32 - 40).contains(&y)
    })
}

fn schedule_save(window: &WebviewWindow) {
    // Placing the window on open moves it too: only the user's moves count.
    if !EDITING.load(Ordering::Relaxed) {
        return;
    }
    let generation = SAVE_GENERATION.fetch_add(1, Ordering::Relaxed) + 1;
    let window = window.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(SAVE_DELAY).await;
        if SAVE_GENERATION.load(Ordering::Relaxed) == generation {
            save_geometry(&window);
        }
    });
}

fn save_geometry(window: &WebviewWindow) {
    let (Ok(pos), Ok(size)) = (window.outer_position(), window.outer_size()) else { return };
    let state = window.app_handle().state::<AppState>();
    state.core.lock().unwrap().settings.set_ingame_overlay_geometry(pos.x, pos.y, size.width, size.height);
}

/// Win32: which window is in front, and showing ours without activating it
/// (Tauri's `show` would take the focus from the game).
mod foreground {
    use std::ffi::c_void;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetWindowTextW, GetWindowThreadProcessId, IsWindowVisible, ShowWindow, SW_HIDE,
        SW_SHOWNOACTIVATE,
    };

    /// Wakfu titles its windows "Pseudo - WAKFU" (just "WAKFU" before login).
    pub fn is_wakfu_title(title: &str) -> bool {
        let title = title.trim().to_uppercase();
        title == "WAKFU" || title.ends_with(" - WAKFU")
    }

    /// A Wakfu window, or one of the app's own other than `overlay` (the
    /// settings window, so the overlay shows while it's being set up).
    pub fn wakfu_or_settings_in_front(overlay: *mut c_void) -> bool {
        // SAFETY: plain Win32 queries on whatever window is in front; a
        // window closing meanwhile just makes them fail (0 / empty title).
        unsafe {
            let hwnd = GetForegroundWindow();
            if hwnd.is_null() || hwnd == overlay {
                return false;
            }
            let mut pid = 0u32;
            GetWindowThreadProcessId(hwnd, &mut pid);
            if pid == std::process::id() {
                return true;
            }
            let mut buffer = [0u16; 256];
            let len = GetWindowTextW(hwnd, buffer.as_mut_ptr(), buffer.len() as i32);
            len > 0 && is_wakfu_title(&String::from_utf16_lossy(&buffer[..len as usize]))
        }
    }

    pub fn set_shown(hwnd: *mut c_void, show: bool) {
        // SAFETY: `hwnd` is our own live window, from Tauri.
        unsafe {
            if (IsWindowVisible(hwnd) != 0) != show {
                ShowWindow(hwnd, if show { SW_SHOWNOACTIVATE } else { SW_HIDE });
            }
        }
    }

    #[cfg(test)]
    mod tests {
        use super::is_wakfu_title;

        #[test]
        fn recognizes_wakfu_windows() {
            assert!(is_wakfu_title("Lueur Pourpre - WAKFU"));
            assert!(is_wakfu_title("WAKFU"));
            assert!(is_wakfu_title("lueur pourpre - Wakfu"));
            assert!(!is_wakfu_title("Wakfu Combo Overlay"));
            assert!(!is_wakfu_title("wakfu.log - Notepad"));
            assert!(!is_wakfu_title("Guide WAKFU - Google Chrome"));
        }
    }
}
