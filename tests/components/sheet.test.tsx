import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { RollWhat } from "srd-rules-engine";
import { beforeEach, describe, expect, it } from "vitest";
import { useDocuments } from "../../src/store/documents";
import { fighter, sorcererBard, wizard } from "../fixtures/characters";
import { installTestEngine, renderApp, resetStores } from "../helpers/app";

const engine = installTestEngine(9);
beforeEach(resetStores);

async function storedFighter() {
  const result = await useDocuments.getState().importCharacter(await fighter(engine, 3));
  if (!result.ok) throw new Error(result.reasons.join("; "));
  return result.id;
}

describe("sheet", () => {
  it("explains its numbers", async () => {
    const id = await storedFighter();
    await renderApp(`/characters/${id}/sheet`);
    const ac = await screen.findByRole("button", { name: /^AC 16 = / }, { timeout: 10_000 });
    expect(ac.getAttribute("aria-label")).toMatch(/Chain Mail/);
  });

  it("applies damage through the engine and shows the new HP", async () => {
    const id = await storedFighter();
    await renderApp(`/characters/${id}/sheet`);
    const hp = await screen.findByRole("region", { name: "Hit Points" }, { timeout: 10_000 });
    await userEvent.type(within(hp).getByPlaceholderText("Amount"), "5");
    await userEvent.click(within(hp).getByRole("button", { name: "Damage" }));
    await waitFor(() => expect(useDocuments.getState().characters[id]?.state.hp.current).toBe(23));
    expect(await within(hp).findByText("23")).toBeInTheDocument();
  });

  it("shows Bloodied when the engine says so", async () => {
    const id = await storedFighter();
    await renderApp(`/characters/${id}/sheet`);
    const hp = await screen.findByRole("region", { name: "Hit Points" }, { timeout: 10_000 });
    expect(within(hp).queryByText("Bloodied")).toBeNull();
    // 28 HP: 14 left is half, so Bloodied.
    await userEvent.type(within(hp).getByPlaceholderText("Amount"), "14");
    await userEvent.click(within(hp).getByRole("button", { name: "Damage" }));
    expect(await within(hp).findByText("Bloodied")).toBeInTheDocument();
  });

  it("rolls a check through the engine, with a condition's Disadvantage and its reason", async () => {
    const id = await storedFighter();
    await useDocuments.getState().playAction(id, { type: "add_condition", condition: "poisoned" });
    await renderApp(`/characters/${id}/sheet`);
    const roll = await screen.findByRole(
      "button",
      { name: /^Athletics .*: Roll$/ },
      { timeout: 10_000 },
    );
    await userEvent.click(roll);
    const [line] = await screen.findAllByText(/Athletics check \(Disadvantage\)/);
    const card = line?.closest(".panel") as HTMLElement;
    expect(card).toHaveTextContent(/Poisoned/);
  });

  it("shows the engine's refusal where the player acted", async () => {
    const id = await storedFighter();
    await renderApp(`/characters/${id}/sheet?tab=combat`);
    const features = await screen.findByRole(
      "region",
      { name: "Features used in turns" },
      { timeout: 10_000 },
    );
    const surge = within(features).getAllByRole("button", { name: "Use" })[1] as HTMLElement;
    await userEvent.click(surge);
    await waitFor(() =>
      expect(useDocuments.getState().characters[id]?.state.uses_spent["fighter:action-surge"]).toBe(
        1,
      ),
    );
    await userEvent.click(surge);
    expect(await within(features).findByRole("alert")).toHaveTextContent(/Action Surge/);
    expect(useDocuments.getState().characters[id]?.state.uses_spent["fighter:action-surge"]).toBe(
      1,
    );
  });

  it("rolls a healing feature by hand: its dice shown, the use spent, nothing healed", async () => {
    const id = await storedFighter();
    await useDocuments.getState().playAction(id, { type: "damage", amount: 10 });
    await renderApp(`/characters/${id}/sheet?tab=combat`);
    const features = await screen.findByRole(
      "region",
      { name: "Features used in turns" },
      { timeout: 10_000 },
    );
    // Only Second Wind has dice: it alone has "By hand", after "Use" (characters play automatic).
    const byHand = within(features).getAllByRole("button", { name: "By hand" });
    expect(byHand).toHaveLength(1);
    await userEvent.click(byHand[0] as HTMLElement);
    await waitFor(() =>
      expect(useDocuments.getState().characters[id]?.state.uses_spent["fighter:second-wind"]).toBe(
        1,
      ),
    );
    expect(useDocuments.getState().characters[id]?.state.hp.current).toBe(18);
    const [tray] = await screen.findAllByRole("region", { name: "Dice results" });
    expect(tray).toHaveTextContent(/Healing rolled/);
  });

  it("rolls an attack by hand from the sheet: its dice shown, nothing spent", async () => {
    const id = await storedFighter();
    await renderApp(`/characters/${id}/sheet?tab=combat`);
    const attacks = await screen.findByRole("region", { name: "Attacks" }, { timeout: 10_000 });
    const before = useDocuments.getState().characters[id]?.state;
    await userEvent.click(
      within(attacks).getAllByRole("button", { name: "Roll" })[0] as HTMLElement,
    );
    const [tray] = await screen.findAllByRole("region", { name: "Dice results" });
    await waitFor(() => expect(tray).toHaveTextContent(/By hand/));
    // An attack costs nothing: the state is the same document.
    expect(useDocuments.getState().characters[id]?.state).toBe(before);
  });

  it("casts a spell by hand from the sheet: its slot spent", async () => {
    const result = await useDocuments.getState().importCharacter(await wizard(engine, 3));
    if (!result.ok) throw new Error(result.reasons.join("; "));
    await renderApp(`/characters/${result.id}/sheet?tab=spells`);
    const level1 = await screen.findByRole("region", { name: "Level 1" }, { timeout: 10_000 });
    await userEvent.click(
      within(level1).getAllByRole("button", { name: "Roll" })[0] as HTMLElement,
    );
    await waitFor(() =>
      expect(useDocuments.getState().characters[result.id]?.state.spell_slots_spent[0]).toBe(1),
    );
    const [tray] = await screen.findAllByRole("region", { name: "Dice results" });
    expect(tray).toHaveTextContent(/By hand/);
  });

  it("offers a spell only the slots the engine lists, a spent level disabled with its reason", async () => {
    const result = await useDocuments.getState().importCharacter(await wizard(engine, 3));
    if (!result.ok) throw new Error(result.reasons.join("; "));
    // A Wizard 3 has four level 1 slots: all spent.
    await useDocuments
      .getState()
      .playAction(result.id, Array(4).fill({ type: "spend_slot", level: 1 }));
    await renderApp(`/characters/${result.id}/sheet?tab=spells`);
    const level1 = await screen.findByRole("region", { name: "Level 1" }, { timeout: 10_000 });
    const [picker] = within(level1).getAllByRole("combobox", { name: /slot level/ });
    if (!picker) throw new Error("no slot picker");
    const spent = within(picker).getByRole("option", { name: /^Level 1/ });
    expect(spent).toBeDisabled();
    expect(spent).toHaveTextContent(/No level 1 spell slots left/);
    expect(picker).toHaveValue("slot:2");
    await userEvent.click(
      within(level1).getAllByRole("button", { name: "Roll" })[0] as HTMLElement,
    );
    await waitFor(() =>
      expect(useDocuments.getState().characters[result.id]?.state.spell_slots_spent[1]).toBe(1),
    );
  });

  it("casts a spell with the spellcasting feature the engine lists for it: Innate Sorcery only on Sorcerer spells", async () => {
    const sent: RollWhat[] = [];
    const rollByHand = engine.rollByHand;
    engine.rollByHand = (build, state, what, force) => {
      sent.push(what);
      return rollByHand(build, state, what, force);
    };
    try {
      const result = await useDocuments.getState().importCharacter(await sorcererBard(engine));
      if (!result.ok) throw new Error(result.reasons.join("; "));
      await useDocuments
        .getState()
        .playAction(result.id, { type: "activate", key: "sorcerer:innate-sorcery" });
      const record = useDocuments.getState().characters[result.id];
      if (!record) throw new Error("no record");
      const { sheet } = await engine.playSheet(record.build, record.state);
      const dc = (source: string) => sheet.spellcasting.find((l) => l.source === source)?.save_dc;
      expect(dc("Sorcerer")).toBe((dc("Bard") ?? 0) + 1);
      // A Bard spell with a save that's on the Sorcerer list too.
      const lists = new Map(
        (
          (await engine.entries("spells")) as {
            id: string;
            lists: string[];
            mechanics: { save: unknown } | null;
          }[]
        ).map((s) => [s.id, s]),
      );
      const bard = sheet.spells.find((s) => {
        const def = lists.get(s.id);
        return (
          s.level === 1 &&
          s.spellcasting.join() === "Bard" &&
          def?.lists.includes("sorcerer") &&
          def.mechanics?.save
        );
      });
      if (!bard) throw new Error("no Bard spell on both lists");
      await renderApp(`/characters/${result.id}/sheet?tab=spells`);
      const level1 = await screen.findByRole("region", { name: "Level 1" }, { timeout: 10_000 });
      const row = within(level1).getByText(bard.name).closest("li") as HTMLElement;
      await userEvent.click(within(row).getByRole("button", { name: "Roll" }));
      await waitFor(() =>
        expect(useDocuments.getState().characters[result.id]?.state.spell_slots_spent[0]).toBe(1),
      );
      expect(sent.at(-1)).toMatchObject({
        type: "cast",
        spell: bard.id,
        slot_level: 1,
        spellcasting: "Bard",
      });
      const [tray] = await screen.findAllByRole("region", { name: "Dice results" });
      expect(tray).toHaveTextContent(new RegExp(`DC ${dc("Bard")}\\b`));
      expect(tray).not.toHaveTextContent(new RegExp(`DC ${dc("Sorcerer")}\\b`));
    } finally {
      engine.rollByHand = rollByHand;
    }
  });

  it("asks which spellcasting feature casts a spell given twice, and sends the one picked", async () => {
    const sent: RollWhat[] = [];
    const rollByHand = engine.rollByHand;
    engine.rollByHand = (build, state, what, force) => {
      sent.push(what);
      return rollByHand(build, state, what, force);
    };
    try {
      const result = await useDocuments.getState().importCharacter(await sorcererBard(engine));
      if (!result.ok) throw new Error(result.reasons.join("; "));
      const record = useDocuments.getState().characters[result.id];
      if (!record) throw new Error("no record");
      // The same spell prepared through both classes (the engine reports it; an old file might have it).
      const bardPicks = record.build.choices["class:bard#prepared"] ?? [];
      const twice = bardPicks[0] as string;
      const sorcererPicks = record.build.choices["class:sorcerer#prepared"] ?? [];
      const build = {
        ...record.build,
        choices: {
          ...record.build.choices,
          "class:sorcerer#prepared": [twice, ...sorcererPicks.slice(1)],
        },
      };
      useDocuments.setState((s) => ({
        characters: { ...s.characters, [result.id]: { ...record, build } },
        revs: { ...s.revs, [result.id]: (s.revs[result.id] ?? 0) + 1 },
      }));
      const { sheet } = await engine.playSheet(build, record.state);
      const line = sheet.spells.find((s) => s.id === twice);
      expect(line?.spellcasting).toEqual(["Sorcerer", "Bard"]);
      await renderApp(`/characters/${result.id}/sheet?tab=spells`);
      const region = await screen.findByRole(
        "region",
        { name: line?.level === 0 ? "Cantrips" : `Level ${line?.level}` },
        { timeout: 10_000 },
      );
      const row = within(region)
        .getByText(line?.name as string)
        .closest("li") as HTMLElement;
      const roll = within(row).getByRole("button", { name: "Roll" });
      expect(roll).toBeDisabled();
      expect(row).toHaveTextContent("Choose the spellcasting feature to cast it with.");
      await userEvent.selectOptions(
        within(row).getByRole("combobox", { name: /Spellcasting feature to cast/ }),
        "Bard",
      );
      expect(roll).toBeEnabled();
      await userEvent.click(roll);
      await waitFor(() =>
        expect(sent.at(-1)).toMatchObject({ spell: twice, spellcasting: "Bard" }),
      );
    } finally {
      engine.rollByHand = rollByHand;
    }
  });

  it("takes a Short Rest spending Hit Point Dice the engine rolls", async () => {
    const id = await storedFighter();
    // Hurt enough that one Hit Die (d10 + 2) can't bring it back to full.
    await useDocuments.getState().playAction(id, { type: "damage", amount: 20 });
    await renderApp(`/characters/${id}/sheet`);
    await userEvent.click(
      await screen.findByRole("button", { name: "Short Rest" }, { timeout: 10_000 }),
    );
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Spend a d10" }));
    // The die is the engine's roll, then its preview (F-005: one die at a time, nothing saved yet).
    await within(dialog).findByTestId("rest-preview", {}, { timeout: 10_000 });
    expect(useDocuments.getState().characters[id]?.state.hit_dice_spent["10"]).toBeUndefined();
    await userEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
    await waitFor(() =>
      expect(useDocuments.getState().characters[id]?.state.hit_dice_spent["10"]).toBe(1),
    );
    expect(useDocuments.getState().characters[id]?.state.hp.current).toBeGreaterThan(8);
  });

  it("offers the starting equipment to a state made before it was picked, and takes it", async () => {
    // A character created empty, then built: its state has no equipment yet.
    const early = await engine.createState(await engine.newBuild());
    const result = await useDocuments.getState().importCharacter(await fighter(engine, 3), early);
    if (!result.ok) throw new Error(result.reasons.join("; "));
    await renderApp(`/characters/${result.id}/sheet`);
    const notice = await screen.findByRole(
      "region",
      { name: "Starting equipment" },
      { timeout: 10_000 },
    );
    expect(notice).toHaveTextContent(/Chain Mail/);
    await userEvent.click(within(notice).getByRole("button", { name: "Take starting equipment" }));
    await waitFor(() => {
      const state = useDocuments.getState().characters[result.id]?.state;
      expect(state?.starting_equipment).toBe(true);
      expect(state?.inventory.some((i) => i.item === "chain-mail" && i.equipped)).toBe(true);
    });
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Starting equipment" })).toBeNull(),
    );
  });
});
