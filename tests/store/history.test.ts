/**
 * kenli F-006 T02: the journal captured by the real store (documents, rolls, history) on the
 * in-process engine with dice the test sets: a roll that changes nothing, a paid cast changed part by
 * part (Heroic Inspiration, the test pack's real luck-style use, a Critical Hit) with costs once and
 * the current result per component, Undo/Redo as status, a death save made again, follow-up damage,
 * rests and the second Long Rest, multi-character encounters, a decision and a forced roll, refusals,
 * and no journal limits. Persistence is in tests/persistence/history.test.ts.
 */

import type { CharacterBuild, CharacterState, PlayAction } from "srd-rules-engine";
import { beforeEach, describe, expect, it } from "vitest";
import type { EngineFacade } from "../../src/engine/facade";
import { t } from "../../src/i18n";
import { journal, longRests } from "../../src/persistence/history";
import { useDocuments } from "../../src/store/documents";
import { type HistoryEntry, projection, sessionEntries, useHistory } from "../../src/store/history";
import { useRolls } from "../../src/store/rolls";
import { fighter, rogue, wizard } from "../fixtures/characters";
import { LUCK, storeCharacter, testContext } from "../fixtures/player-actions";
import { resetStores } from "../helpers/app";
import { engineWithDice } from "../helpers/transfer";

const { engine, dice } = engineWithDice();
const docs = () => useDocuments.getState();
const hist = () => useHistory.getState();
const record = (id: string) => docs().characters[id];
const entries = (id: string) => sessionEntries(id);
const byOp = (id: string, op: string | undefined) =>
  entries(id).find((e) => e.operation_id === op) as HistoryEntry;
const INSPIRATION = { type: "play", action: { type: "spend_inspiration" } };
function ok<T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> {
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r as Extract<T, { ok: true }>;
}

beforeEach(async () => {
  await resetStores();
  useRolls.setState({ last: {} });
  dice.length = 0;
});

async function edit(e: EngineFacade, build: CharacterBuild, edits: readonly unknown[]) {
  let b = build;
  for (const x of edits) {
    const r = await e.editBuild(b, x as never);
    if (!r.ok) throw new Error(r.reasons.join("; "));
    b = r.build;
  }
  return b;
}

/** A level 3 human Wizard (the test pack's luck use) with `spell` in its spellbook and prepared. */
async function humanCaster(spell: string): Promise<CharacterBuild> {
  let current = await edit(engine, await wizard(engine, 3), [{ type: "species", id: "human" }]);
  for (let guard = 0; guard < 40; guard++) {
    const view = await engine.evaluate(current);
    const open = view.choices.find(
      (c) => !c.fixed && !c.replaces && c.selected.length < c.required,
    );
    if (!open) break;
    const picks = [...open.selected];
    for (const o of open.options)
      if (picks.length < open.required && !o.unavailable && !picks.includes(o.id)) picks.push(o.id);
    current = await edit(engine, current, [{ type: "choice", key: open.key, values: picks }]);
  }
  for (let step = 0; step < 2; step++) {
    const view = await engine.evaluate(current);
    const open = view.choices.find(
      (c) => c.required > 0 && c.options.some((o) => o.id === spell) && !c.selected.includes(spell),
    );
    if (!open) break;
    current = await edit(engine, current, [
      { type: "choice", key: open.key, values: [spell, ...open.selected].slice(0, open.required) },
    ]);
  }
  return current;
}

async function caster(spell: string, actions: PlayAction[] = []) {
  const build = await humanCaster(spell);
  const content = await testContext(engine);
  let state = await engine.createState(build, content);
  if (actions.length) {
    const r = await engine.applyPlayAction(build, state, actions, content);
    if (!r.ok) throw new Error(r.reasons.join("; "));
    state = r.state;
  }
  return storeCharacter(engine, build, content, state);
}

async function storedFighter(actions: PlayAction[] = [], level = 3): Promise<string> {
  const build = await fighter(engine, level);
  let state: CharacterState = await engine.createState(build);
  if (actions.length) state = ok(await engine.applyPlayAction(build, state, actions)).state;
  return storeCharacter(engine, build, undefined, state);
}

describe("capture: a roll, its changes, its costs (AC-02, R01-01, R02-02)", () => {
  it("a check that changes nothing is recorded, the record and its undo stack untouched", async () => {
    const id = await storedFighter();
    const before = record(id);
    dice.push(6);
    ok(await docs().rollTest(id, { skill: "athletics" }));
    expect(record(id)).toBe(before);
    expect(docs().history[id]).toBeUndefined();
    const [e] = entries(id);
    expect(e).toMatchObject({ kind: "test", commit: false, costs: [], seq: 1, status: "done" });
    expect(e?.outcome[0]).toMatchObject({ raw: 6, effective: 6 });
    expect(e?.day_id).toBe(hist().meta[id]?.current_day_id);
    expect(e?.effect).toEqual({ mode: "none", replaces_op: null, state_delta: [] });
  });

  it("Scorching Ray: Heroic on a damage die, real Lucky on another ray, a Critical Hit; each part current, costs once, Undo/Redo per part", async () => {
    const id = await caster("scorching-ray", [{ type: "set_inspiration", value: true }]);
    // Per ray: d20, Bless d4, 2d6 fire.
    dice.push(12, 3, 2, 4, 5, 1, 6, 4, 3, 2, 6, 2);
    ok(
      await docs().rollByHand(id, {
        type: "cast",
        spell: "scorching-ray",
        dm: { bonus_dice: [{ dice: "1d4", label: "Bless" }] },
      }),
    );
    const root = entries(id)[0] as HistoryEntry;
    const raw = structuredClone(root.result) as {
      rolls: { attacks: { roll: { rolls: number[] }; damage: { total: number } }[] };
    };
    expect(raw.rolls.attacks.map((a) => a.roll.rolls)).toEqual([[12], [5], [3]]);
    dice.push(5);
    ok(await docs().heroicReroll(id, { kind: "damage", attack: 2, part: 0, die: 1 }));
    dice.push(18);
    ok(await docs().lateAdvantage(id, LUCK, 1));
    dice.push(5, 3);
    ok(await docs().setCritical(id, 0, true));

    const [r, h, l, k] = entries(id);
    expect([r?.kind, h?.kind, l?.kind, k?.kind]).toEqual([
      "sheet_roll",
      "reroll",
      "late_advantage",
      "set_critical",
    ]);
    expect([h?.component, l?.component, k?.component]).toEqual([
      "rolls.attacks[2]",
      "rolls.attacks[1]",
      "rolls.attacks[0]",
    ]);
    expect(r?.costs).toEqual([
      expect.objectContaining({ action: { type: "spend_slot", level: 2 } }),
    ]);
    expect(h?.costs).toEqual([INSPIRATION]);
    expect(l?.costs).toEqual([{ type: "play", action: { type: "use", key: LUCK } }]);
    expect(k?.costs).toEqual([]);
    expect([h?.parent_op, l?.parent_op, k?.parent_op]).toEqual([
      r?.operation_id,
      h?.operation_id,
      l?.operation_id,
    ]);
    expect(new Set(entries(id).map((e) => e.group_id))).toEqual(new Set([r?.operation_id]));
    // The raw root never changes; the current result is Table's own last roll, part by part.
    expect(r?.result).toEqual(raw);
    const full = projection(entries(id), r?.operation_id as string) as typeof raw & {
      rolls: {
        attacks: {
          critical_hit: boolean;
          total: number;
          damage: { parts: { rolls: number[] }[] };
        }[];
      };
    };
    expect(full).toEqual(
      useRolls.getState().last[id]?.kind === "sheet" &&
        (useRolls.getState().last[id] as { roll: unknown }).roll,
    );
    expect(full.rolls.attacks.map((a) => a.roll.rolls)).toEqual([[12], [5, 18], [3]]);
    expect(full.rolls.attacks[0]?.critical_hit).toBe(true);
    expect(full.rolls.attacks[0]?.damage.parts[0]?.rolls).toEqual([2, 4, 5, 3]);
    expect(full.rolls.attacks[2]?.damage.parts[0]?.rolls).toEqual([6, 5]);
    expect(record(id)?.state.uses_spent[LUCK]).toBe(1);
    expect(record(id)?.state.heroic_inspiration).toBe(false);
    expect(record(id)?.state.spell_slots_spent).toEqual([0, 1]);

    const at = () => projection(entries(id), r?.operation_id as string) as typeof full | null;
    await docs().undo(id); // Lucky
    expect(byOp(id, l?.operation_id).status).toBe("undone");
    expect(byOp(id, k?.operation_id).status).toBe("done"); // another ray: not cascaded
    expect(at()?.rolls.attacks.map((a) => a.roll.rolls)).toEqual([[12], [5], [3]]);
    expect(at()?.rolls.attacks[0]?.critical_hit).toBe(true);
    expect(at()?.rolls.attacks[2]?.damage.parts[0]?.rolls).toEqual([6, 5]);
    await docs().undo(id); // Heroic
    expect(at()?.rolls.attacks[2]?.damage.parts[0]?.rolls).toEqual([6, 2]);
    await docs().undo(id); // the cast
    expect(byOp(id, r?.operation_id).status).toBe("undone");
    expect(byOp(id, k?.operation_id)).toMatchObject({
      status: "undone",
      undone_with: r?.operation_id,
    });
    expect(at()).toBeNull();
    expect(record(id)?.state.spell_slots_spent).toEqual([]);
    await docs().redo(id);
    expect(byOp(id, k?.operation_id)).toMatchObject({ status: "done", undone_with: null });
    await docs().redo(id);
    await docs().redo(id);
    expect(at()).toEqual(full);
    expect(entries(id)).toHaveLength(4);
    expect(record(id)?.state.uses_spent[LUCK]).toBe(1); // restored by the snapshot, not paid again
  });

  it("a test's Bless die, then Lucky on the same result: whole-result changes chained, Undo/Redo", async () => {
    const id = await caster("ray-of-sickness", [{ type: "set_inspiration", value: true }]);
    dice.push(8, 1);
    ok(
      await docs().rollTest(id, { save: "dex" }, { bonus_dice: [{ dice: "1d4", label: "Bless" }] }),
    );
    dice.push(4);
    ok(await docs().heroicReroll(id, { kind: "bonus_die", group: 0, die: 0 }));
    dice.push(15);
    ok(await docs().lateAdvantage(id, LUCK));
    const [root, h, l] = entries(id);
    expect([h?.component, l?.component]).toEqual(["", ""]);
    const cur = () =>
      projection(entries(id), root?.operation_id as string) as {
        total: number;
        roll: { rolls: number[] };
        bonus_dice: { rolls: number[] }[];
      };
    expect(cur()).toEqual((useRolls.getState().last[id] as { test: unknown }).test);
    expect([cur().roll.rolls, cur().bonus_dice[0]?.rolls]).toEqual([[8, 15], [4]]);
    await docs().undo(id);
    expect([cur().roll.rolls, cur().bonus_dice[0]?.rolls]).toEqual([[8], [4]]);
    await docs().undo(id);
    expect([cur().roll.rolls, cur().bonus_dice[0]?.rolls]).toEqual([[8], [1]]);
    await docs().redo(id);
    await docs().redo(id);
    expect([cur().roll.rolls, cur().bonus_dice[0]?.rolls]).toEqual([[8, 15], [4]]);
  });

  it("real Lucky declared before the roll: one entry, its use as the operation's cost; undone and redone", async () => {
    const id = await caster("ray-of-sickness");
    dice.push(6, 14);
    ok(await docs().rollTest(id, { skill: "arcana" }, {}, { use: LUCK, label: "Test Luck" }));
    const [e] = entries(id);
    expect(e).toMatchObject({
      kind: "test",
      commit: true,
      costs: [{ type: "play", action: { type: "use", key: LUCK } }],
    });
    expect(e?.outcome[0]).toMatchObject({ raw: 14, effective: 14 });
    expect(e?.effect.state_delta).toEqual([{ path: `uses_spent.${LUCK}`, before: null, after: 1 }]);
    await docs().undo(id);
    expect(entries(id)[0]?.status).toBe("undone");
    expect(record(id)?.state.uses_spent[LUCK] ?? 0).toBe(0);
    await docs().redo(id);
    expect(entries(id)[0]?.status).toBe("done");
  });

  it("a death save made again with Heroic Inspiration replaces the first one's effect", async () => {
    const id = await storedFighter([
      { type: "set_inspiration", value: true },
      { type: "set_hp", current: 1 },
      { type: "damage", amount: 1 },
    ]);
    dice.push(4);
    ok(await docs().deathSave(id));
    dice.push(15);
    ok(await docs().heroicReroll(id, { kind: "death_save" }));
    const [o, h] = entries(id);
    expect(o?.effect.state_delta).toEqual([{ path: "death_saves.failures", before: 0, after: 1 }]);
    expect(h).toMatchObject({
      kind: "reroll",
      parent_op: o?.operation_id,
      costs: [INSPIRATION],
      effect: { mode: "replace", replaces_op: o?.operation_id },
    });
    expect(h?.effect.state_delta).toEqual([
      { path: "death_saves.successes", before: 0, after: 1 },
      { path: "heroic_inspiration", before: true, after: false },
    ]);
    await docs().undo(id);
    expect(record(id)?.state.death_saves).toEqual({ successes: 0, failures: 1 });
    await docs().redo(id);
    expect(record(id)?.state.death_saves).toEqual({ successes: 1, failures: 0 });
  });

  it("follow-up damage: its own entry, no cost, linked only to the open attack roll", async () => {
    const id = await storedFighter();
    const sheet = await engine.playSheet(
      record(id)?.build as CharacterBuild,
      record(id)?.state as CharacterState,
    );
    const line = sheet.sheet.attacks[0];
    if (!line) throw new Error("no attack");
    dice.push(20);
    ok(await docs().rollTest(id, { attack: line.name }));
    const attack = entries(id)[0];
    dice.push(3, 5, 2, 6);
    await docs().rollDamage(id, line.damage_parts, true, line.name, attack?.operation_id);
    const damage = entries(id)[1];
    expect(damage).toMatchObject({
      kind: "damage",
      costs: [],
      commit: false,
      links: { follows: attack?.operation_id, continues: null },
      group_id: damage?.operation_id,
    });
    expect(damage?.outcome[0]).toMatchObject({
      critical: true,
      damage_total: damage?.outcome[0]?.total,
    });
    // The open roll is now the damage: a stale link isn't kept.
    await docs().rollDamage(id, line.damage_parts, false, line.name, attack?.operation_id);
    expect(entries(id)[2]?.links.follows).toBeNull();
  });
});

describe("rests and days (AC-03, AC-05, R01-03)", () => {
  it("a Short Rest's dialog dice (one rerolled) in one entry; Inspiration its cost", async () => {
    const id = await storedFighter([
      { type: "set_inspiration", value: true },
      { type: "damage", amount: 10 },
    ]);
    const first = { dice_expression: "1d10", rolls: [3], modifier: 0, total: 3 };
    const again = { dice_expression: "1d10", rolls: [8], modifier: 0, total: 8 };
    ok(
      await docs().playAction(
        id,
        [{ type: "spend_inspiration" }, { type: "short_rest", hit_dice: [{ die: 10, roll: 8 }] }],
        undefined,
        { rest_dice: [{ die: 10, roll: again, rerolled_from: first }] },
      ),
    );
    const [e] = entries(id);
    expect(e).toMatchObject({ kind: "short_rest", rest_kind: "short", costs: [INSPIRATION] });
    expect(e?.outcome).toEqual([
      {
        label: "Hit Die d10",
        raw: 3,
        effective: 8,
        total: 8,
        success: null,
        critical: null,
        damage_total: null,
      },
    ]);
    expect(e?.effect.state_delta.map((d) => d.path)).toEqual(
      expect.arrayContaining(["heroic_inspiration", "hit_dice_spent.10", "hp.current"]),
    );
  });

  it("a second Long Rest the same day only as the DM's exception; per character; Undo counts it in its own day", async () => {
    const id = await storedFighter([{ type: "damage", amount: 5 }]);
    const other = await storedFighter();
    ok(await docs().playAction(id, { type: "long_rest" }));
    const day1 = hist().meta[id]?.current_day_id as string;
    const before = record(id);
    const refused = await docs().playAction(id, { type: "long_rest" });
    expect(refused).toEqual({ ok: false, reasons: [t("history.restOverrideRequired")] });
    expect(record(id)).toBe(before);
    expect(entries(id)).toHaveLength(1);
    ok(await docs().playAction(other, { type: "long_rest" })); // another character: its own day
    ok(
      await docs().playAction(id, { type: "long_rest" }, undefined, {
        rest_override: { note: " safe haven " },
      }),
    );
    expect(entries(id)[1]?.rest?.override).toEqual({ by: "dm", note: "safe haven" });
    expect(await longRests(id)).toEqual({ total: 2, by_day: { [day1]: 2 } });
    expect(hist().startNextDay(id, "Bandit camp")).toEqual({ ok: true });
    const day2 = hist().meta[id]?.current_day_id as string;
    expect(record(id)).toBe(docs().characters[id]); // a day doesn't change the record
    ok(await docs().playAction(id, { type: "long_rest" })); // a new day: no exception needed
    expect(await longRests(id)).toEqual({ total: 3, by_day: { [day1]: 2, [day2]: 1 } });
    await docs().undo(id);
    await docs().undo(id); // the exception on day 1
    expect(await longRests(id)).toEqual({ total: 1, by_day: { [day1]: 1 } });
    expect(hist().meta[id]?.current_day_id).toBe(day2);
    await docs().redo(id);
    expect(entries(id)[1]).toMatchObject({ status: "done", rest: { override: { by: "dm" } } });
    expect(hist().meta[id]?.days.map((d) => d.label)).toEqual([null, "Bandit camp"]);
    expect(hist().renameDay(id, day1, "two\nlines")).toEqual({
      ok: false,
      code: "history.dayLabelInvalid",
    });
    expect(hist().setCurrentDay(id, "d-nope")).toEqual({ ok: false, code: "history.dayUnknown" });
    expect(await longRests(other)).toMatchObject({ total: 1 });
  });

  it("a day change keeps the reroll window open (the record's rev doesn't move)", async () => {
    const id = await caster("ray-of-sickness");
    dice.push(6);
    ok(await docs().rollTest(id, { skill: "arcana" }));
    hist().startNextDay(id);
    dice.push(14);
    ok(await docs().lateAdvantage(id, LUCK));
    expect(entries(id)[1]).toMatchObject({
      kind: "late_advantage",
      day_id: hist().meta[id]?.current_day_id,
    });
  });
});

describe("encounters, refusals, Undo (AC-03, AC-06, F-T01-01)", () => {
  async function party() {
    const wiz = await caster("ray-of-sickness");
    const fig = await storedFighter();
    const eid = await docs().createEncounter("Ambush");
    ok(
      await docs().encounterAction(eid, [
        { type: "add_character", character: wiz, id: "wiz" },
        { type: "add_character", character: fig, id: "fig" },
        { type: "set_initiative", id: "wiz", value: 20 },
        { type: "set_initiative", id: "fig", value: 5 },
        { type: "start" },
      ]),
    );
    return { wiz, fig, eid };
  }

  it("one cast changing two characters: one operation, an entry in each journal and day; undone together", async () => {
    const { wiz, fig, eid } = await party();
    expect(entries(wiz)).toHaveLength(0); // setup changes no character
    hist().startNextDay(fig);
    dice.push(15, 4, 5, 10);
    ok(
      await docs().encounterAction(eid, {
        type: "cast",
        id: "wiz",
        spell: "ray-of-sickness",
        targets: ["fig"],
      }),
    );
    const [w] = entries(wiz);
    const [f] = entries(fig);
    expect(w?.operation_id).toBe(f?.operation_id);
    expect(w).toMatchObject({
      kind: "encounter",
      role: "actor",
      context: { encounter_id: eid, source: "encounter" },
    });
    expect(w?.costs).toEqual([{ type: "play", action: { type: "spend_slot", level: 1 } }]);
    expect(f).toMatchObject({
      role: "affected",
      costs: [],
      day_id: hist().meta[fig]?.current_day_id,
    });
    expect(w?.day_id).not.toBe(f?.day_id);
    expect(f?.effect.state_delta.map((d) => d.path)).toContain("hp.current");
    await docs().undo(eid);
    expect([entries(wiz)[0]?.status, entries(fig)[0]?.status]).toEqual(["undone", "undone"]);
    await docs().redo(eid);
    expect([entries(wiz)[0]?.status, entries(fig)[0]?.status]).toEqual(["done", "done"]);
  });

  it("F-T01-01: a sheet Undo over a later encounter effect warns; Undo itself unchanged; the encounter entry stays done", async () => {
    const { wiz, fig, eid } = await party();
    ok(await docs().playAction(fig, { type: "damage", amount: 1 }));
    expect(docs().undoWarning(fig)).toBeNull();
    dice.push(15, 4, 5, 10);
    ok(
      await docs().encounterAction(eid, {
        type: "cast",
        id: "wiz",
        spell: "ray-of-sickness",
        targets: ["fig"],
      }),
    );
    const hit = record(fig)?.state.hp.current;
    expect(docs().undoWarning(fig)).toBe(t("history.undoOverwritesEncounter"));
    await docs().undo(fig);
    expect(record(fig)?.state.hp.current).not.toBe(hit); // the encounter's damage went too
    expect(entries(fig).map((e) => [e.kind, e.status])).toEqual([
      ["play", "undone"],
      ["encounter", "done"],
    ]);
    void wiz;
  });

  it("refused or unpaid attempts record nothing; a forced roll records its costs as forced", async () => {
    const aerin = await storedFighter([], 1);
    const eid = await docs().createEncounter("Test");
    ok(
      await docs().encounterAction(eid, [
        { type: "add_character", character: aerin },
        { type: "add_monster", monster: "goblin-warrior" },
        { type: "set_initiative", id: "aerin", value: 20 },
        { type: "set_initiative", id: "goblin-warrior", value: 1 },
        { type: "start" },
      ]),
    );
    const wind = {
      type: "roll",
      id: "aerin",
      what: { type: "feature", feature: "Second Wind" },
    } as const;
    let refused = false;
    for (let i = 0; i < 6 && !refused; i++) refused = !(await docs().rollAndPay(eid, wind)).ok;
    expect(refused).toBe(true);
    const paidRolls = entries(aerin).length;
    expect(entries(aerin).every((e) => e.kind === "encounter" && !e.forced)).toBe(true);
    expect((await docs().playAction(aerin, { type: "use_feature", key: "nope" })).ok).toBe(false);
    expect(entries(aerin)).toHaveLength(paidRolls);
    ok(await docs().rollAndPay(eid, wind, true));
    const forced = entries(aerin).at(-1);
    expect(forced).toMatchObject({ kind: "encounter", role: "actor", forced: true });
    expect(forced?.costs.length).toBeGreaterThan(0);
  });

  it("a decision: the stopped action is in the deciding character's journal, decide continues it", async () => {
    const build = await rogue(engine, 5);
    const rid = await storeCharacter(engine, build);
    const eid = await docs().createEncounter("Dodge");
    ok(
      await docs().encounterAction(eid, [
        { type: "add_character", character: rid, id: "rogue", decisions: "ask" },
        { type: "add_monster", monster: "goblin-warrior" },
        { type: "set_initiative", id: "goblin-warrior", value: 20 },
        { type: "set_initiative", id: "rogue", value: 1 },
        { type: "start" },
      ]),
    );
    dice.push(19, 6);
    const stop = ok(
      await docs().encounterAction(eid, {
        type: "attack",
        id: "goblin-warrior",
        target: "rogue",
        attack: "Scimitar",
      }),
    );
    expect(stop.pending?.kind).toBe("uncanny_dodge");
    const [stopped] = entries(rid);
    expect(stopped).toMatchObject({ kind: "encounter", role: "affected", pending_decision: true });
    ok(await docs().encounterAction(eid, { type: "decide", use: true }));
    const answered = entries(rid)[1];
    expect(answered).toMatchObject({
      pending_decision: false,
      links: { continues: stopped?.operation_id },
    });
    expect(answered?.effect.state_delta.map((d) => d.path)).toContain("hp.current");
  });

  it("a new action after Undo drops Redo but keeps the undone entry; the journal outlasts Undo's 50 and the log's 500", async () => {
    const id = await storedFighter();
    ok(await docs().playAction(id, { type: "damage", amount: 1 }));
    await docs().undo(id);
    ok(await docs().playAction(id, { type: "damage", amount: 2 }));
    await docs().redo(id); // nothing to redo
    expect(entries(id).map((e) => e.status)).toEqual(["undone", "done"]);
    for (let i = 0; i < 510; i++) ok(await docs().rollTest(id, { skill: "athletics" }));
    for (let i = 0; i < 60; i++) ok(await docs().playAction(id, { type: "heal", amount: 1 }));
    expect(docs().history[id]?.past.length).toBe(50);
    expect(entries(id)).toHaveLength(572);
    expect(entries(id).map((e) => e.seq)).toEqual(Array.from({ length: 572 }, (_, i) => i + 1));
    expect((await journal(id)).length).toBe(572);
  });
});
