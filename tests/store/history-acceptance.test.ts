/**
 * kenli F-006 T04: the task's flow on the real store, autosave and IndexedDB (fake), in one run —
 * a check → a paid cast → its Critical Hit and a Heroic damage reroll → a Short Rest → a Long Rest
 * → Undo all → Redo all → save → reload: results kept, each cost once (the slot spent once, after
 * all of it), no new entry, counters and statuses as before. Also putting an item away and taking
 * it back, and an encounter whose log keeps working beside the journal.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb } from "../../src/persistence/db";
import { journal, longRests } from "../../src/persistence/history";
import { flushNow, loadAll, startAutosave } from "../../src/persistence/sync";
import { useDocuments } from "../../src/store/documents";
import { type HistoryEntry, projection, sessionEntries, useHistory } from "../../src/store/history";
import { useRolls } from "../../src/store/rolls";
import { fighter } from "../fixtures/characters";
import { humanWizard, RAY, storeCharacter, testContext } from "../fixtures/player-actions";
import { resetStores } from "../helpers/app";
import { engineWithDice } from "../helpers/transfer";

let fx = engineWithDice();
let stop: (() => void) | null = null;
const docs = () => useDocuments.getState();

beforeEach(async () => {
  await resetStores();
  useRolls.setState({ last: {} });
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

describe("T04: the whole flow, then reload (AC-02, AC-03, AC-04, AC-05)", () => {
  it("check → paid cast → Critical Hit → Heroic → Short Rest → Long Rest → Undo all → Redo all → reload: kept, costs once, no new entry", async () => {
    const content = await testContext(fx.engine);
    const build = await humanWizard(fx.engine);
    let state = await fx.engine.createState(build, content);
    state = ok(
      await fx.engine.applyPlayAction(
        build,
        state,
        [
          { type: "set_inspiration", value: true },
          { type: "damage", amount: 6 },
        ],
        content,
      ),
    ).state;
    const id = await storeCharacter(fx.engine, build, content, state);
    fx.dice.push(11);
    ok(await docs().rollTest(id, { skill: "arcana" }));
    fx.dice.push(9, 2, 3);
    ok(await docs().rollByHand(id, { type: "cast", spell: RAY }));
    fx.dice.push(4, 6);
    ok(await docs().setCritical(id, 0, true));
    fx.dice.push(8);
    ok(await docs().heroicReroll(id, { kind: "damage", attack: 0, part: 0, die: 0 }));
    const castGroup = sessionEntries(id)[1]?.group_id as string;
    const current = projection(sessionEntries(id), castGroup);
    const hitDie = { dice_expression: "1d6", rolls: [4], modifier: 0, total: 4 };
    ok(
      await docs().playAction(
        id,
        { type: "short_rest", hit_dice: [{ die: 6, roll: 4 }] },
        undefined,
        {
          rest_dice: [{ die: 6, roll: hitDie, rerolled_from: null }],
        },
      ),
    );
    ok(await docs().playAction(id, { type: "long_rest" }));
    const before = sessionEntries(id).map((e) => [e.kind, e.status, e.costs.length]);
    expect(before).toEqual([
      ["test", "done", 0],
      ["sheet_roll", "done", 1],
      ["set_critical", "done", 0],
      ["reroll", "done", 1],
      ["short_rest", "done", 0],
      ["long_rest", "done", 0],
    ]);
    const cast = sessionEntries(id)[1] as HistoryEntry;
    expect(cast.costs).toEqual([
      expect.objectContaining({ action: { type: "spend_slot", level: 1 } }),
    ]);
    const stateAfter = docs().characters[id]?.state;

    const steps = docs().history[id]?.past.length ?? 0;
    for (let i = 0; i < steps; i++) await docs().undo(id);
    expect(
      sessionEntries(id)
        .filter((e) => e.commit)
        .every((e) => e.status === "undone"),
    ).toBe(true);
    expect(projection(sessionEntries(id), castGroup)).toBeNull();
    for (let i = 0; i < steps; i++) await docs().redo(id);
    expect(sessionEntries(id).map((e) => [e.kind, e.status, e.costs.length])).toEqual(before);
    expect(projection(sessionEntries(id), castGroup)).toEqual(current);
    expect(docs().characters[id]?.state).toEqual(stateAfter); // nothing rolled or paid again

    await reload();
    const saved = await journal(id);
    expect(saved.map((e) => [e.kind, e.status, e.costs.length])).toEqual(before);
    expect(projection(saved, castGroup)).toEqual(current);
    expect(saved.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect((await longRests(id)).total).toBe(1);
    expect(docs().characters[id]?.state).toEqual(stateAfter);
  });

  it("an item put away and taken back: two entries with the location change, undone and redone", async () => {
    const build = await fighter(fx.engine, 3);
    const id = await storeCharacter(fx.engine, build);
    const item = docs().characters[id]?.state.inventory.find((i) => !i.equipped);
    if (!item) throw new Error("no item");
    ok(await docs().playAction(id, { type: "store", id: item.id, stored: true }));
    ok(await docs().playAction(id, { type: "store", id: item.id, stored: false }));
    const [put, back] = sessionEntries(id);
    expect(put?.effect.state_delta).toEqual([
      { path: `inventory[id=${item.id}].location`, before: null, after: "stored" },
    ]);
    expect(back?.effect.state_delta).toEqual([
      { path: `inventory[id=${item.id}].location`, before: "stored", after: null },
    ]);
    await docs().undo(id);
    expect(docs().characters[id]?.state.inventory.find((i) => i.id === item.id)?.location).toBe(
      "stored",
    );
    expect(sessionEntries(id).map((e) => e.status)).toEqual(["done", "undone"]);
    await docs().redo(id);
    expect(sessionEntries(id).map((e) => e.status)).toEqual(["done", "done"]);
  });

  it("an encounter's log keeps working beside the journal; both survive a reload", async () => {
    const id = await storeCharacter(fx.engine, await fighter(fx.engine, 3));
    const eid = await docs().createEncounter("Road");
    ok(
      await docs().encounterAction(eid, [
        { type: "add_character", character: id, id: "aerin" },
        { type: "add_monster", monster: "goblin-warrior" },
        { type: "set_initiative", id: "goblin-warrior", value: 20 },
        { type: "set_initiative", id: "aerin", value: 1 },
        { type: "start" },
      ]),
    );
    const logBefore = docs().encounters[eid]?.log.length ?? 0;
    fx.dice.push(18, 4);
    ok(
      await docs().encounterAction(eid, {
        type: "attack",
        id: "goblin-warrior",
        target: "aerin",
        attack: "Scimitar",
      }),
    );
    expect(docs().encounters[eid]?.log.length).toBeGreaterThan(logBefore);
    expect(sessionEntries(id).map((e) => [e.kind, e.role])).toEqual([["encounter", "affected"]]);
    await reload();
    expect(docs().encounters[eid]?.log.length).toBeGreaterThan(logBefore);
    expect((await journal(id)).map((e) => e.context.encounter_id)).toEqual([eid]);
  });
});
