//! The overlay's local HTTP server: serves the overlay page (ui/overlay) and
//! the icons (ui/assets) to OBS's browser source, and pushes live events to it
//! over Server-Sent Events on /events.
//!
//! Hand-rolled on purpose: it answers a single local client (OBS) a handful
//! of GETs plus one long-lived event stream, which a few dozen lines of tokio
//! cover without pulling in a whole HTTP framework.

use serde::Serialize;
use std::collections::VecDeque;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc::{channel, Receiver, Sender};
use tokio::task::JoinSet;

const CAST_BUFFER_SIZE: usize = 20;
const MAX_REQUEST_HEAD_BYTES: usize = 8 * 1024;
const REQUEST_HEAD_TIMEOUT: Duration = Duration::from_secs(10);
/// Connections served at once. The one real client is OBS (plus the in-game
/// window), so this only ever bites a misbehaving local program.
const MAX_CONNECTIONS: usize = 64;
/// Events queued for one stream before it's considered stuck and dropped —
/// otherwise a client that stops reading would make the queue grow forever.
const CLIENT_QUEUE_SIZE: usize = 256;
/// Sent on idle streams so a client that vanished without closing is noticed.
const KEEPALIVE_INTERVAL: Duration = Duration::from_secs(15);
/// The in-game window's requests carry this header. A custom header can't be
/// sent cross-origin without a CORS preflight, which this server never
/// answers: so no web page can trigger the /hud/* actions.
/// Nothing the overlay page loads comes from anywhere but this server.
const SECURITY_HEADERS: &str = "X-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\n\
Content-Security-Policy: default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; \
connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'\r\n";
const HUD_HEADER: &str = "x-wakfu-overlay";

/// Looks up a file of ui/ by its path relative to it ("overlay/index.html").
pub type FileSource = Arc<dyn Fn(&str) -> Option<Vec<u8>> + Send + Sync>;

/// Where the in-game window's counter switch is, in CSS pixels of its page.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct HudRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// What the in-game window's page asks of the app. It's a plain page served
/// from here, with no Tauri IPC: it sends these as GETs on /hud/….
#[derive(Debug, Clone, PartialEq)]
pub enum HudRequest {
    /// Where the control bar is (the window's only clickable spot), or
    /// `None` when it isn't shown.
    ControlsRect(Option<HudRect>),
    /// The bar's turn/fight switch was clicked: "turn" or "fight".
    CounterMode(String),
    /// The room the overlay needs, in CSS pixels.
    Size { width: f64, height: f64 },
    /// The bar's handle was pressed: the window follows the mouse.
    Drag,
    /// The bar's "Récap" button.
    Recap,
}

pub type HudHandler = Arc<dyn Fn(HudRequest) + Send + Sync>;

/// What every connected overlay receives, plus what a newly connected one is
/// replayed so it shows the current state right away.
#[derive(Default)]
pub struct OverlayHub {
    state: Mutex<HubState>,
}

#[derive(Default)]
struct HubState {
    clients: Vec<Client>,
    last_config: Option<String>,
    cast_buffer: VecDeque<String>,
    last_turn_damage: Option<String>,
}

struct Client {
    tx: Sender<Arc<str>>,
    /// The app's own in-game window, rather than OBS.
    ingame: bool,
}

fn frame(event: &str, data: &str) -> Arc<str> {
    Arc::from(format!("event: {event}\ndata: {data}\n\n"))
}

impl OverlayHub {
    /// Number of browser clients (OBS) currently connected to /events — the
    /// in-game window doesn't count.
    pub fn client_count(&self) -> usize {
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        state.clients.retain(|c| !c.tx.is_closed());
        state.clients.iter().filter(|c| !c.ingame).count()
    }

    /// Push a display-config change (e.g. combo-list layout).
    pub fn broadcast_config(&self, config: &impl Serialize) {
        let data = serde_json::to_string(config).unwrap_or_default();
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        state.send(frame("config", &data));
        state.last_config = Some(data);
    }

    /// Push a discrete spell-cast event.
    pub fn broadcast_cast(&self, event: &impl Serialize) {
        let data = serde_json::to_string(event).unwrap_or_default();
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        state.send(frame("cast", &data));
        state.cast_buffer.push_back(data);
        if state.cast_buffer.len() > CAST_BUFFER_SIZE {
            state.cast_buffer.pop_front();
        }
    }

    /// Push the running damage total of the current (or just-ended) turn.
    pub fn broadcast_turn_damage(&self, event: &impl Serialize) {
        let data = serde_json::to_string(event).unwrap_or_default();
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        state.send(frame("turn-damage", &data));
        state.last_turn_damage = Some(data);
    }

    /// Registers a new client and returns, atomically with that, what it must
    /// be replayed first — so no event can slip in between or show up twice.
    fn subscribe(&self, ingame: bool) -> (String, Receiver<Arc<str>>) {
        let (tx, rx) = channel(CLIENT_QUEUE_SIZE);
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        let mut replay = String::from(": connected\n\n");
        if let Some(config) = &state.last_config {
            replay.push_str(&frame("config", config));
        }
        for cast in &state.cast_buffer {
            replay.push_str(&frame("cast", cast));
        }
        if let Some(damage) = &state.last_turn_damage {
            replay.push_str(&frame("turn-damage", damage));
        }
        state.clients.push(Client { tx, ingame });
        (replay, rx)
    }
}

impl HubState {
    fn send(&mut self, payload: Arc<str>) {
        // A full queue means a stuck client: it's dropped rather than waited for.
        self.clients.retain(|c| c.tx.try_send(payload.clone()).is_ok());
    }
}

/// A listening server. Dropping it (or `stop`) closes the port and every
/// connection it accepted.
pub struct OverlayServer {
    task: tauri::async_runtime::JoinHandle<()>,
}

impl OverlayServer {
    /// Binds 127.0.0.1:`port`. Never panics on a bind failure (e.g. port
    /// already in use): the error comes back as a message for the user.
    pub async fn start(port: u16, hub: Arc<OverlayHub>, files: FileSource, hud: HudHandler) -> Result<Self, String> {
        let listener = TcpListener::bind(("127.0.0.1", port)).await.map_err(|e| describe_listen_error(&e))?;
        println!("[OverlayServer] http://localhost:{port}");
        let task = tauri::async_runtime::spawn(async move {
            // Owned here so that aborting this task drops — and so aborts —
            // every connection it accepted.
            let mut connections = JoinSet::new();
            loop {
                tokio::select! {
                    accepted = listener.accept() => {
                        if let Ok((stream, _)) = accepted {
                            if connections.len() < MAX_CONNECTIONS {
                                connections.spawn(handle(stream, port, hub.clone(), files.clone(), hud.clone()));
                            }
                        }
                    }
                    Some(_) = connections.join_next() => {}
                }
            }
        });
        Ok(Self { task })
    }

    pub fn stop(&self) {
        self.task.abort();
    }
}

impl Drop for OverlayServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// Access denied on an unprivileged port almost always means Windows has
/// reserved it (Hyper-V / WSL / Docker grab random port ranges, re-rolled at
/// each reboot — see `netsh interface ipv4 show excludedportrange
/// protocol=tcp`), which is why it can work one day and fail the next.
/// Elsewhere it's rarer: a sandbox or security rule.
fn describe_listen_error(err: &std::io::Error) -> String {
    match err.kind() {
        std::io::ErrorKind::AddrInUse => "Port déjà utilisé par un autre programme.".into(),
        std::io::ErrorKind::PermissionDenied if cfg!(windows) => {
            "Port réservé par Windows (Hyper-V/WSL/Docker) — choisis-en un autre.".into()
        }
        std::io::ErrorKind::PermissionDenied => "Port refusé par le système — choisis-en un autre.".into(),
        _ => err.to_string(),
    }
}

fn mime_type(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or_default() {
        "html" => "text/html; charset=utf-8",
        "css" => "text/css",
        "js" => "application/javascript",
        "png" => "image/png",
        "jpg" => "image/jpeg",
        "gif" => "image/gif",
        "json" => "application/json",
        "woff2" => "font/woff2",
        _ => "application/octet-stream",
    }
}

/// The ui/ file a request path maps to: /assets/* as is, anything else from
/// the overlay page's own folder.
fn ui_path(pathname: &str) -> Option<String> {
    let relative = pathname.trim_start_matches('/');
    if relative.split('/').any(|segment| segment == ".." || segment.contains('\\')) {
        return None;
    }
    Some(if relative.starts_with("assets/") {
        relative.to_string()
    } else if relative.is_empty() {
        "overlay/index.html".to_string()
    } else {
        format!("overlay/{relative}")
    })
}

fn percent_decode(path: &str) -> String {
    let bytes = path.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or_default();
            if let Ok(byte) = u8::from_str_radix(hex, 16) {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

async fn read_request_head(stream: &mut TcpStream) -> Option<String> {
    let mut head = Vec::with_capacity(1024);
    let mut chunk = [0u8; 1024];
    while !head.windows(4).any(|w| w == b"\r\n\r\n") {
        if head.len() > MAX_REQUEST_HEAD_BYTES {
            return None;
        }
        let read = stream.read(&mut chunk).await.ok()?;
        if read == 0 {
            return None;
        }
        head.extend_from_slice(&chunk[..read]);
    }
    Some(String::from_utf8_lossy(&head).into_owned())
}

/// Icons and fonts are kept by the browser: the class icon is re-created on
/// every hero change, and refetching it each time made it pop in mid
/// animation. The page, its script and its style are always revalidated, so
/// an update shows on the next OBS refresh.
fn cache_control(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or_default() {
        "png" | "jpg" | "gif" | "woff2" => "max-age=86400",
        _ => "no-cache",
    }
}

async fn respond(stream: &mut TcpStream, status: &str, mime: &str, cache: &str, body: &[u8], head_only: bool) {
    let header = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {mime}\r\nContent-Length: {}\r\nCache-Control: {cache}\r\n{SECURITY_HEADERS}Connection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(header.as_bytes()).await;
    if !head_only {
        let _ = stream.write_all(body).await;
    }
    let _ = stream.shutdown().await;
}

/// A query string's `key=value` pairs (values here are plain words and numbers).
fn query_params(target: &str) -> impl Iterator<Item = (&str, &str)> {
    let query = target.split('#').next().unwrap_or_default().split_once('?').map_or("", |(_, q)| q);
    query.split('&').filter_map(|param| param.split_once('='))
}

fn hud_request(command: &str, target: &str) -> Option<HudRequest> {
    let param = |key: &str| query_params(target).find(|(k, _)| *k == key).map(|(_, v)| v);
    let number = |key: &str| param(key)?.parse::<f64>().ok().filter(|n| n.is_finite());
    match command {
        "controls-rect" => {
            let rect = (|| {
                let rect = HudRect { x: number("x")?, y: number("y")?, width: number("w")?, height: number("h")? };
                (rect.width > 0.0 && rect.height > 0.0).then_some(rect)
            })();
            Some(HudRequest::ControlsRect(rect))
        }
        "counter-mode" => param("mode").filter(|m| matches!(*m, "turn" | "fight")).map(|m| HudRequest::CounterMode(m.into())),
        "size" => {
            let (width, height) = (number("w")?, number("h")?);
            (width > 0.0 && height > 0.0).then_some(HudRequest::Size { width, height })
        }
        "drag" => Some(HudRequest::Drag),
        "recap" => Some(HudRequest::Recap),
        _ => None,
    }
}

/// The request head's header named `name` (lowercase), if any.
fn header<'a>(head: &'a str, name: &str) -> Option<&'a str> {
    head.lines().skip(1).take_while(|line| !line.is_empty()).find_map(|line| {
        let (key, value) = line.split_once(':')?;
        key.trim().eq_ignore_ascii_case(name).then(|| value.trim())
    })
}

/// Only the loopback names on our own port are accepted as `Host`. A page on
/// another domain that was re-pointed at 127.0.0.1 (DNS rebinding) still
/// sends its own name here, so it can't read the overlay's events.
fn host_is_local(host: Option<&str>, port: u16) -> bool {
    let Some(host) = host else { return false };
    [format!("localhost:{port}"), format!("127.0.0.1:{port}")].iter().any(|ok| host.eq_ignore_ascii_case(ok))
}

/// A cross-origin page may still fire a plain GET at us (an `<img>`, a
/// `fetch` in no-cors mode); browsers label those. Same-origin loads and
/// address-bar visits stay allowed.
fn origin_is_local(head: &str, port: u16) -> bool {
    if let Some(site) = header(head, "sec-fetch-site") {
        if !matches!(site, "same-origin" | "none") {
            return false;
        }
    }
    match header(head, "origin") {
        None => true,
        Some(origin) => host_is_local(origin.strip_prefix("http://"), port),
    }
}

async fn handle(mut stream: TcpStream, port: u16, hub: Arc<OverlayHub>, files: FileSource, hud: HudHandler) {
    let Ok(Some(head)) = tokio::time::timeout(REQUEST_HEAD_TIMEOUT, read_request_head(&mut stream)).await else {
        return;
    };
    let mut parts = head.lines().next().unwrap_or_default().split_whitespace();
    let method = parts.next().unwrap_or_default();
    let target = parts.next().unwrap_or("/");
    if method != "GET" && method != "HEAD" {
        return respond(&mut stream, "405 Method Not Allowed", "text/plain", "no-cache", b"", false).await;
    }
    let pathname = percent_decode(target.split(['?', '#']).next().unwrap_or("/"));

    if !host_is_local(header(&head, "host"), port) {
        return respond(&mut stream, "421 Misdirected Request", "text/plain", "no-cache", b"", false).await;
    }
    let live = pathname == "/events" || pathname.starts_with("/hud/");
    if live && !origin_is_local(&head, port) {
        return respond(&mut stream, "403 Forbidden", "text/plain", "no-cache", b"", false).await;
    }

    if pathname == "/events" {
        return stream_events(stream, hub, is_ingame(target)).await;
    }
    if let Some(command) = pathname.strip_prefix("/hud/") {
        if header(&head, HUD_HEADER).is_none() {
            return respond(&mut stream, "403 Forbidden", "text/plain", "no-cache", b"", false).await;
        }
        return match hud_request(command, target) {
            Some(request) => {
                hud(request);
                respond(&mut stream, "204 No Content", "text/plain", "no-cache", b"", false).await
            }
            None => respond(&mut stream, "400 Bad Request", "text/plain", "no-cache", b"", false).await,
        };
    }

    let Some(path) = ui_path(&pathname) else {
        return respond(&mut stream, "403 Forbidden", "text/plain", "no-cache", b"", false).await;
    };
    match files(&path) {
        Some(body) => {
            respond(&mut stream, "200 OK", mime_type(&path), cache_control(&path), &body, method == "HEAD").await
        }
        None => respond(&mut stream, "404 Not Found", "text/plain", "no-cache", b"Not found", false).await,
    }
}

/// The in-game window loads the page with `?ingame`, which client.js passes on to /events.
fn is_ingame(target: &str) -> bool {
    let query = target.split('#').next().unwrap_or_default().split_once('?').map_or("", |(_, q)| q);
    query.split('&').any(|param| param == "ingame")
}

async fn stream_events(mut stream: TcpStream, hub: Arc<OverlayHub>, ingame: bool) {
    let header = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\n{SECURITY_HEADERS}Connection: keep-alive\r\n\r\n"
    );
    if stream.write_all(header.as_bytes()).await.is_err() {
        return;
    }
    let (replay, mut events) = hub.subscribe(ingame);
    if stream.write_all(replay.as_bytes()).await.is_err() {
        return;
    }
    let (mut reader, mut writer) = stream.into_split();
    let mut discard = [0u8; 256];
    let mut keepalive = tokio::time::interval(KEEPALIVE_INTERVAL);
    keepalive.tick().await;
    loop {
        tokio::select! {
            _ = keepalive.tick() => {
                if writer.write_all(b": keepalive\n\n").await.is_err() {
                    return;
                }
            }
            event = events.recv() => {
                let Some(event) = event else { return };
                if writer.write_all(event.as_bytes()).await.is_err() {
                    return;
                }
            }
            // The client never sends anything more; a read only completes
            // when it disconnects.
            read = reader.read(&mut discard) => {
                if matches!(read, Ok(0) | Err(_)) {
                    return;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_request_paths_to_ui_files() {
        assert_eq!(ui_path("/").as_deref(), Some("overlay/index.html"));
        assert_eq!(ui_path("/client.js").as_deref(), Some("overlay/client.js"));
        assert_eq!(ui_path("/assets/icons/cra/1.png").as_deref(), Some("assets/icons/cra/1.png"));
        assert_eq!(ui_path("/assets/../settings/index.html"), None);
        assert_eq!(ui_path("/..\\x"), None);
    }

    #[test]
    fn reads_the_in_game_windows_requests() {
        let rect = HudRect { x: 10.0, y: 20.5, width: 24.0, height: 14.0 };
        assert_eq!(
            hud_request("controls-rect", "/hud/controls-rect?x=10&y=20.5&w=24&h=14"),
            Some(HudRequest::ControlsRect(Some(rect)))
        );
        assert_eq!(hud_request("controls-rect", "/hud/controls-rect?none"), Some(HudRequest::ControlsRect(None)));
        assert_eq!(
            hud_request("size", "/hud/size?w=420&h=610.5"),
            Some(HudRequest::Size { width: 420.0, height: 610.5 })
        );
        assert_eq!(hud_request("size", "/hud/size?w=0&h=10"), None);
        assert_eq!(hud_request("drag", "/hud/drag"), Some(HudRequest::Drag));
        assert_eq!(hud_request("recap", "/hud/recap"), Some(HudRequest::Recap));
        assert_eq!(
            hud_request("counter-mode", "/hud/counter-mode?mode=fight"),
            Some(HudRequest::CounterMode("fight".into()))
        );
        assert_eq!(hud_request("counter-mode", "/hud/counter-mode?mode=forever"), None);
        assert_eq!(hud_request("shutdown", "/hud/shutdown"), None);
    }

    #[test]
    fn caches_icons_but_not_the_page() {
        assert_eq!(cache_control("assets/icons/cra/1420.png"), "max-age=86400");
        assert_eq!(cache_control("overlay/fonts/ibm-plex-sans-latin.woff2"), "max-age=86400");
        assert_eq!(cache_control("overlay/index.html"), "no-cache");
        assert_eq!(cache_control("overlay/client.js"), "no-cache");
        assert_eq!(cache_control("overlay/style.css"), "no-cache");
    }

    #[test]
    fn tells_the_ingame_window_from_obs() {
        assert!(is_ingame("/events?ingame"));
        assert!(is_ingame("/events?a=1&ingame"));
        assert!(!is_ingame("/events"));
        assert!(!is_ingame("/events?ingame=0"));
    }

    #[test]
    fn only_answers_to_its_own_loopback_host() {
        assert!(host_is_local(Some("localhost:3457"), 3457));
        assert!(host_is_local(Some("127.0.0.1:3457"), 3457));
        assert!(!host_is_local(Some("evil.example:3457"), 3457));
        assert!(!host_is_local(Some("localhost:3458"), 3457));
        assert!(!host_is_local(Some("localhost"), 3457));
        assert!(!host_is_local(None, 3457));
    }

    #[test]
    fn refuses_cross_site_requests() {
        let same = "GET /events HTTP/1.1\r\nHost: localhost:1\r\nSec-Fetch-Site: same-origin\r\n\r\n";
        let none = "GET /events HTTP/1.1\r\nhost: localhost:1\r\n\r\n";
        let cross = "GET /hud/recap HTTP/1.1\r\nHost: localhost:1\r\nSec-Fetch-Site: cross-site\r\n\r\n";
        let foreign = "GET /events HTTP/1.1\r\nHost: localhost:1\r\nOrigin: http://evil.example\r\n\r\n";
        let own = "GET /events HTTP/1.1\r\nHost: localhost:1\r\nOrigin: http://127.0.0.1:1\r\n\r\n";
        assert!(origin_is_local(same, 1) && origin_is_local(none, 1) && origin_is_local(own, 1));
        assert!(!origin_is_local(cross, 1) && !origin_is_local(foreign, 1));
        assert_eq!(header(cross, "host"), Some("localhost:1"));
        assert_eq!(header(none, "x-wakfu-overlay"), None);
    }

    #[test]
    fn drops_a_client_that_stopped_reading() {
        let hub = OverlayHub::default();
        let (_replay, _rx) = hub.subscribe(false);
        assert_eq!(hub.client_count(), 1);
        for i in 0..=CLIENT_QUEUE_SIZE {
            hub.broadcast_turn_damage(&serde_json::json!({ "i": i }));
        }
        assert_eq!(hub.client_count(), 0);
    }

    #[test]
    fn decodes_percent_escapes() {
        assert_eq!(percent_decode("/a%20b"), "/a b");
        assert_eq!(percent_decode("/%2e%2e/x"), "/../x");
        assert_eq!(percent_decode("/100%"), "/100%");
    }
}
