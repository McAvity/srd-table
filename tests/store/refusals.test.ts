/**
 * kenli F-011 T03 (contracts/changes.md §5): a player's explicit command the rules refuse is one
 * `kenli.history/2` entry (`refused`), with nothing paid, rolled or changed — on the real store,
 * engine (in process, dice queued so a consumed die shows), autosave and IndexedDB (fake).
 * Anything that isn't such a command (no `attempt`, a malformed request, the app's own refusals:
 * stale, gone, closed window, not applicable…) records nothing.
 */

import type { CharacterState, RollWhat } from "srd-rules-engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkEntry } from "../../src/import/localCopy/format";
import { closeDb, db } from "../../src/persistence/db";
import { longRests } from "../../src/persistence/history";
import { flushNow, loadAll, startAutosave, unsavedState } from "../../src/persistence/sync";
import { useDocuments } from "../../src/store/documents";
import {
  type Attempt,
  type HistoryEntry,
  type HistoryMeta,
  projection,
  sessionEntries,
  useHistory,
} from "../../src/store/history";
import { useRolls } from "../../src/store/rolls";
import { fighter, sorcererBard, wizard } from "../fixtures/characters";
import {
  BI,
  bard,
  humanWizard,
  LUCK,
  storeCharacter,
  testContext,
} from "../fixtures/player-actions";
import { resetStores } from "../helpers/app";
import { engineWithDice } from "../helpers/transfer";

let fx = engineWithDice();
let stop: (() => void) | null = null;
const docs = () => useDocuments.getState();
const hist = () => useHistory.getState();

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

async function reload() {
  await flushNow();
  stop?.();
  await closeDb();
  useDocuments.setState({ hydrated: false, characters: {}, encounters: {}, revs: {}, history: {} });
  hist().hydrate([]);
  fx = engineWithDice();
  await loadAll();
  stop = startAutosave();
}
function ok<T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> {
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r as Extract<T, { ok: true }>;
}
const SENTINEL = [17, 17, 17, 17];
/** Dice the next real roll would take; a refusal must leave them all queued. */
const queue = () => {
  fx.dice.splice(0, fx.dice.length, ...SENTINEL);
};
const diceLeft = () => fx.dice.length;
const refusals = (id: string) => sessionEntries(id).filter((e) => e.kind === "refused");
const record = (id: string) => docs().characters[id];
/** What IndexedDB holds for a character's journal (this session's unsaved entries left out). */
const savedRows = async (id: string): Promise<HistoryEntry[]> =>
  (await db()).getAllFromIndex(
    "history",
    "by_record_seq",
    IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]),
  );

/** A Wizard 3 with every slot spent (4 × level 1, 2 × level 2) and a level 1 spell of its own. */
async function emptyWizard() {
  const r = ok(await docs().importCharacter(await wizard(fx.engine, 3)));
  ok(
    await docs().playAction(r.id, [
      ...Array(4).fill({ type: "spend_slot", level: 1 }),
      ...Array(2).fill({ type: "spend_slot", level: 2 }),
    ]),
  );
  const rec = record(r.id);
  if (!rec) throw new Error("no record");
  const spells = (await fx.engine.playSheet(rec.build, rec.state)).sheet.spells;
  const orb = spells.find((s) => s.id === "chromatic-orb") ?? spells.find((s) => s.level === 1);
  if (!orb) throw new Error("no level 1 spell");
  return { id: r.id, spell: orb };
}
/** A Bard 5 (test pack) with every Bardic Inspiration spent. */
async function emptyBard() {
  const content = await testContext(fx.engine);
  const id = await storeCharacter(fx.engine, await bard(fx.engine, 5), content);
  for (let i = 0; i < 10; i++) {
    const r = await docs().playAction(id, { type: "use", key: BI });
    if (!r.ok) break;
  }
  return id;
}

describe("sheet commands at zero resources: exactly one refused entry, nothing else", () => {
  it("Cast with an empty slot: refused before any die; one /2 entry; state, rev, dice unchanged", async () => {
    const { id, spell } = await emptyWizard();
    const before = record(id);
    const entries = sessionEntries(id).length;
    queue();
    const attempt: Attempt = { command: "sheet_cast", label: spell.name };
    const r = await docs().rollByHand(
      id,
      { type: "cast", spell: spell.id, slot_level: 1 } as RollWhat,
      undefined,
      attempt,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.cause).toBe("rules");
      expect(r.reasons.join(" ")).toMatch(/No level 1 spell slots left/);
    }
    expect(diceLeft()).toBe(SENTINEL.length);
    expect(record(id)).toBe(before);
    expect(sessionEntries(id)).toHaveLength(entries + 1);
    const [e] = refusals(id);
    expect(e).toMatchObject({
      schema: "kenli.history/2",
      kind: "refused",
      refusal: attempt,
      commit: false,
      status: "done",
      costs: [],
      outcome: [],
      result: null,
      pending_decision: false,
      effect: { mode: "none", replaces_op: null, state_delta: [] },
      links: { follows: null, continues: null },
      context: { source: "sheet", encounter_id: null, round: null },
    });
    expect(e?.group_id).toBe(e?.operation_id);
    expect(e?.messages[0]?.text).toMatch(/No level 1 spell slots left/);
    // The local copy's validator reads it (F-011 §5.6: a mixed journal stays exportable).
    expect(() => checkEntry(e, "e")).not.toThrow();
  });

  it("Bardic Inspiration at 0: one entry, uses unchanged; two attempts, two entries", async () => {
    const id = await emptyBard();
    const spent = record(id)?.state.uses_spent[BI];
    const before = record(id);
    const attempt: Attempt = { command: "sheet_use", label: "Bardic Inspiration" };
    for (const n of [1, 2]) {
      const r = await docs().playAction(
        id,
        { type: "use", key: BI },
        undefined,
        undefined,
        attempt,
      );
      expect(r.ok).toBe(false);
      expect(refusals(id)).toHaveLength(n);
    }
    expect(record(id)).toBe(before);
    expect(record(id)?.state.uses_spent[BI]).toBe(spent);
    expect(refusals(id)[0]?.messages[0]?.text).toMatch(/Bardic Inspiration/);
  });

  it("a declared Lucky with none left (a test, a roll by hand): refused before the d20, one entry each", async () => {
    const content = await testContext(fx.engine);
    const id = await storeCharacter(fx.engine, await humanWizard(fx.engine), content);
    for (let i = 0; i < 10; i++)
      if (!(await docs().playAction(id, { type: "use", key: LUCK })).ok) break;
    const before = record(id);
    queue();
    const lucky = { use: LUCK, label: "Lucky" };
    const t = await docs().rollTest(id, { skill: "arcana" }, undefined, lucky, {
      command: "sheet_test",
      label: "arcana",
    });
    expect(t.ok).toBe(false);
    const h = await docs().rollByHand(id, { type: "attack", attack: "Dagger" } as RollWhat, lucky, {
      command: "sheet_attack",
      label: "Dagger",
    });
    expect(h.ok).toBe(false);
    expect(diceLeft()).toBe(SENTINEL.length);
    expect(record(id)).toBe(before);
    expect(refusals(id).map((e) => e.refusal?.command)).toEqual(["sheet_test", "sheet_attack"]);
  });

  it("records nothing without an attempt, for a malformed request, or for the app's own refusals", async () => {
    const { id, spell } = await emptyWizard();
    const n = sessionEntries(id).length;
    const attempt: Attempt = { command: "sheet_cast", label: spell.name };
    // Bookkeeping (a slot correction) with no attempt: refused, not journaled.
    expect((await docs().playAction(id, { type: "spend_slot", level: 1 })).ok).toBe(false);
    // Malformed (a schema refusal is classified `invalid` by the facade)…
    const zod = await fx.engine.parseState({ hp: "full" });
    expect(zod).toMatchObject({ ok: false, cause: "invalid" });
    // …and an `invalid` refusal of a command records nothing.
    const apply = fx.engine.applyPlayAction;
    fx.engine.applyPlayAction = async () => ({
      ok: false,
      reasons: ["malformed"],
      cause: "invalid",
    });
    try {
      const bad = await docs().playAction(id, { type: "use", key: "x" }, undefined, undefined, {
        command: "sheet_use",
        label: "x",
      });
      expect(bad.ok).toBe(false);
    } finally {
      fx.engine.applyPlayAction = apply;
    }
    // Stale: a dialog's preview of an older version (changedSince).
    const stale = await docs().playAction(
      id,
      { type: "use", key: "x" },
      { rev: -1, gen: 0 },
      undefined,
      attempt,
    );
    expect(stale.ok).toBe(false);
    // Gone: no such record.
    expect(
      (
        await docs().playAction(
          "c-gone",
          { type: "damage", amount: 1 },
          undefined,
          undefined,
          attempt,
        )
      ).ok,
    ).toBe(false);
    // A follow-up with no roll to follow (window closed) and a Lucky where it can't apply.
    expect(
      (await docs().lateAdvantage(id, LUCK, 0, { command: "late_advantage", label: "Lucky" })).ok,
    ).toBe(false);
    expect(
      (
        await docs().rollByHand(
          id,
          { type: "unarmed", option: "shove" } as RollWhat,
          { use: LUCK, label: "Lucky" },
          attempt,
        )
      ).ok,
    ).toBe(false);
    // A builder edit refused (validation) is never a game event.
    expect(
      (
        await docs().editBuild(id, {
          type: "choice",
          key: "class:wizard#skills",
          values: ["arcana", "arcana"],
        })
      ).ok,
    ).toBe(false);
    expect(sessionEntries(id)).toHaveLength(n);
  });
});

describe("the other sheet commands: a feature's use, a toggle", () => {
  it("Second Wind with no use left (use_feature) and Innate Sorcery with none left (activate): one entry each", async () => {
    const f = ok(await docs().importCharacter(await fighter(fx.engine, 3)));
    for (let i = 0; i < 5; i++)
      if (!(await docs().playAction(f.id, { type: "use_feature", key: "fighter:second-wind" })).ok)
        break;
    const fBefore = record(f.id);
    queue();
    const r1 = await docs().playAction(
      f.id,
      { type: "use_feature", key: "fighter:second-wind" },
      undefined,
      undefined,
      { command: "sheet_use_feature", label: "Second Wind" },
    );
    expect(r1.ok).toBe(false);
    expect(record(f.id)).toBe(fBefore);
    expect(refusals(f.id).map((e) => e.refusal?.command)).toEqual(["sheet_use_feature"]);

    const sb = ok(await docs().importCharacter(await sorcererBard(fx.engine)));
    const key = "sorcerer:innate-sorcery";
    let attempts = 0;
    for (let i = 0; i < 6; i++) {
      const on = await docs().playAction(sb.id, { type: "activate", key }, undefined, undefined, {
        command: "sheet_activate",
        label: "Innate Sorcery",
      });
      attempts++;
      if (!on.ok) break;
      ok(await docs().playAction(sb.id, { type: "deactivate", key }));
    }
    expect(refusals(sb.id).map((e) => e.refusal?.command)).toEqual(["sheet_activate"]);
    expect(attempts).toBeGreaterThan(1);
    expect(diceLeft()).toBe(SENTINEL.length);
  });
});

describe("follow-ups, Undo and the current result", () => {
  it("late Advantage with no Lucky left follows the roll; Heroic without Inspiration too; the roll's result is unchanged", async () => {
    const content = await testContext(fx.engine);
    const id = await storeCharacter(fx.engine, await humanWizard(fx.engine), content);
    for (let i = 0; i < 10; i++)
      if (!(await docs().playAction(id, { type: "use", key: LUCK })).ok) break;
    fx.dice.push(6);
    ok(await docs().rollTest(id, { skill: "arcana" }));
    const root = sessionEntries(id).at(-1) as HistoryEntry;
    queue();
    const late = await docs().lateAdvantage(id, LUCK, 0, {
      command: "late_advantage",
      label: "Lucky",
    });
    expect(late.ok).toBe(false);
    const heroic = await docs().heroicReroll(
      id,
      { kind: "d20", die: 0 },
      {
        command: "heroic_reroll",
        label: "Reroll d20",
      },
    );
    expect(heroic.ok).toBe(false);
    expect(diceLeft()).toBe(SENTINEL.length);
    const [a, b] = refusals(id);
    expect(a).toMatchObject({
      refusal: { command: "late_advantage" },
      links: { follows: root.operation_id },
    });
    expect(b).toMatchObject({
      refusal: { command: "heroic_reroll" },
      links: { follows: root.operation_id },
    });
    expect(a?.group_id).not.toBe(root.group_id);
    expect(projection(sessionEntries(id), root.group_id)).toEqual(root.result);
    for (const e of [a, b]) expect(() => checkEntry(e, "e")).not.toThrow();
  });

  it("Undo of an earlier success takes back the success only: the later refusal stays, done", async () => {
    const id = await emptyBard();
    ok(await docs().playAction(id, { type: "damage", amount: 3 }));
    const hurt = record(id)?.state;
    await docs().playAction(id, { type: "use", key: BI }, undefined, undefined, {
      command: "sheet_use",
      label: "Bardic Inspiration",
    });
    expect(record(id)?.state).toBe(hurt); // a refusal is no undo step
    await docs().undo(id);
    expect(record(id)?.state.hp.current).toBeNull();
    const all = sessionEntries(id);
    const damage = all.find((e) => JSON.stringify(e.request).includes('"damage"')) as HistoryEntry;
    expect(damage.status).toBe("undone");
    expect(refusals(id)).toHaveLength(1);
    expect(refusals(id)[0]?.status).toBe("done");
    await docs().redo(id);
    expect(refusals(id)[0]?.status).toBe("done");
  });
});

describe("encounter commands", () => {
  async function encounterWithEmptyWizard() {
    const { id, spell } = await emptyWizard();
    const eid = await docs().createEncounter("T03");
    ok(
      await docs().encounterAction(eid, [
        { type: "add_character", character: id },
        { type: "add_monster", monster: "goblin-warrior" },
        { type: "set_initiative", id: "lirael", value: 20 },
        { type: "set_initiative", id: "goblin-warrior", value: 1 },
        { type: "start" },
      ]),
    );
    return { id, eid, spell };
  }

  it("a roll by hand of a spell with no slot: refused before the dice, one entry in the actor's journal", async () => {
    const { id, eid, spell } = await encounterWithEmptyWizard();
    const before = { enc: docs().encounters[eid], char: record(id) };
    queue();
    const r = await docs().rollAndPay(
      eid,
      {
        type: "roll",
        id: "lirael",
        what: { type: "cast", spell: spell.id, slot_level: 1 },
      } as never,
      false,
      { command: "encounter_roll", label: spell.name },
    );
    expect(r).toMatchObject({ ok: false, unpaid: true, cause: "rules" });
    expect(diceLeft()).toBe(SENTINEL.length);
    expect(docs().encounters[eid]).toBe(before.enc);
    expect(record(id)).toBe(before.char);
    const [e] = refusals(id);
    expect(e).toMatchObject({
      refusal: { command: "encounter_roll", label: spell.name },
      context: { source: "encounter", encounter_id: eid, round: 1 },
      costs: [],
      result: null,
    });
    expect(() => checkEntry(e, "e")).not.toThrow();
  });

  it("an automatic cast with no slot: the engine's refusal, one entry; forced by the GM: no refusal entry", async () => {
    const { id, eid, spell } = await encounterWithEmptyWizard();
    queue();
    const cast = {
      type: "cast",
      id: "lirael",
      spell: spell.id,
      slot_level: 1,
      targets: ["goblin-warrior"],
    } as never;
    const r = await docs().encounterAction(eid, cast, {
      command: "encounter_action",
      label: spell.name,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.cause).toBe("rules");
    expect(diceLeft()).toBe(SENTINEL.length);
    expect(refusals(id).map((e) => e.refusal?.command)).toEqual(["encounter_action"]);
    // Without an attempt (a preview, the composer's check, the GM's own bookkeeping): nothing.
    await docs().encounterAction(eid, cast);
    await fx.engine.checkAction(docs().encounters[eid]?.encounter as never, {} as never, cast);
    expect(refusals(id)).toHaveLength(1);
  });
});

describe("persistence: mixed journal, days, Long Rests, conflicts", () => {
  it("a reload reads /1 and /2 entries back in one sequence; days and Long Rests unchanged", async () => {
    const id = await emptyBard();
    ok(await docs().playAction(id, { type: "damage", amount: 2 }));
    await docs().playAction(id, { type: "use", key: BI }, undefined, undefined, {
      command: "sheet_use",
      label: "Bardic Inspiration",
    });
    ok(await docs().playAction(id, { type: "damage", amount: 1 }));
    const days = hist().meta[id]?.days;
    const rests = await longRests(id);
    const ids = sessionEntries(id).map((e) => [e.id, e.schema, e.seq]);
    await reload();
    const rows = await savedRows(id);
    expect(
      rows.map((e) => [e.id, e.schema, e.seq]).sort((a, b) => (a[2] as number) - (b[2] as number)),
    ).toEqual(ids);
    expect(rows.filter((e) => e.kind === "refused")).toHaveLength(1);
    expect(hist().meta[id]?.days).toEqual(days);
    expect(await longRests(id)).toEqual(rests);
    for (const e of rows) expect(() => checkEntry(e, "e")).not.toThrow();
  });

  it("another tab changed the journal: the refusal is not claimed saved (conflict), nothing written", async () => {
    const id = await emptyBard();
    hist().ensureMeta(id);
    await flushNow();
    const database = await db();
    const m = (await database.get("history_meta", id)) as HistoryMeta;
    await database.put("history_meta", { ...m, rev: m.rev + 1 });
    await docs().playAction(id, { type: "use", key: BI }, undefined, undefined, {
      command: "sheet_use",
      label: "Bardic Inspiration",
    });
    await flushNow();
    expect(hist().saveState.status).toBe("conflict");
    const saved = await database.getAllFromIndex(
      "history",
      "by_record_seq",
      IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]),
    );
    expect(saved.some((e) => e.kind === "refused")).toBe(false);
    expect(unsavedState(id).entries).toBeGreaterThan(0);
  });

  it("quota: the refusal fails to save with the rest, said so, and is written once on retry", async () => {
    const id = await emptyBard();
    await flushNow();
    await docs().playAction(id, { type: "use", key: BI }, undefined, undefined, {
      command: "sheet_use",
      label: "Bardic Inspiration",
    });
    const proto = IDBObjectStore.prototype;
    const put = proto.put;
    proto.put = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore["put"]>) {
      if (this.name === "history") throw new DOMException("quota", "QuotaExceededError");
      return put.apply(this, args);
    };
    try {
      await expect(flushNow()).rejects.toThrow();
    } finally {
      proto.put = put;
    }
    expect(hist().saveState.status).toBe("failed");
    expect((await savedRows(id)).filter((e) => e.kind === "refused")).toHaveLength(0);
    await flushNow();
    expect(hist().saveState).toEqual({ status: "saved" });
    expect((await savedRows(id)).filter((e) => e.kind === "refused")).toHaveLength(1);
  });

  it("the state of a refused command is never different from before (CharacterState identity)", async () => {
    const id = await emptyBard();
    const s: CharacterState | undefined = record(id)?.state;
    await docs().playAction(id, [{ type: "use", key: BI }], undefined, undefined, {
      command: "sheet_use",
      label: "Bardic Inspiration",
    });
    expect(record(id)?.state).toBe(s);
  });
});
