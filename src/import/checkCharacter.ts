/**
 * kenli F-011 T04 (contracts/changes.md §2.5): the F-004 checks of a character's documents on an
 * injected engine — the browser's worker (`engine()`) or Node's in-process `nodeFacade` (T09's CLI).
 * Pure: no worker, DOM or IndexedDB here. Nothing is written.
 */

import type { CharacterBuild, CharacterState } from "srd-rules-engine";
import type { EngineFacade } from "@/engine/facade";
import type { ContentContext } from "@/lib/canonical";
import { changedFields, droppedFields } from "@/lib/files";

/** What the checks need of an engine (the facade's own methods, so any facade fits). */
export type CharacterChecker = Pick<
  EngineFacade,
  "checkContent" | "parseBuild" | "evaluate" | "parseState" | "validateState" | "reconcileState"
>;

export interface CheckProblem {
  readonly code: string;
  readonly detail: string;
}
const problem = (code: string, detail = ""): CheckProblem => ({ code, detail });
const contextCode = (reasons: readonly string[]) =>
  reasons.some((r) => r.includes("context_unavailable"))
    ? "context_unavailable"
    : "context_invalid";

/**
 * Nothing dropped by the parse, the build valid with its content, the state valid for it and
 * unchanged by `reconcileState` (spent HP, slots, uses and the inventory are the table's).
 */
export async function checkCharacterWith(
  f: CharacterChecker,
  rawBuild: unknown,
  rawState: unknown | null,
  content: ContentContext | null,
): Promise<{
  build: CharacterBuild | null;
  state: CharacterState | null;
  problems: CheckProblem[];
}> {
  const ctx = content ?? undefined;
  const problems: CheckProblem[] = [];
  if (content) {
    const ok = await f.checkContent(content);
    if (!ok.ok)
      return {
        build: null,
        state: null,
        problems: [problem(contextCode(ok.reasons), ok.reasons.join("; "))],
      };
  }
  const parsed = await f.parseBuild(rawBuild);
  if (!parsed.ok)
    return {
      build: null,
      state: null,
      problems: [problem("build_invalid", parsed.reasons.join("; "))],
    };
  const lostBuild = droppedFields(rawBuild, parsed.build);
  if (lostBuild.length) problems.push(problem("fields_dropped", lostBuild.join(", ")));
  const view = await f.evaluate(parsed.build, ctx);
  const buildErrors = view.report.issues.filter((i) => i.severity === "error");
  if (buildErrors.length)
    problems.push(problem("build_invalid", buildErrors.map((i) => i.message).join("; ")));
  if (rawState === null || problems.length) return { build: parsed.build, state: null, problems };
  const ps = await f.parseState(rawState);
  if (!ps.ok)
    return {
      build: parsed.build,
      state: null,
      problems: [problem("state_invalid", ps.reasons.join("; "))],
    };
  const lostState = droppedFields(rawState, ps.state);
  if (lostState.length) problems.push(problem("fields_dropped", lostState.join(", ")));
  const stateErrors = (await f.validateState(parsed.build, ps.state, ctx)).filter(
    (i) => i.severity === "error",
  );
  if (stateErrors.length)
    problems.push(problem("state_invalid", stateErrors.map((i) => i.message).join("; ")));
  if (!problems.length) {
    const fitted = await f.reconcileState(parsed.build, ps.state, ctx);
    const changed = changedFields(ps.state, fitted.state);
    if (changed.length) problems.push(problem("state_would_change", changed.join(", ")));
  }
  return { build: parsed.build, state: ps.state, problems };
}
