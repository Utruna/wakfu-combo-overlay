//! Starting with Windows (the per-user "Run" registry key).
//!
//! Starting with Windows is what keeps the overlay reachable when OBS opens
//! first: a browser source whose first load fails shows an error page and
//! never retries by itself, so the server has to be up before OBS is.

use std::io;
use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_SET_VALUE};
use winreg::RegKey;

const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const VALUE_NAME: &str = "Wakfu Combo Overlay";
/// Electron's own name for the entry the 1.x versions registered.
const ELECTRON_VALUE_PREFIX: &str = "electron.app.";
const ELECTRON_INSTALL_MARKER: &str = r"\programs\wakfu-combo-overlay\";

/// Passed by the login entry: starts straight in the tray instead of popping
/// the settings window at every session start.
pub const HIDDEN_ARG: &str = "--hidden";

/// Only an installed build registers itself — a dev build would leave an
/// entry pointing at a target/ folder.
pub fn available() -> bool {
    !cfg!(debug_assertions)
}

fn run_key(access: u32) -> io::Result<RegKey> {
    RegKey::predef(HKEY_CURRENT_USER).open_subkey_with_flags(RUN_KEY, access)
}

pub fn is_enabled() -> bool {
    available() && run_key(KEY_READ).is_ok_and(|key| key.get_value::<String, _>(VALUE_NAME).is_ok())
}

pub fn set_enabled(enabled: bool) -> io::Result<()> {
    if !available() {
        return Ok(());
    }
    let key = run_key(KEY_SET_VALUE)?;
    if enabled {
        let exe = std::env::current_exe()?;
        key.set_value(VALUE_NAME, &format!("\"{}\" {HIDDEN_ARG}", exe.display()))
    } else {
        match key.delete_value(VALUE_NAME) {
            Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(()),
            other => other,
        }
    }
}

/// The 1.x (Electron) versions registered their own entry, pointing at an
/// exe the new installer removes: carry the user's choice over to this
/// version's entry instead of leaving a dead one behind.
pub fn migrate_from_electron() {
    if !available() {
        return;
    }
    let Ok(key) = run_key(KEY_READ | KEY_SET_VALUE) else { return };
    let electron_entries: Vec<String> = key
        .enum_values()
        .filter_map(Result::ok)
        .filter(|(name, value)| {
            name.starts_with(ELECTRON_VALUE_PREFIX)
                && value.to_string().to_lowercase().contains(ELECTRON_INSTALL_MARKER)
        })
        .map(|(name, _)| name)
        .collect();
    if electron_entries.is_empty() {
        return;
    }
    for name in &electron_entries {
        let _ = key.delete_value(name);
    }
    if let Err(err) = set_enabled(true) {
        eprintln!("[autostart] Failed to carry the login item over: {err}");
    }
}
