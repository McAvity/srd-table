/**
 * kenli F-007 T03 test helpers: separate installations (each its own fake IndexedDB factory, so
 * several databases live side by side, as two browser profiles do), the real store, autosave and
 * in-process engine, source characters pinned to the SRD + the F-005 test pack, the contract's
 * 595-entry synthetic journal written as a saved journal of a real character, database dumps for
 * "nothing written" checks and the mapping invariants of contract §6.1.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { IDBFactory } from "fake-indexeddb";
import type { CharacterBuild } from "srd-rules-engine";
import { useLocalCopySession } from "../../src/import/localCopy/commit";
import {
  ext,
  ID,
  inheritedEncounterNames,
  type LocalCopy,
} from "../../src/import/localCopy/format";
import { type ContentContext, canonicalJson, packRefOf } from "../../src/lib/canonical";
import { closeDb, db, packKey } from "../../src/persistence/db";
import {
  flushNow,
  installationId,
  loadAll,
  persistBundled,
  startAutosave,
} from "../../src/persistence/sync";
import { type CharacterRecord, useDocuments } from "../../src/store/documents";
import { type HistoryEntry, type HistoryMeta, useHistory } from "../../src/store/history";
import { DEFAULT_SETTINGS, useSettings } from "../../src/store/settings";
import { useUi } from "../../src/store/ui";
import { TEST_PACK } from "../fixtures/player-actions";
import { engineWithDice } from "../helpers/transfer";

export const FIX = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
// biome-ignore lint/suspicious/noExplicitAny: test data reached field by field.
export type Loose = any;

export function ok<T extends { ok: unknown }>(r: T): Extract<T, { ok: true }> {
  if (r.ok !== true) throw new Error(JSON.stringify(r).slice(0, 2000));
  return r as Extract<T, { ok: true }>;
}

/** Installations: one fake IndexedDB each; switching one in is a reload of the app on it. */
export class Installations {
  private readonly factories = new Map<string, IDBFactory>();
  private stop: (() => void) | null = null;
  fx = engineWithDice();
  current: string | null = null;

  async open(name: string): Promise<string> {
    await this.close();
    let f = this.factories.get(name);
    if (!f) {
      f = new IDBFactory();
      this.factories.set(name, f);
    }
    globalThis.indexedDB = f;
    useDocuments.setState({
      hydrated: false,
      characters: {},
      encounters: {},
      revs: {},
      history: {},
    });
    useHistory.getState().hydrate([]);
    useSettings.setState({ settings: DEFAULT_SETTINGS });
    useUi.setState({ toasts: [] });
    // A reload ends the session: its import Undo/Redo window too.
    useLocalCopySession.setState({ last: null });
    this.fx = engineWithDice();
    await loadAll();
    this.stop = startAutosave();
    await persistBundled();
    this.current = name;
    return installationId();
  }

  /** Close the app on the current installation (its saves done first). */
  async close(): Promise<void> {
    if (this.current) await flushNow().catch(() => undefined);
    this.stop?.();
    this.stop = null;
    await closeDb();
    this.current = null;
  }

  /** Reload the app on the current installation. */
  async reload(): Promise<void> {
    const name = this.current;
    if (!name) throw new Error("no installation open");
    await this.open(name);
  }
}

/** The F-005 test pack stored as an imported pack (a pinned record's context needs its files here). */
export async function storeTestPack(): Promise<void> {
  const ref = await packRefOf(TEST_PACK);
  const database = await db();
  const tx = database.transaction("packs", "readwrite");
  if (!(await tx.store.get(packKey(ref))))
    await tx.store.add({
      key: packKey(ref),
      ref,
      files: TEST_PACK,
      installed_at: 1,
      origin: { kind: "import", file: "test-actions.transfer.json", bytes_sha256: null },
    });
  await tx.done;
}

/** A character in the store pinned to `content` (or legacy), saved by the autosave. */
export async function addCharacter(
  build: CharacterBuild,
  content: ContentContext | null,
  engine: Installations["fx"]["engine"],
  id = `c-${Math.random().toString(36).slice(2, 10)}`,
): Promise<string> {
  const state = await engine.createState(build, content ?? undefined);
  const now = Date.now();
  useDocuments.setState((s) => ({
    characters: {
      ...s.characters,
      [id]: {
        id,
        build,
        state,
        created: now,
        updated: now,
        rev: 1,
        gen: 0,
        ...(content ? { content } : {}),
      },
    },
  }));
  await flushNow();
  return id;
}

/** The contract's synthetic 595-entry journal, re-keyed to `recordId` (participants and head too). */
export function exampleJournal(recordId: string): { entries: HistoryEntry[]; meta: HistoryMeta } {
  const c = JSON.parse(
    readFileSync(join(FIX, "long-pinned.local-copy.fixture"), "utf8"),
  ) as LocalCopy;
  const src = c.payload.source.record_id;
  const entries = c.payload.history.entries.map((e) => ({
    ...e,
    record_id: recordId,
    participants: e.participants.map((p) =>
      p.record_id === src ? { ...p, record_id: recordId } : p,
    ),
  })) as HistoryEntry[];
  const meta = { ...(c.payload.history.meta as HistoryMeta), record_id: recordId };
  return { entries, meta };
}

/** Write a saved journal for a character straight into its database (as an earlier session saved it). */
export async function writeJournal(
  entries: readonly HistoryEntry[],
  meta: HistoryMeta,
): Promise<void> {
  const database = await db();
  const tx = database.transaction(["history", "history_meta"], "readwrite");
  for (const e of entries) await tx.objectStore("history").put(e);
  await tx.objectStore("history_meta").put(meta);
  await tx.done;
}

/** Everything in the current database (packs by key and ref), canonical: equal dumps = nothing written. */
export async function dumpDb(): Promise<string> {
  const database = await db();
  const tx = database.transaction(
    ["characters", "encounters", "history", "history_meta", "packs", "settings"],
    "readonly",
  );
  const out = {
    characters: await tx.objectStore("characters").getAll(),
    encounters: await tx.objectStore("encounters").getAll(),
    history: await tx.objectStore("history").getAll(),
    history_meta: await tx.objectStore("history_meta").getAll(),
    packs: (await tx.objectStore("packs").getAll()).map((p) => ({ key: p.key, ref: p.ref })),
    settings: await tx.objectStore("settings").getAllKeys(),
  };
  await tx.done;
  return canonicalJson(out);
}

export async function rowsOf(recordId: string): Promise<HistoryEntry[]> {
  return (await db()).getAllFromIndex(
    "history",
    "by_record_seq",
    IDBKeyRange.bound([recordId, 0], [recordId, Number.MAX_SAFE_INTEGER]),
  );
}

export const bytesOf = async (blob: Blob) => new Uint8Array(await blob.arrayBuffer());

/** Everything of an entry except what the mapping may change (contract §6.1). */
export function preserved(e: Loose) {
  const {
    id: _i,
    record_id: _r,
    operation_id: _o,
    group_id: _g,
    parent_op: _p,
    undone_with: _u,
    links: _l,
    participants,
    context,
    effect,
    ...rest
  } = e;
  return {
    ...rest,
    participants: participants.map((p: { name: string }) => p.name),
    context: { ...context, encounter_id: context.encounter_id === null ? null : "*" },
    effect: { ...effect, replaces_op: effect.replaces_op === null ? null : "*" },
  };
}

const longRestCount = (entries: readonly Loose[]) => {
  const by_day = new Map<string, number>();
  let total = 0;
  for (const e of entries)
    if (e.rest_kind === "long" && e.status === "done") {
      total++;
      by_day.set(e.day_id, (by_day.get(e.day_id) ?? 0) + 1);
    }
  return canonicalJson({ total, by_day: Object.fromEntries(by_day) });
};

/**
 * The contract's mapping invariants (§6.1, model `mappingInvariants`): the source copy against the
 * new record's saved journal and head, with the target's live records and encounters.
 */
export function mappingInvariants(
  copy: LocalCopy,
  record: CharacterRecord,
  entries: readonly HistoryEntry[],
  meta: HistoryMeta | null,
  target: {
    characters: Readonly<Record<string, unknown>>;
    encounters: Readonly<Record<string, unknown>>;
  },
): string[] {
  const errs: string[] = [];
  const src = copy.payload.history.entries;
  const inst = copy.payload.source.installation_id;
  if (entries.length !== src.length) errs.push("entry count changed");
  const opMap = new Map<string, string>();
  for (const [i, e] of src.entries()) {
    const n = entries[i];
    if (!n) continue;
    const prev = opMap.get(e.operation_id);
    if (prev !== undefined && prev !== n.operation_id) errs.push(`entry ${e.seq}: op not one map`);
    opMap.set(e.operation_id, n.operation_id);
  }
  const inv = new Map([...opMap].map(([a, b]) => [b, a]));
  if (inv.size !== opMap.size) errs.push("op mapping not injective");
  for (const [i, e] of src.entries()) {
    const n = entries[i] as Loose;
    if (!n) break;
    if (canonicalJson(preserved(e)) !== canonicalJson(preserved(n)))
      errs.push(`entry ${e.seq}: preserved fields changed`);
    for (const k of ["operation_id", "group_id", "parent_op", "undone_with"] as const)
      if ((e[k] === null) !== (n[k] === null) || (e[k] !== null && inv.get(n[k]) !== e[k]))
        errs.push(`entry ${e.seq}: ${k}`);
    const ro = e.effect.replaces_op;
    if (
      (ro === null) !== (n.effect.replaces_op === null) ||
      (ro !== null && inv.get(n.effect.replaces_op) !== ro)
    )
      errs.push(`entry ${e.seq}: replaces_op`);
    for (const k of ["follows", "continues"] as const) {
      const a = e.links[k];
      const b = n.links[k];
      if (a === null ? b !== null : opMap.has(a) ? b !== opMap.get(a) : b !== ext(inst, a))
        errs.push(`entry ${e.seq}: links.${k}`);
    }
    if (n.record_id !== record.id) errs.push(`entry ${e.seq}: record`);
    for (const p of n.participants) {
      if (p.record_id === record.id) continue;
      if (Object.hasOwn(target.characters, p.record_id) || !ID.extRecord.test(p.record_id))
        errs.push(
          `entry ${e.seq}: participant ${p.record_id} resolves locally or is not canonical`,
        );
      if (/^ext:[^:]+:ext:/.test(p.record_id)) errs.push(`entry ${e.seq}: nested ext`);
    }
    const enc = n.context.encounter_id;
    if (
      enc !== null &&
      (Object.hasOwn(target.encounters, enc) ||
        !ID.extEncounter.test(enc) ||
        /^ext:[^:]+:ext:/.test(enc))
    )
      errs.push(`entry ${e.seq}: encounter ${enc} resolves locally or is not canonical`);
  }
  const groups = (es: readonly Loose[], key: (x: string) => string) =>
    canonicalJson(es.map((x) => [x.seq, key(x.group_id)]));
  if (groups(src, (x) => x) !== groups(entries, (x) => inv.get(x) ?? `unmapped:${x}`))
    errs.push("groups not isomorphic");
  if (longRestCount(src) !== longRestCount(entries)) errs.push("Long Rest counters changed");
  const a = copy.payload.history.meta;
  if (
    (a === null) !== (meta === null) ||
    (a &&
      canonicalJson({ ...a, record_id: 0, rev: 0 }) !==
        canonicalJson({ ...meta, record_id: 0, rev: 0 }))
  )
    errs.push("days/head changed");
  if (new Set(entries.map((x) => x.id)).size !== entries.length) errs.push("duplicate entry ids");
  const kept = inheritedEncounterNames(record.origin);
  for (const e of copy.payload.external.encounters)
    if (kept.get(ext(inst, e.encounter_id)) !== e.name)
      errs.push(`external encounter name lost: ${e.encounter_id}`);
  return errs;
}
