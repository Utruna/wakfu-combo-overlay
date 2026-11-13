use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use taktik_lib::overlay_server::{FileSource, HudHandler, HudRequest, OverlayHub, OverlayServer};

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
}

/// Sends a raw request and returns the response head (status line first).
fn request(port: u16, raw: &str) -> String {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
    stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    stream.write_all(raw.as_bytes()).unwrap();
    let mut out = String::new();
    let mut buf = [0u8; 4096];
    while let Ok(n) = stream.read(&mut buf) {
        if n == 0 {
            break;
        }
        out.push_str(&String::from_utf8_lossy(&buf[..n]));
        if out.contains("\r\n\r\n") && !out.contains("text/event-stream") {
            break;
        }
        if out.contains("event-stream") && out.contains(": connected") {
            break;
        }
    }
    out
}

struct Fixture {
    port: u16,
    hud_calls: Arc<Mutex<Vec<HudRequest>>>,
    _server: OverlayServer,
}

fn start() -> Fixture {
    let port = free_port();
    let hud_calls = Arc::new(Mutex::new(Vec::new()));
    let calls = hud_calls.clone();
    let hud: HudHandler = Arc::new(move |request| calls.lock().unwrap().push(request));
    let files: FileSource = Arc::new(|path| (path == "overlay/index.html").then(|| b"<html></html>".to_vec()));
    let server = tauri::async_runtime::block_on(OverlayServer::start(port, Arc::new(OverlayHub::default()), files, hud))
        .expect("server starts");
    Fixture { port, hud_calls, _server: server }
}

fn get(path: &str, port: u16, extra: &str) -> String {
    format!("GET {path} HTTP/1.1\r\nHost: localhost:{port}\r\n{extra}\r\n")
}

#[test]
fn serves_the_page_with_security_headers() {
    let f = start();
    let response = request(f.port, &get("/", f.port, ""));
    assert!(response.starts_with("HTTP/1.1 200"), "{response}");
    assert!(response.contains("Content-Security-Policy:"));
    assert!(response.contains("X-Content-Type-Options: nosniff"));
}

#[test]
fn refuses_a_foreign_host_name() {
    let f = start();
    let response = request(f.port, "GET / HTTP/1.1\r\nHost: evil.example\r\n\r\n");
    assert!(response.starts_with("HTTP/1.1 421"), "{response}");
    let response = request(f.port, "GET /events HTTP/1.1\r\nHost: rebind.evil.example:80\r\n\r\n");
    assert!(response.starts_with("HTTP/1.1 421"), "{response}");
}

#[test]
fn hud_actions_need_the_overlays_own_header() {
    let f = start();
    // What a web page's <img> or no-cors fetch can send: no custom header.
    let response = request(f.port, &get("/hud/recap", f.port, ""));
    assert!(response.starts_with("HTTP/1.1 403"), "{response}");
    let response = request(f.port, &get("/hud/recap", f.port, "Sec-Fetch-Site: cross-site\r\nX-Wakfu-Overlay: 1\r\n"));
    assert!(response.starts_with("HTTP/1.1 403"), "{response}");
    assert!(f.hud_calls.lock().unwrap().is_empty());

    let response = request(f.port, &get("/hud/recap", f.port, "Sec-Fetch-Site: same-origin\r\nX-Wakfu-Overlay: 1\r\n"));
    assert!(response.starts_with("HTTP/1.1 204"), "{response}");
    assert_eq!(*f.hud_calls.lock().unwrap(), vec![HudRequest::Recap]);
}

#[test]
fn events_stream_is_closed_to_cross_site_pages() {
    let f = start();
    let response = request(f.port, &get("/events", f.port, "Sec-Fetch-Site: cross-site\r\n"));
    assert!(response.starts_with("HTTP/1.1 403"), "{response}");
    let response = request(f.port, &get("/events", f.port, "Origin: http://evil.example\r\n"));
    assert!(response.starts_with("HTTP/1.1 403"), "{response}");
    let response = request(f.port, &get("/events", f.port, "Sec-Fetch-Site: same-origin\r\n"));
    assert!(response.starts_with("HTTP/1.1 200") && response.contains("text/event-stream"), "{response}");
}

#[test]
fn does_not_leave_the_ui_folder() {
    let f = start();
    for path in ["/../secret", "/%2e%2e/secret", "/assets/../settings/index.html"] {
        let response = request(f.port, &get(path, f.port, ""));
        assert!(response.starts_with("HTTP/1.1 403"), "{path}: {response}");
    }
}
