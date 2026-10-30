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

describe("Encounter: a tile refused only for a resource is the player's attempt", () => {
  it("Second Wind with no use left: the tile sends one command, one entry; a tile refused for the economy stays inert", async () => {
    const aerin = ok(await docs().importCharacter(await fighter(fx.engine, 3)));
    for (let i = 0; i < 5; i++)
      if (
        !(await docs().playAction(aerin.id, { type: "use_feature", key: "fighter:second-wind" })).ok
      )
        break;
    const record = docs().characters[aerin.id];
    if (!record) throw new Error("no record");
    const party = { [aerin.id]: { build: record.build, state: record.state } };
    const r = await fx.engine.applyEncounterAction(await fx.engine.newEncounter(), party, [
      { type: "add_character", character: aerin.id },
      { type: "add_monster", monster: "goblin-warrior" },
      { type: "set_initiative", id: "aerin", value: 20 },
      { type: "set_initiative", id: "goblin-warrior", value: 5 },
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
    useUi.setState({ role: { kind: "player", character: aerin.id } });
    const sent: unknown[] = [];
    const apply = fx.engine.applyEncounterAction;
    fx.engine.applyEncounterAction = (encounter, p, action, world) => {
      sent.push(action);
      return apply(encounter, p, action, world);
    };
    try {
      await renderApp(`/encounters/${id}`);
      const options = await screen.findByRole("region", { name: "Options" }, { timeout: 15_000 });
      await userEvent.click(within(options).getByRole("tab", { name: /Bonus Action/ }));
      const wind = await within(options).findByRole("button", { name: /^Second Wind/ });
      expect(wind).toHaveAttribute("aria-disabled", "true");
      expect(wind).toHaveAccessibleDescription(/.+/);
      await userEvent.click(wind);
      await waitFor(() => expect(refused(aerin.id)).toHaveLength(1));
      expect(sent).toHaveLength(1);
      expect(refused(aerin.id)[0]).toMatchObject({
        refusal: { command: "encounter_action", label: expect.stringMatching(/Second Wind/) },
        context: { source: "encounter", encounter_id: id },
      });
      // The action used (Dodge), then an Action tile is refused for the economy: inert, nothing sent.
      await userEvent.click(within(options).getByRole("tab", { name: /^Action/ }));
      await userEvent.click(within(options).getByRole("button", { name: /^Dodge/ }));
      await waitFor(() => expect(sent).toHaveLength(2));
      const dash = await within(options).findByRole("button", { name: /^Dash/ });
      await waitFor(() => expect(dash).toHaveAttribute("aria-disabled", "true"));
      await userEvent.click(dash);
      expect(sent).toHaveLength(2);
      expect(refused(aerin.id)).toHaveLength(1);
    } finally {
      fx.engine.applyEncounterAction = apply;
    }
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
    expect(within(line as HTMLElement).getByTestId("history-applied")).toHaveTextContent(
      /Applied: hp\.current: — → \d+/,
    );
    expect(within(line as HTMLElement).queryByTestId("history-outcome")).toBeNull();
  });
});
