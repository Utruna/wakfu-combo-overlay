//! The per-user folders the app reads and writes, on each system.

use std::path::PathBuf;

/// Where apps keep their per-user data: `%APPDATA%` on Windows,
/// `~/Library/Application Support` on macOS, `$XDG_CONFIG_HOME` (by default
/// `~/.config`) on Linux. Also where Electron puts an app's data — the Ankama
/// launcher's included (see `log_reader::logs_dir_candidates`).
#[cfg(windows)]
pub fn app_data() -> PathBuf {
    std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Users\Default\AppData\Roaming"))
}

#[cfg(target_os = "macos")]
pub fn app_data() -> PathBuf {
    home().join("Library").join("Application Support")
}

#[cfg(all(unix, not(target_os = "macos")))]
pub fn app_data() -> PathBuf {
    // The spec says a relative value is to be ignored.
    std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .filter(|dir| dir.is_absolute())
        .unwrap_or_else(|| home().join(".config"))
}

#[cfg(not(windows))]
pub fn home() -> PathBuf {
    std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/"))
}

/// The app's own folder: settings.json, saved fights and the OBS loader page.
pub fn app_dir() -> PathBuf {
    // Lowercase, like the other folders in ~/.config.
    let name = if cfg!(any(windows, target_os = "macos")) { "Taktik" } else { "taktik" };
    app_data().join(name)
}

/// The folder the app had before it was called Taktik (it was "Wakfu Combo
/// Overlay", from the 1.x Electron versions on).
fn legacy_app_dir() -> PathBuf {
    let name = if cfg!(any(windows, target_os = "macos")) { "Wakfu Combo Overlay" } else { "wakfu-combo-overlay" };
    app_data().join(name)
}

/// First launch under the new name: starts from a copy of the old folder, so
/// the heroes, layout and saved fights carry over. A copy, not a move: the
/// loader page path users pasted into OBS lives in the old folder, and keeps
/// working there (it only probes the overlay port).
pub fn migrate_legacy_app_dir() {
    copy_dir_if_absent(&legacy_app_dir(), &app_dir());
}

/// Copies `from` to `to` when `from` exists and `to` doesn't. Best effort: a
/// failure never blocks the launch, and a half-made copy is removed so the
/// next launch tries again instead of starting on a partial folder.
pub fn copy_dir_if_absent(from: &std::path::Path, to: &std::path::Path) {
    if !from.is_dir() || to.exists() {
        return;
    }
    if let Err(err) = copy_dir(from, to) {
        eprintln!("[user_dirs] Failed to carry {} over to {}: {err}", from.display(), to.display());
        let _ = std::fs::remove_dir_all(to);
    }
}

fn copy_dir(from: &std::path::Path, to: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}
