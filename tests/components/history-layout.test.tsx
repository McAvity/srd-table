/**
 * kenli F-011 T05 (AC-07, AC-08) in jsdom: the History panel is a column of the layout, left of
 * `<main>` (no portal, no overlay), the game stays mounted when it opens and closes, and new entries
 * add to the page instead of pushing the oldest shown ones off it (reading older entries never
 * loses them). Geometry (bounds, scroll position, overflow) needs a real browser: e2e/layout.spec.ts.
 */

import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useDocuments } from "../../src/store/documents";
import { fighter } from "../fixtures/characters";
import { storeCharacter } from "../fixtures/player-actions";
import { installTestEngine, renderApp, resetStores } from "../helpers/app";
import { engineWithDice } from "../helpers/transfer";

installTestEngine(5);
const docs = () => useDocuments.getState();
let fx = engineWithDice();
beforeEach(async () => {
  await resetStores();
  fx = engineWithDice();
});
afterEach(() => cleanup());

const TOGGLE = "History: what this character played";
async function aerin(): Promise<string> {
  const built = await fx.engine.editBuild(await fighter(fx.engine, 3), {
    type: "name",
    name: "Aerin",
  });
  if (!built.ok) throw new Error("no build");
  return storeCharacter(fx.engine, built.build);
}

describe("History beside the game", () => {
  it("a column before <main> in one row, not a portal; the sheet isn't remounted when it opens or closes", async () => {
    const id = await aerin();
    await renderApp(`/characters/${id}/sheet`);
    const heading = await screen.findByRole(
      "heading",
      { name: "Aerin", level: 1 },
      { timeout: 15_000 },
    );
    await userEvent.click(screen.getByRole("button", { name: TOGGLE }));
    const panel = await screen.findByRole("dialog", { name: "History" });
    const row = screen.getByTestId("shell-row");
    const main = document.getElementById("main") as HTMLElement;
    expect(panel.parentElement).toBe(row);
    expect(main.parentElement).toBe(row);
    expect(panel.compareDocumentPosition(main) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(panel.className).not.toMatch(/\bfixed\b/);
    expect(main.className).toMatch(/@container/);
    // The same heading element: the screen wasn't rebuilt by opening the panel, nor by closing it.
    expect(screen.getByRole("heading", { name: "Aerin", level: 1 })).toBe(heading);
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "History" })).toBeNull());
    expect(screen.getByRole("heading", { name: "Aerin", level: 1 })).toBe(heading);
    expect(document.getElementById("main")).toBe(main);
  });

  it("new entries add to the page: the oldest one shown stays (reading the archive loses nothing)", async () => {
    const id = await aerin();
    for (let i = 0; i < 60; i++) {
      fx.dice.push((i % 19) + 1);
      expect((await docs().rollTest(id, { skill: "athletics" })).ok).toBe(true);
    }
    await renderApp(`/characters/${id}/sheet`);
    await userEvent.click(await screen.findByRole("button", { name: TOGGLE }, { timeout: 15_000 }));
    const panel = await screen.findByRole("dialog", { name: "History" });
    await waitFor(() =>
      expect(within(panel).getByTestId("history-count")).toHaveTextContent(
        "Showing 50 of 60 entries",
      ),
    );
    const groups = () =>
      within(panel)
        .getAllByTestId("history-group")
        .map((g) => g.dataset.anchor);
    const oldestShown = groups().at(-1);
    for (let i = 0; i < 3; i++) {
      fx.dice.push(10);
      await act(async () => {
        expect((await docs().rollTest(id, { skill: "athletics" })).ok).toBe(true);
      });
    }
    await waitFor(() =>
      expect(within(panel).getByTestId("history-count")).toHaveTextContent(
        "Showing 53 of 63 entries",
      ),
    );
    expect(groups().at(-1)).toBe(oldestShown);
    expect(groups()).toHaveLength(53);
  });
});
