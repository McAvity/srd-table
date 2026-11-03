import { beforeEach, describe, expect, it } from "vitest";
import { partyOf, useDocuments } from "../../src/store/documents";
import { useHistory } from "../../src/store/history";
import { useRollAdditions, useRolls } from "../../src/store/rolls";
import {
  empowerContext,
  empoweredSorcerer,
  SORCERY,
  storeCharacter,
} from "../fixtures/player-actions";
import { resetStores } from "../helpers/app";
import { engineWithDice } from "../helpers/transfer";

// kenli F-002 T12 B2b: Empowered Spell after the damage roll through the store — on the sheet's
// last roll by hand (the window, one commit, the journal, Undo) and an encounter's pending choice
// of dice (nothing applied until answered, the same dice on replay). The engine decides.

const { engine, dice } = engineWithDice();
const docs = () => useDocuments.getState();
const record = (id: string) => docs().characters[id];
const sp = (id: string) => record(id)?.state.uses_spent[SORCERY] ?? 0;

beforeEach(async () => {
  await resetStores();
  useRolls.setState({ last: {} });
  useRollAdditions.setState({ by: {} });
  dice.length = 0;
});

async function sorcerer() {
  const content = await empowerContext(engine);
  const build = await empoweredSorcerer(engine);
  const id = await storeCharacter(engine, build, content);
  const sheet = (await engine.playSheet(build, record(id)?.state as never, content)).sheet;
  const empowered = sheet.cast_options.find((o) => o.effect === "empowered");
  if (!empowered) throw new Error("no Empowered Spell");
  return { id, empowered, sheet };
}

describe("B2b Empowered Spell on the sheet's last roll by hand", () => {
  it("the chosen dice rerolled and kept, 1 Sorcery Point committed once, journaled, undone", async () => {
    const { id, empowered } = await sorcerer();
    expect(empowered.reroll_dice).toBe(3);
    dice.push(1, 2, 6);
    const roll = await docs().rollByHand(id, {
      type: "cast",
      spell: "burning-hands",
      slot_level: 1,
    });
    if (!roll.ok) throw new Error(roll.reasons.join("; "));
    expect(roll.roll.rolls.damage?.parts[0]?.rolls).toEqual([1, 2, 6]);
    const slots = record(id)?.state.spell_slots_spent;
    expect(sp(id)).toBe(0);
    // Too many / repeated dice: refused, nothing spent, the window still open.
    const twice = await docs().empoweredSpell(id, 0, [
      { part: 0, die: 0 },
      { part: 0, die: 0 },
    ]);
    expect(twice.ok).toBe(false);
    expect(sp(id)).toBe(0);
    dice.push(5, 1);
    const r = await docs().empoweredSpell(
      id,
      0,
      [
        { part: 0, die: 0 },
        { part: 0, die: 2 },
      ],
      { command: "late_advantage", label: "Empowered Spell" },
    );
    if (!r.ok) throw new Error(r.reasons.join("; "));
    // The 6 rerolled to 1 is kept: 5 + 2 + 1.
    expect(sp(id)).toBe(1);
    expect(record(id)?.state.spell_slots_spent).toEqual(slots);
    const last = useRolls.getState().last[id];
    const damage = last?.kind === "sheet" ? last.roll.rolls.damage : null;
    expect(damage?.parts[0]?.rolls).toEqual([5, 2, 1]);
    expect(damage?.total).toBe(8);
    expect(damage?.rerolled?.source).toBe(empowered.key);
    const entry = Object.values(useHistory.getState().entries)
      .flat()
      .find((e) => (e.request as { empowered?: boolean } | null)?.empowered === true && e.commit);
    expect(entry).toMatchObject({ kind: "reroll", commit: true, component: "rolls.damage" });
    expect(entry?.costs).toHaveLength(1);
    // Once per cast: refused, nothing more spent.
    const again = await docs().empoweredSpell(id, 0, [{ part: 0, die: 1 }]);
    expect(again.ok).toBe(false);
    expect(sp(id)).toBe(1);
    await docs().undo(id);
    expect(sp(id)).toBe(0);
    expect(record(id)?.state.spell_slots_spent).toEqual(slots);
  }, 60_000);

  it("a spell attack's damage (Fire Bolt hit); a closed window refuses it", async () => {
    const { id } = await sorcerer();
    dice.push(15, 3);
    const roll = await docs().rollByHand(id, { type: "cast", spell: "fire-bolt" });
    if (!roll.ok) throw new Error(roll.reasons.join("; "));
    expect(roll.roll.rolls.attacks[0]?.damage?.parts[0]?.rolls).toEqual([3]);
    dice.push(9);
    const r = await docs().empoweredSpell(id, 0, [{ part: 0, die: 0 }]);
    if (!r.ok) throw new Error(r.reasons.join("; "));
    const last = useRolls.getState().last[id];
    expect(last?.kind === "sheet" && last.roll.rolls.attacks[0]?.damage?.total).toBe(9);
    expect(sp(id)).toBe(1);
    // Any other change of the character closes the window.
    await docs().playAction(id, { type: "long_rest" } as never);
    const closed = await docs().empoweredSpell(id, 0, [{ part: 0, die: 0 }]);
    expect(closed.ok).toBe(false);
    expect(sp(id)).toBe(0);
  }, 60_000);
});

describe("B2b Empowered Spell in an encounter: the pending choice of dice", () => {
  it("cast with it: paused with nothing applied; Keep spends nothing; Reroll pays once and applies the new dice to both targets", async () => {
    const { id, empowered } = await sorcerer();
    const eid = await docs().createEncounter("B2b");
    const setup = await docs().encounterAction(eid, [
      { type: "add_character", character: id },
      { type: "add_monster", monster: "goblin-warrior" },
      { type: "add_monster", monster: "goblin-warrior" },
      { type: "set_initiative", id: "syn-sorcerer", value: 20 },
      { type: "set_initiative", id: "goblin-warrior", value: 1 },
      { type: "set_initiative", id: "goblin-warrior-2", value: 1 },
      { type: "start" },
    ]);
    if (!setup.ok) throw new Error(setup.reasons.join("; "));
    const cast = {
      type: "cast",
      id: "syn-sorcerer",
      spell: "burning-hands",
      targets: ["goblin-warrior", "goblin-warrior-2"],
      options: [empowered.key],
    } as const;
    const charBefore = record(id);
    // Their Dexterity saves 2, 3; Burning Hands' one 3d6: 1, 1, 6.
    dice.push(2, 3, 1, 1, 6);
    const r = await docs().encounterAction(eid, [cast as never]);
    if (!r.ok) throw new Error(r.reasons.join("; "));
    const pending = docs().encounters[eid]?.encounter.pending;
    expect(pending?.kind).toBe("empowered_spell");
    expect(pending?.dice?.map((d) => d.value)).toEqual([1, 1, 6]);
    expect(pending?.max_dice).toBe(3);
    expect(record(id)).toBe(charBefore);
    // Another action waits (the update/advance guard is the same pending).
    const blocked = await docs().encounterAction(eid, [{ type: "next_turn" } as never]);
    expect(blocked.ok).toBe(false);
    dice.push(5, 4);
    const done = await docs().encounterAction(eid, [
      { type: "decide", use: true, dice: [0, 1] } as never,
    ]);
    if (!done.ok) throw new Error(done.reasons.join("; "));
    const enc = docs().encounters[eid]?.encounter;
    expect(enc?.pending ?? null).toBeNull();
    expect(sp(id)).toBe(1);
    expect(record(id)?.state.spell_slots_spent[0]).toBe(1);
    // 5 + 4 + 6 = 15 fire on a failed save: both Goblin Warriors (10 HP) down from the same roll.
    expect(enc?.combatants.filter((c) => c.monster === "goblin-warrior").map((c) => c.hp)).toEqual([
      0, 0,
    ]);
    expect(partyOf).toBeTypeOf("function");
  }, 60_000);

  it("Keep (use: false): no Sorcery Point, the rolled damage", async () => {
    const { id, empowered } = await sorcerer();
    const eid = await docs().createEncounter("B2b keep");
    await docs().encounterAction(eid, [
      { type: "add_character", character: id },
      { type: "add_monster", monster: "ogre" },
      { type: "set_initiative", id: "syn-sorcerer", value: 20 },
      { type: "set_initiative", id: "ogre", value: 1 },
      { type: "start" },
    ]);
    dice.push(18, 4);
    const r = await docs().encounterAction(eid, [
      {
        type: "cast",
        id: "syn-sorcerer",
        spell: "fire-bolt",
        targets: ["ogre"],
        options: [empowered.key],
      } as never,
    ]);
    if (!r.ok) throw new Error(r.reasons.join("; "));
    expect(docs().encounters[eid]?.encounter.pending?.kind).toBe("empowered_spell");
    const kept = await docs().encounterAction(eid, [{ type: "decide", use: false } as never]);
    if (!kept.ok) throw new Error(kept.reasons.join("; "));
    expect(sp(id)).toBe(0);
    expect(docs().encounters[eid]?.encounter.combatants.find((c) => c.id === "ogre")?.hp).toBe(
      68 - 4,
    );
  }, 60_000);
});
