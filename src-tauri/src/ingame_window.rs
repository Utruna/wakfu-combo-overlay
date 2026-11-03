//! The in-game overlay ("Affichage tête haute" in the app): the OBS overlay page shown straight over Wakfu, in a
//! transparent, always-on-top window that lets every click through — for
//! players who don't stream. Opt-in, and the window only exists while it's
//! on: like the settings window, its web view is most of what it costs.
//!
//! Its one clickable spot is the page's control bar: a handle to drag the
//! window around (its place is remembered), the counter's turn/fight switch
//! and a button opening the fight recap. The page sizes the window to what
//! the overlay can take up, its top-right corner staying put.
//!
//! By default it only shows while a Wakfu window ("Pseudo - WAKFU") — or one
//! of the app's own — is in front, so it doesn't sit over everything else.
//! It stays over a windowed or borderless game, not over exclusive fullscreen.

use crate::app_state::LockExt;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::menu::CheckMenuItem;
use tauri::{AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent, Wry};

use crate::app_state::{AppState, SETTINGS_WINDOW};
use crate::overlay_server::HudRect;

pub const INGAME_WINDOW: &str = "ingame";

/// Until the page says how much room it needs (see `fit`).
const DEFAULT_WIDTH: f64 = 400.0;
const DEFAULT_HEIGHT: f64 = 640.0;
/// How often the window in front, and the mouse, are checked — often enough
/// that the control bar catches the mouse as soon as it's over it.
const POLL_INTERVAL: Duration = Duration::from_millis(50);
/// How often the window follows the mouse while it's dragged.
const DRAG_INTERVAL: Duration = Duration::from_millis(8);
/// Extra room around the bar, in CSS pixels, so its edge isn't fiddly.
const CONTROLS_MARGIN: f64 = 2.0;

static DRAGGING: AtomicBool = AtomicBool::new(false);
/// Where the page last said its control bar is (None: not shown).
static CONTROLS_RECT: Mutex<Option<HudRect>> = Mutex::new(None);

/// The page reports where its control bar is — the one spot of the window
/// that takes clicks.
pub fn set_controls_rect(rect: Option<HudRect>) {
    *CONTROLS_RECT.lock_safe() = rect;
}

/// Sizes the window to the room the overlay needs (CSS pixels), keeping its
/// top-right corner where it is: the overlay is anchored there.
pub fn fit(app: &AppHandle, width: f64, height: f64) {
    let Some(window) = app.get_webview_window(INGAME_WINDOW) else { return };
    let (Ok(pos), Ok(old), Ok(scale)) = (window.outer_position(), window.outer_size(), window.scale_factor()) else { return };
    let new: PhysicalSize<u32> = LogicalSize::new(width.ceil(), height.ceil()).to_physical(scale);
    if new == old {
        return;
    }
    let right = pos.x + old.width as i32;
    let _ = window.set_size(new);
    let _ = window.set_position(PhysicalPosition::new(right - new.width as i32, pos.y));
    save_geometry(&window);
}

/// The bar's handle was pressed: the window follows the mouse until its
/// button is released, then stays there.
pub fn start_drag(app: &AppHandle) {
    let Some(window) = app.get_webview_window(INGAME_WINDOW) else { return };
    if DRAGGING.swap(true, Ordering::Relaxed) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let start = (foreground::cursor_position(), window.outer_position());
        if let (Some((start_x, start_y)), Ok(origin)) = start {
            while foreground::left_button_down() {
                if let Some((x, y)) = foreground::cursor_position() {
                    let _ = window.set_position(PhysicalPosition::new(origin.x + x - start_x, origin.y + y - start_y));
                }
                tokio::time::sleep(DRAG_INTERVAL).await;
            }
            save_geometry(&window);
        }
        DRAGGING.store(false, Ordering::Relaxed);
    });
}

/// The tray's "Affichage tête haute" item, kept in step with the setting.
pub struct IngameMenuItem(pub CheckMenuItem<Wry>);

/// `?ingame` keeps the window out of the OBS client count (see overlay_server).
fn page_url(port: u16) -> tauri::Url {
    format!("http://127.0.0.1:{port}/?ingame").parse().expect("valid overlay URL")
}

fn flag(app: &AppHandle, key: &str, default: bool) -> bool {
    let state = app.state::<AppState>();
    let core = state.core.lock_safe();
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
    let online = state.core.lock_safe().overlay_error.is_none();
    json!({
        "enabled": is_enabled(app),
        "onlyOverWakfu": only_over_wakfu(app),
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
    app.state::<AppState>().core.lock_safe().settings.set_ingame_overlay_flag("enabled", enabled);
    if enabled {
        open(app);
    } else {
        close(app);
    }
    notify(app);
}

pub fn set_only_over_wakfu(app: &AppHandle, only: bool) {
    app.state::<AppState>().core.lock_safe().settings.set_ingame_overlay_flag("onlyOverWakfu", only);
    notify(app);
}

/// Opens the window if the setting says so (at launch, after a port change…)
/// and points it at the current port.
pub fn refresh(app: &AppHandle) {
    let state = app.state::<AppState>();
    let (port, online) = {
        let core = state.core.lock_safe();
        (core.settings.overlay_port(), core.overlay_error.is_none())
    };
    match app.get_webview_window(INGAME_WINDOW) {
        Some(window) if online => {
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
        let core = state.core.lock_safe();
        (core.settings.overlay_port(), core.overlay_error.is_none(), core.settings.ingame_overlay())
    };
    // Without the server the window would show the browser's error page —
    // opaque, over the game. It opens once the port is fixed (`refresh`).
    if !online {
        return;
    }
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

    window.on_window_event(|event| {
        // Only "off" closes it (Alt+F4, say, would leave the setting on with
        // no window).
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
        }
    });
    tauri::async_runtime::spawn(follow_foreground(app.clone()));
}

/// Shows the window while Wakfu is in front, hides it otherwise, and lets
/// clicks through everywhere but on the control bar — until the window is
/// closed.
async fn follow_foreground(app: AppHandle) {
    // Whether the window currently catches the mouse (it starts click-through).
    let mut catching = false;
    while let Some(window) = app.get_webview_window(INGAME_WINDOW) {
        if let Ok(hwnd) = window.hwnd() {
            let dragging = DRAGGING.load(Ordering::Relaxed);
            let show = !only_over_wakfu(&app) || dragging || foreground::wakfu_or_settings_in_front(hwnd.0);
            foreground::set_shown(hwnd.0, show);
            let over_controls = show && (dragging || cursor_over_controls(&window));
            if over_controls != catching {
                let _ = window.set_ignore_cursor_events(!over_controls);
                catching = over_controls;
            }
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

fn cursor_over_controls(window: &WebviewWindow) -> bool {
    let Some(rect) = *CONTROLS_RECT.lock_safe() else { return false };
    let (Some((cursor_x, cursor_y)), Ok(origin), Ok(scale)) =
        (foreground::cursor_position(), window.inner_position(), window.scale_factor())
    else {
        return false;
    };
    // Physical screen pixels -> the page's CSS pixels.
    let x = f64::from(cursor_x - origin.x) / scale;
    let y = f64::from(cursor_y - origin.y) / scale;
    (rect.x - CONTROLS_MARGIN..rect.x + rect.width + CONTROLS_MARGIN).contains(&x)
        && (rect.y - CONTROLS_MARGIN..rect.y + rect.height + CONTROLS_MARGIN).contains(&y)
}

fn close(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(INGAME_WINDOW) {
        let _ = window.destroy();
    }
}

/// Back where it was left — unless that was on a monitor that's gone since,
/// in which case top-right of the main screen, like in OBS.
fn place(window: &WebviewWindow, geometry: &Value) {
    let field = |key: &str| geometry.get(key).and_then(Value::as_i64);
    // Out-of-range numbers (a hand-edited or damaged settings.json) are
    // ignored rather than wrapped into a nonsensical window size.
    let saved = (|| {
        let size = |key: &str| field(key).and_then(|v| u32::try_from(v).ok()).filter(|v| (50..=10_000).contains(v));
        Some((i32::try_from(field("x")?).ok()?, i32::try_from(field("y")?).ok()?, size("width")?, size("height")?))
    })();
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

fn save_geometry(window: &WebviewWindow) {
    let (Ok(pos), Ok(size)) = (window.outer_position(), window.outer_size()) else { return };
    let state = window.app_handle().state::<AppState>();
    state.core.lock_safe().settings.set_ingame_overlay_geometry(pos.x, pos.y, size.width, size.height);
}

/// Win32: which window is in front, and showing ours without activating it
/// (Tauri's `show` would take the focus from the game).
mod foreground {
    use std::ffi::c_void;
    use windows_sys::Win32::Foundation::POINT;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetCursorPos, GetForegroundWindow, GetWindowTextW, GetWindowThreadProcessId, IsWindowVisible, ShowWindow, SW_HIDE,
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

    /// The mouse, in physical screen pixels.
    pub fn cursor_position() -> Option<(i32, i32)> {
        let mut point = POINT { x: 0, y: 0 };
        // SAFETY: GetCursorPos only writes the POINT it's given.
        (unsafe { GetCursorPos(&mut point) } != 0).then_some((point.x, point.y))
    }

    /// Whether the (primary) mouse button is held, wherever the mouse is.
    pub fn left_button_down() -> bool {
        // SAFETY: a plain state query; the high bit means "down".
        unsafe { GetAsyncKeyState(i32::from(VK_LBUTTON)) as u16 & 0x8000 != 0 }
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
