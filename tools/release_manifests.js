/**
 * tools/release_manifests.js
 * Run by .github/workflows/release.yml, in two steps:
 *
 *   node tools/release_manifests.js collect <windows|linux|macos>
 *     After `tauri build`, on each system's runner: copies what `tauri build`
 *     made to dist/ under stable, space-free names, with the updater
 *     signature of the file the updater downloads next to it (*.sig).
 *
 *   node tools/release_manifests.js manifests
 *     Once every system's dist/ is gathered in one: writes the two update
 *     manifests the release publishes next to the files.
 *
 *   - latest.json — read by this app's own updater (tauri-plugin-updater),
 *     with each file's minisign signature from `tauri build`.
 *   - latest.yml  — read by electron-updater in the 1.x (Electron) versions,
 *     Windows only, so they're offered the installer too; it uninstalls them
 *     on the way (see src-tauri/installer-hooks.nsh).
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const OWNER_REPO = 'utruna/wakfu-combo-overlay';
const TARGET = path.join(REPO, 'src-tauri', 'target');
const OUT = path.join(REPO, 'dist');

const version = require(path.join(REPO, 'package.json')).version;

// The files each system's release is made of. `updater`: the one the in-app
// updater downloads, and the platforms of latest.json it's offered to.
const RELEASES = {
  windows: [
    {
      from: path.join(TARGET, 'release', 'bundle', 'nsis'),
      suffix: `_${version}_x64-setup.exe`,
      name: `wakfu-combo-overlay-setup-${version}.exe`,
      updater: ['windows-x86_64'],
    },
  ],
  linux: [
    {
      from: path.join(TARGET, 'release', 'bundle', 'appimage'),
      suffix: `_${version}_amd64.AppImage`,
      name: `wakfu-combo-overlay-${version}-x86_64.AppImage`,
      updater: ['linux-x86_64'],
    },
  ],
  // One universal build, for Apple Silicon and Intel Macs alike.
  macos: [
    {
      from: path.join(TARGET, 'universal-apple-darwin', 'release', 'bundle', 'dmg'),
      suffix: `_${version}_universal.dmg`,
      name: `wakfu-combo-overlay-${version}-macos.dmg`,
    },
    {
      from: path.join(TARGET, 'universal-apple-darwin', 'release', 'bundle', 'macos'),
      suffix: '.app.tar.gz',
      name: `wakfu-combo-overlay-${version}-macos.app.tar.gz`,
      updater: ['darwin-aarch64', 'darwin-x86_64'],
    },
  ],
};

function findBuilt({ from, suffix }) {
  const found = fs.existsSync(from) ? fs.readdirSync(from).find((f) => f.endsWith(suffix)) : undefined;
  if (!found) throw new Error(`No *${suffix} for ${version} in ${from}`);
  return path.join(from, found);
}

function collect(system) {
  const files = RELEASES[system];
  if (!files) throw new Error(`Unknown system "${system}" (windows, linux or macos)`);
  fs.mkdirSync(OUT, { recursive: true });
  for (const file of files) {
    const built = findBuilt(file);
    fs.copyFileSync(built, path.join(OUT, file.name));
    if (file.updater) fs.copyFileSync(`${built}.sig`, path.join(OUT, `${file.name}.sig`));
    console.log(`[release] ${path.basename(built)} -> dist/${file.name}`);
  }
}

function manifests() {
  const url = (name) => `https://github.com/${OWNER_REPO}/releases/download/v${version}/${name}`;
  const now = new Date().toISOString();

  const platforms = {};
  // A system the release leaves out (see the build matrix in release.yml) has
  // nothing in dist/ and no update entry; one that was built must be complete.
  const built = Object.values(RELEASES).filter((files) => files.some((f) => fs.existsSync(path.join(OUT, f.name))));
  for (const file of built.flat().filter((f) => f.updater)) {
    const sigPath = path.join(OUT, `${file.name}.sig`);
    if (!fs.existsSync(sigPath)) throw new Error(`dist/${file.name}.sig missing: was every system built?`);
    const signature = fs.readFileSync(sigPath, 'utf8').trim();
    for (const platform of file.updater) platforms[platform] = { signature, url: url(file.name) };
  }
  fs.writeFileSync(path.join(OUT, 'latest.json'), `${JSON.stringify({
    version,
    pub_date: now,
    platforms,
  }, null, 2)}\n`);

  const setupName = RELEASES.windows[0].name;
  const bytes = fs.readFileSync(path.join(OUT, setupName));
  const sha512 = crypto.createHash('sha512').update(bytes).digest('base64');
  fs.writeFileSync(path.join(OUT, 'latest.yml'), [
    `version: ${version}`,
    'files:',
    `  - url: ${setupName}`,
    `    sha512: ${sha512}`,
    `    size: ${bytes.length}`,
    `path: ${setupName}`,
    `sha512: ${sha512}`,
    `releaseDate: '${now}'`,
    '',
  ].join('\n'));

  console.log(`[release] latest.json (${Object.keys(platforms).join(', ')}) and latest.yml written to dist/`);
}

const [command, system] = process.argv.slice(2);
if (command === 'collect') collect(system);
else if (command === 'manifests') manifests();
else throw new Error('Usage: node tools/release_manifests.js collect <windows|linux|macos> | manifests');
