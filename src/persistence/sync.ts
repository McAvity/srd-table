/**
 * Load → parse → store, and save on change. Every document read from IndexedDB goes through the
 * engine's `parse*` (validation and migration of older versions), and the migrated result is
 * written back. A record that doesn't parse is left in the database untouched and reported.
 */

import { engine } from "@/engine/client";
import { t } from "@/i18n";
import {
  type CharacterRecord,
  type DeclaredEntry,
  type EncounterRecord,
  type LogEntry,
  useDocuments,
} from "@/store/documents";
import { PLAY_WAYS, type PlayWay, readSettings, useSettings } from "@/store/settings";
import { useUi } from "@/store/ui";
import { db } from "./db";

const SETTINGS_KEY = "campaign";
const SAVE_DELAY_MS = 300;

export async function loadAll(): Promise<void> {
  const database = await db();
  const settings = readSettings(await database.get("settings", SETTINGS_KEY));
  useSettings.getState().replace(settings);
  await engine().configure({ packs: settings.packs, sources: settings.sources });
  if (settings.dev_seed !== null) await engine().setSeed(settings.dev_seed);

  const problems: string[] = [];
  const characters: CharacterRecord[] = [];
  for (const raw of await database.getAll("characters")) {
    const build = await engine().parseBuild(raw.build);
    const state = await engine().parseState(raw.state);
    if (!build.ok || !state.ok) {
      const reasons = [...(build.ok ? [] : build.reasons), ...(state.ok ? [] : state.reasons)];
      problems.push(t("persistence.badCharacter", { id: raw.id, reasons: reasons.join("; ") }));
      continue;
    }
    characters.push({ ...raw, build: build.build, state: state.state });
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
    encounters.push({
      ...raw,
      encounter: parsed.encounter,
      log: readLog(raw.log),
      declared: readDeclared(raw.declared),
      modes: readModes(raw.modes),
    });
  }
  useDocuments.getState().hydrate({ characters, encounters });
  // Persist what the parse migrated.
  const tx = database.transaction(["characters", "encounters"], "readwrite");
  await Promise.all([
    ...characters.map((c) => tx.objectStore("characters").put(c)),
    ...encounters.map((e) => tx.objectStore("encounters").put(e)),
    tx.done,
  ]);
  if (problems.length) useUi.getState().toast(problems, "error", t("persistence.someSkipped"));
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

/** Declared actions waiting for an outcome: entries that still look like the engine's. */
function readDeclared(raw: unknown): DeclaredEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (e): e is DeclaredEntry =>
      typeof e === "object" &&
      e !== null &&
      typeof (e as DeclaredEntry).id === "string" &&
      (e as DeclaredEntry).result?.manual === true &&
      Array.isArray((e as DeclaredEntry).result.targets),
  );
}

function readModes(raw: unknown): Record<string, PlayWay> {
  if (typeof raw !== "object" || raw === null) return {};
  return Object.fromEntries(
    Object.entries(raw).filter((e): e is [string, PlayWay] =>
      (PLAY_WAYS as readonly unknown[]).includes(e[1]),
    ),
  );
}

/** Save documents and settings when they change (debounced), deleting removed ones. */
export function startAutosave(): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let savedCharacters = useDocuments.getState().characters;
  let savedEncounters = useDocuments.getState().encounters;
  let savedSettings = useSettings.getState().settings;

  const flush = async () => {
    timer = null;
    const { characters, encounters } = useDocuments.getState();
    const settings = useSettings.getState().settings;
    const database = await db();
    const tx = database.transaction(["characters", "encounters", "settings"], "readwrite");
    const writes: Promise<unknown>[] = [];
    for (const [id, record] of Object.entries(characters)) {
      if (savedCharacters[id] !== record) writes.push(tx.objectStore("characters").put(record));
    }
    for (const id of Object.keys(savedCharacters)) {
      if (!characters[id]) writes.push(tx.objectStore("characters").delete(id));
    }
    for (const [id, record] of Object.entries(encounters)) {
      if (savedEncounters[id] !== record) writes.push(tx.objectStore("encounters").put(record));
    }
    for (const id of Object.keys(savedEncounters)) {
      if (!encounters[id]) writes.push(tx.objectStore("encounters").delete(id));
    }
    if (settings !== savedSettings)
      writes.push(tx.objectStore("settings").put(settings, SETTINGS_KEY));
    savedCharacters = characters;
    savedEncounters = encounters;
    savedSettings = settings;
    await Promise.all([...writes, tx.done]);
  };

  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      flush().catch((error: unknown) =>
        useUi.getState().toast([String(error)], "error", t("persistence.saveFailed")),
      );
    }, SAVE_DELAY_MS);
  };
  const unsubscribeDocs = useDocuments.subscribe(schedule);
  const unsubscribeSettings = useSettings.subscribe(schedule);
  const onHide = () => {
    if (timer) {
      clearTimeout(timer);
      void flush();
    }
  };
  addEventListener("pagehide", onHide);
  return () => {
    unsubscribeDocs();
    unsubscribeSettings();
    removeEventListener("pagehide", onHide);
    onHide();
  };
}
