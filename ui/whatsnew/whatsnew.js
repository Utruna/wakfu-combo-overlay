'use strict';

// The "Nouveautés" window (src-tauri/src/whats_new.rs): CHANGELOG.md's
// sections for the versions to show, rendered from their markdown.

const { invoke } = window.__TAURI__.core;
const { getCurrentWindow } = window.__TAURI__.window;

const escapeHtml = (text) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** `**bold**` and `` `code` `` — all the changelog uses inside a line. */
const inline = (text) => escapeHtml(text)
  .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  .replace(/`(.+?)`/g, '<code>$1</code>');

/** The changelog's markdown: `###` headings, `- ` lists and paragraphs. */
function renderMarkdown(markdown) {
  const html = [];
  let list = false;
  let paragraph = [];
  const flush = () => {
    if (paragraph.length) html.push(`<p>${inline(paragraph.join(' '))}</p>`);
    paragraph = [];
    if (list) html.push('</ul>');
    list = false;
  };
  for (const raw of markdown.split('\n')) {
    const line = raw.trim();
    const heading = line.match(/^#{3,}\s+(.*)$/);
    const item = line.match(/^[-*]\s+(.*)$/);
    if (!line) {
      flush();
    } else if (heading) {
      flush();
      html.push(`<h3>${inline(heading[1])}</h3>`);
    } else if (item) {
      if (paragraph.length) flush();
      if (!list) html.push('<ul>');
      list = true;
      html.push(`<li>${inline(item[1])}</li>`);
    } else if (list) {
      // A wrapped list item.
      html[html.length - 1] = html[html.length - 1].replace(/<\/li>$/, ` ${inline(line)}</li>`);
    } else {
      paragraph.push(line);
    }
  }
  flush();
  return html.join('\n');
}

async function init() {
  const since = new URLSearchParams(window.location.search).get('since');
  const { version, notes } = await invoke('get_release_notes', { since });
  document.getElementById('wn-title').textContent = `Version ${version}`;
  // Several versions (skipped updates, or opened by hand): each gets its label.
  const labelled = notes.length > 1;
  document.getElementById('wn-notes').innerHTML = notes.length
    ? notes.map((note, i) => [
      i > 0 ? '<hr>' : '',
      labelled ? `<div class="wn-version">v${escapeHtml(note.version)}</div>` : '',
      renderMarkdown(note.markdown),
    ].join('')).join('\n')
    : '<p>Pas de notes pour cette version.</p>';
}

document.getElementById('wn-close').addEventListener('click', () => getCurrentWindow().close());
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') getCurrentWindow().close(); });

init();
