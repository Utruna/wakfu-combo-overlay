'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildLoaderHtml, writeLoaderPage } = require('../src/obsLoaderPage');

test('loader targets the configured port', () => {
  assert.match(buildLoaderHtml(4123), /"http:\/\/127\.0\.0\.1:4123\/"/);
});

test('loader probes an asset the overlay server actually serves', () => {
  const probed = /OVERLAY_URL \+ '([^?]+)\?/.exec(buildLoaderHtml(3457))[1];
  assert.ok(fs.existsSync(path.join(__dirname, '..', probed)), `${probed} must exist in the app`);
});

test('writeLoaderPage rewrites the file when the port changes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wakfu-loader-'));
  const filePath = writeLoaderPage(dir, 3457);
  writeLoaderPage(dir, 4000);
  assert.match(fs.readFileSync(filePath, 'utf-8'), /127\.0\.0\.1:4000/);
});
