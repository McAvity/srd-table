import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDocuments } from "../../src/store/documents";
import { useRollAdditions, useRolls } from "../../src/store/rolls";
import { useUi } from "../../src/store/ui";
import { fighter } from "../fixtures/characters";
import {
  BI,
  bard,
  humanWizard,
  LUCK,
  RAY,
  storeCharacter,
  testContext,
} from "../fixtures/player-actions";
import { installTestEngine, renderApp, resetStores } from "../helpers/app";

// F-005 on the sheet: the UI picks the action and its payment, the engine computes, the store commits once.

const engine = installTestEngine();
const record = (id: string) => useDocuments.getState().characters[id];

beforeEach(async () => {
  await resetStores();
  useRolls.setState({ last: {} });
  useRollAdditions.setState({ by: {} });
});

async function pinnedBard() {
  const build = await bard(engine);
  const content = await testContext(engine);
  const fresh = await engine.createState(build, content);
  const spent = await engine.applyPlayAction(
    build,
    fresh,
    { type: "use", key: BI, amount: 2 },
    content,
  );
  if (!spent.ok) throw new Error(spent.reasons.join("; "));
  return { id: await storeCharacter(engine, build, content, spent.state), build, content };
}

describe("player actions on the sheet", () => {
  it("Font of Inspiration with a chosen slot: one commit, a use of Bardic Inspiration back", async () => {
    const { id } = await pinnedBard();
    await renderApp(`/characters/${id}/sheet?tab=combat`);
    const row = (await screen.findByText("Font of Inspiration", {}, { timeout: 10_000 })).closest(
      "li",
    ) as HTMLElement;
    await userEvent.selectOptions(within(row).getByRole("combobox"), "2");
    await userEvent.click(within(row).getByRole("button", { name: "Use" }));
    await waitFor(() => expect(record(id)?.state.uses_spent[BI]).toBe(1));
    expect(record(id)?.state.spell_slots_spent).toEqual([0, 1]);
    expect(record(id)?.rev).toBe(1);
  });

  it("a free cast picked on the Spells tab spends the free use, not a slot", async () => {
    const { id, build, content } = await pinnedBard();
    const sheet = (await engine.playSheet(build, record(id)?.state as never, content)).sheet;
    const spell = sheet.spells.find((s) => s.free.length > 0);
    const use = spell?.free[0]?.use as string;
    await renderApp(`/characters/${id}/sheet?tab=spells`);
    const row = (
      await screen.findAllByText(spell?.name as string, {}, { timeout: 10_000 })
    )[0]?.closest("li") as HTMLElement;
    await userEvent.selectOptions(
      within(row).getByRole("combobox", { name: /slot level/ }),
      `free:${use}`,
    );
    await userEvent.click(within(row).getByRole("button", { name: "Roll" }));
    await waitFor(() => expect(record(id)?.state.uses_spent[use]).toBe(1));
    expect(record(id)?.state.spell_slots_spent ?? []).toEqual([]);
  });

  it("a feature's die by hand, then Heroic Inspiration from the last-roll panel: the use stays spent once", async () => {
    const { id } = await pinnedBard();
    await useDocuments.getState().playAction(id, { type: "set_inspiration", value: true });
    await renderApp(`/characters/${id}/sheet?tab=combat`);
    const row = (await screen.findByText("Test Taunt", {}, { timeout: 10_000 })).closest(
      "li",
    ) as HTMLElement;
    await userEvent.click(within(row).getByRole("button", { name: "By hand" }));
    await waitFor(() => expect(record(id)?.state.uses_spent["species:human:test-spur"]).toBe(1));
    const panel = await screen.findByRole("region", { name: "Last roll" });
    await userEvent.click(within(panel).getByRole("button", { name: /^Reroll 1d8/ }));
    await waitFor(() => expect(record(id)?.state.heroic_inspiration).toBe(false));
    expect(record(id)?.state.uses_spent["species:human:test-spur"]).toBe(1);
  });

  it("Grapple from the sheet shows what the save decides", async () => {
    const build = await fighter(engine, 3);
    const id = await storeCharacter(engine, build);
    await renderApp(`/characters/${id}/sheet?tab=combat`);
    await userEvent.click(
      await screen.findByRole("button", { name: "Grapple" }, { timeout: 10_000 }),
    );
    await waitFor(() =>
      expect(
        useUi
          .getState()
          .toasts.flatMap((x) => x.lines)
          .some((l) => /Grapple, DC \d+/.test(l)),
      ).toBe(true),
    );
  });

  it("the GM's modifier set on the sheet reaches the next check, listed in the result", async () => {
    const build = await fighter(engine, 3);
    const id = await storeCharacter(engine, build);
    await renderApp(`/characters/${id}/sheet`);
    const options = await screen.findByRole(
      "region",
      { name: "GM additions to the next rolls" },
      { timeout: 10_000 },
    );
    const modifier = within(options).getByLabelText("Modifier");
    await userEvent.type(modifier, "3");
    await userEvent.tab();
    await userEvent.click(screen.getByRole("button", { name: /^Athletics .*Roll$/ }));
    await waitFor(() => {
      const last = useRolls.getState().last[id];
      expect(last?.kind === "test" ? last.test.modifiers : null).toEqual([
        { label: "GM", value: 3 },
      ]);
    });
  });

  it("a Short Rest one die at a time: Cancel saves nothing; Confirm is one commit and a short-rest use comes back once", async () => {
    const build = await fighter(engine, 3);
    const id = await storeCharacter(engine, build);
    await useDocuments.getState().playAction(id, [
      { type: "use", key: "fighter:second-wind", amount: 2 },
      { type: "damage", amount: 20 },
    ]);
    const before = record(id);
    await renderApp(`/characters/${id}/sheet`);
    await userEvent.click(
      await screen.findByRole("button", { name: "Short Rest" }, { timeout: 10_000 }),
    );
    let dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Spend a d10" }));
    await within(dialog).findByTestId("rest-preview", {}, { timeout: 10_000 });
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(record(id)).toBe(before);
    await userEvent.click(screen.getByRole("button", { name: "Short Rest" }));
    dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Spend a d10" }));
    await within(dialog).findByTestId("rest-preview", {}, { timeout: 10_000 });
    await userEvent.click(within(dialog).getByRole("button", { name: "Spend a d10" }));
    await waitFor(() =>
      expect(within(dialog).getByTestId("rest-dice").textContent).toMatch(/d10: \d+, d10: \d+/),
    );
    await userEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(record(id)?.state.hit_dice_spent["10"]).toBe(2));
    expect(record(id)?.rev).toBe((before?.rev ?? 0) + 1);
    expect(record(id)?.state.uses_spent["fighter:second-wind"]).toBe(1);
  });
});

// Independent manager reproductions: intentionally assert required behavior.
describe("manager rest regressions", () => {
  it("cannot confirm while the hit die is pending", async () => {
    const build = await fighter(engine, 3);
    const id = await storeCharacter(engine, build);
    await renderApp(`/characters/${id}/sheet`);
    await userEvent.click(await screen.findByRole("button", { name: "Short Rest" }));
    const dialog = await screen.findByRole("dialog");
    const original = engine.roll.bind(engine);
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const spy = vi.spyOn(engine, "roll").mockImplementation(async (...args) => {
      await gate;
      return original(...args);
    });
    try {
      await userEvent.click(within(dialog).getByRole("button", { name: "Spend a d10" }));
      expect(within(dialog).getByRole("button", { name: "Confirm" })).toBeDisabled();
    } finally {
      release();
      spy.mockRestore();
    }
  });
  it("does not carry cancelled asynchronous dice into the next rest", async () => {
    const build = await fighter(engine, 3);
    const id = await storeCharacter(engine, build);
    await renderApp(`/characters/${id}/sheet`);
    await userEvent.click(await screen.findByRole("button", { name: "Short Rest" }));
    let dialog = await screen.findByRole("dialog");
    const original = engine.roll.bind(engine);
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const spy = vi.spyOn(engine, "roll").mockImplementation(async (...args) => {
      await gate;
      return original(...args);
    });
    await userEvent.click(within(dialog).getByRole("button", { name: "Spend a d10" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await userEvent.click(screen.getByRole("button", { name: "Short Rest" }));
    dialog = await screen.findByRole("dialog");
    release();
    spy.mockRestore();
    await waitFor(() => expect(within(dialog).queryByTestId("rest-preview")).not.toBeNull());
    expect(within(dialog).queryByTestId("rest-dice")).toBeNull();
  });
});

// Review 04: the Short Rest dialog's asynchronous steps, Lucky declared before a roll by hand, Heroic Inspiration on
// an attack's bonus and damage dice, free damage closing the last roll, Initiative and a spell blocked by armour.
function gate<K extends "roll" | "applyPlayAction">(name: K) {
  const original = engine[name].bind(engine) as (...args: unknown[]) => Promise<unknown>;
  let release!: () => void;
  const held = new Promise<void>((r) => {
    release = r;
  });
  const calls: Promise<unknown>[] = [];
  const spy = vi.spyOn(engine, name).mockImplementation(((...args: unknown[]) => {
    const call = held.then(() => original(...args));
    calls.push(call);
    return call;
  }) as never);
  return {
    calls,
    async open() {
      release();
      await Promise.all(calls);
      spy.mockRestore();
    },
  };
}

async function openShortRest(id: string) {
  await renderApp(`/characters/${id}/sheet`);
  await userEvent.click(
    await screen.findByRole("button", { name: "Short Rest" }, { timeout: 10_000 }),
  );
  const dialog = await screen.findByRole("dialog");
  await within(dialog).findByTestId("rest-preview", {}, { timeout: 10_000 });
  return dialog;
}

describe("the Short Rest dialog's steps (review 04)", () => {
  it("a double click while the die is pending rolls one die; Confirm waits for it", async () => {
    const id = await storeCharacter(engine, await fighter(engine, 3));
    const dialog = await openShortRest(id);
    const held = gate("roll");
    await userEvent.dblClick(within(dialog).getByRole("button", { name: "Spend a d10" }));
    expect(within(dialog).getByRole("button", { name: "Confirm" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Spend a d10" })).toBeDisabled();
    await held.open();
    expect(held.calls).toHaveLength(1);
    await waitFor(() =>
      expect(within(dialog).getByTestId("rest-dice").textContent).toMatch(/^Rolled: d10: \d+$/),
    );
    await waitFor(() =>
      expect(within(dialog).getByRole("button", { name: "Confirm" })).toBeEnabled(),
    );
    await userEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(record(id)?.state.hit_dice_spent["10"]).toBe(1));
    expect(record(id)?.rev).toBe(1);
  });

  it("Cancel while the die and the preview are pending: the next rest gets neither, and rolls its own", async () => {
    const id = await storeCharacter(engine, await fighter(engine, 3));
    let dialog = await openShortRest(id);
    const held = gate("applyPlayAction");
    await userEvent.click(within(dialog).getByRole("button", { name: "Spend a d10" }));
    await waitFor(() => expect(held.calls.length).toBeGreaterThan(0));
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await userEvent.click(screen.getByRole("button", { name: "Short Rest" }));
    dialog = await screen.findByRole("dialog");
    await held.open();
    await within(dialog).findByTestId("rest-preview", {}, { timeout: 10_000 });
    expect(within(dialog).queryByTestId("rest-dice")).toBeNull();
    await userEvent.click(within(dialog).getByRole("button", { name: "Spend a d10" }));
    await waitFor(() =>
      expect(within(dialog).getByTestId("rest-dice").textContent).toMatch(/^Rolled: d10: \d+$/),
    );
    expect(record(id)?.rev).toBe(0);
  });

  it("an import replacing the record between the preview and Confirm: the rest starts again on it, the old dice never committed", async () => {
    const id = await storeCharacter(engine, await fighter(engine, 3));
    const dialog = await openShortRest(id);
    await userEvent.click(within(dialog).getByRole("button", { name: "Spend a d10" }));
    await within(dialog).findByTestId("rest-dice", {}, { timeout: 10_000 });
    const current = record(id);
    if (!current) throw new Error("no record");
    useDocuments.setState((s) => ({
      characters: { ...s.characters, [id]: { ...current, gen: 1, rev: 5 } },
    }));
    await within(dialog).findByText(/The character changed meanwhile/);
    expect(within(dialog).queryByTestId("rest-dice")).toBeNull();
    await within(dialog).findByTestId("rest-preview", {}, { timeout: 10_000 });
    await waitFor(() =>
      expect(within(dialog).getByRole("button", { name: "Confirm" })).toBeEnabled(),
    );
    await userEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(record(id)?.rev).toBe(6));
    expect(record(id)?.gen).toBe(1);
    expect(record(id)?.state.hit_dice_spent["10"] ?? 0).toBe(0);
  });

  it("another change of the character while the dialog is open: the rest starts again, nothing of the old one kept", async () => {
    const id = await storeCharacter(engine, await fighter(engine, 3));
    const dialog = await openShortRest(id);
    await userEvent.click(within(dialog).getByRole("button", { name: "Spend a d10" }));
    await within(dialog).findByTestId("rest-dice", {}, { timeout: 10_000 });
    await useDocuments.getState().playAction(id, { type: "damage", amount: 4 });
    await within(dialog).findByText(/The character changed meanwhile/);
    expect(within(dialog).queryByTestId("rest-dice")).toBeNull();
    expect(record(id)?.state.hit_dice_spent["10"] ?? 0).toBe(0);
  });

  it("a Hit Die rolled in the rest closes the window of the character's last roll", async () => {
    const id = await storeCharacter(engine, await fighter(engine, 3));
    await useDocuments.getState().playAction(id, { type: "set_inspiration", value: true });
    await useDocuments.getState().rollTest(id, { skill: "athletics" });
    const dialog = await openShortRest(id);
    // The dialog is modal: the page behind it is hidden from the accessibility tree.
    const panel = { name: "Last roll", hidden: true };
    expect(screen.getByRole("region", panel)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Spend a d10" }));
    await within(dialog).findByTestId("rest-dice", {}, { timeout: 10_000 });
    expect(useRolls.getState().last[id]).toBeUndefined();
    expect(screen.queryByRole("region", panel)).toBeNull();
  });
});

describe("Lucky declared before a roll by hand (review 04, §5.4)", () => {
  async function declare(id: string) {
    const options = await screen.findByRole(
      "region",
      { name: "GM additions to the next rolls" },
      { timeout: 10_000 },
    );
    await userEvent.selectOptions(within(options).getByLabelText("Advantage declared with"), LUCK);
    return options;
  }

  it("a weapon attack By hand: Advantage from the engine and the use in the attack's commit; the choice then cleared", async () => {
    const { id } = await pinnedBard();
    await renderApp(`/characters/${id}/sheet?tab=combat`);
    const options = await declare(id);
    const row = (await screen.findByRole("rowheader", { name: /^Dagger/ })).closest(
      "tr",
    ) as HTMLElement;
    await userEvent.click(within(row).getByRole("button", { name: "Roll" }));
    await waitFor(() => expect(record(id)?.state.uses_spent[LUCK]).toBe(1));
    expect(record(id)?.rev).toBe(1);
    const last = useRolls.getState().last[id];
    expect(last?.kind === "sheet" ? last.roll.rolls.attacks[0]?.roll.mode : null).toBe("advantage");
    await waitFor(() =>
      expect(within(options).getByLabelText("Advantage declared with")).toHaveValue(""),
    );
  });

  it("a spell attack By hand: its slot and the use once, one commit", async () => {
    const build = await humanWizard(engine);
    const content = await testContext(engine);
    const id = await storeCharacter(engine, build, content);
    await renderApp(`/characters/${id}/sheet?tab=spells`);
    await declare(id);
    const row = (
      await screen.findAllByText("Ray of Sickness", {}, { timeout: 10_000 })
    )[0]?.closest("li") as HTMLElement;
    await userEvent.click(within(row).getByRole("button", { name: "Roll" }));
    await waitFor(() => expect(record(id)?.state.uses_spent[LUCK]).toBe(1));
    expect(record(id)?.state.spell_slots_spent).toEqual([1]);
    expect(record(id)?.rev).toBe(1);
    const last = useRolls.getState().last[id];
    expect(last?.kind === "sheet" ? last.roll.rolls.attacks[0]?.roll.mode : null).toBe("advantage");
  });

  it("no use left by the time of the roll: refused with the engine's reason, nothing changed, the choice kept", async () => {
    const { id } = await pinnedBard();
    await renderApp(`/characters/${id}/sheet?tab=combat`);
    await declare(id);
    await useDocuments.getState().playAction(id, { type: "use", key: LUCK, amount: 3 });
    const before = record(id);
    const refusal = await engine.applyPlayAction(
      before?.build as never,
      before?.state as never,
      { type: "use", key: LUCK },
      before?.content,
    );
    if (refusal.ok) throw new Error("a use was still left");
    const row = (await screen.findByRole("rowheader", { name: /^Dagger/ })).closest(
      "tr",
    ) as HTMLElement;
    await userEvent.click(within(row).getByRole("button", { name: "Roll" }));
    const section = row.closest("section") as HTMLElement;
    expect(await within(section).findByText(refusal.reasons[0] as string)).toBeInTheDocument();
    expect(record(id)).toBe(before);
    expect(useRollAdditions.getState().by[id]?.lucky).toBe(LUCK);
  });
});

describe("the last roll on the sheet (review 04)", () => {
  async function inspiredFighter() {
    const build = await fighter(engine, 3);
    const id = await storeCharacter(engine, build);
    await useDocuments.getState().playAction(id, { type: "set_inspiration", value: true });
    const sheet = (await engine.playSheet(build, record(id)?.state as never)).sheet;
    const line = sheet.attacks.find((a) => a.damage_parts.some((p) => p.dice));
    if (!line) throw new Error("no attack with dice");
    return { id, line };
  }
  const attackRow = async (name: string) =>
    (
      await screen.findByRole("rowheader", { name: new RegExp(`^${name}`) }, { timeout: 10_000 })
    ).closest("tr") as HTMLElement;

  it("Heroic Inspiration on the GM's bonus die of an attack By hand: that die again, nothing paid again", async () => {
    const { id, line } = await inspiredFighter();
    await renderApp(`/characters/${id}/sheet?tab=combat`);
    const options = await screen.findByRole(
      "region",
      { name: "GM additions to the next rolls" },
      { timeout: 10_000 },
    );
    await userEvent.type(within(options).getByLabelText("Bonus die"), "1d4");
    await userEvent.tab();
    await userEvent.click(within(await attackRow(line.name)).getByRole("button", { name: "Roll" }));
    const panel = await screen.findByRole("region", { name: "Last roll" });
    const rev = record(id)?.rev ?? 0;
    const state = record(id)?.state;
    await userEvent.click(within(panel).getByRole("button", { name: /^Reroll GM \(\d\)$/ }));
    await waitFor(() => expect(record(id)?.state.heroic_inspiration).toBe(false));
    expect(record(id)?.rev).toBe(rev + 1);
    expect({ ...record(id)?.state, heroic_inspiration: true }).toEqual(state);
    const last = useRolls.getState().last[id];
    const attack = last?.kind === "sheet" ? last.roll.rolls.attacks[0] : undefined;
    expect(attack?.bonus_dice[0]?.rolls).toHaveLength(1);
    expect(attack?.total).toBe(
      (attack?.roll.d20 ?? 0) + (attack?.bonus ?? 0) + (attack?.bonus_dice[0]?.total ?? 0),
    );
  });

  it("Heroic Inspiration on an attack's damage die from the panel: the damage again from that die only", async () => {
    const { id, line } = await inspiredFighter();
    await renderApp(`/characters/${id}/sheet?tab=combat`);
    await userEvent.click(within(await attackRow(line.name)).getByRole("button", { name: "Roll" }));
    const panel = await screen.findByRole("region", { name: "Last roll" });
    const before = useRolls.getState().last[id];
    const damage = before?.kind === "sheet" ? before.roll.rolls.attacks[0]?.damage : null;
    const part = damage?.parts.findIndex((p) => p.dice) ?? -1;
    const buttons = within(panel).getAllByRole("button", { name: /^Reroll damage / });
    await userEvent.click(buttons[0] as HTMLElement);
    await waitFor(() => expect(record(id)?.state.heroic_inspiration).toBe(false));
    const last = useRolls.getState().last[id];
    const after = last?.kind === "sheet" ? last.roll.rolls.attacks[0]?.damage : null;
    const p = after?.parts[part];
    expect(p?.rolls).toHaveLength(damage?.parts[part]?.rolls.length ?? -1);
    expect(p?.total).toBe(
      Math.max(0, (p?.rolls ?? []).reduce((a, b) => a + b, 0) + (p?.bonus ?? 0)),
    );
  });

  it("free Damage, then Critical: each is the last roll (the attack's window closes), Heroic on its die", async () => {
    const { id, line } = await inspiredFighter();
    await renderApp(`/characters/${id}/sheet?tab=combat`);
    const row = await attackRow(line.name);
    await userEvent.click(within(row).getByRole("button", { name: `${line.name}: attack` }));
    const panel = await screen.findByRole("region", { name: "Last roll" });
    await within(panel).findByRole("button", { name: /^Reroll d20/ });
    await userEvent.click(within(row).getByRole("button", { name: `${line.name}: Damage` }));
    await waitFor(() => expect(useRolls.getState().last[id]?.kind).toBe("damage"));
    expect(within(panel).queryByRole("button", { name: /^Reroll d20/ })).toBeNull();
    await userEvent.click(within(row).getByRole("button", { name: `${line.name}: Critical Hit!` }));
    await waitFor(() => {
      const last = useRolls.getState().last[id];
      expect(last?.kind === "damage" ? last.damage.critical : null).toBe(true);
    });
    expect(record(id)?.rev).toBe(1);
    await userEvent.click(
      within(panel).getAllByRole("button", { name: /^Reroll damage / })[0] as HTMLElement,
    );
    await waitFor(() => expect(record(id)?.state.heroic_inspiration).toBe(false));
  });

  it("Initiative from the sheet: the engine's test, the last roll", async () => {
    const id = await storeCharacter(engine, await fighter(engine, 3));
    await renderApp(`/characters/${id}/sheet`);
    await userEvent.click(
      await screen.findByRole("button", { name: /^Init [+-]\d+: Roll$/ }, { timeout: 10_000 }),
    );
    await waitFor(() => expect(useRolls.getState().last[id]?.kind).toBe("test"));
    const last = useRolls.getState().last[id];
    const sheet = (await engine.playSheet(record(id)?.build as never, record(id)?.state as never))
      .sheet;
    expect(last?.kind === "test" ? last.test.total - last.test.roll.d20 : null).toBe(
      sheet.initiative.total,
    );
    expect(await screen.findByRole("region", { name: "Last roll" })).toBeInTheDocument();
  });

  it("a spell blocked by armour without training: the engine's reason shown, Roll disabled", async () => {
    const build = await humanWizard(engine);
    const content = await testContext(engine);
    const fresh = await engine.createState(build, content);
    const added = await engine.applyPlayAction(
      build,
      fresh,
      { type: "add_item", item: "chain-mail" },
      content,
    );
    if (!added.ok) throw new Error(added.reasons.join("; "));
    const armour = added.state.inventory.at(-1)?.id as string;
    const worn = await engine.applyPlayAction(
      build,
      added.state,
      { type: "equip", id: armour, equipped: true },
      content,
    );
    if (!worn.ok) throw new Error(worn.reasons.join("; "));
    const sheet = (await engine.playSheet(build, worn.state, content)).sheet;
    const blocked = sheet.spells.find((s) => s.id === RAY)?.blocked?.text;
    expect(blocked).toBeTruthy();
    const id = await storeCharacter(engine, build, content, worn.state);
    await renderApp(`/characters/${id}/sheet?tab=spells`);
    const row = (
      await screen.findAllByText("Ray of Sickness", {}, { timeout: 10_000 })
    )[0]?.closest("li") as HTMLElement;
    expect(within(row).getByText(blocked as string)).toBeInTheDocument();
    expect(within(row).getByRole("button", { name: "Roll" })).toBeDisabled();
  });
});
