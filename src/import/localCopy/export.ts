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
import { CAMPAIGN_CONTEXT_KEY, parsePrepared, settingsFingerprint } from "@/offline/campaign";

export { CAMPAIGN_CONTEXT_KEY, settingsFingerprint };

import { engine } from "@/engine/client";
import {
  checkImageBytes,
  decodeChecked,
  imageDecoder,
  PORTRAIT_LIMITS,
  PortraitError,
  type PortraitMime,
  sniff,
  toBase64,
} from "@/lib/image";
import { admission, UPDATE_IN_PROGRESS } from "@/offline/admission";
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
  type CopyPortrait,
  checkProgressionWith,
  checkStructure,
  externalOf,
  HISTORY_CONTAINER,
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

export interface ExportSummary {
  readonly name: string;
  readonly entries: number;
  readonly undone: number;
  readonly days: number;
  readonly long_rests: number;
  readonly packs: readonly PackRef[];
  readonly bytes: number;
  readonly legacy: boolean;
  /** The portrait carried (`null`: none). */
  readonly portrait: { readonly mime: PortraitMime; readonly bytes: number } | null;
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
  /** The portrait Blob read in the same transaction (kenli F-011 §3.2), `null`: none. */
  readonly portrait: Blob | null;
}

/** `<slug>-<YYYYMMDD-HHMM>.local-copy.json` (local time). */
export function localCopyFileName(name: string, fallback: string, at: number): string {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  return `${fileSlug(name, fallback)}-${stamp}.local-copy.json`;
}

/** What a prepared legacy context says, when its shape is right (else `null`). */
/** The stored prepared legacy context (kenli F-007 T04 `parsePrepared`: one reader for all). */
function preparedContext(v: unknown): { fingerprint: string; context: ContentContext } | null {
  const p = parsePrepared(v);
  return p ? { fingerprint: p.settings_fingerprint, context: p.context } : null;
}

async function exportLocalCopyNow(recordId: string, now = Date.now()): Promise<ExportResult> {
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
    ["characters", "encounters", "history", "history_meta", "packs", "settings", "portraits"],
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
  // kenli F-011 §3.2: the portrait as it is with this very record revision (a portrait write is a
  // revision of the record, §3.1, so the pair can't be torn).
  const portrait = (await tx.objectStore("portraits").get(recordId)) ?? null;
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
    portrait,
  };
}

/**
 * kenli F-011 §3.2: the stored portrait as a copy carries it. Its type is its bytes' (never
 * `Blob.type`: WebKit may store PNG for an asked WebP); over 5 MiB, or an old type (GIF, SVG,
 * AVIF, HEIC…) is refused with what to do — the Blob stays as it is, nothing is converted or left
 * out. Then the same checks as an import, its full decode included.
 */
async function portraitOfBlob(blob: Blob | null): Promise<CopyPortrait | null> {
  if (!blob) return null;
  if (blob.size > PORTRAIT_LIMITS.bytes)
    refuse(
      "limit_portrait_bytes",
      "Portrait is larger than 5 MiB. Choose a smaller image in the portrait editor and export again.",
    );
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const kind = sniff(bytes);
  if (kind !== "png" && kind !== "jpeg" && kind !== "webp")
    refuse(
      "portrait_unsupported_stored",
      `This portrait's format (${kind}) isn't supported. Choose a PNG, JPEG or WebP version in the portrait editor and export again.`,
    );
  try {
    const head = checkImageBytes(bytes);
    await decodeChecked(bytes, head.mime, head, imageDecoder());
    return { mime: head.mime, bytes: bytes.length, base64: toBase64(bytes) };
  } catch (error) {
    if (error instanceof PortraitError) return refuse(error.code, error.detail);
    throw error;
  }
}

/** Outside the transaction: the context, packs, external names, hash, bytes and the self-check. */
/**
 * kenli F-011 §2.3: a record's origin as a copy carries it — an earlier copy's origin keeps its
 * external names but not its own origin (`source_origin: null`), so origins never chain up.
 */
function flatOrigin(origin: StoredCharacter["origin"]): Payload["character"]["origin"] {
  if (!origin) return null;
  const o = structuredClone(origin);
  if (o.kind === "import" && o.extensions && Object.hasOwn(o.extensions, "local_copy")) {
    const lc = o.extensions.local_copy as Record<string, unknown> | null;
    if (lc && typeof lc === "object")
      return {
        ...o,
        extensions: { ...o.extensions, local_copy: { ...lc, source_origin: null } },
      };
  }
  return o;
}

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
    schema: HISTORY_CONTAINER as typeof HISTORY_CONTAINER,
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
  const portrait = await portraitOfBlob(s.portrait);
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
      producer: null,
    },
    character: {
      name: typeof build.name === "string" ? build.name : "",
      build: structuredClone(record.build) as Record<string, unknown>,
      state: structuredClone(record.state) as Record<string, unknown>,
      state_origin: { kind: "exported" },
      context: structuredClone(context),
      origin: flatOrigin(record.origin),
      portrait,
      // kenli F-002 T07 (§9): the plan as the record keeps it, or `null` (an ordinary character).
      progression: record.progression
        ? (structuredClone(record.progression) as Payload["character"]["progression"])
        : null,
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
  // …and its plan the one an import accepts (read whole, the character's packs, its checkpoint):
  // a character changed outside its plan is refused here, before a file that can't come back.
  await checkProgressionWith(
    payload.character.progression,
    payload.character.build,
    context,
    packs.map((e) => ({ id: e.id, sha256: e.sha256 })),
    engine(),
  );
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
      portrait: portrait ? { mime: portrait.mime, bytes: portrait.bytes } : null,
    },
  };
}

/** kenli F-007 T05 (offline.md §7.3): an entry point of the admission gate. */
export function exportLocalCopy(
  ...args: Parameters<typeof exportLocalCopyNow>
): ReturnType<typeof exportLocalCopyNow> {
  return admission.guard(
    "localCopy.export",
    () => exportLocalCopyNow(...args),
    () => ({ ok: false, code: UPDATE_IN_PROGRESS, detail: "" }) as const,
  );
}
