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
 */

import { engine } from "@/engine/client";
import { t } from "@/i18n";
import { canonicalJson } from "@/lib/canonical";
import {
  type CharacterRecord,
  type EncounterRecord,
  type LogEntry,
  useDocuments,
} from "@/store/documents";
import { PLAY_WAYS, type PlayWay, readSettings, useSettings } from "@/store/settings";
import { useUi } from "@/store/ui";
import { db, newInstallationId, onDbBlocked, packKey } from "./db";

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

export async function loadAll(): Promise<void> {
  const database = await db();
  const settings = readSettings(await database.get("settings", SETTINGS_KEY));
  useSettings.getState().replace(settings);
  await engine().configure({ packs: settings.packs, sources: settings.sources });
  if (settings.dev_seed !== null) await engine().setSeed(settings.dev_seed);
  const id = await database.get("settings", INSTALLATION_KEY);
  if (typeof id === "string") installation = id;
  else {
    installation = newInstallationId();
    await database.put("settings", installation, INSTALLATION_KEY);
  }
  // Imported packs, for the documents pinned to them (their hashes are checked in the worker),
  // and the stored copies of the served SRD (also for the campaign's catalog when the host is gone).
  const packs = await database.getAll("packs");
  const imported = packs.filter((p) => p.origin.kind !== "bundled");
  const bundled = packs
    .filter((p) => p.origin.kind === "bundled")
    .sort((a, b) => a.installed_at - b.installed_at);
  if (imported.length) await engine().registerPacks(imported.map((p) => p.files));
  if (bundled.length)
    await engine().registerPacks(
      bundled.map((p) => p.files),
      true,
    );

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
    const record: EncounterRecord = {
      ...raw,
      encounter: parsed.encounter,
      log: readLog(raw.log),
      modes: readModes(raw.modes),
    };
    encounters.push(record);
    if (
      canonicalJson([raw.encounter, raw.log, raw.modes ?? {}]) !==
      canonicalJson([record.encounter, record.log, record.modes ?? {}])
    )
      migrated.push({ store: "encounters", record, rev: raw.rev ?? 0 });
  }
  useDocuments.getState().hydrate({ characters, encounters });
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
}

/** The running autosave (one per app), so an import can flush it and move its baseline. */
let active: {
  flush: () => Promise<void>;
  baseline: Baseline;
  conflicted: Set<string>;
} | null = null;

/** Save now what's waiting (an import flushes before its transaction). */
export function flushNow(): Promise<void> {
  return active ? active.flush() : Promise.resolve();
}

/** An import wrote these records: they are this tab's last written version now. */
export function markCommitted(records: {
  characters: readonly CharacterRecord[];
  encounters: readonly EncounterRecord[];
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
  };
}

/** Save documents and settings when they change (debounced), deleting removed ones. */
export function startAutosave(): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const conflicted = new Set<string>();
  const state: NonNullable<typeof active> = {
    baseline: {
      characters: useDocuments.getState().characters,
      encounters: useDocuments.getState().encounters,
      settings: useSettings.getState().settings,
    },
    conflicted,
    flush: () => writeQueue(save),
  };

  async function save() {
    // A save now replaces the one waiting (its timer would otherwise fire later, even after stop).
    if (timer) clearTimeout(timer);
    timer = null;
    const { characters, encounters } = useDocuments.getState();
    const settings = useSettings.getState().settings;
    const saved = state.baseline;
    const database = await db();
    const tx = database.transaction(["characters", "encounters", "settings"], "readwrite");
    const written = {
      characters: new Map<string, CharacterRecord | null>(),
      encounters: new Map<string, EncounterRecord | null>(),
    };
    const newly: string[] = [];
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
        conflicted.add(id);
        newly.push(id);
        return;
      }
      if (record) await tx.objectStore(store).put(record as never);
      else await tx.objectStore(store).delete(id);
      (written[store] as Map<string, R | null>).set(id, record);
    };
    for (const [id, record] of Object.entries(characters))
      if (saved.characters[id] !== record)
        await write("characters", id, record, saved.characters[id]);
    for (const id of Object.keys(saved.characters))
      if (!characters[id]) await write("characters", id, null, saved.characters[id]);
    for (const [id, record] of Object.entries(encounters))
      if (saved.encounters[id] !== record)
        await write("encounters", id, record, saved.encounters[id]);
    for (const id of Object.keys(saved.encounters))
      if (!encounters[id]) await write("encounters", id, null, saved.encounters[id]);
    const settingsChanged = settings !== saved.settings;
    if (settingsChanged) await tx.objectStore("settings").put(settings, SETTINGS_KEY);
    await tx.done;
    // Only now is it saved: move the baseline for what was written.
    const next = {
      ...state.baseline,
      characters: { ...state.baseline.characters },
      encounters: { ...state.baseline.encounters },
    };
    for (const [id, r] of written.characters) {
      if (r) next.characters[id] = r;
      else delete next.characters[id];
    }
    for (const [id, r] of written.encounters) {
      if (r) next.encounters[id] = r;
      else delete next.encounters[id];
    }
    if (settingsChanged) next.settings = settings;
    state.baseline = next;
    if (newly.length) {
      useUi.getState().toast(
        newly.map((id) => t("persistence.changedElsewhere", { id })),
        "error",
        t("persistence.saveFailed"),
      );
    }
  }

  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      state
        .flush()
        .catch((error: unknown) =>
          useUi.getState().toast([String(error)], "error", t("persistence.saveFailed")),
        );
    }, SAVE_DELAY_MS);
  };
  const unsubscribeDocs = useDocuments.subscribe(schedule);
  const unsubscribeSettings = useSettings.subscribe(schedule);
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
    unsubscribeBlocked();
    removeEventListener("pagehide", onHide);
    onHide();
    if (active === state) active = null;
  };
}
