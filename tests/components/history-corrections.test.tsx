/**
 * kenli F-006 review04 regressions (R04-01–03), on the real store, autosave, fake IndexedDB and the
 * real History panel: a day-only change that fails to save says so and can be retried (also the
 * first head, a rename and a day correction; per character); a roll's group stays whole when another
 * group's entry falls between its entries (an encounter roll with no cost), before and after a save
 * and reload; a follow-up or an answer names the earlier action it refers to even off the page,
 * without merging their results, costs or page counts, and says when it isn't in this history.
 */

import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { openDB } from "idb";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, DB_NAME, db } from "../../src/persistence/db";
import { groupFrom, journal } from "../../src/persistence/history";
import { flushNow, loadAll, startAutosave, unsavedState } from "../../src/persistence/sync";
import { useDocuments } from "../../src/store/documents";
import {
  type HistoryEntry,
  type HistoryMeta,
  sessionEntries,
  useHistory,
} from "../../src/store/history";
import { useRolls } from "../../src/store/rolls";
import { fighter, rogue } from "../fixtures/characters";
import { storeCharacter } from "../fixtures/player-actions";
import { installTestEngine, renderApp, resetStores } from "../helpers/app";
import { engineWithDice } from "../helpers/transfer";

installTestEngine(5);
const docs = () => useDocuments.getState();
let fx = engineWithDice();
let stop: (() => void) | null = null;

beforeEach(async () => {
  await resetStores();
  useRolls.setState({ last: {} });
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

async function reload() {
  await flushNow();
  stop?.();
  await closeDb();
  useDocuments.setState({ hydrated: false, characters: {}, encounters: {}, revs: {}, history: {} });
  useHistory.getState().hydrate([]);
  fx = engineWithDice();
  await loadAll();
  stop = startAutosave();
}

async function named(name: string): Promise<string> {
  const build = ok(
    await fx.engine.editBuild(await fighter(fx.engine, 3), { type: "name", name }),
  ).build;
  return storeCharacter(fx.engine, build);
}

const TOGGLE = "History: what this character played";
async function openPanel() {
  await userEvent.click(await screen.findByRole("button", { name: TOGGLE }, { timeout: 15_000 }));
  return screen.findByRole("dialog", { name: "History" });
}

/** A quota on the journal head's store only (a simulation of a full disk, not a real one). */
function failHeads(): () => void {
  const proto = IDBObjectStore.prototype;
  const put = proto.put;
  proto.put = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore["put"]>) {
    if (this.name === "history_meta") throw new DOMException("quota", "QuotaExceededError");
    return put.apply(this, args);
  };
  return () => {
    proto.put = put;
  };
}

describe("R04-01: a change of days alone is saved truthfully", () => {
  it("next day, rename, correction: failed with a retry, never 'saved', until it is; then it survives a reload", async () => {
    await loadAll();
    stop = startAutosave();
    const id = await named("Aerin");
    await renderApp(`/characters/${id}/sheet`);
    const panel = await openPanel();
    await waitFor(() =>
      expect(within(panel).getByTestId("history-day")).toHaveTextContent("Day 1"),
    );
    // The first head itself is a change to save (a character never looked at before).
    expect(unsavedState(id)).toEqual({ entries: 0, days: true });
    await act(() => flushNow());
    expect(within(panel).getByTestId("history-save")).toHaveTextContent("Saved on this device.");
    const saved = (await (await db()).get("history_meta", id)) as HistoryMeta;
    for (const change of ["next", "rename", "correct"] as const) {
      const restore = failHeads();
      try {
        if (change === "next")
          await userEvent.click(within(panel).getByRole("button", { name: "Next day" }));
        if (change === "rename") {
          await userEvent.type(
            within(panel).getByRole("textbox", { name: "Day label (optional)" }),
            "Camp",
          );
          await userEvent.click(within(panel).getByRole("button", { name: "Rename today" }));
        }
        if (change === "correct")
          await userEvent.selectOptions(
            within(panel).getByRole("combobox", { name: "Correct the current day" }),
            saved.current_day_id,
          );
        // Unsaved, and after an earlier failure still failed (not "saved") until a save succeeds.
        expect(within(panel).getByTestId("history-save")).toHaveTextContent(
          change === "next" ? /Not saved yet/ : /Saving failed/,
        );
        await act(() => flushNow().catch(() => undefined));
        expect(useHistory.getState().saveState.status).toBe("failed");
        expect(((await (await db()).get("history_meta", id)) as HistoryMeta).rev).toBe(saved.rev);
        expect(within(panel).getByTestId("history-save")).toHaveTextContent(/Saving failed/);
        expect(within(panel).getByTestId("history-save")).not.toHaveTextContent(
          /Saved on this device/,
        );
        expect(within(panel).getByRole("button", { name: "Try saving again" })).toBeInTheDocument();
      } finally {
        restore();
      }
    }
    await userEvent.click(within(panel).getByRole("button", { name: "Try saving again" }));
    await waitFor(() =>
      expect(within(panel).getByTestId("history-save")).toHaveTextContent("Saved on this device."),
    );
    const head = (await (await db()).get("history_meta", id)) as HistoryMeta;
    expect(head.rev).toBe(saved.rev + 1);
    expect(head.days.map((d) => d.label)).toEqual([null, "Camp"]);
    expect(head.current_day_id).toBe(saved.current_day_id);
    cleanup();
    await reload();
    expect(useHistory.getState().meta[id]?.days.map((d) => d.label)).toEqual([null, "Camp"]);
  });

  it("another character's unsaved days don't show as this character's failure", async () => {
    await loadAll();
    stop = startAutosave();
    const a = await named("Aerin");
    const b = await named("Brann");
    useHistory.getState().ensureMeta(a);
    useHistory.getState().ensureMeta(b);
    await flushNow();
    const restore = failHeads();
    try {
      useHistory.getState().startNextDay(b, "Elsewhere");
      await flushNow().catch(() => undefined);
    } finally {
      restore();
    }
    expect(unsavedState(b)).toEqual({ entries: 0, days: true });
    expect(unsavedState(a)).toEqual({ entries: 0, days: false });
    await renderApp(`/characters/${a}/sheet`);
    const panel = await openPanel();
    expect(await within(panel).findByTestId("history-save")).toHaveTextContent(
      "Saved on this device.",
    );
    await userEvent.selectOptions(within(panel).getByRole("combobox", { name: "Character" }), b);
    await waitFor(() =>
      expect(within(panel).getByTestId("history-save")).toHaveTextContent(/Saving failed/),
    );
  });
});

/** A fighter with a sheet attack rolled by hand (its group's root). */
async function sheetAttack(name = "Aerin") {
  const id = await named(name);
  const build = docs().characters[id]?.build;
  if (!build) throw new Error("gone");
  const sheet = (await fx.engine.playSheet(build, docs().characters[id]?.state as never)).sheet;
  const line = sheet.attacks.find((a) => a.damage_parts.some((p) => p.dice));
  if (!line) throw new Error("no attack line");
  fx.dice.push(12, 3, 3);
  ok(await docs().rollByHand(id, { type: "attack", attack: line.name }));
  return { id, line, root: sessionEntries(id)[0] as HistoryEntry };
}

describe("R04-02: a group is read by its id, whatever lies between its entries", () => {
  it("an encounter roll with no cost between a roll and its Critical Hit: the group whole, saved, reloaded, current", async () => {
    await loadAll();
    stop = startAutosave();
    const { id, line, root } = await sheetAttack();
    const eid = await docs().createEncounter("Ambush");
    ok(
      await docs().encounterAction(eid, [
        { type: "add_character", character: id, id: "a" },
        { type: "add_monster", monster: "goblin-warrior" },
        { type: "set_initiative", id: "a", value: 20 },
        { type: "set_initiative", id: "goblin-warrior", value: 1 },
        { type: "start" },
      ]),
    );
    fx.dice.push(12, 3, 3);
    ok(
      await docs().encounterAction(eid, {
        type: "roll",
        id: "a",
        what: { type: "attack", attack: line.name },
      } as never),
    );
    fx.dice.push(4, 4);
    ok(await docs().setCritical(id, 0, true)); // the sheet roll's window is still open
    expect(sessionEntries(id).map((e) => e.kind)).toEqual([
      "sheet_roll",
      "encounter",
      "set_critical",
    ]);
    const expected = sessionEntries(id).filter((e) => e.group_id === root.group_id);
    expect(await groupFrom(root)).toEqual(expected);
    await reload();
    const saved = await journal(id);
    const savedRoot = saved.find((e) => e.operation_id === root.operation_id) as HistoryEntry;
    expect((await groupFrom(savedRoot)).map((e) => e.kind)).toEqual(["sheet_roll", "set_critical"]);
    await renderApp(`/characters/${id}/sheet`);
    const panel = await openPanel();
    const group = (
      await within(panel).findAllByTestId("history-group", {}, { timeout: 10_000 })
    ).find((g) => within(g).queryByTestId("history-current")) as HTMLElement;
    expect(
      within(group)
        .getAllByTestId("history-entry")
        .map((l) => l.dataset.kind),
    ).toEqual(["sheet_roll", "set_critical"]);
    expect(within(group).getByTestId("history-current")).toHaveTextContent("Critical Hit");
    // Every entry once: the encounter roll is its own group, the count the journal's.
    expect(within(panel).getAllByTestId("history-entry")).toHaveLength(3);
    expect(within(panel).getByTestId("history-count")).toHaveTextContent("Showing 3 of 3 entries");
  });

  it("an interleaved Heroic reroll: Undo and Redo change its status and the current result", async () => {
    const id = await named("Aerin");
    ok(await docs().playAction(id, { type: "set_inspiration", value: true }));
    const build = docs().characters[id]?.build;
    const sheet = (await fx.engine.playSheet(build as never, docs().characters[id]?.state as never))
      .sheet;
    const line = sheet.attacks.find((a) => a.damage_parts.some((p) => p.dice));
    if (!line) throw new Error("no attack line");
    fx.dice.push(12, 3, 3);
    ok(await docs().rollByHand(id, { type: "attack", attack: line.name }));
    const root = sessionEntries(id).at(-1) as HistoryEntry;
    const eid = await docs().createEncounter("Ambush");
    ok(
      await docs().encounterAction(eid, [
        { type: "add_character", character: id, id: "a" },
        { type: "add_monster", monster: "goblin-warrior" },
        { type: "set_initiative", id: "a", value: 20 },
        { type: "set_initiative", id: "goblin-warrior", value: 1 },
        { type: "start" },
      ]),
    );
    fx.dice.push(12, 3, 3);
    ok(
      await docs().encounterAction(eid, {
        type: "roll",
        id: "a",
        what: { type: "attack", attack: line.name },
      } as never),
    );
    fx.dice.push(19);
    ok(await docs().heroicReroll(id, { kind: "d20", attack: 0, die: 0 }));
    expect((await groupFrom(root)).map((e) => [e.kind, e.status])).toEqual([
      ["sheet_roll", "done"],
      ["reroll", "done"],
    ]);
    await docs().undo(id);
    expect((await groupFrom(root)).map((e) => e.status)).toEqual(["done", "undone"]);
    await docs().redo(id);
    expect((await groupFrom(root)).map((e) => e.status)).toEqual(["done", "done"]);
  });
});

describe("R04-02: the v3 → v4 upgrade", () => {
  it("adds the group index over rows already saved: an interleaved group is read whole, nothing rewritten", async () => {
    const { id, line, root } = await sheetAttack();
    const eid = await docs().createEncounter("Ambush");
    ok(
      await docs().encounterAction(eid, [
        { type: "add_character", character: id, id: "a" },
        { type: "add_monster", monster: "goblin-warrior" },
        { type: "set_initiative", id: "a", value: 20 },
        { type: "set_initiative", id: "goblin-warrior", value: 1 },
        { type: "start" },
      ]),
    );
    fx.dice.push(12, 3, 3);
    ok(
      await docs().encounterAction(eid, {
        type: "roll",
        id: "a",
        what: { type: "attack", attack: line.name },
      } as never),
    );
    fx.dice.push(4, 4);
    ok(await docs().setCritical(id, 0, true));
    const rows = sessionEntries(id);
    // A database as version 3 left it: the journal stores and their four indexes, no by_group.
    await closeDb();
    await new Promise<void>((r) => {
      const req = indexedDB.deleteDatabase(DB_NAME);
      req.onsuccess = () => r();
      req.onerror = () => r();
    });
    const old = await openDB(DB_NAME, 3, {
      upgrade(d) {
        d.createObjectStore("characters", { keyPath: "id" });
        d.createObjectStore("encounters", { keyPath: "id" });
        d.createObjectStore("settings");
        d.createObjectStore("portraits");
        d.createObjectStore("packs", { keyPath: "key" });
        const h = d.createObjectStore("history", { keyPath: "id" });
        h.createIndex("by_record_seq", ["record_id", "seq"], { unique: true });
        h.createIndex("by_record_day", ["record_id", "day_id", "seq"]);
        h.createIndex("by_record_rest", ["record_id", "rest_kind", "seq"]);
        h.createIndex("by_operation", "operation_id");
        d.createObjectStore("history_meta", { keyPath: "record_id" });
      },
    });
    const record = docs().characters[id];
    await old.put("characters", record as never);
    for (const e of rows) await old.put("history", e as never);
    await old.put("history_meta", {
      ...(useHistory.getState().meta[id] as HistoryMeta),
      rev: 1,
    } as never);
    old.close();
    useDocuments.setState({
      hydrated: false,
      characters: {},
      encounters: {},
      revs: {},
      history: {},
    });
    useHistory.getState().hydrate([]);
    await loadAll();
    const database = await db();
    expect(database.version).toBe(4);
    expect([...database.transaction("history").store.indexNames]).toContain("by_group");
    const byId = (a: HistoryEntry, b: HistoryEntry) => a.id.localeCompare(b.id);
    expect([...(await database.getAll("history"))].sort(byId)).toEqual([...rows].sort(byId));
    expect((await groupFrom(root)).map((e) => e.kind)).toEqual(["sheet_roll", "set_critical"]);
  });
});

describe("R04-03: what a follow-up or an answer refers to", () => {
  it("follow-up damage off the page: names the attack it follows, its own cost line, counts unchanged", async () => {
    const { id, line, root } = await sheetAttack();
    await docs().rollDamage(id, line.damage_parts, false, line.name, root.operation_id);
    for (let i = 0; i < 49; i++) ok(await docs().rollTest(id, { skill: "athletics" }));
    await renderApp(`/characters/${id}/sheet`);
    const panel = await openPanel();
    await waitFor(() => expect(within(panel).getAllByTestId("history-entry")).toHaveLength(50));
    const damage = within(panel)
      .getAllByTestId("history-entry")
      .find((l) => l.dataset.kind === "damage") as HTMLElement;
    const context = within(damage).getByTestId("history-context");
    expect(context).toHaveTextContent(`Follows #${root.seq}: Rolled by hand: ${line.name}`);
    expect(context).toHaveTextContent("total 17");
    expect(within(damage).getByTestId("history-costs")).toHaveTextContent("Nothing paid");
    expect(within(panel).getByTestId("history-count")).toHaveTextContent(
      "Showing 50 of 51 entries",
    );
    // The attack isn't made a row of this page, nor its result merged into the damage.
    expect(
      within(panel)
        .getAllByTestId("history-entry")
        .map((l) => l.dataset.kind),
    ).not.toContain("sheet_roll");
    expect(within(damage).queryByTestId("history-current")).toBeNull();
  });

  it("an answer after a reload, its stop off the page: names the stop; a link to nothing says so", async () => {
    await loadAll();
    stop = startAutosave();
    const rid = await storeCharacter(fx.engine, await rogue(fx.engine, 5));
    const eid = await docs().createEncounter("Dodge");
    ok(
      await docs().encounterAction(eid, [
        { type: "add_character", character: rid, id: "rogue", decisions: "ask" },
        { type: "add_monster", monster: "goblin-warrior" },
        { type: "set_initiative", id: "goblin-warrior", value: 20 },
        { type: "set_initiative", id: "rogue", value: 1 },
        { type: "start" },
      ]),
    );
    fx.dice.push(19, 6);
    ok(
      await docs().encounterAction(eid, {
        type: "attack",
        id: "goblin-warrior",
        target: "rogue",
        attack: "Scimitar",
      }),
    );
    const stopped = sessionEntries(rid).at(-1) as HistoryEntry;
    for (let i = 0; i < 50; i++) ok(await docs().rollTest(rid, { skill: "athletics" }));
    await reload();
    ok(await docs().encounterAction(eid, { type: "decide", use: true }));
    // A row whose earlier action isn't in this character's history (written as another app would).
    const answer = sessionEntries(rid).at(-1) as HistoryEntry;
    await flushNow();
    const stray: HistoryEntry = {
      ...answer,
      id: "h-stray-link",
      seq: answer.seq + 1,
      operation_id: "op-stray-0001",
      group_id: "op-stray-0001",
      links: { follows: "op-nowhere-01", continues: null },
    };
    const database = await db();
    const head = (await database.get("history_meta", rid)) as HistoryMeta;
    await database.put("history", stray);
    await database.put("history_meta", { ...head, rev: head.rev + 1, next_seq: stray.seq + 1 });
    await reload();
    await renderApp(`/encounters/${eid}`);
    const panel = await openPanel();
    await userEvent.selectOptions(within(panel).getByRole("combobox", { name: "Character" }), rid);
    await waitFor(() =>
      expect(within(panel).getAllByTestId("history-context").length).toBeGreaterThanOrEqual(2),
    );
    const rows = within(panel).getAllByTestId("history-entry");
    const answered = rows.find((l) => within(l).queryByText(/Answers a decision/)) as HTMLElement;
    expect(within(answered).getByTestId("history-context")).toHaveTextContent(
      `Answers #${stopped.seq}: At the table (Dodge)`,
    );
    const orphan = rows.find((l) => l.textContent?.includes(`#${stray.seq} ·`)) as HTMLElement;
    expect(within(orphan).getByTestId("history-context")).toHaveTextContent(
      "Follows an earlier action that isn't in this character's history",
    );
  });
});
