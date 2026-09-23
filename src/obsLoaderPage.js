/**
 * obsLoaderPage.js
 * Writes a tiny local HTML file meant to be used as the OBS browser source
 * ("Local file") instead of the http:// URL.
 *
 * Why: OBS is often started before this app. A browser source pointing at
 * http://localhost:<port> then fails its first load, shows an error page and
 * never retries on its own — the overlay stays blank until the source is
 * manually refreshed. A local file always loads; it waits for the overlay
 * server to answer, then navigates to it. Once there, the overlay page's own
 * SSE reconnect loop handles the app being restarted.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const LOADER_FILE_NAME = 'overlay-obs.html';
const RETRY_INTERVAL_MS = 2000;

/** @param {number} port @returns {string} */
function buildLoaderHtml(port) {
  const overlayUrl = `http://127.0.0.1:${Number(port)}/`;
  // Probed with an <img> rather than fetch(): image loads from a file:// page
  // to http:// are never subject to CORS or file-origin restrictions, and
  // onload/onerror cleanly tell "server up" from "connection refused".
  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <title>Wakfu Combo Overlay</title>
  <style>html, body { margin: 0; background: transparent; }</style>
</head>
<body>
  <!-- Généré par Wakfu Combo Overlay — attend que l'application soit lancée puis ouvre l'overlay. -->
  <script>
    const OVERLAY_URL = ${JSON.stringify(overlayUrl)};
    function tryOpenOverlay() {
      const probe = new Image();
      probe.onload = () => location.replace(OVERLAY_URL);
      probe.onerror = () => setTimeout(tryOpenOverlay, ${RETRY_INTERVAL_MS});
      probe.src = OVERLAY_URL + 'assets/tray-icon.png?t=' + Date.now();
    }
    tryOpenOverlay();
  </script>
</body>
</html>
`;
}

/**
 * (Re)writes the loader for the given port. Never throws — a failure only
 * means the local-file option is unavailable, the http:// URL still works.
 *
 * @param {string} dir - Stable directory (the app's userData), so the path
 *   pasted into OBS survives app updates.
 * @param {number} port
 * @returns {string|null} Absolute path of the loader, or null on failure.
 */
function writeLoaderPage(dir, port) {
  const filePath = path.join(dir, LOADER_FILE_NAME);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, buildLoaderHtml(port));
    return filePath;
  } catch (err) {
    console.error('[obsLoaderPage] Failed to write loader page:', err.message);
    return null;
  }
}

module.exports = { buildLoaderHtml, writeLoaderPage, LOADER_FILE_NAME };
