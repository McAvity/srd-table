/**
 * Stored items (kenli F-005 DEC-01, variant A) through the app: the store action, Undo, the
 * document queue, IndexedDB, F-008 transfers (a character and an encounter with its party) and a
 * reload. `location: "stored"` and the state's version 2 are kept everywhere, never dropped; a
 * state without one keeps version 1 and its bytes.
 */

import type { CharacterState } from "srd-rules-engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { commitPlan, previewImport, type Source } from "../../src/import";
import { exportCharacter, exportEncounter } from "../../src/import/export";
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

/** Reload: a new engine (a new worker), the store emptied, everything read back from IndexedDB. */
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
const file = (name: string, x: unknown) => ({
  name,
  bytes: new TextEncoder().encode(JSON.stringify(x)),
});
async function importFiles(files: Source) {
  const p = await previewImport(files, { signal: new AbortController().signal });
  if (!p.ok) throw new Error(`${p.problem.code}: ${p.problem.detail}`);
  const r = await commitPlan(p.plan, { characters: {} });
  if (!r.ok) throw new Error(JSON.stringify(r.problems));
}
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
  const sword = record.state.inventory.find((i) => !i.equipped && i.item !== "chain-mail")?.id;
  return { id: r.id, sword: sword as string, before: record.state };
}
const stored = (s: CharacterState | undefined, item: string) =>
  s?.inventory.find((i) => i.id === item)?.location;

describe("stored items in the app", () => {
  it("put away: one commit, version 2; Undo gives the same bytes back (version 1); kept through a reload", async () => {
    const { id, sword, before } = await aFighter();
    const rev = docs().characters[id]?.rev ?? 0;
    expect((await docs().playAction(id, { type: "store", id: sword, stored: true })).ok).toBe(true);
    expect(docs().characters[id]?.rev).toBe(rev + 1);
    expect(docs().characters[id]?.state.version).toBe(2);
    expect(stored(docs().characters[id]?.state, sword)).toBe("stored");
    await docs().undo(id);
    expect(json(docs().characters[id]?.state)).toBe(json(before));
    await docs().redo(id);
    expect(stored(docs().characters[id]?.state, sword)).toBe("stored");
    await reload();
    const back = docs().characters[id]?.state;
    expect(back?.version).toBe(2);
    expect(stored(back, sword)).toBe("stored");
    // Taken back after the reload: version 1 and the bytes from before it was put away.
    expect((await docs().playAction(id, { type: "store", id: sword, stored: false })).ok).toBe(
      true,
    );
    await reload();
    expect(json(docs().characters[id]?.state)).toBe(json(before));
  });

  it("refusals change nothing: putting away a worn item, equipping a stored one", async () => {
    const { id, sword } = await aFighter();
    const armor = docs().characters[id]?.state.inventory.find((i) => i.equipped)?.id as string;
    const before = docs().characters[id];
    const worn = await docs().playAction(id, { type: "store", id: armor, stored: true });
    expect(worn.ok).toBe(false);
    if (!worn.ok) expect(worn.reasons.join(" ")).toMatch(/Take off .* before putting it away/);
    expect(docs().characters[id]).toBe(before);
    await docs().playAction(id, { type: "store", id: sword, stored: true });
    const after = docs().characters[id];
    const equip = await docs().playAction(id, { type: "equip", id: sword, equipped: true });
    expect(equip.ok).toBe(false);
    if (!equip.ok) expect(equip.reasons.join(" ")).toMatch(/is stored: take it back first/);
    expect(docs().characters[id]).toBe(after);
  });

  it("a character transfer keeps location and version 2: exported, imported elsewhere, the same state", async () => {
    const { id, sword } = await aFighter();
    await docs().playAction(id, { type: "store", id: sword, stored: true });
    const record = docs().characters[id];
    if (!record) throw new Error("no record");
    const env = await exportCharacter(record, installationId());
    expect((env.content as { state: CharacterState }).state.version).toBe(2);
    await resetStores();
    engine = engineWithDice().engine;
    await loadAll();
    stop = startAutosave();
    await importFiles({ files: [file("fighter.transfer.json", env)] });
    const imported = Object.values(docs().characters)[0];
    expect(json(imported?.state)).toBe(json(record.state));
    await reload();
    expect(json(Object.values(docs().characters)[0]?.state)).toBe(json(record.state));
  });

  it("an encounter with the character: its actions keep the stored item; exported with its party and imported, still stored", async () => {
    const { id, sword } = await aFighter();
    await docs().playAction(id, { type: "store", id: sword, stored: true });
    const eid = await docs().createEncounter("Camp");
    expect(
      (await docs().encounterAction(eid, { type: "add_character", character: id, id: "f" })).ok,
    ).toBe(true);
    expect(
      (
        await docs().encounterAction(eid, {
          type: "effects",
          id: "f",
          actions: [{ type: "damage", amount: 2 }],
        })
      ).ok,
    ).toBe(true);
    const state = docs().characters[id]?.state;
    expect(state?.version).toBe(2);
    expect(stored(state, sword)).toBe("stored");
    const record = docs().encounters[eid];
    if (!record) throw new Error("no encounter");
    const { encounter, party } = await exportEncounter(record, docs().characters, installationId());
    expect(party.map((p) => (p.content as { state: CharacterState }).state.version)).toEqual([2]);
    await resetStores();
    engine = engineWithDice().engine;
    await loadAll();
    stop = startAutosave();
    await importFiles({
      files: [file("camp.transfer.json", encounter), ...party.map((p, n) => file(`p${n}.json`, p))],
    });
    const member = Object.values(docs().characters)[0];
    expect(json(member?.state)).toBe(json(state));
    const enc = Object.values(docs().encounters)[0];
    expect(enc?.encounter.combatants.some((c) => c.character === member?.id)).toBe(true);
  });

  it("a plain file import (build + state) keeps a stored item", async () => {
    const { id, sword } = await aFighter();
    await docs().playAction(id, { type: "store", id: sword, stored: true });
    const record = docs().characters[id];
    const again = await docs().importCharacter(
      JSON.parse(json(record?.build)),
      JSON.parse(json(record?.state)),
    );
    expect(again.ok).toBe(true);
    if (again.ok) expect(stored(docs().characters[again.id]?.state, sword)).toBe("stored");
  });
});
