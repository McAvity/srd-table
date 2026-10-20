/**
 * The last roll shown for each character, while it can still be changed: Heroic Inspiration
 * rerolls a die of it, a luck-style resource gives it Advantage late, the table makes an attack a
 * Critical Hit. The window is the record's `rev`/`gen` when the roll was made (after its cost was
 * paid): any later change of the character, or an import replacing it, closes it
 * (`reroll_window_closed`). Kept in memory only: a reload closes it too (contract actions.md §5.5).
 *
 * The roll's numbers and the rules to change them are the engine's (`resolution` on the result);
 * this module only remembers which roll is the last one.
 */

import type {
  CharacterState,
  D20TestResult,
  PlaySheet,
  RolledDamage,
  RollResult,
  RollWhat,
} from "srd-rules-engine";
import { create } from "zustand";
import type { SheetRoll } from "@/engine/facade";

/** A record as it was: its revision and generation (`gen`, +1 when an import replaces it). */
export interface RecordVersion {
  readonly rev: number;
  readonly gen: number;
}

/** The record's version now (`rev`/`gen`, 0 when never set). */
export function versionOf(record: { readonly rev?: number; readonly gen?: number }): RecordVersion {
  return { rev: record.rev ?? 0, gen: record.gen ?? 0 };
}

/**
 * The window, and (kenli F-006) the journal operation of the roll as it is now and the group of the
 * roll it changes (`op`, `group`: a later change's parent and group).
 */
type Window = RecordVersion & { readonly op?: string; readonly group?: string };

/** What was rolled last for a character, with the window it can be changed in. */
export type LastRoll = Window &
  (
    | { readonly kind: "test"; readonly test: D20TestResult }
    | { readonly kind: "sheet"; readonly what: RollWhat; readonly roll: SheetRoll["roll"] }
    /** An attack line's damage rolled freely (`rollDamage`, nothing spent). */
    | { readonly kind: "damage"; readonly label: string; readonly damage: RolledDamage }
    | {
        readonly kind: "death_save";
        /** The d20 as rolled, and the state the save was made on (to make it again). */
        readonly die: RollResult;
        readonly before: CharacterState;
      }
  );

interface RollsState {
  last: Readonly<Record<string, LastRoll>>;
  remember(id: string, roll: LastRoll): void;
  forget(id: string): void;
}

export const useRolls = create<RollsState>()((set) => ({
  last: {},
  remember(id, roll) {
    set((s) => ({ last: { ...s.last, [id]: roll } }));
  },
  forget(id) {
    set((s) => {
      const { [id]: _gone, ...rest } = s.last;
      return { last: rest };
    });
  },
}));

/** The last roll of a record if its window is still open (same `rev` and `gen`), else `null`. */
export function openRoll(
  last: LastRoll | undefined,
  record: { readonly rev?: number; readonly gen?: number } | undefined,
): LastRoll | null {
  if (!last || !record) return null;
  return (record.rev ?? 0) === last.rev && (record.gen ?? 0) === last.gen ? last : null;
}

/**
 * The GM's additions a character's next rolls get on the sheet (`DmOptions`): kept until changed,
 * shown on the sheet while set. Plain values the engine reads; the UI adds nothing up.
 */
export interface RollAdditions {
  readonly mode_override?: "normal" | "advantage" | "disadvantage";
  readonly modifier?: number;
  readonly bonus_die?: string;
  readonly damage_modifier?: number;
  readonly damage_die?: string;
  readonly damage_type?: string;
  /**
   * A luck-style use spent for Advantage on the next D20 Test, attack or spell attack (declared
   * before the roll); cleared once it was spent.
   */
  readonly lucky?: string;
}

/** A luck-style use declared for Advantage: the use spent and the label of the Advantage. */
export interface DeclaredLucky {
  readonly use: string;
  readonly label: string;
}

/** The declared luck-style use of these additions, as the sheet lists it (else none). */
export function declaredLucky(
  a: RollAdditions | undefined,
  sheet: PlaySheet,
): DeclaredLucky | undefined {
  const use = a?.lucky ? sheet.play.uses.find((u) => u.key === a.lucky) : undefined;
  return use ? { use: use.key, label: use.name } : undefined;
}

/** After the declared use was spent: the same additions without it. */
export function luckySpent(id: string) {
  const { by, set } = useRollAdditions.getState();
  const a = by[id];
  if (a?.lucky) set(id, { ...a, lucky: undefined });
}

interface AdditionsState {
  by: Readonly<Record<string, RollAdditions>>;
  set(id: string, additions: RollAdditions): void;
}

export const useRollAdditions = create<AdditionsState>()((set) => ({
  by: {},
  set(id, additions) {
    set((s) => ({ by: { ...s.by, [id]: additions } }));
  },
}));

const GM = "GM";

/** The additions as the options of a D20 Test (`rollCheck`). */
export function testOptions(a: RollAdditions | undefined) {
  if (!a) return {};
  return {
    ...(a.mode_override ? { mode_override: { mode: a.mode_override, reason: GM } } : {}),
    ...(a.modifier ? { modifiers: [{ value: a.modifier, label: GM }] } : {}),
    ...(a.bonus_die ? { bonus_dice: [{ dice: a.bonus_die, label: GM }] } : {}),
  };
}

/** The additions as an attack's or spell's `dm` (`RollWhat.attack.dm`, `RollWhat.cast.dm`). */
export function attackDm(a: RollAdditions | undefined, withDamage = true) {
  const dm = {
    ...testOptions(a),
    ...(withDamage && a?.damage_modifier
      ? { damage_modifiers: [{ value: a.damage_modifier, label: GM }] }
      : {}),
    ...(withDamage && a?.damage_die && a.damage_type
      ? { damage_bonus_dice: [{ dice: a.damage_die, type: a.damage_type, label: GM }] }
      : {}),
  };
  return Object.keys(dm).length ? { dm } : {};
}
