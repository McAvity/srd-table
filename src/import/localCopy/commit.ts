/**
 * kenli F-007 T03: a local copy written as a NEW character (contract local-copy.md §6, §7). The
 * whole file is checked again, then ONE readwrite transaction adds the packs it lacks (never
 * overwriting one, never other bytes for a pack version), the record, every journal entry and the
 * head — `add`, never `put`. A failure before it is done (a pack conflict, the quota, an abort)
 * writes nothing. Only after it is done is the copy shown and given to the autosave as saved
 * (`markCommitted`), so the autosave never takes it for unsaved nor writes an empty head over it.
 *
 * A failure after the transaction (the publication) is said as "saved, not shown — reload": no
 * rollback of what was written, no second copy. The publication is all or nothing in memory
 * (R04-01): the record, its head and the autosave's baseline are set together, and a failure at
 * any step takes back what this attempt put in the store, so the app never shows a copy the
 * autosave doesn't know as saved. The plan keeps its `import_id`: confirming it again finds the
 * copy in the database (same transaction check) and publishes it whole; a copy already published
 * (and maybe played since) is left as it is.
 *
 * Undo/Redo of the last import is session-only: Undo deletes the copy with its journal while it is
 * unchanged since the import, Redo writes the same objects again. A reload ends the window.
 */

import { create } from "zustand";
import { engine } from "@/engine/client";
import { type PackRef, packRefOf } from "@/lib/canonical";
import { db, packKey, type StoredPack } from "@/persistence/db";
import {
  flushNow,
  forgetCommitted,
  isCommitted,
  markCommitted,
  unsavedState,
  writeQueue,
} from "@/persistence/sync";
import { type CharacterRecord, lockDocuments, newId, useDocuments } from "@/store/documents";
import { type HistoryEntry, type HistoryMeta, useHistory } from "@/store/history";
import {
  asRefused,
  checkStructure,
  checkWithEngine,
  localCopyOf,
  Refusal,
  type Refused,
  refuse,
} from "./format";
import { mapLocalCopy } from "./map";
import type { LocalCopyPlan } from "./plan";

export type CommitResult =
  | { readonly ok: true; readonly recordId: string; readonly import_id: string }
  | Refused
  | {
      readonly ok: "saved_unpublished";
      readonly recordId: string;
      readonly import_id: string;
      readonly detail: string;
    };

/** The steps of a publication, in order (the test seam names the one about to run). */
export type PublishStep = "packs" | "record" | "head" | "baseline";
/** Test seam (development builds only): make the publication after the transaction fail. */
export const localCopyFaults: { publish: ((step: PublishStep) => void) | null } = { publish: null };
if (import.meta.env.DEV)
  (globalThis as { __srdTableLocalCopyFaults?: typeof localCopyFaults }).__srdTableLocalCopyFaults =
    localCopyFaults;

interface LastImport {
  readonly import_id: string;
  readonly record: CharacterRecord;
  readonly meta: HistoryMeta | null;
  readonly entries: readonly HistoryEntry[];
  readonly packs: readonly StoredPack[];
  readonly state: "done" | "undone";
}

/** The session's last local-copy import (Undo/Redo), for the UI. */
export const useLocalCopySession = create<{ last: LastImport | null }>()(() => ({ last: null }));
const setLast = (last: LastImport | null) => useLocalCopySession.setState({ last });

function storageRefusal(error: unknown): Refused {
  if (error instanceof Refusal) return asRefused(error);
  const name = (error as { name?: string } | null)?.name;
  const detail = error instanceof Error ? error.message : String(error);
  if (name === "QuotaExceededError") return { ok: false, code: "storage_quota", detail };
  return { ok: false, code: "storage_failed", detail };
}

async function storedPacks(plan: LocalCopyPlan, now: number): Promise<StoredPack[]> {
  const out: StoredPack[] = [];
  for (const env of plan.copy.payload.packs) {
    const files = (env.content as { files: Record<string, unknown> }).files;
    const ref: PackRef = await packRefOf(files);
    out.push({
      key: packKey(ref),
      ref,
      files,
      installed_at: now,
      origin: { kind: "import", file: plan.file_name, bytes_sha256: plan.bytes_sha256 },
    });
  }
  return out;
}

/**
 * The copy in the store and the autosave's baseline (R04-01): the packs for the worker, then — in
 * one synchronous step, so no save runs between — the record, its head and the baseline. A failure
 * at any step takes back what this attempt published in memory (never the database), so the copy
 * is either shown and saved here or not shown at all, and a retry starts clean.
 */
async function publish(
  record: CharacterRecord,
  meta: HistoryMeta | null,
  packs: readonly StoredPack[],
): Promise<void> {
  const fault = (step: PublishStep) => {
    if (import.meta.env.DEV) localCopyFaults.publish?.(step);
  };
  fault("packs");
  await engine().registerPacks(packs.map((p) => p.files));
  if (Object.hasOwn(useDocuments.getState().characters, record.id))
    throw new Error(`${record.id} is already in this session`);
  try {
    fault("record");
    useDocuments.getState().publishLocalCopy(record);
    fault("head");
    if (meta) useHistory.getState().published([], [meta]);
    fault("baseline");
    markCommitted({ characters: [record], encounters: [], meta: meta ? [meta] : [] });
  } catch (error) {
    // Nothing of a half publication stays: the autosave would take the record for one it never
    // saved (a conflict) or a baseline without its record for a deletion.
    forgetCommitted([record.id]);
    useDocuments.getState().withdrawLocalCopy(record.id);
    useHistory.getState().saved({ entries: [], meta: [], dropped: [record.id] });
    throw error;
  }
}

/** A copy written by this import and already in the session: done (then never overwritten), or not. */
function alreadyPublished(recordId: string): "done" | "partial" | null {
  if (!Object.hasOwn(useDocuments.getState().characters, recordId)) return null;
  return isCommitted(recordId) ? "done" : "partial";
}

export async function commitLocalCopy(
  plan: LocalCopyPlan,
  options: { readonly confirmNewCopy?: boolean } = {},
): Promise<CommitResult> {
  // The whole file again (§4): the plan's copy may have been shown for a while.
  try {
    await checkStructure(structuredClone(plan.copy));
    await checkWithEngine(plan.copy);
  } catch (error) {
    return asRefused(error);
  }
  plan.import_id ??= newId("lc");
  const importId = plan.import_id;
  const now = Date.now();
  const packs = await storedPacks(plan, now);
  const mapped = mapLocalCopy(plan.copy, {
    bytesSha: plan.bytes_sha256,
    fileName: plan.file_name,
    importId,
    newId,
    now,
  });
  let existing: {
    record: CharacterRecord;
    meta: HistoryMeta | null;
    entries: HistoryEntry[];
  } | null = null;
  try {
    await writeQueue(async () => {
      const database = await db();
      const tx = database.transaction(
        ["packs", "characters", "history", "history_meta"],
        "readwrite",
      );
      try {
        const all = await tx.objectStore("characters").getAll();
        // §6.2.2: this plan's copy is already written (a retry after a failed publication).
        const retry = all.find((c) => localCopyOf(c.origin)?.import_id === importId);
        if (retry) {
          const meta = (await tx.objectStore("history_meta").get(retry.id)) ?? null;
          const entries = await tx
            .objectStore("history")
            .index("by_record_seq")
            .getAll(IDBKeyRange.bound([retry.id, 0], [retry.id, Number.MAX_SAFE_INTEGER]));
          existing = { record: retry as CharacterRecord, meta, entries };
          await tx.done;
          return;
        }
        const before = all.filter(
          (c) => c.origin?.kind === "import" && c.origin.sha256 === plan.copy.payload_sha256,
        );
        if (before.length && !options.confirmNewCopy)
          refuse("copy_already_imported", before.map((c) => c.id).join(","));
        const packStore = tx.objectStore("packs");
        for (const p of packs) {
          const prefix = `${p.ref.id}@${p.ref.version ?? ""}#`;
          const keys = (await packStore.getAllKeys(
            IDBKeyRange.bound(prefix, `${prefix}\uffff`),
          )) as string[];
          if (keys.some((k) => k !== p.key))
            refuse("pack_identity_conflict", `${p.ref.id}@${p.ref.version ?? ""}`);
          if (!keys.includes(p.key)) await packStore.add(p);
        }
        await tx.objectStore("characters").add(mapped.record);
        const history = tx.objectStore("history");
        for (const e of mapped.entries) await history.add(e);
        if (mapped.meta) await tx.objectStore("history_meta").add(mapped.meta);
        await tx.done;
      } catch (error) {
        try {
          tx.abort();
        } catch {
          // already finished
        }
        await tx.done.catch(() => undefined);
        throw error;
      }
    });
  } catch (error) {
    return storageRefusal(error);
  }
  const found = existing as {
    record: CharacterRecord;
    meta: HistoryMeta | null;
    entries: HistoryEntry[];
  } | null;
  const record = found?.record ?? mapped.record;
  const meta = found ? found.meta : mapped.meta;
  const entries = found?.entries ?? mapped.entries;
  if (found) {
    // A technical retry: a copy published before (and maybe played since) is left as it is.
    const shown = alreadyPublished(record.id);
    if (shown === "done") return { ok: true, recordId: record.id, import_id: importId };
    if (shown === "partial")
      return {
        ok: "saved_unpublished",
        recordId: record.id,
        import_id: importId,
        detail: "shown but not saved here: reload the app",
      };
  }
  try {
    await publish(record, meta, packs);
  } catch (error) {
    return {
      ok: "saved_unpublished",
      recordId: record.id,
      import_id: importId,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  setLast({ import_id: importId, record, meta, entries, packs, state: "done" });
  return { ok: true, recordId: record.id, import_id: importId };
}

export async function undoLocalCopyImport(): Promise<
  { readonly ok: true; readonly recordId: string } | Refused
> {
  const last = useLocalCopySession.getState().last;
  if (last?.state !== "done") return { ok: false, code: "undo_import_gone", detail: "" };
  const id = last.record.id;
  try {
    return await lockDocuments([id], async () => {
      await flushNow();
      const rec = useDocuments.getState().characters[id];
      if (!rec) return refuse("undo_import_gone", id);
      const u = unsavedState(id);
      if ((rec.rev ?? 0) !== 1 || u.entries > 0 || u.days)
        return refuse("undo_import_changed", "the copy changed since the import");
      await writeQueue(async () => {
        const database = await db();
        const tx = database.transaction(["characters", "history", "history_meta"], "readwrite");
        try {
          const row = await tx.objectStore("characters").get(id);
          if (!row) refuse("undo_import_gone", id);
          if ((row?.rev ?? 0) !== 1)
            refuse("undo_import_changed", "the copy changed since the import");
          const head = await tx.objectStore("history_meta").get(id);
          if ((head?.rev ?? null) !== (last.meta ? 1 : null))
            refuse("undo_import_changed", "its journal changed since the import");
          const index = tx.objectStore("history").index("by_record_seq");
          const range = IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]);
          for (let c = await index.openCursor(range); c; c = await c.continue()) await c.delete();
          await tx.objectStore("history_meta").delete(id);
          await tx.objectStore("characters").delete(id);
          await tx.done;
        } catch (error) {
          try {
            tx.abort();
          } catch {
            // already finished
          }
          await tx.done.catch(() => undefined);
          throw error;
        }
      });
      forgetCommitted([id]);
      useDocuments.getState().withdrawLocalCopy(id);
      useHistory.getState().saved({ entries: [], meta: [], dropped: [id] });
      setLast({ ...last, state: "undone" });
      return { ok: true as const, recordId: id };
    });
  } catch (error) {
    return storageRefusal(error);
  }
}

export async function redoLocalCopyImport(): Promise<
  { readonly ok: true; readonly recordId: string } | Refused
> {
  const last = useLocalCopySession.getState().last;
  if (last?.state !== "undone") return { ok: false, code: "undo_import_gone", detail: "" };
  const id = last.record.id;
  if (alreadyPublished(id) === "done") {
    setLast({ ...last, state: "done" });
    return { ok: true, recordId: id };
  }
  try {
    await writeQueue(async () => {
      const database = await db();
      const tx = database.transaction(["characters", "history", "history_meta"], "readwrite");
      try {
        const row = await tx.objectStore("characters").get(id);
        if (row) {
          // A retry after a failed publication: only this Redo's own copy, exactly as it wrote it —
          // the document AND the journal head (or no head for an empty journal) unchanged, the
          // same paired compare-and-set as the autosave and Undo. Another tab's change to either
          // half refuses it: a reload shows the newer data, nothing stale is published.
          const head = await tx.objectStore("history_meta").get(id);
          if (
            localCopyOf(row.origin)?.import_id !== last.import_id ||
            (row.rev ?? 0) !== (last.record.rev ?? 0) ||
            (head?.rev ?? null) !== (last.meta?.rev ?? null)
          )
            refuse("redo_import_present", "changed since this Redo wrote it: reload the app");
          await tx.done;
          return;
        }
        await tx.objectStore("characters").add(last.record);
        for (const e of last.entries) await tx.objectStore("history").add(e);
        if (last.meta) await tx.objectStore("history_meta").add(last.meta);
        await tx.done;
      } catch (error) {
        try {
          tx.abort();
        } catch {
          // already finished
        }
        await tx.done.catch(() => undefined);
        throw error;
      }
    });
  } catch (error) {
    const refused = storageRefusal(error);
    // Changed meanwhile by another tab: this session's Redo is over (a reload shows the copy).
    if (refused.code === "redo_import_present") setLast(null);
    return refused;
  }
  if (alreadyPublished(id) === "partial")
    return { ok: false, code: "publication_failed", detail: "shown but not saved here: reload" };
  try {
    await publish(last.record, last.meta, last.packs);
  } catch (error) {
    // Written again but not shown: Redo stays offered (it only shows the written copy) and a
    // reload shows it too.
    return {
      ok: false,
      code: "publication_failed",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  setLast({ ...last, state: "done" });
  return { ok: true, recordId: id };
}
