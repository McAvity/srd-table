/**
 * kenli F-002 T08 (review04 C11): on the sheet, a feature with its own die (a maneuver) is used only
 * by rolling it — one "Use (roll 1d8)" button, which asks the engine to roll the feature (its die
 * rolled, its cost paid once by `rollByHand`), never a bare use that spends and rolls nothing; an
 * attack is rolled with the riders picked for it. SRD character, the real sheet from the engine,
 * one synthetic action and rider added (no private pack); the store's `rollByHand` observed.
 */

import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { PlaySheet } from "srd-rules-engine";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CombatTab } from "../../src/features/sheet/CombatTab";
import { createQueryClient } from "../../src/queries";
import { useDocuments } from "../../src/store/documents";
import { rogue } from "../fixtures/characters";
import { testContext } from "../fixtures/player-actions";
import { installTestEngine } from "../helpers/app";
import { addCharacter, Installations, type Loose } from "../localCopy/helpers";

installTestEngine(4);
const inst = new Installations();
beforeEach(async () => {
  await inst.open(`C11-${Math.random().toString(36).slice(2)}`);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
afterAll(() => inst.close());

async function sheetWithManeuver() {
  const ctx = await testContext(inst.fx.engine);
  const id = await addCharacter(await rogue(inst.fx.engine, 3), ctx, inst.fx.engine);
  const rec = useDocuments.getState().characters[id] as Loose;
  const sheet = structuredClone(
    ((await inst.fx.engine.playSheet(rec.build, rec.state, ctx)) as Loose).sheet,
  ) as Loose;
  const base = sheet.actions[0] ?? {};
  sheet.actions = [
    ...sheet.actions,
    {
      ...base,
      key: "test:maneuver",
      name: "Test Maneuver",
      economy: "free",
      uses: null,
      heal: null,
      save: null,
      roll_die: "1d8",
      pool: false,
    },
  ];
  if (sheet.attacks[0])
    sheet.attacks[0] = { ...sheet.attacks[0], riders: [{ id: "test-rider", name: "Test Rider" }] };
  return { id, sheet: sheet as PlaySheet };
}
function show(id: string, sheet: PlaySheet) {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <CombatTab id={id} sheet={sheet} />
    </QueryClientProvider>,
  );
}

describe("C11: a feature with its own die is rolled, never spent silently", () => {
  it("one button, Use (roll 1d8); it rolls the feature by hand (die and cost there), no bare use", async () => {
    const { id, sheet } = await sheetWithManeuver();
    const rollByHand = vi.fn(async (..._a: unknown[]) => ({ ok: true }) as Loose);
    const playAction = vi.fn(async (..._a: unknown[]) => ({ ok: true }) as Loose);
    useDocuments.setState({ rollByHand, playAction } as Loose);
    show(id, sheet);
    const row = (await screen.findByText("Test Maneuver")).closest("li") as HTMLElement;
    const buttons = [...row.querySelectorAll("button")].map((b) => b.textContent);
    expect(buttons).toEqual(["Use (roll 1d8)"]);
    fireEvent.click(screen.getByRole("button", { name: "Use (roll 1d8)" }));
    await vi.waitFor(() => expect(rollByHand).toHaveBeenCalledTimes(1));
    expect(rollByHand.mock.calls[0]?.[1]).toEqual({ type: "feature", feature: "test:maneuver" });
    expect(playAction).not.toHaveBeenCalled();
  });

  it("an attack is rolled with the riders picked for it (and without, when none is)", async () => {
    const { id, sheet } = await sheetWithManeuver();
    const rollByHand = vi.fn(async (..._a: unknown[]) => ({ ok: true }) as Loose);
    useDocuments.setState({ rollByHand } as Loose);
    show(id, sheet);
    const attack = sheet.attacks[0]?.name as string;
    const row = (await screen.findByRole("rowheader", { name: new RegExp(`^${attack}`) })).closest(
      "tr",
    ) as HTMLElement;
    const rollIn = () =>
      [...row.querySelectorAll("button")].find((b) => b.textContent === "Roll") as HTMLElement;
    fireEvent.click(rollIn());
    await vi.waitFor(() => expect(rollByHand).toHaveBeenCalledTimes(1));
    expect((rollByHand.mock.calls[0]?.[1] as Loose)?.riders).toBeUndefined();
    fireEvent.click(screen.getByLabelText("Test Rider"));
    await vi.waitFor(() => expect(rollIn().hasAttribute("disabled")).toBe(false));
    fireEvent.click(rollIn());
    await vi.waitFor(() => expect(rollByHand).toHaveBeenCalledTimes(2));
    expect(rollByHand.mock.calls[1]?.[1]).toMatchObject({
      type: "attack",
      attack,
      riders: [{ rider: "test-rider" }],
    });
  });

  it("a pick isn't carried to another character's same line, nor kept once the line drops it", async () => {
    const a = await sheetWithManeuver();
    const b = await sheetWithManeuver();
    const attack = a.sheet.attacks[0]?.name as string;
    const bare = (sh: PlaySheet) =>
      ({
        ...sh,
        attacks: sh.attacks.map((x, i) => (i === 0 ? { ...x, riders: [] } : x)),
      }) as PlaySheet;
    const rollByHand = vi.fn(async (..._a: unknown[]) => ({ ok: true }) as Loose);
    useDocuments.setState({ rollByHand } as Loose);
    const client = createQueryClient();
    const view = (id: string, sheet: PlaySheet) => (
      <QueryClientProvider client={client}>
        <CombatTab id={id} sheet={sheet} />
      </QueryClientProvider>
    );
    const { rerender } = render(view(a.id, a.sheet));
    const rollIn = async () => {
      const row = (
        await screen.findByRole("rowheader", { name: new RegExp(`^${attack}`) })
      ).closest("tr") as HTMLElement;
      const btn = [...row.querySelectorAll("button")].find(
        (x) => x.textContent === "Roll",
      ) as HTMLElement;
      await vi.waitFor(() => expect(btn.hasAttribute("disabled")).toBe(false));
      fireEvent.click(btn);
    };
    fireEvent.click(screen.getByLabelText("Test Rider"));
    // Warm switch (the same component, as the route does): B's line has no riders.
    rerender(view(b.id, bare(b.sheet)));
    await rollIn();
    await vi.waitFor(() => expect(rollByHand).toHaveBeenCalledTimes(1));
    expect(rollByHand.mock.calls[0]?.[0]).toBe(b.id);
    expect((rollByHand.mock.calls[0]?.[1] as Loose)?.riders).toBeUndefined();
    // B's line offers the rider: nothing is picked for B.
    rerender(view(b.id, b.sheet));
    expect((screen.getByLabelText("Test Rider") as HTMLInputElement).checked).toBe(false);
    // Picked for B, then the line no longer offers it (an Undo, an expired option): not sent.
    fireEvent.click(screen.getByLabelText("Test Rider"));
    rerender(view(b.id, bare(b.sheet)));
    await rollIn();
    await vi.waitFor(() => expect(rollByHand).toHaveBeenCalledTimes(2));
    expect((rollByHand.mock.calls[1]?.[1] as Loose)?.riders).toBeUndefined();
  });
});
