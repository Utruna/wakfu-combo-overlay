//! The spell and class icons shipped with the app: data/spellIcons.json (built
//! by tools/scrape_spell_icons.js) and ui/assets/icons/classes/*.png.

use serde_json::{json, Map, Value};
use std::collections::HashMap;

const SPELL_ICONS_JSON: &str = include_str!("../../data/spellIcons.json");

/// Every class the game has, by the id the settings page and the icon
/// folders use.
pub const CLASSES: [&str; 18] = [
    "feca", "osamodas", "enutrof", "sram", "xelor", "ecaflip", "eniripsa", "iop", "cra", "sadida",
    "sacrieur", "pandawa", "roublard", "zobal", "ouginak", "steamer", "eliotrope", "huppermage",
];

const PREVIEW_COLORS: [(u8, u8, u8); 6] =
    [(74, 144, 226), (220, 50, 50), (76, 175, 80), (171, 71, 188), (255, 167, 38), (38, 198, 218)];

pub struct Catalog {
    /// class -> spell name -> icon path (relative to ui/), in scraped order.
    spell_icons: Vec<(String, HashMap<String, String>)>,
    /// class -> emblem path (relative to ui/), for the classes that have one.
    pub class_icons: Map<String, Value>,
    /// One sample cast per class, for the settings page's overlay preview.
    pub preview_pool: Value,
}

impl Catalog {
    /// `has_asset` tells whether a ui/ file exists (the class emblems).
    pub fn load(has_asset: impl Fn(&str) -> bool) -> Self {
        let table: Map<String, Value> = serde_json::from_str(SPELL_ICONS_JSON).unwrap_or_default();

        let mut preview_pool = Vec::new();
        for (hero_class, spells) in &table {
            let first = spells.as_object().and_then(|s| s.iter().next());
            let Some((spell_name, entry)) = first else { continue };
            let Some(icon) = entry.get("icon").and_then(Value::as_str) else { continue };
            let (r, g, b) = PREVIEW_COLORS[preview_pool.len() % PREVIEW_COLORS.len()];
            preview_pool.push(json!({
                "class": hero_class,
                "spellName": spell_name,
                "icon": icon,
                "color": { "r": r, "g": g, "b": b },
            }));
        }

        let spell_icons = table
            .into_iter()
            .map(|(class, spells)| {
                let icons = spells
                    .as_object()
                    .into_iter()
                    .flatten()
                    .filter_map(|(name, entry)| Some((name.clone(), entry.get("icon")?.as_str()?.to_string())))
                    .collect();
                (class, icons)
            })
            .collect();

        let class_icons = CLASSES
            .iter()
            .map(|class| (*class, format!("assets/icons/classes/{class}.png")))
            .filter(|(_, path)| has_asset(path))
            .map(|(class, path)| (class.to_string(), json!(path)))
            .collect();

        Self { spell_icons, class_icons, preview_pool: Value::Array(preview_pool) }
    }

    /// A spell's icon, scoped to the caster's class when known (this is what
    /// correctly resolves same-named spells across classes, e.g. "Rafale" for
    /// both Iop and Cra). Falls back to a best-effort search across every
    /// class when the hero's class isn't set.
    pub fn spell_icon(&self, hero_class: Option<&str>, spell_name: &str) -> Option<&str> {
        let in_class = hero_class.and_then(|class| {
            let (_, spells) = self.spell_icons.iter().find(|(c, _)| c == class)?;
            spells.get(spell_name)
        });
        in_class
            .or_else(|| self.spell_icons.iter().find_map(|(_, spells)| spells.get(spell_name)))
            .map(String::as_str)
    }

    /// Spell names of a class (all classes when it has none), for test casts.
    pub fn spell_names(&self, hero_class: Option<&str>) -> Vec<&str> {
        let own: Vec<&str> = self
            .spell_icons
            .iter()
            .filter(|(c, _)| Some(c.as_str()) == hero_class)
            .flat_map(|(_, spells)| spells.keys().map(String::as_str))
            .collect();
        if !own.is_empty() {
            return own;
        }
        self.spell_icons.iter().flat_map(|(_, spells)| spells.keys().map(String::as_str)).collect()
    }

    pub fn class_icon(&self, hero_class: Option<&str>) -> Value {
        hero_class.and_then(|c| self.class_icons.get(c)).cloned().unwrap_or(Value::Null)
    }
}
