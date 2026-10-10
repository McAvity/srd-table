import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Encounter } from "srd-rules-engine";
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

  it("plays an attack by hand: no target, rolled as often as asked, nothing applied", async () => {
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
    const attack = options.attacks.find(
      (a) => a.action.type === "attack" && a.action.attack === "Greatsword",
    );
    if (!attack) throw new Error("no attack");
    const id = storeEncounter(r.encounter);
    await renderApp(`/encounters/${id}`);

    const bar = await screen.findByRole("region", { name: "Options" }, { timeout: 15_000 });
    await userEvent.click(within(bar).getByRole("button", { name: "By hand" }));
    const tileOf = () => {
      const tile = within(bar).getAllByRole("button", {
        name: new RegExp(`^${literal(attack.label)}`),
      })[0];
      if (!tile) throw new Error("no tile");
      return tile;
    };
    // Sent at once, with no target: no composer.
    await userEvent.click(tileOf());
    expect(screen.queryByRole("region", { name: attack.label })).toBeNull();
    const [tray] = await screen.findAllByRole("region", { name: "Dice results" });
    await waitFor(() => expect(tray).toHaveTextContent(/By hand/));
    expect(tray).not.toHaveTextContent(/AC/);
    // The action economy isn't spent: the attack can be rolled again.
    await waitFor(() => expect(tileOf()).not.toHaveAttribute("aria-disabled", "true"));
    await userEvent.click(tileOf());
    await waitFor(() =>
      expect(
        useDocuments
          .getState()
          .encounters[id]?.log.flatMap((e) => e.lines)
          .filter((l) => /by hand/.test(l)),
      ).toHaveLength(2),
    );
    const sent = useDocuments.getState().encounters[id];
    expect(sent?.encounter.combatants[1]?.hp).toBe(r.encounter.combatants[1]?.hp);
    expect(await screen.findByRole("region", { name: "Log" })).toHaveTextContent(/by hand/);
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

  it("rolls a saving throw for a monster from the selection panel", async () => {
    const r = await engine.applyEncounterAction(await engine.newEncounter(), {}, [
      { type: "add_monster", monster: "goblin-warrior" },
    ]);
    if (!r.ok) throw new Error("setup");
    const id = storeEncounter(r.encounter);
    useTableUi.setState({ selected: "goblin-warrior", pinned: true });
    await renderApp(`/encounters/${id}`);
    const panel = await screen.findByRole("region", { name: "Selection" }, { timeout: 15_000 });
    await userEvent.click(within(panel).getByText("Check or saving throw"));
    await userEvent.selectOptions(
      within(panel).getByRole("combobox", { name: "What to roll" }),
      "save:dex",
    );
    await userEvent.type(within(panel).getByRole("textbox", { name: "DC (optional)" }), "12");
    await userEvent.click(within(panel).getByRole("button", { name: "Roll" }));
    expect(await screen.findByRole("region", { name: "Log" })).toHaveTextContent(
      /Dexterity saving throw/,
    );
    expect(useDocuments.getState().encounters[id]?.encounter.combatants[0]?.hp).toBe(
      r.encounter.combatants[0]?.hp,
    );
  });

  it("lets a player apply damage to their own character from the encounter", async () => {
    const aerin = await useDocuments.getState().importCharacter(await fighter(engine, 3));
    if (!aerin.ok) throw new Error("import");
    const record = useDocuments.getState().characters[aerin.id];
    if (!record) throw new Error("import");
    const party = { [aerin.id]: { build: record.build, state: record.state } };
    const r = await engine.applyEncounterAction(await engine.newEncounter(), party, [
      { type: "add_character", character: aerin.id },
      { type: "add_monster", monster: "goblin-warrior" },
    ]);
    if (!r.ok) throw new Error(r.reasons.join("; "));
    const id = storeEncounter(r.encounter);
    useUi.setState({ role: { kind: "player", character: aerin.id } });
    await renderApp(`/encounters/${id}`);
    const panel = await screen.findByRole("region", { name: "Selection" }, { timeout: 15_000 });
    await waitFor(() => expect(panel).toHaveTextContent("Aerin"));
    await userEvent.type(within(panel).getByRole("textbox", { name: "Amount" }), "5");
    await userEvent.click(within(panel).getByRole("button", { name: "Damage" }));
    await waitFor(() =>
      // 28 HP at full (`current` is `null` until hurt), 23 after.
      expect(useDocuments.getState().characters[aerin.id]?.state.hp.current).toBe(23),
    );
    // Not the GM's controls.
    expect(within(panel).queryByRole("button", { name: "Remove" })).toBeNull();
  });
});

/** A label as a literal pattern. */
function literal(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
