use taktik_lib::whats_new::{notes, on_launch, parse_version, sections, OnLaunch};

const CHANGELOG: &str = "## v2.2.0\r\n\r\n### Nouveau\r\n\r\n- A\r\n\r\n## v2.1.1\n\n- B\n\n## v2.1.0\n\n- C\n\n## v2.0.0\n\n- D\n";

fn versions(shown: &[serde_json::Value]) -> Vec<&str> {
    shown.iter().map(|note| note["version"].as_str().unwrap()).collect()
}

#[test]
fn parses_versions() {
    assert_eq!(parse_version("v2.10.3"), Some((2, 10, 3)));
    assert_eq!(parse_version("2.1.0"), Some((2, 1, 0)));
    assert_eq!(parse_version("2.1"), None);
    assert_eq!(parse_version("Nouveau"), None);
}

#[test]
fn splits_the_changelog_into_versions() {
    let sections = sections(CHANGELOG);
    assert_eq!(sections.len(), 4);
    assert_eq!(sections[0], ("2.2.0".to_string(), "### Nouveau\n\n- A".to_string()));
    assert_eq!(sections[1].1, "- B");
}

#[test]
fn shows_every_version_since_the_last_one_seen() {
    assert_eq!(versions(&notes(CHANGELOG, "2.2.0", Some("2.1.0"))), ["2.2.0", "2.1.1"]);
    assert_eq!(versions(&notes(CHANGELOG, "2.2.0", Some("2.1.1"))), ["2.2.0"]);
    // Never a version newer than the running one.
    assert_eq!(versions(&notes(CHANGELOG, "2.1.1", Some("2.0.0"))), ["2.1.1", "2.1.0"]);
}

#[test]
fn opened_by_hand_shows_the_latest_few() {
    assert_eq!(versions(&notes(CHANGELOG, "2.2.0", None)), ["2.2.0", "2.1.1", "2.1.0"]);
}

#[test]
fn decides_what_to_do_at_launch() {
    assert_eq!(on_launch(Some("2.2.0"), "2.2.0", true), OnLaunch::Nothing);
    assert_eq!(on_launch(Some("2.1.1"), "2.2.0", true), OnLaunch::Show(Some("2.1.1".into())));
    // Updated from a version that didn't record what was seen.
    assert_eq!(on_launch(None, "2.2.0", true), OnLaunch::Show(None));
    // Fresh install: the onboarding greets the user instead.
    assert_eq!(on_launch(None, "2.2.0", false), OnLaunch::Remember);
    // Downgraded: nothing to announce.
    assert_eq!(on_launch(Some("2.3.0"), "2.2.0", true), OnLaunch::Nothing);
}
