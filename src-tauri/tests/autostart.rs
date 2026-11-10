//! The files that start the app with the session on Linux and macOS.
#![cfg(not(windows))]

use std::path::Path;

use wakfu_combo_overlay_lib::autostart::{desktop_entry, desktop_exec_arg, launch_agent};

#[test]
fn quotes_exec_arguments_as_the_desktop_entry_spec_asks() {
    assert_eq!(desktop_exec_arg("/home/me/Wakfu Overlay.AppImage"), r#""/home/me/Wakfu Overlay.AppImage""#);
    assert_eq!(desktop_exec_arg(r#"/a"b$c`d"#), r#""/a\\"b\\$c\\`d""#);
    assert_eq!(desktop_exec_arg(r"/a\b"), r#""/a\\\\b""#);
    assert_eq!(desktop_exec_arg("/100%"), r#""/100%%""#);
}

#[test]
fn the_desktop_entry_starts_the_app_hidden() {
    let entry = desktop_entry(Path::new("/home/me/Applications/wakfu-combo-overlay.AppImage"));
    assert!(entry.starts_with("[Desktop Entry]\n"));
    assert!(entry.contains("\nType=Application\n"));
    assert!(entry.contains("\nExec=\"/home/me/Applications/wakfu-combo-overlay.AppImage\" --hidden\n"));
}

#[test]
fn the_launch_agent_starts_the_app_hidden_at_login() {
    let plist = launch_agent(
        "com.example.app",
        Path::new("/Applications/Wakfu & Co.app/Contents/MacOS/wakfu-combo-overlay"),
    );
    assert!(plist.contains("<key>Label</key>\n\t<string>com.example.app</string>"));
    assert!(plist.contains(
        "\t\t<string>/Applications/Wakfu &amp; Co.app/Contents/MacOS/wakfu-combo-overlay</string>\n\t\t<string>--hidden</string>"
    ));
    assert!(plist.contains("<key>RunAtLoad</key>\n\t<true/>"));
}
