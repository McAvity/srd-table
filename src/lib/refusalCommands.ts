/**
 * kenli F-011 T04: the refusal commands as plain data (no store), so the copy codec — run outside
 * the app, in Node for T09's CLI — reads the same list as the journal (`store/history` re-exports it).
 */

/**
 * kenli F-011 contracts/changes.md §5: the player's explicit command a refused entry records.
 * Only the engine's rule refusals (`cause: "rules"`) of these commands are journaled.
 */
export type RefusalCommand =
  | "sheet_cast"
  | "sheet_attack"
  | "sheet_use"
  | "sheet_use_feature"
  | "sheet_activate"
  | "sheet_test"
  | "late_advantage"
  | "heroic_reroll"
  | "encounter_roll"
  | "encounter_action";
export const REFUSAL_COMMANDS: readonly RefusalCommand[] = [
  "sheet_cast",
  "sheet_attack",
  "sheet_use",
  "sheet_use_feature",
  "sheet_activate",
  "sheet_test",
  "late_advantage",
  "heroic_reroll",
  "encounter_roll",
  "encounter_action",
];
