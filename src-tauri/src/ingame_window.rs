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
//!
//! On Linux it needs X11 (XWayland on a Wayland desktop, see `run`): Wayland
//! itself lets no app place its window or know which one is in front.

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
/// Whether the window currently catches the mouse (the cursor is over the
/// control bar) — see `follow_foreground` and `clicking_the_bar`.
static CATCHING: AtomicBool = AtomicBool::new(false);
/// Where the window was last put, and how big it was made. macOS moves and
/// resizes windows asynchronously, so reading the position back right after
/// `set_position` / `set_size` can still give the old one: `fit` and the saved
/// geometry start from what was asked for instead, or the window drifts away
/// at every change of layout.
static FRAME: Mutex<Option<(PhysicalPosition<i32>, PhysicalSize<u32>)>> = Mutex::new(None);

fn remember_frame(pos: PhysicalPosition<i32>, size: PhysicalSize<u32>) {
    *FRAME.lock_safe() = Some((pos, size));
}

/// Position and size of the window: the last ones asked for on macOS, what the
/// system says elsewhere.
fn frame(window: &WebviewWindow) -> Option<(PhysicalPosition<i32>, PhysicalSize<u32>)> {
    if cfg!(target_os = "macos") {
        if let Some(known) = *FRAME.lock_safe() {
            return Some(known);
        }
    }
    Some((window.outer_position().ok()?, window.outer_size().ok()?))
}

/// A rectangle in physical pixels: x, y, width, height.
type Rect = (i32, i32, i32, i32);

/// Moves a window at `pos` the least it takes for its control bar (`bar`, in
/// the window's own pixels) to lie wholly inside one of the usable screen
/// `areas` - the one it overlaps most, or the nearest. The bar is the only
/// way to move the window, so it must never end up out of reach (a layout
/// change, a monitor unplugged, a drag past the edge).
fn keep_bar_visible(pos: (i32, i32), bar: Rect, areas: &[Rect]) -> (i32, i32) {
    let (bx, by, bw, bh) = bar;
    let (left, top) = (pos.0 + bx, pos.1 + by);
    let overlap = |a: &Rect| {
        let w = (left + bw).min(a.0 + a.2) - left.max(a.0);
        let h = (top + bh).min(a.1 + a.3) - top.max(a.1);
        if w > 0 && h > 0 { i64::from(w) * i64::from(h) } else { 0 }
    };
    let distance = |a: &Rect| {
        let (dx, dy) = (i64::from(left + bw / 2 - (a.0 + a.2 / 2)), i64::from(top + bh / 2 - (a.1 + a.3 / 2)));
        dx * dx + dy * dy
    };
    let Some(area) = areas
        .iter()
        .max_by_key(|a| overlap(a))
        .filter(|a| overlap(a) > 0)
        .or_else(|| areas.iter().min_by_key(|a| distance(a)))
    else {
        return pos;
    };
    // A bar wider than the screen sticks to its top-left edge.
    let fit = |p: i32, offset: i32, extent: i32, start: i32, room: i32| {
        let lowest = start - offset;
        p.clamp(lowest, (start + room - offset - extent).max(lowest))
    };
    (fit(pos.0, bx, bw, area.0, area.2), fit(pos.1, by, bh, area.1, area.3))
}

/// Where the control bar is in the window's physical pixels - the top-left
/// corner of the window when the page hasn't said yet.
fn bar_rect(window: &WebviewWindow, size: PhysicalSize<u32>) -> Rect {
    match (*CONTROLS_RECT.lock_safe(), window.scale_factor()) {
        (Some(r), Ok(scale)) => {
            let px = |v: f64| (v * scale).round() as i32;
            (px(r.x), px(r.y), px(r.width).max(1), px(r.height).max(1))
        }
        _ => (0, 0, (size.width as i32).min(80), (size.height as i32).min(40)),
    }
}

/// `pos` moved so the bar is on a connected, usable screen (below the menu
/// bar, above the Dock or taskbar).
fn on_visible_screen(window: &WebviewWindow, pos: PhysicalPosition<i32>, size: PhysicalSize<u32>) -> PhysicalPosition<i32> {
    let Ok(monitors) = window.available_monitors() else { return pos };
    let areas: Vec<Rect> = monitors
        .iter()
        .map(|m| {
            let area = m.work_area();
            (area.position.x, area.position.y, area.size.width as i32, area.size.height as i32)
        })
        .collect();
    let (x, y) = keep_bar_visible((pos.x, pos.y), bar_rect(window, size), &areas);
    PhysicalPosition::new(x, y)
}

/// Brings the window back if its bar is out of reach - after the page moved
/// the bar within it, or a monitor went away.
pub fn ensure_visible(app: &AppHandle) {
    let Some(window) = app.get_webview_window(INGAME_WINDOW) else { return };
    if DRAGGING.load(Ordering::Relaxed) {
        return;
    }
    let Some((pos, size)) = frame(&window) else { return };
    let fixed = on_visible_screen(&window, pos, size);
    if fixed != pos {
        let _ = window.set_position(fixed);
        remember_frame(fixed, size);
        save_geometry(&window);
    }
}

/// The mouse is on the control bar: a click there makes macOS activate the
/// app, which must not open the settings window as a Dock click does.
pub fn clicking_the_bar() -> bool {
    CATCHING.load(Ordering::Relaxed)
}
/// Where the page last said its control bar is (None: not shown).
static CONTROLS_RECT: Mutex<Option<HudRect>> = Mutex::new(None);

/// The page reports where its control bar is — the one spot of the window
/// that takes clicks.
pub fn set_controls_rect(rect: Option<HudRect>) {
    *CONTROLS_RECT.lock_safe() = rect;
}

/// Sizes the window to the room the overlay needs (CSS pixels), keeping the
/// corner the overlay is pinned to where it is (see #combo-overlay in
/// ui/overlay/style.css).
pub fn fit(app: &AppHandle, width: f64, height: f64, keep_left: bool, keep_bottom: bool) {
    let Some(window) = app.get_webview_window(INGAME_WINDOW) else { return };
    let (Some((pos, old)), Ok(scale)) = (frame(&window), window.scale_factor()) else { return };
    let new: PhysicalSize<u32> = LogicalSize::new(width.ceil(), height.ceil()).to_physical(scale);
    if new == old {
        return;
    }
    let x = if keep_left { pos.x } else { pos.x + old.width as i32 - new.width as i32 };
    let y = if keep_bottom { pos.y + old.height as i32 - new.height as i32 } else { pos.y };
    let target = on_visible_screen(&window, PhysicalPosition::new(x, y), new);
    let _ = window.set_size(new);
    let _ = window.set_position(target);
    remember_frame(target, new);
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
        let start = (foreground::cursor_position(&window), frame(&window));
        if let (Some((start_x, start_y)), Some((origin, size))) = start {
            while foreground::left_button_down() {
                if let Some((x, y)) = foreground::cursor_position(&window) {
                    let wanted = PhysicalPosition::new(origin.x + x - start_x, origin.y + y - start_y);
                    let target = on_visible_screen(&window, wanted, size);
                    let _ = window.set_position(target);
                    remember_frame(target, size);
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
        // Whether "only over Wakfu" can work here at all.
        "canTellWakfu": foreground::can_tell_front(),
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
    *FRAME.lock_safe() = None;
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
    let mut ticks = 0u32;
    while let Some(window) = app.get_webview_window(INGAME_WINDOW) {
        // About once a second: a monitor may have been unplugged.
        ticks = ticks.wrapping_add(1);
        if ticks.is_multiple_of(20) {
            ensure_visible(&app);
        }
        let dragging = DRAGGING.load(Ordering::Relaxed);
        // When it can't be told (no X11 session), always shown.
        let show = !only_over_wakfu(&app) || dragging || foreground::wakfu_or_own_in_front(&window) != Some(false);
        if foreground::set_shown(&window, show) {
            // Mapped again, it may have lost its click-through state (X11).
            let _ = window.set_ignore_cursor_events(!catching);
        }
        let over_controls = show && (dragging || cursor_over_controls(&window));
        if over_controls != catching {
            let _ = window.set_ignore_cursor_events(!over_controls);
            catching = over_controls;
            CATCHING.store(catching, Ordering::Relaxed);
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

fn cursor_over_controls(window: &WebviewWindow) -> bool {
    let Some(rect) = *CONTROLS_RECT.lock_safe() else { return false };
    let (Some((cursor_x, cursor_y)), Ok(origin), Ok(scale)) =
        (foreground::cursor_position(window), window.inner_position(), window.scale_factor())
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
    CATCHING.store(false, Ordering::Relaxed);
    *FRAME.lock_safe() = None;
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
        let size = PhysicalSize::new(width, height);
        let pos = on_visible_screen(window, PhysicalPosition::new(x, y), size);
        let _ = window.set_size(size);
        let _ = window.set_position(pos);
        remember_frame(pos, size);
        return;
    }
    let (Ok(Some(monitor)), Ok(size)) = (window.primary_monitor(), window.outer_size()) else { return };
    let scale = monitor.scale_factor();
    let x = monitor.position().x + monitor.size().width as i32 - size.width as i32 - (24.0 * scale) as i32;
    let y = monitor.position().y + (96.0 * scale) as i32;
    let pos = on_visible_screen(window, PhysicalPosition::new(x, y), size);
    let _ = window.set_position(pos);
    remember_frame(pos, size);
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
    let Some((pos, size)) = frame(window) else { return };
    let state = window.app_handle().state::<AppState>();
    state.core.lock_safe().settings.set_ingame_overlay_geometry(pos.x, pos.y, size.width, size.height);
}


/// Which window is in front, the mouse, and showing ours without activating
/// it — the game keeps the focus. One implementation per system.
mod foreground {
    /// Wakfu titles its windows "Pseudo - WAKFU" (just "WAKFU" before login),
    /// natively as under Wine.
    #[cfg_attr(target_os = "macos", allow(dead_code))]
    pub fn is_wakfu_title(title: &str) -> bool {
        let title = title.trim().to_uppercase();
        title == "WAKFU" || title.ends_with(" - WAKFU")
    }

    /// macOS only tells which application is in front, not which window: is
    /// it Wakfu, by its name, bundle identifier or executable path?
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    pub fn is_wakfu_app(name: &str) -> bool {
        name.to_lowercase().contains("wakfu")
    }

    pub use imp::*;

    #[cfg(windows)]
    mod imp {
        use tauri::WebviewWindow;
        use windows_sys::Win32::Foundation::POINT;
        use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON};
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            GetCursorPos, GetForegroundWindow, GetWindowTextW, GetWindowThreadProcessId, IsWindowVisible, ShowWindow,
            SW_HIDE, SW_SHOWNOACTIVATE,
        };

        use super::is_wakfu_title;

        pub fn can_tell_front() -> bool {
            true
        }

        /// A Wakfu window, or one of the app's own other than the overlay
        /// (the settings window, so the overlay shows while it's being set up).
        pub fn wakfu_or_own_in_front(window: &WebviewWindow) -> Option<bool> {
            let overlay = window.hwnd().ok()?.0;
            // SAFETY: plain Win32 queries on whatever window is in front; a
            // window closing meanwhile just makes them fail (0 / empty title).
            unsafe {
                let hwnd = GetForegroundWindow();
                if hwnd.is_null() || hwnd == overlay {
                    return Some(false);
                }
                let mut pid = 0u32;
                GetWindowThreadProcessId(hwnd, &mut pid);
                if pid == std::process::id() {
                    return Some(true);
                }
                let mut buffer = [0u16; 256];
                let len = GetWindowTextW(hwnd, buffer.as_mut_ptr(), buffer.len() as i32);
                Some(len > 0 && is_wakfu_title(&String::from_utf16_lossy(&buffer[..len as usize])))
            }
        }

        /// The mouse, in physical screen pixels.
        pub fn cursor_position(_window: &WebviewWindow) -> Option<(i32, i32)> {
            let mut point = POINT { x: 0, y: 0 };
            // SAFETY: GetCursorPos only writes the POINT it's given.
            (unsafe { GetCursorPos(&mut point) } != 0).then_some((point.x, point.y))
        }

        /// Whether the (primary) mouse button is held, wherever the mouse is.
        pub fn left_button_down() -> bool {
            // SAFETY: a plain state query; the high bit means "down".
            unsafe { GetAsyncKeyState(i32::from(VK_LBUTTON)) as u16 & 0x8000 != 0 }
        }

        /// Shows or hides the window (Tauri's `show` would take the focus
        /// from the game). True when it was just shown.
        pub fn set_shown(window: &WebviewWindow, show: bool) -> bool {
            let Ok(hwnd) = window.hwnd() else { return false };
            // SAFETY: `hwnd` is our own live window, from Tauri.
            unsafe {
                if (IsWindowVisible(hwnd.0) != 0) == show {
                    return false;
                }
                ShowWindow(hwnd.0, if show { SW_SHOWNOACTIVATE } else { SW_HIDE });
            }
            show
        }
    }

    /// Asked to the X server: under XWayland, Wakfu (a Java game) and this
    /// app are both X11 clients, and a native Wayland window in front reads
    /// as no window at all.
    #[cfg(target_os = "linux")]
    mod imp {
        use std::sync::{Mutex, OnceLock};
        use tauri::{PhysicalPosition, WebviewWindow};
        use x11rb::connection::Connection;
        use x11rb::protocol::xproto::{Atom, AtomEnum, ConnectionExt, GetPropertyReply, KeyButMask, QueryPointerReply, Window};
        use x11rb::rust_connection::RustConnection;

        use super::is_wakfu_title;
        use crate::app_state::LockExt;

        struct X11 {
            conn: RustConnection,
            root: Window,
            net_active_window: Atom,
            net_wm_pid: Atom,
            net_wm_name: Atom,
            utf8_string: Atom,
        }

        /// Connected on first use. None without an X server (a Wayland
        /// session without XWayland): the overlay then always shows.
        fn x11() -> Option<&'static X11> {
            static X11: OnceLock<Option<X11>> = OnceLock::new();
            X11.get_or_init(|| {
                let (conn, screen) = x11rb::connect(None).ok()?;
                let root = conn.setup().roots.get(screen)?.root;
                let atom = |name: &str| Some(conn.intern_atom(false, name.as_bytes()).ok()?.reply().ok()?.atom);
                let net_active_window = atom("_NET_ACTIVE_WINDOW")?;
                let net_wm_pid = atom("_NET_WM_PID")?;
                let net_wm_name = atom("_NET_WM_NAME")?;
                let utf8_string = atom("UTF8_STRING")?;
                Some(X11 { conn, root, net_active_window, net_wm_pid, net_wm_name, utf8_string })
            })
            .as_ref()
        }

        impl X11 {
            fn property(&self, window: Window, property: impl Into<Atom>, kind: impl Into<Atom>, longs: u32) -> Option<GetPropertyReply> {
                self.conn.get_property(false, window, property, kind, 0, longs).ok()?.reply().ok()
            }

            fn number(&self, window: Window, property: Atom, kind: AtomEnum) -> Option<u32> {
                self.property(window, property, kind, 1)?.value32()?.next()
            }

            fn title(&self, window: Window) -> String {
                if let Some(reply) = self.property(window, self.net_wm_name, self.utf8_string, 256) {
                    if !reply.value.is_empty() {
                        return String::from_utf8_lossy(&reply.value).into_owned();
                    }
                }
                // Clients that only set the old Latin-1 title.
                self.property(window, AtomEnum::WM_NAME, AtomEnum::STRING, 256)
                    .map(|reply| reply.value.iter().map(|&byte| char::from(byte)).collect())
                    .unwrap_or_default()
            }

            fn pointer(&self) -> Option<QueryPointerReply> {
                self.conn.query_pointer(self.root).ok()?.reply().ok()
            }
        }

        pub fn can_tell_front() -> bool {
            x11().is_some()
        }

        /// A Wakfu window, or one of the app's own (the overlay never is: it
        /// can't take the focus).
        pub fn wakfu_or_own_in_front(_window: &WebviewWindow) -> Option<bool> {
            let x11 = x11()?;
            // None too when the window manager doesn't say (no EWMH support).
            let active = x11.number(x11.root, x11.net_active_window, AtomEnum::WINDOW)?;
            if active == 0 {
                return Some(false);
            }
            if x11.number(active, x11.net_wm_pid, AtomEnum::CARDINAL) == Some(std::process::id()) {
                return Some(true);
            }
            Some(is_wakfu_title(&x11.title(active)))
        }

        /// The mouse, in physical screen pixels (X11's own, like the window's position).
        pub fn cursor_position(_window: &WebviewWindow) -> Option<(i32, i32)> {
            let pointer = x11()?.pointer()?;
            Some((pointer.root_x.into(), pointer.root_y.into()))
        }

        pub fn left_button_down() -> bool {
            x11().and_then(X11::pointer).is_some_and(|pointer| pointer.mask.contains(KeyButMask::BUTTON1))
        }

        /// Where the window was when hidden: the window manager may place it
        /// anew when it's shown again.
        static HIDDEN_AT: Mutex<Option<PhysicalPosition<i32>>> = Mutex::new(None);

        /// Shows or hides the window — it can't take the focus (`focusable`),
        /// so showing it leaves the game's. True when it was just shown.
        pub fn set_shown(window: &WebviewWindow, show: bool) -> bool {
            if window.is_visible().unwrap_or(show) == show {
                return false;
            }
            if show {
                let _ = window.show();
                if let Some(position) = HIDDEN_AT.lock_safe().take() {
                    let _ = window.set_position(position);
                }
            } else {
                *HIDDEN_AT.lock_safe() = window.outer_position().ok();
                let _ = window.hide();
            }
            show
        }
    }

    #[cfg(target_os = "macos")]
    mod imp {
        use objc2::rc::autoreleasepool;
        use objc2_app_kit::{NSEvent, NSWorkspace};
        use tauri::WebviewWindow;

        use super::is_wakfu_app;

        pub fn can_tell_front() -> bool {
            true
        }

        /// Wakfu, or this app (the settings window, so the overlay shows
        /// while it's being set up).
        pub fn wakfu_or_own_in_front(_window: &WebviewWindow) -> Option<bool> {
            autoreleasepool(|_| {
                let front = NSWorkspace::sharedWorkspace().frontmostApplication()?;
                if front.processIdentifier() as u32 == std::process::id() {
                    return Some(true);
                }
                let name = front.localizedName().map(|name| name.to_string());
                let bundle = front.bundleIdentifier().map(|id| id.to_string());
                let executable = front.executableURL().and_then(|url| url.path()).map(|path| path.to_string());
                Some([name, bundle, executable].iter().flatten().any(|name| is_wakfu_app(name)))
            })
        }

        /// The mouse, in the same physical pixels as the window's position.
        pub fn cursor_position(window: &WebviewWindow) -> Option<(i32, i32)> {
            let position = window.cursor_position().ok()?;
            Some((position.x.round() as i32, position.y.round() as i32))
        }

        pub fn left_button_down() -> bool {
            NSEvent::pressedMouseButtons() & 1 != 0
        }

        /// Shows or hides the window — it can't become the key window
        /// (`focusable`), so showing it leaves the game in front. True when
        /// it was just shown.
        pub fn set_shown(window: &WebviewWindow, show: bool) -> bool {
            if window.is_visible().unwrap_or(show) == show {
                return false;
            }
            let _ = if show { window.show() } else { window.hide() };
            show
        }
    }

    #[cfg(test)]
    mod tests {
        use super::{is_wakfu_app, is_wakfu_title};

        #[test]
        fn recognizes_wakfu_windows() {
            assert!(is_wakfu_title("Lueur Pourpre - WAKFU"));
            assert!(is_wakfu_title("WAKFU"));
            assert!(is_wakfu_title("lueur pourpre - Wakfu"));
            assert!(!is_wakfu_title("Wakfu Combo Overlay"));
            assert!(!is_wakfu_title("wakfu.log - Notepad"));
            assert!(!is_wakfu_title("Guide WAKFU - Google Chrome"));
        }

        #[test]
        fn recognizes_the_wakfu_application() {
            assert!(is_wakfu_app("Wakfu"));
            assert!(is_wakfu_app("/Users/me/Library/Application Support/zaap/wakfu/Wakfu.app/Contents/MacOS/Wakfu"));
            assert!(!is_wakfu_app("Ankama Launcher"));
            assert!(!is_wakfu_app("com.google.Chrome"));
        }
    }
}

#[cfg(test)]
mod bar_tests {
    use super::keep_bar_visible;

    const SCREEN: [(i32, i32, i32, i32); 1] = [(0, 25, 1440, 800)];
    // A 200 x 30 bar, 10 px in from the window's left and top edges.
    const BAR: (i32, i32, i32, i32) = (10, 10, 200, 30);

    #[test]
    fn leaves_a_reachable_bar_alone() {
        assert_eq!(keep_bar_visible((300, 200), BAR, &SCREEN), (300, 200));
    }

    #[test]
    fn pulls_a_bar_back_from_every_side() {
        // Past the right and bottom edges, the bar's far corner is the limit.
        assert_eq!(keep_bar_visible((5000, 5000), BAR, &SCREEN), (1440 - 210, 825 - 40));
        // Past the left edge and under the menu bar.
        assert_eq!(keep_bar_visible((-900, -300), BAR, &SCREEN), (-10, 15));
    }

    #[test]
    fn a_window_may_hang_off_the_screen_while_its_bar_is_inside() {
        assert_eq!(keep_bar_visible((-400, 100), BAR, &SCREEN), (-10, 100));
        assert_eq!(keep_bar_visible((1300, 100), BAR, &SCREEN), (1230, 100));
    }

    #[test]
    fn picks_the_screen_the_bar_is_mostly_on() {
        let two = [(0, 0, 1000, 800), (1000, 0, 1000, 800)];
        // The bar straddles the seam: it's brought wholly onto the screen it is mostly on.
        assert_eq!(keep_bar_visible((950, 100), BAR, &two), (990, 100));
        // Off every screen: the nearest one takes it.
        assert_eq!(keep_bar_visible((3000, 100), BAR, &two), (1790, 100));
    }

    #[test]
    fn no_screen_known_means_no_change() {
        assert_eq!(keep_bar_visible((9, 9), BAR, &[]), (9, 9));
    }
}
