import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { newId, useDocuments } from "../../src/store/documents";
import { useUi } from "../../src/store/ui";
import { fighter } from "../fixtures/characters";
import { installTestEngine, renderApp, resetStores } from "../helpers/app";

const engine = installTestEngine(3);
beforeEach(async () => {
  cleanup();
  await resetStores();
});

async function setup() {
  const aerin = await useDocuments.getState().importCharacter(await fighter(engine, 1));
  if (!aerin.ok) throw new Error("import");
  const record = useDocuments.getState().characters[aerin.id];
  if (!record) throw new Error("import");
  const party = { [aerin.id]: { build: record.build, state: record.state } };
  const r = await engine.applyEncounterAction(await engine.newEncounter(), party, [
    { type: "add_character", character: aerin.id },
  ]);
  if (!r.ok) throw new Error(r.reasons.join("; "));
  const id = newId("e");
  useDocuments.setState((s) => ({
    encounters: {
      ...s.encounters,
      [id]: { id, name: "Bridge", encounter: r.encounter, log: [], created: 0, updated: 0 },
    },
    revs: { ...s.revs, [id]: 1 },
  }));
  return { character: aerin.id, encounter: id };
}

const nav = () => screen.getByRole("navigation", { name: "Main" });
const link = (name: string) => within(nav()).getByRole("link", { name });

describe("the top bar's Table and Characters", () => {
  it("open the lists until there's something to open, then the last table and character", async () => {
    const { character, encounter } = await setup();
    await renderApp("/characters");
    await screen.findByRole("navigation", { name: "Main" });
    expect(link("Table")).toHaveAttribute("href", "/encounters");
    expect(link("Characters")).toHaveAttribute("href", "/characters");

    // The GM opens the table, then the character: both are remembered.
    await userEvent.click(link("Table"));
    await userEvent.click(await screen.findByRole("link", { name: /Bridge/ }));
    await waitFor(() => expect(useUi.getState().lastOpened.encounter).toBe(encounter));
    await userEvent.click(link("Characters"));
    await userEvent.click(await screen.findByRole("link", { name: /Sheet/ }));
    await waitFor(() => expect(useUi.getState().lastOpened.character).toBe(character));
    expect(link("Table")).toHaveAttribute("href", `/encounters/${encounter}`);
    expect(link("Characters")).toHaveAttribute("href", `/characters/${character}/sheet`);

    // The list is one click away from the document.
    await userEvent.click(link("Table"));
    await userEvent.click(await screen.findByRole("link", { name: "All encounters" }));
    expect(await screen.findByRole("link", { name: /Bridge/ })).toBeInTheDocument();
  });

  it("open a player's own sheet and the table their character is in", async () => {
    const { character, encounter } = await setup();
    useUi.setState({ role: { kind: "player", character } });
    await renderApp("/compendium");
    await screen.findByRole("navigation", { name: "Main" });
    expect(link("Characters")).toHaveAttribute("href", `/characters/${character}/sheet`);
    expect(link("Table")).toHaveAttribute("href", `/encounters/${encounter}`);
  });

  it("open at / too: the table, else the character, else the characters list", async () => {
    const { character, encounter } = await setup();
    await renderApp("/");
    expect(await screen.findByRole("heading", { name: "Characters" })).toBeInTheDocument();
    cleanup();

    useUi.setState({ lastOpened: { encounter: null, character } });
    await renderApp("/");
    expect(
      await screen.findByRole("region", { name: "Hit Points" }, { timeout: 10_000 }),
    ).toBeInTheDocument();
    cleanup();

    useUi.setState({ lastOpened: { encounter, character } });
    await renderApp("/");
    expect(
      await screen.findByRole("navigation", { name: "Initiative" }, { timeout: 15_000 }),
    ).toBeInTheDocument();
  });
});
