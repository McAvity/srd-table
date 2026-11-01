/**
 * Playing an action by hand: a dice roller. The engine rolls what's declared (attack rolls,
 * damage, healing; a save effect's DC) with the encounter's free `roll` action: no target, no
 * outcome, nothing spent. The app tracks resources: it pays the roll's costs (slots, uses,
 * Recharge) with `spend` (the store's `rollAndPay`), never the action economy. Whoever is affected
 * applies the result. Which refusals count by hand is the app's policy (`byHandReasons`): the
 * engine lists every reason with its category. Which way a combatant plays by default is the GM's
 * per-combatant setting, else the campaign's default for its kind.
 */

import type {
  EncounterAction,
  OptionEntry,
  OptionReason,
  PlaySheet,
  RefusalCategory,
  RollWhat,
} from "srd-rules-engine";
import type { CombatantView } from "@/engine/facade";
import type { EncounterRecord } from "@/store/documents";
import type { CampaignSettings, PlayWay } from "@/store/settings";

/** What doesn't stop a roll by hand: the action economy, the turn, targets and movement. */
const IGNORED_BY_HAND: ReadonlySet<RefusalCategory> = new Set([
  "economy",
  "turn",
  "target",
  "movement",
]);

/** The option's reasons that still count when it's rolled by hand. */
export function byHandReasons(entry: Pick<OptionEntry, "reasons">): readonly OptionReason[] {
  return entry.reasons.filter((r) => !IGNORED_BY_HAND.has(r.category));
}

/**
 * kenli F-011 §5.3 (review03 R03-02): the refusal codes that mean the command isn't complete yet —
 * something only the player can still say (a target, an unknown or missing choice). A complete
 * command the rules refuse (a resource, the turn, the economy, range…) stays the player's attempt:
 * sent, refused by the engine and journaled, nothing spent or rolled.
 */
export const INCOMPLETE_CODES: ReadonlySet<string> = new Set([
  "incomplete",
  "unknown",
  "no_target",
]);
export function incompleteRefusal(codes: readonly string[]): boolean {
  return codes.some((c) => INCOMPLETE_CODES.has(c));
}

/**
 * What to roll for an action, as the `roll` action's `what`: the action's own fields, without its
 * actor, targets, area, cover or economy flags. `null` for an action that has no roll.
 */
export function rollOf(action: EncounterAction): RollWhat | null {
  switch (action.type) {
    case "attack":
      return {
        type: "attack",
        attack: action.attack,
        ...pick(action, [
          "mode",
          "two_handed",
          "riders",
          "light_extra",
          "cleave",
          "cunning",
          "brutal",
        ]),
      };
    case "unarmed":
      return { type: "unarmed", option: action.option, ...pick(action, ["save"]) };
    case "cast":
      return {
        type: "cast",
        spell: action.spell,
        ...pick(action, ["via", "slot_level", "pact", "mode", "damage_type", "triggers"]),
      };
    case "feature":
      return {
        type: "feature",
        feature: action.feature,
        ...pick(action, ["amount", "damage_type"]),
      };
    case "save_action":
      return { type: "save_action", ability: action.ability };
    case "legendary":
      return { type: "legendary", action: action.action, ...pick(action, ["attack", "mode"]) };
    default:
      return null;
  }
}

/** The fields of `object` among `keys` that are set. */
function pick<T extends object, K extends keyof T>(
  object: T,
  keys: readonly K[],
): Partial<Pick<T, K>> {
  const out: Partial<Pick<T, K>> = {};
  for (const k of keys) if (object[k] !== undefined) out[k] = object[k];
  return out;
}

/**
 * The action as sent the chosen way: by hand, an option the engine can roll (`rollable`) is sent
 * as `roll`; anything else is sent as it is.
 */
export function playedAs(
  action: EncounterAction,
  way: PlayWay,
  rollable: boolean,
): EncounterAction {
  const id = "id" in action && typeof action.id === "string" ? action.id : null;
  const what = way === "manual" && rollable && id !== null ? rollOf(action) : null;
  return what && id !== null ? { type: "roll", id, what } : action;
}

/**
 * Does an option played by hand need the composer? Only for what by hand still asks: a slot
 * level, Cunning or Brutal Strike effects, an attack's riders or two-handed damage (from the
 * character's attack line). Targets, areas and cover don't apply.
 */
export function needsComposerByHand(entry: OptionEntry, sheet: PlaySheet | null): boolean {
  if (entry.slot_levels.length > 1 || entry.pact_slot !== null) return true;
  // kenli F-011 (review03 R03-02): a leveled spell's slot — spent levels included — is chosen in
  // the form, by hand as in automatic play.
  if (entry.action.type === "cast" && (entry.action.slot_level ?? 0) > 0) return true;
  if (entry.strikes.length > 0) return true;
  const a = entry.action;
  if (a.type !== "attack" || !sheet) return false;
  const line = sheet.attacks.find((l) => l.name === a.attack);
  return Boolean(line && (line.riders.length > 0 || line.two_handed_damage_parts));
}

/** How a combatant plays its actions unless told otherwise. */
export function wayOf(
  record: EncounterRecord,
  combatant: Pick<CombatantView, "id" | "character">,
  settings: Pick<CampaignSettings, "character_play" | "monster_play">,
): PlayWay {
  return (
    record.modes?.[combatant.id] ??
    (combatant.character !== null ? settings.character_play : settings.monster_play)
  );
}
