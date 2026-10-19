/**
 * How a d20 roll's dice read on screen: each die as rolled, and the value it counts as when the
 * engine changed it (a floor: Silver Tongue, Reliable Talent, a pack's `d20_floors`), with the
 * engine's label: `1 → 10 (Silver Tongue)`. Nothing is computed here: the changes are the engine's
 * own list (`D20TestResult.floors`, `{label, from, to}`, one per raised die in the order rolled),
 * and the kept die is the engine's `kept`. A die nothing changed reads as rolled.
 */

import type { AppliedFloor, D20Roll } from "srd-rules-engine";

export interface DieFace {
  /** As rolled. */
  readonly raw: number;
  /** What it counts as (the same as `raw` when nothing changed it). */
  readonly effective: number;
  /** Why it counts as more: the engine's label, or `null` when the result names none. */
  readonly label: string | null;
  /** The die the total uses (with Advantage or Disadvantage, the other one is discarded). */
  readonly kept: boolean;
}

/**
 * The faces of a d20 roll. `applied`: the engine's raised dice for this roll (a sheet's D20 Test,
 * after a reroll too). A result without that list (an encounter check) still says when its kept
 * die counts as more than rolled (`natural` → `d20`), without a label.
 */
export function d20Faces(roll: D20Roll, applied?: readonly AppliedFloor[]): DieFace[] {
  const queue = [...(applied ?? [])];
  return roll.rolls.map((raw, i) => {
    const kept = i === roll.kept;
    // The engine lists raised dice in the order rolled: the next one for this value is this die's.
    const at = queue.findIndex((f) => f.from === raw && f.to > raw);
    if (at >= 0) {
      const [f] = queue.splice(at, 1) as [AppliedFloor];
      return { raw, effective: f.to, label: f.label, kept };
    }
    if (!applied && kept && roll.d20 !== raw)
      return { raw, effective: roll.d20, label: null, kept };
    return { raw, effective: raw, label: null, kept };
  });
}
