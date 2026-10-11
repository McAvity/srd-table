import { beforeEach, describe, expect, it } from "vitest";
import { setEngine } from "../../src/engine/client";
import { nodeFacade } from "../../src/engine/node";
import { useDocuments } from "../../src/store/documents";
import { useUi } from "../../src/store/ui";
import { fighter } from "../fixtures/characters";
import { installTestEngine, resetStores } from "../helpers/app";

const engine = installTestEngine(11);
const docs = () => useDocuments.getState();

beforeEach(resetStores);

async function storedFighter(level = 1) {
  const build = await fighter(engine, level);
  const result = await docs().importCharacter(build);
  if (!result.ok) throw new Error(result.reasons.join("; "));
  return result.id;
}

describe("documents store", () => {
  it("commits the build the engine returns, and reconciles the state", async () => {
    const id = await docs().createCharacter();
    const result = await docs().editBuild(id, { type: "class", id: "wizard" });
    expect(result.ok).toBe(true);
    expect(docs().characters[id]?.build.class_id).toBe("wizard");
    expect(docs().revs[id]).toBeGreaterThan(1);
  });

  it("leaves the document untouched on a refusal and returns the reasons", async () => {
    const id = await storedFighter();
    const before = docs().characters[id];
    const result = await docs().editBuild(id, {
      type: "choice",
      key: "class:fighter#skills",
      values: ["athletics", "athletics"],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons.length).toBeGreaterThan(0);
    expect(docs().characters[id]).toBe(before);
  });

  it("applies play actions and shows their notes", async () => {
    const id = await storedFighter();
    const hit = await docs().playAction(id, { type: "damage", amount: 5, damage_type: "slashing" });
    expect(hit.ok).toBe(true);
    expect(docs().characters[id]?.state.hp.current).not.toBeNull();
    await docs().playAction(id, { type: "use_feature", key: "fighter:second-wind" });
    expect(useUi.getState().toasts.at(-1)?.lines.join(" ")).toMatch(/Second Wind/);
  });

  it("undoes and redoes a character change", async () => {
    const id = await storedFighter();
    await docs().playAction(id, { type: "damage", amount: 4 });
    const hurt = docs().characters[id]?.state;
    docs().undo(id);
    expect(docs().characters[id]?.state.hp.current).toBeNull();
    docs().redo(id);
    expect(docs().characters[id]?.state).toEqual(hurt);
  });

  it("rolls by hand, then pays the costs in the same step; refused when unpaid unless forced", async () => {
    const aerin = await storedFighter(1);
    const eid = await docs().createEncounter("Test");
    await docs().encounterAction(eid, [
      { type: "add_character", character: aerin },
      { type: "add_monster", monster: "goblin-warrior" },
      { type: "set_initiative", id: "aerin", value: 20 },
      { type: "set_initiative", id: "goblin-warrior", value: 1 },
      { type: "start" },
    ]);
    const wind = {
      type: "roll",
      id: "aerin",
      what: { type: "feature", feature: "Second Wind" },
    } as const;
    const used = (state = docs().characters[aerin]?.state) =>
      Object.entries(state?.uses_spent ?? {}).find(([k]) => k.endsWith("second-wind"))?.[1] ?? 0;

    const before = docs().characters[aerin]?.state;
    const rolled = await docs().rollAndPay(eid, wind);
    expect(rolled.ok).toBe(true);
    expect(used()).toBe(used(before) + 1);
    // One undo step takes back the roll and its payment together.
    docs().undo(eid);
    expect(docs().characters[aerin]?.state).toEqual(before);

    // Out of uses: nothing rolled, the engine's reason returned; forced, rolled anyway.
    let refusal: unknown = null;
    for (let i = 0; i < 5 && !refusal; i++) {
      const r = await docs().rollAndPay(eid, wind);
      if (!r.ok) refusal = r;
    }
    expect(refusal).toMatchObject({ ok: false, unpaid: true, reasons: [expect.any(String)] });
    const log = docs().encounters[eid]?.log.length;
    const forced = await docs().rollAndPay(eid, wind, true);
    expect(forced.ok).toBe(true);
    expect(docs().encounters[eid]?.log.length).toBeGreaterThan(log ?? 0);
  });

  it("sends an encounter its party, writes changed states back, and undoes them together", async () => {
    const aerin = await storedFighter(3);
    const eid = await docs().createEncounter("Test");
    const setup = await docs().encounterAction(eid, [
      { type: "add_character", character: aerin },
      { type: "add_monster", monster: "goblin-warrior" },
      { type: "set_initiative", id: "goblin-warrior", value: 20 },
      { type: "set_initiative", id: "aerin", value: 1 },
      { type: "start" },
    ]);
    expect(setup.ok).toBe(true);
    const encounter = docs().encounters[eid]?.encounter;
    expect(encounter?.combatants.map((c) => c.id)).toEqual(["aerin", "goblin-warrior"]);

    // The goblin attacks until it hits, so Aerin's state changes through the encounter.
    let hit = false;
    for (let i = 0; i < 10 && !hit; i++) {
      const before = docs().characters[aerin]?.state.hp.current;
      await docs().encounterAction(eid, [
        { type: "attack", id: "goblin-warrior", target: "aerin", attack: "Scimitar" },
      ]);
      hit = docs().characters[aerin]?.state.hp.current !== before;
      if (!hit) {
        await docs().encounterAction(eid, [{ type: "next_turn" }, { type: "next_turn" }]);
      }
    }
    expect(hit).toBe(true);
    const log = docs().encounters[eid]?.log ?? [];
    expect(log.some((e) => e.lines.some((l) => /Goblin Warrior/.test(l)))).toBe(true);
    // Each note is also kept as the engine's message (code and parameters), for translation.
    for (const entry of log.filter((e) => e.tone === "notes")) {
      expect(entry.messages?.map((m) => m.text)).toEqual(entry.lines);
      for (const m of entry.messages ?? []) expect(typeof m.code).toBe("string");
    }
    expect(useUi.getState().dice.length).toBeGreaterThan(0);

    const hurt = docs().characters[aerin]?.state.hp.current;
    docs().undo(eid);
    expect(docs().characters[aerin]?.state.hp.current).not.toBe(hurt);
  });

  it("logs a decision's question with its message code", async () => {
    // Find dice where the blue dragon fails its save against the red dragon's breath.
    let logged = false;
    for (let seed = 1; seed < 200 && !logged; seed++) {
      await resetStores();
      setEngine(nodeFacade({ seed }));
      const eid = await docs().createEncounter("Test");
      const r = await docs().encounterAction(eid, [
        { type: "set_decisions", mode: "ask" },
        { type: "add_monster", monster: "adult-red-dragon" },
        { type: "add_monster", monster: "adult-blue-dragon" },
        { type: "set_initiative", id: "adult-red-dragon", value: 20 },
        { type: "set_initiative", id: "adult-blue-dragon", value: 5 },
        { type: "start" },
        {
          type: "save_action",
          id: "adult-red-dragon",
          ability: "Fire Breath",
          targets: ["adult-blue-dragon"],
        },
      ]);
      if (!r.ok || !docs().encounters[eid]?.encounter.pending) continue;
      const entry = docs().encounters[eid]?.log.at(-1);
      expect(entry?.tone).toBe("decision");
      expect(entry?.messages?.map((m) => m.text)).toEqual(entry?.lines);
      expect(entry?.messages?.[0]?.code).toMatch(/^decision\./);
      logged = true;
    }
    expect(logged).toBe(true);
    setEngine(engine);
  });

  it("refuses an encounter action with the engine's reason", async () => {
    const eid = await docs().createEncounter("Empty");
    const result = await docs().encounterAction(eid, { type: "next_turn" });
    expect(result.ok).toBe(false);
  });

  it("imports refuse documents that don't parse", async () => {
    const result = await docs().importCharacter({ version: 999 });
    expect(result.ok).toBe(false);
    expect(Object.keys(docs().characters)).toHaveLength(0);
  });
});
