/**
 * characterMatcher.js
 * Matches log-detected character names with your heroes configuration.
 */

'use strict';

class CharacterMatcher {
  static SPELL_TO_CLASS = {
    'Flèche d\'immolation': 'Cra',
    'Flèche lumineuse': 'Cra',
    'Revitalisation': 'Eniripsa',
    'Vivification': 'Eniripsa',
    'Saignée mortelle': 'Sram',
    'Premier Sang': 'Sram',
    'Fourberie': 'Sram',
  };

  /**
   * Match a log-detected character name against your heroes list.
   *
   * @param {string} logCharacterName - Character name from Wakfu logs.
   * @param {object[]} heroConfigs - Heroes from heroes.json.
   * @param {object} [options] - Optional matching options.
   * @param {object<string, string|number>} [options.characterMap] - Map of characterName -> hero name or hero index.
  * @param {string} [options.combatSpellName] - Spell name captured from combat logs.
   * @param {boolean} [options.strict] - If true, stop after exact name/alias matches and never
   *   fall back to fuzzy class-substring matching. Use this whenever the input name could belong
   *   to someone other than your own tracked characters (e.g. any fighter from a combat log line),
   *   since the fuzzy tiers below can false-positive on unrelated names containing a class word.
   * @returns {number|null} Index of matching hero, or null if not found.
   */
  static findHeroIndexByName(logCharacterName, heroConfigs, options = {}) {
    if (!logCharacterName) return null;

    const normalizedName = String(logCharacterName).trim();
    const logNameNorm = this._normalizeName(normalizedName);

    // Highest priority: explicit mapping from settings.characterMap
    const explicitTarget = this._findExplicitTarget(normalizedName, options.characterMap);
    if (explicitTarget !== null) {
      if (typeof explicitTarget === 'number' && explicitTarget >= 0 && explicitTarget < heroConfigs.length) {
        return explicitTarget;
      }

      const mappedName = this._normalizeName(String(explicitTarget));
      const mappedIndex = heroConfigs.findIndex((hero) =>
        this._normalizeName(String(hero.name || '')).includes(mappedName)
      );
      if (mappedIndex !== -1) return mappedIndex;
    }

    // Strong match: explicit character aliases per hero
    let match = heroConfigs.findIndex((hero) => {
      const aliases = this._heroAliases(hero);
      return aliases.some((alias) => this._normalizeName(alias) === logNameNorm);
    });
    if (match !== -1) return match;

    // First try: exact case-insensitive match on hero name
    match = heroConfigs.findIndex(
      (hero) => this._normalizeName(hero.name).includes(logNameNorm)
    );
    if (match !== -1) return match;

    if (options.strict) return null;

    // Second try: match the class name extracted from log
    // Example: "Héros 1 — Iop" contains "Iop", match by class
    const extractedClass = this._extractClassName(logCharacterName);
    if (extractedClass) {
      match = heroConfigs.findIndex((hero) => {
        const heroNameLower = hero.name.toLowerCase();
        return heroNameLower.includes(extractedClass.toLowerCase());
      });
      if (match !== -1) return match;
    }

    // Third try: infer class from combat spell name and match hero by class in name/profile path.
    const inferredClass = this._classFromCombatSpell(options.combatSpellName);
    if (inferredClass) {
      match = heroConfigs.findIndex((hero) => {
        const heroNameLower = this._normalizeName(String(hero.name || ''));
        const profileLower = this._normalizeName(String(hero.profile || ''));
        const clsLower = this._normalizeName(inferredClass);
        return heroNameLower.includes(clsLower) || profileLower.includes(clsLower);
      });
      if (match !== -1) return match;
    }

    return null;
  }

  /**
   * Extract the class name from a character name.
   * Example: "MyCharIop" or "My Iop" -> "Iop"
   *
   * @private
   * @param {string} characterName
   * @returns {string|null}
   */
  static _extractClassName(characterName) {
    const classes = [
      'Iop', 'Eniripsa', 'Osamodas', 'Ecaflip', 'Enutrof',
      'Sram', 'Xelor', 'Sadida', 'Sacrieur', 'Pandawa',
      'Roublard', 'Steamer', 'Cra', 'Eliotrope', 'Huppermage',
      'Ouginak', 'Zobal',
    ];

    // Try to find any class name (case-insensitive)
    for (const cls of classes) {
      if (characterName.toLowerCase().includes(cls.toLowerCase())) {
        return cls;
      }
    }

    return null;
  }

  static _heroAliases(hero) {
    const aliases = [];
    if (hero.characterName) aliases.push(String(hero.characterName));
    if (Array.isArray(hero.characterAliases)) {
      aliases.push(...hero.characterAliases.map((x) => String(x)));
    }
    return aliases;
  }

  static _findExplicitTarget(characterName, characterMap) {
    if (!characterMap || typeof characterMap !== 'object') return null;
    const lower = this._normalizeName(characterName);

    for (const [key, value] of Object.entries(characterMap)) {
      if (this._normalizeName(key) === lower) {
        return value;
      }
    }

    return null;
  }

  static _classFromCombatSpell(combatSpellName) {
    if (!combatSpellName) return null;
    const spellLower = String(combatSpellName).toLowerCase().trim();

    for (const [spell, cls] of Object.entries(this.SPELL_TO_CLASS)) {
      if (spell.toLowerCase() === spellLower) return cls;
    }

    return null;
  }

  static _normalizeName(value) {
    return String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }
}

module.exports = { CharacterMatcher };
