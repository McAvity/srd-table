/**
 * Custom items (kenli F-011 T02, contracts/changes.md §6) through the app's existing paths: the
 * engine's `add_custom_item` play action, the document queue and Undo, IndexedDB and a reload, the
 * play sheet view and an F-008 character transfer. No new inventory form here (T06), no full copy
 * (T04): the state's version 3 and its custom line are kept everywhere, never dropped.
 */

import type { CharacterState } from "srd-rules-engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { commitPlan, previewImport } from "../../src/import";
import { exportCharacter } from "../../src/import/export";
import { closeDb } from "../../src/persistence/db";
import { flushNow, installationId, loadAll, startAutosave } from "../../src/persistence/sync";
import { useDocuments } from "../../src/store/documents";
import { fighter } from "../fixtures/characters";
import { resetStores } from "../helpers/app";
import { engineWithDice } from "../helpers/transfer";

const docs = () => useDocuments.getState();
let stop: (() => void) | null = null;
let engine = engineWithDice().engine;

beforeEach(async () => {
  await resetStores();
  engine = engineWithDice().engine;
  await loadAll();
  stop = startAutosave();
});
afterEach(() => {
  stop?.();
  stop = null;
});

async function reload() {
  await flushNow();
  stop?.();
  await closeDb();
  useDocuments.setState({ hydrated: false, characters: {}, encounters: {}, revs: {}, history: {} });
  engine = engineWithDice().engine;
  await loadAll();
  stop = startAutosave();
}
const json = (x: unknown) => JSON.stringify(x);
async function aFighter() {
  const build = await fighter(engine, 3);
  const state = await engine.createState(build);
  const r = await docs().importCharacter(
    JSON.parse(json(build)),
    JSON.parse(json(state)) as CharacterState,
  );
  if (!r.ok) throw new Error(r.reasons.join("; "));
  const record = docs().characters[r.id];
  if (!record) throw new Error("no record");
  return { id: r.id, before: record.state };
}
const customOf = (s: CharacterState | undefined) =>
  s?.inventory.filter((i) => i.item === null) ?? [];

describe("custom items in the app", () => {
  it("added through the store: version 3, one commit; Undo gives the same bytes back; kept through a reload", async () => {
    const { id, before } = await aFighter();
    const rev = docs().characters[id]?.rev ?? 0;
    const r = await docs().playAction(id, {
      type: "add_custom_item",
      name: "Strange idol",
      description: "Warm to the touch.",
      weight_lb: null,
    });
    expect(r.ok).toBe(true);
    expect(docs().characters[id]?.rev).toBe(rev + 1);
    const added = docs().characters[id]?.state;
    expect(added?.version).toBe(3);
    expect(customOf(added).map((i) => i.custom)).toEqual([
      { name: "Strange idol", description: "Warm to the touch.", weight_lb: null },
    ]);
    await docs().undo(id);
    expect(json(docs().characters[id]?.state)).toBe(json(before));
    await docs().redo(id);
    expect(json(docs().characters[id]?.state)).toBe(json(added));
    await reload();
    expect(json(docs().characters[id]?.state)).toBe(json(added));
  });

  it("the play sheet: a custom line (item null), known weight counted, unknown counted apart", async () => {
    const { id } = await aFighter();
    const base = docs().characters[id];
    if (!base) throw new Error("no record");
    const w0 = (await engine.playSheet(base.build as never, base.state as never)).sheet.play
      .carried_weight;
    await docs().playAction(id, [
      { type: "add_custom_item", name: "Herb pouch", description: "", weight_lb: 2.5, qty: 2 },
      { type: "add_custom_item", name: "Strange idol", description: "", weight_lb: null },
    ]);
    const record = docs().characters[id];
    if (!record) throw new Error("no record");
    const play = (await engine.playSheet(record.build as never, record.state as never)).sheet.play;
    expect(play.carried_weight).toBeCloseTo(w0 + 5);
    expect(play.carried_weight_unknown).toBe(1);
    expect(
      play.inventory.filter((i) => i.item === null).map((i) => [i.name, i.category, i.weight]),
    ).toEqual([
      ["Herb pouch", "custom", 2.5],
      ["Strange idol", "custom", null],
    ]);
  });

  it("refused actions change nothing: equipping or selling a custom item", async () => {
    const { id } = await aFighter();
    await docs().playAction(id, {
      type: "add_custom_item",
      name: "Idol",
      description: "",
      weight_lb: 1,
    });
    const line = customOf(docs().characters[id]?.state)[0];
    const before = docs().characters[id];
    for (const action of [
      { type: "equip", id: line?.id as string, equipped: true },
      { type: "sell", id: line?.id as string },
    ] as const) {
      const r = await docs().playAction(id, action);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reasons.join(" ")).toMatch(/Idol is a custom item: it can't be/);
      expect(docs().characters[id]).toBe(before);
    }
  });

  it("a character transfer keeps the custom line and version 3", async () => {
    const { id } = await aFighter();
    await docs().playAction(id, {
      type: "add_custom_item",
      name: "Letter",
      description: "Sealed.",
      weight_lb: 0,
    });
    const record = docs().characters[id];
    if (!record) throw new Error("no record");
    const env = await exportCharacter(record, installationId());
    const exported = (env.content as { state: CharacterState }).state;
    expect(exported.version).toBe(3);
    await resetStores();
    engine = engineWithDice().engine;
    await loadAll();
    const p = await previewImport(
      { files: [{ name: "c.json", bytes: new TextEncoder().encode(json(env)) }] },
      { signal: new AbortController().signal },
    );
    if (!p.ok) throw new Error(`${p.problem.code}: ${p.problem.detail}`);
    const r = await commitPlan(p.plan, { characters: {} });
    if (!r.ok) throw new Error(JSON.stringify(r.problems));
    const imported = Object.values(docs().characters)[0]?.state;
    expect(json(imported)).toBe(json(exported));
  });
});
