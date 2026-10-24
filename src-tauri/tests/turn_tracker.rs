use wakfu_combo_overlay_lib::turn_tracker::{CombatTurnTracker, TurnUpdate, TurnUpdateKind};

fn combat(message: &str) -> String {
    format!(" INFO 19:16:35,717 [AWT-EventQueue-0] (aNZ:174) - [Information (combat)] {message}")
}

fn join_in(name: &str, ai: bool, fight_id: &str, breed: u32) -> String {
    format!(
        " INFO 18:44:53,521 [AWT-EventQueue-0] (fcb:0) - [_FL_] fightId={fight_id} {name} breed : {breed} [8820880] \
         isControlledByAI={ai} obstacleId : -1 join the fight at {{Point3 : (3, 5, 9)}}"
    )
}

fn join(name: &str, ai: bool) -> String {
    join_in(name, ai, "1664003685", 4)
}

/// Chat-log style lines with their own timestamps, for the multi-client tests.
fn at(time: &str, message: &str) -> String {
    format!("{time} - [Information (combat)] {message}")
}

fn no_extra_allies(_: &str) -> bool {
    false
}

fn lueur(name: &str) -> bool {
    name.starts_with("Lueur ")
}

struct Run {
    tracker: CombatTurnTracker,
    events: Vec<TurnUpdate>,
}

impl Run {
    fn ended(&self) -> Vec<(String, u64)> {
        self.events
            .iter()
            .filter(|e| e.kind == TurnUpdateKind::End)
            .map(|e| (e.character_name.clone(), e.total))
            .collect()
    }
}

fn track_with(lines: &[String], is_ally: &dyn Fn(&str) -> bool) -> Run {
    let mut tracker = CombatTurnTracker::new();
    let mut events = Vec::new();
    for line in lines {
        events.extend(tracker.process_line(line, is_ally));
    }
    Run { tracker, events }
}

fn track(lines: &[String]) -> Run {
    track_with(lines, &no_extra_allies)
}

fn ended(pairs: &[(&str, u64)]) -> Vec<(String, u64)> {
    pairs.iter().map(|(n, t)| (n.to_string(), *t)).collect()
}

fn fight_start() -> Vec<String> {
    vec![join("Lueur Pourpre", false), join("Kamarachnide", true), join("Lueur Anthracite", false)]
}

fn with_start(lines: &[&str]) -> Vec<String> {
    let mut all = fight_start();
    all.extend(lines.iter().map(|m| combat(m)));
    all
}

#[test]
fn sums_the_damage_of_a_turn_with_space_grouped_thousands() {
    let run = track(&with_start(&[
        "Lueur Pourpre lance le sort Attaque perfide (Critiques)",
        "Bulbiflore: -9 822 PV  (Eau)",
        "Bulbiflore: 3 928 Armure (Attaque perfide)",
        "Lueur Pourpre lance le sort Kleptosram (Critiques)",
        "Bulbiflore: -5 465 PV  (Eau)",
        "Bulbiflore: -1 365 PV  (Lumière) (Feu) (Rupture violente)",
        "Lueur Pourpre: +3 697 PV (Neutre) (Assassin)",
        "145 secondes reportées pour le tour suivant.",
    ]));
    assert_eq!(run.ended(), ended(&[("Lueur Pourpre", 9822 + 5465 + 1365)]));
}

#[test]
fn credits_bomb_damage_to_the_roublard_without_friendly_fire() {
    let run = track(&with_start(&[
        "Lueur Anthracite lance le sort Brasier",
        "Lueur Anthracite: Invoque un(e) Bombe Paralysante ",
        "Lueur Anthracite lance le sort Barbrûlé (Critiques)",
        "Kamarachnide: -1 258 PV (Feu)",
        "Lueur Anthracite lance le sort Détonation",
        "Bombe Paralysante: -1 456 PV  (Terre) (Bombe paralysante)",
        "Lueur Pourpre: -280 PV (Terre) (Bombe paralysante)",
        "Lueur Anthracite: -306 PV (Terre) (Bombe paralysante)",
        "Kamarachnide: -668 PV (Terre) (Bombe paralysante)",
        "Bombe Paralysante est hors-combat !",
        "99 secondes reportées pour le tour suivant.",
    ]));
    assert_eq!(run.ended(), ended(&[("Lueur Anthracite", 1258 + 668)]));
}

#[test]
fn ends_a_turn_when_another_fighter_casts() {
    let run = track(&with_start(&[
        "Kamarachnide lance le sort Drache dorée",
        "Lueur Pourpre: -1 463 PV (Terre)",
        "Lueur Anthracite lance le sort Brasier",
        "Kamarachnide: -525 PV (Feu)",
    ]));
    assert_eq!(run.ended(), ended(&[("Kamarachnide", 1463)]));
}

#[test]
fn leaves_start_of_turn_effects_out_of_every_turn() {
    let run = track(&with_start(&[
        "Lueur Pourpre lance le sort Effroi",
        "Kamarachnide: -100 PV (Air)",
        "112 secondes reportées pour le tour suivant.",
        "Kamarachnide: -2 637 PV  (Air) (Hémorragie)",
        "Kamarachnide lance le sort Drache dorée",
        "Combat terminé, cliquez ici pour rouvrir l'écran de fin de combat. ",
    ]));
    assert_eq!(run.ended(), ended(&[("Lueur Pourpre", 100), ("Kamarachnide", 0)]));
}

#[test]
fn consecutive_turns_of_the_same_fighter_are_split_by_the_turn_end_line() {
    let run = track(&with_start(&[
        "Lueur Pourpre lance le sort Double",
        "Lueur Pourpre: Passe son tour",
        "150 secondes reportées pour le tour suivant.",
        "Lueur Pourpre lance le sort Effroi (Critiques)",
    ]));
    let starts: Vec<_> = run.events.iter().filter(|e| e.kind == TurnUpdateKind::Start).collect();
    assert_eq!(starts.len(), 2);
    assert_ne!(starts[0].turn_id, starts[1].turn_id);
}

#[test]
fn emits_running_totals_on_each_hit() {
    let run = track(&with_start(&[
        "Lueur Pourpre lance le sort Effroi",
        "Kamarachnide: -8 911 PV  (Air)",
        "Kamarachnide: -2 637 PV  (Air) (Hémorragie)",
    ]));
    let seen: Vec<_> = run.events.iter().map(|e| (e.kind, e.total, e.amount)).collect();
    assert_eq!(
        seen,
        vec![
            (TurnUpdateKind::Start, 0, None),
            (TurnUpdateKind::Damage, 8911, Some(8911)),
            (TurnUpdateKind::Damage, 11548, Some(2637)),
        ]
    );
}

#[test]
fn is_ally_covers_heroes_whose_join_line_was_missed() {
    let lines: Vec<String> = [
        "Lueur Pourpre lance le sort Effroi",
        "Lueur Ocre: -500 PV (Air)",
        "Kamarachnide: -100 PV (Air)",
        "Lueur Pourpre: Passe son tour",
    ]
    .iter()
    .map(|m| combat(m))
    .collect();
    let run = track_with(&lines, &lueur);
    assert_eq!(run.ended(), ended(&[("Lueur Pourpre", 100)]));
}

#[test]
fn counts_each_hit_once_when_two_clients_write_the_same_feed() {
    let lines = vec![
        at("11:43:49,997", "Lueur Etherique lance le sort Mirage (Critiques)"),
        at("11:43:50,005", "Lueur Etherique lance le sort Mirage (Critiques)"),
        at("11:43:51,323", "Patapattes: -1 186 PV (Air)"),
        at("11:43:51,343", "Patapattes: -1 186 PV (Air)"),
        at("11:44:06,849", "Lueur Etherique lance le sort Faille (Critiques)"),
        at("11:44:06,872", "Lueur Etherique lance le sort Faille (Critiques)"),
        at("11:44:08,189", "Patator: -2 424 PV (Terre)"),
        at("11:44:08,198", "48 secondes reportées pour le tour suivant."),
        at("11:44:08,200", "Patator: -2 424 PV (Terre)"),
        at("11:44:08,208", "48 secondes reportées pour le tour suivant."),
        at("11:44:09,197", "Patator lance le sort Pataplomb"),
        at("11:44:09,198", "Patator lance le sort Pataplomb"),
        at("11:44:09,198", "Lueur Etherique: -358 PV (Feu)"),
        at("11:44:09,199", "Lueur Etherique: -358 PV (Feu)"),
        at("11:44:13,910", "Lueur Pourpre lance le sort Effroi (Critiques)"),
    ];
    let run = track_with(&lines, &lueur);
    assert_eq!(run.tracker.copies(), 2);
    assert_eq!(run.ended(), ended(&[("Lueur Etherique", 1186 + 2424), ("Patator", 358)]));
}

#[test]
fn keeps_a_hit_legitimately_logged_twice() {
    let single = track(&[
        at("18:44:56,119", "Lueur Etherique lance le sort Orbes luisants (Critiques)"),
        at("18:44:57,328", "Avalodon: -1 048 PV  (Lumière) (Terre) (Parade !)"),
        at("18:44:57,329", "Avalodon: -1 048 PV  (Lumière) (Terre) (Parade !)"),
        at("18:44:58,000", "Lueur Etherique: Passe son tour"),
    ]);
    assert_eq!(single.ended(), ended(&[("Lueur Etherique", 2096)]));

    let dual = track(&[
        at("11:43:59,923", "Lueur Etherique lance le sort Épée de lumière (Critiques)"),
        at("11:43:59,981", "Lueur Etherique lance le sort Épée de lumière (Critiques)"),
        at("11:44:02,944", "Patapattes: -2 849 PV (Lumière) (Eau)"),
        at("11:44:02,947", "Patapattes: -2 849 PV (Lumière) (Eau)"),
        at("11:44:03,011", "Patapattes: -2 849 PV (Lumière) (Eau)"),
        at("11:44:03,013", "Patapattes: -2 849 PV (Lumière) (Eau)"),
        at("11:44:08,198", "48 secondes reportées pour le tour suivant."),
    ]);
    assert_eq!(dual.ended(), ended(&[("Lueur Etherique", 2 * 2849)]));
}

#[test]
fn a_quick_genuine_recast_is_not_mistaken_for_a_second_client() {
    let run = track(&[
        at("21:49:07,754", "Fresh-Fighterz lance le sort Rafale (Critiques)"),
        at("21:49:08,088", "K'abah'al, Gardien de la route des morts: -3 618 PV (Air)"),
        at("21:49:08,088", "Fresh-Fighterz: Concentration (+25 Niv.)"),
        at("21:49:08,091", "Fresh-Fighterz lance le sort Rafale (Critiques)"),
        at("21:49:08,416", "K'abah'al, Gardien de la route des morts: -3 618 PV (Air)"),
        at("21:49:08,416", "Fresh-Fighterz: Concentration (+30 Niv.)"),
        at("21:49:10,000", "Fresh-Fighterz: Passe son tour"),
    ]);
    assert_eq!(run.tracker.copies(), 1);
    assert_eq!(run.ended(), ended(&[("Fresh-Fighterz", 2 * 3618)]));
}

#[test]
fn a_lagging_clients_late_copy_doesnt_drop_back_to_one_client() {
    let run = track(&[
        at("11:36:39,605", "Lueur Etherique lance le sort Libération"),
        at("11:36:39,606", "Lueur Etherique lance le sort Libération"),
        at("11:36:41,205", "Lueur Etherique lance le sort Feu-follet"),
        at("11:36:41,727", "Lueur Etherique lance le sort Feu-follet"),
        at("11:36:42,500", "Patapattes: -100 PV (Feu)"),
    ]);
    assert_eq!(run.tracker.copies(), 2);
}

/// Real excerpt: an Osamodas creature is only named on the system join line.
fn osamodas_fight() -> Vec<String> {
    vec![
        join_in("Sac à patates", true, "1552161909", 2335),
        join_in("Lueur Pourpre", false, "1552161909", 4),
        join_in("Lueur Émeraude", false, "1552161909", 2),
        combat("Lueur Émeraude lance le sort Invocation"),
        combat("Lueur Émeraude: Invoque une créature du Gobgob"),
        join_in("Dragoeuf Guerrier", true, "1552161909", 4210),
        combat("Dragoeuf Guerrier: -50 % Dommages infligés"),
        combat("Lueur Émeraude lance le sort Gobgob"),
        combat("Lueur Émeraude: Invoque un(e) Gobgob "),
        join_in("Gobgob", true, "1552161909", 1620),
        combat("53 secondes reportées pour le tour suivant."),
        combat("Lueur Émeraude: 0 PW (Invocateur animal)"),
        combat("Gobgob lance le sort Nova"),
        combat("Sac à patates: -399 PV  (Terre)"),
        combat("Dragoeuf Guerrier lance le sort Griffure"),
        combat("Sac à patates: -491 PV  (Feu)"),
        combat("Lueur Pourpre lance le sort Attaque perfide (Critiques)"),
        combat("Dragoeuf Guerrier: -4 320 PV  (Eau)"),
        combat("63 secondes reportées pour le tour suivant."),
    ]
}

#[test]
fn summons_playing_right_after_their_summoner_carry_on_its_turn() {
    let run = track(&osamodas_fight());
    assert_eq!(
        run.ended(),
        ended(&[("Lueur Émeraude", 0), ("Lueur Émeraude", 399 + 491), ("Lueur Pourpre", 0)])
    );
    let mut turn_ids: Vec<u64> = run
        .events
        .iter()
        .filter(|e| e.character_name == "Lueur Émeraude")
        .map(|e| e.turn_id)
        .collect();
    turn_ids.dedup();
    assert_eq!(turn_ids.len(), 1);
}

#[test]
fn knows_each_summons_summoner_and_summoning_spell() {
    let run = track(&osamodas_fight()[..10]);
    let t = &run.tracker;
    assert_eq!(t.owner_of("Dragoeuf Guerrier").as_deref(), Some("Lueur Émeraude"));
    assert_eq!(t.summoning_spell_of("Dragoeuf Guerrier").as_deref(), Some("Invocation"));
    assert_eq!(t.owner_of("Gobgob").as_deref(), Some("Lueur Émeraude"));
    assert_eq!(t.summoning_spell_of("Gobgob").as_deref(), Some("Gobgob"));
    assert!(t.is_ally("Dragoeuf Guerrier", &no_extra_allies));
    assert_eq!(t.owner_of("Sac à patates"), None);
    assert!(!t.is_ally("Sac à patates", &no_extra_allies));
}

#[test]
fn a_summon_playing_after_someone_else_opens_a_turn_for_its_summoner() {
    let run = track(&with_start(&[
        "Lueur Pourpre lance le sort Double",
        "Lueur Pourpre: Invoque un(e) Double Sram ",
        "150 secondes reportées pour le tour suivant.",
        "Kamarachnide lance le sort Drache dorée",
        "Double Sram lance le sort Contact Létal",
        "Kamarachnide: -700 PV (Air)",
        "Kamarachnide lance le sort Morsure",
    ]));
    assert_eq!(run.ended(), ended(&[("Lueur Pourpre", 0), ("Kamarachnide", 0), ("Lueur Pourpre", 700)]));
}

#[test]
fn training_dummies_a_hero_summons_are_targets_not_pets() {
    let run = track(&[
        join_in("Sac à patates", true, "1552162620", 2335),
        join_in("Lueur Anthracite", false, "1552162620", 13),
        combat("Lueur Anthracite lance le sort Invocation"),
        combat("Lueur Anthracite: Invoque un(e) Sac à patates "),
        join_in("Sac à patates", true, "1552162620", 2335),
        combat("Lueur Anthracite lance le sort Barbrûlé"),
        combat("Sac à patates: -1 494 PV (Feu)"),
        combat("Sac à patates: -1 121 PV (Lumière) (Feu) (Tir surprise)"),
        combat("Lueur Anthracite: Passe son tour"),
    ]);
    assert!(!run.tracker.is_ally("Sac à patates", &no_extra_allies));
    assert_eq!(run.tracker.owner_of("Sac à patates"), None);
    assert_eq!(run.ended(), ended(&[("Lueur Anthracite", 1494 + 1121)]));
}

#[test]
fn a_new_fight_forgets_the_previous_fights_allies() {
    let mut lines = fight_start();
    lines.push(combat("Lueur Anthracite: Invoque un(e) Bombe Paralysante "));
    lines.push(join_in("Lueur Grenat", false, "42", 4));
    let run = track(&lines);
    assert!(run.tracker.is_ally("Lueur Grenat", &no_extra_allies));
    assert!(!run.tracker.is_ally("Lueur Pourpre", &no_extra_allies));
    assert!(!run.tracker.is_ally("Bombe Paralysante", &no_extra_allies));
}
