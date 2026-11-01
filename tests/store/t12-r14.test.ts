import { beforeEach, describe, expect, it } from "vitest";
import type { ContentContext, PackFiles } from "../../src/lib/canonical";
import { partyOf, useDocuments } from "../../src/store/documents";
import { useHistory } from "../../src/store/history";
import { useRollAdditions, useRolls } from "../../src/store/rolls";
import {
  ARCANUM_USE,
  arcanumContext,
  bard,
  storeCharacter,
  warlock11,
} from "../fixtures/player-actions";
import { resetStores } from "../helpers/app";
import { engineWithDice } from "../helpers/transfer";

// kenli F-002 T12 attempt1 (review14 R14-01, R14-02): Peerless Skill's follow-up on the last roll
// and a free cast in an encounter, through the store: the engine decides, the store commits once
// (or not at all), nothing is computed here.

const { engine, dice } = engineWithDice();
const docs = () => useDocuments.getState();
const record = (id: string) => docs().characters[id];

/** An invented pack (`source: test`): a human's use with a d8 for a failed check or attack. */
const KNACK_PACK: PackFiles = {
  "manifest.json": {
    name: "test-knack",
    manifest: { id: "test-knack", version: "1.0.0", source: "test", requires: ["srd-5.2.1"] },
    patches: [
      {
        target: "species/human",
        op: "append",
        path: "grants.resources",
        value: { id: "test-knack", name: "Test Knack", max: { value: 1 }, recharge: "long" },
      },
      {
        target: "species/human",
        op: "append",
        path: "grants.actions",
        value: {
          id: "test-knack",
          name: "Test Knack",
          economy: "free",
          uses: "test-knack",
          roll: { dice: "1d8" },
          after_failed_roll: { kinds: ["check", "attack"], spend: "on_success" },
        },
      },
    ],
    tables: {},
  },
};
const KNACK = "species:human:test-knack";

async function knackContext(): Promise<ContentContext> {
  const [ref] = await engine.registerPacks([KNACK_PACK]);
  const srd = await engine.servedPack("srd-5.2.1");
  if (!ref) throw new Error("knack pack not registered");
  return { packs: [srd, ref], sources: null };
}

async function knackBard() {
  const build = await bard(engine, 1);
  const content = await knackContext();
  const id = await storeCharacter(engine, build, content);
  const sheet = (await engine.playSheet(build, record(id)?.state as never, content)).sheet;
  const line = sheet.actions.find((a) => a.after_failed_roll);
  if (!line?.uses) throw new Error("no after_failed_roll line");
  expect(line.uses).toBe(KNACK);
  expect(line.roll_die).toBe("1d8");
  return { id, action: line.key, use: line.uses };
}

beforeEach(async () => {
  await resetStores();
  useRolls.setState({ last: {} });
  useRollAdditions.setState({ by: {} });
  dice.length = 0;
});

describe("R14-01 a feature for a failed check or attack (Peerless Skill shape)", () => {
  it("a failed check with a DC that the die turns into a success: one use spent, one commit, journaled", async () => {
    const { id, action, use } = await knackBard();
    dice.push(5);
    const test = await docs().rollTest(id, { skill: "athletics" }, { dc: 12 });
    if (!test.ok) throw new Error("refused");
    expect(test.test.success).toBe(false);
    const before = record(id);
    dice.push(8);
    const r = await docs().afterFailedRoll(id, action, use, undefined, undefined, {
      command: "late_advantage",
      label: "Test Knack",
    });
    expect(r).toMatchObject({ ok: true, success: true, spent: true });
    expect(record(id)?.state.uses_spent[use]).toBe(1);
    expect(record(id)).not.toBe(before);
    const last = useRolls.getState().last[id];
    expect(last?.kind === "test" && last.test.total).toBe(test.test.total + 8);
    const entry = Object.values(useHistory.getState().entries)
      .flat()
      .find((e) => (e.request as { after_failed_roll?: string } | null)?.after_failed_roll);
    expect(entry).toMatchObject({ kind: "late_advantage", commit: true });
    expect(entry?.costs).toHaveLength(1);
    // Undo gives the use back.
    await docs().undo(id);
    expect(record(id)?.state.uses_spent[use] ?? 0).toBe(0);
  });

  it("still a failure after the die: nothing spent, the record unchanged", async () => {
    const { id, action, use } = await knackBard();
    dice.push(2);
    await docs().rollTest(id, { skill: "athletics" }, { dc: 20 });
    const before = record(id);
    dice.push(1);
    const r = await docs().afterFailedRoll(id, action, use);
    expect(r).toMatchObject({ ok: true, success: false, spent: false });
    expect(record(id)).toBe(before);
    expect(record(id)?.state.uses_spent[use] ?? 0).toBe(0);
  });

  it("refused on a success, on a save, without a DC, and with no use left; nothing changes", async () => {
    const { id, action, use } = await knackBard();
    dice.push(19);
    await docs().rollTest(id, { skill: "athletics" }, { dc: 10 });
    let before = record(id);
    expect((await docs().afterFailedRoll(id, action, use)).ok).toBe(false);
    expect(record(id)).toBe(before);

    dice.push(2);
    await docs().rollTest(id, { save: "str" }, { dc: 15 });
    before = record(id);
    expect((await docs().afterFailedRoll(id, action, use)).ok).toBe(false);
    expect(record(id)).toBe(before);

    // No DC on the roll: refused until the table declares one, then decided against it.
    dice.push(3);
    await docs().rollTest(id, { skill: "athletics" });
    before = record(id);
    expect((await docs().afterFailedRoll(id, action, use)).ok).toBe(false);
    expect(record(id)).toBe(before);
    dice.push(8);
    expect(await docs().afterFailedRoll(id, action, use, undefined, 10)).toMatchObject({
      ok: true,
      success: true,
      spent: true,
    });

    // The one use is spent: refused, nothing rolled or changed.
    dice.push(2);
    await docs().rollTest(id, { skill: "athletics" }, { dc: 12 });
    before = record(id);
    expect((await docs().afterFailedRoll(id, action, use)).ok).toBe(false);
    expect(record(id)).toBe(before);
  });
});

describe("R14-02 a free cast in an encounter (Mystic Arcanum)", () => {
  it("the option carries its free cast; the cast spends the use, no slot; a second one is refused", async () => {
    const build = await warlock11(engine);
    const content = await arcanumContext(engine);
    const id = await storeCharacter(engine, build, content);
    const eid = await docs().createEncounter("R14-02");
    const setup = await docs().encounterAction(eid, [
      { type: "add_character", character: id },
      { type: "add_monster", monster: "goblin-warrior" },
      { type: "set_initiative", id: "syn-warlock", value: 20 },
      { type: "set_initiative", id: "goblin-warrior", value: 1 },
      { type: "start" },
    ]);
    if (!setup.ok) throw new Error(setup.reasons.join("; "));
    const enc = docs().encounters[eid]?.encounter;
    if (!enc) throw new Error("no encounter");
    const actor = enc.combatants.find((c) => c.character === id)?.id ?? "";
    const options = await engine.combatantOptions(enc, partyOf(enc, docs().characters), actor);
    const arcanum = options.spells.find((o) => o.free_casts?.some((f) => f.use === ARCANUM_USE));
    expect(arcanum, "the arcanum spell's option").toBeTruthy();
    expect(arcanum?.slot_levels).toEqual([]);
    const cast = arcanum?.action;
    expect(cast).toMatchObject({ type: "cast", payment: { type: "free", use: ARCANUM_USE } });
    const r = await docs().encounterAction(eid, [cast as never]);
    if (!r.ok) throw new Error(r.reasons.join("; "));
    expect(record(id)?.state.uses_spent[ARCANUM_USE]).toBe(1);
    expect(record(id)?.state.spell_slots_spent ?? []).toEqual([]);
    expect(record(id)?.state.pact_slots_spent ?? 0).toBe(0);
    const before = { enc: docs().encounters[eid], char: record(id) };
    const again = await docs().encounterAction(eid, [cast as never]);
    expect(again.ok).toBe(false);
    expect(docs().encounters[eid]).toBe(before.enc);
    expect(record(id)).toBe(before.char);
  }, 60_000);
});
