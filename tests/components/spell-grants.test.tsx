/**
 * kenli F-011 review03 R03-09 on the real sheet (jsdom, the in-process engine at the pinned commit):
 * spell rows come from the engine's grant provenance (`SpellLine.grants`, `SpellcastingLine.key`).
 * The same spell given by two sources (Elf and Sage, through a pack) is two rows, neither lost;
 * two Magic Initiates of one name (Human Versatile, Sage) are two identities with their own labels,
 * colours, free casts and cost choices; the description accordion and the looks are keyed by the
 * actual grant, stable across renders and a reload. Casting keeps the existing command identity.
 */

import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb } from "../../src/persistence/db";
import { flushNow, loadAll, startAutosave } from "../../src/persistence/sync";
import { useDocuments } from "../../src/store/documents";
import { sessionEntries } from "../../src/store/history";
import { elfSage, grantsContext, twoInitiates } from "../fixtures/grants";
import { storeCharacter } from "../fixtures/player-actions";
import { installTestEngine, renderApp, resetStores } from "../helpers/app";

const engine = installTestEngine(11);
const docs = () => useDocuments.getState();
beforeEach(async () => {
  await resetStores();
});
let stop: (() => void) | null = null;
afterEach(() => {
  cleanup();
  stop?.();
  stop = null;
});

async function open(id: string) {
  await renderApp(`/characters/${id}/sheet`);
  await userEvent.click(await screen.findByRole("tab", { name: "Spells" }, { timeout: 15_000 }));
  return screen.findAllByTestId("spell-line", {}, { timeout: 15_000 });
}
const rowsOf = (name: string) =>
  screen.getAllByTestId("spell-line").filter((l) => within(l).queryByRole("button", { name }));
const chip = (row: HTMLElement) => within(row).getByTestId("spell-source");
const nameButton = (row: HTMLElement) =>
  within(row)
    .getAllByRole("button")
    .find((b) => b.hasAttribute("aria-expanded")) as HTMLElement;

describe("the same spell from two sources", () => {
  it("Mage Hand from Elf and from Sage: two rows with their own labels, looks and descriptions; stable after a reload", async () => {
    await loadAll();
    stop = startAutosave(); // saved as the app saves it, so a reload reads it back
    const ctx = await grantsContext(engine);
    const id = await storeCharacter(engine, await elfSage(engine, ctx), ctx);
    await open(id);
    const rows = rowsOf("Mage Hand");
    expect(rows.map((r) => chip(r).textContent)).toEqual(["Elf", "Sage"]);
    const keys = rows.map((r) => r.dataset.spellKey);
    expect(new Set(keys).size).toBe(2);
    expect(chip(rows[0] as HTMLElement).dataset.look).not.toBe(
      chip(rows[1] as HTMLElement).dataset.look,
    );
    // One description open in the whole tab: the Sage row's, then the Elf row's.
    await userEvent.click(nameButton(rows[1] as HTMLElement));
    expect(nameButton(rows[1] as HTMLElement)).toHaveAttribute("aria-expanded", "true");
    expect(nameButton(rows[0] as HTMLElement)).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(nameButton(rows[0] as HTMLElement));
    expect(nameButton(rows[1] as HTMLElement)).toHaveAttribute("aria-expanded", "false");
    const looks = rows.map((r) => chip(r).dataset.look);
    // A reload (the store read back from storage): the same rows, keys and looks.
    await flushNow();
    cleanup();
    // As review03's reload: the autosave stopped first (an emptied store isn't a deletion).
    stop?.();
    await closeDb();
    useDocuments.setState({
      hydrated: false,
      characters: {},
      encounters: {},
      revs: {},
      history: {},
    });
    await loadAll();
    stop = startAutosave();
    expect(docs().characters[id]).toBeDefined();
    await open(id);
    const again = rowsOf("Mage Hand");
    expect(again.map((r) => r.dataset.spellKey)).toEqual(keys);
    expect(again.map((r) => chip(r).dataset.look)).toEqual(looks);
  });

  it("each row casts through its own grant: Elf's names its spellcasting (as before), Sage's names none", async () => {
    const ctx = await grantsContext(engine);
    const id = await storeCharacter(engine, await elfSage(engine, ctx), ctx);
    await open(id);
    const [elf, sage] = rowsOf("Mage Hand") as [HTMLElement, HTMLElement];
    await userEvent.click(within(elf).getByRole("button", { name: "Roll" }));
    await userEvent.click(within(sage).getByRole("button", { name: "Roll" }));
    await waitFor(() => expect(sessionEntries(id).length).toBe(2));
    const requests = sessionEntries(id).map(
      (e) => e.request as { what?: { spellcasting?: string } },
    );
    expect(requests.map((r) => r.what?.spellcasting ?? null)).toEqual(["Elf", null]);
  });
});

describe("two Magic Initiates of one name", () => {
  async function twoInitiatesStored() {
    const ctx = await grantsContext(engine);
    return storeCharacter(engine, await twoInitiates(engine, ctx), ctx);
  }

  it("labels say what granted each, looks differ, each level 1 spell offers only its own free cast; the choices are independent and the uses apart", async () => {
    const id = await twoInitiatesStored();
    await open(id);
    const labels = screen.getAllByTestId("spell-source").map((c) => c.textContent);
    expect(labels).toEqual(
      expect.arrayContaining(["Magic Initiate · Human", "Magic Initiate · Sage"]),
    );
    const human = screen
      .getAllByTestId("spell-source")
      .find((c) => c.textContent === "Magic Initiate · Human");
    const sage = screen
      .getAllByTestId("spell-source")
      .find((c) => c.textContent === "Magic Initiate · Sage");
    expect(human?.dataset.look).not.toBe(sage?.dataset.look);
    // The level 1 spell of each: its cost selector's free cast is its own feat's use.
    const level1 = (label: string) =>
      screen.getAllByTestId("spell-line").find(
        (l) =>
          chip(l).textContent === label &&
          within(l)
            .queryAllByRole("option")
            .some((o) => /free/i.test(o.textContent ?? "")),
      ) as HTMLElement;
    const h = level1("Magic Initiate · Human");
    const s = level1("Magic Initiate · Sage");
    const freeOf = (row: HTMLElement) =>
      [...(within(row).getAllByRole("combobox").at(-1) as HTMLSelectElement).options]
        .filter((o) => o.value.startsWith("free:"))
        .map((o) => o.value);
    expect(freeOf(h)).toEqual(["free:feat:magic-initiate@species:human#versatile:free-cast"]);
    expect(freeOf(s)).toEqual(["free:feat:magic-initiate@background:sage:free-cast"]);
    // Independent cost choices: the Human one's free cast picked, the Sage one keeps its slot.
    const hCost = within(h).getAllByRole("combobox").at(-1) as HTMLSelectElement;
    const sCost = within(s).getAllByRole("combobox").at(-1) as HTMLSelectElement;
    const sBefore = sCost.value;
    fireEvent.change(hCost, { target: { value: freeOf(h)[0] } });
    expect(sCost.value).toBe(sBefore);
    // Its description opens alone; the choice stays.
    await userEvent.click(nameButton(h));
    expect(hCost.value).toBe(freeOf(h)[0]);
    // Cast with the Human one's free use: only that use is spent.
    await userEvent.click(within(h).getByRole("button", { name: "Roll" }));
    await waitFor(() =>
      expect(
        docs().characters[id]?.state.uses_spent[
          "feat:magic-initiate@species:human#versatile:free-cast"
        ],
      ).toBe(1),
    );
    expect(
      docs().characters[id]?.state.uses_spent["feat:magic-initiate@background:sage:free-cast"] ?? 0,
    ).toBe(0);
    // Tab away and back: the same identities and looks.
    const looks = screen
      .getAllByTestId("spell-source")
      .map((c) => `${c.textContent}|${c.dataset.look}`);
    await userEvent.click(screen.getByRole("tab", { name: "Combat" }));
    await userEvent.click(screen.getByRole("tab", { name: "Spells" }));
    await waitFor(() =>
      expect(
        screen.getAllByTestId("spell-source").map((c) => `${c.textContent}|${c.dataset.look}`),
      ).toEqual(looks),
    );
    await act(async () => undefined);
  });
});
