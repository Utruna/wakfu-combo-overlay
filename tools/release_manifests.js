/**
 * tools/release_manifests.js
 * Run by .github/workflows/release.yml after `tauri build`: copies the NSIS
 * installer to dist/ under a stable, space-free name and writes the two
 * update manifests the release publishes next to it.
 *
 *   - latest.json — read by this app's own updater (tauri-plugin-updater),
 *     with the installer's minisign signature from `tauri build`.
 *   - latest.yml  — read by electron-updater in the 1.x (Electron) versions,
 *     so they're offered this installer too; it uninstalls them on the way
 *     (see src-tauri/installer-hooks.nsh).
 *
 * Usage: node tools/release_manifests.js
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const OWNER_REPO = 'utruna/wakfu-combo-overlay';
const NSIS_DIR = path.join(REPO, 'src-tauri', 'target', 'release', 'bundle', 'nsis');
const OUT = path.join(REPO, 'dist');

const version = require(path.join(REPO, 'package.json')).version;
const setupName = fs.readdirSync(NSIS_DIR).find((f) => f.endsWith(`${version}_x64-setup.exe`));
if (!setupName) throw new Error(`No NSIS installer for ${version} in ${NSIS_DIR}`);

const assetName = `wakfu-combo-overlay-setup-${version}.exe`;
const setupPath = path.join(NSIS_DIR, setupName);
const signature = fs.readFileSync(`${setupPath}.sig`, 'utf8').trim();

fs.mkdirSync(OUT, { recursive: true });
fs.copyFileSync(setupPath, path.join(OUT, assetName));

const url = `https://github.com/${OWNER_REPO}/releases/download/v${version}/${assetName}`;
const now = new Date().toISOString();
fs.writeFileSync(path.join(OUT, 'latest.json'), `${JSON.stringify({
  version,
  pub_date: now,
  platforms: { 'windows-x86_64': { signature, url } },
}, null, 2)}\n`);

const bytes = fs.readFileSync(setupPath);
const sha512 = crypto.createHash('sha512').update(bytes).digest('base64');
fs.writeFileSync(path.join(OUT, 'latest.yml'), [
  `version: ${version}`,
  'files:',
  `  - url: ${assetName}`,
  `    sha512: ${sha512}`,
  `    size: ${bytes.length}`,
  `path: ${assetName}`,
  `sha512: ${sha512}`,
  `releaseDate: '${now}'`,
  '',
].join('\n'));

console.log(`[release] ${assetName}, latest.json, latest.yml written to dist/`);
