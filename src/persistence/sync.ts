/**
 * Load → parse → store, and save on change. Every document read from IndexedDB goes through the
 * engine's `parse*` (validation and migration of older versions), and the migrated result is
 * written back. A record that doesn't parse is left in the database untouched and reported.
 *
 * kenli F-008: every write to the database goes through one queue (autosave and imports alike).
 * A record is written only if the database still has the revision this tab last wrote or read
 * (compare-and-set): a change made in another tab is never overwritten, the record is marked and
 * no longer saved here until the page is reloaded. The saved baseline moves only once a
 * transaction is done, so a failed save is tried again.
 *
 * kenli F-006 (contract history.md §5.3): a character is one unit with its journal. Its document
 * row is compared on `rev`, its journal head (`history_meta.rev`) on the version this tab last read
 * or wrote — independently: a day or a roll that changes nothing never touches the document's
 * `rev`. Both match or nothing of that character is written; a mismatch marks it conflicted
 * (document or history), said once, and not tried again until a reload. Every journal write puts
 * the head with `rev + 1`; entries keep their ids, so a retried save writes the same rows.
 */

import { engine } from "@/engine/client";
import type { StoredPackStatus } from "@/engine/content";
import { t } from "@/i18n";
import { canonicalJson } from "@/lib/canonical";
import { configureCampaign, loadPreparedCampaign } from "@/offline/campaign";
import { loadStorageState } from "@/offline/storage";
import {
  type CharacterRecord,
  type EncounterRecord,
  type LogEntry,
  useDocuments,
} from "@/store/documents";
import {
  type ConflictKind,
  type HistoryEntry,
  type HistoryMeta,
  useHistory,
} from "@/store/history";
import { PLAY_WAYS, type PlayWay, readSettings, useSettings } from "@/store/settings";
import { useUi } from "@/store/ui";
import { db, newInstallationId, onDbBlocked, packKey, type StoredPack } from "./db";

const SETTINGS_KEY = "campaign";
const INSTALLATION_KEY = "installation";
const SAVE_DELAY_MS = 300;

let writes: Promise<unknown> = Promise.resolve();
/** Run a database write after every earlier one (autosave flushes and import commits). */
export function writeQueue<T>(fn: () => Promise<T>): Promise<T> {
  const next = writes.then(fn, fn);
  writes = next.catch(() => undefined);
  return next;
}

/** This installation's id (kenli F-008 local export identity), created once. */
let installation: string | null = null;
export function installationId(): string {
  if (!installation) throw new Error("installation id not loaded yet");
  return installation;
}

/**
 * Stored packs whose files didn't verify at the last start (kenli F-007 T04): kept out of every
 * catalog, kept in storage, shown by the readiness check.
 */
let packProblems: readonly StoredPackStatus[] = [];
export const storedPackProblems = (): readonly StoredPackStatus[] => packProblems;

/**
 * Register the stored packs (kenli F-007 T04 §5.1.2): each only when its whole files hash to its
 * own ref and key; imported ones first, then the stored copies of served packs by install time.
 */
export async function registerStoredPacks(
  rows: readonly StoredPack[],
): Promise<readonly StoredPackStatus[]> {
  const ordered = [
    ...rows.filter((p) => p.origin.kind !== "bundled"),
    ...rows
      .filter((p) => p.origin.kind === "bundled")
      .sort((a, b) => a.installed_at - b.installed_at),
  ];
  const statuses = await engine().registerStoredPacks(
    ordered.map((p) => ({
      key: p.key,
      ref: p.ref,
      files: p.files,
      bundled: p.origin.kind === "bundled",
    })),
  );
  packProblems = [
    ...packProblems.filter((x) => !statuses.some((y) => y.key === x.key)),
    ...statuses.filter((x) => x.status !== "ok"),
  ];
  return statuses;
}

export async function loadAll(): Promise<void> {
  const database = await db();
  const settings = readSettings(await database.get("settings", SETTINGS_KEY));
  useSettings.getState().replace(settings);
  await loadPreparedCampaign(database);
  await loadStorageState(database);
  // Stored packs first (verified), then the campaign catalog: with a prepared context matching the
  // settings it reads those exact refs from storage, without trying the host (kenli F-007 T04).
  packProblems = [];
  await registerStoredPacks(await database.getAll("packs"));
  await configureCampaign(settings);
  if (settings.dev_seed !== null) await engine().setSeed(settings.dev_seed);
  const id = await database.get("settings", INSTALLATION_KEY);
  if (typeof id === "string") installation = id;
  else {
    installation = newInstallationId();
    await database.put("settings", installation, INSTALLATION_KEY);
  }

  const problems: string[] = [];
  const characters: CharacterRecord[] = [];
  const migrated: {
    store: "characters" | "encounters";
    record: CharacterRecord | EncounterRecord;
    rev: number;
  }[] = [];
  for (const raw of await database.getAll("characters")) {
    const build = await engine().parseBuild(raw.build);
    const state = await engine().parseState(raw.state);
    if (!build.ok || !state.ok) {
      const reasons = [...(build.ok ? [] : build.reasons), ...(state.ok ? [] : state.reasons)];
      problems.push(t("persistence.badCharacter", { id: raw.id, reasons: reasons.join("; ") }));
      continue;
    }
    const record: CharacterRecord = { ...raw, build: build.build, state: state.state };
    characters.push(record);
    if (canonicalJson([raw.build, raw.state]) !== canonicalJson([record.build, record.state]))
      migrated.push({ store: "characters", record, rev: raw.rev ?? 0 });
  }
  const encounters: EncounterRecord[] = [];
  for (const raw of await database.getAll("encounters")) {
    const parsed = await engine().parseEncounter(raw.encounter);
    if (!parsed.ok) {
      problems.push(
        t("persistence.badEncounter", { name: raw.name, reasons: parsed.reasons.join("; ") }),
      );
      continue;
    }
    const { pending_op: _pending, ...stored } = raw;
    const record: EncounterRecord = {
      ...stored,
      encounter: parsed.encounter,
      log: readLog(raw.log),
      modes: readModes(raw.modes),
      ...pendingOpOf(raw, parsed.encounter),
    };
    encounters.push(record);
    if (
      canonicalJson([raw.encounter, raw.log, raw.modes ?? {}]) !==
      canonicalJson([record.encounter, record.log, record.modes ?? {}])
    )
      migrated.push({ store: "encounters", record, rev: raw.rev ?? 0 });
  }
  useDocuments.getState().hydrate({ characters, encounters });
  // Every character's journal head (small); the entries stay in the database until read.
  useHistory.getState().hydrate(await database.getAll("history_meta"));
  // Persist what the parse migrated, only where the database still has what was read.
  if (migrated.length) {
    await writeQueue(async () => {
      const tx = database.transaction(["characters", "encounters"], "readwrite");
      for (const { store, record, rev } of migrated) {
        const current = await tx.objectStore(store).get(record.id);
        if ((current?.rev ?? 0) === rev) await tx.objectStore(store).put(record as never);
      }
      await tx.done;
    });
  }
  if (problems.length) useUi.getState().toast(problems, "error", t("persistence.someSkipped"));
}

/** The packs served with the app that are kept in storage (kenli F-008 §9.5). */
export const BUNDLED_PACKS = ["srd-5.2.1"] as const;

/**
 * Keep the served SRD in `packs` (kenli F-008 §9.5): the whole pack as the worker read and hashed
 * it, `origin: bundled`, added once and never overwritten (a version stored with other bytes stays,
 * as for an import). Documents pinned to it then open from storage with the host gone. It's its own
 * transaction, never part of an import's; a full storage is said and the app goes on (the session
 * still has its copy in memory).
 */
export async function persistBundled(): Promise<"added" | "present" | "unavailable" | "failed"> {
  let outcome: "added" | "present" | "unavailable" | "failed" = "present";
  for (const id of BUNDLED_PACKS) {
    let served: Awaited<ReturnType<ReturnType<typeof engine>["servedPackFiles"]>>;
    try {
      served = await engine().servedPackFiles(id);
    } catch {
      outcome = "unavailable"; // not served now (the host is gone): nothing new to keep
      continue;
    }
    const { ref, files } = served;
    try {
      const added = await writeQueue(async () => {
        const database = await db();
        const tx = database.transaction("packs", "readwrite");
        const store = tx.objectStore("packs");
        const prefix = `${ref.id}@${ref.version ?? ""}#`;
        const keys = await store.getAllKeys(IDBKeyRange.bound(prefix, `${prefix}\uffff`));
        const fresh = keys.length === 0;
        if (fresh)
          await store.add({
            key: packKey(ref),
            ref,
            files,
            installed_at: Date.now(),
            origin: { kind: "bundled" },
          });
        await tx.done;
        return fresh;
      });
      if (added) outcome = "added";
    } catch (error) {
      outcome = "failed";
      const quota = (error as { name?: string } | null)?.name === "QuotaExceededError";
      useUi
        .getState()
        .toast(
          [quota ? t("persistence.bundledQuota") : String(error)],
          "error",
          t("persistence.bundledFailed"),
        );
    }
  }
  return outcome;
}

function readLog(raw: unknown): LogEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (e): e is LogEntry =>
        typeof e === "object" && e !== null && Array.isArray((e as LogEntry).lines),
    )
    .map((e) => {
      // Messages are kept only when they still match the lines one for one.
      if (e.messages === undefined) return e;
      if (Array.isArray(e.messages) && e.messages.length === e.lines.length) return e;
      const { messages: _, ...rest } = e;
      return rest;
    });
}

/**
 * The journal operation an encounter's pending decision continues (kenli F-006 R03-01): kept only
 * while the encounter still waits for a decision and the value is an operation id; else dropped.
 */
function pendingOpOf(
  raw: { readonly pending_op?: unknown },
  encounter: EncounterRecord["encounter"],
): { pending_op?: string } {
  const op = raw.pending_op;
  return encounter.pending && typeof op === "string" && op.startsWith("op-")
    ? { pending_op: op }
    : {};
}

function readModes(raw: unknown): Record<string, PlayWay> {
  if (typeof raw !== "object" || raw === null) return {};
  return Object.fromEntries(
    Object.entries(raw).filter((e): e is [string, PlayWay] =>
      (PLAY_WAYS as readonly unknown[]).includes(e[1]),
    ),
  );
}

interface Baseline {
  characters: Readonly<Record<string, CharacterRecord>>;
  encounters: Readonly<Record<string, EncounterRecord>>;
  settings: unknown;
  /** Journal versions this tab saved (entries by id, heads by record id). */
  entries: Readonly<Record<string, HistoryEntry>>;
  meta: Readonly<Record<string, HistoryMeta>>;
}

/** The running autosave (one per app), so an import can flush it and move its baseline. */
let active: {
  flush: () => Promise<void>;
  baseline: Baseline;
  conflicted: Set<string>;
} | null = null;

/**
 * The journal head version of a character this tab last read or wrote (`null`: none saved), and
 * whether it is still saved here (not conflicted): the import compares it in its transaction.
 */
export function savedHead(recordId: string): { rev: number | null; conflicted: boolean } {
  if (!active) {
    const m = useHistory.getState().meta[recordId];
    return { rev: m && m.rev > 0 ? m.rev : null, conflicted: false };
  }
  return {
    rev: active.baseline.meta[recordId]?.rev ?? null,
    conflicted: active.conflicted.has(recordId),
  };
}

/** Save now what's waiting (an import flushes before its transaction). */
export function flushNow(): Promise<void> {
  return active ? active.flush() : Promise.resolve();
}

/**
 * How many of a character's journal entries this tab captured or changed and hasn't saved yet
 * (kenli F-006 T03: the panel's "not saved yet"). Without a running autosave: all of this session's.
 */
export function unsavedCount(recordId: string): number {
  return unsavedState(recordId).entries;
}

/**
 * What of a character's journal this tab hasn't saved yet (kenli F-006 R04-01): its entries, and
 * whether its head changed (a day, a label, a correction, its first head) — a change of days alone
 * is unsaved too. Without a running autosave nothing is saved.
 */
export function unsavedState(recordId: string): { entries: number; days: boolean } {
  const { entries: all, meta } = useHistory.getState();
  const entries = Object.values(all).filter((e) => e.record_id === recordId);
  const head = meta[recordId];
  if (!active) return { entries: entries.length, days: !!head };
  const saved = active.baseline;
  return {
    entries: entries.filter((e) => saved.entries[e.id] !== e).length,
    days: !!head && saved.meta[recordId] !== head,
  };
}

/** An import wrote these records (and journal rows): they are this tab's last written version now. */
export function markCommitted(records: {
  characters: readonly CharacterRecord[];
  encounters: readonly EncounterRecord[];
  entries?: readonly HistoryEntry[];
  meta?: readonly HistoryMeta[];
}): void {
  if (!active) return;
  const b = active.baseline;
  active.baseline = {
    ...b,
    characters: {
      ...b.characters,
      ...Object.fromEntries(records.characters.map((c) => [c.id, c])),
    },
    encounters: {
      ...b.encounters,
      ...Object.fromEntries(records.encounters.map((e) => [e.id, e])),
    },
    entries: { ...b.entries, ...Object.fromEntries((records.entries ?? []).map((e) => [e.id, e])) },
    meta: { ...b.meta, ...Object.fromEntries((records.meta ?? []).map((m) => [m.record_id, m])) },
  };
}

/**
 * kenli F-007 T03: a transaction outside the autosave deleted these characters with their journals
 * (a local copy's Undo): they are no longer this tab's to save or delete.
 */
export function forgetCommitted(characterIds: readonly string[]): void {
  if (!active || !characterIds.length) return;
  const b = active.baseline;
  const gone = new Set(characterIds);
  active.baseline = {
    ...b,
    characters: Object.fromEntries(Object.entries(b.characters).filter(([id]) => !gone.has(id))),
    entries: Object.fromEntries(
      Object.entries(b.entries).filter(([, e]) => !gone.has(e.record_id)),
    ),
    meta: Object.fromEntries(Object.entries(b.meta).filter(([id]) => !gone.has(id))),
  };
}

/**
 * kenli F-007 T03 R04-01: whether a character is this tab's saved version (in the autosave's
 * baseline): a published import is; a record only in the store is not. Without a running
 * autosave nothing is tracked, so whatever the store has counts.
 */
export function isCommitted(characterId: string): boolean {
  if (!active) return true;
  return Object.hasOwn(active.baseline.characters, characterId);
}

/**
 * kenli F-007 T04: whether this tab saved a record exactly as it is now (the autosave's baseline
 * holds this very version). Without a running autosave nothing is tracked: counted as saved.
 */
export function recordSaved(store: "characters" | "encounters", id: string): boolean {
  if (!active) return true;
  const now = useDocuments.getState()[store][id];
  return !!now && active.baseline[store][id] === now;
}

/** kenli F-007 T04: whether this tab has settings it hasn't saved yet (no autosave: none tracked). */
export function unsavedSettings(): boolean {
  return !!active && useSettings.getState().settings !== active.baseline.settings;
}

/** Save documents and settings when they change (debounced), deleting removed ones. */
export function startAutosave(): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const conflicted = new Set<string>();
  const kinds = new Map<string, ConflictKind>();
  const state: NonNullable<typeof active> = {
    baseline: {
      characters: useDocuments.getState().characters,
      encounters: useDocuments.getState().encounters,
      settings: useSettings.getState().settings,
      entries: useHistory.getState().entries,
      meta: useHistory.getState().meta,
    },
    conflicted,
    flush: () =>
      writeQueue(() =>
        save().catch((error: unknown) => {
          useHistory.getState().setSaveState({ status: "failed", reason: String(error) });
          throw error;
        }),
      ),
  };

  async function save() {
    // A save now replaces the one waiting (its timer would otherwise fire later, even after stop).
    if (timer) clearTimeout(timer);
    timer = null;
    const { characters, encounters } = useDocuments.getState();
    const settings = useSettings.getState().settings;
    const journal = useHistory.getState();
    const saved = state.baseline;
    const database = await db();
    const tx = database.transaction(
      ["characters", "encounters", "settings", "history", "history_meta"],
      "readwrite",
    );

    const written = {
      characters: new Map<string, CharacterRecord | null>(),
      encounters: new Map<string, EncounterRecord | null>(),
    };
    const writtenEntries: HistoryEntry[] = [];
    const writtenMeta: { read: HistoryMeta; written: HistoryMeta }[] = [];
    const dropped: string[] = [];
    const newly: { id: string; kind: ConflictKind; pending: number }[] = [];
    const conflict = (id: string, kind: ConflictKind, pending = 0) => {
      conflicted.add(id);
      kinds.set(id, kind);
      newly.push({ id, kind, pending });
    };
    // Compare-and-set: the database must still hold the revision this tab saved (or read).
    const write = async <R extends CharacterRecord | EncounterRecord>(
      store: "characters" | "encounters",
      id: string,
      record: R | null,
      before: R | undefined,
    ) => {
      if (conflicted.has(id)) return;
      const current = await tx.objectStore(store).get(id);
      const expected = before ? (before.rev ?? 0) : null;
      const actual = current ? (current.rev ?? 0) : null;
      if (actual !== expected) {
        conflict(id, "document");
        return;
      }
      if (record) await tx.objectStore(store).put(record as never);
      else await tx.objectStore(store).delete(id);
      (written[store] as Map<string, R | null>).set(id, record);
    };

    const settingsChanged = settings !== saved.settings;
    try {
      // Characters: each one with its journal, as one unit (kenli F-006 §5.3).
      const pendingOf = new Map<string, HistoryEntry[]>();
      for (const e of Object.values(journal.entries))
        if (saved.entries[e.id] !== e)
          pendingOf.set(e.record_id, [...(pendingOf.get(e.record_id) ?? []), e]);
      const ids = new Set([
        ...Object.keys(characters),
        ...Object.keys(saved.characters),
        ...Object.keys(journal.meta),
        ...pendingOf.keys(),
      ]);
      for (const id of [...ids].sort()) {
        if (conflicted.has(id)) continue;
        const record = characters[id] ?? null;
        const before = saved.characters[id];
        if (!record && !before) {
          // Created and deleted before it was ever saved: its journal goes with it, nothing to write.
          if (journal.meta[id] || pendingOf.has(id)) dropped.push(id);
          continue;
        }
        const docDirty = record !== (before ?? null);
        const entries = record ? (pendingOf.get(id) ?? []) : [];
        const meta = journal.meta[id];
        const metaDirty = record ? !!meta && saved.meta[id] !== meta : true;
        const journalDirty = entries.length > 0 || metaDirty;
        if (!docDirty && !journalDirty) continue;
        const row = await tx.objectStore("characters").get(id);
        if ((row ? (row.rev ?? 0) : null) !== (before ? (before.rev ?? 0) : null)) {
          conflict(id, "document", entries.length);
          continue;
        }
        if (journalDirty) {
          const head = await tx.objectStore("history_meta").get(id);
          if ((head?.rev ?? null) !== (saved.meta[id]?.rev ?? null)) {
            conflict(id, "history", entries.length);
            continue;
          }
        }
        if (docDirty) {
          if (record) await tx.objectStore("characters").put(record as never);
          else await tx.objectStore("characters").delete(id);
          written.characters.set(id, record);
        }
        if (!journalDirty) continue;
        if (!record) {
          // Deleted: its journal and head go in the same transaction.
          const index = tx.objectStore("history").index("by_record_seq");
          const range = IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]);
          for (let c = await index.openCursor(range); c; c = await c.continue()) await c.delete();
          await tx.objectStore("history_meta").delete(id);
          dropped.push(id);
          continue;
        }
        for (const e of entries) await tx.objectStore("history").put(e);
        const head = meta ?? useHistory.getState().ensureMeta(id);
        const next: HistoryMeta = { ...head, rev: (saved.meta[id]?.rev ?? 0) + 1 };
        await tx.objectStore("history_meta").put(next);
        writtenEntries.push(...entries);
        writtenMeta.push({ read: head, written: next });
      }
      for (const [id, record] of Object.entries(encounters))
        if (saved.encounters[id] !== record)
          await write("encounters", id, record, saved.encounters[id]);
      for (const id of Object.keys(saved.encounters))
        if (!encounters[id]) await write("encounters", id, null, saved.encounters[id]);
      if (settingsChanged) await tx.objectStore("settings").put(settings, SETTINGS_KEY);
      await tx.done;
    } catch (error) {
      // Nothing of a failed save is kept (quota, a unique index): the baseline doesn't move.
      try {
        tx.abort();
      } catch {
        // already finished
      }
      await tx.done.catch(() => undefined);
      throw error;
    }
    // Only now is it saved: move the baseline for what was written.
    const next = {
      ...state.baseline,
      characters: { ...state.baseline.characters },
      encounters: { ...state.baseline.encounters },
      entries: { ...state.baseline.entries },
      meta: { ...state.baseline.meta },
    };
    for (const [id, r] of written.characters) {
      if (r) next.characters[id] = r;
      else delete next.characters[id];
    }
    for (const [id, r] of written.encounters) {
      if (r) next.encounters[id] = r;
      else delete next.encounters[id];
    }
    for (const e of writtenEntries) next.entries[e.id] = e;
    for (const m of writtenMeta) next.meta[m.written.record_id] = m.written;
    for (const id of dropped) {
      delete next.meta[id];
      for (const [eid, e] of Object.entries(next.entries))
        if (e.record_id === id) delete next.entries[eid];
    }
    if (settingsChanged) next.settings = settings;
    state.baseline = next;
    useHistory.getState().saved({ entries: writtenEntries, meta: writtenMeta, dropped });
    if (conflicted.size) {
      useHistory.getState().setConflicts(Object.fromEntries(kinds));
      useHistory.getState().setSaveState({ status: "conflict", records: [...conflicted] });
    } else useHistory.getState().setSaveState({ status: "saved" });
    if (newly.length) {
      const name = (id: string) => characters[id]?.build.name || id;
      useUi.getState().toast(
        newly.map(({ id, kind, pending }) =>
          kind === "history"
            ? t("persistence.historyChangedElsewhere", { name: name(id), count: pending })
            : t("persistence.changedElsewhere", { id }),
        ),
        "error",
        t("persistence.saveFailed"),
      );
    }
  }

  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      state.flush().catch((error: unknown) => {
        useHistory.getState().setSaveState({ status: "failed", reason: String(error) });
        useUi.getState().toast([String(error)], "error", t("persistence.saveFailed"));
      });
    }, SAVE_DELAY_MS);
  };
  const unsubscribeDocs = useDocuments.subscribe(schedule);
  const unsubscribeSettings = useSettings.subscribe(schedule);
  // A roll that changes no document, a day: the journal alone is saved too (kenli F-006 §5.3.1).
  const unsubscribeHistory = useHistory.subscribe((s, prev) => {
    if (s.entries !== prev.entries || s.meta !== prev.meta) schedule();
  });
  const unsubscribeBlocked = onDbBlocked((why) =>
    useUi
      .getState()
      .toast([t(why === "blocked" ? "persistence.closeOtherTabs" : "persistence.reload")], "error"),
  );
  const onHide = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
      void state.flush();
    }
  };
  addEventListener("pagehide", onHide);
  active = state;
  return () => {
    unsubscribeDocs();
    unsubscribeSettings();
    unsubscribeHistory();
    unsubscribeBlocked();
    removeEventListener("pagehide", onHide);
    onHide();
    if (active === state) active = null;
  };
}
