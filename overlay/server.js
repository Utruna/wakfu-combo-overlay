'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const STATIC_DIR = __dirname;
const PORT = 3456;

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
  constructor() {
    this._clients = new Set();
    this._lastState = null;
    this._server = http.createServer((req, res) => this._handle(req, res));
  }

  start(port = PORT) {
    this._server.listen(port, '127.0.0.1', () => {
      console.log(`[OverlayServer] http://localhost:${port}`);
    });
  }

  stop() {
    for (const res of this._clients) res.end();
    this._clients.clear();
    this._server.close();
  }

  /** Push hero + profile state to all connected browser clients. */
  broadcast(state) {
    this._lastState = state;
    const payload = `data: ${JSON.stringify(state)}\n\n`;
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
        'Access-Control-Allow-Origin': '*',
      });
      res.write(': connected\n\n');

      if (this._lastState) {
        res.write(`data: ${JSON.stringify(this._lastState)}\n\n`);
      }

      this._clients.add(res);
      req.on('close', () => this._clients.delete(res));
      return;
    }

    // Project assets (icons, etc.)
    if (pathname.startsWith('/assets/')) {
      return this._serveFile(path.join(PROJECT_ROOT, pathname), res);
    }

    // Overlay static files
    const file = pathname === '/'
      ? path.join(STATIC_DIR, 'index.html')
      : path.join(STATIC_DIR, pathname.replace(/^\//, ''));

    this._serveFile(file, res);
  }

  _serveFile(filePath, res) {
    const resolved = path.resolve(filePath);
    const allowed = resolved.startsWith(PROJECT_ROOT);
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
