import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { useDocuments } from "../../src/store/documents";
import { fighter } from "../fixtures/characters";
import { storeCharacter } from "../fixtures/player-actions";
import { installTestEngine, renderApp, resetStores } from "../helpers/app";

// Stored items on the sheet (kenli F-005 DEC-01): Put away / Take back are play actions; weight,
// attack lines and refusals are the engine's.

const engine = installTestEngine();
const record = (id: string) => useDocuments.getState().characters[id];

beforeEach(async () => {
  await resetStores();
});

const weight = () =>
  Number(/Carried (\d+(?:\.\d+)?) of/.exec(screen.getByText(/Carried \d/).textContent ?? "")?.[1]);
const row = (name: string) =>
  screen.getAllByText(name, { exact: true })[0]?.closest("li") as HTMLElement;

describe("stored items on the sheet", () => {
  it("a worn item: Put away is refused with the engine's reason, nothing changed", async () => {
    const id = await storeCharacter(engine, await fighter(engine, 3));
    await renderApp(`/characters/${id}/sheet?tab=inventory`);
    await screen.findByText(/Carried \d/, {}, { timeout: 10_000 });
    const before = record(id);
    await userEvent.click(within(row("Chain Mail")).getByRole("button", { name: "Put away" }));
    expect(
      await screen.findByText(/Take off Chain Mail before putting it away/),
    ).toBeInTheDocument();
    expect(record(id)).toBe(before);
  });

  it("Put away: stored (not carried), off the weight and the attack lines, no Equip; Undo; Take back", async () => {
    const id = await storeCharacter(engine, await fighter(engine, 3));
    await renderApp(`/characters/${id}/sheet?tab=inventory`);
    await screen.findByText(/Carried \d/, {}, { timeout: 10_000 });
    const w0 = weight();
    await userEvent.click(within(row("Greatsword")).getByRole("button", { name: "Put away" }));
    await waitFor(() => expect(record(id)?.state.version).toBe(2));
    await waitFor(() => expect(weight()).toBe(w0 - 6));
    const sword = row("Greatsword");
    expect(within(sword).getByText("Stored")).toBeInTheDocument();
    expect(within(sword).getByText(/6 lb \(not carried\)/)).toBeInTheDocument();
    expect(within(sword).queryByRole("button", { name: "Equip" })).toBeNull();
    await userEvent.click(screen.getByRole("tab", { name: /Combat/ }));
    await screen.findByRole("region", { name: "Attacks" });
    expect(screen.queryByRole("rowheader", { name: /^Greatsword/ })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(record(id)?.state.version).toBe(1));
    expect(await screen.findByRole("rowheader", { name: /^Greatsword/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Redo" }));
    await waitFor(() => expect(record(id)?.state.version).toBe(2));
    await userEvent.click(screen.getByRole("tab", { name: /Inventory/ }));
    await screen.findByText(/Carried \d/);
    await userEvent.click(within(row("Greatsword")).getByRole("button", { name: "Take back" }));
    await waitFor(() => expect(record(id)?.state.version).toBe(1));
    await waitFor(() => expect(weight()).toBe(w0));
  });

  it("a stored item can be sold or removed", async () => {
    const id = await storeCharacter(engine, await fighter(engine, 3));
    await renderApp(`/characters/${id}/sheet?tab=inventory`);
    await screen.findByText(/Carried \d/, {}, { timeout: 10_000 });
    const gp = record(id)?.state.currency.gp ?? 0;
    await userEvent.click(within(row("Greatsword")).getByRole("button", { name: "Put away" }));
    await waitFor(() => expect(record(id)?.state.version).toBe(2));
    await userEvent.click(
      within(row("Greatsword")).getByRole("button", { name: "Sell one: Greatsword" }),
    );
    await waitFor(() => expect(record(id)?.state.currency.gp).toBe(gp + 25));
    expect(record(id)?.state.inventory.some((i) => i.item === "greatsword")).toBe(false);
    expect(record(id)?.state.version).toBe(1);
    const torch = record(id)?.state.inventory.find((i) => i.item !== "chain-mail" && !i.equipped);
    if (!torch) throw new Error("nothing else to put away");
    await useDocuments.getState().playAction(id, { type: "store", id: torch.id, stored: true });
    const name = (
      await engine.playSheet(record(id)?.build as never, record(id)?.state as never)
    ).sheet.play.inventory.find((i) => i.id === torch.id)?.name as string;
    const qty = torch.qty;
    for (let n = 0; n < qty; n++)
      await userEvent.click(within(row(name)).getByRole("button", { name: `Remove: ${name}` }));
    await waitFor(() =>
      expect(record(id)?.state.inventory.some((i) => i.id === torch.id)).toBe(false),
    );
    expect(record(id)?.state.version).toBe(1);
  });
});
