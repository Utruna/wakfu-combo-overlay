use serde_json::json;
use std::fs;
use std::path::Path;

use wakfu_combo_overlay_lib::loader_page::{build_loader_html, write_loader_page, PROBED_ASSET};
use wakfu_combo_overlay_lib::matcher::{find_hero_index, normalize_name};

#[test]
fn normalizes_accents_case_and_punctuation() {
    assert_eq!(normalize_name("  Lueur Émeraude "), "lueur emeraude");
    assert_eq!(normalize_name("Fresh--Fighterz!"), "fresh fighterz");
}

#[test]
fn matches_heroes_by_in_game_name_or_alias_only() {
    let heroes = [
        json!({ "name": "Lueur Pourpre", "characterName": "Lueur Pourpre", "class": "sram" }),
        json!({ "name": "Main", "characterName": "Lueur Ocre", "characterAliases": ["Ocre-Alt"] }),
    ];
    assert_eq!(find_hero_index("Lueur Pourpre", &heroes), Some(0));
    assert_eq!(find_hero_index("lueur ocre", &heroes), Some(1));
    assert_eq!(find_hero_index("Ocre-Alt", &heroes), Some(1));
    assert_eq!(find_hero_index("Un Iop Quelconque", &heroes), None);
    assert_eq!(find_hero_index("", &heroes), None);
}

#[test]
fn loader_targets_the_configured_port() {
    assert!(build_loader_html(4123).contains(r#""http://127.0.0.1:4123/""#));
}

#[test]
fn loader_probes_an_asset_the_overlay_server_actually_serves() {
    assert!(build_loader_html(3457).contains(PROBED_ASSET));
    let in_app = Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("ui").join(PROBED_ASSET);
    assert!(in_app.exists(), "{PROBED_ASSET} must exist in ui/");
}

#[test]
fn write_loader_page_rewrites_the_file_when_the_port_changes() {
    let dir = std::env::temp_dir().join(format!("wakfu-loader-{}", std::process::id()));
    let path = write_loader_page(&dir, 3457).unwrap();
    write_loader_page(&dir, 4000);
    assert!(fs::read_to_string(path).unwrap().contains("127.0.0.1:4000"));
}
