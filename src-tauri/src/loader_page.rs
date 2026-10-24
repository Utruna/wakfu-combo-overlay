//! Writes a tiny local HTML file meant to be used as the OBS browser source
//! ("Local file") instead of the http:// URL.
//!
//! Why: OBS is often started before this app. A browser source pointing at
//! http://localhost:<port> then fails its first load, shows an error page and
//! never retries on its own — the overlay stays blank until the source is
//! manually refreshed. A local file always loads; it waits for the overlay
//! server to answer, then navigates to it. Once there, the overlay page's own
//! SSE reconnect loop handles the app being restarted.

use std::fs;
use std::path::{Path, PathBuf};

pub const LOADER_FILE_NAME: &str = "overlay-obs.html";
/// Served by the overlay server, so its loading tells that the server is up.
pub const PROBED_ASSET: &str = "assets/tray-icon.png";
const RETRY_INTERVAL_MS: u32 = 2000;

pub fn build_loader_html(port: u16) -> String {
    let overlay_url = format!("http://127.0.0.1:{port}/");
    // Probed with an <img> rather than fetch(): image loads from a file://
    // page to http:// are never subject to CORS or file-origin restrictions,
    // and onload/onerror cleanly tell "server up" from "connection refused".
    format!(
        r#"<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <title>Wakfu Combo Overlay</title>
  <style>html, body {{ margin: 0; background: transparent; }}</style>
</head>
<body>
  <!-- Généré par Wakfu Combo Overlay — attend que l'application soit lancée puis ouvre l'overlay. -->
  <script>
    const OVERLAY_URL = "{overlay_url}";
    function tryOpenOverlay() {{
      const probe = new Image();
      probe.onload = () => location.replace(OVERLAY_URL);
      probe.onerror = () => setTimeout(tryOpenOverlay, {RETRY_INTERVAL_MS});
      probe.src = OVERLAY_URL + '{PROBED_ASSET}?t=' + Date.now();
    }}
    tryOpenOverlay();
  </script>
</body>
</html>
"#
    )
}

/// (Re)writes the loader for the given port, in a stable directory (the
/// settings folder) so the path pasted into OBS survives app updates. A
/// failure only means the local-file option is unavailable — the http:// URL
/// still works.
pub fn write_loader_page(dir: &Path, port: u16) -> Option<PathBuf> {
    let path = dir.join(LOADER_FILE_NAME);
    let result = fs::create_dir_all(dir).and_then(|()| fs::write(&path, build_loader_html(port)));
    match result {
        Ok(()) => Some(path),
        Err(err) => {
            eprintln!("[obsLoaderPage] Failed to write loader page: {err}");
            None
        }
    }
}
