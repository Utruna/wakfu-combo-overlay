use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

use wakfu_combo_overlay_lib::log_reader::{CastEvent, LogEvent, WakfuCombatLogReader};

static NEXT_DIR: AtomicU32 = AtomicU32::new(0);

fn temp_dir(prefix: &str) -> PathBuf {
    let n = NEXT_DIR.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("{prefix}-{}-{n}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn make_logs_dir(initial: &str) -> (PathBuf, PathBuf) {
    let dir = temp_dir("wakfu-logs");
    let log = dir.join("wakfu.log");
    fs::write(&log, initial).unwrap();
    (dir, log)
}

fn append(path: &Path, bytes: &[u8]) {
    OpenOptions::new().append(true).open(path).unwrap().write_all(bytes).unwrap();
}

fn cast_line(who: &str, spell: &str) -> String {
    format!("12:00:00,000 [Information (combat)] {who} lance le sort {spell}\r\n")
}

fn casts(events: Vec<LogEvent>) -> Vec<CastEvent> {
    events
        .into_iter()
        .filter_map(|e| match e {
            LogEvent::Cast(c) => Some(c),
            LogEvent::Line(_) => None,
        })
        .collect()
}

#[test]
fn ignores_content_already_in_the_log_at_start_emits_appended_casts() {
    let (dir, log) = make_logs_dir(&cast_line("Lueur Pourpre", "Ancienne"));
    let mut reader = WakfuCombatLogReader::new(&dir);

    append(&log, cast_line("Lueur Pourpre", "Saignée mortelle").as_bytes());
    let found = casts(reader.scan());

    assert_eq!(found.len(), 1);
    assert_eq!(found[0].character_name, "Lueur Pourpre");
    assert_eq!(found[0].spell_name, "Saignée mortelle");
}

#[test]
fn waits_for_a_line_to_be_complete_before_parsing_it() {
    let (dir, log) = make_logs_dir("");
    let mut reader = WakfuCombatLogReader::new(&dir);

    append(&log, "12:00:00,000 [Information (combat)] Lueur Pourpre lance le sort Saig".as_bytes());
    assert!(casts(reader.scan()).is_empty());

    append(&log, "née mortelle\r\n".as_bytes());
    let found = casts(reader.scan());
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].spell_name, "Saignée mortelle");
}

#[test]
fn decodes_a_multi_byte_character_split_across_two_writes() {
    let (dir, log) = make_logs_dir("");
    let mut reader = WakfuCombatLogReader::new(&dir);

    let line = cast_line("Lueur Pourpre", "Flèche lumineuse");
    let bytes = line.as_bytes();
    let split_at = line.find('è').unwrap() + 1; // middle of "è"
    append(&log, &bytes[..split_at]);
    let mut found = casts(reader.scan());
    append(&log, &bytes[split_at..]);
    found.extend(casts(reader.scan()));

    assert_eq!(found.len(), 1);
    assert_eq!(found[0].spell_name, "Flèche lumineuse");
}

#[test]
fn strips_the_trailing_detail_from_the_spell_name() {
    let (dir, log) = make_logs_dir("");
    let mut reader = WakfuCombatLogReader::new(&dir);

    append(&log, cast_line("Lueur Pourpre", "Fourberie (Critiques)").as_bytes());
    assert_eq!(casts(reader.scan())[0].spell_name, "Fourberie");
}

#[test]
fn reads_a_truncated_or_recreated_log_from_the_start() {
    let (dir, log) = make_logs_dir(&format!("{}\n", "x".repeat(5000)));
    let mut reader = WakfuCombatLogReader::new(&dir);

    fs::write(&log, cast_line("Lueur Pourpre", "Premier Sang")).unwrap();
    let found = casts(reader.scan());

    assert_eq!(found.len(), 1);
    assert_eq!(found[0].spell_name, "Premier Sang");
}

#[test]
fn suppresses_the_near_simultaneous_duplicate_written_by_a_second_client() {
    let (dir, log) = make_logs_dir("");
    let mut reader = WakfuCombatLogReader::new(&dir);

    let line = cast_line("Lueur Pourpre", "Fourberie");
    append(&log, format!("{line}{line}").as_bytes());
    assert_eq!(casts(reader.scan()).len(), 1);
}

#[test]
fn emits_every_line_before_its_cast() {
    let (dir, log) = make_logs_dir("");
    let mut reader = WakfuCombatLogReader::new(&dir);

    append(&log, b"12:00:00,000 [Information (combat)] Kamarachnide: -100 PV (Air)\r\n");
    append(&log, cast_line("Lueur Pourpre", "Fourberie").as_bytes());
    let kinds: Vec<&str> = reader
        .scan()
        .iter()
        .map(|e| match e {
            LogEvent::Line(_) => "line",
            LogEvent::Cast(_) => "cast",
        })
        .collect();
    assert_eq!(kinds, ["line", "line", "cast"]);
}

#[test]
fn picks_up_a_logs_dir_that_only_appears_after_start() {
    let dir = temp_dir("wakfu-late").join("logs");
    let mut reader = WakfuCombatLogReader::new(&dir);

    fs::create_dir_all(&dir).unwrap();
    let log = dir.join("wakfu.log");
    fs::write(&log, "").unwrap();
    reader.scan(); // discovers the file, seeds it at EOF
    append(&log, cast_line("Lueur Pourpre", "Fourberie").as_bytes());

    assert_eq!(casts(reader.scan()).len(), 1);
}
