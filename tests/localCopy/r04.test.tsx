/**
 * kenli F-007 T03 round 7 (review04 R04-01..03), on the real store, autosave, engine and fake
 * IndexedDB, and the real History panel:
 *  R04-01 a publication failing at ANY step (packs, record, head, baseline) — first import and
 *         Redo — leaves nothing half shown: "saved, not shown", the autosave saves without a
 *         conflict and never touches the copy; a retry publishes it whole (head, baseline, Undo),
 *         play goes on normally; a retry after a complete publication leaves newer play alone.
 *  R04-02 opaque historical request/result/roll/delta of any JSON shape import verbatim and the
 *         panel stays readable (no error boundary), with neutral labels where a field isn't text.
 *  R04-03 a build or state the engine would read differently (a literal version, a default added
 *         by parse) is refused before anything is written; a valid copy stays exactly equal after
 *         reload.
 */

import { cleanup, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { titleOf } from "../../src/features/history/format";
import {
  commitLocalCopy,
  localCopyFaults,
  type PublishStep,
  redoLocalCopyImport,
  undoLocalCopyImport,
  useLocalCopySession,
} from "../../src/import/localCopy/commit";
import { exportLocalCopy } from "../../src/import/localCopy/export";
import { type LocalCopy, validateLocalCopy } from "../../src/import/localCopy/format";
import { planLocalCopy } from "../../src/import/localCopy/plan";
import { canonicalJson, contentSha } from "../../src/lib/canonical";
import { db } from "../../src/persistence/db";
import { flushNow, isCommitted, savedHead, unsavedState } from "../../src/persistence/sync";
import { useDocuments } from "../../src/store/documents";
import { type HistoryEntry, useHistory } from "../../src/store/history";
import { useUi } from "../../src/store/ui";
import { rogue } from "../fixtures/characters";
import { testContext } from "../fixtures/player-actions";
import { installTestEngine, renderApp } from "../helpers/app";
import {
  addCharacter,
  dumpDb,
  exampleJournal,
  Installations,
  type Loose,
  ok,
  rowsOf,
  storeTestPack,
  writeJournal,
} from "./helpers";

installTestEngine(3);
const inst = new Installations();
const docs = () => useDocuments.getState();
afterEach(() => {
  cleanup();
  localCopyFaults.publish = null;
  vi.restoreAllMocks();
});
afterAll(() => inst.close());

/** A source with the contract's journal; `edit` may change its entries before it is saved. */
async function source(name: string, edit?: (entries: HistoryEntry[]) => void) {
  await inst.open(name);
  await storeTestPack();
  const ctx = await testContext(inst.fx.engine);
  const id = await addCharacter(await rogue(inst.fx.engine, 5), ctx, inst.fx.engine);
  const j = exampleJournal(id);
  edit?.(j.entries);
  await writeJournal(j.entries, j.meta);
  await inst.reload();
  return { id, copy: ok(await exportLocalCopy(id)).copy };
}

const bytes = (c: unknown) => new TextEncoder().encode(JSON.stringify(c));
async function rehashed(c: LocalCopy): Promise<LocalCopy> {
  return { ...c, payload_sha256: await contentSha(c.payload) };
}
async function planOf(copy: LocalCopy) {
  const v = ok(await validateLocalCopy(bytes(copy)));
  return planLocalCopy(v.copy, v.bytes_sha256, "r04.local-copy.json");
}
const failAt = (at: PublishStep) => {
  localCopyFaults.publish = (step) => {
    if (step === at) throw new Error(`injected failure before ${step}`);
  };
};

describe("R04-01: a publication is whole or not shown", () => {
  const STEPS: PublishStep[] = ["packs", "record", "head", "baseline"];

  it.each(STEPS)(
    "fails before %s: saved not shown, no conflict; the retry publishes it whole and play goes on",
    async (step) => {
      const src = await source(`P-${step}`);
      await inst.open(`P-${step}-dest`);
      const plan = await planOf(src.copy);
      failAt(step);
      const r = await commitLocalCopy(plan);
      expect(r.ok).toBe("saved_unpublished");
      const id = (r as { recordId: string }).recordId;
      // nothing half shown: no record, no head, no baseline; the copy is whole in the database
      expect(docs().characters[id]).toBeUndefined();
      expect(useHistory.getState().meta[id]).toBeUndefined();
      expect(isCommitted(id)).toBe(false);
      expect(await rowsOf(id)).toHaveLength(595);
      const saved = await dumpDb();
      await flushNow();
      expect(useHistory.getState().saveState).toEqual({ status: "saved" });
      expect(await dumpDb()).toBe(saved); // the autosave neither deletes nor writes over it
      localCopyFaults.publish = null;
      const retry = ok(await commitLocalCopy(plan));
      expect(retry.recordId).toBe(id);
      expect(useHistory.getState().meta[id]).toMatchObject({ rev: 1, next_seq: 596 });
      expect(savedHead(id)).toEqual({ rev: 1, conflicted: false });
      expect(isCommitted(id)).toBe(true);
      expect(useLocalCopySession.getState().last).toMatchObject({
        import_id: plan.import_id,
        state: "done",
      });
      expect(unsavedState(id)).toEqual({ entries: 0, days: false });
      await flushNow();
      expect(useHistory.getState().saveState).toEqual({ status: "saved" });
      expect(await dumpDb()).toBe(saved);
      // a normal next action: entry 596, head rev 2, saved
      inst.fx.dice.push(14);
      ok(await docs().rollTest(id, { skill: "stealth" }));
      await flushNow();
      expect(useHistory.getState().saveState).toEqual({ status: "saved" });
      expect((await rowsOf(id)).at(-1)).toMatchObject({ seq: 596, kind: "test" });
      expect((await (await db()).get("history_meta", id))?.rev).toBe(2);
      expect((await (await db()).getAll("characters")).filter((c) => c.id === id)).toHaveLength(1);
    },
    60_000,
  );

  it("the reviewer's case: the head's publication throws once after the record's — retried whole", async () => {
    const src = await source("P-spy");
    await inst.open("P-spy-dest");
    const plan = await planOf(src.copy);
    vi.spyOn(useHistory.getState(), "published").mockImplementationOnce(() => {
      throw new Error("failure after the document's publication");
    });
    const failed = await commitLocalCopy(plan);
    expect(failed.ok).toBe("saved_unpublished");
    const id = (failed as { recordId: string }).recordId;
    expect(docs().characters[id]).toBeUndefined();
    ok(await commitLocalCopy(plan));
    expect(useHistory.getState().meta[id]).toMatchObject({ next_seq: 596, rev: 1 });
    await flushNow();
    expect(useHistory.getState().saveState.status).toBe("saved");
  }, 60_000);

  it("a retry after a complete publication leaves newer, unsaved play as it is", async () => {
    const src = await source("P-newer");
    await inst.open("P-newer-dest");
    const plan = await planOf(src.copy);
    const id = ok(await commitLocalCopy(plan)).recordId;
    inst.fx.dice.push(9);
    ok(await docs().rollTest(id, { skill: "stealth" }));
    const played = docs().characters[id];
    const head = useHistory.getState().meta[id];
    expect(unsavedState(id).entries).toBe(1);
    expect(ok(await commitLocalCopy(plan)).recordId).toBe(id);
    expect(docs().characters[id]).toBe(played);
    expect(useHistory.getState().meta[id]).toBe(head);
    expect(unsavedState(id).entries).toBe(1);
    await flushNow();
    expect(await rowsOf(id)).toHaveLength(596);
    expect(useHistory.getState().saveState.status).toBe("saved");
  }, 60_000);

  it.each(STEPS)(
    "Redo whose publication fails before %s: written, not shown, Redo still offered; retried whole",
    async (step) => {
      const src = await source(`R-${step}`);
      await inst.open(`R-${step}-dest`);
      const id = ok(await commitLocalCopy(await planOf(src.copy))).recordId;
      const rows = await rowsOf(id);
      ok(await undoLocalCopyImport());
      failAt(step);
      expect(await redoLocalCopyImport()).toMatchObject({ ok: false, code: "publication_failed" });
      expect(docs().characters[id]).toBeUndefined();
      expect(useHistory.getState().meta[id]).toBeUndefined();
      expect(useLocalCopySession.getState().last?.state).toBe("undone");
      expect(await rowsOf(id)).toEqual(rows); // written again, once
      await flushNow();
      expect(useHistory.getState().saveState.status).toBe("saved");
      expect(await rowsOf(id)).toEqual(rows);
      localCopyFaults.publish = null;
      ok(await redoLocalCopyImport());
      expect(useHistory.getState().meta[id]).toMatchObject({ rev: 1, next_seq: 596 });
      expect(isCommitted(id)).toBe(true);
      expect(useLocalCopySession.getState().last?.state).toBe("done");
      await flushNow();
      expect(useHistory.getState().saveState.status).toBe("saved");
      // Undo and Redo keep working, and a reload keeps the copy
      ok(await undoLocalCopyImport());
      ok(await redoLocalCopyImport());
      await inst.reload();
      expect(await rowsOf(id)).toEqual(rows);
      expect(useHistory.getState().meta[id]?.rev).toBe(1);
    },
    60_000,
  );
});

// ───────────────────────── R04-02 ─────────────────────────

const OPAQUE: unknown[] = [
  { type: { opaque: true } },
  null,
  7,
  "plain",
  true,
  [1, { type: 3 }, null],
  { type: null },
  { type: ["a"] },
];

/** The last play entries get opaque requests; a test, a damage, a sheet roll, a rest odd results. */
function opaqueJournal(entries: HistoryEntry[]) {
  const last = (kind: string, n = 1) =>
    entries
      .map((e, i) => [e, i] as const)
      .filter(([e]) => e.kind === kind)
      .slice(-n)
      .map(([, i]) => i);
  const plays = last("play", OPAQUE.length);
  plays.forEach((i, k) => {
    entries[i] = { ...(entries[i] as HistoryEntry), request: OPAQUE[k] };
  });
  const set = (kind: string, patch: (e: Loose) => Loose) => {
    const [i] = last(kind);
    if (i !== undefined) entries[i] = patch(structuredClone(entries[i]));
  };
  set("test", (e) => ({ ...e, result: { label: { not: "text" }, roll: "x" } }));
  set("damage", (e) => ({ ...e, request: { label: [1, 2] }, result: [] }));
  set("sheet_roll", (e) => ({ ...e, result: { name: null, rolls: 5 } }));
  set("encounter", (e) => ({ ...e, request: [{ type: { deep: [1] } }, 3, null] }));
  set("short_rest", (e) =>
    e.rest?.dice?.length
      ? { ...e, rest: { ...e.rest, dice: [{ ...e.rest.dice[0], roll: { total: { odd: 1 } } }] } }
      : e,
  );
  // the newest entries carry these shapes, so the panel's first page shows them
  return entries;
}

describe("R04-02: opaque historical values never break the panel", () => {
  it("valid copy with opaque request/result/roll/delta values: imported verbatim, titles never throw, the real panel reads", async () => {
    const src = await source("O1", opaqueJournal);
    const shapes = src.copy.payload.history.entries;
    for (const e of shapes) expect(() => titleOf(e)).not.toThrow();
    await inst.open("O2");
    const v = ok(await validateLocalCopy(bytes(src.copy)));
    const id = ok(
      await commitLocalCopy(await planLocalCopy(v.copy, v.bytes_sha256, "o.local-copy.json")),
    ).recordId;
    const rows = await rowsOf(id);
    // every opaque value kept exactly
    expect(
      canonicalJson(
        rows.map((e) => [e.request, e.result, e.messages, e.effect.state_delta, e.rest ?? null]),
      ),
    ).toBe(
      canonicalJson(
        shapes.map((e) => [e.request, e.result, e.messages, e.effect.state_delta, e.rest ?? null]),
      ),
    );
    for (const e of rows) expect(typeof titleOf(e)).toBe("string");
    // the actual History panel on the copy
    useUi.setState({ history: { open: true, character: id } });
    await renderApp(`/characters/${id}/sheet`);
    await waitFor(() => expect(screen.getAllByTestId("history-entry").length).toBeGreaterThan(20), {
      timeout: 20_000,
    });
    expect(screen.queryByText(/Something went wrong/)).toBeNull();
    expect(screen.queryAllByTestId("history-unreadable")).toHaveLength(0); // the guards suffice
    const text = document.body.textContent ?? "";
    expect(text).toMatch(/Sheet: /); // neutral labels, still titled
    expect(text).toMatch(/Roll: /);
    expect(text).not.toContain("[object Object]");
  }, 90_000);
});

// ───────────────────────── R04-03 ─────────────────────────

describe("R04-03: the engine must read a copy exactly as written", () => {
  const cases: [string, (c: Loose) => void, string][] = [
    [
      "state.version 2 (parse makes it 1)",
      (c) => {
        c.payload.character.state.version = 2;
      },
      "state_would_change",
    ],
    [
      "state without hp (parse adds its default)",
      (c) => {
        delete c.payload.character.state.hp;
      },
      "state_would_change",
    ],
    [
      "state without inventory (parse adds a default)",
      (c) => {
        delete c.payload.character.state.inventory;
      },
      "state_would_change",
    ],
    [
      "build without version (parse adds it)",
      (c) => {
        delete c.payload.character.build.version;
      },
      "build_invalid",
    ],
    [
      "build without rolled_pool (parse adds it)",
      (c) => {
        delete c.payload.character.build.rolled_pool;
      },
      "build_invalid",
    ],
  ];

  it.each(cases)(
    "%s → refused, nothing written",
    async (_name, mutate, code) => {
      const src = await source("N1");
      const c = structuredClone(src.copy) as Loose;
      mutate(c);
      const changed = await rehashed(c);
      const v = await validateLocalCopy(bytes(changed));
      expect(v).toMatchObject({ ok: false, code });
      // also at commit (a plan built before would be checked again): nothing written
      await inst.open("N2");
      const before = await dumpDb();
      const unchecked = await planLocalCopy(changed, "0".repeat(64), "n.local-copy.json");
      expect(await commitLocalCopy(unchecked)).toMatchObject({ ok: false, code });
      expect(await dumpDb()).toBe(before);
    },
    60_000,
  );

  it("a valid copy's documents stay exactly equal after import and reload", async () => {
    const src = await source("N3");
    await inst.open("N4");
    const id = ok(await commitLocalCopy(await planOf(src.copy))).recordId;
    const docsOf = async () => {
      const row = await (await db()).get("characters", id);
      return canonicalJson([
        row?.build,
        row?.state,
        docs().characters[id]?.build,
        docs().characters[id]?.state,
      ]);
    };
    const want = canonicalJson([
      src.copy.payload.character.build,
      src.copy.payload.character.state,
      src.copy.payload.character.build,
      src.copy.payload.character.state,
    ]);
    expect(await docsOf()).toBe(want);
    await inst.reload();
    expect(await docsOf()).toBe(want);
  }, 60_000);
});
