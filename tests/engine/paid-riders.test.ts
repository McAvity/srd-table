/**
 * kenli F-002 T02 R04-01: paid damage riders through the app's facade. The engine computes a
 * rider's use as a cost; the facade's cost check (on fixed dice) refuses a roll it can't pay
 * before the session's dice move, and a GM's forced roll goes on with the cost unpaid. In an
 * encounter the engine refuses an exhausted pool before rolling. Invented test content only.
 */

import { describe, expect, it } from "vitest";
import { nodeFacade } from "../../src/engine/node";
import { fighter } from "../fixtures/characters";

const pack = {
  "manifest.json": {
    manifest: { id: "test-paid-riders", version: "1.0.0", source: "test", requires: ["srd-5.2.1"] },
    tables: { feats: { file: "feats.json", count: 1 } },
  },
  "feats.json": [
    {
      id: "test-pool",
      name: "Test Pool",
      category: "origin",
      grants: {
        resources: [{ id: "pool", name: "Test Pool", max: { value: 1 }, recharge: "short" }],
        damage_riders: ["first", "second"].map((id) => ({
          id,
          name: id,
          damage: "1d6",
          applies_to: { weapon: true },
          uses: "pool",
        })),
      },
    },
  ],
};

async function setup(seed: number) {
  const e = nodeFacade({ seed });
  const [ref] = await e.registerPacks([pack]);
  const ctx = { packs: [await e.servedPack("srd-5.2.1"), ref as never], sources: null };
  const base = await fighter(e, 1);
  const r = await e.editBuild(base, { type: "choice", key: "species:human#versatile", values: ["test-pool"] }, ctx);
  if (!r.ok) throw new Error(r.reasons.join("; "));
  const build = r.build;
  const state = await e.createState(build, ctx);
  const sheet = (await e.playSheet(build, state, ctx)).sheet;
  const key = sheet.play.uses.find((u) => u.name === "Test Pool")?.key as string;
  const empty = await e.applyPlayAction(build, state, { type: "use", key }, ctx);
  if (!empty.ok) throw new Error(empty.reasons.join("; "));
  return { e, ctx, build, state, empty: empty.state, key };
}
const attack = (riders: string[]) =>
  ({ type: "attack", attack: "Greatsword", riders: riders.map((rider) => ({ rider })) }) as const;
const nextRoll = async (s: Awaited<ReturnType<typeof setup>>) => {
  const r = await s.e.rollByHand(s.build, s.state, attack([]), false, s.ctx);
  if (!r.ok) throw new Error(r.reasons.join("; "));
  return JSON.stringify(r.roll.rolls.attacks);
};

describe("paid riders through the facade (kenli F-002 R04-01)", () => {
  it("over budget (two riders, pool 1): refused, the session's dice don't move, nothing spent", async () => {
    const a = await setup(11);
    const b = await setup(11);
    const refused = await a.e.rollByHand(a.build, a.state, attack(["first", "second"]), false, a.ctx);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reasons.join(" ")).toMatch(/Test Pool: 0 left/);
    expect(await nextRoll(a)).toBe(await nextRoll(b));
  });

  it("within budget: paid once; an exhausted pool is refused without rolling", async () => {
    const s = await setup(3);
    const paid = await s.e.rollByHand(s.build, s.state, attack(["first"]), false, s.ctx);
    expect(paid.ok).toBe(true);
    if (paid.ok) expect(paid.state.uses_spent[s.key]).toBe(1);
    const t = await setup(3);
    const empty = await t.e.rollByHand(t.build, t.empty, attack(["first"]), false, t.ctx);
    expect(empty.ok).toBe(false);
    const u = await setup(3);
    expect(await nextRoll(t)).toBe(await nextRoll(u));
  });

  it("forced by the GM: rolled, the cost reported unpaid, the pool not overspent", async () => {
    const s = await setup(5);
    const forced = await s.e.rollByHand(s.build, s.empty, attack(["first"]), true, s.ctx);
    expect(forced.ok).toBe(true);
    if (!forced.ok) return;
    expect(forced.roll.costs.some((c) => !c.payable)).toBe(true);
    expect(forced.state.uses_spent[s.key]).toBe(1);
    expect(forced.notes.join(" ")).toMatch(/0 left/);
  });

  it("in an encounter, an exhausted pool is refused before any die", async () => {
    const run = async (seed: number, tryPaid: boolean) => {
      const s = await setup(seed);
      const party = { aerin: { build: s.build, state: s.empty, content: s.ctx } };
      let enc = await s.e.newEncounter();
      const act = async (action: never) => {
        const r = await s.e.applyEncounterAction(enc, party, action, s.ctx);
        if (r.ok) enc = r.encounter;
        return r;
      };
      for (const a of [
        { type: "add_character", character: "aerin" },
        { type: "add_monster", monster: "ogre" },
        { type: "set_initiative", id: "aerin", value: 20 },
        { type: "set_initiative", id: "ogre", value: 10 },
        { type: "start" },
      ])
        await act(a as never);
      let refused: unknown = null;
      if (tryPaid)
        refused = await act({ type: "attack", id: "aerin", target: "ogre", attack: "Greatsword", riders: [{ rider: "first" }] } as never);
      const plain = await act({ type: "attack", id: "aerin", target: "ogre", attack: "Greatsword" } as never);
      return { refused, plain: plain.ok ? JSON.stringify(plain.results) : plain.reasons };
    };
    const tried = await run(9, true);
    expect((tried.refused as { ok: boolean; reasons: string[] }).ok).toBe(false);
    expect((tried.refused as { reasons: string[] }).reasons.join(" ")).toMatch(/Test Pool: 0 left/);
    expect(tried.plain).toEqual((await run(9, false)).plain);
  });
});
