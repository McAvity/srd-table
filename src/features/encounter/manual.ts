/**
 * Playing an action by hand (`manual`): the engine checks it and spends its costs, rolls nothing
 * and applies nothing; the GM applies the outcome with effects. Which way a combatant plays by
 * default is the GM's per-combatant setting, else the campaign's default for its kind.
 */

import type { DeclaredResult, EncounterAction } from "srd-rules-engine";
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

/** The action as sent the chosen way (actions that can't be played by hand are sent as they are). */
export function playedAs(action: EncounterAction, way: PlayWay): EncounterAction {
  return way === "manual" && canPlayByHand(action)
    ? ({ ...action, manual: true } as EncounterAction)
    : action;
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
