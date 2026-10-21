/**
 * kenli F-007 T04: the start of the game data (contract offline.md §5.1). The update boot gate
 * (`update.ts`, T05) decides FIRST — before anything writes game data: `loadAll`'s migrations and
 * installation id, the stored packs' registration and the campaign catalog, the autosave and
 * `persistBundled`. Only an `open` gate starts them; any other answer leaves storage untouched.
 */

import { loadAll, persistBundled, startAutosave } from "@/persistence/sync";
import { type BootDecision, updateBootGate } from "./update";

export interface BootSteps {
  readonly gate: () => Promise<BootDecision>;
  readonly load: () => Promise<void>;
  /** Runs after the load (the locale) and before the autosave starts. */
  readonly afterLoad?: () => Promise<void>;
  readonly autosave: () => unknown;
  readonly bundled: () => Promise<unknown>;
}

const DEFAULT_STEPS: BootSteps = {
  gate: () => updateBootGate(),
  load: loadAll,
  autosave: startAutosave,
  bundled: persistBundled,
};

/** Gate, then (only when open) load, autosave and the served SRD in the background. */
export async function startGameData(steps: Partial<BootSteps> = {}): Promise<BootDecision> {
  const s = { ...DEFAULT_STEPS, ...steps };
  const decision = await s.gate();
  if (decision !== "open") return decision;
  await s.load();
  await s.afterLoad?.();
  s.autosave();
  // The served SRD into storage (kenli F-008 §9.5), after the start: never in the way of the app.
  void s.bundled();
  return decision;
}
