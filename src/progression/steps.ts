/**
 * kenli F-002 T03: the next step of a compiled plan for a character at `level` (what T04's preview
 * shows and its advance applies): the checkpoint of `level + 1` with its readable ops and changes.
 * Pure: reads a `compilePlan` result, changes nothing.
 */

import type { PlanCheckpoint, PlanCompileResult } from "@/engine/plans";

export type NextStep =
  | { readonly kind: "step"; readonly from: number; readonly to: PlanCheckpoint }
  /** The character is at the plan's last level. */
  | { readonly kind: "done"; readonly level: number }
  | {
      readonly kind: "refused";
      readonly code: "plan_not_compiled" | "plan_level_out_of_range";
      readonly detail: string;
    };

export function nextStep(result: PlanCompileResult, level: number): NextStep {
  if (!result.ok)
    return { kind: "refused", code: "plan_not_compiled", detail: result.problem.code };
  if (!Number.isInteger(level) || level < 1 || level > result.range.to)
    return {
      kind: "refused",
      code: "plan_level_out_of_range",
      detail: `${level} outside 1–${result.range.to}`,
    };
  if (level === result.range.to) return { kind: "done", level };
  const to = result.checkpoints[level];
  if (!to || to.level !== level + 1)
    return {
      kind: "refused",
      code: "plan_level_out_of_range",
      detail: `no checkpoint ${level + 1}`,
    };
  return { kind: "step", from: level, to };
}
