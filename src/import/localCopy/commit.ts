/**
 * kenli F-007 T03: a local copy written as a NEW character (contract local-copy.md §6, §7). The
 * whole file is checked again, then ONE readwrite transaction adds the packs it lacks (never
 * overwriting one, never other bytes for a pack version), the record, every journal entry and the
 * head — `add`, never `put`. A failure before it is done (a pack conflict, the quota, an abort)
 * writes nothing. Only after it is done is the copy shown and given to the autosave as saved
 * (`markCommitted`), so the autosave never takes it for unsaved nor writes an empty head over it.
 *
 * A failure after the transaction (the publication) is said as "saved, not shown — reload": no
 * rollback, no second copy. The plan keeps its `import_id`: confirming it again finds the copy in
 * the database (same transaction check) and only shows it.
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

/** Test seam (development builds only): make the publication after the transaction fail. */
export const localCopyFaults: { publish: (() => void) | null } = { publish: null };
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

/** The copy in the store and the autosave's baseline, in one synchronous step (no save between). */
async function publish(
  record: CharacterRecord,
  meta: HistoryMeta | null,
  packs: readonly StoredPack[],
): Promise<void> {
  if (import.meta.env.DEV) localCopyFaults.publish?.();
  await engine().registerPacks(packs.map((p) => p.files));
  // The store first: a failure between the two leaves a record the autosave can't overwrite
  // (compare-and-set), never a baseline without the record (which it would delete).
  useDocuments.getState().publishLocalCopy(record);
  if (meta) useHistory.getState().published([], [meta]);
  markCommitted({ characters: [record], encounters: [], meta: meta ? [meta] : [] });
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
  if (found && Object.hasOwn(useDocuments.getState().characters, record.id))
    return { ok: true, recordId: record.id, import_id: importId };
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
  try {
    await writeQueue(async () => {
      const database = await db();
      const tx = database.transaction(["characters", "history", "history_meta"], "readwrite");
      try {
        if (await tx.objectStore("characters").get(id)) refuse("redo_import_present", id);
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
    return storageRefusal(error);
  }
  try {
    await publish(last.record, last.meta, last.packs);
  } catch (error) {
    setLast({ ...last, state: "done" });
    return {
      ok: false,
      code: "publication_failed",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  setLast({ ...last, state: "done" });
  return { ok: true, recordId: id };
}
