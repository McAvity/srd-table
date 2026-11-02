// kenli F-013 T06 (decision 07): Magic and Proficiency each required, excluded or ignored, on the
// real engine (in-process facade, real SRD). Explicit labelled selects; neutral and unknown items
// keep their labels; both proficiency modes wait for (and report a failed) assessment; only
// "require" narrows a template's bases and a hidden base is never kept; filtering changes nothing.
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { CharacterState } from "srd-rules-engine";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { useDocuments } from "../../src/store/documents";
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

const rows = (dialog: HTMLElement) =>
  within(dialog)
    .queryAllByTestId(/^item-row-/)
    .map((e) => e.getAttribute("data-testid")?.slice(9));
const details = (dialog: HTMLElement) => within(dialog).getByTestId("item-details");
const pickBase = (dialog: HTMLElement, base: string) =>
  userEvent.selectOptions(within(dialog).getByRole("combobox", { name: /Made from/ }), base);
const baseOptions = (dialog: HTMLElement) =>
  within(within(dialog).getByRole("combobox", { name: /Made from/ }))
    .getAllByRole("option")
    .map((o) => o.textContent);

describe("T06: three-mode Magic and Proficiency", () => {
  it("two labelled selects, each value in words, both Any (ignore) by default", async () => {
    const dialog = await openDialog(await character("wizard"));
    await list(dialog);
    for (const [name, words] of [
      ["Magic", ["Any (ignore)", "Only magic items", "No magic items"]],
      [
        "Proficiency",
        ["Any (ignore)", "Only proficient or trained", "Not marked proficient or trained"],
      ],
    ] as const) {
      const select = within(dialog).getByRole("combobox", { name }) as HTMLSelectElement;
      expect(select.value).toBe("ignore");
      expect(
        within(select)
          .getAllByRole("option")
          .map((o) => o.textContent),
      ).toEqual(words);
    }
    // The old toggle buttons are gone (no pressed state carries a mode).
    expect(within(dialog).queryByRole("button", { name: "Magic" })).toBeNull();
  });

  it("Magic: require, exclude and ignore within Shields", async () => {
    const dialog = await openDialog(await character("wizard"));
    await list(dialog);
    await press(dialog, "Shields");
    await shown(dialog, "armor:shield");
    await mode(dialog, "Magic", "exclude");
    await waitFor(() => expect(rows(dialog)).toContain("armor:shield"));
    expect(rows(dialog).some((k) => k?.startsWith("magic_items:"))).toBe(false);
    await mode(dialog, "Magic", "require");
    await waitFor(() => expect(rows(dialog)).not.toContain("armor:shield"));
    expect(rows(dialog).every((k) => k?.startsWith("magic_items:"))).toBe(true);
    await mode(dialog, "Magic", "ignore");
    await waitFor(() => expect(rows(dialog)).toContain("armor:shield"));
    expect(rows(dialog)).toContain("magic_items:animated-shield");
  });

  it("Proficiency: exclude keeps neutral gear with its own label; require and ignore", async () => {
    const dialog = await openDialog(await character("wizard"));
    await list(dialog);
    await press(dialog, "Weapons");
    await search(dialog, "rapier");
    await shown(dialog, "weapons:rapier");
    await mode(dialog, "Proficiency", "require");
    expect(await within(dialog).findByText(/No items match/)).toBeInTheDocument();
    await mode(dialog, "Proficiency", "exclude");
    expect(
      within(await shown(dialog, "weapons:rapier")).getByText("Not proficient"),
    ).toBeInTheDocument();
    expect(within(dialog).getByText(/includes gear that needs no proficiency/)).toBeInTheDocument();
    await search(dialog, "dagger");
    expect(await within(dialog).findByText(/No items match/)).toBeInTheDocument();
    await mode(dialog, "Proficiency", "require");
    await shown(dialog, "weapons:dagger");
    // Neutral gear: excluded from "require", kept by "exclude" as "No proficiency needed".
    await press(dialog, "Gear");
    await search(dialog, "rope");
    expect(await within(dialog).findByText(/No items match/)).toBeInTheDocument();
    await mode(dialog, "Proficiency", "exclude");
    const rope = await shown(dialog, "gear:rope");
    expect(within(rope).getByText("No proficiency needed")).toBeInTheDocument();
    expect(within(rope).queryByText("Not proficient")).toBeNull();
    await mode(dialog, "Proficiency", "ignore");
    await shown(dialog, "gear:rope");
  });

  it("combined: only magic, not proficient, Weapons, a name", async () => {
    const dialog = await openDialog(await character("wizard"));
    await list(dialog);
    await press(dialog, "Weapons");
    await mode(dialog, "Magic", "require");
    await mode(dialog, "Proficiency", "exclude");
    await search(dialog, "dwarven");
    const thrower = await shown(dialog, "magic_items:dwarven-thrower");
    expect(within(thrower).getByText("Not proficient")).toBeInTheDocument();
    // Weapon, +1 has a base the Wizard is proficient with: it carries the marker, so it's out.
    await search(dialog, "weapon, +1");
    expect(await within(dialog).findByText(/No items match/)).toBeInTheDocument();
    await mode(dialog, "Proficiency", "require");
    await shown(dialog, "magic_items:weapon-1");
  });

  it("a failed assessment: both proficiency modes say so with Try again, never a list", async () => {
    // Assessment failing: both modes say so with Try again, never a list.
    engine.assessItems = async () => {
      throw new Error("worker crashed");
    };
    try {
      const fresh = await openDialog(await character("wizard"));
      await list(fresh);
      for (const value of ["require", "exclude"] as const) {
        await mode(fresh, "Proficiency", value);
        expect(
          await within(fresh).findByText(/Couldn't check how the items suit this character/),
        ).toBeInTheDocument();
        expect(within(fresh).queryByRole("list", { name: "Add an item" })).toBeNull();
      }
    } finally {
      engine.assessItems = async (...args) => {
        if (gate) await gate;
        return realAssess(...args);
      };
    }
  });

  for (const value of ["require", "exclude"] as const) {
    it(`while the answer is pending, ${value} shows Checking, not the unfiltered list`, async () => {
      holdAssessments();
      const dialog = await openDialog(await character("wizard"));
      await list(dialog); // All, nothing that needs the answer: the catalog is listed
      await mode(dialog, "Proficiency", value);
      expect(
        within(dialog).getByText("Checking the items for this character…"),
      ).toBeInTheDocument();
      expect(within(dialog).queryByRole("list", { name: "Add an item" })).toBeNull();
      open();
      await list(dialog);
      expect(within(dialog).queryByText("Checking the items for this character…")).toBeNull();
    });
  }

  it("bases: only require narrows them; a base require hides isn't kept", async () => {
    const dialog = await openDialog(await character("wizard"));
    await list(dialog);
    await press(dialog, "Weapons");
    await mode(dialog, "Magic", "require");
    await search(dialog, "weapon, +1");
    await userEvent.click(await shown(dialog, "magic_items:weapon-1"));
    await mode(dialog, "Proficiency", "require");
    expect(baseOptions(dialog)).toContain("Dagger — proficient");
    expect(baseOptions(dialog)).not.toContain("Longsword");
    await pickBase(dialog, "dagger");
    await waitFor(() => expect(details(dialog)).toHaveTextContent("Proficient with Dagger, +1"));
    // Exclude: every legal base again (the picked item stays open), Dagger still the choice.
    await mode(dialog, "Proficiency", "exclude");
    expect(baseOptions(dialog)).toContain("Longsword");
    expect(within(dialog).queryByText(/Showing only what you're proficient with/)).toBeNull();
    expect(
      (within(dialog).getByRole("combobox", { name: /Made from/ }) as HTMLSelectElement).value,
    ).toBe("dagger");
    await pickBase(dialog, "longsword");
    await waitFor(() =>
      expect(details(dialog)).toHaveTextContent("Not proficient with Longsword, +1"),
    );
    // Back to require: Longsword is hidden, so it's no longer the choice, assessed or sent.
    await mode(dialog, "Proficiency", "require");
    const select = within(dialog).getByRole("combobox", { name: /Made from/ }) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe(""));
    await waitFor(() => expect(details(dialog)).not.toHaveTextContent(/Longsword/));
    await mode(dialog, "Proficiency", "ignore");
    expect(baseOptions(dialog)).toContain("Longsword");
    expect(select.value).toBe("");
  });

  it("filtering changes nothing: the character's documents stay the same", async () => {
    const id = await character("wizard", 35);
    const before = record(id);
    const dialog = await openDialog(id);
    await list(dialog);
    for (const magic of ["require", "exclude", "ignore"] as const)
      for (const proficient of ["require", "exclude", "ignore"] as const) {
        await mode(dialog, "Magic", magic);
        await mode(dialog, "Proficiency", proficient);
      }
    await press(dialog, "Within my coins");
    await press(dialog, "Tools");
    await shown(dialog, "tools:flute");
    expect(record(id)).toBe(before);
    expect(record(id)?.state.currency).toEqual(coins(35));
    expect(useDocuments.getState().revs[id] ?? 0).toBe(0);
  });
});
