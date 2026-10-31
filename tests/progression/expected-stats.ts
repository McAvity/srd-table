/**
 * kenli F-002 T03 R05-01: the checkpoint numbers of the positive fixtures, worked out by hand from
 * the SRD 5.2.1 rules and each fixture's own picks — not read from the engine. Shared by the Node
 * suite and the browser-worker parity probe, so a wrong mapping fails even where both agree.
 *
 * Fixed HP: level 1 = the Hit Die + CON mod; each later level = Hit Die / 2 + 1 + CON mod; a CON
 * change counts for every level. Initiative: Dex mod (+ Alert: the Proficiency Bonus). AC: the
 * build's starting equipment (no bought armor).
 */

export interface ExpectedLevel {
  readonly hp: number;
  readonly ac: number;
  readonly initiative: number;
  readonly pb: number;
  /** Class traits first gained at this level (the sheet's names). */
  readonly traits?: readonly string[];
  readonly slots?: readonly number[];
}

export const EXPECTED_STATS: Readonly<Record<string, readonly ExpectedLevel[]>> = {
  // Human Soldier Fighter, CON 14 (+2), DEX 14 (+2), Alert, starting Chain Mail (AC 16, no Dex).
  // HP 10+2 = 12, then +8 a level. Initiative 2 + PB.
  "fighter-1-6.plan.json": [
    {
      hp: 12,
      ac: 16,
      initiative: 4,
      pb: 2,
      traits: ["Second Wind", "Weapon Mastery", "Fighting Style"],
    },
    { hp: 20, ac: 16, initiative: 4, pb: 2, traits: ["Action Surge", "Tactical Mind"] },
    { hp: 28, ac: 16, initiative: 4, pb: 2, traits: ["Improved Critical", "Remarkable Athlete"] },
    { hp: 36, ac: 16, initiative: 4, pb: 2, traits: ["Ability Score Improvement"] },
    { hp: 44, ac: 16, initiative: 5, pb: 3, traits: ["Extra Attack", "Tactical Shift"] },
    { hp: 52, ac: 16, initiative: 5, pb: 3 },
  ],
  // The same Fighter, Ability Score Improvement CON +2 at 4: CON 16 (+3) for all 4 levels:
  // 10+3 + 3 × (6+3) = 40 (not 36): the earlier levels gain 1 each.
  "fighter-con-asi-1-4.plan.json": [
    { hp: 12, ac: 16, initiative: 4, pb: 2 },
    { hp: 20, ac: 16, initiative: 4, pb: 2 },
    { hp: 28, ac: 16, initiative: 4, pb: 2 },
    { hp: 40, ac: 16, initiative: 4, pb: 2, traits: ["Ability Score Improvement"] },
  ],
  // Elf Sage Wizard, CON 14 (+2), DEX 14 (+2), no armor: AC 10+2. HP 6+2, then +6. Alert at 4.
  // Full-caster slots: [2], [3], [4,2], [4,3], [4,3,2].
  "wizard-1-5.plan.json": [
    { hp: 8, ac: 12, initiative: 2, pb: 2, slots: [2] },
    { hp: 14, ac: 12, initiative: 2, pb: 2, slots: [3], traits: ["Scholar"] },
    {
      hp: 20,
      ac: 12,
      initiative: 2,
      pb: 2,
      slots: [4, 2],
      traits: ["Evocation Savant", "Potent Cantrip"],
    },
    { hp: 26, ac: 12, initiative: 4, pb: 2, slots: [4, 3] },
    { hp: 32, ac: 12, initiative: 5, pb: 3, slots: [4, 3, 2], traits: ["Memorize Spell"] },
  ],
  // Human Acolyte Sorcerer 1 → Bard 2, CON 13 (+1), DEX 14 (+2), Alert: HP 6+1, then 5+1 twice.
  // Multiclass caster level 3 (Sorcerer 1 + Bard 2): [4, 2].
  "sorcerer-bard-1-3.plan.json": [
    { hp: 7, ac: 12, initiative: 4, pb: 2, slots: [2] },
    { hp: 13, ac: 12, initiative: 4, pb: 2, slots: [3], traits: ["Bardic Inspiration"] },
    { hp: 19, ac: 12, initiative: 4, pb: 2, slots: [4, 2], traits: ["Jack of All Trades"] },
  ],
  // Human Acolyte Warlock, CON 13 (+1), DEX 14 (+2), Alert; Armor of Shadows (Mage Armor at will:
  // 13 + Dex = 15, better than the starting Leather Armor's 13). HP 8+1, then 5+1.
  "warlock-1-2.plan.json": [
    { hp: 9, ac: 15, initiative: 4, pb: 2, traits: ["Pact Magic", "Armor of Shadows"] },
    {
      hp: 15,
      ac: 15,
      initiative: 4,
      pb: 2,
      traits: ["Magical Cunning", "Agonizing Blast", "Devil's Sight"],
    },
  ],
};

/** Feature options (Eldritch Invocations) chosen by each level, by name. */
export const EXPECTED_FEATURE_OPTIONS: Readonly<Record<string, readonly (readonly string[])[]>> = {
  "warlock-1-2.plan.json": [
    ["Armor of Shadows"],
    ["Armor of Shadows", "Agonizing Blast", "Devil's Sight"],
  ],
};
