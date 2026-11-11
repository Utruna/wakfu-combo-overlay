use serde_json::{json, Value};
use std::fs;
use std::sync::atomic::{AtomicUsize, Ordering};

use wakfu_combo_overlay_lib::catalog::Catalog;
use wakfu_combo_overlay_lib::fight_recap::{parse_tags, EffectTags};
use wakfu_combo_overlay_lib::settings::SettingsStore;
use wakfu_combo_overlay_lib::turn_tracker::CombatTurnTracker;

fn tags(element: Option<&str>, source: Option<&str>) -> EffectTags {
    EffectTags { element: element.map(str::to_string), source: source.map(str::to_string), lifesteal: false }
}

#[test]
fn reads_element_and_source() {
    assert_eq!(parse_tags(" (Feu)"), tags(Some("Feu"), None));
    assert_eq!(parse_tags(" (Neutre) (Parade !) (Ponction)"), tags(Some("Neutre"), Some("Ponction")));
    assert_eq!(parse_tags(" (Lumière) (Feu) (Radiance)"), tags(Some("Lumière"), Some("Radiance")));
    assert_eq!(
        parse_tags(" (Neutre - Vol de vie) (Saignée mortelle)"),
        EffectTags { lifesteal: true, ..tags(Some("Neutre"), Some("Saignée mortelle")) }
    );
    assert_eq!(parse_tags(""), tags(None, None));
}

/// A line of wakfu.log, `n` tenths of a second into the fight.
fn line(n: u32, message: &str) -> String {
    let ms = 36_000_000 + n * 700;
    let (s, ms) = (ms / 1000, ms % 1000);
    format!(" INFO {:02}:{:02}:{:02},{ms:03} [AWT-EventQueue-0] (aOb:174) - {message}", s / 3600, s / 60 % 60, s % 60)
}

fn record(messages: &[&str]) -> Value {
    record_then(messages, |_| {})
}

/// Records the lines, then does `then` to the tracker before reading the recap.
fn record_then(messages: &[&str], then: impl FnOnce(&mut CombatTurnTracker)) -> Value {
    // One folder per call: the tests run in parallel threads, and sharing one
    // settings.json let a test read it while another was rewriting it (empty
    // for an instant), so its heroes vanished.
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    let dir = std::env::temp_dir().join(format!("wakfu-recap-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
    fs::create_dir_all(&dir).unwrap();
    let path = dir.join("settings.json");
    fs::write(
        &path,
        json!({ "heroes": [
            { "name": "Lueur Pourpre", "characterName": "Lueur Pourpre", "class": "sram", "color": { "r": 1, "g": 2, "b": 3 } },
            { "name": "Lueur Grenat", "characterName": "Lueur Grenat", "class": "eniripsa", "color": { "r": 1, "g": 2, "b": 3 } },
        ] })
        .to_string(),
    )
    .unwrap();
    let settings = SettingsStore::open(&path);
    let mut tracker = CombatTurnTracker::new();
    let heroes = ["Lueur Pourpre", "Lueur Grenat"];
    for (i, message) in messages.iter().enumerate() {
        tracker.process_line(&line(i as u32, message), &|name| heroes.contains(&name));
    }
    then(&mut tracker);
    tracker.recorder.to_json(&settings, &Catalog::load(|_| true))
}

fn fighter<'a>(fight: &'a Value, name: &str) -> &'a Value {
    fight["fighters"].as_array().unwrap().iter().find(|f| f["name"] == name).unwrap()
}

const JOIN: [&str; 3] = [
    "[_FL_] fightId=42 Lueur Pourpre breed : 4 [1] isControlledByAI=false obstacleId : -1 join the fight",
    "[_FL_] fightId=42 Lueur Grenat breed : 4 [2] isControlledByAI=false obstacleId : -1 join the fight",
    "[_FL_] fightId=42 Ogrest breed : 777 [3] isControlledByAI=true obstacleId : -1 join the fight",
];

#[test]
fn records_spells_hits_heals_and_damage_taken() {
    let mut lines = JOIN.to_vec();
    lines.extend([
        "[Information (combat)] Lueur Pourpre lance le sort Kleptosram (Critiques)",
        "[Information (combat)] Ogrest: -12 000 PV (Air)",
        "[Information (combat)] Ogrest: -3 000 PV (Air)",
        "[Information (combat)] Lueur Pourpre lance le sort Mise à mort",
        // Named after the turn's first spell: goes back to it.
        "[Information (combat)] Ogrest: -1 000 PV (Air) (Kleptosram)",
        // Named after nothing cast this turn: "others".
        "[Information (combat)] Ogrest: -500 PV (Neutre) (Hémorragie)",
        "[Information (combat)] 30 secondes reportées pour le tour suivant.",
        "[Information (combat)] Lueur Grenat lance le sort Revitalisation",
        "[Information (combat)] Lueur Pourpre: +2 577 PV (Eau)",
        // A heal landing on a monster isn't the group's.
        "[Information (combat)] Ogrest: +9 999 PV (Eau)",
        "[Information (combat)] 30 secondes reportées pour le tour suivant.",
        "[Information (combat)] Ogrest lance le sort Lance Rochette",
        "[Information (combat)] Lueur Grenat: -10 513 PV (Feu) (Lance Rochette)",
        "[Information (combat)] Lueur Pourpre : +109 116 340 points d'XP.  Prochain niveau dans : 1.",
        "[FIGHT] End fight with id 42",
        "[Information (combat)] Combat terminé, cliquez ici pour rouvrir l'écran de fin de combat.",
    ]);
    let recap = record(&lines);
    let fights = recap["fights"].as_array().unwrap();
    assert_eq!(fights.len(), 1);
    let fight = &fights[0];
    assert_eq!(fight["live"], false);
    assert_eq!(fight["victory"], true);
    assert_eq!(fight["isNew"], true);
    assert_eq!(fight["foes"], json!(["Ogrest"]));
    // The monster isn't listed: the recap is about the group.
    assert_eq!(fight["fighters"].as_array().unwrap().len(), 2);

    let pourpre = fighter(fight, "Lueur Pourpre");
    let turn = &pourpre["turns"][0];
    assert_eq!(turn["spells"][0]["name"], "Kleptosram");
    assert_eq!(turn["spells"][0]["crit"], true);
    let amounts = |spell: &Value| spell["hits"].as_array().unwrap().iter().map(|h| h["amount"].as_u64().unwrap()).collect::<Vec<_>>();
    assert_eq!(amounts(&turn["spells"][0]), [12000, 3000, 1000]);
    assert_eq!(turn["spells"][0]["hits"][0]["element"], "Air");
    assert_eq!(amounts(&turn["spells"][1]), Vec::<u64>::new());
    assert_eq!(turn["others"], json!([{ "label": "Hémorragie", "amount": 500 }]));

    let grenat = fighter(fight, "Lueur Grenat");
    assert_eq!(grenat["turns"][0]["spells"][0]["heals"], json!([{ "amount": 2577, "element": "Eau", "target": "Lueur Pourpre" }]));
    assert_eq!(grenat["taken"], 10513);
    assert_eq!(pourpre["taken"], 0);
}

#[test]
fn credits_heals_to_their_healer_even_outside_its_turn() {
    let mut lines = JOIN.to_vec();
    lines.extend([
        "[Information (combat)] Lueur Grenat lance le sort Revitalisation",
        // An area heal: one line per ally, all the spell's.
        "[Information (combat)] Lueur Pourpre: +10 000 PV (Eau)",
        "[Information (combat)] Lueur Grenat: +10 000 PV (Eau)",
        // Overheal.
        "[Information (combat)] Lueur Pourpre: +0 PV (Eau)",
        // An effect first seen in Grenat's turn is Grenat's.
        "[Information (combat)] Lueur Grenat: +300 PV (Neutre) (Marque Husse)",
        "[Information (combat)] 30 secondes reportées pour le tour suivant.",
        "[Information (combat)] Lueur Pourpre lance le sort Saignée mortelle",
        "[Information (combat)] Ogrest: -5 000 PV (Air)",
        // Lifesteal is the healed one's own.
        "[Information (combat)] Lueur Pourpre: +500 PV (Neutre - Vol de vie) (Saignée mortelle)",
        // Grenat's mark healing during Pourpre's turn: still Grenat's.
        "[Information (combat)] Lueur Pourpre: +400 PV (Neutre) (Marque Husse)",
        "[Information (combat)] 30 secondes reportées pour le tour suivant.",
    ]);
    let recap = record(&lines);
    let fight = &recap["fights"][0];
    let grenat = fighter(fight, "Lueur Grenat");
    let revitalisation = &grenat["turns"][0]["spells"][0]["heals"];
    assert_eq!(revitalisation.as_array().unwrap().len(), 2);
    assert_eq!(grenat["turns"][0]["healOthers"], json!([{ "label": "Marque Husse", "amount": 300 }]));
    assert_eq!(grenat["healOutside"], json!([{ "label": "Marque Husse", "amount": 400 }]));
    let pourpre = fighter(fight, "Lueur Pourpre");
    assert_eq!(pourpre["turns"][0]["spells"][0]["heals"][0]["amount"], 500);
    assert_eq!(pourpre["healOutside"], json!([]));
}

#[test]
fn a_fight_in_progress_comes_first_and_live() {
    let mut lines = JOIN.to_vec();
    lines.push("[Information (combat)] Lueur Pourpre lance le sort Kleptosram");
    let recap = record(&lines);
    assert_eq!(recap["fights"][0]["live"], true);
    assert_eq!(recap["fights"][0]["isNew"], false);
}

#[test]
fn the_bin_drops_finished_fights_only() {
    let mut lines = JOIN.to_vec();
    lines.extend([
        "[Information (combat)] Lueur Pourpre lance le sort Kleptosram",
        "[Information (combat)] Ogrest: -12 000 PV (Air)",
        "[FIGHT] End fight with id 42",
        "[_FL_] fightId=43 Lueur Pourpre breed : 4 [1] isControlledByAI=false obstacleId : -1 join the fight",
        "[Information (combat)] Lueur Pourpre lance le sort Kleptosram",
    ]);
    let ids = |recap: &Value| recap["fights"].as_array().unwrap().iter().map(|f| f["id"].as_u64().unwrap()).collect::<Vec<_>>();
    let before = ids(&record(&lines));
    assert_eq!(before.len(), 2);
    let (live, finished) = (before[0], before[1]);
    let after = record_then(&lines, |tracker| {
        assert!(!tracker.recorder.delete(live));
        assert!(tracker.recorder.delete(finished));
        assert!(!tracker.recorder.has_unseen());
    });
    assert_eq!(ids(&after), [live]);
}

#[test]
fn armour_goes_to_whoever_gave_it() {
    let mut lines = JOIN.to_vec();
    lines.extend([
        "[Information (combat)] Lueur Pourpre lance le sort Kleptosram",
        "[Information (combat)] Lueur Pourpre lance le sort Fourberie",
        // Given to an ally during Pourpre's turn, by its spell: Pourpre's.
        "[Information (combat)] Lueur Grenat: 690 Armure",
        "[Information (combat)] Lueur Pourpre: 690 Armure",
        // A monster's armour isn't the group's.
        "[Information (combat)] Ogrest: 7 778 Armure (Attaque perfide)",
        "[Information (combat)] 30 secondes reportées pour le tour suivant.",
        "[Information (combat)] Ogrest lance le sort Lance Rochette",
        // Nothing named, no ally playing: the gainer's own (a passive).
        "[Information (combat)] Lueur Grenat: 300 Armure",
    ]);
    let recap = record(&lines);
    let fight = &recap["fights"][0];
    let pourpre = fighter(fight, "Lueur Pourpre");
    let shields = &pourpre["turns"][0]["spells"][1]["shields"];
    assert_eq!(pourpre["turns"][0]["spells"][1]["name"], "Fourberie");
    assert_eq!(shields.as_array().unwrap().iter().map(|s| s["amount"].as_u64().unwrap()).sum::<u64>(), 1380);
    assert_eq!(shields[0]["target"], "Lueur Grenat");
    let grenat = fighter(fight, "Lueur Grenat");
    assert_eq!(grenat["shieldOutside"], json!([{ "label": "Armure", "amount": 300 }]));
}

/// A full team fight (see the 2026-11-03 dungeon): one hero of the user, one
/// of their own characters not set up yet, and players of other people.
#[test]
fn shows_the_whole_group_and_spots_the_users_untracked_characters() {
    let lines = [
        "[_FL_] fightId=7 Lueur Grenat breed : 7 [1] isControlledByAI=false obstacleId : -1 join the fight",
        "[_FL_] fightId=7 Lueur Ocre breed : 13 [2] isControlledByAI=false obstacleId : -1 join the fight",
        "[_FL_] fightId=7 Autre Sacri breed : 11 [3] isControlledByAI=false obstacleId : -1 join the fight",
        "[_FL_] fightId=7 Autre Iop breed : 8 [4] isControlledByAI=false obstacleId : -1 join the fight",
        "[_FL_] fightId=7 Autre Muet breed : 19 [5] isControlledByAI=false obstacleId : -1 join the fight",
        "[_FL_] fightId=7 Ogrest breed : 777 [6] isControlledByAI=true obstacleId : -1 join the fight",
        "[Information (combat)] Lueur Ocre lance le sort Dynamite",
        "[Information (combat)] Ogrest: -4 000 PV (Feu)",
        "[Information (combat)] 30 secondes reportées pour le tour suivant.",
        // "Méditation" is filed under the Eliotrope: outvoted by the rest.
        "[Information (combat)] Autre Sacri lance le sort Méditation",
        "[Information (combat)] Autre Sacri lance le sort Assaut",
        "[Information (combat)] Autre Sacri lance le sort Bain de sang",
        "[Information (combat)] Ogrest: -2 500 PV (Feu)",
        "[Information (combat)] 30 secondes reportées pour le tour suivant.",
        // "Rafale" is both Iop and Cra: no vote.
        "[Information (combat)] Autre Iop lance le sort Rafale",
        "[Information (combat)] Autre Iop lance le sort Fulgur",
        "[Information (combat)] 30 secondes reportées pour le tour suivant.",
        // Nothing but a shared spell: the breed says it.
        "[Information (combat)] Autre Muet lance le sort Rafale",
        "[Information (combat)] 30 secondes reportées pour le tour suivant.",
        "[Information (combat)] Lueur Grenat lance le sort Mot soignant",
        // XP is only written for the characters of the client(s) writing the log.
        "[Information (combat)] Lueur Grenat : +96 808 163 points d'XP.  Prochain niveau dans : 7 882 942 500.",
        "[Information (combat)] Lueur Ocre : +1 000 points d'XP.  Prochain niveau dans : 5 000.",
        "[FIGHT] End fight with id 7",
    ];
    let recap = record(&lines);
    let fight = &recap["fights"][0];
    assert_eq!(fight["victory"], true);
    assert_eq!(fight["fighters"].as_array().unwrap().len(), 5);

    let grenat = fighter(fight, "Lueur Grenat");
    assert_eq!((grenat["hero"].clone(), grenat["local"].clone()), (json!(true), json!(true)));
    assert_eq!((grenat["class"].clone(), grenat["classGuessed"].clone()), (json!("eniripsa"), json!(false)));

    let ocre = fighter(fight, "Lueur Ocre");
    assert_eq!((ocre["hero"].clone(), ocre["local"].clone()), (json!(false), json!(true)));
    assert_eq!((ocre["class"].clone(), ocre["classGuessed"].clone()), (json!("roublard"), json!(true)));
    assert_eq!(ocre["turns"][0]["spells"][0]["hits"][0]["amount"], 4000);

    let sacri = fighter(fight, "Autre Sacri");
    assert_eq!((sacri["hero"].clone(), sacri["local"].clone()), (json!(false), json!(false)));
    assert_eq!(sacri["class"], "sacrieur");
    assert_eq!(sacri["turns"][0]["spells"].as_array().unwrap().len(), 3);
    assert_eq!(fighter(fight, "Autre Iop")["class"], "iop");
    assert_eq!(fighter(fight, "Autre Muet")["class"], "huppermage");
}
