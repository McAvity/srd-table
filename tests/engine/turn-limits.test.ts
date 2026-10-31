/**
 * kenli F-002 T02 R04 (round 7): turn limits through the app's facade. One once-per-turn
 * alternative shared by feature actions and riders (`alternative`), a die-free action that
 * unlocks its rider (`counts_as`), a strike after a qualifying attack (`after_attack_with`) and a
 * miss that hits instead (`hit_on_miss`, a decision). Invented test content only.
 */

import { describe, expect, it } from "vitest";
import { nodeFacade } from "../../src/engine/node";
import { fighter } from "../fixtures/characters";

const FREE = { label: "Test Free" };
const pack = {
  "manifest.json": {
    manifest: { id: "test-turn-limits", version: "1.0.0", source: "test", requires: ["srd-5.2.1"] },
    tables: { feats: { file: "feats.json", count: 1 } },
  },
  "feats.json": [
    {
      id: "test-tricks",
      name: "Test Tricks",
      category: "origin",
      grants: {
        resources: [{ id: "pool", name: "Test Pool", max: { value: 2 }, recharge: "short" }],
        actions: [
          { id: "dash", name: "Test Dash", economy: "bonus_action", uses: "pool", also: ["dash"] },
          {
            id: "dash-free",
            name: "Test Dash (Free)",
            economy: "bonus_action",
            also: ["dash"],
            alternative: FREE,
            counts_as: "dash",
          },
          { id: "other-free", name: "Test Other (Free)", economy: "free", alternative: FREE },
          {
            id: "pole",
            name: "Test Pole",
            economy: "bonus_action",
            after_attack_action: true,
            after_attack_with: { properties: ["heavy", "two-handed"] },
            attacks: { attack: "Test Butt", count: 1 },
          },
          { id: "aim", name: "Test Aim", economy: "free", hit_on_miss: true },
        ],
        weapon_strikes: [
          {
            name: "Test Butt",
            die: "1d4",
            damage_type: "bludgeoning",
            properties: ["heavy", "two-handed"],
          },
        ],
        damage_riders: [
          {
            id: "trip",
            name: "Test Trip",
            damage: "1d6",
            applies_to: { weapon: true },
            uses: "pool",
            exclusive: "trick",
            alternative: { dice: "1d8", ...FREE },
          },
          {
            id: "lunge",
            name: "Test Lunge",
            damage: "1d6",
            applies_to: { weapon: true },
            exclusive: "trick",
            requires_feature: "dash",
            alternative: { dice: "1d8", ...FREE },
          },
        ],
      },
    },
  ],
};

async function setup(seed: number) {
  const e = nodeFacade({ seed });
  const [ref] = await e.registerPacks([pack]);
  const ctx = { packs: [await e.servedPack("srd-5.2.1"), ref as never], sources: null };
  const base = await fighter(e, 1);
  const r = await e.editBuild(
    base,
    { type: "choice", key: "species:human#versatile", values: ["test-tricks"] },
    ctx,
  );
  if (!r.ok) throw new Error(r.reasons.join("; "));
  const build = r.build;
  let party = { aerin: { build, state: await e.createState(build, ctx), content: ctx } };
  let enc = await e.newEncounter();
  const act = async (action: object) => {
    const x = await e.applyEncounterAction(enc, party, action as never, ctx);
    if (x.ok) {
      enc = x.encounter;
      for (const [k, st] of Object.entries(x.states))
        if (k === "aerin") party = { aerin: { ...party.aerin, state: st } };
    }
    return x;
  };
  for (const a of [
    { type: "add_character", character: "aerin" },
    { type: "add_monster", monster: "ogre" },
    { type: "set_initiative", id: "aerin", value: 20 },
    { type: "set_initiative", id: "ogre", value: 10 },
    { type: "start" },
  ])
    await act(a);
  const spent = () => Object.values(party.aerin.state.uses_spent).reduce((n, v) => n + (v ?? 0), 0);
  return {
    e,
    ctx,
    act,
    spent,
    get enc() {
      return enc;
    },
    get party() {
      return party;
    },
  };
}
const feature = (name: string) => ({ type: "feature", id: "aerin", feature: name });
const swing = (attack: string, riders: object[] = [], extra: object = {}) => ({
  type: "attack",
  id: "aerin",
  target: "ogre",
  attack,
  riders,
  ...extra,
});
type Rolled = {
  hit?: boolean;
  hit_instead?: string;
  roll?: { d20: number };
  damage?: { parts: { dice: string }[] } | null;
};
const last = (x: { ok: boolean }) =>
  x.ok ? ((x as unknown as { results: Rolled[] }).results.at(-1) ?? {}) : {};

describe("turn limits through the facade (kenli F-002 R04 round 7)", () => {
  it("one shared alternative: action then rider refused, the paid rider still works", async () => {
    const s = await setup(4);
    expect((await s.act(feature("Test Other (Free)"))).ok).toBe(true);
    const refused = await s.act(swing("Greatsword", [{ rider: "trip", alternative: true }]));
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reasons.join(" ")).toMatch(/already used Test Free/);
    const paid = await s.act(swing("Greatsword", [{ rider: "trip" }]));
    expect(paid.ok).toBe(true);
  });

  it("a die-free action unlocks its rider: the alternative's die, nothing spent, no second charge", async () => {
    for (let seed = 1; seed < 40; seed++) {
      const s = await setup(seed);
      await s.act(feature("Test Dash (Free)"));
      const hit = await s.act(swing("Greatsword", [{ rider: "lunge", alternative: true }]));
      expect(hit.ok).toBe(true);
      if (!last(hit).hit) continue;
      expect(last(hit).damage?.parts.map((p) => p.dice)).toContain("1d8");
      expect(s.spent()).toBe(0);
      const again = await s.act(feature("Test Other (Free)"));
      expect(again.ok).toBe(false);
      return;
    }
    throw new Error("no hit in 40 seeds");
  });

  it("a strike after a qualifying attack only", async () => {
    const s = await setup(2);
    await s.act(swing("Unarmed Strike"));
    const refused = await s.act(feature("Test Pole"));
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reasons.join(" ")).toMatch(/follows an attack with Greatsword/);
    const t = await setup(2);
    await t.act(swing("Greatsword"));
    expect((await t.act(feature("Test Pole"))).ok).toBe(true);
    expect((await t.act(swing("Test Butt", [], { granted: true }))).ok).toBe(true);
  });

  it("a miss asked to hit instead: the same roll, then not again until the next own turn", async () => {
    for (let seed = 1; seed < 80; seed++) {
      const s = await setup(seed);
      await s.act({ type: "set_decisions", id: "aerin", mode: "ask" });
      const stopped = await s.act(swing("Greatsword"));
      if (!stopped.ok || stopped.pending?.kind !== "hit_on_miss") continue;
      const used = await s.act({ type: "decide", use: true });
      expect(used.ok).toBe(true);
      expect(last(used)).toMatchObject({ hit: true, hit_instead: "Test Aim" });
      // The decision replays the recorded d20: the missed roll is the one that hits.
      expect(last(used).roll?.d20).toBe(stopped.pending.rolls[0]);
      expect((stopped.pending.rolls[0] ?? 20) + 5).toBeLessThan(11);
      const own = s.enc.combatants.find((c) => c.character === "aerin");
      expect(own?.used_until_turn.length).toBe(1);
      const alone = await s.act(feature("Test Aim"));
      expect(alone.ok).toBe(false);
      return;
    }
    throw new Error("no miss in 80 seeds");
  });

  it("by hand: a costless use with the table's note, no die rolled", async () => {
    const s = await setup(7);
    const r = await s.e.rollByHand(
      s.party.aerin.build,
      s.party.aerin.state,
      { type: "feature", feature: "Test Aim" } as never,
      false,
      s.ctx,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.notes.join(" ")).toMatch(/declared a miss hits instead/);
  });
});
