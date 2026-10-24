use serde_json::{json, Map, Value};
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};

use wakfu_combo_overlay_lib::settings::{Defaults, SettingsStore};

static NEXT: AtomicU32 = AtomicU32::new(0);

fn tmp_settings_path() -> PathBuf {
    let n = NEXT.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("wakfu-settings-{}-{n}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir.join("settings.json")
}

fn defaults() -> Defaults {
    Defaults { overlay_port: 3456, logs_dir: "logs".into() }
}

fn layout_change(value: Value) -> Map<String, Value> {
    value.as_object().unwrap().clone()
}

fn names(store: &SettingsStore) -> Vec<&str> {
    store.heroes().iter().map(|h| h["characterName"].as_str().unwrap()).collect()
}

fn blue() -> Value {
    json!({ "r": 74, "g": 144, "b": 226 })
}

fn hero(name: &str, class: &str) -> Value {
    json!({ "characterName": name, "color": blue(), "class": class })
}

#[test]
fn persists_the_overlay_port_across_restarts() {
    let file = tmp_settings_path();
    SettingsStore::open(&file).set_overlay_port(4000);
    assert_eq!(SettingsStore::open(&file).overlay_port(), 4000);
}

#[test]
fn falls_back_to_the_backup_when_settings_json_is_corrupt() {
    let file = tmp_settings_path();
    let mut store = SettingsStore::open(&file);
    store.set_overlay_port(4000);
    store.set_overlay_port(4001); // second write creates the .bak holding 4000

    fs::write(&file, "").unwrap(); // simulates a write interrupted by a crash/shutdown

    assert_eq!(SettingsStore::open(&file).overlay_port(), 4000);
}

#[test]
fn leaves_no_temp_file_behind() {
    let file = tmp_settings_path();
    SettingsStore::open(&file).set_overlay_port(4000);
    assert!(!PathBuf::from(format!("{}.tmp", file.display())).exists());
}

#[test]
fn keeps_unknown_fields_of_older_or_newer_versions() {
    let file = tmp_settings_path();
    fs::write(&file, r#"{"someFutureField": {"a": 1}, "overlayPort": 3460}"#).unwrap();
    SettingsStore::open(&file).set_overlay_port(3461);
    let saved: Value = serde_json::from_str(&fs::read_to_string(&file).unwrap()).unwrap();
    assert_eq!(saved["someFutureField"], json!({ "a": 1 }));
}

#[test]
fn keeps_the_class_icon_where_it_was_for_layouts_saved_before_the_setting_existed() {
    let file = tmp_settings_path();
    fs::write(
        &file,
        json!({ "comboLayout": { "orientation": "vertical", "direction": "bottom-to-top", "iconSize": 32,
            "castLifetimeMs": 6000, "maxVisibleCasts": 8, "previewEnabled": false, "damageCounterEnabled": true } })
        .to_string(),
    )
    .unwrap();
    let mut store = SettingsStore::open(&file);
    store.ensure_defaults(&defaults());
    assert_eq!(store.combo_layout()["classIconSide"], "right");
}

#[test]
fn ignores_an_invalid_class_icon_side() {
    let mut store = SettingsStore::open(tmp_settings_path());
    store.ensure_defaults(&defaults());
    store.set_combo_layout(&layout_change(json!({ "classIconSide": "right" })));
    store.set_combo_layout(&layout_change(json!({ "classIconSide": "middle" })));
    assert_eq!(store.combo_layout()["classIconSide"], "right");
}

#[test]
fn clamps_out_of_range_layout_numbers() {
    let mut store = SettingsStore::open(tmp_settings_path());
    store.ensure_defaults(&defaults());
    let layout = store.set_combo_layout(&layout_change(json!({ "iconSize": 999, "castLifetimeMs": "2500.5", "maxVisibleCasts": "x" })));
    assert_eq!(layout["iconSize"], 128);
    assert_eq!(layout["castLifetimeMs"], 2501);
    assert_eq!(layout["maxVisibleCasts"], 8);
}

#[test]
fn reinserts_a_removed_hero_at_its_old_position_and_tracked_state() {
    let mut store = SettingsStore::open(tmp_settings_path());
    store.ensure_defaults(&defaults());
    store.add_hero(&hero("A", "iop"), None, true);
    store.add_hero(&hero("B", "cra"), None, true);
    store.add_hero(&hero("C", "sram"), None, true);
    store.set_tracked_heroes(&[json!("A"), json!("C")]);

    store.remove_hero("B");
    assert!(store.add_hero(&hero("B", "cra"), Some(1), false));

    assert_eq!(names(&store), ["A", "B", "C"]);
    assert!(!store.is_tracked("B"));
}

#[test]
fn renames_a_hero_keeping_it_tracked_under_its_new_name() {
    let mut store = SettingsStore::open(tmp_settings_path());
    store.ensure_defaults(&defaults());
    store.add_hero(&hero("Old", "iop"), None, true);

    assert!(store.update_hero("Old", &json!({ "characterName": "New", "class": "cra" })));

    assert_eq!(
        store.heroes(),
        [json!({ "name": "New", "characterName": "New", "color": blue(), "class": "cra" })]
    );
    assert_eq!(store.tracked_character_names(), ["New"]);
}

#[test]
fn refuses_to_rename_a_hero_to_a_blank_or_already_used_name() {
    let mut store = SettingsStore::open(tmp_settings_path());
    store.ensure_defaults(&defaults());
    store.add_hero(&hero("A", "iop"), None, true);
    store.add_hero(&hero("B", "cra"), None, true);

    assert!(!store.update_hero("A", &json!({ "characterName": "B" })));
    assert!(!store.update_hero("A", &json!({ "characterName": "  " })));
    assert_eq!(names(&store), ["A", "B"]);
}

#[test]
fn turns_the_damage_counter_on_for_layouts_saved_before_the_setting_existed() {
    let file = tmp_settings_path();
    fs::write(&file, r#"{"comboLayout": {"orientation": "vertical", "direction": "top-to-bottom", "iconSize": 32}}"#)
        .unwrap();
    let mut store = SettingsStore::open(&file);
    store.ensure_defaults(&defaults());
    assert_eq!(store.combo_layout()["damageCounterEnabled"], true);

    store.set_combo_layout(&layout_change(json!({ "damageCounterEnabled": 0 })));
    assert_eq!(store.combo_layout()["damageCounterEnabled"], false);
}

#[test]
fn persists_the_onboarding_flag() {
    let file = tmp_settings_path();
    assert!(!SettingsStore::open(&file).onboarding_done());
    SettingsStore::open(&file).set_onboarding_done();
    assert!(SettingsStore::open(&file).onboarding_done());
}
