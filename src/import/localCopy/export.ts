/**
 * kenli F-007 T03: the local copy of a character — its state and whole journal — as one file
 * (contract local-copy.md §3). The source is never changed. Its document queue is held, the autosave
 * flushed, and only a saved, unconflicted character with nothing of its journal waiting is copied;
 * then ONE readonly transaction reads the record, its head, every journal row, the packs of its
 * context and the settings (and the encounters, for their names). Hashing and serializing happen
 * after it, outside any live transaction; the store is compared with what was read, so a change in
 * between is a refusal, never a file of two moments.
 */

import { type ContentContext, contentSha, type PackRef } from "@/lib/canonical";
import { fileSlug } from "@/lib/format";
import { isReleaseBuild, RELEASE_ID } from "@/offline/release";
import { db, packKey, type StoredCharacter, type StoredPack } from "@/persistence/db";
import { flushNow, installationId, savedHead, unsavedState } from "@/persistence/sync";
import { lockDocuments, useDocuments } from "@/store/documents";
import type { HistoryEntry, HistoryMeta } from "@/store/history";
import { useHistory } from "@/store/history";
import { readSettings } from "@/store/settings";
import { exportPack } from "../export";
import {
  asRefused,
  checkStructure,
  externalOf,
  ID,
  inheritedEncounterNames,
  LOCAL_COPY_FORMAT,
  LOCAL_COPY_LIMITS,
  type LocalCopy,
  type Payload,
  type Refused,
  refuse,
} from "./format";

/** The settings key a prepared legacy campaign context lives under (offline.md §5.3, written by T04). */
export const CAMPAIGN_CONTEXT_KEY = "offline.campaign-context.v1";

export interface ExportSummary {
  readonly name: string;
  readonly entries: number;
  readonly undone: number;
  readonly days: number;
  readonly long_rests: number;
  readonly packs: readonly PackRef[];
  readonly bytes: number;
  readonly legacy: boolean;
}

export type ExportResult =
  | {
      readonly ok: true;
      readonly blob: Blob;
      readonly fileName: string;
      readonly summary: ExportSummary;
      readonly copy: LocalCopy;
    }
  | Refused;

/** Fingerprint of campaign settings (offline.md §5.3): SHA-256 of JCS({packs, sources sorted|null}). */
export const settingsFingerprint = (packs: readonly string[], sources: readonly string[] | null) =>
  contentSha({
    packs: [...packs],
    sources: sources === null ? null : [...new Set(sources)].sort(),
  });

interface Snapshot {
  readonly record: StoredCharacter;
  readonly meta: HistoryMeta | null;
  readonly rows: readonly HistoryEntry[];
  readonly packs: ReadonlyMap<string, StoredPack>;
  readonly campaign: {
    readonly packs: readonly string[];
    readonly sources: readonly string[] | null;
  };
  readonly prepared: unknown;
  readonly encounters: ReadonlyMap<string, string>;
}

/** `<slug>-<YYYYMMDD-HHMM>.local-copy.json` (local time). */
export function localCopyFileName(name: string, fallback: string, at: number): string {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  return `${fileSlug(name, fallback)}-${stamp}.local-copy.json`;
}

/** What a prepared legacy context says, when its shape is right (else `null`). */
function preparedContext(v: unknown): { fingerprint: string; context: ContentContext } | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if (o.schema !== "srd-table.campaign-context/1" || typeof o.settings_fingerprint !== "string")
    return null;
  const c = o.context as ContentContext | undefined;
  if (!c || !Array.isArray(c.packs) || !(c.sources === null || Array.isArray(c.sources)))
    return null;
  return { fingerprint: o.settings_fingerprint, context: c };
}

export async function exportLocalCopy(recordId: string, now = Date.now()): Promise<ExportResult> {
  try {
    if (!Object.hasOwn(useDocuments.getState().characters, recordId))
      return refuse("source_missing", recordId);
    const snap = await lockDocuments([recordId], () => snapshot(recordId));
    return await build(recordId, snap, now);
  } catch (error) {
    return asRefused(error);
  }
}

/** Under the record's queue: flush, check it is saved, read everything in one readonly transaction. */
async function snapshot(recordId: string): Promise<Snapshot> {
  try {
    await flushNow();
  } catch (error) {
    refuse("source_unsaved", `failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const clean = () => {
    const s = useHistory.getState().saveState;
    if (s.status === "failed") refuse("source_unsaved", `failed: ${s.reason}`);
    if (s.status === "conflict") refuse("source_unsaved", "conflict");
    if (savedHead(recordId).conflicted) refuse("source_unsaved", "conflict");
    const u = unsavedState(recordId);
    if (u.entries > 0 || u.days)
      refuse("source_unsaved", `unsaved: ${u.entries} entries, days ${u.days}`);
  };
  clean();
  const database = await db();
  const tx = database.transaction(
    ["characters", "encounters", "history", "history_meta", "packs", "settings"],
    "readonly",
  );
  const record = await tx.objectStore("characters").get(recordId);
  if (!record) {
    await tx.done.catch(() => undefined);
    return refuse("source_missing", recordId);
  }
  const meta = (await tx.objectStore("history_meta").get(recordId)) ?? null;
  const rows = await tx
    .objectStore("history")
    .index("by_record_seq")
    .getAll(IDBKeyRange.bound([recordId, 0], [recordId, Number.MAX_SAFE_INTEGER]));
  const settings = readSettings(await tx.objectStore("settings").get("campaign"));
  const prepared = record.content
    ? null
    : await tx.objectStore("settings").get(CAMPAIGN_CONTEXT_KEY);
  const refs = record.content?.packs ?? preparedContext(prepared)?.context.packs ?? [];
  const packs = new Map<string, StoredPack>();
  for (const ref of refs) {
    const p = await tx.objectStore("packs").get(packKey(ref));
    if (p) packs.set(packKey(ref), p);
  }
  const encounters = new Map<string, string>();
  for (const e of await tx.objectStore("encounters").getAll()) encounters.set(e.id, e.name);
  await tx.done;
  // The snapshot is what this tab shows: same document revision, same saved head, nothing new.
  clean();
  const inStore = useDocuments.getState().characters[recordId];
  if (!inStore || (inStore.rev ?? 0) !== (record.rev ?? 0))
    refuse("source_unsaved", "changed while it was read");
  if (savedHead(recordId).rev !== (meta?.rev ?? null))
    refuse("source_unsaved", "its journal changed while it was read");
  return {
    record,
    meta,
    rows,
    packs,
    campaign: { packs: settings.packs, sources: settings.sources },
    prepared,
    encounters,
  };
}

/** Outside the transaction: the context, packs, external names, hash, bytes and the self-check. */
async function build(recordId: string, s: Snapshot, now: number): Promise<ExportResult> {
  const { record, meta, rows } = s;
  let context: ContentContext;
  let legacy: Payload["source"]["legacy_context"] = null;
  if (record.content) context = record.content;
  else {
    const prepared = preparedContext(s.prepared);
    const fingerprint = await settingsFingerprint(s.campaign.packs, s.campaign.sources);
    if (!prepared || prepared.fingerprint !== fingerprint)
      return refuse(
        "context_unprepared",
        prepared ? "the campaign settings changed since it was prepared" : "not prepared",
      );
    context = prepared.context;
    legacy = {
      settings_fingerprint: fingerprint,
      packs: [...s.campaign.packs],
      sources: s.campaign.sources === null ? null : [...s.campaign.sources],
    };
  }
  const pos = new Map(context.packs.map((p) => [p.id, p]));
  const packs = context.packs.map((ref) => {
    const stored =
      s.packs.get(packKey(ref)) ?? refuse("dependency_missing", `${ref.id}@${ref.version ?? ""}`);
    const req =
      (stored.files["manifest.json"] as { manifest?: { requires?: string[] } } | undefined)
        ?.manifest?.requires ?? [];
    const deps = req.map(
      (id) => pos.get(id) ?? refuse("dependency_missing", `${ref.id} requires ${id}`),
    );
    return exportPack(stored, deps, installationId());
  });
  if (!meta && rows.length) return refuse("history_head", "rows without a head");
  if (meta && rows.length !== meta.next_seq - 1)
    return refuse("history_head", `${rows.length} rows for next_seq ${meta.next_seq}`);
  if (rows.some((e, i) => e.record_id !== recordId || e.seq !== i + 1))
    return refuse("history_head", "rows out of order");
  const history = {
    schema: "kenli.history/1" as const,
    entry_count: rows.length,
    meta: meta ? structuredClone(meta) : null,
    entries: structuredClone(rows) as HistoryEntry[],
  };
  const external = externalOf(history, recordId);
  // §2.2: a live encounter here gives its current name; an external one only the name its record
  // inherited (canonical key); an external id is never looked up among this installation's encounters.
  const inherited = inheritedEncounterNames(record.origin);
  for (const e of external.encounters)
    e.name = ID.extEncounter.test(e.encounter_id)
      ? (inherited.get(e.encounter_id) ?? null)
      : (s.encounters.get(e.encounter_id) ?? null);
  const build = record.build as { name?: unknown };
  const payload: Payload = {
    source: {
      installation_id: installationId(),
      record_id: recordId,
      record_rev: Math.max(1, record.rev ?? 1),
      record_gen: record.gen ?? 0,
      history_rev: meta?.rev ?? 0,
      exported_at: now,
      release_id: isReleaseBuild(RELEASE_ID) ? RELEASE_ID : null,
      legacy_context: legacy,
    },
    character: {
      name: typeof build.name === "string" ? build.name : "",
      build: structuredClone(record.build) as Record<string, unknown>,
      state: structuredClone(record.state) as Record<string, unknown>,
      state_origin: { kind: "exported" },
      context: structuredClone(context),
      origin: record.origin ? structuredClone(record.origin) : null,
    },
    history,
    external,
    packs,
  };
  const copy: LocalCopy = {
    format: LOCAL_COPY_FORMAT,
    payload_sha256: await contentSha(payload),
    payload,
  };
  const text = JSON.stringify(copy);
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength > LOCAL_COPY_LIMITS.copyBytes)
    return refuse("limit_copy_bytes", `${bytes.byteLength} > ${LOCAL_COPY_LIMITS.copyBytes}`);
  // The file must be one this app imports: the same structural checks, on the bytes as written.
  await checkStructure(JSON.parse(text));
  const rests = rows.filter((e) => e.rest_kind === "long" && e.status === "done").length;
  return {
    ok: true,
    blob: new Blob([bytes], { type: "application/json" }),
    fileName: localCopyFileName(payload.character.name, recordId, now),
    copy,
    summary: {
      name: payload.character.name,
      entries: rows.length,
      undone: rows.filter((e) => e.status === "undone").length,
      days: meta?.days.length ?? 0,
      long_rests: rests,
      packs: context.packs,
      bytes: bytes.byteLength,
      legacy: !record.content,
    },
  };
}
