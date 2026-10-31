/**
 * kenli F-002 T04: a character's optional progression metadata (dnd5 contracts/progression.md
 * §4.3) and the state policy of a planned step (§8). Pure: no store, no database, no worker.
 *
 * `StoredCharacter.progression`: `null`/absent = an ordinary character; otherwise the plan file
 * (without its pack envelopes — the packs live in the `packs` store), the level applied and the
 * prefix hash of that level. It is read strictly each time it's used (`readProgression`); an
 * unsupported value is never stripped — the record stays as it is and planned actions refuse it.
 */

import type { CharacterState } from "srd-rules-engine";
import { canonicalJson } from "@/lib/canonical";
import { type PlanFile, parsePlanFile } from "./codec";

export const PROGRESSION_SCHEMA = "srd-table.progression/1";

export interface ProgressionMeta {
  readonly schema: typeof PROGRESSION_SCHEMA;
  /** The plan file as bound, without `packs` envelopes (canonical: its own `plan_sha256`). */
  readonly plan: Omit<PlanFile, "packs">;
  /** The character level this record is at in the plan (`characterLevel(build)` at commit). */
  readonly applied_level: number;
  /** `prefix_sha256` of the checkpoint `applied_level` (contract §4.1). */
  readonly prefix_sha256: string;
  readonly bound_at: number;
}

export type ProgressionRead =
  | { readonly ok: true; readonly progression: ProgressionMeta | null }
  | { readonly ok: false; readonly code: "progression_unsupported"; readonly detail: string };

const HEX64 = /^[0-9a-f]{64}$/;
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * A stored `progression` read whole: absent or `null` → none; otherwise exactly the §4.3 fields,
 * the plan file valid by the plan codec (its hash included) and `applied_level` inside its range.
 */
export async function readProgression(raw: unknown): Promise<ProgressionRead> {
  if (raw === undefined || raw === null) return { ok: true, progression: null };
  const bad = (detail: string): ProgressionRead => ({
    ok: false,
    code: "progression_unsupported",
    detail,
  });
  if (!isObj(raw)) return bad("not an object");
  const keys = ["schema", "plan", "applied_level", "prefix_sha256", "bound_at"];
  for (const k of Object.keys(raw)) if (!keys.includes(k)) return bad(`unknown field ${k}`);
  for (const k of keys) if (!Object.hasOwn(raw, k)) return bad(`missing ${k}`);
  if (raw.schema !== PROGRESSION_SCHEMA) return bad(`schema ${String(raw.schema)}`);
  if (isObj(raw.plan) && Object.hasOwn(raw.plan, "packs")) return bad("plan carries envelopes");
  const parsed = await parsePlanFile(raw.plan);
  if (!parsed.ok) return bad(`plan: ${parsed.problem.code} ${parsed.problem.detail}`);
  const level = raw.applied_level;
  if (typeof level !== "number" || !Number.isInteger(level) || level < 1 || level > parsed.range.to)
    return bad(`applied_level ${String(level)} outside 1–${parsed.range.to}`);
  if (typeof raw.prefix_sha256 !== "string" || !HEX64.test(raw.prefix_sha256))
    return bad("prefix_sha256");
  if (typeof raw.bound_at !== "number" || !Number.isInteger(raw.bound_at) || raw.bound_at < 0)
    return bad("bound_at");
  return { ok: true, progression: raw as unknown as ProgressionMeta };
}

/** The plan file to keep on a record: the same document without its pack envelopes. */
export function planWithoutPacks(file: PlanFile): Omit<PlanFile, "packs"> {
  const { packs: _packs, ...rest } = file;
  return rest;
}

// ───────────────────────── state policy (§8) ─────────────────────────

/**
 * §8.2: renamed limited-use keys whose spent count is carried over on a planned step. Application
 * policy, not plan data; each entry needs its own test. Empty: no rename is known — an unknown
 * change is refused, never zeroed.
 */
export const SPENT_KEY_RENAMES: readonly {
  readonly from: string;
  readonly to: string;
  readonly when: { readonly class_id: string; readonly class_level: number };
  readonly reason: string;
}[] = [];

/** Why a reconciled state would differ from the saved one (§8: refused, with the paths). */
export type StateLoss = "state_changed" | "spent_lost" | "state_choice_lost" | "hp_changed";

export interface StateDifference {
  readonly path: string;
  readonly code: StateLoss;
  readonly before: unknown;
  readonly after: unknown;
}

const SPENT = new Set(["hit_dice_spent", "spell_slots_spent", "pact_slots_spent", "uses_spent"]);

/** Every leaf where `after` differs from `before` (objects by key, arrays whole). */
function leaves(
  before: unknown,
  after: unknown,
  path: string,
  out: { path: string; before: unknown; after: unknown }[],
) {
  if (isObj(before) && isObj(after)) {
    for (const k of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort())
      leaves(before[k], after[k], path ? `${path}.${k}` : k, out);
    return;
  }
  if (canonicalJson(before ?? null) !== canonicalJson(after ?? null))
    out.push({ path, before: before ?? null, after: after ?? null });
}

/**
 * §8: the reconciled state must be canonically the saved one. Every difference is classified
 * (spent counts, rest choices, HP, anything else) so a refusal names what would be lost.
 */
export function stateDifferences(
  saved: CharacterState,
  reconciled: CharacterState,
): StateDifference[] {
  const raw: { path: string; before: unknown; after: unknown }[] = [];
  leaves(saved, reconciled, "", raw);
  return raw.map((d) => {
    const top = d.path.split(".")[0] ?? "";
    const code: StateLoss = SPENT.has(top)
      ? "spent_lost"
      : top === "choices"
        ? "state_choice_lost"
        : top === "hp"
          ? "hp_changed"
          : "state_changed";
    return { ...d, code };
  });
}
