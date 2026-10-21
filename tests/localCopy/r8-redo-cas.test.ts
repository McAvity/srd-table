/**
 * kenli F-007 T03 round 8 (review04 correction 1, R04-01): a Redo whose publication failed is
 * retried only while BOTH halves of the character are still exactly what that Redo wrote — the
 * document (`rev`) and the journal head (`history_meta.rev`, or no head for an empty journal) —
 * the same paired compare-and-set the autosave and Undo use. Another tab's change to either half
 * (simulated here by a direct database write, as that tab's autosave would make it) refuses the
 * retry with `redo_import_present`, writes nothing, publishes nothing stale, and a reload shows
 * the newer data. An unchanged copy's retry still works. Real store, engine and fake IndexedDB.
 */

import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  commitLocalCopy,
  localCopyFaults,
  redoLocalCopyImport,
  undoLocalCopyImport,
  useLocalCopySession,
} from "../../src/import/localCopy/commit";
import { exportLocalCopy } from "../../src/import/localCopy/export";
import type { LocalCopy } from "../../src/import/localCopy/format";
import { planLocalCopy } from "../../src/import/localCopy/plan";
import { db } from "../../src/persistence/db";
import { flushNow, isCommitted } from "../../src/persistence/sync";
import { useDocuments } from "../../src/store/documents";
import { type HistoryEntry, type HistoryMeta, useHistory } from "../../src/store/history";
import { rogue } from "../fixtures/characters";
import { testContext } from "../fixtures/player-actions";
import {
  addCharacter,
  dumpDb,
  exampleJournal,
  Installations,
  ok,
  rowsOf,
  storeTestPack,
  writeJournal,
} from "./helpers";

const inst = new Installations();
const docs = () => useDocuments.getState();
afterEach(() => {
  localCopyFaults.publish = null;
});
afterAll(() => inst.close());

async function exported(name: string, journal: boolean): Promise<LocalCopy> {
  await inst.open(name);
  await storeTestPack();
  const ctx = await testContext(inst.fx.engine);
  const id = await addCharacter(await rogue(inst.fx.engine, 5), ctx, inst.fx.engine);
  if (journal) {
    const j = exampleJournal(id);
    await writeJournal(j.entries, j.meta);
  }
  await inst.reload();
  return ok(await exportLocalCopy(id)).copy;
}

/** Import, Undo, then a Redo whose publication fails before the head: written, not shown. */
async function failedRedo(copy: LocalCopy, name: string): Promise<string> {
  await inst.open(name);
  const id = ok(
    await commitLocalCopy(await planLocalCopy(copy, "a".repeat(64), "r8.local-copy.json")),
  ).recordId;
  ok(await undoLocalCopyImport());
  localCopyFaults.publish = (step) => {
    if (step === "head") throw new Error("injected: after the record, before the head");
  };
  expect(await redoLocalCopyImport()).toMatchObject({ ok: false, code: "publication_failed" });
  localCopyFaults.publish = null;
  expect(docs().characters[id]).toBeUndefined();
  return id;
}

/** Simulated other tab: write as its autosave would (head rev + 1, the document untouched). */
async function otherTabHead(
  id: string,
  change: (m: HistoryMeta) => HistoryMeta,
  rows: HistoryEntry[] = [],
) {
  const database = await db();
  const tx = database.transaction(["history", "history_meta"], "readwrite");
  const head = (await tx.objectStore("history_meta").get(id)) ?? null;
  for (const e of rows) await tx.objectStore("history").put(e);
  const next = change(head as HistoryMeta);
  await tx.objectStore("history_meta").put({ ...next, rev: (head?.rev ?? 0) + 1 });
  await tx.done;
}

/** A refused retry: the database as the other tab left it, nothing shown, nothing stale. */
async function expectRefused(id: string) {
  const before = await dumpDb();
  const r = await redoLocalCopyImport();
  expect(r).toMatchObject({ ok: false, code: "redo_import_present" });
  expect(await dumpDb()).toBe(before);
  expect(docs().characters[id]).toBeUndefined();
  expect(useHistory.getState().meta[id]).toBeUndefined();
  expect(isCommitted(id)).toBe(false);
  // nothing for the autosave to save or to conflict on
  await flushNow();
  expect(useHistory.getState().saveState).toEqual({ status: "saved" });
  expect(await dumpDb()).toBe(before);
}

describe("Redo retry with the paired document + journal-head check", () => {
  it("the reviewer's case: another tab changed only a day label (head rev 2, document rev 1) → refused; a reload shows the newer head", async () => {
    const copy = await exported("S1", true);
    const id = await failedRedo(copy, "D1");
    await otherTabHead(id, (m) => ({
      ...m,
      days: m.days.map((d, i) => (i === 0 ? { ...d, label: "newer day from other tab" } : d)),
    }));
    await expectRefused(id);
    await inst.reload();
    const head = useHistory.getState().meta[id];
    expect(head).toMatchObject({ rev: 2 });
    expect(head?.days[0]?.label).toBe("newer day from other tab");
    inst.fx.dice.push(12);
    ok(await docs().rollTest(id, { skill: "stealth" }));
    await flushNow();
    expect(useHistory.getState().saveState).toEqual({ status: "saved" });
    expect((await (await db()).get("history_meta", id))?.rev).toBe(3);
  }, 60_000);

  it("a roll that changed only the journal (new entry, head rev 2) → refused; reload sees it", async () => {
    const copy = await exported("S2", true);
    const id = await failedRedo(copy, "D2");
    const rows = await rowsOf(id);
    const last = rows.at(-1) as HistoryEntry;
    const entry: HistoryEntry = {
      ...last,
      id: "h-othertab01",
      seq: 596,
      operation_id: "op-othertab01",
      group_id: "op-othertab01",
      parent_op: null,
      undone_with: null,
      status: "done",
      links: { follows: null, continues: null },
      effect: { ...last.effect, replaces_op: null },
    };
    await otherTabHead(id, (m) => ({ ...m, next_seq: 597 }), [entry]);
    await expectRefused(id);
    await inst.reload();
    expect((await rowsOf(id)).length).toBe(596);
    expect(useHistory.getState().meta[id]).toMatchObject({ rev: 2, next_seq: 597 });
  }, 60_000);

  it("an empty journal: another tab started a day (no head → head rev 1) → refused; reload sees the new head", async () => {
    const copy = await exported("S3", false);
    expect(copy.payload.history.meta).toBeNull();
    const id = await failedRedo(copy, "D3");
    expect(await (await db()).get("history_meta", id)).toBeUndefined();
    const day = { id: "d-othertab01", n: 1, label: "Started elsewhere", started_at: 1 };
    await otherTabHead(id, () => ({
      schema: "kenli.history-meta/1",
      record_id: id,
      rev: 0,
      next_seq: 1,
      current_day_id: day.id,
      days: [day],
    }));
    await expectRefused(id);
    await inst.reload();
    expect(useHistory.getState().meta[id]).toMatchObject({
      rev: 1,
      current_day_id: "d-othertab01",
    });
  }, 60_000);

  it("another tab changed the document (rev 2) → refused; reload sees it", async () => {
    const copy = await exported("S4", true);
    const id = await failedRedo(copy, "D4");
    const database = await db();
    const row = await database.get("characters", id);
    await database.put("characters", { ...(row as NonNullable<typeof row>), rev: 2, updated: 2 });
    await expectRefused(id);
    await inst.reload();
    expect(docs().characters[id]?.rev).toBe(2);
  }, 60_000);

  it("unchanged: the retry still shows the same copy whole, with its head, baseline and Undo", async () => {
    const copy = await exported("S5", true);
    const id = await failedRedo(copy, "D5");
    const rows = await rowsOf(id);
    ok(await redoLocalCopyImport());
    expect(useHistory.getState().meta[id]).toMatchObject({ rev: 1, next_seq: 596 });
    expect(isCommitted(id)).toBe(true);
    expect(useLocalCopySession.getState().last?.state).toBe("done");
    expect(await rowsOf(id)).toEqual(rows);
    inst.fx.dice.push(8);
    ok(await docs().rollTest(id, { skill: "stealth" }));
    await flushNow();
    expect(useHistory.getState().saveState).toEqual({ status: "saved" });
    expect((await (await db()).get("history_meta", id))?.rev).toBe(2);
  }, 60_000);

  it("unchanged empty journal: the retry still works and leaves no head", async () => {
    const copy = await exported("S6", false);
    const id = await failedRedo(copy, "D6");
    ok(await redoLocalCopyImport());
    expect(docs().characters[id]).toBeDefined();
    expect(useHistory.getState().meta[id]).toBeUndefined();
    await flushNow();
    expect(useHistory.getState().saveState).toEqual({ status: "saved" });
  }, 60_000);
});
