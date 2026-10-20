/**
 * kenli F-006 T03: the History side panel in the real app (in-process engine, fake IndexedDB):
 * opening and closing with focus, the empty state and the local-only notice, two characters' own
 * days and Long Rest counts, a roll's changes with their own costs, its current result and Undo
 * status (also when the root is older than the page), an import boundary, the save states (pending,
 * saved, failed with retry, conflict without it), more than 500 entries with nothing cut, a table's
 * party, and the warning before a sheet Undo that also takes back a table action.
 */

import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { commitPlan, previewImport } from "../../src/import";
import { db } from "../../src/persistence/db";
import { flushNow, loadAll, startAutosave } from "../../src/persistence/sync";
import { useDocuments } from "../../src/store/documents";
import { type HistoryMeta, useHistory } from "../../src/store/history";
import { useUi } from "../../src/store/ui";
import { fighter } from "../fixtures/characters";
import { humanWizard, RAY, storeCharacter, testContext } from "../fixtures/player-actions";
import { installTestEngine, renderApp, resetStores } from "../helpers/app";
import { engineWithDice, libraryFetch, snapshot } from "../helpers/transfer";

installTestEngine(5);
const docs = () => useDocuments.getState();
let fx = engineWithDice();
let stop: (() => void) | null = null;

beforeEach(async () => {
  await resetStores();
  fx = engineWithDice();
});
afterEach(() => {
  cleanup();
  stop?.();
  stop = null;
});

function ok<T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> {
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r as Extract<T, { ok: true }>;
}

async function named(name: string, level = 3): Promise<string> {
  const build = await fighter(fx.engine, level);
  const renamed = ok(await fx.engine.editBuild(build, { type: "name", name }));
  return storeCharacter(fx.engine, renamed.build);
}

const TOGGLE = "History: what this character played";
async function openPanel() {
  await userEvent.click(await screen.findByRole("button", { name: TOGGLE }, { timeout: 15_000 }));
  return screen.findByRole("dialog", { name: "History" });
}

describe("the History panel (AC-01, AC-02, AC-05, AC-06)", () => {
  it("opens beside the sheet, keeps open while playing, closes with Esc and gives focus back; empty state; local only", async () => {
    const id = await named("Aerin");
    await renderApp(`/characters/${id}/sheet`);
    const panel = await openPanel();
    await waitFor(() => expect(panel.contains(document.activeElement)).toBe(true));
    expect(within(panel).getByRole("combobox", { name: "Character" })).toHaveValue(id);
    expect(await within(panel).findByText(/Nothing recorded yet/)).toBeInTheDocument();
    expect(within(panel).getByTestId("history-local")).toHaveTextContent(
      "History stays on this device: it isn't exported or imported.",
    );
    // Playing beside it: a click on the sheet leaves it open.
    await userEvent.click(
      await screen.findByRole("heading", { name: "Aerin", level: 1 }, { timeout: 10_000 }),
    );
    expect(screen.getByRole("dialog", { name: "History" })).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "History" })).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole("button", { name: TOGGLE }));
    const again = await openPanel();
    await userEvent.click(within(again).getByRole("button", { name: "Close history" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "History" })).toBeNull());
  });

  it("two characters keep their own days and Long Rest counts; the DM's exception shows", async () => {
    const a = await named("Aerin");
    const b = await named("Brann");
    ok(await docs().playAction(a, { type: "long_rest" }));
    ok(
      await docs().playAction(a, { type: "long_rest" }, undefined, {
        rest_override: { note: "haven" },
      }),
    );
    await renderApp(`/characters/${a}/sheet`);
    let panel = await openPanel();
    expect(await within(panel).findByTestId("history-rests")).toHaveTextContent(
      "Long Rests today: 2 · since this history began: 2",
    );
    expect(within(panel).getByText(/2 Long Rests on this day/)).toBeInTheDocument();
    await waitFor(() =>
      expect(
        within(panel)
          .getAllByTestId("history-badge")
          .map((b) => b.textContent),
      ).toContain("DM's exception"),
    );
    await userEvent.type(
      within(panel).getByRole("textbox", { name: "Day label (optional)" }),
      "Camp",
    );
    await userEvent.click(within(panel).getByRole("button", { name: "Next day" }));
    expect(within(panel).getByTestId("history-day")).toHaveTextContent("Today: Camp");
    expect(await within(panel).findByTestId("history-rests")).toHaveTextContent(
      "Long Rests today: 0",
    );
    await userEvent.selectOptions(within(panel).getByRole("combobox", { name: "Character" }), b);
    panel = screen.getByRole("dialog", { name: "History" });
    await waitFor(() =>
      expect(within(panel).getByTestId("history-day")).toHaveTextContent("Today: Day 1"),
    );
    expect(within(panel).getByTestId("history-rests")).toHaveTextContent(
      "Long Rests today: 0 · since this history began: 0",
    );
    expect(useHistory.getState().meta[a]?.days.map((d) => d.label)).toEqual([null, "Camp"]);
    expect(useHistory.getState().meta[b]?.days).toHaveLength(1);
    // A bad label is said where it was typed; the day stays.
    await userEvent.type(
      within(panel).getByRole("textbox", { name: "Day label (optional)" }),
      "x".repeat(41),
    );
    await userEvent.click(within(panel).getByRole("button", { name: "Rename today" }));
    expect(within(panel).getByRole("alert")).toHaveTextContent("one line of at most 40 characters");
    // Undo of a's exception rest counts in its own (first) day, not today.
    await act(() => docs().undo(a));
    expect(useHistory.getState().meta[a]?.days[1]?.label).toBe("Camp");
  });

  it("a roll's change older than the page: the whole group, its own costs, the current result; Undo marks it", async () => {
    const content = await testContext(fx.engine);
    const build = await humanWizard(fx.engine);
    let state = await fx.engine.createState(build, content);
    state = ok(
      await fx.engine.applyPlayAction(
        build,
        state,
        { type: "set_inspiration", value: true },
        content,
      ),
    ).state;
    const id = await storeCharacter(fx.engine, build, content, state);
    fx.dice.push(9, 2, 3);
    ok(await docs().rollByHand(id, { type: "cast", spell: RAY }));
    fx.dice.push(7);
    ok(await docs().heroicReroll(id, { kind: "damage", attack: 0, part: 0, die: 0 }));
    for (let i = 0; i < 49; i++) {
      fx.dice.push(10);
      ok(await docs().rollTest(id, { skill: "arcana" }));
    }
    await renderApp(`/characters/${id}/sheet`);
    const panel = await openPanel();
    const groups = await within(panel).findAllByTestId("history-group", {}, { timeout: 10_000 });
    const rollGroup = groups.find((g) => within(g).queryByTestId("history-current")) as HTMLElement;
    expect(rollGroup).toBeDefined();
    const lines = within(rollGroup).getAllByTestId("history-entry");
    expect(lines.map((l) => l.dataset.kind)).toEqual(["sheet_roll", "reroll"]);
    expect(within(lines[0] as HTMLElement).getByTestId("history-costs")).toHaveTextContent(
      "a level 1 spell slot",
    );
    expect(within(lines[1] as HTMLElement).getByTestId("history-costs")).toHaveTextContent(
      "Heroic Inspiration",
    );
    expect(within(lines[0] as HTMLElement).getByTestId("history-outcome")).toHaveTextContent(
      "damage 5",
    );
    expect(within(rollGroup).getByTestId("history-current")).toHaveTextContent("damage 10");
    expect(within(panel).getByTestId("history-count")).toHaveTextContent(
      "Showing 50 of 51 entries",
    );
    await act(() => docs().undo(id)); // the Heroic reroll
    await waitFor(() =>
      expect(
        within(panel)
          .getAllByTestId("history-entry")
          .find((l) => l.dataset.kind === "reroll")?.dataset.status,
      ).toBe("undone"),
    );
    const again = within(panel)
      .getAllByTestId("history-group")
      .find((g) => within(g).queryByTestId("history-current")) as HTMLElement;
    expect(within(again).getByTestId("history-current")).toHaveTextContent("damage 5");
  });

  it("more than 500 entries: older pages until the first, nothing cut", async () => {
    const id = await named("Aerin");
    for (let i = 0; i < 520; i++) ok(await docs().rollTest(id, { skill: "athletics" }));
    await renderApp(`/characters/${id}/sheet`);
    const panel = await openPanel();
    expect(
      await within(panel).findByTestId("history-count", {}, { timeout: 10_000 }),
    ).toHaveTextContent("Showing 50 of 520 entries");
    for (let pages = 1; pages < 20; pages++) {
      const more = await waitFor(() => {
        const b = within(panel).queryByRole("button", {
          name: /Show older entries|Reading the history/,
        });
        if (b) expect(b).toBeEnabled();
        return b;
      });
      if (!more) break;
      await userEvent.click(more);
    }
    await waitFor(() => expect(within(panel).getAllByTestId("history-entry")).toHaveLength(520), {
      timeout: 10_000,
    });
    expect(within(panel).queryByRole("button", { name: "Show older entries" })).toBeNull();
    expect(within(panel).getByTestId("history-count")).toHaveTextContent(
      "Showing 520 of 520 entries",
    );
    expect(within(panel).getByText(/^#1 ·/)).toBeInTheDocument();
  });

  it("an import boundary reads as such; exports say history stays here", async () => {
    await loadAll();
    stop = startAutosave();
    const preview = async () => {
      const p = await previewImport(
        { url: snapshot("wren") },
        { signal: new AbortController().signal, fetch: libraryFetch() },
      );
      if (!p.ok) throw new Error(p.problem.code);
      return p.plan;
    };
    ok(await commitPlan(await preview(), { characters: {} }));
    const id = Object.values(docs().characters).find((c) => c.build.name === "Wren")?.id as string;
    ok(await docs().playAction(id, { type: "damage", amount: 1 }));
    await flushNow();
    const plan = await preview();
    const key = plan.characters[0]?.key as string;
    ok(
      await commitPlan(plan, {
        characters: { [key]: { kind: "replace", target: id, confirmed: true } },
      }),
    );
    await renderApp(`/characters/${id}/sheet`);
    const panel = await openPanel();
    expect(
      await within(panel).findByTestId("history-import", {}, { timeout: 10_000 }),
    ).toHaveTextContent("Replaced by an imported version (generation 0 → 1)");
    cleanup();
    // jsdom has no object URLs: the download itself is stubbed, the notice is the app's.
    const { createObjectURL, revokeObjectURL } = URL;
    URL.createObjectURL = () => "blob:test";
    URL.revokeObjectURL = () => undefined;
    try {
      await renderApp("/characters");
      await userEvent.click(
        await screen.findByRole(
          "button",
          { name: "Export for another device (with its content's identity)" },
          { timeout: 10_000 },
        ),
      );
      const notice = "History stays on this device: it isn't exported or imported.";
      await waitFor(() => expect(useUi.getState().toasts.at(-1)?.lines).toEqual([notice]));
      expect(screen.getAllByText(notice).length).toBeGreaterThan(0);
    } finally {
      URL.createObjectURL = createObjectURL;
      URL.revokeObjectURL = revokeObjectURL;
    }
  });

  it("save states: pending, saved, failed with a retry, a conflict without one", async () => {
    await loadAll();
    stop = startAutosave();
    const id = await named("Aerin");
    await flushNow();
    await renderApp(`/characters/${id}/sheet`);
    const panel = await openPanel();
    // Its first head (made as the panel opened) is a change too: not saved, then saved.
    expect(await within(panel).findByTestId("history-save")).toHaveTextContent(/Not saved yet/);
    await act(() => flushNow());
    expect(within(panel).getByTestId("history-save")).toHaveTextContent("Saved on this device.");
    await act(async () => {
      ok(await docs().rollTest(id, { skill: "athletics" }));
    });
    expect(within(panel).getByTestId("history-save")).toHaveTextContent("Not saved yet: 1 entries");
    const proto = IDBObjectStore.prototype;
    const put = proto.put;
    proto.put = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore["put"]>) {
      if (this.name === "history") throw new DOMException("quota", "QuotaExceededError");
      return put.apply(this, args);
    };
    await act(() => flushNow().catch(() => undefined));
    expect(within(panel).getByTestId("history-save")).toHaveTextContent(
      "Saving failed: 1 entries aren't saved.",
    );
    proto.put = put;
    await userEvent.click(within(panel).getByRole("button", { name: "Try saving again" }));
    await waitFor(() =>
      expect(within(panel).getByTestId("history-save")).toHaveTextContent("Saved on this device."),
    );
    // Another tab changes this character's journal: a conflict, no retry offered.
    const database = await db();
    const head = (await database.get("history_meta", id)) as HistoryMeta;
    await database.put("history_meta", { ...head, rev: head.rev + 1 });
    await act(async () => {
      ok(await docs().rollTest(id, { skill: "athletics" }));
      await flushNow();
    });
    await waitFor(() =>
      expect(within(panel).getByTestId("history-save")).toHaveTextContent(/changed in another tab/),
    );
    expect(within(panel).queryByRole("button", { name: "Try saving again" })).toBeNull();
  });

  it("at a table: its party to pick from; entries say where; Undo on the sheet warns before taking back a table action", async () => {
    const a = await named("Aerin");
    const b = await named("Brann");
    const eid = await docs().createEncounter("Ambush");
    ok(
      await docs().encounterAction(eid, [
        { type: "add_character", character: a, id: "aerin" },
        { type: "add_character", character: b, id: "brann" },
        { type: "add_monster", monster: "goblin-warrior" },
        { type: "set_initiative", id: "goblin-warrior", value: 20 },
        { type: "set_initiative", id: "aerin", value: 10 },
        { type: "set_initiative", id: "brann", value: 5 },
        { type: "start" },
      ]),
    );
    ok(await docs().playAction(b, { type: "damage", amount: 1 }));
    fx.dice.push(19, 4);
    ok(
      await docs().encounterAction(eid, {
        type: "attack",
        id: "goblin-warrior",
        target: "brann",
        attack: "Scimitar",
      }),
    );
    await renderApp(`/encounters/${eid}`);
    const panel = await openPanel();
    const party = within(panel).getByRole("group", { name: "This table's characters" });
    await userEvent.click(within(party).getByRole("button", { name: "Brann" }));
    await waitFor(() =>
      expect(
        within(panel)
          .getAllByTestId("history-entry")
          .some((l) => /At the table \(Ambush\): attack/.test(l.textContent ?? "")),
      ).toBe(true),
    );
    cleanup();
    await renderApp(`/characters/${b}/sheet`);
    const hurt = docs().characters[b]?.state;
    await userEvent.click(await screen.findByRole("button", { name: "Undo" }, { timeout: 10_000 }));
    const warn = await screen.findByRole("dialog", { name: "Undo also takes back a table action" });
    await userEvent.click(within(warn).getByRole("button", { name: "Cancel" }));
    expect(docs().characters[b]?.state).toBe(hurt);
    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    await userEvent.click(
      within(
        await screen.findByRole("dialog", { name: "Undo also takes back a table action" }),
      ).getByRole("button", {
        name: "Undo anyway",
      }),
    );
    await waitFor(() => expect(docs().characters[b]?.state).not.toBe(hurt));
  });
});
