//! Splits Wakfu's combat feed into turns and sums the damage dealt during each.
//!
//! The log never says who dealt a hit — a damage line only names the target
//! ("Kamarachnide: -1 258 PV (Feu)"). So every hit is credited to whoever owns
//! the turn that is open when it lands. That is also what makes delayed damage
//! work: a Roublard's bombs exploding on "Détonation", a trap, a "Hémorragie"
//! tick… all land while their owner's turn is still open.
//!
//! Turn boundaries, as observed in the logs:
//!   - opens on the first spell cast by a fighter (no event marks a turn start);
//!   - closes on "N secondes reportées pour le tour suivant." — written when a
//!     player ends their turn, before the next fighter's start-of-turn effects
//!     (so those aren't credited to the wrong turn), or "X: Passe son tour";
//!   - closes when a different fighter casts — the fallback for monsters and
//!     summons, which never get the "secondes reportées" line;
//!   - closes when the fight ends.
//!
//! Friendly fire (a bomb blast catching an ally, the caster itself…) is left
//! out. Allies are the non-AI fighters announced by the "[_FL_] … join the
//! fight" lines, anything they summon, and whatever `is_ally` recognizes (the
//! configured heroes — covers starting the app in the middle of a fight, when
//! the join lines were already past).
//!
//! Summons count for whoever summoned them: they are allies (no friendly fire
//! on them), and a summon playing right after its summoner — which is what
//! they do (Osamodas creatures, Double Sram, Dark Lapino…) — carries on that
//! summoner's turn instead of opening one of its own, so its damage lands in
//! the same total. Most summons are named on the spot ("X: Invoque un(e)
//! Gobgob"); an Osamodas creature isn't ("X: Invoque une créature du Gobgob"),
//! its name only comes on the "[_FL_] … join the fight" line right after.
//!
//! Several local clients in the same fight each write the whole combat feed
//! to the shared log, so every line shows up once per client, the copies
//! < 300 ms apart (measured: none between 300 and 500 ms, the next ones are
//! genuine recasts). That count of clients is read off the casts — the same
//! spell can't be recast that fast — and then only one in every `copies`
//! identical lines within the window is kept. Counting instead of dropping
//! every repeat keeps a hit legitimately logged twice (an Huppermage spell
//! hitting with two elements prints two identical lines) at its true weight.

use regex::Regex;
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use crate::fight_recap::{parse_tags, FightRecorder};

fn re(pattern: &str) -> Regex {
    Regex::new(pattern).expect("valid regex")
}

static COMBAT_PREFIX: LazyLock<Regex> = LazyLock::new(|| re(r"\[Information\s+\(combat\)\]\s+(.*?)\s*$"));
pub static CAST: LazyLock<Regex> = LazyLock::new(|| re(r"^(.+?)\s+lance\s+le\s+sort\s+(.+?)(?:\s*\(|$)"));
// "-1 375 PV" — thousands are grouped with a space (\s also covers the no-break ones).
static DAMAGE: LazyLock<Regex> = LazyLock::new(|| re(r"^(.+?):\s+-([0-9][0-9\s]*)\s+PV\b(.*)$"));
static HEAL: LazyLock<Regex> = LazyLock::new(|| re(r"^(.+?):\s+\+([0-9][0-9\s]*)\s+PV\b(.*)$"));
static ARMOR: LazyLock<Regex> = LazyLock::new(|| re(r"^(.+?):\s+([0-9][0-9\s]*)\s+Armure\b(.*)$"));
static CRITICAL: LazyLock<Regex> = LazyLock::new(|| re(r"\(Critiques\)\s*$"));
// Written for each player just before a won fight ends.
static XP_GAINED: LazyLock<Regex> = LazyLock::new(|| re(r"points\s+d'XP"));
static INVOKE: LazyLock<Regex> = LazyLock::new(|| re(r"^(.+?):\s+Invoque\s+(?:un\(e\)\s+(.+?)\s*$)?"));
static TURN_END: LazyLock<Regex> = LazyLock::new(|| {
    re(r"secondes\s+report[ée]es\s+pour\s+le\s+tour\s+suivant|^[^:]+:\s+Passe\s+son\s+tour")
});
static COMBAT_END: LazyLock<Regex> = LazyLock::new(|| re(r"^Combat\s+termin[ée]"));
static FIGHTER_JOIN: LazyLock<Regex> = LazyLock::new(|| {
    re(r"\[_FL_\]\s+fightId=([0-9]+)\s+(.+?)\s+breed\s*:\s*([0-9]+).*?isControlledByAI=(true|false)")
});
static FIGHT_END: LazyLock<Regex> = LazyLock::new(|| re(r"\[FIGHT\]\s+End\s+fight"));
static LOG_TIME: LazyLock<Regex> = LazyLock::new(|| re(r"([0-9]{2}):([0-9]{2}):([0-9]{2}),([0-9]{3})"));

// The training dummy ("Poutch", logged "Sac à patates"): players summon it
// themselves to hit it, so it is always a target, never a pet.
const TARGET_DUMMY_BREEDS: [&str; 1] = ["2335"];

const COPY_WINDOW_MS: i64 = 400;
// Copies of a cast arrive mostly < 150 ms apart; a genuine quick recast (an
// Iop's "Rafale" was seen 337 ms after the previous one) never does. Only
// that tight a repeat counts as proof of another client.
const CAST_COPY_PROOF_MS: i64 = 150;
// Housekeeping only: past this many tracked line groups, expired ones are swept.
const MAX_GROUPS: usize = 500;

/// "1 375" (thousands grouped with any kind of space) -> 1375.
fn parse_amount(text: &str) -> u64 {
    text.chars().filter(char::is_ascii_digit).collect::<String>().parse().unwrap_or(0)
}

/// Milliseconds since midnight from the "HH:MM:SS,mmm" stamp, or None.
fn log_time_ms(line: &str) -> Option<i64> {
    let c = LOG_TIME.captures(line)?;
    let n = |i: usize| c[i].parse::<i64>().unwrap_or(0);
    Some(((n(1) * 60 + n(2)) * 60 + n(3)) * 1000 + n(4))
}

/// Midnight rollover (or a clock jump back) counts as expired too.
fn expired(at: i64, now: i64) -> bool {
    now < at || now - at > COPY_WINDOW_MS
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TurnUpdateKind {
    Start,
    Damage,
    /// A heal or armour given by the fighter playing.
    Support,
    End,
}

/// What an ally gives: heals, or armour.
#[derive(Debug, Clone, Copy)]
enum Support {
    Heal,
    Armor,
}

#[derive(Debug, Clone)]
pub struct TurnUpdate {
    pub kind: TurnUpdateKind,
    pub character_name: String,
    pub turn_id: u64,
    pub total: u64,
    /// Everything this fighter has dealt since the fight started.
    pub fight_total: u64,
    /// The hit's amount, on `Damage` updates only.
    pub amount: Option<u64>,
    /// Heals and armour this fighter gave, this turn and since the fight
    /// started (see FightRecorder::heal for who gets them).
    pub heal: u64,
    pub fight_heal: u64,
    pub armor: u64,
    pub fight_armor: u64,
}

#[derive(Debug, Clone)]
struct Turn {
    character_name: String,
    turn_id: u64,
    total: u64,
    heal: u64,
    armor: u64,
}

#[derive(Debug, Clone)]
struct Summon {
    owner: String,
    /// The spell its summoner cast to bring it in.
    spell: Option<String>,
    breed: Option<String>,
}

struct CastGroup {
    at: i64,
    count: u32,
    proven_copies: u32,
}

struct LineGroup {
    at: i64,
    count: u32,
}

pub struct CombatTurnTracker {
    fight_id: Option<String>,
    allies: HashSet<String>,
    turn: Option<Turn>,
    /// The turn just closed, which its summoner's summons may carry on.
    last_turn: Option<Turn>,
    next_turn_id: u64,
    summons: HashMap<String, Summon>,
    /// Fighter -> last spell cast.
    last_spell: HashMap<String, String>,
    /// A summon waiting for the creature's name (Osamodas).
    pending_summon: Option<Summon>,
    /// Breeds that are targets even when summoned.
    enemy_breeds: HashSet<String>,
    /// Fighter -> damage dealt this fight (summons count for their summoner).
    fight_totals: HashMap<String, u64>,
    fight_heals: HashMap<String, u64>,
    fight_armor: HashMap<String, u64>,
    /// Clients currently writing the feed.
    copies: u32,
    /// Cast message -> group, in insertion order (the order matters when
    /// expired groups are swept, see `is_extra_copy`).
    cast_groups: Vec<(String, CastGroup)>,
    /// Last cast seen with fewer copies than expected.
    lone_cast: Option<String>,
    /// Any combat message -> group.
    line_groups: HashMap<String, LineGroup>,
    /// What the "Récap des combats" window shows.
    pub recorder: FightRecorder,
}

impl Default for CombatTurnTracker {
    fn default() -> Self {
        Self::new()
    }
}

impl CombatTurnTracker {
    pub fn new() -> Self {
        Self {
            fight_id: None,
            allies: HashSet::new(),
            turn: None,
            last_turn: None,
            next_turn_id: 1,
            summons: HashMap::new(),
            last_spell: HashMap::new(),
            pending_summon: None,
            enemy_breeds: Self::default_enemy_breeds(),
            fight_totals: HashMap::new(),
            fight_heals: HashMap::new(),
            fight_armor: HashMap::new(),
            copies: 1,
            cast_groups: Vec::new(),
            lone_cast: None,
            line_groups: HashMap::new(),
            recorder: FightRecorder::default(),
        }
    }

    fn default_enemy_breeds() -> HashSet<String> {
        TARGET_DUMMY_BREEDS.iter().map(|b| b.to_string()).collect()
    }

    /// The turn being played, if any — the overlay replays the class icon's
    /// entrance on the first cast of each turn.
    pub fn current_turn_id(&self) -> Option<u64> {
        self.turn.as_ref().map(|turn| turn.turn_id)
    }

    /// How many clients the feed currently looks duplicated by.
    pub fn copies(&self) -> u32 {
        self.copies
    }

    /// Feed one raw wakfu.log line (any line — non-combat ones are mostly
    /// ignored). `is_ally` names extra allies on top of the ones read from the
    /// log (the configured heroes).
    pub fn process_line(&mut self, line: &str, is_ally: &dyn Fn(&str) -> bool) -> Vec<TurnUpdate> {
        let mut out = Vec::new();
        self.recorder.set_clock(log_time_ms(line));

        if let Some(join) = FIGHTER_JOIN.captures(line) {
            let fight_id = &join[1];
            let name = join[2].trim().to_string();
            let breed = join[3].to_string();
            let ai_controlled = &join[4] == "true";
            if self.fight_id.as_deref() != Some(fight_id) {
                self.fight_id = Some(fight_id.to_string());
                self.forget_fighters();
                self.recorder.start();
            }
            let pending = self.pending_summon.take();
            if !ai_controlled {
                self.recorder.add_ally(&name);
                self.allies.insert(name);
            } else {
                let summoned_by_ally = pending.as_ref().is_some_and(|p| self.is_ally_fighter(&p.owner, is_ally));
                if !summoned_by_ally {
                    // The other side — a creature an ally then summons with
                    // the same breed is a target, not a pet (training dummies:
                    // a player summoning "Sac à patates" to hit them).
                    self.enemy_breeds.insert(breed.clone());
                }
                if let Some(p) = pending {
                    self.add_summon(name, Summon { breed: Some(breed), ..p });
                }
            }
            return out;
        }
        if FIGHT_END.is_match(line) {
            self.end_fight(&mut out);
            return out;
        }

        let Some(combat) = COMBAT_PREFIX.captures(line) else {
            return out;
        };
        let message = combat.get(1).map_or("", |m| m.as_str());
        if self.is_extra_copy(message, log_time_ms(line)) {
            return out;
        }
        // The creature's join line comes right after its summon line.
        self.pending_summon = None;

        if COMBAT_END.is_match(message) {
            self.end_fight(&mut out);
            return out;
        }
        if TURN_END.is_match(message) {
            self.close_turn(&mut out);
            return out;
        }
        if XP_GAINED.is_match(message) {
            self.recorder.victory();
            return out;
        }

        if let Some(cast) = CAST.captures(message) {
            let caster = cast[1].trim().to_string();
            let spell = cast[2].trim().to_string();
            self.last_spell.insert(caster.clone(), spell.clone());
            let actor = self.owner_of(&caster).unwrap_or_else(|| caster.clone());
            if !self.turn.as_ref().is_some_and(|t| t.character_name == actor) {
                self.close_turn(&mut out);
                let carried = self.last_turn.take().filter(|t| actor != caster && t.character_name == actor);
                self.turn = Some(match carried {
                    // A summon playing right after its summoner: same turn, same total.
                    Some(turn) => turn,
                    None => {
                        let turn_id = self.next_turn_id;
                        self.next_turn_id += 1;
                        Turn { character_name: actor.clone(), turn_id, total: 0, heal: 0, armor: 0 }
                    }
                });
                self.emit(&mut out, TurnUpdateKind::Start, None);
            }
            let turn_id = self.turn.as_ref().map_or(0, |t| t.turn_id);
            let summoning_spell = self.summoning_spell_of(&caster);
            let crit = CRITICAL.is_match(message);
            self.recorder.cast(&actor, turn_id, &caster, &spell, crit, summoning_spell);
            return out;
        }

        if let Some(invoke) = INVOKE.captures(message) {
            let owner = invoke[1].trim().to_string();
            let summon = Summon {
                spell: self.last_spell.get(&owner).cloned(),
                owner,
                breed: None,
            };
            if let Some(named) = invoke.get(2) {
                self.add_summon(named.as_str().trim().to_string(), summon.clone());
            }
            // Named or not, the creature's join line follows: an Osamodas
            // creature is only named there.
            self.pending_summon = Some(summon);
            return out;
        }

        if let Some(damage) = DAMAGE.captures(message) {
            let target = damage[1].trim();
            let amount = parse_amount(&damage[2]);
            if amount == 0 {
                return out;
            }
            let turn_owner = self.turn.as_ref().map(|t| t.character_name.clone());
            let owner_is_ally = turn_owner.as_deref().is_some_and(|owner| self.is_ally(owner, is_ally));
            let target_is_ally = self.is_ally(target, is_ally);
            // Taken from the other side (a monster's turn, or a delayed hit
            // landing between turns) — not an ally's own friendly fire.
            if target_is_ally && !owner_is_ally {
                let hurt = self.owner_of(target).unwrap_or_else(|| target.to_string());
                self.recorder.taken(&hurt, amount);
            }
            let Some(turn_owner) = turn_owner else {
                return out;
            };
            // Friendly fire only counts against allies hitting allies; a
            // monster hurting a player is that monster's damage.
            if owner_is_ally && target_is_ally {
                return out;
            }
            let turn_id = self.turn.as_ref().map_or(0, |t| t.turn_id);
            self.recorder.hit(&turn_owner, turn_id, target, amount, parse_tags(&damage[3]), owner_is_ally);
            if let Some(turn) = self.turn.as_mut() {
                turn.total += amount;
            }
            *self.fight_totals.entry(turn_owner).or_insert(0) += amount;
            self.emit(&mut out, TurnUpdateKind::Damage, Some(amount));
            return out;
        }

        // Effects named during an ally's turn are that ally's (see FightRecorder::heal).
        let ally_turn = self
            .turn
            .as_ref()
            .filter(|t| self.is_ally(&t.character_name, is_ally))
            .map(|t| (t.character_name.clone(), t.turn_id));
        if let Some((owner, _)) = &ally_turn {
            if let Some(effect) = parse_tags(message).source {
                self.recorder.observe_effect(&effect, owner);
            }
        }

        if let Some(heal) = HEAL.captures(message) {
            // Allies healed (not a monster healed by a bounce).
            let target = heal[1].trim();
            if self.is_ally(target, is_ally) {
                let healed = self.owner_of(target).unwrap_or_else(|| target.to_string());
                let turn = ally_turn.as_ref().map(|(owner, id)| (owner.as_str(), *id));
                let amount = parse_amount(&heal[2]);
                if let Some(healer) = self.recorder.heal(turn, &healed, target, amount, parse_tags(&heal[3])) {
                    self.add_support(&mut out, Support::Heal, &healer, amount);
                }
            }
            return out;
        }

        if let Some(armor) = ARMOR.captures(message) {
            let target = armor[1].trim();
            if self.is_ally(target, is_ally) {
                let gainer = self.owner_of(target).unwrap_or_else(|| target.to_string());
                let turn = ally_turn.as_ref().map(|(owner, id)| (owner.as_str(), *id));
                let amount = parse_amount(&armor[2]);
                if let Some(giver) = self.recorder.armor(turn, &gainer, target, amount, parse_tags(&armor[3])) {
                    self.add_support(&mut out, Support::Armor, &giver, amount);
                }
            }
        }
        out
    }

    pub fn is_ally(&self, name: &str, is_ally: &dyn Fn(&str) -> bool) -> bool {
        if self.is_ally_fighter(name, is_ally) {
            return true;
        }
        self.owner_of(name).is_some_and(|owner| self.is_ally_fighter(&owner, is_ally))
    }

    /// The fighter at the top of a summon chain (a summon's summon…), or None
    /// if not a summon. Names aren't unique: a summon sharing an enemy's breed
    /// (a training dummy) is not treated as one, or that enemy's own casts and
    /// hits would be taken for the summoner's.
    pub fn owner_of(&self, name: &str) -> Option<String> {
        let mut owner: Option<&str> = None;
        let mut seen: HashSet<&str> = HashSet::new();
        let mut current = self.summon_of(name);
        while let Some(s) = current {
            if !seen.insert(s.owner.as_str()) {
                break;
            }
            owner = Some(s.owner.as_str());
            current = self.summon_of(&s.owner);
        }
        owner.map(str::to_string)
    }

    /// The spell its summoner cast to bring it in (e.g. "Invocation", "Double").
    pub fn summoning_spell_of(&self, name: &str) -> Option<String> {
        self.summon_of(name).and_then(|s| s.spell.clone())
    }

    // ── Private ──────────────────────────────────────────────────────────

    /// True for a line that is just another client's copy of one already seen.
    fn is_extra_copy(&mut self, message: &str, now: Option<i64>) -> bool {
        let Some(now) = now else { return false };

        // Raising takes a tight repeat (below). Lowering takes two different
        // casts in a row that no other client echoed within the window: a
        // lagging client's copy can come 0.5–0.8 s late, and it then looks
        // like a lone cast followed by a lone cast of the same spell.
        let mut i = 0;
        while i < self.cast_groups.len() {
            if !expired(self.cast_groups[i].1.at, now) {
                i += 1;
                continue;
            }
            let (key, group) = self.cast_groups.remove(i);
            if group.count >= self.copies {
                self.lone_cast = None;
            } else if self.lone_cast.as_ref().is_some_and(|lone| *lone != key) {
                self.copies = group.count;
                self.lone_cast = None;
            } else {
                self.lone_cast = Some(key);
            }
        }
        if CAST.is_match(message) {
            let index = match self.cast_groups.iter().position(|(key, _)| key == message) {
                Some(index) => index,
                None => {
                    self.cast_groups.push((message.to_string(), CastGroup { at: now, count: 0, proven_copies: 0 }));
                    self.cast_groups.len() - 1
                }
            };
            let group = &mut self.cast_groups[index].1;
            group.count += 1;
            if now - group.at <= CAST_COPY_PROOF_MS {
                group.proven_copies += 1;
            }
            self.copies = self.copies.max(group.proven_copies);
        }

        if self.line_groups.len() > MAX_GROUPS {
            self.line_groups.retain(|_, group| !expired(group.at, now));
        }
        let group = self
            .line_groups
            .entry(message.to_string())
            .or_insert(LineGroup { at: now, count: 0 });
        if expired(group.at, now) {
            *group = LineGroup { at: now, count: 0 };
        }
        group.count += 1;
        (group.count - 1) % self.copies != 0
    }

    /// A player (or configured hero) in its own right, summons aside.
    fn is_ally_fighter(&self, name: &str, is_ally: &dyn Fn(&str) -> bool) -> bool {
        self.allies.contains(name) || is_ally(name)
    }

    fn summon_of(&self, name: &str) -> Option<&Summon> {
        self.summons
            .get(name)
            .filter(|s| !s.breed.as_ref().is_some_and(|b| self.enemy_breeds.contains(b)))
    }

    fn add_summon(&mut self, name: String, summon: Summon) {
        // A monster duplicating itself isn't a summon chain.
        if name != summon.owner {
            self.summons.insert(name, summon);
        }
    }

    fn close_turn(&mut self, out: &mut Vec<TurnUpdate>) {
        if self.turn.is_none() {
            return;
        }
        self.emit(out, TurnUpdateKind::End, None);
        self.last_turn = self.turn.take();
    }

    fn forget_fighters(&mut self) {
        self.allies.clear();
        self.summons.clear();
        self.last_spell.clear();
        self.pending_summon = None;
        self.last_turn = None;
        self.enemy_breeds = Self::default_enemy_breeds();
        self.fight_totals.clear();
        self.fight_heals.clear();
        self.fight_armor.clear();
    }

    /// A heal or armour credited to `giver`: its fight total, and the turn's
    /// counter when it's the one playing.
    fn add_support(&mut self, out: &mut Vec<TurnUpdate>, kind: Support, giver: &str, amount: u64) {
        let fight = match kind {
            Support::Heal => &mut self.fight_heals,
            Support::Armor => &mut self.fight_armor,
        };
        *fight.entry(giver.to_string()).or_insert(0) += amount;
        let Some(turn) = self.turn.as_mut().filter(|t| t.character_name == giver) else { return };
        match kind {
            Support::Heal => turn.heal += amount,
            Support::Armor => turn.armor += amount,
        }
        self.emit(out, TurnUpdateKind::Support, None);
    }

    fn end_fight(&mut self, out: &mut Vec<TurnUpdate>) {
        self.close_turn(out);
        self.recorder.finish();
        self.fight_id = None;
        self.forget_fighters();
    }

    fn emit(&self, out: &mut Vec<TurnUpdate>, kind: TurnUpdateKind, amount: Option<u64>) {
        if let Some(turn) = &self.turn {
            out.push(TurnUpdate {
                kind,
                character_name: turn.character_name.clone(),
                turn_id: turn.turn_id,
                total: turn.total,
                fight_total: self.fight_totals.get(&turn.character_name).copied().unwrap_or(0),
                amount,
                heal: turn.heal,
                fight_heal: self.fight_heals.get(&turn.character_name).copied().unwrap_or(0),
                armor: turn.armor,
                fight_armor: self.fight_armor.get(&turn.character_name).copied().unwrap_or(0),
            });
        }
    }
}
