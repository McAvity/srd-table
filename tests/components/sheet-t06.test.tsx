/**
 * kenli F-011 T06 on the real sheet (jsdom, the in-process engine): Initiative only in Combat (the
 * same roll, no encounter); Bardic Inspiration's pool as the same crossed squares in its action and
 * in Limited Uses (spend, restore, Long Rest — once each); each use's (i), read by touch/click and
 * keyboard, with the character's own text or an honest "none", and for a luck-style use the way to
 * the existing roll option (focus only: nothing chosen or spent); Spells with ≥ 4 real sources — one
 * granted by a private pack — each its colour and label, stable; one description open in the whole
 * tab, opened from the name, separate from the cost selector (the same spell with two costs keeps
 * its choice); Features always shown; a custom item (name required, description, quantity, weight
 * known or unknown ≠ 0), carried/stored weight, no gold, history and Undo, replaced by a catalog one.
 */

import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { CharacterBuild } from "srd-rules-engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sourceLooks } from "../../src/features/sheet/SpellsTab";
import type { ContentContext, PackFiles } from "../../src/lib/canonical";
import { useDocuments } from "../../src/store/documents";
import { sessionEntries } from "../../src/store/history";
import { useRolls } from "../../src/store/rolls";
import { sorcererBard, wizard } from "../fixtures/characters";
import { humanWizard, storeCharacter, TEST_PACK, testContext } from "../fixtures/player-actions";
import { installTestEngine, renderApp, resetStores } from "../helpers/app";

const engine = installTestEngine(9);
const docs = () => useDocuments.getState();
beforeEach(async () => {
  await resetStores();
});
afterEach(() => cleanup());

/** A pack standing in for a private one: its own id and source, granting a cantrip via Sage. */
const PRIVATE_PACK: PackFiles = {
  "manifest.json": {
    name: "kenli-test-private",
    manifest: {
      id: "kenli-test-private",
      version: "0.1.0",
      source: "kenli-private",
      requires: ["srd-5.2.1"],
    },
    patches: [
      { target: "backgrounds/sage", op: "append", path: "grants.cantrips", value: "mage-hand" },
    ],
    tables: {},
  },
};
async function lirael(): Promise<string> {
  const [testRef, privateRef] = await engine.registerPacks([TEST_PACK, PRIVATE_PACK]);
  const srd = await engine.servedPack("srd-5.2.1");
  const ctx = { packs: [srd, testRef, privateRef], sources: null } as ContentContext;
  const built = await engine.editBuild(await wizard(engine, 3), { type: "name", name: "Lirael" });
  if (!built.ok) throw new Error("no build");
  return storeCharacter(engine, built.build as CharacterBuild, ctx);
}
async function open(id: string, tab: string) {
  await renderApp(`/characters/${id}/sheet`);
  await userEvent.click(await screen.findByRole("tab", { name: tab }, { timeout: 15_000 }));
}
const record = (id: string) => docs().characters[id];

describe("Combat: Initiative, one Bardic Inspiration pool, (i) on each use", () => {
  it("Initiative is rolled from Combat only: the same test, recorded once, no encounter made", async () => {
    const id = await storeCharacter(engine, await wizard(engine, 3));
    await renderApp(`/characters/${id}/sheet`);
    await screen.findByRole("tab", { name: "Overview" }, { timeout: 15_000 });
    expect(screen.queryByRole("button", { name: /^Init [+-]\d+: Roll$/ })).toBeNull();
    await userEvent.click(screen.getByRole("tab", { name: "Combat" }));
    const init = within(await screen.findByTestId("combat-initiative"));
    await userEvent.click(init.getByRole("button", { name: /^Init [+-]\d+: Roll$/ }));
    await waitFor(() => expect(useRolls.getState().last[id]?.kind).toBe("test"));
    const last = useRolls.getState().last[id];
    const sheet = (await engine.playSheet(record(id)?.build as never, record(id)?.state as never))
      .sheet;
    expect(last?.kind === "test" ? last.test.total - last.test.roll.d20 : null).toBe(
      sheet.initiative.total,
    );
    expect(sessionEntries(id).filter((e) => e.kind === "test")).toHaveLength(1);
    expect(Object.keys(docs().encounters)).toHaveLength(0);
  });

  it("Bardic Inspiration: the action shows the same squares as Limited Uses; spend, restore and a Long Rest change the one pool once", async () => {
    const id = await storeCharacter(engine, await sorcererBard(engine));
    await open(id, "Combat");
    const pool = () =>
      screen
        .getAllByRole("img", { name: /^Bardic Inspiration: \d+ of 3 left$/ })
        .map((x) => x.getAttribute("aria-label"));
    await waitFor(() =>
      expect(pool()).toEqual([
        "Bardic Inspiration: 3 of 3 left",
        "Bardic Inspiration: 3 of 3 left",
      ]),
    );
    expect(screen.queryByText(/^· 3 of 3 left$/)).toBeNull(); // no second, textual counter
    const row = screen
      .getByTestId("action-pool-bard:bardic-inspiration")
      .closest("li") as HTMLElement;
    await userEvent.click(within(row).getByRole("button", { name: "Use" }));
    await waitFor(() =>
      expect(pool()).toEqual([
        "Bardic Inspiration: 2 of 3 left",
        "Bardic Inspiration: 2 of 3 left",
      ]),
    );
    expect(record(id)?.state.uses_spent["bard:bardic-inspiration"]).toBe(1);
    await userEvent.click(screen.getByRole("button", { name: "Restore one: Bardic Inspiration" }));
    await waitFor(() =>
      expect(pool()).toEqual([
        "Bardic Inspiration: 3 of 3 left",
        "Bardic Inspiration: 3 of 3 left",
      ]),
    );
    await userEvent.click(within(row).getByRole("button", { name: "Use" }));
    await waitFor(() => expect(record(id)?.state.uses_spent["bard:bardic-inspiration"]).toBe(1));
    await act(async () => {
      expect((await docs().playAction(id, { type: "long_rest" })).ok).toBe(true);
    });
    await waitFor(() =>
      expect(pool()).toEqual([
        "Bardic Inspiration: 3 of 3 left",
        "Bardic Inspiration: 3 of 3 left",
      ]),
    );
    expect(record(id)?.state.uses_spent["bard:bardic-inspiration"] ?? 0).toBe(0);
  });

  it("(i): the character's own text (a trait, or the feat the use comes from) and recharge, by click and keyboard; reading changes nothing", async () => {
    const id = await storeCharacter(engine, await sorcererBard(engine));
    await open(id, "Combat");
    const before = record(id);
    const entries = sessionEntries(id).length;
    const bi = await screen.findByRole("button", { name: "About Bardic Inspiration" });
    await userEvent.click(bi);
    expect(bi).toHaveAttribute("aria-expanded", "true");
    const info = screen.getByTestId("use-info");
    expect(info.textContent).toMatch(/From: /);
    expect(info.textContent).toMatch(/3 uses\. All come back on a Long Rest\./);
    // Keyboard: the same button with Enter closes it; another opens its own.
    bi.focus();
    await userEvent.keyboard("{Enter}");
    expect(screen.queryByTestId("use-info")).toBeNull();
    const mi = screen.getByRole("button", { name: "About Magic Initiate (free level 1 spell)" });
    mi.focus();
    await userEvent.keyboard(" ");
    // Magic Initiate's free cast: the feat's own text (its key names the feat), not a guess.
    await waitFor(() =>
      expect(screen.getByTestId("use-info").textContent).toMatch(/From: Magic Initiate/),
    );
    expect(record(id)).toBe(before); // nothing spent or changed
    expect(sessionEntries(id)).toHaveLength(entries);
  });

  it("Lucky (a luck-style use): how to apply it, and the way to the existing roll option — focus only, nothing chosen or spent", async () => {
    const id = await storeCharacter(engine, await humanWizard(engine), await testContext(engine));
    await open(id, "Combat");
    const before = record(id);
    await userEvent.click(await screen.findByRole("button", { name: "About Test Luck" }));
    const info = screen.getByTestId("use-info");
    expect(info.textContent).toMatch(/Advantage declared with/);
    // The test pack gives this use no text: said, not made up.
    expect(info.textContent).toMatch(/This character's packs give no description for this use/);
    expect(info.textContent).toMatch(/impose Disadvantage/);
    await userEvent.click(
      within(info).getByRole("button", { name: /Go to “Advantage declared with”/ }),
    );
    const select = document.activeElement as HTMLSelectElement;
    expect(select.tagName).toBe("SELECT");
    expect(select.id).toBe(`rollopts-lucky-${id}`);
    expect(select.value).toBe("");
    expect(within(select).getByRole("option", { name: /Test Luck/ })).toBeInTheDocument();
    expect(record(id)).toBe(before);
  });
});

describe("Spells: sources, one description at a time, controls apart", () => {
  it("≥ 4 real sources (one from a private pack), each its colour and label, the same in every group and render", async () => {
    const id = await lirael();
    await open(id, "Spells");
    await screen.findAllByTestId("spell-line", {}, { timeout: 15_000 });
    const chips = () =>
      screen.getAllByTestId("spell-source").map((c) => [c.textContent, c.dataset.look] as const);
    const seen = new Map<string, string>();
    for (const [name, look] of chips()) {
      if (seen.has(name as string)) expect(look).toBe(seen.get(name as string));
      seen.set(name as string, look as string);
    }
    expect([...seen.keys()]).toEqual(
      expect.arrayContaining([
        "Wizard",
        // R03-09: a feat's source names what granted it (two Magic Initiates stay apart).
        "Magic Initiate · Sage",
        "Drow (Elf)",
        "Sage",
      ]),
    );
    expect(new Set(seen.values()).size).toBe(seen.size); // distinct sources, distinct looks
    // Another render (tab away and back): the same looks.
    const first = chips();
    await userEvent.click(screen.getByRole("tab", { name: "Combat" }));
    await userEvent.click(screen.getByRole("tab", { name: "Spells" }));
    await waitFor(() => expect(chips()).toEqual(first));
  });

  it("past the palette a source keeps a distinct look (edge style) and always its label", () => {
    const sources = Array.from({ length: 8 }, (_, i) => `Source ${i}`);
    const looks = sourceLooks({
      spellcasting: [],
      spells: sources.map((source, i) => ({ id: `s${i}`, source }) as never),
    });
    const all = sources.map((s) => looks.get(s));
    expect(new Set(all.map((l) => `${l?.edge}|${l?.chip}`)).size).toBe(8);
    expect(all[6]?.edge).toMatch(/dashed/);
  });

  it("one description in the whole tab, from the name (click, Enter, Space); the cost choice is apart, kept, and costs nothing", async () => {
    const id = await lirael();
    await open(id, "Spells");
    const lines = await screen.findAllByTestId("spell-line", {}, { timeout: 15_000 });
    const before = record(id);
    const entries = sessionEntries(id).length;
    const name = (line: HTMLElement) =>
      within(line)
        .getAllByRole("button")
        .find((b) => b.hasAttribute("aria-expanded")) as HTMLElement;
    const expanded = () =>
      screen
        .getAllByTestId("spell-line")
        .filter((l) => name(l).getAttribute("aria-expanded") === "true");
    const a = lines[0] as HTMLElement;
    const b = lines.at(-1) as HTMLElement; // another level group
    await userEvent.click(name(a));
    expect(expanded()).toEqual([a]);
    await userEvent.click(name(b));
    expect(expanded()).toEqual([b]);
    name(a).focus();
    await userEvent.keyboard("{Enter}");
    expect(expanded()).toEqual([a]);
    await userEvent.keyboard(" ");
    expect(expanded()).toEqual([]);
    // The same spell with two costs (Magic Initiate: its slot or its free use): the choice stays.
    const mi = lines.find((l) =>
      within(l)
        .queryAllByRole("option")
        .some((o) => /free/i.test(o.textContent ?? "")),
    ) as HTMLElement;
    expect(mi).toBeDefined();
    const cost = within(mi).getAllByRole("combobox").at(-1) as HTMLSelectElement;
    const free = [...cost.options].find((o) => /free/i.test(o.text)) as HTMLOptionElement;
    expect([...cost.options].some((o) => /Level \d/.test(o.text))).toBe(true);
    fireEvent.change(cost, { target: { value: free.value } });
    expect(cost.value).toBe(free.value);
    await userEvent.click(name(mi));
    expect(expanded()).toEqual([mi]);
    expect(cost.value).toBe(free.value);
    // Controls beside the name, the metadata on its own row.
    const header = name(mi).parentElement?.parentElement as HTMLElement;
    expect(header.contains(within(mi).getByTestId("spell-controls"))).toBe(true);
    expect(header.contains(within(mi).getByTestId("spell-meta"))).toBe(false);
    expect(record(id)).toBe(before);
    expect(sessionEntries(id)).toHaveLength(entries);
  });
});

describe("Features: always shown", () => {
  it("every description visible, nothing to fold", async () => {
    const id = await lirael();
    await open(id, "Features");
    const blocks = await screen.findAllByTestId("feature-block", {}, { timeout: 15_000 });
    expect(blocks.length).toBeGreaterThan(3);
    const panel = screen.getByRole("tabpanel");
    expect(panel.querySelector("details, summary")).toBeNull();
    for (const block of blocks) {
      expect(within(block).queryByRole("button")).toBeNull();
      expect(block.querySelector("[aria-expanded]")).toBeNull();
      expect((block.textContent ?? "").length).toBeGreaterThan(20);
    }
  });
});

describe("Inventory: a custom item", () => {
  it("name required; unknown weight isn't 0; carried and stored weight; no gold; history and Undo; replaced by a catalog item", async () => {
    const id = await storeCharacter(engine, await wizard(engine, 3));
    await open(id, "Inventory");
    const gold = record(id)?.state.currency;
    const weightLine = () => screen.getByText(/^Carried /).closest("p") as HTMLElement;
    const carried = () =>
      Number(/Carried ([\d.,]+)/.exec(weightLine().textContent ?? "")?.[1]?.replace(",", ""));
    const base = carried();
    const add = async (fill: {
      name: string;
      description?: string;
      qty?: string;
      weight?: string;
    }) => {
      await userEvent.click(screen.getByRole("button", { name: "Add a custom item" }));
      const form = within(await screen.findByTestId("custom-item-form"));
      const dialog = screen.getByRole("dialog");
      const confirm = within(dialog).getByRole("button", { name: "Add it" });
      expect(confirm).toBeDisabled(); // a name is required
      await userEvent.type(form.getByRole("textbox", { name: "Name" }), fill.name);
      if (fill.description)
        await userEvent.type(form.getByRole("textbox", { name: /Description/ }), fill.description);
      if (fill.qty) {
        const q = form.getByRole("textbox", { name: "Quantity" });
        await userEvent.clear(q);
        await userEvent.type(q, fill.qty);
      }
      if (fill.weight !== undefined) {
        await userEvent.click(form.getByRole("radio", { name: /Known/ }));
        await userEvent.type(form.getByRole("textbox", { name: "Weight in pounds" }), fill.weight);
      }
      expect(confirm).toBeEnabled();
      await userEvent.click(confirm);
      await waitFor(() => expect(screen.queryByTestId("custom-item-form")).toBeNull());
    };
    const entries = sessionEntries(id).length;
    await add({ name: "Sealed letter", description: "For the abbess.", qty: "2" });
    const item = (await screen.findByText("Sealed letter")).closest("li") as HTMLElement;
    expect(item.textContent).toMatch(/×2/);
    expect(within(item).getByTestId("custom-description")).toHaveTextContent("For the abbess.");
    expect(item.textContent).toMatch(/weight unknown/);
    expect(screen.getByTestId("weight-incomplete")).toHaveTextContent(
      /incomplete: unknown weight for 1 carried item\(s\)/,
    );
    expect(carried()).toBe(base); // unknown is not 0 and not counted
    expect(within(item).queryByRole("button", { name: /Equip|Sell/ })).toBeNull();
    expect(sessionEntries(id).length).toBe(entries + 1);
    // Undo: gone, with its incomplete note.
    await act(async () => {
      await docs().undo(id);
    });
    await waitFor(() => expect(screen.queryByText("Sealed letter")).toBeNull());
    expect(screen.queryByTestId("weight-incomplete")).toBeNull();
    // Known weight (0.5 lb × 2): counted while carried, not when stored.
    await add({ name: "Idol", qty: "2", weight: "0.5" });
    await waitFor(() => expect(carried()).toBeCloseTo(base + 1));
    const idol = (await screen.findByText("Idol")).closest("li") as HTMLElement;
    await userEvent.click(within(idol).getByRole("button", { name: "Put away" }));
    await waitFor(() => expect(carried()).toBeCloseTo(base));
    expect(((await screen.findByText("Idol")).closest("li") as HTMLElement).textContent).toMatch(
      /not carried/,
    );
    // A weight of 0 is known: no incomplete note.
    await add({ name: "Feather", weight: "0" });
    expect(screen.queryByTestId("weight-incomplete")).toBeNull();
    // Replaced by a catalog item: removed, then the catalog one added — its weight once.
    const feather = (await screen.findByText("Feather")).closest("li") as HTMLElement;
    await userEvent.click(within(feather).getByRole("button", { name: "Remove: Feather" }));
    await waitFor(() => expect(screen.queryByText("Feather")).toBeNull());
    await act(async () => {
      expect((await docs().playAction(id, { type: "add_item", item: "rope", qty: 1 })).ok).toBe(
        true,
      );
    });
    const rope = (
      await engine.playSheet(record(id)?.build as never, record(id)?.state as never)
    ).sheet.play.inventory.filter((i) => i.item === "rope");
    expect(rope).toHaveLength(1);
    await waitFor(() => expect(carried()).toBeCloseTo(base + (rope[0]?.weight ?? 0)));
    expect(record(id)?.state.currency).toEqual(gold); // no gold changed by any of it
  });
});
