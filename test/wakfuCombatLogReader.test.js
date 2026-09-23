'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { WakfuCombatLogReader } = require('../src/wakfuCombatLogReader');

function makeLogsDir(initialContent = '') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wakfu-logs-'));
  const logFile = path.join(dir, 'wakfu.log');
  fs.writeFileSync(logFile, initialContent);
  return { dir, logFile };
}

async function startReader(dir) {
  const casts = [];
  // Huge poll interval: the tests drive scans by hand via _scan().
  const reader = new WakfuCombatLogReader((e) => casts.push(e), { logsDir: dir, pollIntervalMs: 1e9 });
  await reader.start();
  return { reader, casts };
}

const castLine = (who, spell) => `12:00:00,000 [Information (combat)] ${who} lance le sort ${spell}\r\n`;

test('ignores content already in the log at start, emits appended casts', async (t) => {
  const { dir, logFile } = makeLogsDir(castLine('Lueur Pourpre', 'Ancienne'));
  const { reader, casts } = await startReader(dir);
  t.after(() => reader.stop());

  fs.appendFileSync(logFile, castLine('Lueur Pourpre', 'Saignée mortelle'));
  reader._scan();

  assert.equal(casts.length, 1);
  assert.equal(casts[0].characterName, 'Lueur Pourpre');
  assert.equal(casts[0].spellName, 'Saignée mortelle');
});

test('waits for a line to be complete before parsing it', async (t) => {
  const { dir, logFile } = makeLogsDir();
  const { reader, casts } = await startReader(dir);
  t.after(() => reader.stop());

  fs.appendFileSync(logFile, '12:00:00,000 [Information (combat)] Lueur Pourpre lance le sort Saig');
  reader._scan();
  assert.equal(casts.length, 0);

  fs.appendFileSync(logFile, 'née mortelle\r\n');
  reader._scan();
  assert.equal(casts.length, 1);
  assert.equal(casts[0].spellName, 'Saignée mortelle');
});

test('decodes a multi-byte character split across two writes', async (t) => {
  const { dir, logFile } = makeLogsDir();
  const { reader, casts } = await startReader(dir);
  t.after(() => reader.stop());

  const bytes = Buffer.from(castLine('Lueur Pourpre', 'Flèche lumineuse'), 'utf8');
  const splitAt = bytes.indexOf(Buffer.from('è', 'utf8')) + 1; // middle of "è"
  fs.appendFileSync(logFile, bytes.subarray(0, splitAt));
  reader._scan();
  fs.appendFileSync(logFile, bytes.subarray(splitAt));
  reader._scan();

  assert.equal(casts.length, 1);
  assert.equal(casts[0].spellName, 'Flèche lumineuse');
});

test('strips the trailing "(...)" detail from the spell name', async (t) => {
  const { dir, logFile } = makeLogsDir();
  const { reader, casts } = await startReader(dir);
  t.after(() => reader.stop());

  fs.appendFileSync(logFile, castLine('Lueur Pourpre', 'Fourberie (Critiques)'));
  reader._scan();

  assert.equal(casts[0].spellName, 'Fourberie');
});

test('reads a truncated/recreated log from the start', async (t) => {
  const { dir, logFile } = makeLogsDir('x'.repeat(5000) + '\n');
  const { reader, casts } = await startReader(dir);
  t.after(() => reader.stop());

  fs.writeFileSync(logFile, castLine('Lueur Pourpre', 'Premier Sang'));
  reader._scan();

  assert.equal(casts.length, 1);
  assert.equal(casts[0].spellName, 'Premier Sang');
});

test('suppresses the near-simultaneous duplicate written by a second client', async (t) => {
  const { dir, logFile } = makeLogsDir();
  const { reader, casts } = await startReader(dir);
  t.after(() => reader.stop());

  fs.appendFileSync(logFile, castLine('Lueur Pourpre', 'Fourberie') + castLine('Lueur Pourpre', 'Fourberie'));
  reader._scan();

  assert.equal(casts.length, 1);
});

test('picks up a logs dir that only appears after start()', async (t) => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wakfu-late-')), 'logs');
  const { reader, casts } = await startReader(dir);
  t.after(() => reader.stop());

  fs.mkdirSync(dir);
  const logFile = path.join(dir, 'wakfu.log');
  fs.writeFileSync(logFile, '');
  reader._tick(); // discovers the file, seeds it at EOF
  fs.appendFileSync(logFile, castLine('Lueur Pourpre', 'Fourberie'));
  reader._tick();

  assert.equal(casts.length, 1);
});
