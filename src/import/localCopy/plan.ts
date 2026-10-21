/**
 * kenli F-007 T03: the preview of a local copy before anything is written (contract local-copy.md
 * §5): who it is and where it came from, its state, its journal (done/undone, days, Long Rests),
 * its packs here (new, already installed, in conflict), its size, and whether this very copy was
 * imported before (then only an explicit "another separate copy" goes on). Reads only.
 */

import { engine } from "@/engine/client";
import { type PackRef, packRefOf } from "@/lib/canonical";
import { db, packKey } from "@/persistence/db";
import { useDocuments } from "@/store/documents";
import type { LocalCopy } from "./format";

export interface LocalCopyDay {
  readonly id: string;
  readonly n: number;
  readonly label: string | null;
  readonly long_rests: number;
}

export interface LocalCopyPlan {
  readonly copy: LocalCopy;
  readonly bytes_sha256: string;
  readonly file_name: string;
  /** The file's size in bytes (`null`: not given). */
  readonly size: number | null;
  readonly summary: {
    readonly name: string;
    readonly installation_id: string;
    readonly exported_at: number;
    readonly release_id: string | null;
    readonly legacy: boolean;
    readonly hp: { readonly current: number; readonly max: number } | null;
    readonly entries: { readonly total: number; readonly done: number; readonly undone: number };
    readonly days: readonly LocalCopyDay[];
    readonly long_rests: number;
    readonly pending_historical: number;
  };
  readonly packs: {
    readonly new: readonly PackRef[];
    readonly present: readonly PackRef[];
    readonly conflict: readonly PackRef[];
  };
  /** Characters here made from this very copy (same `payload_sha256`). */
  readonly already_imported: readonly string[];
  /**
   * Made on the first confirmation and kept: a technical retry of this plan finds the copy it
   * already wrote instead of writing a second one (§6.3). A new plan is a new import.
   */
  import_id: string | null;
}

export async function planLocalCopy(
  copy: LocalCopy,
  bytesSha: string,
  fileName: string,
  options: { readonly size?: number } = {},
): Promise<LocalCopyPlan> {
  const p = copy.payload;
  const entries = p.history.entries;
  const restsByDay = new Map<string, number>();
  let rests = 0;
  for (const e of entries)
    if (e.rest_kind === "long" && e.status === "done") {
      rests += 1;
      restsByDay.set(e.day_id, (restsByDay.get(e.day_id) ?? 0) + 1);
    }
  const keys = new Set((await (await db()).getAllKeys("packs")) as string[]);
  const packs = { new: [] as PackRef[], present: [] as PackRef[], conflict: [] as PackRef[] };
  for (const env of p.packs) {
    const ref = await packRefOf((env.content as { files: Record<string, unknown> }).files);
    const prefix = `${ref.id}@${ref.version ?? ""}#`;
    if (keys.has(packKey(ref))) packs.present.push(ref);
    else if ([...keys].some((k) => k.startsWith(prefix))) packs.conflict.push(ref);
    else packs.new.push(ref);
  }
  let hp: LocalCopyPlan["summary"]["hp"] = null;
  try {
    const view = await engine().playSheet(
      p.character.build as never,
      p.character.state as never,
      p.character.context,
    );
    hp = { current: view.sheet.play.hp.current, max: view.sheet.play.hp.max };
  } catch {
    hp = null; // shown without it; the validator already read the documents
  }
  const already = Object.values(useDocuments.getState().characters)
    .filter((c) => c.origin?.kind === "import" && c.origin.sha256 === copy.payload_sha256)
    .map((c) => c.id);
  return {
    copy,
    bytes_sha256: bytesSha,
    file_name: fileName,
    size: options.size ?? null,
    summary: {
      name: p.character.name,
      installation_id: p.source.installation_id,
      exported_at: p.source.exported_at,
      release_id: p.source.release_id,
      legacy: p.source.legacy_context !== null,
      hp,
      entries: {
        total: entries.length,
        done: entries.filter((e) => e.status === "done").length,
        undone: entries.filter((e) => e.status === "undone").length,
      },
      days: (p.history.meta?.days ?? []).map((d) => ({
        id: d.id,
        n: d.n,
        label: d.label,
        long_rests: restsByDay.get(d.id) ?? 0,
      })),
      long_rests: rests,
      pending_historical: entries.filter((e) => e.pending_decision).length,
    },
    packs,
    already_imported: already,
    import_id: null,
  };
}
