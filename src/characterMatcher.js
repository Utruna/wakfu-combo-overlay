/**
 * characterMatcher.js
 * Matches log-detected character names with your heroes configuration.
 */

'use strict';

class CharacterMatcher {
  /**
   * Match a log-detected character name against your heroes list.
   *
   * @param {string} logCharacterName - Character name from Wakfu logs.
   * @param {object[]} heroConfigs - Heroes from heroes.json.
   * @returns {number|null} Index of matching hero, or null if not found.
   */
  static findHeroIndexByName(logCharacterName, heroConfigs) {
    if (!logCharacterName) return null;

    const logNameLower = logCharacterName.toLowerCase().trim();

    // First try: exact case-insensitive match on hero name
    let match = heroConfigs.findIndex(
      (hero) => hero.name.toLowerCase().includes(logNameLower)
    );
    if (match !== -1) return match;

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
}

module.exports = { CharacterMatcher };
