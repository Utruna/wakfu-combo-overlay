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
/// On Windows, the same folder as the 1.x (Electron) versions, so their
/// settings — and the loader page path users pasted into OBS — carry over.
pub fn app_dir() -> PathBuf {
    // Lowercase, like the other folders in ~/.config.
    let name = if cfg!(any(windows, target_os = "macos")) { "Wakfu Combo Overlay" } else { "wakfu-combo-overlay" };
    app_data().join(name)
}
