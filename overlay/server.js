'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const DEFAULT_ROOT_DIR = path.resolve(__dirname, '..');
const DEFAULT_STATIC_DIR = __dirname;
const PORT = 3456;
const CAST_BUFFER_SIZE = 20;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.json': 'application/json',
};

class OverlayServer {
  /**
   * @param {object} [options]
   * @param {string} [options.rootDir] - Project root, used to resolve /assets/* requests.
   * @param {string} [options.staticDir] - Directory serving the overlay page itself (index.html, client.js, style.css).
   */
  constructor({ rootDir = DEFAULT_ROOT_DIR, staticDir = DEFAULT_STATIC_DIR } = {}) {
    this._rootDir = rootDir;
    this._staticDir = staticDir;
    this._clients = new Set();
    this._lastState = null;
    this._castBuffer = [];
    this._lastConfig = null;
    this._server = http.createServer((req, res) => this._handle(req, res));
    // Without a listener, an error here (e.g. EADDRINUSE) would be an uncaught
    // exception that crashes the whole Electron main process — this permanent
    // listener keeps that from happening even after start() has resolved.
    this._server.on('error', (err) => {
      console.error('[OverlayServer] Server error:', err.message);
    });
  }

  /**
   * @param {number} port
   * @returns {Promise<{ok: boolean, error?: string}>} Never rejects — a bind
   *   failure (e.g. port already in use) resolves with ok:false instead, so
   *   callers can report it rather than crash.
   */
  start(port = PORT) {
    return new Promise((resolve) => {
      const onError = (err) => {
        cleanup();
        resolve({ ok: false, error: OverlayServer.describeListenError(err) });
      };
      const onListening = () => {
        cleanup();
        console.log(`[OverlayServer] http://localhost:${port}`);
        resolve({ ok: true });
      };
      const cleanup = () => {
        this._server.removeListener('error', onError);
        this._server.removeListener('listening', onListening);
      };
      this._server.once('error', onError);
      this._server.once('listening', onListening);
      this._server.listen(port, '127.0.0.1');
    });
  }

  /**
   * EACCES on an unprivileged port almost always means Windows has reserved
   * it (Hyper-V / WSL / Docker grab random port ranges, re-rolled at each
   * reboot — see `netsh interface ipv4 show excludedportrange protocol=tcp`),
   * which is why it can work one day and fail the next with no change here.
   */
  static describeListenError(err) {
    if (err.code === 'EADDRINUSE') return 'Port déjà utilisé par un autre programme.';
    if (err.code === 'EACCES') return 'Port réservé par Windows (Hyper-V/WSL/Docker) — choisis-en un autre.';
    return err.message;
  }

  stop() {
    for (const res of this._clients) res.end();
    this._clients.clear();
    this._server.close();
  }

  /** Number of browser clients currently connected to /events. */
  get clientCount() {
    return this._clients.size;
  }

  /** Push hero + profile state to all connected browser clients. */
  broadcast(state) {
    this._lastState = state;
    const payload = `data: ${JSON.stringify(state)}\n\n`;
    for (const res of this._clients) res.write(payload);
  }

  /** Push a discrete spell-cast event to all connected browser clients. */
  broadcastCast(event) {
    this._castBuffer.push(event);
    if (this._castBuffer.length > CAST_BUFFER_SIZE) this._castBuffer.shift();

    const payload = `event: cast\ndata: ${JSON.stringify(event)}\n\n`;
    for (const res of this._clients) res.write(payload);
  }

  /** Push a display-config change (e.g. combo-list layout) to all connected browser clients. */
  broadcastConfig(config) {
    this._lastConfig = config;
    const payload = `event: config\ndata: ${JSON.stringify(config)}\n\n`;
    for (const res of this._clients) res.write(payload);
  }

  // ── Private ────────────────────────────────────────────────────────────────

  _handle(req, res) {
    const pathname = new URL(req.url, 'http://localhost').pathname;

    // Server-Sent Events stream
    if (pathname === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      res.write(': connected\n\n');

      if (this._lastState) {
        res.write(`data: ${JSON.stringify(this._lastState)}\n\n`);
      }
      if (this._lastConfig) {
        res.write(`event: config\ndata: ${JSON.stringify(this._lastConfig)}\n\n`);
      }
      for (const event of this._castBuffer) {
        res.write(`event: cast\ndata: ${JSON.stringify(event)}\n\n`);
      }

      this._clients.add(res);
      req.on('close', () => this._clients.delete(res));
      return;
    }

    // Project assets (icons, etc.)
    if (pathname.startsWith('/assets/')) {
      return this._serveFile(path.join(this._rootDir, pathname), res, this._rootDir);
    }

    // Overlay static files
    const file = pathname === '/'
      ? path.join(this._staticDir, 'index.html')
      : path.join(this._staticDir, pathname.replace(/^\//, ''));

    this._serveFile(file, res, this._staticDir);
  }

  _serveFile(filePath, res, allowedBase) {
    const resolved = path.resolve(filePath);
    // Trailing separator matters: without it, "<allowedBase>-evil" would
    // wrongly pass a plain startsWith("<allowedBase>") check.
    const resolvedBase = path.resolve(allowedBase) + path.sep;
    const allowed = (resolved + path.sep).startsWith(resolvedBase);
    if (!allowed) {
      res.writeHead(403);
      return res.end();
    }

    fs.readFile(resolved, (err, data) => {
      if (err) {
        res.writeHead(404);
        return res.end('Not found');
      }
      const mime = MIME[path.extname(resolved)] ?? 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': mime });
      res.end(data);
    });
  }
}

module.exports = { OverlayServer, PORT };
