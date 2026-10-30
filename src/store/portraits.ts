/**
 * Portraits: images players upload for their characters (the SRD has no art). App-only data in
 * IndexedDB, next to the documents and never inside them; shown as object URLs.
 *
 * kenli F-011 T04 (contracts/changes.md §3.1, §3.5): a portrait write is a revision of its record —
 * in the record's queue, after a flush, ONE transaction compares the record's `rev` with the one
 * this tab saved (another tab changed it: refused, nothing written), writes `rev + 1` and the Blob
 * (or its deletion) together, and only then shows it and gives it to the autosave as saved. So an
 * import's Undo (which needs `rev` 1) can never delete a portrait changed since, in any tab. A new
 * image is checked raw before any decoder (`prepareUpload`); a refusal keeps the old portrait.
 */

import { create } from "zustand";
import { type PortraitError, prepareUpload } from "@/lib/image";
import { admission, UPDATE_IN_PROGRESS } from "@/offline/admission";
import { db } from "@/persistence/db";
import { flushNow, markCommitted, recordSaved, savedHead, writeQueue } from "@/persistence/sync";
import { type CharacterRecord, lockDocuments, useDocuments } from "@/store/documents";

export type PortraitResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: string; readonly detail: string };

interface PortraitsState {
  /** Object URL by character id; `null`: none stored; missing: not loaded yet. */
  urls: Readonly<Record<string, string | null>>;
  load(id: string): Promise<void>;
  set(id: string, file: Blob): Promise<PortraitResult>;
  remove(id: string): Promise<PortraitResult>;
  /** A Blob a transaction elsewhere wrote for this record (an import, a Redo): show it. */
  adopt(id: string, blob: Blob | null): void;
  /** A record gone (an import's Undo): its URL released. */
  forget(id: string): void;
}

const blocked = (): PortraitResult => ({ ok: false, code: UPDATE_IN_PROGRESS, detail: "" });

export const usePortraits = create<PortraitsState>()((set, get) => ({
  urls: {},
  async load(id) {
    if (id in get().urls) return;
    set((s) => ({ urls: { ...s.urls, [id]: null } }));
    const blob = await (await db()).get("portraits", id);
    if (blob && get().urls[id] === null)
      set((s) => ({ urls: { ...s.urls, [id]: URL.createObjectURL(blob) } }));
  },
  // kenli F-007 T05 (offline.md §7.3): portraits change only while the admission gate is open.
  set(id, file) {
    return admission.guard("portraits.set", () => setNow(id, file), blocked);
  },
  remove(id) {
    return admission.guard("portraits.remove", () => writePortrait(id, null), blocked);
  },
  adopt(id, blob) {
    const old = get().urls[id];
    if (old) URL.revokeObjectURL(old);
    set((s) => ({ urls: { ...s.urls, [id]: blob ? URL.createObjectURL(blob) : null } }));
  },
  forget(id) {
    const old = get().urls[id];
    if (old) URL.revokeObjectURL(old);
    set((s) => {
      const { [id]: _gone, ...urls } = s.urls;
      return { urls };
    });
  },
}));

async function setNow(id: string, file: Blob): Promise<PortraitResult> {
  let prepared: Awaited<ReturnType<typeof prepareUpload>>;
  try {
    prepared = await prepareUpload(file);
  } catch (error) {
    const e = error as PortraitError;
    return { ok: false, code: e.code ?? "portrait_invalid", detail: e.detail ?? String(error) };
  }
  return writePortrait(id, prepared.blob);
}

/** Test seam: a step of a portrait write (development builds and tests only). */
export const portraitFaults: { beforeTransaction: (() => Promise<void>) | null } = {
  beforeTransaction: null,
};

/** §3.1: the record's next revision and the Blob (or none) in one transaction. */
async function writePortrait(id: string, blob: Blob | null): Promise<PortraitResult> {
  try {
    return await lockDocuments([id], async () => {
      await flushNow();
      const mine = useDocuments.getState().characters[id];
      if (!mine) return { ok: false, code: "document_gone", detail: id } as const;
      if (!recordSaved("characters", id) || savedHead(id).conflicted)
        return {
          ok: false,
          code: "portrait_unsaved",
          detail: "the character isn't saved",
        } as const;
      const next: CharacterRecord = { ...mine, rev: (mine.rev ?? 0) + 1, updated: Date.now() };
      const written = await writeQueue(async () => {
        await portraitFaults.beforeTransaction?.();
        const database = await db();
        const tx = database.transaction(["characters", "portraits"], "readwrite");
        try {
          const row = await tx.objectStore("characters").get(id);
          if (!row) throw Object.assign(new Error(id), { code: "document_gone" });
          if ((row.rev ?? 0) !== (mine.rev ?? 0))
            throw Object.assign(new Error(`${row.rev ?? 0} ≠ ${mine.rev ?? 0}`), {
              code: "portrait_record_changed",
            });
          await tx.objectStore("characters").put(next);
          if (blob) await tx.objectStore("portraits").put(blob, id);
          else await tx.objectStore("portraits").delete(id);
          await tx.done;
          return true;
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
      if (!written) return { ok: false, code: "portrait_failed", detail: "" } as const;
      // Shown and saved together, synchronously: no autosave runs in between.
      useDocuments.getState().publishRevision(next);
      markCommitted({ characters: [next], encounters: [] });
      usePortraits.getState().adopt(id, blob);
      return { ok: true } as const;
    });
  } catch (error) {
    // Our refusals carry a string code; a DOMException's `code` is a legacy number (22: quota).
    const code = (error as { code?: unknown }).code;
    const name = (error as { name?: string }).name;
    return {
      ok: false,
      code:
        typeof code === "string"
          ? code
          : name === "QuotaExceededError"
            ? "storage_quota"
            : "storage_failed",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}
