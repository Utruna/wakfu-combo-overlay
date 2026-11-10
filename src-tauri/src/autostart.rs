//! Starting with the session: the per-user "Run" registry key on Windows, an
//! XDG autostart entry on Linux, a launch agent on macOS.
//!
//! Starting with the session is what keeps the overlay reachable when OBS
//! opens first: a browser source whose first load fails shows an error page
//! and never retries by itself, so the server has to be up before OBS is.

use std::io;
#[cfg(not(windows))]
use std::path::Path;

/// Passed by the login entry: starts straight in the tray instead of popping
/// the settings window at every session start.
pub const HIDDEN_ARG: &str = "--hidden";

/// Why the app can't register itself here, if it can't.
pub fn unavailable_reason() -> Option<&'static str> {
    // Only an installed build registers itself — a dev build would leave an
    // entry pointing at a target/ folder.
    if cfg!(debug_assertions) {
        return Some("Indisponible en développement (build non packagé).");
    }
    imp::unavailable_reason()
}

pub fn available() -> bool {
    unavailable_reason().is_none()
}

pub fn is_enabled() -> bool {
    available() && imp::is_enabled()
}

pub fn set_enabled(enabled: bool) -> io::Result<()> {
    if !available() {
        return Ok(());
    }
    imp::set_enabled(enabled)
}

/// The 1.x (Electron) versions registered their own entry, pointing at an
/// exe the new installer removes: carry the user's choice over to this
/// version's entry instead of leaving a dead one behind. 1.x only ever
/// existed on Windows.
pub fn migrate_from_electron() {
    #[cfg(windows)]
    if available() {
        imp::migrate_from_electron();
    }
}

#[cfg(windows)]
mod imp {
    use std::io;
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_SET_VALUE};
    use winreg::RegKey;

    use super::HIDDEN_ARG;

    const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
    const VALUE_NAME: &str = "Wakfu Combo Overlay";
    /// Electron's own name for the entry the 1.x versions registered.
    const ELECTRON_VALUE_PREFIX: &str = "electron.app.";
    const ELECTRON_INSTALL_MARKER: &str = r"\programs\wakfu-combo-overlay\";

    pub fn unavailable_reason() -> Option<&'static str> {
        None
    }

    fn run_key(access: u32) -> io::Result<RegKey> {
        RegKey::predef(HKEY_CURRENT_USER).open_subkey_with_flags(RUN_KEY, access)
    }

    pub fn is_enabled() -> bool {
        run_key(KEY_READ).is_ok_and(|key| key.get_value::<String, _>(VALUE_NAME).is_ok())
    }

    pub fn set_enabled(enabled: bool) -> io::Result<()> {
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

    pub fn migrate_from_electron() {
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
}

#[cfg(all(unix, not(target_os = "macos")))]
mod imp {
    use std::io;
    use std::path::PathBuf;

    pub fn unavailable_reason() -> Option<&'static str> {
        None
    }

    /// `~/.config/autostart`: what every desktop (GNOME, KDE, Xfce…) starts at login.
    fn entry_path() -> PathBuf {
        crate::user_dirs::app_data().join("autostart").join("wakfu-combo-overlay.desktop")
    }

    /// The AppImage file itself: the running executable is a copy mounted
    /// under /tmp, gone as soon as the app quits.
    fn executable() -> io::Result<PathBuf> {
        match std::env::var_os("APPIMAGE") {
            Some(appimage) => Ok(PathBuf::from(appimage)),
            None => std::env::current_exe(),
        }
    }

    pub fn is_enabled() -> bool {
        entry_path().is_file()
    }

    pub fn set_enabled(enabled: bool) -> io::Result<()> {
        let contents = if enabled { Some(super::desktop_entry(&executable()?)) } else { None };
        super::write_entry(&entry_path(), contents)
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use std::io;
    use std::path::PathBuf;

    const LABEL: &str = "com.colinliaud.wakfu-combo-overlay";

    /// An app opened where it was downloaded runs from a random read-only
    /// copy (App Translocation), and one opened straight from its disk image
    /// disappears with it: an entry pointing at either would be dead by the
    /// next login.
    pub fn unavailable_reason() -> Option<&'static str> {
        let exe = std::env::current_exe().ok()?;
        let exe = exe.to_string_lossy();
        (exe.contains("/AppTranslocation/") || exe.starts_with("/Volumes/"))
            .then_some("Range d'abord l'application dans le dossier Applications.")
    }

    /// Launch agents in this folder are started by launchd at every login.
    fn agent_path() -> PathBuf {
        crate::user_dirs::home().join("Library").join("LaunchAgents").join(format!("{LABEL}.plist"))
    }

    pub fn is_enabled() -> bool {
        agent_path().is_file()
    }

    pub fn set_enabled(enabled: bool) -> io::Result<()> {
        let contents = if enabled { Some(super::launch_agent(LABEL, &std::env::current_exe()?)) } else { None };
        super::write_entry(&agent_path(), contents)
    }
}

/// Writes (or removes) the one file that registers the app.
#[cfg(not(windows))]
fn write_entry(path: &Path, contents: Option<String>) -> io::Result<()> {
    match contents {
        Some(contents) => {
            if let Some(dir) = path.parent() {
                std::fs::create_dir_all(dir)?;
            }
            std::fs::write(path, contents)
        }
        None => match std::fs::remove_file(path) {
            Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(()),
            other => other,
        },
    }
}

/// The XDG autostart entry starting `exe` in the tray.
#[cfg(not(windows))]
pub fn desktop_entry(exe: &Path) -> String {
    format!(
        "[Desktop Entry]\n\
         Type=Application\n\
         Name=Wakfu Combo Overlay\n\
         Comment=Overlay des sorts lancés dans Wakfu\n\
         Exec={} {HIDDEN_ARG}\n\
         Terminal=false\n\
         X-GNOME-Autostart-enabled=true\n",
        desktop_exec_arg(&exe.to_string_lossy()),
    )
}

/// One argument of an Exec= line, quoted as the Desktop Entry spec asks: in
/// double quotes, with `"`, `` ` ``, `$` and `\` escaped by a backslash —
/// then every backslash doubled again, the value itself being an escaped
/// string — and `%` doubled (field codes).
#[cfg(not(windows))]
pub fn desktop_exec_arg(arg: &str) -> String {
    let mut quoted = String::from("\"");
    for c in arg.chars() {
        match c {
            '"' | '`' | '$' | '\\' => {
                quoted.push('\\');
                quoted.push(c);
            }
            '%' => quoted.push_str("%%"),
            _ => quoted.push(c),
        }
    }
    quoted.push('"');
    quoted.replace('\\', "\\\\")
}

/// The launch agent starting `exe` in the tray at login.
#[cfg(not(windows))]
pub fn launch_agent(label: &str, exe: &Path) -> String {
    let xml = |text: &str| text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;");
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
         <!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n\
         <plist version=\"1.0\">\n\
         <dict>\n\
         \t<key>Label</key>\n\
         \t<string>{}</string>\n\
         \t<key>ProgramArguments</key>\n\
         \t<array>\n\
         \t\t<string>{}</string>\n\
         \t\t<string>{HIDDEN_ARG}</string>\n\
         \t</array>\n\
         \t<key>RunAtLoad</key>\n\
         \t<true/>\n\
         \t<key>ProcessType</key>\n\
         \t<string>Interactive</string>\n\
         </dict>\n\
         </plist>\n",
        xml(label),
        xml(&exe.to_string_lossy()),
    )
}
