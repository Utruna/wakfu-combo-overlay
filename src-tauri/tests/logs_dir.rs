//! Finding Wakfu's logs folder: which of the places it can be is picked.

use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, SystemTime};

use taktik_lib::log_reader::{pick_logs_dir, redetected_logs_dir};

static NEXT_DIR: AtomicU32 = AtomicU32::new(0);

fn temp_dir(prefix: &str) -> PathBuf {
    let n = NEXT_DIR.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("{prefix}-{}-{n}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

/// A logs folder holding a wakfu.log last written `age` ago.
fn logs_with_log(root: &PathBuf, name: &str, age: Duration) -> PathBuf {
    let dir = root.join(name);
    fs::create_dir_all(&dir).unwrap();
    let log = fs::File::create(dir.join("wakfu.log")).unwrap();
    log.set_modified(SystemTime::now() - age).unwrap();
    dir
}

#[test]
fn picks_the_folder_whose_log_was_written_last() {
    let root = temp_dir("wakfu-pick");
    let old = logs_with_log(&root, "old", Duration::from_secs(3600));
    let recent = logs_with_log(&root, "recent", Duration::from_secs(10));
    let missing = root.join("missing");
    assert_eq!(pick_logs_dir(&[missing, old, recent.clone()]), recent);
}

#[test]
fn without_any_log_picks_the_first_existing_folder_then_the_first() {
    let root = temp_dir("wakfu-pick-empty");
    let (missing, empty) = (root.join("missing"), root.join("empty"));
    fs::create_dir_all(&empty).unwrap();
    assert_eq!(pick_logs_dir(&[missing.clone(), empty.clone()]), empty);
    assert_eq!(pick_logs_dir(&[missing.clone(), root.join("other")]), missing);
    assert_eq!(pick_logs_dir(&[]), PathBuf::new());
}

#[test]
fn switches_from_an_empty_default_to_where_the_logs_are() {
    let root = temp_dir("wakfu-redetect");
    let default = root.join("native");
    let wine = logs_with_log(&root, "wine", Duration::from_secs(10));
    let candidates = [default.clone(), wine.clone()];
    assert_eq!(redetected_logs_dir(&default, &candidates), Some(wine.clone()));
    // Already the right one: nothing to change.
    assert_eq!(redetected_logs_dir(&wine, &candidates), None);
}

#[test]
fn keeps_a_folder_the_user_chose_or_a_default_with_logs() {
    let root = temp_dir("wakfu-redetect-keep");
    let found = logs_with_log(&root, "found", Duration::from_secs(10));
    let chosen = root.join("chosen-by-hand");
    assert_eq!(redetected_logs_dir(&chosen, &[found.clone()]), None);

    let default = logs_with_log(&root, "default", Duration::from_secs(3600));
    assert_eq!(redetected_logs_dir(&default, &[default.clone(), found]), None);
}

#[test]
fn stays_on_the_default_while_no_candidate_has_logs() {
    let root = temp_dir("wakfu-redetect-none");
    let default = root.join("native");
    assert_eq!(redetected_logs_dir(&default, &[default.clone(), root.join("wine")]), None);
}

#[cfg(not(windows))]
mod candidates {
    use super::*;
    use taktik_lib::log_reader::logs_dir_candidates_in;

    const ZAAP: &str = "AppData/Roaming/zaap/gamesLogs/wakfu/logs";

    #[test]
    fn lists_the_native_launcher_first_then_each_wine_prefix() {
        let home = temp_dir("wakfu-home");
        for prefix in [
            ".wine",
            ".local/share/Steam/steamapps/compatdata/123/pfx",
            "Games/wakfu",
            "Library/Application Support/CrossOver/Bottles/Wakfu",
        ] {
            fs::create_dir_all(home.join(prefix).join("drive_c/users/me")).unwrap();
        }
        let app_data = home.join(".config");
        let found = logs_dir_candidates_in(&home, app_data.clone());
        assert_eq!(
            found,
            vec![
                app_data.join("zaap/gamesLogs/wakfu/logs"),
                home.join(".wine/drive_c/users/me").join(ZAAP),
                home.join(".local/share/Steam/steamapps/compatdata/123/pfx/drive_c/users/me").join(ZAAP),
                home.join("Games/wakfu/drive_c/users/me").join(ZAAP),
                home.join("Library/Application Support/CrossOver/Bottles/Wakfu/drive_c/users/me").join(ZAAP),
            ]
        );
    }

    /// ~/.steam/steam is a link to ~/.local/share/Steam.
    #[cfg(unix)]
    #[test]
    fn lists_a_prefix_reached_through_a_link_once() {
        let home = temp_dir("wakfu-home-link");
        let steam = home.join(".local/share/Steam");
        fs::create_dir_all(steam.join("steamapps/compatdata/123/pfx/drive_c/users/steamuser")).unwrap();
        fs::create_dir_all(home.join(".steam")).unwrap();
        std::os::unix::fs::symlink(&steam, home.join(".steam/steam")).unwrap();
        let found = logs_dir_candidates_in(&home, home.join(".config"));
        assert_eq!(found.len(), 2, "{found:?}");
    }

    #[test]
    fn with_nothing_installed_lists_only_the_native_launcher() {
        let home = temp_dir("wakfu-home-empty");
        assert_eq!(logs_dir_candidates_in(&home, home.join("cfg")), vec![home.join("cfg/zaap/gamesLogs/wakfu/logs")]);
    }
}
