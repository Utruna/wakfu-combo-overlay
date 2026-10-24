//! Matches a character name read from the combat log against the configured
//! heroes.
//!
//! Strict on purpose: any fighter in a log line could be someone other than
//! the user's own characters, so only exact name/alias matches count — never
//! a fuzzy class-name guess that would false-positive on an unrelated player
//! whose name happens to contain "Iop".

use serde_json::Value;
use unicode_normalization::char::is_combining_mark;
use unicode_normalization::UnicodeNormalization;

/// Accents stripped, lowercase, any run of non-alphanumerics as one space.
pub fn normalize_name(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut pending_space = false;
    for c in value.nfd().filter(|c| !is_combining_mark(*c)).flat_map(char::to_lowercase) {
        if c.is_ascii_alphanumeric() {
            if pending_space && !out.is_empty() {
                out.push(' ');
            }
            pending_space = false;
            out.push(c);
        } else {
            pending_space = true;
        }
    }
    out
}

fn hero_aliases(hero: &Value) -> impl Iterator<Item = &str> {
    let character_name = hero.get("characterName").and_then(Value::as_str);
    let aliases = hero
        .get("characterAliases")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str);
    character_name.into_iter().chain(aliases)
}

/// Index of the hero playing under `log_character_name`, if any.
pub fn find_hero_index(log_character_name: &str, heroes: &[Value]) -> Option<usize> {
    let wanted = normalize_name(log_character_name.trim());
    if wanted.is_empty() {
        return None;
    }

    // Strong match: the in-game name or one of its aliases.
    if let Some(i) = heroes
        .iter()
        .position(|hero| hero_aliases(hero).any(|alias| normalize_name(alias) == wanted))
    {
        return Some(i);
    }

    // Then the display name.
    heroes.iter().position(|hero| {
        let name = hero.get("name").and_then(Value::as_str).unwrap_or_default();
        normalize_name(name).contains(&wanted)
    })
}
