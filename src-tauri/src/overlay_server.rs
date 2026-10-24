//! The overlay's local HTTP server: serves the overlay page (ui/overlay) and
//! the icons (ui/assets) to OBS's browser source, and pushes live events to it
//! over Server-Sent Events on /events.
//!
//! Hand-rolled on purpose: it answers a single local client (OBS) a handful
//! of GETs plus one long-lived event stream, which a few dozen lines of tokio
//! cover without pulling in a whole HTTP framework.

use serde::Serialize;
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc::{unbounded_channel, UnboundedSender};
use tokio::task::JoinSet;

const CAST_BUFFER_SIZE: usize = 20;
const MAX_REQUEST_HEAD_BYTES: usize = 8 * 1024;
const REQUEST_HEAD_TIMEOUT: Duration = Duration::from_secs(10);

/// Looks up a file of ui/ by its path relative to it ("overlay/index.html").
pub type FileSource = Arc<dyn Fn(&str) -> Option<Vec<u8>> + Send + Sync>;

/// What every connected overlay receives, plus what a newly connected one is
/// replayed so it shows the current state right away.
#[derive(Default)]
pub struct OverlayHub {
    state: Mutex<HubState>,
}

#[derive(Default)]
struct HubState {
    clients: Vec<UnboundedSender<Arc<str>>>,
    last_config: Option<String>,
    cast_buffer: VecDeque<String>,
    last_turn_damage: Option<String>,
}

fn frame(event: &str, data: &str) -> Arc<str> {
    Arc::from(format!("event: {event}\ndata: {data}\n\n"))
}

impl OverlayHub {
    /// Number of browser clients currently connected to /events.
    pub fn client_count(&self) -> usize {
        let mut state = self.state.lock().unwrap();
        state.clients.retain(|c| !c.is_closed());
        state.clients.len()
    }

    /// Push a display-config change (e.g. combo-list layout).
    pub fn broadcast_config(&self, config: &impl Serialize) {
        let data = serde_json::to_string(config).unwrap_or_default();
        let mut state = self.state.lock().unwrap();
        state.send(frame("config", &data));
        state.last_config = Some(data);
    }

    /// Push a discrete spell-cast event.
    pub fn broadcast_cast(&self, event: &impl Serialize) {
        let data = serde_json::to_string(event).unwrap_or_default();
        let mut state = self.state.lock().unwrap();
        state.send(frame("cast", &data));
        state.cast_buffer.push_back(data);
        if state.cast_buffer.len() > CAST_BUFFER_SIZE {
            state.cast_buffer.pop_front();
        }
    }

    /// Push the running damage total of the current (or just-ended) turn.
    pub fn broadcast_turn_damage(&self, event: &impl Serialize) {
        let data = serde_json::to_string(event).unwrap_or_default();
        let mut state = self.state.lock().unwrap();
        state.send(frame("turn-damage", &data));
        state.last_turn_damage = Some(data);
    }

    /// Registers a new client and returns, atomically with that, what it must
    /// be replayed first — so no event can slip in between or show up twice.
    fn subscribe(&self) -> (String, tokio::sync::mpsc::UnboundedReceiver<Arc<str>>) {
        let (tx, rx) = unbounded_channel();
        let mut state = self.state.lock().unwrap();
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
        state.clients.push(tx);
        (replay, rx)
    }
}

impl HubState {
    fn send(&mut self, payload: Arc<str>) {
        self.clients.retain(|c| c.send(payload.clone()).is_ok());
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
    pub async fn start(port: u16, hub: Arc<OverlayHub>, files: FileSource) -> Result<Self, String> {
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
                            connections.spawn(handle(stream, hub.clone(), files.clone()));
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
fn describe_listen_error(err: &std::io::Error) -> String {
    match err.kind() {
        std::io::ErrorKind::AddrInUse => "Port déjà utilisé par un autre programme.".into(),
        std::io::ErrorKind::PermissionDenied => {
            "Port réservé par Windows (Hyper-V/WSL/Docker) — choisis-en un autre.".into()
        }
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

async fn respond(stream: &mut TcpStream, status: &str, mime: &str, body: &[u8], head_only: bool) {
    let header = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {mime}\r\nContent-Length: {}\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(header.as_bytes()).await;
    if !head_only {
        let _ = stream.write_all(body).await;
    }
    let _ = stream.shutdown().await;
}

async fn handle(mut stream: TcpStream, hub: Arc<OverlayHub>, files: FileSource) {
    let Ok(Some(head)) = tokio::time::timeout(REQUEST_HEAD_TIMEOUT, read_request_head(&mut stream)).await else {
        return;
    };
    let mut parts = head.lines().next().unwrap_or_default().split_whitespace();
    let method = parts.next().unwrap_or_default();
    let target = parts.next().unwrap_or("/");
    if method != "GET" && method != "HEAD" {
        return respond(&mut stream, "405 Method Not Allowed", "text/plain", b"", false).await;
    }
    let pathname = percent_decode(target.split(['?', '#']).next().unwrap_or("/"));

    if pathname == "/events" {
        return stream_events(stream, hub).await;
    }

    let Some(path) = ui_path(&pathname) else {
        return respond(&mut stream, "403 Forbidden", "text/plain", b"", false).await;
    };
    match files(&path) {
        Some(body) => respond(&mut stream, "200 OK", mime_type(&path), &body, method == "HEAD").await,
        None => respond(&mut stream, "404 Not Found", "text/plain", b"Not found", false).await,
    }
}

async fn stream_events(mut stream: TcpStream, hub: Arc<OverlayHub>) {
    let header = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: keep-alive\r\n\r\n";
    if stream.write_all(header.as_bytes()).await.is_err() {
        return;
    }
    let (replay, mut events) = hub.subscribe();
    if stream.write_all(replay.as_bytes()).await.is_err() {
        return;
    }
    let (mut reader, mut writer) = stream.into_split();
    let mut discard = [0u8; 256];
    loop {
        tokio::select! {
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
    fn decodes_percent_escapes() {
        assert_eq!(percent_decode("/a%20b"), "/a b");
        assert_eq!(percent_decode("/%2e%2e/x"), "/../x");
        assert_eq!(percent_decode("/100%"), "/100%");
    }
}
