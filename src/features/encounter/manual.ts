/**
 * Playing an action by hand (`manual`): a dice roller. The engine rolls what's declared (attack
 * rolls, damage, healing; a save effect's DC), with no target and no outcome; it spends the
 * resources (slots, uses, Recharge), not the action economy. Whoever is affected applies the
 * result. Which way a combatant plays by default is the GM's per-combatant setting, else the
 * campaign's default for its kind.
 */

import type { DeclaredResult, EncounterAction, OptionEntry, PlaySheet } from "srd-rules-engine";
import type { CombatantView } from "@/engine/facade";
import type { EncounterRecord } from "@/store/documents";
import type { CampaignSettings, PlayWay } from "@/store/settings";

/** The encounter actions the engine takes `manual: true` on. */
const MANUAL_ACTIONS: ReadonlySet<string> = new Set<DeclaredResult["action"]>([
  "attack",
  "unarmed",
  "cast",
  "feature",
  "save_action",
  "legendary",
]);

export function canPlayByHand(action: EncounterAction): boolean {
  return MANUAL_ACTIONS.has(action.type);
}

/**
 * The action as sent the chosen way (actions that can't be played by hand are sent as they are).
 * By hand it has no target: the engine's ready-made one, an area and cover are left out.
 */
export function playedAs(action: EncounterAction, way: PlayWay): EncounterAction {
  if (way !== "manual" || !canPlayByHand(action)) return action;
  const {
    target: _t,
    targets: _ts,
    area: _a,
    cover: _c,
    ...rest
  } = action as Record<string, unknown>;
  return { ...rest, manual: true } as EncounterAction;
}

/**
 * Does an option played by hand need the composer? Only for what by hand still asks: a slot
 * level, Cunning or Brutal Strike effects, an attack's riders or two-handed damage (from the
 * character's attack line). Targets, areas and cover don't apply.
 */
export function needsComposerByHand(entry: OptionEntry, sheet: PlaySheet | null): boolean {
  if (entry.slot_levels.length > 1 || entry.pact_slot !== null) return true;
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
