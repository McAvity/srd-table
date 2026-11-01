/**
 * kenli F-002 T10 (H2): a tracked pool through the app's facade — the sheet path's cast by hand
 * with a `triggers` pick (created or restored, its cost paid once with the slot), refusals without a
 * slot or when already created (nothing spent), `use` with an amount (the absorbed part), a Long Rest
 * ends it. Invented test content only (a patch on the SRD Wizard).
 */

import { describe, expect, it } from "vitest";
import { nodeFacade } from "../../src/engine/node";
import { wizard } from "../fixtures/characters";

const pack = {
  "manifest.json": {
    manifest: { id: "test-ward", version: "1.0.0", source: "test", requires: ["srd-5.2.1"] },
    tables: {},
    patches: [
      {
        target: "classes/wizard",
        op: "append",
        path: "features.1.resources",
        value: {
          id: "ward",
          name: "Test Ward",
          max: { per_class_level: 2, plus_ability: "int" },
          recharge: "long",
          tracked: true,
        },
      },
      {
        target: "classes/wizard",
        op: "set",
        path: "features.1.cast_triggers",
        value: [
          {
            id: "ward",
            name: "Test Ward",
            school: "abjuration",
            resource: "ward",
            create: true,
            restore_per_slot_level: 2,
          },
        ],
      },
    ],
  },
};

async function setup() {
  const e = nodeFacade({ seed: 3 });
  const [ref] = await e.registerPacks([pack]);
  const ctx = { packs: [await e.servedPack("srd-5.2.1"), ref as never], sources: null };
  const build = await wizard(e, 3);
  const state = await e.createState(build, ctx);
  return { e, ctx, build, state };
}
const KEY = "wizard:ward";

describe("Arcane Ward-like tracked pool through the facade (kenli F-002 T10 H2)", () => {
  it("created by a slotted Abjuration cast with the player's pick, then absorbs, then a Long Rest ends it", async () => {
    const { e, ctx, build, state } = await setup();
    const sheet0 = (await e.playSheet(build, state, ctx)).sheet;
    expect(sheet0.cast_triggers.map((t) => t.key)).toEqual([KEY]);
    const line = (s: typeof sheet0) => s.play.uses.find((u) => u.key === KEY);
    // INT 17 (+3), Wizard 3: 2 × 3 + 3 = 9.
    expect(line(sheet0)).toMatchObject({ tracked: true, created: false, max: 9 });
    const spell = sheet0.spells.find((s) => s.id === "alarm") ? "alarm" : "shield";

    const ritual = await e.rollByHand(
      build,
      state,
      {
        type: "cast",
        spell: "alarm",
        payment: { type: "ritual" },
        triggers: [{ key: KEY, mode: "create" }],
      },
      false,
      ctx,
    );
    expect(ritual.ok).toBe(false);

    const made = await e.rollByHand(
      build,
      state,
      { type: "cast", spell, slot_level: 1, triggers: [{ key: KEY, mode: "create" }] },
      false,
      ctx,
    );
    if (!made.ok) throw new Error(made.reasons.join("; "));
    expect(made.state.spell_slots_spent[0]).toBe(1);
    const s1 = (await e.playSheet(build, made.state, ctx)).sheet;
    expect(line(s1)).toMatchObject({ created: true, current: 9 });

    const again = await e.rollByHand(
      build,
      made.state,
      { type: "cast", spell, slot_level: 1, triggers: [{ key: KEY, mode: "create" }] },
      false,
      ctx,
    );
    expect(again.ok).toBe(false);

    const hit = await e.applyPlayAction(
      build,
      made.state,
      { type: "use", key: KEY, amount: 4 },
      ctx,
    );
    if (!hit.ok) throw new Error(hit.reasons.join("; "));
    expect(line((await e.playSheet(build, hit.state, ctx)).sheet)?.current).toBe(5);
    const over = await e.applyPlayAction(
      build,
      hit.state,
      { type: "use", key: KEY, amount: 6 },
      ctx,
    );
    expect(over.ok).toBe(false);

    const rested = await e.applyPlayAction(build, hit.state, { type: "long_rest" }, ctx);
    if (!rested.ok) throw new Error(rested.reasons.join("; "));
    expect(line((await e.playSheet(build, rested.state, ctx)).sheet)).toMatchObject({
      created: false,
    });
    expect(rested.state.pools).toBeUndefined();
  });
});
