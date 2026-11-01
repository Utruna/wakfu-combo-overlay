//! The "Nouveautés" window: after an update, shows what changed since the
//! version the user last saw. Its text is CHANGELOG.md's own sections (the
//! same ones the GitHub release notes are cut from), embedded at build time.

use serde_json::{json, Value};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::app_state::AppState;

pub const WHATS_NEW_WINDOW: &str = "whatsnew";
const CHANGELOG: &str = include_str!("../../CHANGELOG.md");
/// Opened by hand, the window shows this many of the latest versions.
const MANUAL_VERSION_COUNT: usize = 3;

type Version = (u64, u64, u64);

/// "2.1.0" or "v2.1.0" -> (2, 1, 0).
pub fn parse_version(text: &str) -> Option<Version> {
    let mut parts = text.trim().trim_start_matches('v').split('.').map(|part| part.parse::<u64>().ok());
    let version = (parts.next()??, parts.next()??, parts.next()??);
    parts.next().is_none().then_some(version)
}

/// The changelog's `## vX.Y.Z` sections, newest first (as written), each with
/// its markdown body.
pub fn sections(changelog: &str) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    for line in changelog.lines() {
        let line = line.trim_end_matches('\r');
        if let Some(heading) = line.strip_prefix("## ") {
            if parse_version(heading).is_some() {
                out.push((heading.trim().trim_start_matches('v').to_string(), String::new()));
                continue;
            }
        }
        if let Some((_, body)) = out.last_mut() {
            body.push_str(line);
            body.push('\n');
        }
    }
    for (_, body) in &mut out {
        *body = body.trim().to_string();
    }
    out
}

/// The sections to show: those newer than `since` up to `current`, or the
/// latest few when `since` is None (opened by hand).
pub fn notes(changelog: &str, current: &str, since: Option<&str>) -> Vec<Value> {
    let current = parse_version(current);
    let since = since.and_then(parse_version);
    let shown = sections(changelog).into_iter().filter(|(version, _)| {
        let version = parse_version(version);
        version <= current && since.is_none_or(|since| version > Some(since))
    });
    let limit = if since.is_some() { usize::MAX } else { MANUAL_VERSION_COUNT };
    shown.take(limit).map(|(version, markdown)| json!({ "version": version, "markdown": markdown })).collect()
}

/// What to do at launch, given the last version whose notes were shown.
#[derive(Debug, PartialEq, Eq)]
pub enum OnLaunch {
    /// Nothing new since last time.
    Nothing,
    /// Fresh install: the onboarding assistant greets the user, not release
    /// notes — just remember the version.
    Remember,
    /// Updated: show the notes since this version (None: from before 2.2.0,
    /// which didn't record it — the current version's notes only).
    Show(Option<String>),
}

pub fn on_launch(last_seen: Option<&str>, current: &str, already_set_up: bool) -> OnLaunch {
    match last_seen {
        Some(seen) if parse_version(seen) >= parse_version(current) => OnLaunch::Nothing,
        Some(seen) => OnLaunch::Show(Some(seen.to_string())),
        None if already_set_up => OnLaunch::Show(None),
        None => OnLaunch::Remember,
    }
}

/// Called whenever the settings window opens: shows the notes once after
/// each update — at the next launch, or, when the app starts hidden at login,
/// the first time the user opens the settings.
pub fn show_if_updated(app: &AppHandle) {
    let current = app.package_info().version.to_string();
    let launch = {
        let state = app.state::<AppState>();
        let mut core = state.core.lock().unwrap();
        let settings = &mut core.settings;
        let already_set_up = settings.onboarding_done() || !settings.heroes().is_empty();
        let launch = on_launch(settings.last_seen_version(), &current, already_set_up);
        if launch != OnLaunch::Nothing {
            settings.set_last_seen_version(&current);
        }
        launch
    };
    if let OnLaunch::Show(since) = launch {
        // Before 2.2.0 nothing was recorded: show just this version.
        let since = since.or_else(|| previous_version(&current));
        show(app, since.as_deref());
    }
}

/// The version listed right before `current` in the changelog.
fn previous_version(current: &str) -> Option<String> {
    let current = parse_version(current);
    sections(CHANGELOG).into_iter().map(|(version, _)| version).find(|version| parse_version(version) < current)
}

/// Opens the window, or brings it back if it's already open. `since`: show what changed after that
/// version; None: the latest few versions.
pub fn show(app: &AppHandle, since: Option<&str>) {
    if let Some(window) = app.get_webview_window(WHATS_NEW_WINDOW) {
        let _ = window.unminimize();
        let _ = window.set_focus();
        return;
    }
    let page = match since {
        Some(since) => format!("whatsnew/index.html?since={since}"),
        None => "whatsnew/index.html".to_string(),
    };
    let built = WebviewWindowBuilder::new(app, WHATS_NEW_WINDOW, WebviewUrl::App(page.into()))
        .title("Nouveautés — Wakfu Combo Overlay")
        .inner_size(560.0, 600.0)
        .min_inner_size(420.0, 360.0)
        .background_color(tauri::window::Color(0x13, 0x1a, 0x1e, 0xff))
        .center()
        .build();
    if let Err(err) = built {
        eprintln!("[whatsNew] Failed to open the window: {err}");
    }
}

/// For the window's page: the notes to show.
pub fn release_notes(app: &AppHandle, since: Option<&str>) -> Value {
    let current = app.package_info().version.to_string();
    json!({ "version": current, "notes": notes(CHANGELOG, &current, since) })
}
