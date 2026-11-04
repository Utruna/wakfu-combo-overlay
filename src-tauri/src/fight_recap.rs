//! Records each fight for the "Récap des combats" window: every fighter's
//! turns, the spells cast in them and the hits each spell landed, plus heals,
//! armour and damage taken. Fed by the turn tracker (which already sorts out
//! turns, summons, friendly fire and multi-client copies); kept in memory for
//! the session.
//!
//! What the log can't say is filled in the tracker's way: a hit counts for
//! whoever owns the turn, and goes to the spell named in its line when that
//! spell was cast this turn ("-3 230 PV (Feu) (Fléau magmatique)"), else to
//! the turn's last spell — or to "others" (poisons, start-of-turn effects…)
//! when its line names something that wasn't cast this turn.
//!
//! Heals and armour go to their caster's spells the same way, with two
//! exceptions, since many land outside their caster's turn: lifesteal
//! ("Neutre - Vol de vie") is the healed fighter's own, and a heal or armour
//! named after an effect (an Eniripsa's "Marque Husse", "Radiance", a Sram's
//! "Assassin"…) goes to whoever that effect belongs to — the ally whose turn
//! it first showed up in. Armour given while no ally plays, by nothing named,
//! is the receiver's own (a passive).

use regex::Regex;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use crate::catalog::Catalog;
use crate::log_reader::now_ms;
use crate::matcher::find_hero_index;
use crate::settings::SettingsStore;

/// Fights kept for the session, oldest dropped first.
const MAX_FIGHTS: usize = 30;

pub const ELEMENTS: [&str; 7] = ["Feu", "Eau", "Terre", "Air", "Neutre", "Lumière", "Stasis"];

static PARENTHESES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\(([^()]*)\)").expect("valid regex"));

/// What a damage or heal line says after the amount: "(Feu) (Parade !) (Ponction)".
#[derive(Debug, Default, PartialEq, Eq)]
pub struct EffectTags {
    /// The first element named, if any.
    pub element: Option<String>,
    /// What caused it, when named (a spell, "Ponction", "Début de tour"…).
    pub source: Option<String>,
    /// "(Neutre - Vol de vie)": the healed fighter drained it.
    pub lifesteal: bool,
}

pub fn parse_tags(rest: &str) -> EffectTags {
    let mut tags = EffectTags::default();
    for group in PARENTHESES.captures_iter(rest) {
        let text = group[1].trim();
        // "Neutre - Vol de vie": the element is the first word.
        let word = text.split(" - ").next().unwrap_or(text).trim();
        if text.ends_with("Vol de vie") {
            tags.lifesteal = true;
        }
        if ELEMENTS.contains(&word) {
            if tags.element.is_none() {
                tags.element = Some(word.to_string());
            }
        } else if !text.is_empty() && text != "Parade !" {
            tags.source = Some(text.to_string());
        }
    }
    tags
}

#[derive(Debug, Clone)]
struct Hit {
    amount: u64,
    element: Option<String>,
    target: String,
}

#[derive(Debug, Clone)]
struct SpellCast {
    name: String,
    crit: bool,
    /// Who cast it: the fighter, or one of its summons.
    caster: String,
    /// For a summon's cast: the spell that brought it in (icon fallback).
    summoning_spell: Option<String>,
    hits: Vec<Hit>,
    heals: Vec<Hit>,
    /// Armour given.
    shields: Vec<Hit>,
}

#[derive(Debug, Clone)]
struct TurnRecord {
    turn_id: u64,
    spells: Vec<SpellCast>,
    /// Damage not tied to a spell of this turn, by what caused it.
    others: Vec<(String, u64)>,
    /// Same for heals, and armour.
    heal_others: Vec<(String, u64)>,
    shield_others: Vec<(String, u64)>,
}

#[derive(Debug, Clone, Default)]
struct FighterRecord {
    turns: Vec<TurnRecord>,
    /// Heals of this fighter landing outside its turns (lifesteal, marks…),
    /// by what caused them.
    heal_outside: Vec<(String, u64)>,
    /// Same for the armour it gave.
    shield_outside: Vec<(String, u64)>,
    taken: u64,
}

/// What an ally gives the others: heals, or armour.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Support {
    Heal,
    Armor,
}

fn add_to(list: &mut Vec<(String, u64)>, label: String, amount: u64) {
    match list.iter_mut().find(|(l, _)| *l == label) {
        Some((_, total)) => *total += amount,
        None => list.push((label, amount)),
    }
}

impl FighterRecord {
    fn turn_mut(&mut self, turn_id: u64) -> &mut TurnRecord {
        if self.turns.last().is_none_or(|t| t.turn_id != turn_id) {
            self.turns.push(TurnRecord {
                turn_id,
                spells: Vec::new(),
                others: Vec::new(),
                heal_others: Vec::new(),
                shield_others: Vec::new(),
            });
        }
        self.turns.last_mut().expect("just pushed")
    }

    /// The turn being played, if it's this fighter's.
    fn open_turn(&mut self, turn_id: u64) -> Option<&mut TurnRecord> {
        self.turns.last_mut().filter(|t| t.turn_id == turn_id)
    }
}

#[derive(Debug, Clone)]
struct FightRecord {
    id: u64,
    started_at: i64,
    ended_at: Option<i64>,
    /// The log's own "HH:MM:SS" stamps (ms since midnight) of the fight's
    /// first and last lines — the fight's real times even when the log is
    /// read late.
    started_clock: Option<i64>,
    ended_clock: Option<i64>,
    /// Earned XP at the end: a won fight.
    victory: bool,
    /// Players announced as joining (allies): name -> their join line's
    /// "breed" (the class id).
    allies: HashMap<String, String>,
    /// Players the log wrote XP for at the end. The game only writes it for
    /// the characters of the client(s) writing the log: these are the user's
    /// own, the other players of the group never get one.
    local: HashSet<String>,
    /// In order of first appearance.
    fighters: Vec<(String, FighterRecord)>,
    /// Who the allies hit, and how hard: the fight's opponents.
    foes: HashMap<String, u64>,
    /// Effect name ("Marque Husse") -> the ally it belongs to.
    effect_owners: HashMap<String, String>,
}

impl FightRecord {
    fn fighter_mut(&mut self, name: &str) -> &mut FighterRecord {
        let index = match self.fighters.iter().position(|(n, _)| n == name) {
            Some(index) => index,
            None => {
                self.fighters.push((name.to_string(), FighterRecord::default()));
                self.fighters.len() - 1
            }
        };
        &mut self.fighters[index].1
    }
}

#[derive(Default)]
pub struct FightRecorder {
    /// The stamp of the line being processed (see `set_clock`).
    clock: Option<i64>,
    current: Option<FightRecord>,
    history: Vec<FightRecord>,
    next_id: u64,
    /// Fights finished since the recap last showed them.
    unseen: HashSet<u64>,
    /// Something worth redrawing the recap for happened.
    changed: bool,
}

impl FightRecorder {
    /// The log stamp of the line about to be processed.
    pub fn set_clock(&mut self, ms_since_midnight: Option<i64>) {
        if ms_since_midnight.is_some() {
            self.clock = ms_since_midnight;
        }
    }

    fn fight(&mut self) -> &mut FightRecord {
        let clock = self.clock;
        if self.current.is_none() {
            self.next_id += 1;
            self.current = Some(FightRecord {
                id: self.next_id,
                started_at: now_ms(),
                ended_at: None,
                started_clock: clock,
                ended_clock: None,
                victory: false,
                allies: HashMap::new(),
                local: HashSet::new(),
                fighters: Vec::new(),
                foes: HashMap::new(),
                effect_owners: HashMap::new(),
            });
        }
        let fight = self.current.as_mut().expect("just set");
        fight.ended_clock = clock;
        fight
    }

    /// A new fight id showed up: whatever was open is over.
    pub fn start(&mut self) {
        self.finish();
        self.fight();
    }

    pub fn add_ally(&mut self, name: &str, breed: &str) {
        self.fight().allies.insert(name.to_string(), breed.to_string());
    }

    pub fn cast(&mut self, fighter: &str, turn_id: u64, caster: &str, spell: &str, crit: bool, summoning_spell: Option<String>) {
        self.fight().fighter_mut(fighter).turn_mut(turn_id).spells.push(SpellCast {
            name: spell.to_string(),
            crit,
            caster: caster.to_string(),
            summoning_spell,
            hits: Vec::new(),
            heals: Vec::new(),
            shields: Vec::new(),
        });
        self.changed = true;
    }

    pub fn hit(&mut self, fighter: &str, turn_id: u64, target: &str, amount: u64, tags: EffectTags, target_is_foe: bool) {
        let fight = self.fight();
        if target_is_foe {
            *fight.foes.entry(target.to_string()).or_insert(0) += amount;
        }
        let turn = fight.fighter_mut(fighter).turn_mut(turn_id);
        let hit = Hit { amount, element: tags.element, target: target.to_string() };
        let spell_index = match &tags.source {
            // Named after a spell of this turn: that one (its latest cast).
            Some(source) => turn.spells.iter().rposition(|s| &s.name == source),
            None => turn.spells.len().checked_sub(1),
        };
        match spell_index {
            Some(index) => turn.spells[index].hits.push(hit),
            None => add_to(&mut turn.others, tags.source.unwrap_or_else(|| "Autres".to_string()), amount),
        }
        self.changed = true;
    }

    /// Any effect named in a line during an ally's turn ("Lueur Etherique:
    /// 1 PM (Marque unt)") belongs to that ally, unless already claimed.
    pub fn observe_effect(&mut self, effect: &str, ally_turn_owner: &str) {
        if let Some(fight) = self.current.as_mut() {
            fight.effect_owners.entry(effect.to_string()).or_insert_with(|| ally_turn_owner.to_string());
        }
    }

    /// An ally healed. `turn`: the ally playing, if one is, with its turn id.
    /// Returns the healer it was credited to (None: nobody, or an overheal).
    pub fn heal(&mut self, turn: Option<(&str, u64)>, healed: &str, target: &str, amount: u64, tags: EffectTags) -> Option<String> {
        self.support(Support::Heal, turn, healed, target, amount, tags)
    }

    /// An ally gained armour: it goes to whoever gave it, returned.
    pub fn armor(&mut self, turn: Option<(&str, u64)>, gainer: &str, target: &str, amount: u64, tags: EffectTags) -> Option<String> {
        self.support(Support::Armor, turn, gainer, target, amount, tags)
    }

    fn support(
        &mut self,
        kind: Support,
        turn: Option<(&str, u64)>,
        healed: &str,
        target: &str,
        amount: u64,
        tags: EffectTags,
    ) -> Option<String> {
        if amount == 0 {
            return None; // overheal
        }
        let fight = self.fight();
        let casts_this_turn = |fight: &mut FightRecord, source: &str| {
            turn.is_some_and(|(owner, id)| {
                fight.fighter_mut(owner).open_turn(id).is_some_and(|t| t.spells.iter().any(|s| s.name == source))
            })
        };
        let healer = if tags.lifesteal {
            Some(healed.to_string())
        } else {
            match &tags.source {
                Some(source) if !casts_this_turn(fight, source) => {
                    fight.effect_owners.get(source).cloned().or_else(|| turn.map(|(owner, _)| owner.to_string()))
                }
                _ => turn.map(|(owner, _)| owner.to_string()),
            }
        };
        // Armour while no ally plays, from nothing named: the gainer's own.
        let healer = healer.or_else(|| (kind == Support::Armor).then(|| healed.to_string()));
        let healer = healer?;
        let hit = Hit { amount, element: tags.element, target: target.to_string() };
        let label = tags.source.clone().unwrap_or_else(|| {
            match kind {
                Support::Armor => "Armure",
                Support::Heal if tags.lifesteal => "Vol de vie",
                Support::Heal => "Soins",
            }
            .to_string()
        });
        let open = turn.filter(|(owner, _)| *owner == healer).map(|(_, id)| id);
        let record = fight.fighter_mut(&healer);
        match open.and_then(|id| record.open_turn(id)) {
            Some(turn) => {
                let spell_index = match &tags.source {
                    Some(source) => turn.spells.iter().rposition(|s| &s.name == source),
                    None => turn.spells.len().checked_sub(1),
                };
                match (spell_index, kind) {
                    (Some(index), Support::Heal) => turn.spells[index].heals.push(hit),
                    (Some(index), Support::Armor) => turn.spells[index].shields.push(hit),
                    (None, Support::Heal) => add_to(&mut turn.heal_others, label, amount),
                    (None, Support::Armor) => add_to(&mut turn.shield_others, label, amount),
                }
            }
            None => match kind {
                Support::Heal => add_to(&mut record.heal_outside, label, amount),
                Support::Armor => add_to(&mut record.shield_outside, label, amount),
            },
        }
        self.changed = true;
        Some(healer)
    }

    pub fn taken(&mut self, fighter: &str, amount: u64) {
        self.fight().fighter_mut(fighter).taken += amount;
    }

    /// XP earned at the end: a won fight. `player`: whom it was for, when the
    /// line names them — one of the user's own characters.
    pub fn victory(&mut self, player: Option<&str>) {
        if let Some(fight) = self.current.as_mut() {
            fight.victory = true;
            if let Some(player) = player {
                fight.local.insert(player.to_string());
            }
        }
    }

    pub fn finish(&mut self) {
        let clock = self.clock;
        let Some(mut fight) = self.current.take() else { return };
        // A fight where nobody did anything (a join line, then nothing) isn't one.
        if fight.fighters.iter().all(|(_, f)| f.turns.is_empty()) {
            return;
        }
        fight.ended_at = Some(now_ms());
        fight.ended_clock = clock.or(fight.ended_clock);
        self.unseen.insert(fight.id);
        self.history.push(fight);
        if self.history.len() > MAX_FIGHTS {
            let dropped = self.history.remove(0);
            self.unseen.remove(&dropped.id);
        }
        self.changed = true;
    }

    /// Whether the recap needs redrawing since last asked (then clears it).
    pub fn take_changed(&mut self) -> bool {
        std::mem::take(&mut self.changed)
    }

    pub fn has_unseen(&self) -> bool {
        !self.unseen.is_empty()
    }

    pub fn mark_seen(&mut self, id: u64) {
        self.unseen.remove(&id);
    }

    /// Drops a finished fight from the recap (the one being played stays).
    pub fn delete(&mut self, id: u64) -> bool {
        let Some(index) = self.history.iter().position(|f| f.id == id) else { return false };
        self.history.remove(index);
        self.unseen.remove(&id);
        self.changed = true;
        true
    }

    /// Every fight of the session, newest first (the one being played, if
    /// any, at the top), for ui/recap.
    pub fn to_json(&self, settings: &SettingsStore, catalog: &Catalog) -> Value {
        let heroes = settings.heroes();
        let fights: Vec<Value> = self
            .current
            .iter()
            .chain(self.history.iter().rev())
            .map(|fight| {
                let fighters: Vec<Value> = fight
                    .fighters
                    .iter()
                    .filter_map(|(name, record)| {
                        let hero = find_hero_index(name, heroes).map(|i| &heroes[i]);
                        // Monsters stay out: the recap is about the group.
                        if hero.is_none() && !fight.allies.contains_key(name) {
                            return None;
                        }
                        let set_class = hero.and_then(|h| h.get("class")).and_then(Value::as_str);
                        // Not configured: worked out from its own casts, else its breed.
                        let guessed = set_class.is_none().then(|| {
                            let own_casts = record.turns.iter().flat_map(|t| &t.spells).filter(|s| s.caster == *name);
                            catalog
                                .class_of_spells(own_casts.map(|s| s.name.as_str()))
                                .or_else(|| fight.allies.get(name).and_then(|breed| Catalog::class_of_breed(breed)))
                        });
                        let class = set_class.or(guessed.flatten());
                        Some(json!({
                            "name": name,
                            "hero": hero.is_some(),
                            "local": fight.local.contains(name),
                            "class": class,
                            "classGuessed": set_class.is_none() && class.is_some(),
                            "classIcon": catalog.class_icon(class),
                            "color": hero.and_then(|h| h.get("color")),
                            "healOutside": labelled_json(&record.heal_outside),
                            "shieldOutside": labelled_json(&record.shield_outside),
                            "taken": record.taken,
                            "turns": record.turns.iter().map(|turn| json!({
                                "turnId": turn.turn_id,
                                "spells": turn.spells.iter().map(|spell| json!({
                                    "name": spell.name,
                                    "crit": spell.crit,
                                    "summon": spell.caster != *name,
                                    "icon": catalog.spell_icon(class, &spell.name).or_else(|| {
                                        catalog.spell_icon(class, spell.summoning_spell.as_deref()?)
                                    }),
                                    "hits": hits_json(&spell.hits),
                                    "heals": hits_json(&spell.heals),
                                    "shields": hits_json(&spell.shields),
                                })).collect::<Vec<_>>(),
                                "others": labelled_json(&turn.others),
                                "healOthers": labelled_json(&turn.heal_others),
                                "shieldOthers": labelled_json(&turn.shield_others),
                            })).collect::<Vec<_>>(),
                        }))
                    })
                    .collect();
                let mut foes: Vec<(&String, &u64)> = fight.foes.iter().collect();
                foes.sort_by(|a, b| b.1.cmp(a.1));
                json!({
                    "id": fight.id,
                    "live": fight.ended_at.is_none(),
                    "startedAt": fight.started_at,
                    "endedAt": fight.ended_at,
                    "startedClock": fight.started_clock,
                    "endedClock": fight.ended_clock,
                    "victory": fight.victory,
                    "foes": foes.iter().map(|(name, _)| name).collect::<Vec<_>>(),
                    "isNew": self.unseen.contains(&fight.id),
                    "fighters": fighters,
                })
            })
            .collect();
        json!({ "fights": fights })
    }
}

fn hits_json(hits: &[Hit]) -> Vec<Value> {
    hits.iter().map(|hit| json!({ "amount": hit.amount, "element": hit.element, "target": hit.target })).collect()
}

fn labelled_json(list: &[(String, u64)]) -> Vec<Value> {
    list.iter().map(|(label, amount)| json!({ "label": label, "amount": amount })).collect()
}
