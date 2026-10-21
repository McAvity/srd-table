/**
 * kenli F-007 T04: readiness and preparation for offline play (contract offline.md §5.3–§5.5).
 *
 * `checkReadiness(target)` says, for one character or one encounter (its world and every member of
 * its party — one ready character proves nothing about an encounter), what this device has now:
 * the app release complete (the service worker's own inspection) and this page controlled by it;
 * every exact pack of the context registered here and whole (no network); for a legacy record the
 * prepared campaign context matching the current settings; the record parsed; its journal head,
 * document and settings saved by the autosave, without a failed save or a conflict. `ready` only
 * when all of it holds. The browser's storage protection is shown apart and never changes it.
 *
 * `prepareOffline(target)` is the explicit preparation (and its retry): the CURRENT release through
 * `prepareCurrentRelease()` (register if needed, inspect, repair the same release in place — never
 * another release); the campaign context of a legacy record (each served pack read whole, hashed,
 * stored, its exact ref kept — an existing other version is never replaced: `pack_identity_conflict`;
 * once prepared for these settings the binding is kept, a retry only restores its own exact refs);
 * a pinned record's served packs when the host still has those exact bytes (anything else is a
 * missing pack, to bring with the importer — never a library prefetch); the storage protection; a
 * flush; then a fresh check. Each write is one transaction: a cancel, a full storage or a failure
 * keeps everything already there (characters, history, packs).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { engine } from "@/engine/client";
import {
  type ContentContext,
  contextKey,
  type PackFiles,
  type PackRef,
  sha256Hex,
} from "@/lib/canonical";
import { db, packKey, type StoredPack } from "@/persistence/db";
import {
  flushNow,
  recordSaved,
  registerStoredPacks,
  savedHead,
  unsavedSettings,
  unsavedState,
  writeQueue,
} from "@/persistence/sync";
import { characterKeysOf, useDocuments } from "@/store/documents";
import { useHistory } from "@/store/history";
import { useSettings } from "@/store/settings";
import {
  CAMPAIGN_CONTEXT_KEY,
  CAMPAIGN_CONTEXT_SCHEMA,
  configureCampaign,
  matchingContext,
  type PreparedCampaign,
  setPreparedCampaign,
  settingsFingerprint,
} from "./campaign";
import {
  type Inspection,
  inspectRelease,
  isReleaseBuild,
  prepareCurrentRelease,
  RELEASE_ID,
  releaseOfScriptUrl,
} from "./release";
import {
  askPersistence,
  type Persisted,
  STORAGE_KEY,
  setStorageState,
  storageState,
} from "./storage";

export type Target = { readonly kind: "character" | "encounter"; readonly id: string };
export type ReadinessStatus = "checking" | "preparing" | "ready" | "incomplete" | "failed";
export type ItemStatus = "ok" | "missing" | "corrupt" | "pending" | "failed";

export interface ReadinessItem {
  readonly kind: "app" | "pack" | "record" | "history" | "save" | "party";
  readonly id: string;
  readonly status: ItemStatus;
  /** A machine code (`reload_to_finish`, `context_unavailable`, `unsaved`…) or `null`. */
  readonly detail: string | null;
}

export interface Readiness {
  readonly schema: "srd-table.readiness/1";
  readonly record_id: string;
  readonly release_id: string;
  readonly release_complete: boolean;
  readonly context_key_sha256: string | null;
  readonly legacy_settings_fingerprint: string | null;
  readonly items: readonly ReadinessItem[];
  readonly storage: { readonly persisted: Persisted | null };
  readonly status: Exclude<ReadinessStatus, "preparing">;
  readonly checked_at: number;
}

export const readinessKey = (recordId: string) => `offline.readiness.v1:${recordId}`;

/** The release this page runs and its service worker (replaced in tests). */
export interface ReleaseApi {
  readonly releaseId: string;
  readonly isRelease: boolean;
  inspect(): Promise<Inspection>;
  prepare(): Promise<Inspection>;
  /** The release of the worker controlling this page (`null`: none). */
  controller(): string | null;
}

const browserRelease: ReleaseApi = {
  releaseId: RELEASE_ID,
  isRelease: isReleaseBuild(),
  inspect: () => inspectRelease(),
  prepare: () => prepareCurrentRelease(),
  controller: () =>
    typeof navigator !== "undefined"
      ? releaseOfScriptUrl(navigator.serviceWorker?.controller?.scriptURL)
      : null,
};
let release: ReleaseApi = browserRelease;
/** Tests: another release API (`null`: the browser's). */
export function setReleaseApi(api: ReleaseApi | null): void {
  release = api ?? browserRelease;
  lastInspection = null;
}

/** The release inspection of this session (re-read on an explicit check or preparation). */
let lastInspection: Inspection | null = null;

class PrepareError extends Error {
  constructor(
    readonly code: string,
    readonly detail = "",
  ) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

// ───────────────────────── the check ─────────────────────────

async function appItem(fresh: boolean): Promise<{ item: ReadinessItem; complete: boolean }> {
  const id = release.releaseId;
  if (!release.isRelease)
    return {
      item: { kind: "app", id, status: "failed", detail: "release_dev_build" },
      complete: false,
    };
  if (fresh || !lastInspection) {
    try {
      lastInspection = await release.inspect();
    } catch (error) {
      lastInspection = { release_id: id, complete: false, missing: [String(error)] };
    }
  }
  const ins = lastInspection;
  if (!ins.complete) {
    const missing = ins.missing.slice(0, 5).join(", ") || "incomplete";
    return { item: { kind: "app", id, status: "missing", detail: missing }, complete: false };
  }
  // Prepared, but this page isn't controlled by it yet (the first registration doesn't claim).
  if (release.controller() !== id)
    return {
      item: { kind: "app", id, status: "pending", detail: "reload_to_finish" },
      complete: true,
    };
  return { item: { kind: "app", id, status: "ok", detail: null }, complete: true };
}

/** The content a record (or an encounter's world) plays with, and whether it is the campaign's. */
async function contextOf(
  content: ContentContext | undefined,
): Promise<{ context: ContentContext | null; legacy: boolean }> {
  if (content) return { context: content, legacy: false };
  const { packs, sources } = useSettings.getState().settings;
  return { context: await matchingContext({ packs, sources }), legacy: true };
}

async function packItems(context: ContentContext | null): Promise<ReadinessItem[]> {
  if (!context)
    return [{ kind: "pack", id: "campaign", status: "missing", detail: "campaign_unprepared" }];
  const items: ReadinessItem[] = [];
  for (const ref of context.packs) {
    const r = await engine().localPackFiles(ref);
    items.push({
      kind: "pack",
      id: packKey(ref),
      status: r.ok ? "ok" : r.code === "pack_corrupt" ? "corrupt" : "missing",
      detail: r.ok ? null : r.code,
    });
  }
  return items;
}

function saveItem(store: "characters" | "encounters", id: string): ReadinessItem {
  const s = useHistory.getState().saveState;
  if (s.status === "failed") return { kind: "save", id, status: "failed", detail: "save_failed" };
  if ((s.status === "conflict" && s.records.includes(id)) || savedHead(id).conflicted)
    return { kind: "save", id, status: "failed", detail: "save_conflict" };
  if (!recordSaved(store, id)) return { kind: "save", id, status: "pending", detail: "unsaved" };
  if (unsavedSettings()) return { kind: "save", id, status: "pending", detail: "settings_unsaved" };
  return { kind: "save", id, status: "ok", detail: null };
}

async function characterItems(id: string): Promise<{
  items: ReadinessItem[];
  context: ContentContext | null;
  legacy: boolean;
}> {
  const record = useDocuments.getState().characters[id];
  if (!record)
    return {
      items: [{ kind: "record", id, status: "missing", detail: "record_missing" }],
      context: null,
      legacy: false,
    };
  const { context, legacy } = await contextOf(record.content);
  const items: ReadinessItem[] = [{ kind: "record", id, status: "ok", detail: null }];
  items.push(...(await packItems(context)));
  const meta = useHistory.getState().meta[id];
  const u = unsavedState(id);
  const headSaved = !meta || savedHead(id).rev === meta.rev;
  items.push(
    headSaved && u.entries === 0 && !u.days
      ? { kind: "history", id, status: "ok", detail: null }
      : { kind: "history", id, status: "pending", detail: u.days ? "days_unsaved" : "unsaved" },
  );
  items.push(saveItem("characters", id));
  return { items, context, legacy };
}

function statusOf(items: readonly ReadinessItem[]): Readiness["status"] {
  if (items.some((i) => i.status === "failed")) return "failed";
  if (items.some((i) => i.status === "missing" || i.status === "corrupt")) return "incomplete";
  if (items.some((i) => i.status === "pending")) return "checking";
  return "ready";
}

/** What this device has now for a character or an encounter (nothing is written). */
export async function checkReadiness(
  target: Target,
  options: { readonly fresh?: boolean } = {},
): Promise<Readiness> {
  const app = await appItem(options.fresh ?? false);
  const items: ReadinessItem[] = [app.item];
  let context: ContentContext | null = null;
  let legacy = false;
  if (target.kind === "character") {
    const c = await characterItems(target.id);
    items.push(...c.items);
    context = c.context;
    legacy = c.legacy;
  } else {
    const record = useDocuments.getState().encounters[target.id];
    if (!record)
      items.push({ kind: "record", id: target.id, status: "missing", detail: "record_missing" });
    else {
      const world = await contextOf(record.content);
      context = world.context;
      legacy = world.legacy;
      items.push({ kind: "record", id: target.id, status: "ok", detail: null });
      items.push(...(await packItems(world.context)));
      items.push(saveItem("encounters", target.id));
      // The whole party: each member ready on its own content (no promise for anyone else).
      for (const key of characterKeysOf(record.encounter)) {
        const member = await characterItems(key);
        const bad = member.items.find((i) => i.status !== "ok");
        items.push({
          kind: "party",
          id: key,
          status: bad?.status ?? "ok",
          detail: bad ? `${bad.kind}:${bad.detail ?? bad.status}` : null,
        });
      }
    }
  }
  const { packs, sources } = useSettings.getState().settings;
  return {
    schema: "srd-table.readiness/1",
    record_id: target.id,
    release_id: release.releaseId,
    release_complete: app.complete,
    context_key_sha256: context ? await sha256Hex(contextKey(context)) : null,
    legacy_settings_fingerprint: legacy ? await settingsFingerprint(packs, sources) : null,
    items,
    storage: { persisted: storageState()?.persisted ?? null },
    status: statusOf(items),
    checked_at: Date.now(),
  };
}

// ───────────────────────── the preparation ─────────────────────────

/**
 * Store verified pack files (one transaction, with an optional settings value): a missing row is
 * added; a row of the same exact identity that didn't verify is written again with these verified
 * bytes; another hash for the same `(id, version)` refuses the whole write
 * (`pack_identity_conflict`): nothing replaced, nothing written.
 */
async function storePacks(
  packs: readonly { readonly ref: PackRef; readonly files: PackFiles }[],
  extra?: { readonly key: string; readonly value: unknown },
): Promise<void> {
  const local = await Promise.all(packs.map((p) => engine().localPackFiles(p.ref)));
  const now = Date.now();
  const rows: StoredPack[] = packs.map((p) => ({
    key: packKey(p.ref),
    ref: p.ref,
    files: p.files,
    installed_at: now,
    origin: { kind: "bundled" },
  }));
  const written: StoredPack[] = [];
  await writeQueue(async () => {
    const database = await db();
    const tx = database.transaction(["packs", "settings"], "readwrite");
    try {
      const store = tx.objectStore("packs");
      for (const [i, row] of rows.entries()) {
        const prefix = `${row.ref.id}@${row.ref.version ?? ""}#`;
        const keys = (await store.getAllKeys(IDBKeyRange.bound(prefix, `${prefix}￿`))) as string[];
        if (keys.some((k) => k !== row.key))
          throw new PrepareError(
            "pack_identity_conflict",
            `${row.ref.id}@${row.ref.version ?? ""}`,
          );
        if (keys.includes(row.key) && local[i]?.ok) continue;
        await store.put(row);
        written.push(row);
      }
      if (extra) await tx.objectStore("settings").put(extra.value, extra.key);
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
  if (written.length) await registerStoredPacks(written);
}

const aborted = (signal?: AbortSignal) => {
  if (signal?.aborted) throw new PrepareError("cancelled");
};

/** The campaign context of legacy records: every served pack whole, its exact ref kept. */
async function prepareCampaign(signal?: AbortSignal): Promise<void> {
  const { packs, sources } = useSettings.getState().settings;
  const served: { ref: PackRef; files: PackFiles }[] = [];
  for (const id of packs) {
    try {
      served.push(await engine().servedPackFiles(id));
    } catch (error) {
      throw new PrepareError(
        "network",
        `${id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    aborted(signal);
  }
  const prepared: PreparedCampaign = {
    schema: CAMPAIGN_CONTEXT_SCHEMA,
    settings_fingerprint: await settingsFingerprint(packs, sources),
    packs: [...packs],
    sources: sources === null ? null : [...sources],
    context: { packs: served.map((s) => s.ref), sources: sources === null ? null : [...sources] },
    prepared_at: Date.now(),
    release_id: release.isRelease ? release.releaseId : null,
  };
  aborted(signal);
  await storePacks(served, { key: CAMPAIGN_CONTEXT_KEY, value: prepared });
  setPreparedCampaign(prepared);
  await configureCampaign({ packs, sources });
}

/**
 * A pinned context's packs: one not here is stored from the host only when the host serves those
 * exact bytes (the SRD served with the app); any other is left missing (bring it with Import…).
 */
async function storeServedExact(context: ContentContext, signal?: AbortSignal): Promise<void> {
  for (const ref of context.packs) {
    if ((await engine().localPackFiles(ref)).ok) continue;
    let served: { ref: PackRef; files: PackFiles } | null = null;
    try {
      served = await engine().servedPackFiles(ref.id);
    } catch {
      served = null; // not served (or offline): stays missing
    }
    aborted(signal);
    if (served && served.ref.sha256 === ref.sha256) await storePacks([served]);
  }
}

/** The contexts a target needs: a legacy one (the campaign's) and pinned ones. */
function needs(target: Target): { legacy: boolean; pinned: ContentContext[] } {
  const docs = useDocuments.getState();
  const pinned: ContentContext[] = [];
  let legacy = false;
  const add = (content: ContentContext | undefined) => {
    if (content) pinned.push(content);
    else legacy = true;
  };
  if (target.kind === "character") {
    const c = docs.characters[target.id];
    if (c) add(c.content);
  } else {
    const e = docs.encounters[target.id];
    if (e) {
      add(e.content);
      for (const key of characterKeysOf(e.encounter)) {
        const c = docs.characters[key];
        if (c) add(c.content);
      }
    }
  }
  return { legacy, pinned };
}

const codeOf = (error: unknown): { code: string; detail: string } => {
  if (error instanceof PrepareError) return { code: error.code, detail: error.detail };
  const name = (error as { name?: string; code?: string } | null)?.name;
  const detail = error instanceof Error ? error.message : String(error);
  if (name === "QuotaExceededError") return { code: "storage_quota", detail };
  const code = (error as { code?: unknown } | null)?.code;
  return { code: typeof code === "string" ? code : "failed", detail };
};

/**
 * The explicit preparation (also its retry). Returns the readiness after it, with what failed;
 * whatever was there before stays (a failed or cancelled step writes nothing of its own).
 */
export async function prepareOffline(
  target: Target,
  options: { readonly signal?: AbortSignal; readonly storage?: () => Promise<Persisted> } = {},
): Promise<Readiness> {
  const failures: ReadinessItem[] = [];
  const signal = options.signal;
  try {
    // 1. this release: registered if needed, inspected, its missing or damaged files restored
    if (release.isRelease) {
      try {
        lastInspection = await release.prepare();
      } catch (error) {
        const { code, detail } = codeOf(error);
        failures.push({
          kind: "app",
          id: release.releaseId,
          status: "failed",
          detail: `${code}${detail ? `: ${detail}` : ""}`,
        });
      }
    }
    aborted(signal);
    // 2. the content: the campaign's prepared context, pinned packs served with these exact bytes
    const need = needs(target);
    if (need.legacy) {
      try {
        // Already prepared for these settings: keep that exact binding (its missing or damaged
        // packs restored only from identical bytes); never re-read and re-bind to what the host
        // serves now. Unprepared (or other settings): prepare from the host.
        const { packs, sources } = useSettings.getState().settings;
        const bound = await matchingContext({ packs, sources });
        if (bound) await storeServedExact(bound, signal);
        else await prepareCampaign(signal);
      } catch (error) {
        if (error instanceof PrepareError && error.code === "cancelled") throw error;
        const { code, detail } = codeOf(error);
        failures.push({
          kind: "pack",
          id: "campaign",
          status: "failed",
          detail: `${code}${detail ? `: ${detail}` : ""}`,
        });
      }
    }
    for (const context of need.pinned) {
      try {
        await storeServedExact(context, signal);
      } catch (error) {
        if (error instanceof PrepareError && error.code === "cancelled") throw error;
        const { code, detail } = codeOf(error);
        failures.push({
          kind: "pack",
          id: contextKey(context),
          status: "failed",
          detail: `${code}${detail ? `: ${detail}` : ""}`,
        });
      }
    }
    aborted(signal);
    // 3. the storage protection, shown apart (its answer never changes the status)
    const persisted = await (options.storage ?? askPersistence)();
    const state = setStorageState(persisted);
    await writeQueue(async () => (await db()).put("settings", state, STORAGE_KEY)).catch(
      () => undefined,
    );
    // 4. everything saved
    await flushNow().catch(() => undefined);
  } catch (error) {
    if (!(error instanceof PrepareError && error.code === "cancelled")) throw error;
    failures.push({ kind: "app", id: release.releaseId, status: "pending", detail: "cancelled" });
  }
  const checked = await checkReadiness(target, { fresh: true });
  const items = [...failures, ...checked.items];
  const result: Readiness = { ...checked, items, status: statusOf(items) };
  await writeQueue(async () => (await db()).put("settings", result, readinessKey(target.id))).catch(
    () => undefined,
  );
  return result;
}

// ───────────────────────── the hook ─────────────────────────

/**
 * The readiness of a character or an encounter, checked again whenever what it depends on changes
 * (the record, the settings, a save, the journal head); `prepare` runs the preparation, `cancel`
 * stops it between steps, `check` re-inspects the release.
 */
export function useReadiness(target: Target | null) {
  const id = target?.id ?? null;
  const kind = target?.kind ?? "character";
  const rev = useDocuments((s) => (id ? (s.revs[id] ?? 0) : 0));
  const settings = useSettings((s) => s.settings);
  const saveState = useHistory((s) => s.saveState);
  const head = useHistory((s) => (id ? s.meta[id] : undefined));
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  const [busy, setBusy] = useState<"checking" | "preparing" | null>(null);
  const abort = useRef<AbortController | null>(null);
  const run = useRef(0);

  const check = useCallback(
    async (fresh = false) => {
      if (!id) return;
      const mine = ++run.current;
      setBusy((b) => b ?? "checking");
      const r = await checkReadiness({ kind, id }, { fresh });
      if (run.current === mine) {
        setReadiness(r);
        setBusy((b) => (b === "checking" ? null : b));
      }
    },
    [id, kind],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: these are triggers to check again
  useEffect(() => {
    setReadiness(null);
    void check(false);
  }, [check, rev, settings, saveState, head]);

  const prepare = useCallback(async () => {
    if (!id) return;
    const controller = new AbortController();
    abort.current = controller;
    run.current++;
    setBusy("preparing");
    try {
      setReadiness(await prepareOffline({ kind, id }, { signal: controller.signal }));
    } finally {
      abort.current = null;
      setBusy(null);
    }
  }, [id, kind]);

  const cancel = useCallback(() => abort.current?.abort(), []);
  const status: ReadinessStatus | null =
    busy === "preparing" ? "preparing" : (readiness?.status ?? (busy ? "checking" : null));
  return { readiness, status, busy, check: () => check(true), prepare, cancel };
}
