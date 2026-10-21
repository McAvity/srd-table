/**
 * kenli F-007 T05: the "everything saved" condition before an update (contract offline.md §7.3).
 * Called with the admission gate already CLOSED: it waits for admitted mutations, the document
 * queues and the database write queue, flushes, and then checks explicitly — no failed save, no
 * conflict, no unsaved journal entry or day, no unsaved document or setting — plus the open UI
 * states and data states that must end first. A resolved `flushNow()` alone proves nothing.
 */

import {
  flushNow,
  recordSaved,
  savedHead,
  unsavedSettings,
  unsavedState,
  writesIdle,
} from "@/persistence/sync";
import { documentsIdle, useDocuments } from "@/store/documents";
import { useHistory } from "@/store/history";
import { useRolls } from "@/store/rolls";
import { admission, type Reason } from "./admission";

/** The open/data states that block an update now (no waiting, nothing written). */
export function blockers(): Reason[] {
  const out: Reason[] = admission.holds();
  const docs = useDocuments.getState();
  for (const e of Object.values(docs.encounters))
    if (e.encounter.pending) out.push({ code: "decision_pending", detail: e.name });
  for (const id of Object.keys(useRolls.getState().last))
    out.push({ code: "reroll_window_open", detail: docs.characters[id]?.build.name || id });
  return out;
}

/** Wait for everything started, flush, and say what isn't saved (`[]`: all saved). */
export async function savedReasons(timeoutMs = 10_000): Promise<Reason[]> {
  if (!(await admission.drain(timeoutMs)))
    return [{ code: "operation_in_flight", detail: String(admission.inFlight()) }];
  await documentsIdle();
  await writesIdle();
  try {
    await flushNow();
  } catch (error) {
    return [
      { code: "save_failed", detail: error instanceof Error ? error.message : String(error) },
    ];
  }
  await writesIdle();
  const out: Reason[] = [];
  const s = useHistory.getState().saveState;
  if (s.status === "failed") out.push({ code: "save_failed", detail: s.reason });
  if (s.status === "conflict") out.push({ code: "save_conflict", detail: s.records.join(", ") });
  const docs = useDocuments.getState();
  for (const id of Object.keys(docs.characters)) {
    if (savedHead(id).conflicted) out.push({ code: "save_conflict", detail: id });
    const u = unsavedState(id);
    if (u.entries || u.days || !recordSaved("characters", id))
      out.push({ code: "unsaved", detail: docs.characters[id]?.build.name || id });
  }
  for (const id of Object.keys(docs.encounters))
    if (!recordSaved("encounters", id))
      out.push({ code: "unsaved", detail: docs.encounters[id]?.name || id });
  if (unsavedSettings()) out.push({ code: "unsaved", detail: "settings" });
  return out;
}
