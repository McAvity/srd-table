// kenli F-013 T03: the Add item dialog on the real engine (in-process facade, real SRD): kinds
// without typing, magic across kinds, the engine's statuses/restrictions/mastery as text, the
// budget from the engine's price, a template's bases, keyboard picking, Italian, and no stale
// answer after a revision, a base or a character changes. Buy and Add are the same actions.
import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import type { CharacterState } from "srd-rules-engine";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createQueryClient, useItemAssessments } from "../../src/queries";
import { useDocuments } from "../../src/store/documents";
import { applyLocale } from "../../src/store/locale";
import { fighter, wizard } from "../fixtures/characters";
import { storeCharacter } from "../fixtures/player-actions";
import { installTestEngine, renderApp, resetStores } from "../helpers/app";

const engine = installTestEngine();
const realAssess = engine.assessItems;
/** While set, every assessment waits for it (a slow worker). */
let gate: Promise<void> | null = null;
let open: () => void = () => {};
function holdAssessments() {
  gate = new Promise<void>((resolve) => {
    open = () => {
      gate = null;
      resolve();
    };
  });
}
engine.assessItems = async (...args) => {
  if (gate) await gate;
  return realAssess(...args);
};

// jsdom has no layout: the virtualizer reads offsetHeight/offsetWidth, so give the list's scroll
// box a screenful and each row (`data-index`) a row's height; the real VirtualList then renders
// the first rows of each list, as a browser would.
const box = (size: number, row: number) =>
  function (this: HTMLElement) {
    if (this.classList.contains("overflow-y-auto")) return size;
    return this.hasAttribute("data-index") ? row : 0;
  };
const offsets = {
  offsetHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight"),
  offsetWidth: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth"),
};
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get: box(900, 56),
  });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get: box(800, 800),
  });
});
afterAll(() => {
  for (const [name, d] of Object.entries(offsets))
    if (d) Object.defineProperty(HTMLElement.prototype, name, d);
});
beforeEach(async () => {
  await resetStores();
});
afterEach(() => {
  open();
  cleanup();
});

const coins = (gp: number): CharacterState["currency"] => ({ cp: 0, sp: 0, ep: 0, gp, pp: 0 });
const record = (id: string) => useDocuments.getState().characters[id];

async function character(kind: "wizard" | "fighter", gp?: number): Promise<string> {
  const build = kind === "wizard" ? await wizard(engine, 1) : await fighter(engine, 3);
  const state = await engine.createState(build);
  return storeCharacter(
    engine,
    build,
    undefined,
    gp === undefined ? state : { ...state, currency: coins(gp) },
  );
}

async function openDialog(id: string) {
  await renderApp(`/characters/${id}/sheet?tab=inventory`);
  await userEvent.click(
    await screen.findByRole("button", { name: "Add an item" }, { timeout: 10_000 }),
  );
  return screen.findByRole("dialog");
}
const list = (dialog: HTMLElement) => within(dialog).findByRole("list", { name: "Add an item" });
const rowOf = (dialog: HTMLElement, key: string) => within(dialog).queryByTestId(`item-row-${key}`);
const press = (dialog: HTMLElement, name: string | RegExp) =>
  userEvent.click(within(dialog).getByRole("button", { name }));
/** A marker filter's mode (kenli F-013 T06): its labelled select, by its value. */
const mode = (
  dialog: HTMLElement,
  name: "Magic" | "Proficiency",
  value: "ignore" | "require" | "exclude",
) => userEvent.selectOptions(within(dialog).getByRole("combobox", { name }), value);
const search = async (dialog: HTMLElement, text: string) => {
  const box = within(dialog).getByRole("searchbox", { name: "Search items" });
  await userEvent.clear(box);
  if (text) await userEvent.type(box, text);
};
/** The row once it's rendered (throws while it isn't, so `waitFor` retries). */
const shown = (dialog: HTMLElement, key: string) =>
  waitFor(() => {
    const r = rowOf(dialog, key);
    if (!r) throw new Error(`no row ${key}`);
    return r;
  });

describe("Add item: kinds and filters", () => {
  it("finds every kind without typing; magic shields under Shields; staffs by their base", async () => {
    const dialog = await openDialog(await character("wizard"));
    await list(dialog);
    await press(dialog, "Shields");
    await waitFor(() => expect(rowOf(dialog, "armor:shield")).not.toBeNull());
    expect(rowOf(dialog, "magic_items:shield-1")).not.toBeNull();
    expect(rowOf(dialog, "weapons:dagger")).toBeNull();
    expect(within(dialog).getByRole("button", { name: "Shields" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    // Magic narrows within the kind (AND): only magic shields.
    await mode(dialog, "Magic", "require");
    await waitFor(() => expect(rowOf(dialog, "armor:shield")).toBeNull());
    expect(rowOf(dialog, "magic_items:shield-1")).not.toBeNull();
    await mode(dialog, "Magic", "ignore");
    for (const [kind, key] of [
      ["Weapons", "weapons:club"],
      ["Armor", "armor:breastplate"],
      ["Tools", "tools:alchemists-supplies"],
      ["Gear", "gear:acid"],
    ] as const) {
      await press(dialog, kind);
      await waitFor(() => expect(rowOf(dialog, key)).not.toBeNull());
    }
    // A staff made from a Quarterstaff is a weapon; one with no base is gear.
    const search = within(dialog).getByRole("searchbox", { name: "Search items" });
    await userEvent.type(search, "staff of");
    await press(dialog, "Weapons");
    await waitFor(() => expect(rowOf(dialog, "magic_items:staff-of-power")).not.toBeNull());
    expect(rowOf(dialog, "magic_items:staff-of-healing")).toBeNull();
    await press(dialog, "Gear");
    await waitFor(() => expect(rowOf(dialog, "magic_items:staff-of-healing")).not.toBeNull());
    // No result: said, with what to do.
    await userEvent.type(search, "zzz");
    expect(await within(dialog).findByText(/No items match/)).toBeInTheDocument();
    // Recommendations: none exist for this character, so the filter is off and says why.
    const recommended = within(dialog).getByRole("button", { name: /Recommended/ });
    expect(recommended).toBeDisabled();
    expect(recommended).toHaveAccessibleDescription(/No equipment recommendations/);
  });

  it("statuses as words and icons; restrictions together; mastery apart; details by keyboard", async () => {
    const dialog = await openDialog(await character("wizard"));
    await list(dialog);
    await press(dialog, "Armor");
    const chain = await waitFor(() => {
      const r = rowOf(dialog, "armor:chain-mail");
      if (!r) throw new Error("no Chain Mail yet");
      return r;
    });
    expect(within(chain).getByText("Not trained")).toBeInTheDocument();
    expect(within(chain).getByText("3 restrictions")).toBeInTheDocument();
    // Keyboard: focus the row and press Enter; the details are text, no hover.
    chain.focus();
    await userEvent.keyboard("{Enter}");
    const details = await within(dialog).findByTestId("item-details");
    expect(details).toHaveTextContent(/Disadvantage on D20 Tests that use Strength or Dexterity/);
    expect(details).toHaveTextContent(/your Speed drops by 10 feet/);
    expect(details).toHaveTextContent(/Disadvantage on Dexterity \(Stealth\) checks/);
    expect(details).toHaveTextContent("75 GP");
    await press(dialog, "Shields");
    await userEvent.click(await shown(dialog, "armor:shield"));
    expect(await within(dialog).findByTestId("item-details")).toHaveTextContent(
      "Holding Shield without Shield training: it gives you no Armor Class",
    );
  });

  it("the Fighter: Proficient and Mastery are separate signs", async () => {
    const id = await character("fighter");
    const { build, state } = record(id) ?? {};
    if (!build || !state) throw new Error("no fighter");
    const weapons = (await engine.entries("weapons")) as { id: string }[];
    const { items } = await engine.assessItems(
      build,
      state,
      weapons.map((w) => ({ table: "weapons" as const, item: w.id })),
    );
    const mastered = items.find((a) => a.mastery.status === "yes");
    const plain = items.find((a) => a.mastery.status === "no" && a.proficiency.status === "yes");
    if (!mastered || !plain) throw new Error("fixture changed: need one weapon of each");
    const dialog = await openDialog(id);
    await list(dialog);
    await press(dialog, "Weapons");
    const m = (await waitFor(() => rowOf(dialog, mastered.key))) as HTMLElement;
    expect(within(m).getByText("Proficient")).toBeInTheDocument();
    expect(within(m).getByText(`Mastery: ${mastered.mastery.name}`)).toBeInTheDocument();
    const p = rowOf(dialog, plain.key) as HTMLElement;
    expect(within(p).getByText("Proficient")).toBeInTheDocument();
    expect(within(p).queryByText(/^Mastery:/)).toBeNull();
  });

  it("budget from the engine's price: the Lute at 35 GP passes; unpriced items never do", async () => {
    const dialog = await openDialog(await character("wizard", 35));
    await list(dialog);
    await search(dialog, "lute");
    await press(dialog, "Within my coins");
    const lute = await shown(dialog, "tools:lute");
    expect(within(lute).getByText("35 GP")).toBeInTheDocument();
    await search(dialog, "shield, +1");
    expect(await within(dialog).findByText(/No items match/)).toBeInTheDocument();
    // Off again: the magic shield is there, with no listed price (not 0).
    await press(dialog, "Within my coins");
    const shield = await shown(dialog, "magic_items:shield-1");
    expect(within(shield).getByText("No listed price")).toBeInTheDocument();
  });

  it("budget: at 34 GP the Lute (35 GP) doesn't pass", async () => {
    const dialog = await openDialog(await character("wizard", 34));
    await list(dialog);
    await search(dialog, "lute");
    await shown(dialog, "tools:lute");
    await press(dialog, "Within my coins");
    // "lute" also finds the Flute (2 GP), which passes; the Lute doesn't.
    await shown(dialog, "tools:flute");
    expect(rowOf(dialog, "tools:lute")).toBeNull();
  });

  it("a template: proficient filter keeps it and offers the fitting bases; a base decides", async () => {
    const dialog = await openDialog(await character("wizard"));
    await list(dialog);
    await press(dialog, "Weapons");
    await mode(dialog, "Proficiency", "require");
    await mode(dialog, "Magic", "require");
    await search(dialog, "weapon, +1");
    const row = await shown(dialog, "magic_items:weapon-1");
    expect(within(row).getByText("Some bases suit you")).toBeInTheDocument();
    await userEvent.click(row);
    const details = await within(dialog).findByTestId("item-details");
    expect(details).toHaveTextContent("Some bases suit you");
    const select = within(dialog).getByRole("combobox", { name: /Made from/ });
    const options = within(select)
      .getAllByRole("option")
      .map((o) => o.textContent);
    expect(options).toContain("Dagger — proficient");
    expect(options).not.toContain("Longsword");
    expect(
      within(dialog).getByText(/Showing only what you're proficient with/),
    ).toBeInTheDocument();
    await userEvent.selectOptions(select, "dagger");
    await waitFor(() =>
      expect(within(dialog).getByTestId("item-details")).toHaveTextContent(
        /Proficient with Dagger, \+1/,
      ),
    );
    // The filter off: every base, and a base without proficiency says so.
    await mode(dialog, "Proficiency", "ignore");
    await userEvent.selectOptions(
      within(dialog).getByRole("combobox", { name: /Made from/ }),
      "longsword",
    );
    await waitFor(() =>
      expect(within(dialog).getByTestId("item-details")).toHaveTextContent(
        "Not proficient with Longsword, +1",
      ),
    );
  });

  it("in Italian: the kinds and the engine's words", async () => {
    const id = await character("wizard");
    await applyLocale("it");
    await renderApp(`/characters/${id}/sheet?tab=inventory`);
    await userEvent.click(
      await screen.findByRole("button", { name: "Aggiungi un oggetto" }, { timeout: 10_000 }),
    );
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByRole("list", { name: "Aggiungi un oggetto" });
    await press(dialog, "Scudi");
    await userEvent.click(await shown(dialog, "armor:shield"));
    expect(await within(dialog).findByTestId("item-details")).toHaveTextContent(
      "non ti dà Classe Armatura",
    );
    await applyLocale("en");
  });
});

describe("Add item: never a stale answer", () => {
  it("a new revision: the list waits for the new answer instead of showing the old one", async () => {
    const id = await character("wizard", 34);
    const dialog = await openDialog(id);
    await list(dialog);
    await search(dialog, "lute");
    await press(dialog, "Within my coins");
    await shown(dialog, "tools:flute");
    expect(rowOf(dialog, "tools:lute")).toBeNull();
    holdAssessments();
    await act(async () => {
      await useDocuments.getState().playAction(id, { type: "adjust_currency", changes: { gp: 1 } });
    });
    expect(
      await within(dialog).findByText("Checking the items for this character…"),
    ).toBeInTheDocument();
    // The answer for 34 GP isn't shown as the current one.
    expect(rowOf(dialog, "tools:flute")).toBeNull();
    open();
    await shown(dialog, "tools:lute");
  });

  it("another base: the details wait instead of keeping the previous base's status", async () => {
    const dialog = await openDialog(await character("wizard"));
    await list(dialog);
    await press(dialog, "Weapons");
    await mode(dialog, "Magic", "require");
    await search(dialog, "weapon, +1");
    await userEvent.click(await shown(dialog, "magic_items:weapon-1"));
    const select = within(dialog).getByRole("combobox", { name: /Made from/ });
    await userEvent.selectOptions(select, "dagger");
    await waitFor(() =>
      expect(within(dialog).getByTestId("item-details")).toHaveTextContent(
        /Proficient with Dagger/,
      ),
    );
    holdAssessments();
    await userEvent.selectOptions(select, "longsword");
    await waitFor(() => expect(within(dialog).queryByTestId("item-details")).toBeNull());
    expect(
      within(dialog).getAllByText("Checking the items for this character…").length,
    ).toBeGreaterThan(0);
    open();
    await waitFor(() =>
      expect(within(dialog).getByTestId("item-details")).toHaveTextContent(
        /Not proficient with Longsword/,
      ),
    );
  });

  it("another character: the hook has no answer until that character's arrives", async () => {
    const a = await character("fighter", 100);
    const b = await character("wizard", 0);
    const client = createQueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const requests = [{ table: "tools" as const, item: "lute" }];
    const { result, rerender } = renderHook(({ id }) => useItemAssessments(id, requests), {
      wrapper,
      initialProps: { id: a },
    });
    await waitFor(() => expect(result.current.data?.purse_cp).toBe(10_000));
    holdAssessments();
    rerender({ id: b });
    expect(result.current.data).toBeUndefined();
    expect(result.current.isPending).toBe(true);
    open();
    await waitFor(() => expect(result.current.data?.purse_cp).toBe(0));
  });
});

describe("Add item: Buy and Add unchanged", () => {
  it("Add puts the item in without coins; Buy takes the listed price once", async () => {
    const id = await character("wizard", 35);
    let dialog = await openDialog(id);
    await list(dialog);
    await press(dialog, "Gear");
    await search(dialog, "rope");
    await userEvent.click(await shown(dialog, "gear:rope"));
    await press(dialog, "Add");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(record(id)?.state.inventory.some((i) => i.item === "rope")).toBe(true);
    expect(record(id)?.state.currency).toEqual(coins(35));
    await userEvent.click(screen.getByRole("button", { name: "Add an item" }));
    dialog = await screen.findByRole("dialog");
    await list(dialog);
    await press(dialog, "Tools");
    await search(dialog, "lute");
    await userEvent.click(await shown(dialog, "tools:lute"));
    await press(dialog, "Buy");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(record(id)?.state.currency).toEqual(coins(0));
    expect(record(id)?.state.inventory.filter((i) => i.item === "lute")).toHaveLength(1);
  });
});
