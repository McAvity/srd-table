// kenli F-013 T03: the facade's `assessItems` over the real engine (93dd924): one batch, the
// engine's kinds, statuses and prices (the same `listedPrice` Buy charges), the character's coins in
// copper, the app's language, and nothing changed.
import type { CharacterState } from "srd-rules-engine";
import { afterEach, describe, expect, it } from "vitest";
import { nodeFacade } from "../../src/engine/node";
import { fighter, wizard } from "../fixtures/characters";

const engine = nodeFacade({ seed: 7 });

afterEach(async () => {
  await engine.setLocale("en");
});

const coins = (gp: number): CharacterState["currency"] => ({ cp: 0, sp: 0, ep: 0, gp, pp: 0 });

describe("assessItems (facade)", () => {
  it("assesses a batch in order: kinds, statuses, mastery apart, prices from the engine", async () => {
    const build = await wizard(engine, 1);
    const state = await engine.createState(build);
    const view = await engine.assessItems(build, state, [
      { table: "armor", item: "shield" },
      { table: "magic_items", item: "shield-1" },
      { table: "magic_items", item: "staff-of-power" },
      { table: "magic_items", item: "staff-of-healing" },
      { table: "magic_items", item: "weapon-1" },
      { table: "weapons", item: "dagger" },
      { table: "tools", item: "lute" },
      { table: "gear", item: "arrow" },
      { table: "gear", item: "no-such-thing" },
    ]);
    const [shield, magicShield, power, healing, template, dagger, lute, arrow, unknown] =
      view.items;
    // Kinds: a magic shield is a Shield, a staff made from a Quarterstaff a Weapon, the rest Gear.
    expect([shield, magicShield, power, healing].map((a) => a?.kind)).toEqual([
      "shield",
      "shield",
      "weapon",
      "gear",
    ]);
    expect(shield?.proficiency.status).toBe("no");
    expect(shield?.restrictions.map((r) => r.code)).toEqual(["shield_untrained"]);
    expect(template?.proficiency.status).toBe("choose_base");
    expect(template?.bases?.any_proficient).toBe(true); // Simple weapons
    expect(dagger?.proficiency).toMatchObject({ status: "yes", via: "simple" });
    expect(dagger?.mastery.status).toBe("no"); // a Wizard has no Weapon Mastery
    expect(unknown).toMatchObject({ found: false, price_cp: null, price_text: null });
    expect(unknown?.proficiency.status).toBe("unknown");
    // Prices: the Lute's "35 GP, 2 lb." is 35 GP; Arrows 1 GP for 20; magic items unlisted.
    expect(lute).toMatchObject({ price_cp: 3500, bundle: 1, price_text: "35 GP" });
    expect(arrow).toMatchObject({ price_cp: 100, bundle: 20, price_text: "1 GP" });
    expect(magicShield).toMatchObject({ price_cp: null, price_text: null });
    expect(structuredClone(view)).toEqual(view);
  });

  it("purse in copper; changes nothing; buying charges exactly the listed price", async () => {
    const build = await fighter(engine, 1);
    const state = { ...(await engine.createState(build)), currency: coins(35) };
    const before = JSON.stringify({ build, state });
    const view = await engine.assessItems(build, state, [{ table: "tools", item: "lute" }]);
    expect(view.purse_cp).toBe(3500);
    expect(JSON.stringify({ build, state })).toBe(before);
    const bought = await engine.applyPlayAction(build, state, { type: "buy", item: "lute" });
    if (!bought.ok) throw new Error(bought.reasons.join("; "));
    const after = await engine.assessItems(build, bought.state, [{ table: "tools", item: "lute" }]);
    expect(view.purse_cp - after.purse_cp).toBe(view.items[0]?.price_cp);
    const poor = { ...state, currency: coins(34) };
    expect((await engine.applyPlayAction(build, poor, { type: "buy", item: "lute" })).ok).toBe(
      false,
    );
  });

  it("a chosen base gives the definitive answer; the template doesn't pretend", async () => {
    const build = await wizard(engine, 1);
    const state = await engine.createState(build);
    const { items } = await engine.assessItems(build, state, [
      { table: "magic_items", item: "weapon-1", base: "dagger" },
      { table: "magic_items", item: "weapon-1", base: "longsword" },
    ]);
    expect(items[0]).toMatchObject({ name: "Dagger, +1", base: "dagger" });
    expect(items[0]?.proficiency.status).toBe("yes");
    expect(items[1]?.proficiency.status).toBe("no");
  });

  it("renders the engine's words in the app's language (Italian)", async () => {
    const build = await wizard(engine, 1);
    const state = await engine.createState(build);
    await engine.setLocale("it");
    const { items } = await engine.assessItems(build, state, [{ table: "armor", item: "shield" }]);
    expect(items[0]?.restrictions[0]?.message.text).toBe(
      "Impugnando Shield senza addestramento negli scudi: non ti dà Classe Armatura",
    );
    expect(items[0]?.restrictions[0]?.message.code).toBe("item.restriction.shield_untrained");
  });
});
