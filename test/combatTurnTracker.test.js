'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { CombatTurnTracker } = require('../src/combatTurnTracker');

const combat = (message) => ` INFO 19:16:35,717 [AWT-EventQueue-0] (aNZ:174) - [Information (combat)] ${message}`;
const join = (name, ai, fightId = '1664003685') =>
  ` INFO 18:44:53,521 [AWT-EventQueue-0] (fcb:0) - [_FL_] fightId=${fightId} ${name} breed : 4 [8820880] `
  + `isControlledByAI=${ai} obstacleId : -1 join the fight at {Point3 : (3, 5, 9)}`;

function track(lines, options) {
  const events = [];
  const tracker = new CombatTurnTracker((e) => events.push(e), options);
  for (const line of lines) tracker.processLine(line);
  const ended = events.filter((e) => e.type === 'end').map((e) => [e.characterName, e.total]);
  return { tracker, events, ended };
}

const FIGHT_START = [
  join('Lueur Pourpre', 'false'),
  join('Kamarachnide', 'true'),
  join('Lueur Anthracite', 'false'),
];

test('sums the damage of a turn, with space-grouped thousands', () => {
  const { ended } = track([
    ...FIGHT_START,
    combat('Lueur Pourpre lance le sort Attaque perfide (Critiques)'),
    combat('Bulbiflore: -9 822 PV  (Eau)'),
    combat('Bulbiflore: 3 928 Armure (Attaque perfide)'),
    combat('Lueur Pourpre lance le sort Kleptosram (Critiques)'),
    combat('Bulbiflore: -5 465 PV  (Eau)'),
    combat('Bulbiflore: -1 365 PV  (Lumière) (Feu) (Rupture violente)'),
    combat('Lueur Pourpre: +3 697 PV (Neutre) (Assassin)'),
    combat('145 secondes reportées pour le tour suivant.'),
  ]);
  assert.deepEqual(ended, [['Lueur Pourpre', 9822 + 5465 + 1365]]);
});

test('credits bomb damage to the Roublard whose turn is open, without friendly fire', () => {
  const { ended } = track([
    ...FIGHT_START,
    combat('Lueur Anthracite lance le sort Brasier'),
    combat('Lueur Anthracite: Invoque un(e) Bombe Paralysante '),
    combat('Lueur Anthracite lance le sort Barbrûlé (Critiques)'),
    combat('Kamarachnide: -1 258 PV (Feu)'),
    combat('Lueur Anthracite lance le sort Détonation'),
    combat('Bombe Paralysante: -1 456 PV  (Terre) (Bombe paralysante)'),
    combat('Lueur Pourpre: -280 PV (Terre) (Bombe paralysante)'),
    combat('Lueur Anthracite: -306 PV (Terre) (Bombe paralysante)'),
    combat('Kamarachnide: -668 PV (Terre) (Bombe paralysante)'),
    combat('Bombe Paralysante est hors-combat !'),
    combat('99 secondes reportées pour le tour suivant.'),
  ]);
  assert.deepEqual(ended, [['Lueur Anthracite', 1258 + 668]]);
});

test('ends a turn when another fighter casts', () => {
  const { ended } = track([
    ...FIGHT_START,
    combat('Kamarachnide lance le sort Drache dorée'),
    combat('Lueur Pourpre: -1 463 PV (Terre)'),
    combat('Lueur Anthracite lance le sort Brasier'),
    combat('Kamarachnide: -525 PV (Feu)'),
  ]);
  assert.deepEqual(ended, [['Kamarachnide', 1463]]);
});

test('leaves start-of-turn effects after "secondes reportées" out of every turn', () => {
  const { ended } = track([
    ...FIGHT_START,
    combat('Lueur Pourpre lance le sort Effroi'),
    combat('Kamarachnide: -100 PV (Air)'),
    combat('112 secondes reportées pour le tour suivant.'),
    combat('Kamarachnide: -2 637 PV  (Air) (Hémorragie)'),
    combat('Kamarachnide lance le sort Drache dorée'),
    combat('Combat terminé, cliquez ici pour rouvrir l\'écran de fin de combat. '),
  ]);
  assert.deepEqual(ended, [['Lueur Pourpre', 100], ['Kamarachnide', 0]]);
});

test('consecutive turns of the same fighter are split by the turn-end line', () => {
  const { events } = track([
    ...FIGHT_START,
    combat('Lueur Pourpre lance le sort Double'),
    combat('Lueur Pourpre: Passe son tour'),
    combat('150 secondes reportées pour le tour suivant.'),
    combat('Lueur Pourpre lance le sort Effroi (Critiques)'),
  ]);
  const starts = events.filter((e) => e.type === 'start');
  assert.equal(starts.length, 2);
  assert.notEqual(starts[0].turnId, starts[1].turnId);
});

test('emits running totals on each hit', () => {
  const { events } = track([
    ...FIGHT_START,
    combat('Lueur Pourpre lance le sort Effroi'),
    combat('Kamarachnide: -8 911 PV  (Air)'),
    combat('Kamarachnide: -2 637 PV  (Air) (Hémorragie)'),
  ]);
  assert.deepEqual(
    events.map((e) => [e.type, e.total, e.amount]),
    [['start', 0, undefined], ['damage', 8911, 8911], ['damage', 11548, 2637]]
  );
});

test('isAlly covers heroes whose join line was missed (app started mid-fight)', () => {
  const { ended } = track([
    combat('Lueur Pourpre lance le sort Effroi'),
    combat('Lueur Ocre: -500 PV (Air)'),
    combat('Kamarachnide: -100 PV (Air)'),
    combat('Lueur Pourpre: Passe son tour'),
  ], { isAlly: (name) => name.startsWith('Lueur ') });
  assert.deepEqual(ended, [['Lueur Pourpre', 100]]);
});

// Chat-log style lines with their own timestamps, for the multi-client tests.
const at = (time, message) => `${time} - [Information (combat)] ${message}`;

test('counts each hit once when two clients write the same feed', () => {
  // Real excerpt: every line twice, the second copy's tail after the first
  // copy's turn end.
  const { ended, tracker } = track([
    at('11:43:49,997', 'Lueur Etherique lance le sort Mirage (Critiques)'),
    at('11:43:50,005', 'Lueur Etherique lance le sort Mirage (Critiques)'),
    at('11:43:51,323', 'Patapattes: -1 186 PV (Air)'),
    at('11:43:51,343', 'Patapattes: -1 186 PV (Air)'),
    at('11:44:06,849', 'Lueur Etherique lance le sort Faille (Critiques)'),
    at('11:44:06,872', 'Lueur Etherique lance le sort Faille (Critiques)'),
    at('11:44:08,189', 'Patator: -2 424 PV (Terre)'),
    at('11:44:08,198', '48 secondes reportées pour le tour suivant.'),
    at('11:44:08,200', 'Patator: -2 424 PV (Terre)'),
    at('11:44:08,208', '48 secondes reportées pour le tour suivant.'),
    at('11:44:09,197', 'Patator lance le sort Pataplomb'),
    at('11:44:09,198', 'Patator lance le sort Pataplomb'),
    at('11:44:09,198', 'Lueur Etherique: -358 PV (Feu)'),
    at('11:44:09,199', 'Lueur Etherique: -358 PV (Feu)'),
    at('11:44:13,910', 'Lueur Pourpre lance le sort Effroi (Critiques)'),
  ], { isAlly: (name) => name.startsWith('Lueur ') });
  assert.equal(tracker.copies, 2);
  assert.deepEqual(ended, [['Lueur Etherique', 1186 + 2424], ['Patator', 358]]);
});

test('keeps a hit legitimately logged twice (two-element Huppermage spell), with one or two clients', () => {
  const single = track([
    at('18:44:56,119', 'Lueur Etherique lance le sort Orbes luisants (Critiques)'),
    at('18:44:57,328', 'Avalodon: -1 048 PV  (Lumière) (Terre) (Parade !)'),
    at('18:44:57,329', 'Avalodon: -1 048 PV  (Lumière) (Terre) (Parade !)'),
    at('18:44:58,000', 'Lueur Etherique: Passe son tour'),
  ]);
  assert.deepEqual(single.ended, [['Lueur Etherique', 2096]]);

  const dual = track([
    at('11:43:59,923', 'Lueur Etherique lance le sort Épée de lumière (Critiques)'),
    at('11:43:59,981', 'Lueur Etherique lance le sort Épée de lumière (Critiques)'),
    at('11:44:02,944', 'Patapattes: -2 849 PV (Lumière) (Eau)'),
    at('11:44:02,947', 'Patapattes: -2 849 PV (Lumière) (Eau)'),
    at('11:44:03,011', 'Patapattes: -2 849 PV (Lumière) (Eau)'),
    at('11:44:03,013', 'Patapattes: -2 849 PV (Lumière) (Eau)'),
    at('11:44:08,198', '48 secondes reportées pour le tour suivant.'),
  ]);
  assert.deepEqual(dual.ended, [['Lueur Etherique', 2 * 2849]]);
});

test('a quick genuine recast is not mistaken for a second client', () => {
  // Real excerpt: an Iop recasting "Rafale" 337 ms later, same damage twice.
  const { ended, tracker } = track([
    at('21:49:07,754', 'Fresh-Fighterz lance le sort Rafale (Critiques)'),
    at('21:49:08,088', 'K\'abah\'al, Gardien de la route des morts: -3 618 PV (Air)'),
    at('21:49:08,088', 'Fresh-Fighterz: Concentration (+25 Niv.)'),
    at('21:49:08,091', 'Fresh-Fighterz lance le sort Rafale (Critiques)'),
    at('21:49:08,416', 'K\'abah\'al, Gardien de la route des morts: -3 618 PV (Air)'),
    at('21:49:08,416', 'Fresh-Fighterz: Concentration (+30 Niv.)'),
    at('21:49:10,000', 'Fresh-Fighterz: Passe son tour'),
  ]);
  assert.equal(tracker.copies, 1);
  assert.deepEqual(ended, [['Fresh-Fighterz', 2 * 3618]]);
});

test('a lagging client\'s late copy doesn\'t drop back to one client', () => {
  const { tracker } = track([
    at('11:36:39,605', 'Lueur Etherique lance le sort Libération'),
    at('11:36:39,606', 'Lueur Etherique lance le sort Libération'),
    at('11:36:41,205', 'Lueur Etherique lance le sort Feu-follet'),
    at('11:36:41,727', 'Lueur Etherique lance le sort Feu-follet'),
    at('11:36:42,500', 'Patapattes: -100 PV (Feu)'),
  ]);
  assert.equal(tracker.copies, 2);
});

// Real excerpt: an Osamodas creature is only named on the system join line.
const OSAMODAS_FIGHT = [
  join('Sac à patates', 'true', '1552161909'),
  join('Lueur Pourpre', 'false', '1552161909'),
  join('Lueur Émeraude', 'false', '1552161909'),
  combat('Lueur Émeraude lance le sort Invocation'),
  combat('Lueur Émeraude: Invoque une créature du Gobgob'),
  join('Dragoeuf Guerrier', 'true', '1552161909'),
  combat('Dragoeuf Guerrier: -50 % Dommages infligés'),
  combat('Lueur Émeraude lance le sort Gobgob'),
  combat('Lueur Émeraude: Invoque un(e) Gobgob '),
  join('Gobgob', 'true', '1552161909'),
  combat('53 secondes reportées pour le tour suivant.'),
  combat('Lueur Émeraude: 0 PW (Invocateur animal)'),
  combat('Gobgob lance le sort Nova'),
  combat('Sac à patates: -399 PV  (Terre)'),
  combat('Dragoeuf Guerrier lance le sort Griffure'),
  combat('Sac à patates: -491 PV  (Feu)'),
  combat('Lueur Pourpre lance le sort Attaque perfide (Critiques)'),
  combat('Dragoeuf Guerrier: -4 320 PV  (Eau)'),
  combat('63 secondes reportées pour le tour suivant.'),
];

test('summons playing right after their summoner carry on its turn', () => {
  const { ended, events } = track(OSAMODAS_FIGHT);
  assert.deepEqual(ended, [['Lueur Émeraude', 0], ['Lueur Émeraude', 399 + 491], ['Lueur Pourpre', 0]]);
  const turnIds = events.filter((e) => e.characterName === 'Lueur Émeraude').map((e) => e.turnId);
  assert.equal(new Set(turnIds).size, 1);
});

test('knows each summon\'s summoner and summoning spell, named or not', () => {
  const tracker = new CombatTurnTracker(() => {});
  for (const line of OSAMODAS_FIGHT.slice(0, 10)) tracker.processLine(line);
  assert.equal(tracker.ownerOf('Dragoeuf Guerrier'), 'Lueur Émeraude');
  assert.equal(tracker.summoningSpellOf('Dragoeuf Guerrier'), 'Invocation');
  assert.equal(tracker.ownerOf('Gobgob'), 'Lueur Émeraude');
  assert.equal(tracker.summoningSpellOf('Gobgob'), 'Gobgob');
  assert.equal(tracker.isAlly('Dragoeuf Guerrier'), true);
  assert.equal(tracker.ownerOf('Sac à patates'), null);
  assert.equal(tracker.isAlly('Sac à patates'), false);
});

test('a summon playing after someone else opens a turn for its summoner', () => {
  const { ended } = track([
    ...FIGHT_START,
    combat('Lueur Pourpre lance le sort Double'),
    combat('Lueur Pourpre: Invoque un(e) Double Sram '),
    combat('150 secondes reportées pour le tour suivant.'),
    combat('Kamarachnide lance le sort Drache dorée'),
    combat('Double Sram lance le sort Contact Létal'),
    combat('Kamarachnide: -700 PV (Air)'),
    combat('Kamarachnide lance le sort Morsure'),
  ]);
  assert.deepEqual(ended, [['Lueur Pourpre', 0], ['Kamarachnide', 0], ['Lueur Pourpre', 700]]);
});

test('a new fight forgets the previous fight\'s allies', () => {
  const { tracker } = track([
    ...FIGHT_START,
    combat('Lueur Anthracite: Invoque un(e) Bombe Paralysante '),
    join('Lueur Grenat', 'false', '42'),
  ]);
  assert.equal(tracker.isAlly('Lueur Grenat'), true);
  assert.equal(tracker.isAlly('Lueur Pourpre'), false);
  assert.equal(tracker.isAlly('Bombe Paralysante'), false);
});
