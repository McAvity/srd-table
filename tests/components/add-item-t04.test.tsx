// kenli F-013 T04: regressions for review03 R03-01–03 on the real engine (in-process facade, real
// SRD; a synthetic `source: test` pack for R03-01): an incomplete magic weapon is "Can't tell" in
// Weapons, a base hidden by the proficiency filter is neither assessed nor sent, and a failed
// catalog load is said (with Try again), never an endless spinner or a seemingly complete list.
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { CharacterState } from "srd-rules-engine";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PackFiles } from "../../src/lib/canonical";
import { useDocuments } from "../../src/store/documents";
import { fighter, wizard } from "../fixtures/characters";
import { storeCharacter } from "../fixtures/player-actions";
import { installTestEngine, renderApp, resetStores } from "../helpers/app";

const engine = installTestEngine();
const realAssess = engine.assessItems;
const realEntries = engine.entries;
/** Tables whose loading fails (a broken network or pack), until removed. */
const failing = new Set<string>();
engine.entries = async (table, ctx) => {
  if (failing.has(table)) throw new Error(`fetch failed: ${table}.json`);
  return realEntries(table, ctx);
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
  failing.clear();
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

const INCOMPLETE_PACK: PackFiles = {
  "manifest.json": {
    name: "test-f013-t04",
    manifest: { id: "test-f013-t04", version: "1.0.0", source: "test", requires: ["srd-5.2.1"] },
    tables: { magic_items: { file: "magic_items.json", count: 1 } },
  },
  "magic_items.json": [
    {
      id: "test-incomplete-weapon",
      name: "Test Incomplete Weapon",
      category: "weapon",
      rarity: "common",
    },
  ],
};

describe("R03-01: an incomplete magic weapon", () => {
  it("is listed under Weapons as Can't tell, with the reason to judge it by hand", async () => {
    const [ref] = await engine.registerPacks([INCOMPLETE_PACK]);
    const srd = await engine.servedPack("srd-5.2.1");
    if (!ref) throw new Error("pack not registered");
    const content = { packs: [srd, ref], sources: null };
    const build = await wizard(engine, 1);
    const id = await storeCharacter(
      engine,
      build,
      content,
      await engine.createState(build, content),
    );
    const dialog = await openDialog(id);
    await list(dialog);
    await press(dialog, "Weapons");
    await search(dialog, "test incomplete");
    const row = await shown(dialog, "magic_items:test-incomplete-weapon");
    expect(within(row).getByText("Can't tell")).toBeInTheDocument();
    await userEvent.click(row);
    const details = await within(dialog).findByTestId("item-details");
    expect(details).toHaveTextContent(/doesn't say which weapon it is made from/);
    expect(details).toHaveTextContent("The table judges this");
  });
});

describe("R03-02: a base hidden by the proficiency filter", () => {
  it("is neither assessed nor sent: the visible choice is what's assessed and added", async () => {
    const id = await character("wizard");
    const dialog = await openDialog(id);
    await list(dialog);
    await press(dialog, "Weapons");
    await press(dialog, "Magic");
    await search(dialog, "weapon, +1");
    await userEvent.click(await shown(dialog, "magic_items:weapon-1"));
    await userEvent.selectOptions(
      within(dialog).getByRole("combobox", { name: /Made from/ }),
      "longsword",
    );
    await waitFor(() =>
      expect(within(dialog).getByTestId("item-details")).toHaveTextContent(
        "Not proficient with Longsword, +1",
      ),
    );
    // Proficiency filter on: Longsword (not proficient) leaves the list of bases…
    await press(dialog, "I'm proficient or trained");
    const select = within(dialog).getByRole("combobox", { name: /Made from/ }) as HTMLSelectElement;
    expect(within(select).queryByRole("option", { name: "Longsword" })).toBeNull();
    // …so it isn't the choice any more: not shown, not assessed, not added.
    expect(select.value).toBe("");
    await waitFor(() =>
      expect(within(dialog).getByTestId("item-details")).not.toHaveTextContent(/Longsword/),
    );
    await press(dialog, "Add");
    await waitFor(() => expect(within(dialog).getByRole("alert")).toBeInTheDocument());
    expect(record(id)?.state.inventory.some((i) => i.item === "weapon-1")).toBe(false);
  });
});

describe("R03-03: a catalog table that fails to load", () => {
  it("is said, with Try again, instead of an endless spinner or a partial list; then recovers", async () => {
    const id = await character("wizard");
    failing.add("tools");
    await renderApp(`/characters/${id}/sheet?tab=inventory`);
    await userEvent.click(
      await screen.findByRole("button", { name: "Add an item" }, { timeout: 10_000 }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(
      await within(dialog).findByText(/Couldn't load the item catalog/, {}, { timeout: 5_000 }),
    ).toBeInTheDocument();
    // Not a seemingly complete list without the tools.
    expect(within(dialog).queryByRole("list", { name: "Add an item" })).toBeNull();
    await press(dialog, "Tools");
    expect(within(dialog).queryByText("Checking the items for this character…")).toBeNull();
    expect(within(dialog).getByText(/Couldn't load the item catalog/)).toBeInTheDocument();
    failing.clear();
    await press(dialog, "Try again");
    await shown(dialog, "tools:alchemists-supplies");
    expect(within(dialog).queryByText(/Couldn't load the item catalog/)).toBeNull();
  });

  it("a failed assessment is said in plain words, with Try again", async () => {
    const id = await character("wizard");
    engine.assessItems = async () => {
      throw new Error("worker crashed");
    };
    try {
      const dialog = await openDialog(id);
      await press(dialog, "Tools");
      expect(
        await within(dialog).findByText(/Couldn't check how the items suit this character/),
      ).toBeInTheDocument();
      expect(within(dialog).queryByText(/worker crashed/)).toBeNull();
      expect(within(dialog).getByRole("button", { name: "Try again" })).toBeInTheDocument();
    } finally {
      engine.assessItems = realAssess;
    }
  });
});
