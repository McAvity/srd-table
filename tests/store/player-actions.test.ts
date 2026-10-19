import { beforeEach, describe, expect, it } from "vitest";
import { t } from "../../src/i18n";
import { useDocuments } from "../../src/store/documents";
import { useRollAdditions, useRolls } from "../../src/store/rolls";
import { fighter } from "../fixtures/characters";
import {
  BI,
  bard,
  FONT,
  humanWizard,
  LUCK,
  RAY,
  storeCharacter,
  TAUNT,
  testContext,
  WORD,
} from "../fixtures/player-actions";
import { resetStores } from "../helpers/app";
import { engineWithDice } from "../helpers/transfer";

// F-005 player actions through the store: each change one engine evaluation and one commit (or a refusal that
// changes nothing), the record's content and guards kept, the last roll changed only in its window.

const { engine, dice } = engineWithDice();
const docs = () => useDocuments.getState();
const record = (id: string) => docs().characters[id];

beforeEach(async () => {
  await resetStores();
  useRolls.setState({ last: {} });
  useRollAdditions.setState({ by: {} });
  dice.length = 0;
});

async function pinnedBard() {
  const build = await bard(engine);
  const content = await testContext(engine);
  const fresh = await engine.createState(build, content);
  const spent = await engine.applyPlayAction(
    build,
    fresh,
    [
      { type: "use", key: BI, amount: 2 },
      { type: "spend_slot", level: 1 },
    ],
    content,
  );
  if (!spent.ok) throw new Error(spent.reasons.join("; "));
  return { id: await storeCharacter(engine, build, content, spent.state), build, content };
}

describe("payments (AC-01, AC-02)", () => {
  it("Font of Inspiration: one slot, one Bardic Inspiration use back, one commit; a full pool refuses with nothing changed", async () => {
    const { id } = await pinnedBard();
    const r = await docs().playAction(id, {
      type: "use_feature",
      key: FONT,
      payment: { type: "slot", level: 2 },
    });
    expect(r.ok).toBe(true);
    expect(record(id)?.state.uses_spent[BI]).toBe(1);
    expect(record(id)?.state.spell_slots_spent).toEqual([1, 1]);
    expect(record(id)?.rev).toBe(1);
    expect(record(id)?.content?.packs[1]?.id).toBe("test-actions");
    await docs().playAction(id, { type: "restore_use", key: BI });
    const before = record(id);
    const full = await docs().playAction(id, {
      type: "use_feature",
      key: FONT,
      payment: { type: "slot", level: 1 },
    });
    expect(full.ok).toBe(false);
    expect(record(id)).toBe(before);
  });

  it("a slot instead of a spent use; a refused use leaves the record as it was", async () => {
    const { id } = await pinnedBard();
    await docs().playAction(id, { type: "use_feature", key: WORD });
    const before = record(id);
    expect((await docs().playAction(id, { type: "use_feature", key: WORD })).ok).toBe(false);
    expect(record(id)).toBe(before);
    expect(
      (
        await docs().playAction(id, {
          type: "use_feature",
          key: WORD,
          payment: { type: "slot", level: 3 },
        })
      ).ok,
    ).toBe(true);
    expect(record(id)?.state.spell_slots_spent).toEqual([1, 0, 1]);
    expect(record(id)?.state.uses_spent[WORD]).toBe(1);
  });

  it("a free cast spends its use, never a slot; a ritual neither; spent, the free cast is refused before anything", async () => {
    const { id, build, content } = await pinnedBard();
    const sheet = (await engine.playSheet(build, record(id)?.state as never, content)).sheet;
    const freeSpell = sheet.spells.find((s) => s.free.length > 0);
    expect(freeSpell).toBeDefined();
    const use = freeSpell?.free[0]?.use as string;
    const cast = {
      type: "cast" as const,
      spell: freeSpell?.id as string,
      payment: { type: "free" as const, use },
    };
    const r = await docs().rollByHand(id, cast);
    expect(r.ok).toBe(true);
    expect(record(id)?.state.spell_slots_spent).toEqual([1]);
    expect(record(id)?.state.uses_spent[use]).toBe(1);
    const before = record(id);
    expect((await docs().rollByHand(id, cast)).ok).toBe(false);
    expect(record(id)).toBe(before);
  });
});

describe("rolls changed afterwards (AC-03)", () => {
  it("Heroic on a D20 Test: the d20 again, Heroic Inspiration spent once; nothing left to spend refuses", async () => {
    const { id } = await pinnedBard();
    await docs().playAction(id, { type: "set_inspiration", value: true });
    dice.push(4);
    const test = await docs().rollTest(id, { skill: "athletics" });
    if (!test.ok) throw new Error("no test");
    expect(test.test.roll.natural).toBe(4);
    const rev = record(id)?.rev;
    dice.push(17);
    const r = await docs().heroicReroll(id, { kind: "d20", die: 0 });
    expect(r.ok).toBe(true);
    const last = useRolls.getState().last[id];
    expect(last?.kind === "test" ? last.test.total : null).toBe(17 + test.test.bonus);
    expect(record(id)?.state.heroic_inspiration).toBe(false);
    expect(record(id)?.rev).toBe((rev ?? 0) + 1);
    expect((await docs().heroicReroll(id, { kind: "d20", die: 0 })).ok).toBe(false);
  });

  it("the window closes with any change of the character: the reroll is refused, nothing spent", async () => {
    const { id } = await pinnedBard();
    await docs().playAction(id, { type: "set_inspiration", value: true });
    dice.push(4);
    await docs().rollTest(id, { skill: "athletics" });
    await docs().playAction(id, { type: "damage", amount: 1 });
    const before = record(id);
    const r = await docs().heroicReroll(id, { kind: "d20", die: 0 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons).toEqual([t("errors.rerollWindowClosed")]);
    expect(record(id)).toBe(before);
  });

  it("Luck declared before the roll: Advantage and one use in one commit; late: a second d20, floors on both", async () => {
    const { id } = await pinnedBard();
    dice.push(5, 12);
    const declared = await docs().rollTest(
      id,
      { skill: "persuasion" },
      {},
      { use: LUCK, label: "Test Luck" },
    );
    if (!declared.ok) throw new Error("refused");
    expect(declared.test.roll).toMatchObject({ mode: "advantage", rolls: [5, 12] });
    expect(record(id)?.state.uses_spent[LUCK]).toBe(1);
    dice.push(3);
    const low = await docs().rollTest(id, { skill: "persuasion" });
    if (!low.ok) throw new Error("refused");
    expect(low.test.roll).toMatchObject({ natural: 3, d20: 10 });
    dice.push(15);
    expect((await docs().lateAdvantage(id, LUCK)).ok).toBe(true);
    const last = useRolls.getState().last[id];
    expect(last?.kind === "test" ? last.test.roll.rolls : null).toEqual([3, 15]);
    expect(record(id)?.state.uses_spent[LUCK]).toBe(2);
  });

  it("the GM's additions reach the test: a modifier and a bonus die listed, added by the engine", async () => {
    const { id } = await pinnedBard();
    dice.push(10, 3);
    const r = await docs().rollTest(
      id,
      { skill: "athletics" },
      {
        modifiers: [{ value: 2, label: "GM" }],
        bonus_dice: [{ dice: "1d4", label: "GM" }],
      },
    );
    if (!r.ok) throw new Error("refused");
    expect(r.test.total).toBe(10 + r.test.bonus + 2 + 3);
    expect(r.test.bonus_dice[0]?.rolls).toEqual([3]);
  });

  it("a feature's die rerolled by Heroic: its use stays spent once", async () => {
    const { id } = await pinnedBard();
    await docs().playAction(id, { type: "set_inspiration", value: true });
    dice.push(2);
    expect((await docs().rollByHand(id, { type: "feature", feature: TAUNT })).ok).toBe(true);
    expect(record(id)?.state.uses_spent["species:human:test-spur"]).toBe(1);
    dice.push(7);
    expect((await docs().heroicReroll(id, { kind: "feature_die", die: 0 })).ok).toBe(true);
    const last = useRolls.getState().last[id];
    expect(last?.kind === "sheet" ? last.roll.rolls.die?.total : null).toBe(7);
    expect(record(id)?.state.uses_spent["species:human:test-spur"]).toBe(1);
    expect(record(id)?.state.heroic_inspiration).toBe(false);
  });

  it("an attack: late Advantage and a Critical Hit set by the table, no second cost; setCritical commits nothing", async () => {
    const build = await fighter(engine, 3);
    const id = await storeCharacter(engine, build);
    const sheet = (await engine.playSheet(build, record(id)?.state as never)).sheet;
    const line = sheet.attacks.find((a) => a.damage_parts.some((p) => p.dice))?.name as string;
    dice.push(12);
    expect(
      (
        await docs().rollByHand(id, {
          type: "attack",
          attack: line,
          dm: { modifiers: [{ value: -2, label: "GM" }] },
        })
      ).ok,
    ).toBe(true);
    const rev = record(id)?.rev;
    const before = record(id)?.state;
    expect((await docs().setCritical(id, 0, true)).ok).toBe(true);
    expect(record(id)?.rev).toBe(rev);
    const crit = useRolls.getState().last[id];
    const attack = crit?.kind === "sheet" ? crit.roll.rolls.attacks[0] : undefined;
    expect(attack?.critical_hit).toBe(true);
    expect(attack?.modifiers).toEqual([{ label: "GM", value: -2 }]);
    expect(record(id)?.state).toBe(before);
  });

  it("Heroic on a death save makes it again from before it: the natural 20 replaces two failures; Undo returns to them", async () => {
    const build = await fighter(engine, 3);
    const id = await storeCharacter(engine, build);
    await docs().playAction(id, [
      { type: "set_inspiration", value: true },
      { type: "set_hp", current: 0 },
    ]);
    dice.push(1);
    expect((await docs().deathSave(id)).ok).toBe(true);
    expect(record(id)?.state.death_saves.failures).toBe(2);
    dice.push(20);
    expect((await docs().heroicReroll(id, { kind: "death_save" })).ok).toBe(true);
    expect(record(id)?.state.hp.current).toBe(1);
    expect(record(id)?.state.death_saves).toEqual({ successes: 0, failures: 0 });
    expect(record(id)?.state.heroic_inspiration).toBe(false);
    await docs().undo(id);
    expect(record(id)?.state.death_saves.failures).toBe(2);
    expect(record(id)?.state.heroic_inspiration).toBe(true);
  });

  it("a change asked for a record an import replaces meanwhile is refused (document_replaced), nothing applied", async () => {
    const { id } = await pinnedBard();
    await docs().playAction(id, { type: "set_inspiration", value: true });
    dice.push(4);
    await docs().rollTest(id, { skill: "athletics" });
    const pending = docs().heroicReroll(id, { kind: "d20", die: 0 });
    // An import replaces the record before the reroll's turn comes (a new generation).
    const current = record(id);
    if (!current) throw new Error("no record");
    useDocuments.setState((s) => ({
      characters: { ...s.characters, [id]: { ...current, gen: 1, rev: 99 } },
    }));
    const r = await pending;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons).toEqual([t("errors.documentReplaced")]);
    expect(record(id)?.state.heroic_inspiration).toBe(true);
  });
});

// Review 04: Lucky declared before a roll by hand (§5.4), each later result closing the last one's window (§5.5),
// Heroic Inspiration on an attack's bonus and damage dice, and a change prepared on an older record refused.
describe("rolls by hand and the last roll (review 04)", () => {
  async function luckyWizard() {
    const build = await humanWizard(engine);
    const content = await testContext(engine);
    return { id: await storeCharacter(engine, build, content), build, content };
  }
  const lucky = { use: LUCK, label: "Test Luck" };

  it("Lucky before a weapon attack by hand: Advantage rolled by the engine, the use paid in the attack's commit", async () => {
    const { id } = await pinnedBard();
    const before = record(id);
    dice.push(5, 14);
    const r = await docs().rollByHand(id, { type: "attack", attack: "Dagger" }, lucky);
    if (!r.ok) throw new Error(r.reasons.join("; "));
    expect(r.roll.rolls.attacks[0]?.roll).toMatchObject({ mode: "advantage", rolls: [5, 14] });
    expect(r.roll.rolls.attacks[0]?.reasons).toContain("Advantage: Test Luck");
    expect(record(id)?.state.uses_spent[LUCK]).toBe(1);
    expect(record(id)?.rev).toBe((before?.rev ?? 0) + 1);
    const last = useRolls.getState().last[id];
    expect(last?.kind === "sheet" ? last.rev : null).toBe(record(id)?.rev);
  });

  it("Lucky before a spell attack paid with a slot: one slot, one use, one commit", async () => {
    const { id } = await luckyWizard();
    dice.push(3, 18);
    const r = await docs().rollByHand(id, { type: "cast", spell: RAY, slot_level: 1 }, lucky);
    if (!r.ok) throw new Error(r.reasons.join("; "));
    expect(r.roll.rolls.attacks[0]?.roll).toMatchObject({ mode: "advantage", rolls: [3, 18] });
    expect(record(id)?.state.spell_slots_spent).toEqual([1]);
    expect(record(id)?.state.uses_spent[LUCK]).toBe(1);
    expect(record(id)?.rev).toBe(1);
  });

  it("Lucky with no use left: the roll by hand is refused, nothing spent, the last roll kept", async () => {
    const { id } = await luckyWizard();
    await docs().playAction(id, { type: "use", key: LUCK, amount: 3 });
    dice.push(9);
    await docs().rollTest(id, { skill: "athletics" });
    const kept = useRolls.getState().last[id];
    const before = record(id);
    const r = await docs().rollByHand(id, { type: "cast", spell: RAY, slot_level: 1 }, lucky);
    expect(r.ok).toBe(false);
    expect(record(id)).toBe(before);
    expect(useRolls.getState().last[id]).toBe(kept);
  });

  it("Lucky on a spell whose effects are by hand (no attack roll by the engine): refused, neither slot nor use spent", async () => {
    const { id } = await luckyWizard();
    const before = record(id);
    const r = await docs().rollByHand(
      id,
      { type: "cast", spell: "chromatic-orb", slot_level: 1 },
      lucky,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons).toEqual([t("errors.rollNotApplicable")]);
    expect(record(id)).toBe(before);
  });

  it("Lucky on a roll by hand without a d20 is refused before anything", async () => {
    const { id } = await pinnedBard();
    const before = record(id);
    const r = await docs().rollByHand(id, { type: "feature", feature: TAUNT }, lucky);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons).toEqual([t("errors.rollNotApplicable")]);
    expect(record(id)).toBe(before);
  });

  it("Heroic on an attack's bonus die, then on another attack's damage die: one die each, nothing paid again", async () => {
    const build = await fighter(engine, 3);
    const id = await storeCharacter(engine, build);
    const sheet = (await engine.playSheet(build, record(id)?.state as never)).sheet;
    const line = sheet.attacks.find((a) => a.damage_parts.some((p) => p.dice))?.name as string;
    await docs().playAction(id, { type: "set_inspiration", value: true });
    dice.push(11, 1);
    const first = await docs().rollByHand(id, {
      type: "attack",
      attack: line,
      dm: { bonus_dice: [{ dice: "1d4", label: "GM" }] },
    });
    if (!first.ok) throw new Error(first.reasons.join("; "));
    const attack = first.roll.rolls.attacks[0];
    expect(attack?.bonus_dice[0]?.rolls).toEqual([1]);
    dice.push(4);
    expect(
      (await docs().heroicReroll(id, { kind: "bonus_die", group: 0, die: 0, attack: 0 })).ok,
    ).toBe(true);
    let last = useRolls.getState().last[id];
    const rerolled = last?.kind === "sheet" ? last.roll.rolls.attacks[0] : undefined;
    expect(rerolled?.bonus_dice[0]?.rolls).toEqual([4]);
    expect(rerolled?.total).toBe((attack?.total ?? 0) + 3);
    expect(record(id)?.state.heroic_inspiration).toBe(false);

    await docs().playAction(id, { type: "set_inspiration", value: true });
    dice.push(15, 1);
    const second = await docs().rollByHand(id, { type: "attack", attack: line });
    if (!second.ok) throw new Error(second.reasons.join("; "));
    const damage = second.roll.rolls.attacks[0]?.damage;
    const part = damage?.parts.findIndex((p) => p.dice) ?? -1;
    expect(damage?.parts[part]?.rolls[0]).toBe(1);
    const state = record(id)?.state;
    dice.push(6);
    expect((await docs().heroicReroll(id, { kind: "damage", part, die: 0, attack: 0 })).ok).toBe(
      true,
    );
    last = useRolls.getState().last[id];
    const hit = last?.kind === "sheet" ? last.roll.rolls.attacks[0] : undefined;
    expect(hit?.damage?.parts[part]?.rolls[0]).toBe(6);
    expect(hit?.damage?.total).toBe((damage?.total ?? 0) + 5);
    expect({ ...record(id)?.state, heroic_inspiration: true }).toEqual(state);
  });

  it("free Damage and Critical rolls are the last roll: the attack's window closes; Heroic on the free damage's die", async () => {
    const build = await fighter(engine, 3);
    const id = await storeCharacter(engine, build);
    const sheet = (await engine.playSheet(build, record(id)?.state as never)).sheet;
    const line = sheet.attacks.find((a) => a.damage_parts.some((p) => p.dice));
    if (!line) throw new Error("no attack with dice");
    await docs().playAction(id, { type: "set_inspiration", value: true });
    dice.push(12);
    await docs().rollByHand(id, { type: "attack", attack: line.name });
    const rev = record(id)?.rev;
    dice.push(2);
    const free = await docs().rollDamage(id, line.damage_parts, false, line.name);
    expect(record(id)?.rev).toBe(rev);
    expect(useRolls.getState().last[id]?.kind).toBe("damage");
    const old = await docs().heroicReroll(id, { kind: "d20", die: 0, attack: 0 });
    expect(old.ok).toBe(false);
    expect(record(id)?.state.heroic_inspiration).toBe(true);
    const crit = await docs().rollDamage(id, line.damage_parts, true, line.name);
    const last = useRolls.getState().last[id];
    expect(last?.kind === "damage" ? last.damage : null).toBe(crit);
    expect(crit?.parts[0]?.rolls.length).toBe((free?.parts[0]?.rolls.length ?? 0) * 2);
    const part = crit?.parts.findIndex((p) => p.dice) ?? -1;
    dice.push(3);
    expect((await docs().heroicReroll(id, { kind: "damage", part, die: 0 })).ok).toBe(true);
    const after = useRolls.getState().last[id];
    expect(after?.kind === "damage" ? after.damage.parts[part]?.rolls[0] : null).toBe(3);
    expect(record(id)?.state.heroic_inspiration).toBe(false);
  });

  it("a change prepared on an older record (playAction's `at`) is refused with nothing applied", async () => {
    const build = await fighter(engine, 3);
    const id = await storeCharacter(engine, build);
    const at = { rev: record(id)?.rev ?? 0, gen: record(id)?.gen ?? 0 };
    await docs().playAction(id, { type: "damage", amount: 3 });
    const before = record(id);
    const r = await docs().playAction(
      id,
      { type: "short_rest", hit_dice: [{ die: 10, roll: 5 }] },
      at,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons).toEqual([t("errors.recordChangedSince")]);
    expect(record(id)).toBe(before);
    const now = { rev: before?.rev ?? 0, gen: before?.gen ?? 0 };
    expect(
      (await docs().playAction(id, { type: "short_rest", hit_dice: [{ die: 10, roll: 5 }] }, now))
        .ok,
    ).toBe(true);
  });
});
