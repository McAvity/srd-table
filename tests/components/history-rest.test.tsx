/**
 * kenli F-006 T02: the rest dialog on the real sheet. A preview and a Cancel record nothing; a
 * Confirm records one Short Rest with the dialog's dice (a die rerolled with Heroic Inspiration keeps
 * the die as first rolled); a second Long Rest the same day asks for the DM's exception first.
 */

import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { useDocuments } from "../../src/store/documents";
import { sessionEntries } from "../../src/store/history";
import { fighter } from "../fixtures/characters";
import { installTestEngine, renderApp, resetStores } from "../helpers/app";

const engine = installTestEngine(9);
beforeEach(resetStores);

async function storedFighter() {
  const result = await useDocuments.getState().importCharacter(await fighter(engine, 3));
  if (!result.ok) throw new Error(result.reasons.join("; "));
  return result.id;
}

describe("rest dialog and the journal", () => {
  it("Short Rest: preview and Cancel record nothing; Confirm one entry with the dice as rolled and rerolled", async () => {
    const id = await storedFighter();
    await useDocuments
      .getState()
      .playAction(id, [{ type: "damage", amount: 20 }, { type: "set_inspiration", value: true }]);
    await renderApp(`/characters/${id}/sheet`);
    const open = async () => {
      await userEvent.click(
        await screen.findByRole("button", { name: "Short Rest" }, { timeout: 10_000 }),
      );
      return screen.findByRole("dialog");
    };
    let dialog = await open();
    await userEvent.click(within(dialog).getByRole("button", { name: "Spend a d10" }));
    await within(dialog).findByTestId("rest-preview", {}, { timeout: 10_000 });
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(sessionEntries(id).map((e) => e.kind)).toEqual(["play"]);

    dialog = await open();
    await userEvent.click(within(dialog).getByRole("button", { name: "Spend a d10" }));
    await within(dialog).findByTestId("rest-preview", {}, { timeout: 10_000 });
    await userEvent.click(within(dialog).getByRole("button", { name: /Heroic Inspiration/ }));
    await waitFor(() =>
      expect(within(dialog).queryByRole("button", { name: /Heroic Inspiration/ })).toBeNull(),
    );
    await userEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(sessionEntries(id)).toHaveLength(2));
    const rest = sessionEntries(id)[1];
    expect(rest).toMatchObject({
      kind: "short_rest",
      rest_kind: "short",
      costs: [{ type: "play", action: { type: "spend_inspiration" } }],
    });
    const die = rest?.rest?.dice[0];
    expect(die?.die).toBe(10);
    expect(die?.rerolled_from).not.toBeNull();
    expect(rest?.outcome[0]).toMatchObject({
      raw: die?.rerolled_from?.rolls[0],
      effective: die?.roll.rolls[0],
    });
    expect(useDocuments.getState().characters[id]?.state.hit_dice_spent["10"]).toBe(1);
  });

  it("a second Long Rest the same day: a warning, Confirm only with the DM's exception, kept in the entry", async () => {
    const id = await storedFighter();
    await renderApp(`/characters/${id}/sheet`);
    const longRest = async () => {
      await userEvent.click(
        await screen.findByRole("button", { name: "Long Rest" }, { timeout: 10_000 }),
      );
      return screen.findByRole("dialog");
    };
    let dialog = await longRest();
    await userEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(sessionEntries(id)).toHaveLength(1));
    dialog = await longRest();
    const warning = await within(dialog).findByTestId("second-long-rest");
    expect(warning).toHaveTextContent("A Long Rest was already taken on this day (1)");
    const confirm = within(dialog).getByRole("button", { name: "Confirm" });
    expect(confirm).toBeDisabled();
    await userEvent.click(within(dialog).getByRole("checkbox", { name: /DM allows it/ }));
    await userEvent.type(within(dialog).getByRole("textbox", { name: /Note/ }), "safe haven");
    await userEvent.click(confirm);
    await waitFor(() => expect(sessionEntries(id)).toHaveLength(2));
    expect(sessionEntries(id)[1]?.rest?.override).toEqual({ by: "dm", note: "safe haven" });
  });
});
