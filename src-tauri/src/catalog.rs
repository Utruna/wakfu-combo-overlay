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

/// The game's class ids, as the "[_FL_] … breed : N" join lines give them.
/// Checked against real fights: 6, 7, 8, 11, 13, 19; the others are the
/// game's published ids.
const BREEDS: [(&str, &str); 18] = [
    ("1", "feca"), ("2", "osamodas"), ("3", "enutrof"), ("4", "sram"), ("5", "xelor"), ("6", "ecaflip"),
    ("7", "eniripsa"), ("8", "iop"), ("9", "cra"), ("10", "sadida"), ("11", "sacrieur"), ("12", "pandawa"),
    ("13", "roublard"), ("14", "zobal"), ("15", "ouginak"), ("16", "steamer"), ("18", "eliotrope"),
    ("19", "huppermage"),
];

/// Spells any class can have (items, mounts…): they say nothing of the class.
const SHARED_SPELLS_CLASS: &str = "commun";

const PREVIEW_COLORS:[(u8, u8, u8); 6] =
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

    /// The class a player's casts give away: each cast of a spell only one
    /// class has is a vote for it ("Rafale", Iop and Cra, votes for neither);
    /// the class with most votes wins. None if no vote, or a tie — a stray
    /// spell filed under another class (seen: a Sacrieur's "Méditation") is
    /// outvoted by the rest.
    pub fn class_of_spells<'a>(&self, spells: impl IntoIterator<Item = &'a str>) -> Option<&str> {
        let mut votes: HashMap<&str, usize> = HashMap::new();
        for spell in spells {
            let mut owners = self
                .spell_icons
                .iter()
                .filter(|(class, icons)| class != SHARED_SPELLS_CLASS && icons.contains_key(spell))
                .map(|(class, _)| class.as_str());
            if let (Some(only), None) = (owners.next(), owners.next()) {
                *votes.entry(only).or_insert(0) += 1;
            }
        }
        let most = *votes.values().max()?;
        let mut top = votes.into_iter().filter(|(_, count)| *count == most);
        match (top.next(), top.next()) {
            (Some((class, _)), None) => Some(class),
            _ => None,
        }
    }

    /// The class of a join line's "breed : N".
    pub fn class_of_breed(breed: &str) -> Option<&'static str> {
        BREEDS.iter().find(|(id, _)| *id == breed).map(|(_, class)| *class)
    }

    pub fn class_icon(&self, hero_class: Option<&str>) -> Value {
        hero_class.and_then(|c| self.class_icons.get(c)).cloned().unwrap_or(Value::Null)
    }
}
