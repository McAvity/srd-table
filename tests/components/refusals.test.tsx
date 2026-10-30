/**
 * kenli F-011 T03 (contracts/changes.md §5.3–5.4): the attempt through the real controls. A Cast or
 * Use with none left stays the player's command — the exhausted slot is selectable, the lowest valid
 * level is the default when all are spent, a tap or Enter sends exactly one complete request and
 * one `refused` entry is journaled, shown in the History panel as "Not done" with the engine's
 * reason. Selecting, focusing, hovering or a missing choice (which spellcasting) send nothing.
 */

import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { RollWhat } from "srd-rules-engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newId, useDocuments } from "../../src/store/documents";
import { sessionEntries } from "../../src/store/history";
import { useUi } from "../../src/store/ui";
import { fighter, wizard } from "../fixtures/characters";
import { BI, bard, humanWizard, storeCharacter, testContext } from "../fixtures/player-actions";
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

function ok<T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> {
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r as Extract<T, { ok: true }>;
}
const refused = (id: string) => sessionEntries(id).filter((e) => e.kind === "refused");
/** Every rollByHand request the store sends to the engine. */
function spyRolls() {
  const sent: RollWhat[] = [];
  const original = fx.engine.rollByHand;
  fx.engine.rollByHand = (build, state, what, force, content) => {
    sent.push(what);
    return original(build, state, what, force, content);
  };
  return { sent, restore: () => (fx.engine.rollByHand = original) };
}

describe("Spells: Cast with every slot spent", () => {
  it("defaults to the lowest level, keeps spent levels selectable; click and Enter: one request and one entry each", async () => {
    const r = ok(await docs().importCharacter(await wizard(fx.engine, 3)));
    ok(
      await docs().playAction(r.id, [
        ...Array(4).fill({ type: "spend_slot", level: 1 }),
        ...Array(2).fill({ type: "spend_slot", level: 2 }),
      ]),
    );
    const before = docs().characters[r.id];
    const spy = spyRolls();
    try {
      await renderApp(`/characters/${r.id}/sheet?tab=spells`);
      const level1 = await screen.findByRole("region", { name: "Level 1" }, { timeout: 10_000 });
      // A spell that isn't a ritual (a ritual would rather default to its ritual casting).
      const orbRow = within(level1).getByText("Chromatic Orb").closest("li") as HTMLElement;
      const picker = within(orbRow).getByRole("combobox", { name: /slot level/ });
      expect(picker).toHaveValue("slot:1");
      for (const o of within(picker).getAllByRole("option")) expect(o).not.toBeDisabled();
      const row = picker.closest("li") as HTMLElement;
      const cast = within(row).getByRole("button", { name: "Roll" });
      expect(cast).toBeEnabled();
      // The reason is a warning read with Cast, not a lock.
      expect(cast).toHaveAccessibleDescription(/No level 1 spell slots left/);
      // Not attempts: choosing a level, focusing and hovering Cast.
      await userEvent.selectOptions(picker, "slot:2");
      await userEvent.selectOptions(picker, "slot:1");
      cast.focus();
      await userEvent.hover(cast);
      expect(spy.sent).toHaveLength(0);
      expect(refused(r.id)).toHaveLength(0);
      // One tap: one complete request, one entry.
      await userEvent.click(cast);
      await waitFor(() => expect(refused(r.id)).toHaveLength(1));
      expect(spy.sent).toHaveLength(1);
      expect(spy.sent[0]).toMatchObject({ type: "cast", slot_level: 1 });
      expect((spy.sent[0] as { spell?: string }).spell).toBeTruthy();
      // The keyboard: Enter, then Space on the focused button — one each.
      cast.focus();
      await userEvent.keyboard("{Enter}");
      await waitFor(() => expect(refused(r.id)).toHaveLength(2));
      await userEvent.keyboard(" ");
      await waitFor(() => expect(refused(r.id)).toHaveLength(3));
      expect(spy.sent).toHaveLength(3);
      expect(docs().characters[r.id]?.state).toBe(before?.state);
      expect(refused(r.id)[0]?.refusal).toMatchObject({ command: "sheet_cast" });
    } finally {
      spy.restore();
    }
  });
});

/** An encounter with one character (its record), started, the player's view of it. */
async function encounterOf(characterId: string, combatant: string, manual = false, foe = true) {
  const record = docs().characters[characterId];
  if (!record) throw new Error("no record");
  const party = { [characterId]: { build: record.build, state: record.state } };
  const r = await fx.engine.applyEncounterAction(await fx.engine.newEncounter(), party, [
    { type: "add_character", character: characterId },
    ...(foe
      ? ([
          { type: "add_monster", monster: "goblin-warrior" },
          { type: "set_initiative", id: "goblin-warrior", value: 5 },
        ] as const)
      : []),
    { type: "set_initiative", id: combatant, value: 20 },
    { type: "start" },
  ]);
  if (!r.ok) throw new Error(r.reasons.join("; "));
  const id = newId("e");
  useDocuments.setState((st) => ({
    encounters: {
      ...st.encounters,
      [id]: { id, name: "T03", encounter: r.encounter, log: [], created: 0, updated: 0 },
    },
    revs: { ...st.revs, [id]: 1 },
  }));
  if (manual) await docs().setPlayMode(id, combatant, "manual");
  useUi.setState({ role: { kind: "player", character: characterId } });
  return id;
}
/** Every encounter request the store sends to the engine (not the composer's dry-run checks). */
function spyEncounter() {
  const sent: unknown[] = [];
  const apply = fx.engine.applyEncounterAction;
  fx.engine.applyEncounterAction = (encounter, p, action, world) => {
    sent.push(action);
    return apply(encounter, p, action, world);
  };
  return { sent, restore: () => (fx.engine.applyEncounterAction = apply) };
}
const SENTINEL = [17, 17, 17, 17];
const queueDice = () => fx.dice.splice(0, fx.dice.length, ...SENTINEL);

describe("Encounter: a complete command the rules refuse is the player's attempt (review03 R03-02)", () => {
  it("Second Wind with no use left, then Dash after the action is spent: each tile sends one command and journals one refusal", async () => {
    const aerin = ok(await docs().importCharacter(await fighter(fx.engine, 3)));
    for (let i = 0; i < 5; i++)
      if (
        !(await docs().playAction(aerin.id, { type: "use_feature", key: "fighter:second-wind" })).ok
      )
        break;
    const id = await encounterOf(aerin.id, "aerin");
    const spy = spyEncounter();
    try {
      await renderApp(`/encounters/${id}`);
      const options = await screen.findByRole("region", { name: "Options" }, { timeout: 15_000 });
      await userEvent.click(within(options).getByRole("tab", { name: /Bonus Action/ }));
      const wind = await within(options).findByRole("button", { name: /^Second Wind/ });
      expect(wind).toHaveAttribute("aria-disabled", "true");
      expect(wind).toHaveAccessibleDescription(/.+/);
      await userEvent.click(wind);
      await waitFor(() => expect(refused(aerin.id)).toHaveLength(1));
      expect(spy.sent).toHaveLength(1);
      expect(refused(aerin.id)[0]).toMatchObject({
        refusal: { command: "encounter_action", label: expect.stringMatching(/Second Wind/) },
        context: { source: "encounter", encounter_id: id, round: 1 },
      });
      // The action spent (Dodge), Dash is refused for the economy: still a complete command.
      await userEvent.click(within(options).getByRole("tab", { name: /^Action/ }));
      await userEvent.click(within(options).getByRole("button", { name: /^Dodge/ }));
      await waitFor(() => expect(spy.sent).toHaveLength(2));
      const dash = await within(options).findByRole("button", { name: /^Dash/ });
      await waitFor(() => expect(dash).toHaveAttribute("aria-disabled", "true"));
      const encounter = docs().encounters[id]?.encounter;
      dash.focus();
      await userEvent.keyboard("{Enter}");
      await waitFor(() => expect(refused(aerin.id)).toHaveLength(2));
      expect(spy.sent).toHaveLength(3);
      expect(refused(aerin.id)[1]?.refusal?.label).toMatch(/Dash/);
      expect(docs().encounters[id]?.encounter).toBe(encounter);
    } finally {
      spy.restore();
    }
  });

  it("a slot spent at level 1, level 2 left: the form offers both; level 1 sent is refused before the dice, one entry", async () => {
    const r = ok(await docs().importCharacter(await wizard(fx.engine, 3)));
    ok(await docs().playAction(r.id, Array(4).fill({ type: "spend_slot", level: 1 })));
    const id = await encounterOf(r.id, "lirael");
    const spy = spyEncounter();
    try {
      await renderApp(`/encounters/${id}`);
      const options = await screen.findByRole("region", { name: "Options" }, { timeout: 15_000 });
      await userEvent.click(await within(options).findByRole("button", { name: /^Chromatic Orb/ }));
      const form = await screen.findByRole("region", { name: /^Chromatic Orb/ });
      expect(refused(r.id)).toHaveLength(0);
      const slot = within(form).getByRole("combobox", { name: /Slot level/ });
      const levels = within(slot)
        .getAllByRole("option")
        .map((o) => o.textContent);
      expect(levels[0]).toMatch(/^Level 1 · No level 1 spell slots left/);
      expect(levels[1]).toMatch(/^Level 2$/);
      await userEvent.selectOptions(slot, "1");
      expect(spy.sent).toHaveLength(0);
      const send = within(form).getByRole("button", { name: /^Do it$/ });
      await waitFor(() => expect(send).toBeEnabled());
      queueDice();
      const before = docs().characters[r.id];
      await userEvent.click(send);
      await waitFor(() => expect(refused(r.id)).toHaveLength(1));
      expect(spy.sent.at(-1)).toMatchObject({
        type: "cast",
        spell: "chromatic-orb",
        slot_level: 1,
      });
      expect(fx.dice).toEqual(SENTINEL);
      expect(docs().characters[r.id]).toBe(before);
      expect(refused(r.id)[0]).toMatchObject({
        refusal: { command: "encounter_action", label: expect.stringMatching(/Chromatic Orb/) },
        context: { source: "encounter", encounter_id: id, round: 1 },
      });
    } finally {
      spy.restore();
    }
  });

  it("an attack without its target isn't complete: Do it stays locked, nothing sent; picking one sends it", async () => {
    const aerin = ok(await docs().importCharacter(await fighter(fx.engine, 3)));
    // Nobody else in the fight: the engine names no target for the attack.
    const id = await encounterOf(aerin.id, "aerin", false, false);
    const spy = spyEncounter();
    try {
      await renderApp(`/encounters/${id}`);
      const options = await screen.findByRole("region", { name: "Options" }, { timeout: 15_000 });
      await userEvent.click(await within(options).findByRole("button", { name: /^Greatsword/ }));
      const form = await screen.findByRole("region", { name: /^Greatsword/ });
      const send = within(form).getByRole("button", { name: /^Do it$/ });
      await waitFor(() => expect(send).toBeDisabled());
      await userEvent.click(send);
      expect(spy.sent).toHaveLength(0);
      expect(refused(aerin.id)).toHaveLength(0);
      await userEvent.click(within(form).getByRole("button", { name: /Aerin/, pressed: false }));
      await waitFor(() => expect(send).toBeEnabled());
    } finally {
      spy.restore();
    }
  });

  it("every slot spent: the form defaults to level 1; by hand, Do it by hand from the keyboard: one refusal, no die", async () => {
    const r = ok(await docs().importCharacter(await wizard(fx.engine, 3)));
    ok(
      await docs().playAction(r.id, [
        ...Array(4).fill({ type: "spend_slot", level: 1 }),
        ...Array(2).fill({ type: "spend_slot", level: 2 }),
      ]),
    );
    const id = await encounterOf(r.id, "lirael", true);
    await renderApp(`/encounters/${id}`);
    const options = await screen.findByRole("region", { name: "Options" }, { timeout: 15_000 });
    await userEvent.click(await within(options).findByRole("button", { name: /^Chromatic Orb/ }));
    const form = await screen.findByRole("region", { name: /^Chromatic Orb/ });
    expect(within(form).getByRole("combobox", { name: /Slot level/ })).toHaveValue("1");
    expect(refused(r.id)).toHaveLength(0);
    queueDice();
    within(form)
      .getByRole("button", { name: /^Do it by hand$/ })
      .focus();
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(refused(r.id)).toHaveLength(1));
    expect(refused(r.id)[0]?.refusal?.command).toBe("encounter_roll");
    expect(fx.dice).toEqual(SENTINEL);
  });
});

describe("Encounter by hand: the quick roll that falls back to the form (review03 R03-03)", () => {
  it("Wizard 1, no slot, By hand, Chromatic Orb: the form opens with nothing journaled; Cancel: still nothing; Do it by hand: one", async () => {
    const r = ok(await docs().importCharacter(await wizard(fx.engine, 1)));
    ok(await docs().playAction(r.id, Array(2).fill({ type: "spend_slot", level: 1 })));
    const id = await encounterOf(r.id, "lirael", true);
    const spy = spyEncounter();
    try {
      await renderApp(`/encounters/${id}`);
      const options = await screen.findByRole("region", { name: "Options" }, { timeout: 15_000 });
      const orb = await within(options).findByRole("button", { name: /^Chromatic Orb/ });
      await userEvent.click(orb);
      let form = await screen.findByRole("region", { name: /^Chromatic Orb/ });
      expect(refused(r.id)).toHaveLength(0);
      await userEvent.click(
        within(form).getAllByRole("button", { name: /^Cancel$/ })[0] as HTMLElement,
      );
      await waitFor(() =>
        expect(screen.queryByRole("region", { name: /^Chromatic Orb/ })).toBeNull(),
      );
      expect(refused(r.id)).toHaveLength(0);
      // The quick bar is drawn again once the form is closed: look it up again.
      const bar = await screen.findByRole("region", { name: "Options" });
      await userEvent.click(await within(bar).findByRole("button", { name: /^Chromatic Orb/ }));
      form = await screen.findByRole("region", { name: /^Chromatic Orb/ });
      expect(refused(r.id)).toHaveLength(0);
      queueDice();
      await userEvent.click(within(form).getByRole("button", { name: /^Do it by hand$/ }));
      await waitFor(() => expect(refused(r.id)).toHaveLength(1));
      expect(refused(r.id)[0]?.refusal?.command).toBe("encounter_roll");
      expect(fx.dice).toEqual(SENTINEL);
    } finally {
      spy.restore();
    }
  });

  it("a quick roll by hand that succeeds is still immediate: no form, no refusal", async () => {
    const aerin = ok(await docs().importCharacter(await fighter(fx.engine, 3)));
    const id = await encounterOf(aerin.id, "aerin", true);
    await renderApp(`/encounters/${id}`);
    const options = await screen.findByRole("region", { name: "Options" }, { timeout: 15_000 });
    await userEvent.click(within(options).getByRole("tab", { name: /Bonus Action/ }));
    const before = docs().encounters[id]?.encounter;
    fx.dice.push(4);
    await userEvent.click(await within(options).findByRole("button", { name: /^Second Wind/ }));
    await waitFor(() => expect(docs().encounters[id]?.encounter).not.toBe(before));
    expect(screen.queryByRole("region", { name: /^Second Wind/ })).toBeNull();
    expect(refused(aerin.id)).toHaveLength(0);
  });
});

describe("Combat: Bardic Inspiration at 0, and the History panel", () => {
  it("Use stays enabled with none left: one tap, one entry; the panel says Not done with the engine's reason", async () => {
    const content = await testContext(fx.engine);
    const id = await storeCharacter(fx.engine, await bard(fx.engine, 5), content);
    for (let i = 0; i < 10; i++)
      if (!(await docs().playAction(id, { type: "use", key: BI })).ok) break;
    const before = docs().characters[id];
    await renderApp(`/characters/${id}/sheet?tab=combat`);
    const use = await screen.findByRole(
      "button",
      { name: /Spend one: Bardic Inspiration/ },
      { timeout: 10_000 },
    );
    expect(use).toBeEnabled();
    await userEvent.click(use);
    await waitFor(() => expect(refused(id)).toHaveLength(1));
    expect(docs().characters[id]).toBe(before);
    await userEvent.click(
      await screen.findByRole("button", { name: "History: what this character played" }),
    );
    const panel = await screen.findByRole("dialog", { name: "History" });
    const line = (
      await within(panel).findAllByTestId("history-entry", {}, { timeout: 10_000 })
    ).find((l) => l.dataset.kind === "refused") as HTMLElement;
    expect(line).toBeDefined();
    expect(line).toHaveTextContent("Not done: Bardic Inspiration");
    expect(within(line).getByTestId("history-refusal")).toHaveTextContent(
      /Refused: .*Bardic Inspiration/,
    );
    expect(within(line).getByTestId("history-costs")).toHaveTextContent("Nothing paid");
    expect(within(line).queryByTestId("history-outcome")).toBeNull();
  });
});

describe("History: results at a glance next to refusals", () => {
  it("refusals push a roll off the page: they follow it, don't change it; older entries show its result", async () => {
    const content = await testContext(fx.engine);
    const id = await storeCharacter(fx.engine, await humanWizard(fx.engine), content);
    fx.dice.push(9, 2, 3);
    ok(await docs().rollByHand(id, { type: "cast", spell: "ray-of-sickness" }));
    // 50 Heroic rerolls without Heroic Inspiration: each refused, each one entry following #1.
    for (let i = 0; i < 50; i++)
      await docs().heroicReroll(
        id,
        { kind: "damage", attack: 0, part: 0, die: 0 },
        {
          command: "heroic_reroll",
          label: "Reroll damage",
        },
      );
    expect(refused(id)).toHaveLength(50);
    await renderApp(`/characters/${id}/sheet`);
    await userEvent.click(
      await screen.findByRole(
        "button",
        { name: "History: what this character played" },
        {
          timeout: 15_000,
        },
      ),
    );
    const panel = await screen.findByRole("dialog", { name: "History" });
    const lines = await within(panel).findAllByTestId("history-entry", {}, { timeout: 10_000 });
    expect(lines).toHaveLength(50);
    expect(lines.every((l) => l.dataset.kind === "refused")).toBe(true);
    const one = lines[0] as HTMLElement;
    expect(one).toHaveTextContent("Not done: Reroll damage");
    expect(within(one).getByTestId("history-context")).toHaveTextContent(/#1/);
    expect(within(one).getByTestId("history-context")).toHaveTextContent(/damage 5/);
    expect(within(panel).getByTestId("history-count")).toHaveTextContent(
      "Showing 50 of 51 entries",
    );
    await act(async () => {
      await userEvent.click(within(panel).getByRole("button", { name: /Show older entries/ }));
    });
    await waitFor(() =>
      expect(within(panel).getByTestId("history-count")).toHaveTextContent("Showing 51 of 51"),
    );
    const roll = within(panel)
      .getAllByTestId("history-entry")
      .find((l) => l.dataset.kind === "sheet_roll") as HTMLElement;
    expect(within(roll).getByTestId("history-outcome")).toHaveTextContent("damage 5");
    expect(within(roll).getByTestId("history-costs")).toHaveTextContent("a level 1 spell slot");
  });

  it("an applied change is said without opening details; rolled damage stays the outcome", async () => {
    const r = ok(await docs().importCharacter(await wizard(fx.engine, 3)));
    ok(await docs().playAction(r.id, { type: "damage", amount: 3 }));
    await renderApp(`/characters/${r.id}/sheet`);
    await userEvent.click(
      await screen.findByRole(
        "button",
        { name: "History: what this character played" },
        {
          timeout: 15_000,
        },
      ),
    );
    const panel = await screen.findByRole("dialog", { name: "History" });
    const [line] = await within(panel).findAllByTestId("history-entry", {}, { timeout: 10_000 });
    // review03 R03-04: what was asked (3 damage) and what it did (HP from its maximum to the
    // stored value), both without opening details; no roll, so no outcome is made up.
    expect(within(line as HTMLElement).getByTestId("history-request")).toHaveTextContent(
      "Requested: 3 damage",
    );
    expect(within(line as HTMLElement).getByTestId("history-applied")).toHaveTextContent(
      /Applied: HP: max → \d+/,
    );
    expect(within(line as HTMLElement).queryByTestId("history-outcome")).toBeNull();
  });
});

describe("History: a readable result without opening details (review03 R03-04)", () => {
  const openPanel = async () => {
    await userEvent.click(
      await screen.findByRole(
        "button",
        { name: "History: what this character played" },
        { timeout: 15_000 },
      ),
    );
    return screen.findByRole("dialog", { name: "History" });
  };
  /** An entry's text as shown collapsed (its details element left out). */
  const collapsed = (line: HTMLElement) => {
    const clone = line.cloneNode(true) as HTMLElement;
    for (const d of clone.querySelectorAll("details")) d.remove();
    return clone.textContent ?? "";
  };

  it("a check rolled on the sheet: the entry says the dice, bonus and total the tray showed", async () => {
    const r = ok(await docs().importCharacter(await wizard(fx.engine, 3)));
    await renderApp(`/characters/${r.id}/sheet`);
    fx.dice.push(6);
    await userEvent.click(
      await screen.findByRole("button", { name: /^Arcana \+\d+: / }, { timeout: 10_000 }),
    );
    const [tray] = await screen.findAllByRole("region", { name: "Dice results" });
    const test = sessionEntries(r.id).at(-1)?.result as { total: number; bonus: number };
    expect(tray).toHaveTextContent(String(test.total));
    const panel = await openPanel();
    const [line] = await within(panel).findAllByTestId("history-entry", {}, { timeout: 10_000 });
    const dice = within(line as HTMLElement).getByTestId("history-dice");
    expect(dice).toHaveTextContent(`[6] +${test.bonus} = ${test.total}`);
    expect(tray).toHaveTextContent("6");
    // No DC was asked: nothing says success or failure.
    expect(collapsed(line as HTMLElement)).not.toMatch(/Success|Failure/);
  });

  it("a reroll changes the group's current dice; Undo and Redo bring them back; the root off the page", async () => {
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
    ok(await docs().rollByHand(id, { type: "cast", spell: "ray-of-sickness" }));
    fx.dice.push(7);
    ok(await docs().heroicReroll(id, { kind: "damage", attack: 0, part: 0, die: 0 }));
    for (let i = 0; i < 49; i++) {
      fx.dice.push(10);
      ok(await docs().rollTest(id, { skill: "arcana" }));
    }
    await renderApp(`/characters/${id}/sheet`);
    const panel = await openPanel();
    const current = () =>
      within(panel)
        .getAllByTestId("history-group")
        .map((g) => within(g).queryByTestId("history-current"))
        .find(Boolean) as HTMLElement;
    await waitFor(() => expect(current()).toBeTruthy());
    expect(current()).toHaveTextContent("damage 10");
    expect(current()).toHaveTextContent("[7, 3]");
    // The roll's own line keeps what was rolled first.
    const root = within(panel)
      .getAllByTestId("history-entry")
      .find((l) => l.dataset.kind === "sheet_roll") as HTMLElement;
    expect(within(root).getByTestId("history-dice")).toHaveTextContent("[2, 3]");
    await act(() => docs().undo(id));
    await waitFor(() => expect(current()).toHaveTextContent("[2, 3]"));
    expect(current()).toHaveTextContent("damage 5");
    await act(() => docs().redo(id));
    await waitFor(() => expect(current()).toHaveTextContent("[7, 3]"));
  });

  it("healing and a use: what was asked and what it did, nothing rolled or made up", async () => {
    const content = await testContext(fx.engine);
    const id = await storeCharacter(fx.engine, await bard(fx.engine, 5), content);
    ok(await docs().playAction(id, { type: "damage", amount: 5, damage_type: "fire" }));
    ok(await docs().playAction(id, { type: "heal", amount: 2 }));
    ok(await docs().playAction(id, { type: "use", key: BI }));
    await renderApp(`/characters/${id}/sheet`);
    const panel = await openPanel();
    const lines = await within(panel).findAllByTestId("history-entry", {}, { timeout: 10_000 });
    const [use, heal, damage] = lines as HTMLElement[];
    expect(collapsed(damage as HTMLElement)).toMatch(/Requested: 5 fire damage/);
    expect(collapsed(damage as HTMLElement)).toMatch(/Applied: HP: max → \d+/);
    expect(collapsed(heal as HTMLElement)).toMatch(/Requested: healing 2 HP/);
    expect(collapsed(heal as HTMLElement)).toMatch(/Applied: HP: \d+ → \d+/);
    expect(collapsed(use as HTMLElement)).toMatch(/Requested: use Bardic Inspiration/);
    expect(collapsed(use as HTMLElement)).toMatch(/Bardic Inspiration used: — → 1/);
    for (const l of [use, heal, damage]) {
      expect(within(l as HTMLElement).queryByTestId("history-outcome")).toBeNull();
      expect(within(l as HTMLElement).queryByTestId("history-dice")).toBeNull();
    }
  });

  it("a request is never shown as its effect: a healing capped at the maximum, damage taken by temporary HP", async () => {
    const r = ok(await docs().importCharacter(await wizard(fx.engine, 3)));
    ok(await docs().playAction(r.id, { type: "damage", amount: 3 }));
    ok(await docs().playAction(r.id, { type: "heal", amount: 20 }));
    ok(await docs().playAction(r.id, { type: "set_temp_hp", amount: 5 }));
    ok(await docs().playAction(r.id, { type: "damage", amount: 3 }));
    const record = docs().characters[r.id];
    if (!record) throw new Error("no record");
    const max = (await fx.engine.playSheet(record.build, record.state)).sheet.play.hp.max;
    // Still at the maximum: the 3 points went to the temporary HP (5 → 2).
    expect(record.state.hp).toMatchObject({ current: max, temp: 2 });
    await renderApp(`/characters/${r.id}/sheet`);
    const panel = await openPanel();
    const lines = (
      await within(panel).findAllByTestId("history-entry", {}, { timeout: 10_000 })
    ).map((l) => collapsed(l as HTMLElement));
    const [absorbed, temp, heal, hurt] = lines;
    // 20 asked, only back to the maximum: the request says 20 as asked, the effect says max.
    expect(heal).toMatch(/Requested: healing 20 HP/);
    expect(heal).toMatch(/Applied: HP: \d+ → max/);
    expect(heal).not.toMatch(/Heals 20/);
    // 3 asked, all taken by temporary HP: the effect is the temporary HP's; HP stays at its maximum
    // (stored as the explicit value now: "max → <max>", as recorded, no loss claimed).
    expect(absorbed).toMatch(/Requested: 3 damage/);
    expect(absorbed).toMatch(/temporary HP: 5 → 2/);
    expect(absorbed).toMatch(new RegExp(`Applied: HP: max → ${max}\\b`));
    expect(temp).toMatch(/Requested: 5 temporary HP/);
    expect(hurt).toMatch(/Requested: 3 damage/);
    expect(hurt).toMatch(/Applied: HP: max → \d+/);
  });
});
