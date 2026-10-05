/**
 * combatTurnTracker.js
 * Splits Wakfu's combat feed into turns and sums the damage dealt during each.
 *
 * The log never says who dealt a hit — a damage line only names the target
 * ("Kamarachnide: -1 258 PV (Feu)"). So every hit is credited to whoever owns
 * the turn that is open when it lands. That is also what makes delayed damage
 * work: a Roublard's bombs exploding on "Détonation", a trap, a "Hémorragie"
 * tick… all land while their owner's turn is still open.
 *
 * Turn boundaries, as observed in the logs:
 *   - opens on the first spell cast by a fighter (no event marks a turn start);
 *   - closes on "N secondes reportées pour le tour suivant." — written when a
 *     player ends their turn, before the next fighter's start-of-turn effects
 *     (so those aren't credited to the wrong turn), or "X: Passe son tour";
 *   - closes when a different fighter casts — the fallback for monsters and
 *     summons, which never get the "secondes reportées" line;
 *   - closes when the fight ends.
 *
 * Friendly fire (a bomb blast catching an ally, the caster itself…) is left
 * out. Allies are the non-AI fighters announced by the "[_FL_] … join the
 * fight" lines, anything they summon, and whatever `isAlly` recognizes (the
 * configured heroes — covers starting the app in the middle of a fight, when
 * the join lines were already past).
 *
 * Summons count for whoever summoned them: they are allies (no friendly fire
 * on them), and a summon playing right after its summoner — which is what
 * they do (Osamodas creatures, Double Sram, Dark Lapino…) — carries on that
 * summoner's turn instead of opening one of its own, so its damage lands in
 * the same total. Most summons are named on the spot ("X: Invoque un(e)
 * Gobgob"); an Osamodas creature isn't ("X: Invoque une créature du Gobgob"),
 * its name only comes on the "[_FL_] … join the fight" line right after.
 *
 * Several local clients in the same fight each write the whole combat feed
 * to the shared log, so every line shows up once per client, the copies
 * < 300 ms apart (measured: none between 300 and 500 ms, the next ones are
 * genuine recasts). That count of clients is read off the casts — the same
 * spell can't be recast that fast — and then only one in every `copies`
 * identical lines within the window is kept. Counting instead of dropping
 * every repeat keeps a hit legitimately logged twice (an Huppermage spell
 * hitting with two elements prints two identical lines) at its true weight.
 */

'use strict';

const COMBAT_PREFIX = /\[Information\s+\(combat\)\]\s+(.*?)\s*$/;
const CAST = /^(.+?)\s+lance\s+le\s+sort\s+(.+?)(?:\s*\(|$)/;
// "-1 375 PV" — thousands are grouped with a space (\s also covers the no-break ones).
const DAMAGE = /^(.+?):\s+-(\d[\d\s]*)\s+PV\b/;
const INVOKE = /^(.+?):\s+Invoque\s+(?:un\(e\)\s+(.+?)\s*$)?/;
const TURN_END = /secondes\s+report[ée]es\s+pour\s+le\s+tour\s+suivant|^[^:]+:\s+Passe\s+son\s+tour/;
const COMBAT_END = /^Combat\s+termin[ée]/;
const FIGHTER_JOIN = /\[_FL_\]\s+fightId=(\d+)\s+(.+?)\s+breed\s*:.*?isControlledByAI=(true|false)/;
const FIGHT_END = /\[FIGHT\]\s+End\s+fight/;
const LOG_TIME = /(\d{2}):(\d{2}):(\d{2}),(\d{3})/;

const COPY_WINDOW_MS = 400;
// Copies of a cast arrive mostly < 150 ms apart; a genuine quick recast (an
// Iop's "Rafale" was seen 337 ms after the previous one) never does. Only
// that tight a repeat counts as proof of another client.
const CAST_COPY_PROOF_MS = 150;
// Housekeeping only: past this many tracked line groups, expired ones are swept.
const MAX_GROUPS = 500;

/** Milliseconds since midnight from the "HH:MM:SS,mmm" stamp, or null. */
function logTimeMs(line) {
  const m = line.match(LOG_TIME);
  if (!m) return null;
  return ((Number(m[1]) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + Number(m[4]);
}

/** Midnight rollover (or a clock jump back) counts as expired too. */
const expired = (group, now) => now < group.at || now - group.at > COPY_WINDOW_MS;

class CombatTurnTracker {
  /**
   * @param {Function} onUpdate - ({type: 'start'|'damage'|'end', characterName, turnId, total, amount?, target?}) => void
   * @param {object} [options]
   * @param {Function} [options.isAlly] - (name) => boolean, extra allies on top of the ones read from the log.
   */
  constructor(onUpdate, { isAlly = () => false } = {}) {
    this._onUpdate = onUpdate;
    this._isAllyExtra = isAlly;
    this._fightId = null;
    this._allies = new Set();
    this._turn = null; // { characterName, turnId, total }
    this._lastTurn = null; // the turn just closed, which its summoner's summons may carry on
    this._nextTurnId = 1;
    this._summons = new Map(); // summon name -> { owner, spell } (the spell that summoned it)
    this._lastSpell = new Map(); // fighter -> last spell cast
    this._pendingSummon = null; // { owner, spell } waiting for the creature's name (Osamodas)
    this._copies = 1; // clients currently writing the feed
    this._castGroups = new Map(); // cast message -> { at, count, provenCopies }
    this._loneCast = null; // last cast seen with fewer copies than expected
    this._lineGroups = new Map(); // any combat message -> { at, count }
  }

  /** How many clients the feed currently looks duplicated by. */
  get copies() {
    return this._copies;
  }

  /** Feed one raw wakfu.log line (any line — non-combat ones are mostly ignored). */
  processLine(rawLine) {
    const line = String(rawLine);

    const join = line.match(FIGHTER_JOIN);
    if (join) {
      const [, fightId, name, aiControlled] = join;
      if (fightId !== this._fightId) {
        this._fightId = fightId;
        this._forgetFighters();
      }
      if (aiControlled === 'false') {
        this._allies.add(name.trim());
      } else if (this._pendingSummon) {
        this._addSummon(name.trim(), this._pendingSummon);
      }
      this._pendingSummon = null;
      return;
    }
    if (FIGHT_END.test(line)) {
      this._endFight();
      return;
    }

    const combat = line.match(COMBAT_PREFIX);
    if (!combat) return;
    const message = combat[1];
    if (this._isExtraCopy(message, logTimeMs(line))) return;
    this._pendingSummon = null; // the creature's join line comes right after its summon line

    if (COMBAT_END.test(message)) {
      this._endFight();
      return;
    }
    if (TURN_END.test(message)) {
      this._closeTurn();
      return;
    }

    const cast = message.match(CAST);
    if (cast) {
      const caster = cast[1].trim();
      this._lastSpell.set(caster, cast[2].trim());
      const actor = this.ownerOf(caster) ?? caster;
      if (this._turn?.characterName === actor) return;
      this._closeTurn();
      if (actor !== caster && this._lastTurn?.characterName === actor) {
        // A summon playing right after its summoner: same turn, same total.
        this._turn = this._lastTurn;
      } else {
        this._turn = { characterName: actor, turnId: this._nextTurnId++, total: 0 };
      }
      this._lastTurn = null;
      this._emit('start');
      return;
    }

    const invoke = message.match(INVOKE);
    if (invoke) {
      const owner = invoke[1].trim();
      const summon = { owner, spell: this._lastSpell.get(owner) ?? null };
      if (invoke[2]) this._addSummon(invoke[2].trim(), summon);
      // Named or not, the creature's join line follows: an Osamodas creature
      // is only named there.
      this._pendingSummon = summon;
      return;
    }

    const damage = message.match(DAMAGE);
    if (damage && this._turn) {
      const target = damage[1].trim();
      const amount = Number(damage[2].replace(/\D/g, ''));
      if (!amount) return;
      // Friendly fire only counts against allies hitting allies; a monster
      // hurting a player is that monster's damage.
      if (this.isAlly(this._turn.characterName) && this.isAlly(target)) return;
      this._turn.total += amount;
      this._emit('damage', { amount, target });
    }
  }

  isAlly(name) {
    if (this._allies.has(name) || this._isAllyExtra(name)) return true;
    const owner = this.ownerOf(name);
    return owner !== null && (this._allies.has(owner) || Boolean(this._isAllyExtra(owner)));
  }

  /** The fighter at the top of a summon chain (a summon's summon…), or null if not a summon. */
  ownerOf(name) {
    let owner = null;
    const seen = new Set();
    for (let s = this._summons.get(name); s && !seen.has(s.owner); s = this._summons.get(s.owner)) {
      seen.add(s.owner);
      owner = s.owner;
    }
    return owner;
  }

  /** The spell its summoner cast to bring it in (e.g. "Invocation", "Double"), or null. */
  summoningSpellOf(name) {
    return this._summons.get(name)?.spell ?? null;
  }

  /** The turn currently open, if any. */
  get currentTurn() {
    return this._turn ? { ...this._turn } : null;
  }

  // ── Private ──────────────────────────────────────────────────────────────

  /** True for a line that is just another client's copy of one already seen. */
  _isExtraCopy(message, now) {
    if (now === null) return false;

    // Raising takes a tight repeat (below). Lowering takes two different
    // casts in a row that no other client echoed within the window: a lagging
    // client's copy can come 0.5–0.8 s late, and it then looks like a lone
    // cast followed by a lone cast of the same spell.
    for (const [key, group] of this._castGroups) {
      if (!expired(group, now)) continue;
      this._castGroups.delete(key);
      if (group.count >= this._copies) {
        this._loneCast = null;
      } else if (this._loneCast !== null && this._loneCast !== key) {
        this._copies = group.count;
        this._loneCast = null;
      } else {
        this._loneCast = key;
      }
    }
    if (CAST.test(message)) {
      const group = this._castGroups.get(message) ?? { at: now, count: 0, provenCopies: 0 };
      group.count += 1;
      if (now - group.at <= CAST_COPY_PROOF_MS) group.provenCopies += 1;
      this._castGroups.set(message, group);
      this._copies = Math.max(this._copies, group.provenCopies);
    }

    if (this._lineGroups.size > MAX_GROUPS) {
      for (const [key, group] of this._lineGroups) {
        if (expired(group, now)) this._lineGroups.delete(key);
      }
    }
    let group = this._lineGroups.get(message);
    if (!group || expired(group, now)) {
      group = { at: now, count: 0 };
      this._lineGroups.set(message, group);
    }
    group.count += 1;
    return (group.count - 1) % this._copies !== 0;
  }

  _addSummon(name, { owner, spell }) {
    if (name === owner) return; // a monster duplicating itself isn't a summon chain
    this._summons.set(name, { owner, spell });
  }

  _closeTurn() {
    if (!this._turn) return;
    this._emit('end');
    this._lastTurn = this._turn;
    this._turn = null;
  }

  _forgetFighters() {
    this._allies.clear();
    this._summons.clear();
    this._lastSpell.clear();
    this._pendingSummon = null;
    this._lastTurn = null;
  }

  _endFight() {
    this._closeTurn();
    this._fightId = null;
    this._forgetFighters();
  }

  _emit(type, extra = {}) {
    const { characterName, turnId, total } = this._turn;
    this._onUpdate({ type, characterName, turnId, total, ...extra });
  }
}

module.exports = { CombatTurnTracker };
