import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Encounter, EncounterAction } from "srd-rules-engine";
import { beforeEach, describe, expect, it } from "vitest";
import { setEngine } from "../../src/engine/client";
import type { RolledResult } from "../../src/engine/facade";
import { nodeFacade } from "../../src/engine/node";
import { useTableUi } from "../../src/features/encounter/tableUi";
import { newId, useDocuments } from "../../src/store/documents";
import { useUi } from "../../src/store/ui";
import { fighter, rogue } from "../fixtures/characters";
import { installTestEngine, renderApp, resetStores } from "../helpers/app";

const engine = installTestEngine(13);
beforeEach(async () => {
  await resetStores();
  setEngine(engine);
});

function storeEncounter(encounter: Encounter): string {
  const id = newId("e");
  useDocuments.setState((s) => ({
    encounters: {
      ...s.encounters,
      [id]: { id, name: "Test", encounter, log: [], created: 0, updated: 0 },
    },
    revs: { ...s.revs, [id]: 1 },
  }));
  return id;
}

describe("encounter table", () => {
  it("lists the acting combatant's options, unavailable ones with the engine's reason", async () => {
    const aerin = await useDocuments.getState().importCharacter(await fighter(engine, 3));
    if (!aerin.ok) throw new Error("import");
    const record = useDocuments.getState().characters[aerin.id];
    if (!record) throw new Error("import");
    const party = { [aerin.id]: { build: record.build, state: record.state } };
    const r = await engine.applyEncounterAction(await engine.newEncounter(), party, [
      { type: "add_character", character: aerin.id },
      { type: "add_monster", monster: "goblin-warrior" },
      { type: "set_initiative", id: "aerin", value: 20 },
      { type: "set_initiative", id: "goblin-warrior", value: 5 },
      { type: "start" },
    ]);
    if (!r.ok) throw new Error(r.reasons.join("; "));
    const id = storeEncounter(r.encounter);
    await renderApp(`/encounters/${id}`);

    const options = await screen.findByRole("region", { name: "Options" }, { timeout: 15_000 });
    // Dodge has nothing to fill in: it's sent at once, and the log shows the engine's note.
    await userEvent.click(within(options).getByRole("button", { name: /^Dodge/ }));
    await waitFor(() =>
      expect(useDocuments.getState().encounters[id]?.encounter.combatants[0]?.dodging).toBe(true),
    );
    expect(await screen.findByRole("region", { name: "Log" })).toHaveTextContent(/Dodge/);

    // With the action spent, the Action tiles stay listed, greyed, each with the engine's reason.
    const after = await screen.findByRole("region", { name: "Options" });
    await waitFor(() => {
      const disabled = within(after)
        .getAllByRole("button")
        .filter((b) => b.getAttribute("aria-disabled") === "true");
      expect(disabled.length).toBeGreaterThan(0);
      for (const tile of disabled) expect(tile).toHaveAccessibleDescription(/.+/);
    });
  });

  it("asks a decision after a roll and answers it with decide", async () => {
    // Find dice where the blue dragon fails its save against the red dragon's breath.
    let found: { encounter: Encounter; seed: number } | null = null;
    for (let seed = 1; seed < 200 && !found; seed++) {
      const e = nodeFacade({ seed });
      const r = await e.applyEncounterAction(await e.newEncounter({ decisions: "ask" }), {}, [
        { type: "add_monster", monster: "adult-red-dragon" },
        { type: "add_monster", monster: "adult-blue-dragon" },
        { type: "set_initiative", id: "adult-red-dragon", value: 20 },
        { type: "set_initiative", id: "adult-blue-dragon", value: 5 },
        { type: "start" },
        {
          type: "save_action",
          id: "adult-red-dragon",
          ability: "Fire Breath",
          targets: ["adult-blue-dragon"],
        },
      ]);
      if (r.ok && r.pending) found = { encounter: r.encounter, seed };
    }
    if (!found) throw new Error("no seed gives a failed save");
    setEngine(nodeFacade({ seed: found.seed }));
    const id = storeEncounter(found.encounter);
    await renderApp(`/encounters/${id}`);

    const dialog = await screen.findByRole("dialog", {}, { timeout: 15_000 });
    expect(dialog).toHaveTextContent(found.encounter.pending?.question ?? "");
    // The recommendation is pre-selected (focused), not applied.
    expect(useDocuments.getState().encounters[id]?.encounter.pending).not.toBeNull();
    await userEvent.click(within(dialog).getByRole("button", { name: /Yes, use it/ }));
    await waitFor(() =>
      expect(useDocuments.getState().encounters[id]?.encounter.pending).toBeNull(),
    );
    expect(
      useDocuments.getState().encounters[id]?.encounter.combatants[1]?.legendary_resistance_used,
    ).toBe(1);
  });

  it("hides monsters' HP numbers from a player", async () => {
    const r = await engine.applyEncounterAction(await engine.newEncounter(), {}, [
      { type: "add_monster", monster: "goblin-warrior" },
    ]);
    if (!r.ok) throw new Error("setup");
    const id = storeEncounter(r.encounter);
    useUi.setState({ role: { kind: "player", character: null } });
    await renderApp(`/encounters/${id}`);
    const rail = await screen.findByRole("navigation", { name: "Initiative" }, { timeout: 15_000 });
    expect(rail).toHaveTextContent("Goblin Warrior");
    expect(rail).not.toHaveTextContent("10/10");
  });

  it("warns when the acting combatant is off a map in use, places it, and ends the turn", async () => {
    const r = await engine.applyEncounterAction(await engine.newEncounter(), {}, [
      { type: "add_monster", monster: "goblin-warrior" },
      { type: "add_monster", monster: "zombie" },
      { type: "place", id: "goblin-warrior", x: 2, y: 2 },
      { type: "set_initiative", id: "zombie", value: 20 },
      { type: "set_initiative", id: "goblin-warrior", value: 5 },
      { type: "start" },
    ]);
    if (!r.ok) throw new Error(r.reasons.join("; "));
    const id = storeEncounter(r.encounter);
    await renderApp(`/encounters/${id}`);

    const notice = await screen.findByText(/Zombie isn't on the map/, {}, { timeout: 15_000 });
    await userEvent.click(
      within(notice.closest("[role=status]") as HTMLElement).getByRole("button", {
        name: "Place Zombie",
      }),
    );
    expect(useTableUi.getState()).toMatchObject({ selected: "zombie", tool: "place" });

    const options = await screen.findByRole("region", { name: "Options" });
    await userEvent.click(within(options).getByRole("button", { name: "End turn" }));
    await waitFor(() => expect(useDocuments.getState().encounters[id]?.encounter.turn).toBe(1));
  });

  it("lets the GM require positions: the engine then refuses an off-map attack", async () => {
    const r = await engine.applyEncounterAction(await engine.newEncounter(), {}, [
      { type: "add_monster", monster: "goblin-warrior" },
      { type: "add_monster", monster: "zombie" },
      { type: "place", id: "goblin-warrior", x: 2, y: 2 },
      { type: "set_initiative", id: "zombie", value: 20 },
      { type: "set_initiative", id: "goblin-warrior", value: 5 },
      { type: "start" },
    ]);
    if (!r.ok) throw new Error(r.reasons.join("; "));
    const id = storeEncounter(r.encounter);
    await renderApp(`/encounters/${id}`);

    expect(await screen.findByText(/aren't checked/, {}, { timeout: 15_000 })).toBeInTheDocument();
    await userEvent.selectOptions(await screen.findByLabelText("Off the map"), "required");
    await waitFor(() =>
      expect(useDocuments.getState().encounters[id]?.encounter.positions).toBe("required"),
    );
    expect(await screen.findByText(/the engine refuses its attacks/)).toBeInTheDocument();
    const options = await screen.findByRole("region", { name: "Options" });
    await waitFor(() =>
      expect(within(options).getAllByText(/Zombie isn't on the map/).length).toBeGreaterThan(0),
    );
  });

  it("links a result's targets to the combatants: a click selects and pings it", async () => {
    const r = await engine.applyEncounterAction(await engine.newEncounter(), {}, [
      { type: "add_monster", monster: "goblin-warrior" },
      { type: "add_monster", monster: "zombie" },
      { type: "place", id: "zombie", x: 3, y: 4 },
      { type: "set_initiative", id: "goblin-warrior", value: 20 },
      { type: "set_initiative", id: "zombie", value: 5 },
      { type: "start" },
    ]);
    if (!r.ok) throw new Error(r.reasons.join("; "));
    const id = storeEncounter(r.encounter);
    await renderApp(`/encounters/${id}`);
    await screen.findByRole("navigation", { name: "Initiative" }, { timeout: 15_000 });
    await waitFor(() => expect(useTableUi.getState().selected).toBe("goblin-warrior"));

    // A save effect's result as the engine gives it: each target with its combatant id.
    const save = { dc: 12, roll: { rolls: [4], d20: 4, mode: "normal" }, bonus: 0, total: 4 };
    useUi.getState().showDice([
      {
        kind: "action",
        who: "Goblin Warrior",
        result: {
          action: "Test",
          targets: [{ id: "zombie", target: 1, name: "Zombie", save: { ...save, success: false } }],
          damage: null,
        } as unknown as RolledResult,
      },
    ]);
    const [tray] = screen.getAllByRole("region", { name: "Dice results" });
    if (!tray) throw new Error("no dice tray");
    const [zombie] = await within(tray).findAllByRole("button", { name: "Zombie" });
    if (!zombie) throw new Error("no target link");
    await userEvent.click(zombie);
    await waitFor(() => expect(useTableUi.getState().selected).toBe("zombie"));
    expect(useTableUi.getState().ping).toMatchObject({ x: 3, y: 4 });
  });

  it("explores outside a fight: the GM's pace, a halt answered, a point revealed", async () => {
    const aerin = await useDocuments.getState().importCharacter(await fighter(engine, 3));
    if (!aerin.ok) throw new Error("import");
    const record = useDocuments.getState().characters[aerin.id];
    if (!record) throw new Error("import");
    const party = { [aerin.id]: { build: record.build, state: record.state } };
    const r = await engine.applyEncounterAction(await engine.newEncounter(), party, [
      { type: "add_character", character: aerin.id },
      { type: "place", id: "aerin", x: 0, y: 0 },
      { type: "set_exploration", notice_stops: "everyone" },
      // DC 0 next to Aerin: noticed at once, and everyone waits.
      { type: "add_point", at: { x: 1, y: 0 }, title: "Loose flagstone", kind: "trap", dc: 0 },
    ]);
    if (!r.ok) throw new Error(r.reasons.join("; "));
    const id = storeEncounter(r.encounter);
    await renderApp(`/encounters/${id}`);

    const explore = await screen.findByRole("region", { name: "Exploration" }, { timeout: 15_000 });
    expect(explore).toHaveTextContent("Everyone waits: Aerin noticed something.");
    await userEvent.click(within(explore).getByRole("button", { name: "Fast" }));
    await waitFor(() =>
      expect(useDocuments.getState().encounters[id]?.encounter.pace).toBe("fast"),
    );

    // The GM opens the noticed point from the halt and reveals it: the halt ends.
    await userEvent.click(within(explore).getByRole("button", { name: "Open the point" }));
    const panel = await screen.findByRole("region", { name: "Loose flagstone" });
    expect(panel).toHaveTextContent("Noticed by Aerin.");
    await userEvent.click(within(panel).getByRole("button", { name: "Reveal" }));
    await waitFor(() => {
      const e = useDocuments.getState().encounters[id]?.encounter;
      expect(e?.points[0]?.revealed).toBe(true);
      expect(e?.halted).toBeNull();
    });
  });

  it("hides points the GM hasn't revealed from players", async () => {
    const r = await engine.applyEncounterAction(await engine.newEncounter(), {}, [
      { type: "add_monster", monster: "goblin-warrior" },
      { type: "add_point", at: { x: 2, y: 2 }, title: "Secret door", kind: "door" },
      { type: "add_point", at: { x: 4, y: 2 }, title: "Old well", revealed: true },
    ]);
    if (!r.ok) throw new Error("setup");
    const id = storeEncounter(r.encounter);
    useUi.setState({ role: { kind: "player", character: null } });
    await renderApp(`/encounters/${id}`);
    const map = await screen.findByRole("region", { name: "Map" }, { timeout: 15_000 });
    expect(within(map).getByRole("button", { name: "Old well" })).toBeInTheDocument();
    expect(within(map).queryByRole("button", { name: /Secret door/ })).toBeNull();
  });

  it("offers Cunning Strike effects on a Rogue's attack, with the engine's reasons", async () => {
    const pip = await useDocuments.getState().importCharacter(await rogue(engine, 5));
    if (!pip.ok) throw new Error(pip.reasons.join("; "));
    const record = useDocuments.getState().characters[pip.id];
    if (!record) throw new Error("import");
    const party = { [pip.id]: { build: record.build, state: record.state } };
    const r = await engine.applyEncounterAction(await engine.newEncounter(), party, [
      { type: "add_character", character: pip.id },
      { type: "add_monster", monster: "goblin-warrior" },
      { type: "set_initiative", id: "pip", value: 20 },
      { type: "set_initiative", id: "goblin-warrior", value: 5 },
      { type: "start" },
    ]);
    if (!r.ok) throw new Error(r.reasons.join("; "));
    const options = await engine.combatantOptions(r.encounter, party, "pip");
    const attack = options.attacks.find((a) => a.strikes.length > 0);
    if (!attack) throw new Error("no attack with Strike effects");
    const id = storeEncounter(r.encounter);
    await renderApp(`/encounters/${id}`);

    const bar = await screen.findByRole("region", { name: "Options" }, { timeout: 15_000 });
    // The first tile with that label (a thrown variant follows it).
    const tile = within(bar).getAllByRole("button", {
      name: new RegExp(`^${literal(attack.label)}`),
    })[0];
    if (!tile) throw new Error("no tile");
    await userEvent.click(tile);
    const composer = await screen.findByRole("group", { name: "Strike effects" });
    for (const x of attack.strikes) {
      const box = within(composer).getByRole("checkbox", { name: new RegExp(x.name) });
      if (x.available) expect(box).toBeEnabled();
      else {
        expect(box).toBeDisabled();
        expect(box).toHaveAccessibleDescription(x.reason ?? "");
      }
    }
  });

  it("plays an attack by hand: costs spent, nothing rolled, the GM applies the outcome", async () => {
    const aerin = await useDocuments.getState().importCharacter(await fighter(engine, 3));
    if (!aerin.ok) throw new Error("import");
    const record = useDocuments.getState().characters[aerin.id];
    if (!record) throw new Error("import");
    const party = { [aerin.id]: { build: record.build, state: record.state } };
    const r = await engine.applyEncounterAction(await engine.newEncounter(), party, [
      { type: "add_character", character: aerin.id },
      { type: "add_monster", monster: "goblin-warrior" },
      { type: "set_initiative", id: "aerin", value: 20 },
      { type: "set_initiative", id: "goblin-warrior", value: 5 },
      { type: "start" },
    ]);
    if (!r.ok) throw new Error(r.reasons.join("; "));
    const options = await engine.combatantOptions(r.encounter, party, "aerin");
    const attack = options.attacks[0];
    if (!attack) throw new Error("no attack");
    const id = storeEncounter(r.encounter);
    await renderApp(`/encounters/${id}`);

    const bar = await screen.findByRole("region", { name: "Options" }, { timeout: 15_000 });
    await userEvent.click(within(bar).getByRole("button", { name: "By hand" }));
    const tile = within(bar).getAllByRole("button", {
      name: new RegExp(`^${literal(attack.label)}`),
    })[0];
    if (!tile) throw new Error("no tile");
    await userEvent.click(tile);
    const composer = await screen.findByRole("region", { name: attack.label });
    const goblin = within(composer).queryByRole("button", {
      name: /Goblin Warrior/,
      pressed: false,
    });
    if (goblin) await userEvent.click(goblin);
    await userEvent.click(await within(composer).findByRole("button", { name: "Do it by hand" }));

    // The attack is spent, nothing is rolled or applied; it waits for the GM.
    await waitFor(() => expect(useDocuments.getState().encounters[id]?.declared).toHaveLength(1));
    const after = useDocuments.getState().encounters[id];
    expect(after?.declared?.[0]?.result).toMatchObject({ manual: true, by: "aerin" });
    expect(after?.encounter.combatants[1]?.hp).toBe(r.encounter.combatants[1]?.hp);
    expect(await screen.findByRole("region", { name: "Log" })).toHaveTextContent(/by hand/);

    const waiting = await screen.findByRole("region", { name: "Waiting for an outcome" });
    await userEvent.type(within(waiting).getByRole("textbox", { name: "Amount" }), "4");
    await userEvent.click(within(waiting).getByRole("button", { name: "Damage" }));
    await waitFor(() =>
      expect(useDocuments.getState().encounters[id]?.encounter.combatants[1]?.hp).toBe(
        (r.encounter.combatants[1]?.hp ?? 0) - 4,
      ),
    );
    await userEvent.click(within(waiting).getByRole("button", { name: "Done" }));
    expect(useDocuments.getState().encounters[id]?.declared).toHaveLength(0);
    expect(screen.queryByRole("region", { name: "Waiting for an outcome" })).toBeNull();

    // Undo (the damage, then the declaration) brings the entry back, then takes it away.
    useDocuments.getState().undo(id);
    expect(useDocuments.getState().encounters[id]?.declared).toHaveLength(1);
    useDocuments.getState().undo(id);
    expect(useDocuments.getState().encounters[id]?.declared).toHaveLength(0);
  });

  it("waits for dice rolled at the table and sends them as enter_roll", async () => {
    const aerin = await useDocuments.getState().importCharacter(await fighter(engine, 3));
    if (!aerin.ok) throw new Error("import");
    const record = useDocuments.getState().characters[aerin.id];
    if (!record) throw new Error("import");
    const party = { [aerin.id]: { build: record.build, state: record.state } };
    const r = await engine.applyEncounterAction(await engine.newEncounter(), party, [
      { type: "add_character", character: aerin.id, dice: "table" },
      { type: "add_monster", monster: "goblin-warrior" },
      { type: "set_initiative", id: "aerin", value: 20 },
      { type: "set_initiative", id: "goblin-warrior", value: 5 },
      { type: "start" },
    ]);
    if (!r.ok) throw new Error(r.reasons.join("; "));
    const options = await engine.combatantOptions(r.encounter, party, "aerin");
    const attack = options.attacks.find((a) => a.action.type === "attack" && /2d6/.test(a.label));
    if (!attack) throw new Error("no Greatsword attack");
    const id = storeEncounter(r.encounter);
    await renderApp(`/encounters/${id}`);
    await screen.findByRole("region", { name: "Options" }, { timeout: 15_000 });
    await useDocuments.getState().encounterAction(id, {
      ...attack.action,
      target: "goblin-warrior",
    } as EncounterAction);

    // The attack roll waits for the d20: a value a d20 can't show is refused with the reason.
    const dialog = await screen.findByRole("dialog", { name: "Aerin rolls" });
    expect(useDocuments.getState().encounters[id]?.encounter.pending?.kind).toBe("roll");
    const box = within(dialog).getByRole("textbox", { name: "Die 1 (d20)" });
    await userEvent.type(box, "25");
    await userEvent.click(within(dialog).getByRole("button", { name: "Enter the roll" }));
    expect(await within(dialog).findByText(/A d20 rolls 1 to 20, not 25/)).toBeInTheDocument();
    await userEvent.clear(box);
    await userEvent.type(box, "20");
    await userEvent.click(within(dialog).getByRole("button", { name: "Enter the roll" }));

    // A natural 20 hits: the damage dice are asked next (doubled: 4d6), then the goblin takes them.
    await waitFor(() =>
      expect(useDocuments.getState().encounters[id]?.encounter.pending?.question).toMatch(/damage/),
    );
    const damage = await screen.findByRole("dialog", { name: "Aerin rolls" });
    const dice = within(damage).getAllByRole("textbox");
    expect(dice).toHaveLength(4);
    for (const input of dice) await userEvent.type(input, "6");
    await userEvent.click(within(damage).getByRole("button", { name: "Enter the roll" }));
    await waitFor(() =>
      expect(useDocuments.getState().encounters[id]?.encounter.pending).toBeNull(),
    );
    expect(useDocuments.getState().encounters[id]?.encounter.combatants[1]?.hp).toBeLessThan(
      r.encounter.combatants[1]?.hp ?? 0,
    );
  });

  it("lets the GM override a refusal: Do it anyway, logged as an override", async () => {
    const aerin = await useDocuments.getState().importCharacter(await fighter(engine, 3));
    if (!aerin.ok) throw new Error("import");
    const record = useDocuments.getState().characters[aerin.id];
    if (!record) throw new Error("import");
    const party = { [aerin.id]: { build: record.build, state: record.state } };
    const r = await engine.applyEncounterAction(await engine.newEncounter(), party, [
      { type: "add_character", character: aerin.id },
      { type: "add_monster", monster: "goblin-warrior", hp: 200 },
      { type: "set_initiative", id: "aerin", value: 20 },
      { type: "set_initiative", id: "goblin-warrior", value: 5 },
      { type: "start" },
      { type: "attack", id: "aerin", attack: "Greatsword", target: "goblin-warrior" },
    ]);
    if (!r.ok) throw new Error(r.reasons.join("; "));
    const options = await engine.combatantOptions(r.encounter, party, "aerin");
    const attack = options.attacks.find((a) => a.action.type === "attack" && !a.available);
    if (!attack) throw new Error("no refused attack");
    const id = storeEncounter(r.encounter);
    await renderApp(`/encounters/${id}`);

    const bar = await screen.findByRole("region", { name: "Options" }, { timeout: 15_000 });
    const tile = within(bar).getAllByRole("button", {
      name: new RegExp(`^${literal(attack.label)}`),
    })[0];
    if (!tile) throw new Error("no tile");
    await userEvent.click(tile);
    const composer = await screen.findByRole("region", { name: attack.label });
    await userEvent.click(await within(composer).findByRole("button", { name: "Do it anyway" }));
    expect(await screen.findByRole("region", { name: "Log" })).toHaveTextContent(/GM override/);

    // A player never gets the composer for a refused option.
    useUi.setState({ role: { kind: "player", character: aerin.id } });
    const again = await screen.findByRole("region", { name: "Options" });
    const refused = within(again)
      .getAllByRole("button", { name: new RegExp(`^${literal(attack.label)}`) })
      .find((b) => b.getAttribute("aria-disabled") === "true");
    if (!refused) throw new Error("no refused tile");
    await userEvent.click(refused);
    expect(screen.queryByRole("button", { name: "Do it anyway" })).toBeNull();
  });
});

/** A label as a literal pattern. */
function literal(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
