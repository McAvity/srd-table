import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { useDocuments } from "../../src/store/documents";
import { useRollAdditions, useRolls } from "../../src/store/rolls";
import { useUi } from "../../src/store/ui";
import { fighter } from "../fixtures/characters";
import { BI, bard, storeCharacter, testContext } from "../fixtures/player-actions";
import { installTestEngine, renderApp, resetStores } from "../helpers/app";

// F-005 on the sheet: the UI picks the action and its payment, the engine computes, the store commits once.

const engine = installTestEngine();
const record = (id: string) => useDocuments.getState().characters[id];

beforeEach(async () => {
  await resetStores();
  useRolls.setState({ last: {} });
  useRollAdditions.setState({ by: {} });
});

async function pinnedBard() {
  const build = await bard(engine);
  const content = await testContext(engine);
  const fresh = await engine.createState(build, content);
  const spent = await engine.applyPlayAction(
    build,
    fresh,
    { type: "use", key: BI, amount: 2 },
    content,
  );
  if (!spent.ok) throw new Error(spent.reasons.join("; "));
  return { id: await storeCharacter(engine, build, content, spent.state), build, content };
}

describe("player actions on the sheet", () => {
  it("Font of Inspiration with a chosen slot: one commit, a use of Bardic Inspiration back", async () => {
    const { id } = await pinnedBard();
    await renderApp(`/characters/${id}/sheet?tab=combat`);
    const row = (await screen.findByText("Font of Inspiration", {}, { timeout: 10_000 })).closest(
      "li",
    ) as HTMLElement;
    await userEvent.selectOptions(within(row).getByRole("combobox"), "2");
    await userEvent.click(within(row).getByRole("button", { name: "Use" }));
    await waitFor(() => expect(record(id)?.state.uses_spent[BI]).toBe(1));
    expect(record(id)?.state.spell_slots_spent).toEqual([0, 1]);
    expect(record(id)?.rev).toBe(1);
  });

  it("a free cast picked on the Spells tab spends the free use, not a slot", async () => {
    const { id, build, content } = await pinnedBard();
    const sheet = (await engine.playSheet(build, record(id)?.state as never, content)).sheet;
    const spell = sheet.spells.find((s) => s.free.length > 0);
    const use = spell?.free[0]?.use as string;
    await renderApp(`/characters/${id}/sheet?tab=spells`);
    const row = (
      await screen.findAllByText(spell?.name as string, {}, { timeout: 10_000 })
    )[0]?.closest("li") as HTMLElement;
    await userEvent.selectOptions(
      within(row).getByRole("combobox", { name: /slot level/ }),
      `free:${use}`,
    );
    await userEvent.click(within(row).getByRole("button", { name: "Roll" }));
    await waitFor(() => expect(record(id)?.state.uses_spent[use]).toBe(1));
    expect(record(id)?.state.spell_slots_spent ?? []).toEqual([]);
  });

  it("a feature's die by hand, then Heroic Inspiration from the last-roll panel: the use stays spent once", async () => {
    const { id } = await pinnedBard();
    await useDocuments.getState().playAction(id, { type: "set_inspiration", value: true });
    await renderApp(`/characters/${id}/sheet?tab=combat`);
    const row = (await screen.findByText("Test Taunt", {}, { timeout: 10_000 })).closest(
      "li",
    ) as HTMLElement;
    await userEvent.click(within(row).getByRole("button", { name: "By hand" }));
    await waitFor(() => expect(record(id)?.state.uses_spent["species:human:test-spur"]).toBe(1));
    const panel = await screen.findByRole("region", { name: "Last roll" });
    await userEvent.click(within(panel).getByRole("button", { name: /^Reroll 1d8/ }));
    await waitFor(() => expect(record(id)?.state.heroic_inspiration).toBe(false));
    expect(record(id)?.state.uses_spent["species:human:test-spur"]).toBe(1);
  });

  it("Grapple from the sheet shows what the save decides", async () => {
    const build = await fighter(engine, 3);
    const id = await storeCharacter(engine, build);
    await renderApp(`/characters/${id}/sheet?tab=combat`);
    await userEvent.click(
      await screen.findByRole("button", { name: "Grapple" }, { timeout: 10_000 }),
    );
    await waitFor(() =>
      expect(
        useUi
          .getState()
          .toasts.flatMap((x) => x.lines)
          .some((l) => /Grapple, DC \d+/.test(l)),
      ).toBe(true),
    );
  });

  it("the GM's modifier set on the sheet reaches the next check, listed in the result", async () => {
    const build = await fighter(engine, 3);
    const id = await storeCharacter(engine, build);
    await renderApp(`/characters/${id}/sheet`);
    const options = await screen.findByRole(
      "region",
      { name: "GM additions to the next rolls" },
      { timeout: 10_000 },
    );
    const modifier = within(options).getByLabelText("Modifier");
    await userEvent.type(modifier, "3");
    await userEvent.tab();
    await userEvent.click(screen.getByRole("button", { name: /^Athletics .*Roll$/ }));
    await waitFor(() => {
      const last = useRolls.getState().last[id];
      expect(last?.kind === "test" ? last.test.modifiers : null).toEqual([
        { label: "GM", value: 3 },
      ]);
    });
  });

  it("a Short Rest one die at a time: Cancel saves nothing; Confirm is one commit and a short-rest use comes back once", async () => {
    const build = await fighter(engine, 3);
    const id = await storeCharacter(engine, build);
    await useDocuments.getState().playAction(id, [
      { type: "use", key: "fighter:second-wind", amount: 2 },
      { type: "damage", amount: 20 },
    ]);
    const before = record(id);
    await renderApp(`/characters/${id}/sheet`);
    await userEvent.click(
      await screen.findByRole("button", { name: "Short Rest" }, { timeout: 10_000 }),
    );
    let dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Spend a d10" }));
    await within(dialog).findByTestId("rest-preview", {}, { timeout: 10_000 });
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(record(id)).toBe(before);
    await userEvent.click(screen.getByRole("button", { name: "Short Rest" }));
    dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Spend a d10" }));
    await within(dialog).findByTestId("rest-preview", {}, { timeout: 10_000 });
    await userEvent.click(within(dialog).getByRole("button", { name: "Spend a d10" }));
    await waitFor(() =>
      expect(within(dialog).getByTestId("rest-dice").textContent).toMatch(/d10: \d+, d10: \d+/),
    );
    await userEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(record(id)?.state.hit_dice_spent["10"]).toBe(2));
    expect(record(id)?.rev).toBe((before?.rev ?? 0) + 1);
    expect(record(id)?.state.uses_spent["fighter:second-wind"]).toBe(1);
  });
});
