/**
 * kenli F-006 T02: the journal in IndexedDB through the real autosave and import (fake IndexedDB):
 * the v2 → v3 upgrade with no made-up history and lazy heads, a roll that changes nothing saved and
 * read back after a reload, statuses kept without the Undo stack, the journal head compared apart
 * from the document's revision (another tab's day or roll: a conflict, never a lost day or a second
 * seq), document and journal as one unit, a failed save written whole on retry, the unique index,
 * an import's boundary with its Undo and a reload, a changed journal refusing an import, copies,
 * new characters and deletion, a partly replaced party, and transfers without history.
 *
 * "Another tab" writes to the same database directly, as the contract's algorithm says it would
 * (its head with rev + 1): this process has one store, so a second running app can't be simulated.
 */

import { openDB } from "idb";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { commitPlan, type Plan, previewImport, type Source } from "../../src/import";
import { exportCharacter } from "../../src/import/export";
import { closeDb, DB_NAME, db } from "../../src/persistence/db";
import { entryCount, journal, longRests } from "../../src/persistence/history";
import { flushNow, installationId, loadAll, startAutosave } from "../../src/persistence/sync";
import { useDocuments } from "../../src/store/documents";
import {
  type HistoryEntry,
  type HistoryMeta,
  newMeta,
  sessionEntries,
  useHistory,
} from "../../src/store/history";
import { useUi } from "../../src/store/ui";
import { resetStores } from "../helpers/app";
import { engineWithDice, LIB, libraryFetch, snapshot } from "../helpers/transfer";

const docs = () => useDocuments.getState();
const hist = () => useHistory.getState();
let dice: number[] = [];
let stop: (() => void) | null = null;

beforeEach(async () => {
  await resetStores();
  dice = engineWithDice().dice;
  await loadAll();
  stop = startAutosave();
});
afterEach(() => {
  stop?.();
  stop = null;
});

async function reload() {
  stop?.();
  await closeDb();
  useDocuments.setState({ hydrated: false, characters: {}, encounters: {}, revs: {}, history: {} });
  hist().hydrate([]);
  dice = engineWithDice().dice;
  await loadAll();
  stop = startAutosave();
}
function ok<T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> {
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r as Extract<T, { ok: true }>;
}
const head = async (id: string) => (await db()).get("history_meta", id);
const rows = async (id: string) =>
  ((await (await db()).getAll("history")) as HistoryEntry[])
    .filter((e) => e.record_id === id)
    .sort((a, b) => a.seq - b.seq);

async function newCharacter(): Promise<string> {
  const id = await docs().createCharacter();
  ok(await docs().editBuild(id, { type: "class", id: "fighter" }));
  await flushNow();
  return id;
}

/** "Another tab": its own change of the journal, written as the autosave would (head rev + 1). */
async function otherTab(
  id: string,
  change: (m: HistoryMeta) => HistoryMeta,
  entries: HistoryEntry[] = [],
) {
  const database = await db();
  const m = (await database.get("history_meta", id)) as HistoryMeta;
  const tx = database.transaction(["history", "history_meta"], "readwrite");
  for (const e of entries) await tx.objectStore("history").put(e);
  await tx.objectStore("history_meta").put({ ...change(m), rev: m.rev + 1 });
  await tx.done;
}

function failPuts(store: string): () => void {
  const proto = IDBObjectStore.prototype;
  const original = proto.put;
  proto.put = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore["put"]>) {
    if (this.name === store) throw new DOMException("quota", "QuotaExceededError");
    return original.apply(this, args);
  };
  return () => {
    proto.put = original;
  };
}

describe("storage: upgrade, a roll that changes nothing, reload (AC-04, AC-06)", () => {
  it("v2 → v3 creates empty journal stores: no head, no entry made up; the first roll creates the head", async () => {
    stop?.();
    await closeDb();
    await new Promise<void>((r) => {
      const req = indexedDB.deleteDatabase(DB_NAME);
      req.onsuccess = () => r();
      req.onerror = () => r();
    });
    const old = await openDB(DB_NAME, 2, {
      upgrade(d) {
        d.createObjectStore("characters", { keyPath: "id" });
        d.createObjectStore("encounters", { keyPath: "id" });
        d.createObjectStore("settings");
        d.createObjectStore("portraits");
        d.createObjectStore("packs", { keyPath: "key" });
      },
    });
    const engine = engineWithDice();
    dice = engine.dice;
    const build = await engine.engine.editBuild(await engine.engine.newBuild(), {
      type: "class",
      id: "fighter",
    });
    if (!build.ok) throw new Error("build");
    const state = await engine.engine.createState(build.build);
    await old.put("characters", {
      id: "c-old",
      build: build.build,
      state,
      created: 1,
      updated: 1,
      rev: 4,
    });
    old.close();
    useDocuments.setState({
      hydrated: false,
      characters: {},
      encounters: {},
      revs: {},
      history: {},
    });
    await loadAll();
    stop = startAutosave();
    const database = await db();
    expect(database.version).toBe(3);
    expect(await database.getAll("history")).toEqual([]);
    expect(await database.getAll("history_meta")).toEqual([]);
    expect(hist().meta).toEqual({});
    expect(await journal("c-old")).toEqual([]);
    dice.push(9);
    ok(await docs().rollTest("c-old", { skill: "athletics" }));
    await flushNow();
    expect((await database.get("characters", "c-old"))?.rev).toBe(4); // the document untouched
    expect(await head("c-old")).toMatchObject({ rev: 1, next_seq: 2 });
    expect(await rows("c-old")).toEqual([
      expect.objectContaining({ kind: "test", seq: 1, commit: false }),
    ]);
  });

  it("statuses survive a reload; the Undo stack doesn't", async () => {
    const id = await newCharacter();
    ok(await docs().playAction(id, { type: "damage", amount: 2 }));
    dice.push(7);
    ok(await docs().rollTest(id, { skill: "athletics" }));
    await docs().undo(id);
    await flushNow();
    await reload();
    expect(docs().history[id]).toBeUndefined();
    expect((await journal(id)).map((e) => [e.kind, e.status])).toEqual([
      ["play", "undone"],
      ["test", "done"],
    ]);
    expect(sessionEntries(id)).toEqual([]); // read on demand, not loaded at start
    expect(hist().meta[id]).toMatchObject({ next_seq: 3 });
  });
});

describe("two tabs on one database: the journal head (R02-01)", () => {
  it("day only: another tab's day is kept, this tab's is a conflict, not retried; after a reload it reads theirs", async () => {
    const id = await newCharacter();
    hist().ensureMeta(id);
    await flushNow();
    const rev = (await (await db()).get("characters", id))?.rev;
    await otherTab(id, (m) => ({
      ...m,
      days: [...m.days, { id: "d-theirs", n: 2, label: "Camp B", started_at: 1 }],
      current_day_id: "d-theirs",
    }));
    expect(hist().startNextDay(id, "Camp A")).toEqual({ ok: true });
    await flushNow();
    const saved = (await head(id)) as HistoryMeta;
    expect(saved.days.map((d) => d.label)).toEqual([null, "Camp B"]);
    expect(saved.rev).toBe(2);
    expect((await (await db()).get("characters", id))?.rev).toBe(rev); // the document's rev passed
    expect(hist().conflicts).toEqual({ [id]: "history" });
    expect(hist().saveState).toEqual({ status: "conflict", records: [id] });
    expect(useUi.getState().toasts.at(-1)?.lines.join(" ")).toMatch(
      /history or days .* another tab/,
    );
    hist().renameDay(id, hist().meta[id]?.current_day_id as string, "Camp A2");
    await flushNow(); // not tried again
    expect(((await head(id)) as HistoryMeta).rev).toBe(2);
    await reload();
    expect(hist().meta[id]?.days.map((d) => d.label)).toEqual([null, "Camp B"]);
    expect(hist().conflicts).toEqual({});
  });

  it("roll only: the same next seq in both tabs is a conflict, not a ConstraintError; after a reload the next roll takes seq 2", async () => {
    const id = await newCharacter();
    hist().ensureMeta(id);
    await flushNow();
    const theirs = { ...(await sampleEntry(id)), id: "h-theirs", seq: 1 };
    await otherTab(id, (m) => ({ ...m, next_seq: 2 }), [theirs]);
    dice.push(5);
    ok(await docs().rollTest(id, { skill: "athletics" }));
    expect(sessionEntries(id)[0]?.seq).toBe(1);
    await flushNow();
    expect(hist().saveState.status).toBe("conflict");
    expect((await rows(id)).map((e) => e.id)).toEqual(["h-theirs"]);
    await reload();
    dice.push(6);
    ok(await docs().rollTest(id, { skill: "athletics" }));
    await flushNow();
    expect((await rows(id)).map((e) => [e.seq, e.id === "h-theirs"])).toEqual([
      [1, true],
      [2, false],
    ]);
  });

  it("a document change waits with its journal: another tab's journal change stops both", async () => {
    const id = await newCharacter();
    hist().ensureMeta(id);
    await flushNow();
    const before = (await (await db()).get("characters", id))?.rev;
    await otherTab(id, (m) => m);
    ok(await docs().playAction(id, { type: "damage", amount: 3 }));
    await flushNow();
    expect((await (await db()).get("characters", id))?.rev).toBe(before);
    expect(await rows(id)).toEqual([]);
    expect(hist().conflicts[id]).toBe("history");
  });

  it("a lazy head made in two tabs: the second one to save gets the conflict", async () => {
    const id = await newCharacter();
    const theirs = { ...newMeta(id), rev: 1 }; // the other tab saved its first head first
    await (await db()).put("history_meta", theirs);
    const mine = hist().ensureMeta(id); // this tab's own first head, never saved
    expect(mine.current_day_id).not.toBe(theirs.current_day_id);
    await flushNow();
    expect(hist().conflicts[id]).toBe("history");
    expect(await head(id)).toEqual(theirs);
  });
});

/** A complete entry for a record (from this tab's own capture, then forgotten). */
async function sampleEntry(id: string): Promise<HistoryEntry> {
  dice.push(2);
  ok(await docs().rollTest(id, { skill: "athletics" }));
  const e = sessionEntries(id).at(-1) as HistoryEntry;
  useHistory.setState((s) => {
    const { [e.id]: _gone, ...entries } = s.entries;
    const m = s.meta[id] as HistoryMeta;
    return { entries, meta: { ...s.meta, [id]: { ...m, next_seq: m.next_seq - 1 } } };
  });
  return e;
}

describe("a failed save, retried; the unique index (AC-04)", () => {
  it("quota: nothing of the character is written (document nor journal); the retry writes the same rows once", async () => {
    const id = await newCharacter();
    const before = (await (await db()).get("characters", id))?.rev;
    dice.push(4);
    ok(await docs().rollTest(id, { skill: "athletics" }));
    ok(await docs().playAction(id, { type: "damage", amount: 1 }));
    const restore = failPuts("history");
    await expect(flushNow()).rejects.toThrow();
    restore();
    expect(hist().saveState.status).toBe("failed");
    expect(await rows(id)).toEqual([]);
    expect((await (await db()).get("characters", id))?.rev).toBe(before);
    await flushNow();
    const ids = sessionEntries(id).map((e) => e.id);
    expect((await rows(id)).map((e) => e.id)).toEqual(ids);
    const rev = ((await head(id)) as HistoryMeta).rev;
    await flushNow();
    expect((await rows(id)).map((e) => e.id)).toEqual(ids);
    expect(((await head(id)) as HistoryMeta).rev).toBe(rev);
    expect(hist().saveState).toEqual({ status: "saved" });
  });

  it("a row taking a seq without its head (never by the app) aborts the whole save: nothing written", async () => {
    const id = await newCharacter();
    hist().ensureMeta(id);
    await flushNow();
    const stray = { ...(await sampleEntry(id)), id: "h-stray", seq: 1 };
    await (await db()).put("history", stray); // no head change: the comparison can't see it
    dice.push(3);
    ok(await docs().rollTest(id, { skill: "athletics" }));
    await expect(flushNow()).rejects.toThrow();
    expect(hist().saveState.status).toBe("failed");
    expect((await rows(id)).map((e) => e.id)).toEqual(["h-stray"]);
  });
});

describe("import, copy, delete (R01-02, AC-06)", () => {
  async function preview(source: Source): Promise<Plan> {
    const p = await previewImport(source, {
      signal: new AbortController().signal,
      fetch: libraryFetch(),
    });
    if (!p.ok) throw new Error(`${p.problem.code}: ${p.problem.detail}`);
    return p.plan;
  }
  const byName = (name: string) =>
    Object.values(docs().characters).find((c) => c.build.name === name);
  const keyOf = (plan: Plan, title: string) =>
    plan.characters.find((c) => c.title === title)?.key as string;

  it("replace keeps the journal and days, adds one boundary; its Undo is a status; all survives a reload", async () => {
    ok(await commitPlan(await preview({ url: snapshot("wren") }), { characters: {} }));
    const id = byName("Wren")?.id as string;
    expect(await journal(id)).toEqual([]); // a new import starts empty
    ok(await docs().playAction(id, { type: "damage", amount: 1 }));
    ok(await docs().playAction(id, { type: "long_rest" }));
    hist().startNextDay(id, "Road");
    await flushNow();
    const plan = await preview({ url: snapshot("wren") });
    ok(
      await commitPlan(plan, {
        characters: { [keyOf(plan, "Wren")]: { kind: "replace", target: id, confirmed: true } },
      }),
    );
    const boundary = (await rows(id)).at(-1) as HistoryEntry;
    expect(boundary).toMatchObject({
      kind: "import_boundary",
      seq: 3,
      day_id: hist().meta[id]?.current_day_id,
      import: { mode: "replace", gen_before: 0, gen_after: 1 },
      costs: [],
    });
    expect(boundary.import?.origin).toMatchObject({ kind: "import" });
    expect(((await head(id)) as HistoryMeta).next_seq).toBe(4);
    await docs().undo(id);
    expect(docs().characters[id]?.gen).toBe(2);
    await flushNow();
    expect((await rows(id)).at(-1)?.status).toBe("undone");
    await reload();
    expect((await journal(id)).map((e) => [e.kind, e.status])).toEqual([
      ["play", "done"],
      ["long_rest", "done"],
      ["import_boundary", "undone"],
    ]);
    expect(hist().meta[id]?.days.map((d) => d.label)).toEqual([null, "Road"]);
    expect((await longRests(id)).total).toBe(1);
  });

  it("an import refuses a character whose journal changed in another tab: nothing written", async () => {
    ok(await commitPlan(await preview({ url: snapshot("wren") }), { characters: {} }));
    const id = byName("Wren")?.id as string;
    hist().ensureMeta(id);
    await flushNow();
    await otherTab(id, (m) => m);
    const plan = await preview({ url: snapshot("wren") });
    const r = await commitPlan(plan, {
      characters: { [keyOf(plan, "Wren")]: { kind: "replace", target: id, confirmed: true } },
    });
    expect(r.ok ? [] : r.problems.map((p) => p.code)).toEqual(["history_changed"]);
    expect(docs().characters[id]?.gen ?? 0).toBe(0);
    expect(await rows(id)).toEqual([]);
  });

  it("a copy and a new character start empty; a deleted character's journal goes with it, others keep theirs", async () => {
    const id = await newCharacter();
    const other = await newCharacter();
    dice.push(5);
    ok(await docs().rollTest(id, { skill: "athletics" }));
    ok(await docs().rollTest(other, { skill: "athletics" }));
    hist().startNextDay(id);
    await flushNow();
    const copy = (await docs().duplicateCharacter(id)) as string;
    expect(await journal(copy)).toEqual([]);
    expect(hist().meta[copy]).toBeUndefined();
    expect(hist().ensureMeta(copy).days).toHaveLength(1); // its own first day
    expect(await journal(await docs().createCharacter())).toEqual([]);
    expect(await entryCount(id)).toBe(1);
    await docs().deleteCharacter(id);
    await flushNow();
    expect(await rows(id)).toEqual([]);
    expect(await head(id)).toBeUndefined();
    expect(await rows(other)).toHaveLength(1);
    await reload();
    expect(await journal(id)).toEqual([]);
  });

  it("a partly replaced party: a boundary for the replaced one only; an older encounter step skips it", async () => {
    ok(
      await commitPlan(await preview({ url: `${LIB}d/encounter/mixed-duel.json` }), {
        characters: {},
      }),
    );
    const eid = Object.keys(docs().encounters)[0] as string;
    const wren = byName("Wren")?.id as string;
    const sable = byName("Sable")?.id as string;
    const run = async (
      action: Parameters<ReturnType<typeof docs>["encounterAction"]>[1],
      ...rolls: number[]
    ) => {
      dice.push(...rolls);
      return ok(await docs().encounterAction(eid, action));
    };
    await run([
      { type: "set_initiative", id: "sable", value: 20 },
      { type: "set_initiative", id: "wren", value: 15 },
      { type: "set_initiative", id: "synthetic-dummy", value: 1 },
      { type: "start" },
    ]);
    await run(
      { type: "cast", id: "sable", spell: "synthetic-spark", targets: ["wren"], slot_level: 1 },
      15,
      3,
      3,
    );
    const op = sessionEntries(sable)[0]?.operation_id;
    expect(sessionEntries(wren)[0]?.operation_id).toBe(op);
    await flushNow();
    const plan = await preview({ url: `${LIB}d/encounter/mixed-duel.json` });
    ok(
      await commitPlan(plan, {
        characters: {
          [keyOf(plan, "Wren")]: { kind: "replace", target: wren, confirmed: true },
          [keyOf(plan, "Sable")]: { kind: "use", target: sable },
        },
        encounter: { kind: "replace", target: eid, confirmed: true },
      }),
    );
    expect((await journal(wren)).map((e) => e.kind)).toEqual(["encounter", "import_boundary"]);
    expect((await journal(sable)).map((e) => e.kind)).toEqual(["encounter"]);
    await docs().undo(eid); // the import's encounter step: no character restored
    await docs().undo(eid); // the cast: Sable restored, Wren (replaced since) keeps its own state
    expect(sessionEntries(sable)[0]?.status).toBe("undone");
    expect((await journal(wren)).map((e) => e.status)).toEqual(["done", "done"]);
  });

  it("a transfer carries no history (F-008 unchanged)", async () => {
    const id = await newCharacter();
    dice.push(5);
    ok(await docs().rollTest(id, { skill: "athletics" }));
    hist().startNextDay(id, "Road");
    await flushNow();
    const record = docs().characters[id];
    if (!record) throw new Error("gone");
    const env = await exportCharacter(record, installationId());
    const text = JSON.stringify(env);
    expect(text).not.toMatch(/kenli\.history|history_meta|"Road"|day_id/);
  });
});
