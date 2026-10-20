/**
 * kenli F-006 R03-01: which operation a `decide` continues survives what the encounter survives — an
 * actual save and reload, Undo/Redo of the answer and of the stop, several encounters, an import
 * replacing the encounter (a new generation) and its Undo. The link is the encounter record's own
 * (`pending_op`, next to the engine's document), never parsed from text or guessed from the journal.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { commitPlan, type Plan, previewImport, type Source } from "../../src/import";
import { closeDb } from "../../src/persistence/db";
import { journal } from "../../src/persistence/history";
import { flushNow, loadAll, startAutosave } from "../../src/persistence/sync";
import { useDocuments } from "../../src/store/documents";
import { type HistoryEntry, sessionEntries, useHistory } from "../../src/store/history";
import { rogue } from "../fixtures/characters";
import { storeCharacter } from "../fixtures/player-actions";
import { resetStores } from "../helpers/app";
import { engineWithDice, LIB, libraryFetch } from "../helpers/transfer";

const docs = () => useDocuments.getState();
let fx = engineWithDice();
let stop: (() => void) | null = null;

beforeEach(async () => {
  await resetStores();
  fx = engineWithDice();
  await loadAll();
  stop = startAutosave();
});
afterEach(() => {
  stop?.();
  stop = null;
});

function ok<T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> {
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r as Extract<T, { ok: true }>;
}

async function reload() {
  await flushNow();
  stop?.();
  await closeDb();
  useDocuments.setState({ hydrated: false, characters: {}, encounters: {}, revs: {}, history: {} });
  useHistory.getState().hydrate([]);
  fx = engineWithDice();
  await loadAll();
  stop = startAutosave();
}

/** A rogue (Uncanny Dodge, `ask`) in a fight with a goblin that acts first. */
async function dodgeFight(name = "Dodge") {
  const rid = await storeCharacter(fx.engine, await rogue(fx.engine, 5));
  const eid = await docs().createEncounter(name);
  ok(
    await docs().encounterAction(eid, [
      { type: "add_character", character: rid, id: "rogue", decisions: "ask" },
      { type: "add_monster", monster: "goblin-warrior" },
      { type: "set_initiative", id: "goblin-warrior", value: 20 },
      { type: "set_initiative", id: "rogue", value: 1 },
      { type: "start" },
    ]),
  );
  return { rid, eid };
}

async function hitAndStop(eid: string) {
  fx.dice.push(19, 6);
  const r = ok(
    await docs().encounterAction(eid, {
      type: "attack",
      id: "goblin-warrior",
      target: "rogue",
      attack: "Scimitar",
    }),
  );
  expect(r.pending?.kind).toBe("uncanny_dodge");
}

const last = (rid: string) => sessionEntries(rid).at(-1) as HistoryEntry;

describe("R03-01: the operation a decision continues", () => {
  it("survives an actual save and reload: decide continues the saved stopped operation", async () => {
    const { rid, eid } = await dodgeFight();
    await hitAndStop(eid);
    const stopped = last(rid);
    expect(stopped).toMatchObject({ pending_decision: true });
    await reload();
    expect(docs().encounters[eid]?.encounter.pending).not.toBeNull();
    ok(await docs().encounterAction(eid, { type: "decide", use: true }));
    expect(last(rid).links.continues).toBe(stopped.operation_id);
    await flushNow();
    const saved = await journal(rid);
    expect(saved.map((e) => [e.operation_id === stopped.operation_id, e.links.continues])).toEqual([
      [true, null],
      [false, stopped.operation_id],
    ]);
  });

  it("an answer undone and given again continues the same stop; Redo restores the first answer's entry", async () => {
    const { rid, eid } = await dodgeFight();
    await hitAndStop(eid);
    const stopped = last(rid);
    ok(await docs().encounterAction(eid, { type: "decide", use: true }));
    const first = last(rid);
    await docs().undo(eid);
    expect(docs().encounters[eid]?.encounter.pending).not.toBeNull();
    await reload(); // the restored pending survives a reload too
    ok(await docs().encounterAction(eid, { type: "decide", use: false }));
    const second = last(rid);
    expect(second.links.continues).toBe(stopped.operation_id);
    await docs().undo(eid);
    await docs().redo(eid);
    expect(last(rid)).toMatchObject({ operation_id: second.operation_id, status: "done" });
    await flushNow();
    const firstRow = (await journal(rid)).find((e) => e.operation_id === first.operation_id);
    expect(firstRow?.status).toBe("undone"); // the abandoned answer stays undone, not relinked
  });

  it("an undone stop leaves nothing to continue; a new stop is the one continued", async () => {
    const { rid, eid } = await dodgeFight();
    await hitAndStop(eid);
    const old = last(rid);
    await docs().undo(eid); // the stopped attack itself
    expect(docs().encounters[eid]?.encounter.pending).toBeNull();
    expect(docs().encounters[eid]?.pending_op).toBeUndefined();
    await hitAndStop(eid);
    const fresh = last(rid);
    ok(await docs().encounterAction(eid, { type: "decide", use: true }));
    expect(last(rid).links.continues).toBe(fresh.operation_id);
    expect(last(rid).links.continues).not.toBe(old.operation_id);
  });

  it("two encounters stopped at once: each decision continues its own encounter's stop", async () => {
    const a = await dodgeFight("A");
    const b = await dodgeFight("B");
    await hitAndStop(a.eid);
    await hitAndStop(b.eid);
    const stopA = last(a.rid);
    const stopB = last(b.rid);
    await reload();
    ok(await docs().encounterAction(b.eid, { type: "decide", use: true }));
    ok(await docs().encounterAction(a.eid, { type: "decide", use: false }));
    expect(last(b.rid).links.continues).toBe(stopB.operation_id);
    expect(last(a.rid).links.continues).toBe(stopA.operation_id);
  });

  it("an import replacing the stopped encounter (a new generation) carries no link; its Undo brings the old stop back", async () => {
    const { rid, eid } = await dodgeFight();
    await hitAndStop(eid);
    const stopped = last(rid);
    await flushNow();
    const source: Source = { url: `${LIB}d/encounter/mixed-duel.json` };
    const p = await previewImport(source, { signal: new AbortController().signal, fetch: libraryFetch() });
    if (!p.ok) throw new Error(p.problem.code);
    const plan: Plan = p.plan;
    ok(
      await commitPlan(plan, {
        characters: {},
        encounter: { kind: "replace", target: eid, confirmed: true },
      }),
    );
    expect(docs().encounters[eid]?.gen).toBe(1);
    expect(docs().encounters[eid]?.pending_op).toBeUndefined();
    await reload();
    expect(docs().encounters[eid]?.encounter.pending).toBeNull();
    expect(docs().encounters[eid]?.pending_op).toBeUndefined();
    // The old stop stays in the rogue's journal as it was; nothing new links to it.
    expect((await journal(rid)).map((e) => [e.operation_id === stopped.operation_id, e.status])).toEqual([
      [true, "done"],
    ]);
  });

  it("before a reload, Undo of the replacing import restores the old stop and its link", async () => {
    const { rid, eid } = await dodgeFight();
    await hitAndStop(eid);
    const stopped = last(rid);
    await flushNow();
    const p = await previewImport(
      { url: `${LIB}d/encounter/mixed-duel.json` },
      { signal: new AbortController().signal, fetch: libraryFetch() },
    );
    if (!p.ok) throw new Error(p.problem.code);
    ok(
      await commitPlan(p.plan, {
        characters: {},
        encounter: { kind: "replace", target: eid, confirmed: true },
      }),
    );
    expect(docs().encounters[eid]?.pending_op).toBeUndefined();
    await docs().undo(eid);
    expect(docs().encounters[eid]?.encounter.pending).not.toBeNull();
    expect(docs().encounters[eid]?.pending_op).toBe(stopped.operation_id);
    await reload();
    ok(await docs().encounterAction(eid, { type: "decide", use: true }));
    expect(last(rid).links.continues).toBe(stopped.operation_id);
  });
});
