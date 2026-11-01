/**
 * kenli F-002 T05 on the real store, engine and fake IndexedDB: the sheet's plan panel (where the
 * character is in the plan, the next level only, its preview, Cancel changes nothing, Confirm
 * advances one level), the end of a plan, the builder's warning, the History wording of a level
 * gained from the plan and of a bind, and a progression plan dropped on the ordinary import is
 * routed to the plan import. Review07: the panel is isolated per character (R07-01: a warm route
 * change with an open or a deferred preview/bind never shows or applies it on another character)
 * and a bind's "Finish current roll" previews the same file again (R07-02), never confirming it;
 * a cancelled or closed bind drops its late result. Synthetic/SRD plans only.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { engine } from "../../src/engine/client";
import { titleOf } from "../../src/features/history/format";
import { t } from "../../src/i18n";
import { detachProgression, startFromPlan } from "../../src/progression/advance";
import { useDocuments } from "../../src/store/documents";
import { type HistoryEntry, useHistory } from "../../src/store/history";
import { useRolls } from "../../src/store/rolls";
import { installTestEngine, renderApp } from "../helpers/app";
import { Installations, type Loose } from "../localCopy/helpers";
import { FIXTURE_DIR } from "../progression/generate-fixtures";

const read = (name: string) => JSON.parse(readFileSync(join(FIXTURE_DIR, name), "utf8"));
installTestEngine(3);
const inst = new Installations();
beforeEach(async () => {
  await inst.open(`T05-${Math.random().toString(36).slice(2)}`);
});
afterEach(() => cleanup());
afterAll(() => inst.close());

async function started(name: string, level: number): Promise<string> {
  const r = await startFromPlan(read(name), level);
  if (!r.ok) throw new Error(`${r.code}: ${r.detail}`);
  return r.id;
}
/**
 * Hold the worker's `compilePlan` (previewAdvance's and previewBind's first worker call) until
 * `release()`: a preview or bind still in flight while the user moves on.
 */
function holdCompile() {
  const fx = engine() as unknown as Loose;
  const real = fx.compilePlan;
  let open!: () => void;
  const gate = new Promise<void>((r) => {
    open = r;
  });
  let calls = 0;
  fx.compilePlan = async (...a: unknown[]) => {
    calls++;
    await gate;
    return real.apply(fx, a);
  };
  return {
    calls: () => calls,
    release: () => {
      fx.compilePlan = real;
      open();
    },
  };
}
const settle = () => new Promise((r) => setTimeout(r, 300));
const fileOf = (name: string) =>
  new File([readFileSync(join(FIXTURE_DIR, name))], name, { type: "application/json" });
const level = (id: string) =>
  1 + (useDocuments.getState().characters[id]?.build.levels.length ?? 0);

describe("the sheet's plan panel", () => {
  it("shows where the character is; Next previews only the next level; Cancel changes nothing; Confirm advances one", async () => {
    const id = await started("fighter-1-6.plan.json", 2);
    await renderApp(`/characters/${id}/sheet`);
    const panel = await screen.findByTestId("plan-panel", {}, { timeout: 20_000 });
    expect(within(panel).getByTestId("plan-level-status").textContent).toContain("At level 2 of 6");
    fireEvent.click(within(panel).getByTestId("plan-next"));
    const preview = await screen.findByTestId("step-preview", {}, { timeout: 20_000 });
    expect(preview.textContent).toContain("Level 2 → 3");
    const before = useDocuments.getState().characters[id];
    fireEvent.click(screen.getByTestId("plan-preview-cancel"));
    await waitFor(() => expect(screen.queryByTestId("step-preview")).toBeNull());
    expect(useDocuments.getState().characters[id]).toBe(before);
    fireEvent.click(screen.getByTestId("plan-next"));
    await screen.findByTestId("step-preview", {}, { timeout: 20_000 });
    fireEvent.click(screen.getByTestId("plan-confirm"));
    await waitFor(() => expect(level(id)).toBe(3), { timeout: 20_000 });
    expect((await screen.findByTestId("plan-note")).textContent).toContain(
      "Level 3 gained from the plan.",
    );
    expect(screen.getByTestId("plan-level-status").textContent).toContain("At level 3 of 6");
  }, 60_000);

  it("at the plan's last level: the end, no Next", async () => {
    const id = await started("fighter-1-6.plan.json", 6);
    await renderApp(`/characters/${id}/sheet`);
    await screen.findByTestId("plan-end", {}, { timeout: 20_000 });
    expect(screen.queryByTestId("plan-next")).toBeNull();
  }, 60_000);

  it("the builder warns that a manual edit leaves the plan, and offers to stop following it", async () => {
    const id = await started("fighter-1-6.plan.json", 3);
    await renderApp(`/characters/${id}/build`);
    const notice = await screen.findByTestId("plan-builder-notice", {}, { timeout: 20_000 });
    expect(within(notice).getByTestId("plan-builder-detach")).toBeTruthy();
  }, 60_000);
});

describe("review07 R07-01: the panel belongs to its character", () => {
  it("warm route A → B with A's preview open: B shows its own panel, no preview; B's Confirm advances B only", async () => {
    const a = await started("fighter-1-6.plan.json", 2);
    const b = await started("fighter-1-6.plan.json", 3);
    const { router } = await renderApp(`/characters/${a}/sheet`);
    fireEvent.click(await screen.findByTestId("plan-next", {}, { timeout: 20_000 }));
    expect(
      (await screen.findByTestId("step-preview", {}, { timeout: 20_000 })).textContent,
    ).toContain("Level 2 → 3");
    const recA = useDocuments.getState().characters[a];
    await router.navigate({ to: "/characters/$id/sheet", params: { id: b }, search: {} });
    await waitFor(() =>
      expect(screen.getByTestId("plan-level-status").textContent).toContain("At level 3 of 6"),
    );
    expect(screen.queryByTestId("step-preview")).toBeNull();
    expect(screen.queryByTestId("plan-confirm")).toBeNull();
    // B's own next level needs its own preview and confirm.
    fireEvent.click(screen.getByTestId("plan-next"));
    expect(
      (await screen.findByTestId("step-preview", {}, { timeout: 20_000 })).textContent,
    ).toContain("Level 3 → 4");
    fireEvent.click(screen.getByTestId("plan-confirm"));
    await waitFor(() => expect(level(b)).toBe(4), { timeout: 20_000 });
    expect(level(a)).toBe(2);
    expect(useDocuments.getState().characters[a]).toBe(recA);
  }, 90_000);

  it("a deferred preview of A arriving after the move to B never appears; back on A it needs a fresh Next", async () => {
    const a = await started("fighter-1-6.plan.json", 2);
    const b = await started("fighter-1-6.plan.json", 3);
    const { router } = await renderApp(`/characters/${a}/sheet`);
    const held = holdCompile();
    fireEvent.click(await screen.findByTestId("plan-next", {}, { timeout: 20_000 }));
    await waitFor(() => expect(held.calls()).toBe(1));
    await router.navigate({ to: "/characters/$id/sheet", params: { id: b }, search: {} });
    await waitFor(() =>
      expect(screen.getByTestId("plan-level-status").textContent).toContain("At level 3 of 6"),
    );
    held.release();
    await settle();
    expect(screen.queryByTestId("step-preview")).toBeNull();
    await router.navigate({ to: "/characters/$id/sheet", params: { id: a }, search: {} });
    await waitFor(() =>
      expect(screen.getByTestId("plan-level-status").textContent).toContain("At level 2 of 6"),
    );
    await settle();
    expect(screen.queryByTestId("step-preview")).toBeNull();
    expect(level(a)).toBe(2);
    expect(level(b)).toBe(3);
  }, 90_000);

  it("a deferred bind of A arriving after the move to B opens nothing and binds nothing", async () => {
    const a = await started("fighter-1-6.plan.json", 3);
    const b = await started("fighter-1-6.plan.json", 2);
    await detachProgression(a);
    const { router } = await renderApp(`/characters/${a}/sheet`);
    fireEvent.click(await screen.findByTestId("plan-bind-open", {}, { timeout: 20_000 }));
    const held = holdCompile();
    fireEvent.change(await screen.findByTestId("plan-bind-file"), {
      target: { files: [fileOf("fighter-1-6.plan.json")] },
    });
    await waitFor(() => expect(held.calls()).toBe(1), { timeout: 20_000 });
    await router.navigate({ to: "/characters/$id/sheet", params: { id: b }, search: {} });
    await waitFor(() =>
      expect(screen.getByTestId("plan-level-status").textContent).toContain("At level 2 of 6"),
    );
    held.release();
    await settle();
    expect(screen.queryByTestId("step-preview")).toBeNull();
    expect(screen.queryByTestId("plan-bind-file")).toBeNull();
    expect(useDocuments.getState().characters[a]?.progression ?? null).toBeNull();
  }, 90_000);
});

describe("review07 R07-02: a bind's Finish current roll", () => {
  async function unboundWithRoll() {
    const id = await started("fighter-1-6.plan.json", 3);
    await detachProgression(id);
    const r = await useDocuments
      .getState()
      .rollTest(id, { kind: "check", ability: "str" } as Loose);
    if (!r.ok) throw new Error("roll refused");
    return id;
  }

  it("forgets the roll and previews the same file again; nothing paid, written or confirmed", async () => {
    const id = await unboundWithRoll();
    await renderApp(`/characters/${id}/sheet`);
    fireEvent.click(await screen.findByTestId("plan-bind-open", {}, { timeout: 20_000 }));
    fireEvent.change(await screen.findByTestId("plan-bind-file"), {
      target: { files: [fileOf("fighter-1-6.plan.json")] },
    });
    const refusal = await screen.findByTestId("plan-refusal", {}, { timeout: 20_000 });
    expect(refusal.getAttribute("data-code")).toBe("advance_busy");
    const before = useDocuments.getState().characters[id];
    const historyBefore = Object.keys(useHistory.getState().entries).length;
    fireEvent.click(within(refusal).getByTestId("plan-finish-roll"));
    const preview = await screen.findByTestId("step-preview", {}, { timeout: 20_000 });
    expect(preview.textContent).toContain("Follow this plan from level 3");
    expect(screen.queryByTestId("plan-refusal")).toBeNull();
    expect(useRolls.getState().last[id]).toBeUndefined();
    // Only the roll's window ended: the record, its state and History are the same; not bound.
    expect(useDocuments.getState().characters[id]).toBe(before);
    expect(Object.keys(useHistory.getState().entries).length).toBe(historyBefore);
    expect(before?.progression ?? null).toBeNull();
    fireEvent.click(screen.getByTestId("plan-preview-cancel"));
    await waitFor(() => expect(screen.queryByTestId("step-preview")).toBeNull());
    expect(useDocuments.getState().characters[id]).toBe(before);
  }, 90_000);

  it("a bind cancelled while its preview is in flight never reopens; the file is forgotten", async () => {
    const id = await unboundWithRoll();
    useRolls.getState().forget(id);
    await renderApp(`/characters/${id}/sheet`);
    fireEvent.click(await screen.findByTestId("plan-bind-open", {}, { timeout: 20_000 }));
    const held = holdCompile();
    fireEvent.change(await screen.findByTestId("plan-bind-file"), {
      target: { files: [fileOf("fighter-1-6.plan.json")] },
    });
    await waitFor(() => expect(held.calls()).toBe(1), { timeout: 20_000 });
    fireEvent.click(screen.getByTestId("plan-bind-cancel"));
    await waitFor(() => expect(screen.queryByTestId("plan-bind-file")).toBeNull());
    held.release();
    await settle();
    expect(screen.queryByTestId("step-preview")).toBeNull();
    expect(screen.queryByTestId("plan-refusal")).toBeNull();
    // Reopened: a clean dialog, nothing carried over from the cancelled one.
    fireEvent.click(screen.getByTestId("plan-bind-open"));
    await screen.findByTestId("plan-bind-file");
    expect(screen.queryByTestId("plan-refusal")).toBeNull();
    expect(useDocuments.getState().characters[id]?.progression ?? null).toBeNull();
  }, 90_000);
});

describe("a pending decision", () => {
  it("Next is refused with a link to the encounter's own decision; nothing is decided or advanced", async () => {
    const id = await started("fighter-1-6.plan.json", 2);
    const eid = await useDocuments.getState().createEncounter("Bridge");
    // The encounter waiting on a decision for this character (component level: the store's
    // documents, not the browser's database).
    const enc = useDocuments.getState().encounters[eid] as unknown as Loose;
    const pending = { kind: "test" };
    useDocuments.setState((s) => ({
      encounters: {
        ...s.encounters,
        [eid]: {
          ...enc,
          encounter: {
            ...enc.encounter,
            combatants: [{ ...(enc.encounter.combatants[0] ?? {}), id: "x", character: id }],
            pending,
          },
        },
      } as typeof s.encounters,
    }));
    const { router } = await renderApp(`/characters/${id}/sheet`);
    fireEvent.click(await screen.findByTestId("plan-next", {}, { timeout: 20_000 }));
    const refusal = await screen.findByTestId("plan-refusal", {}, { timeout: 20_000 });
    expect(refusal.getAttribute("data-code")).toBe("advance_busy");
    expect(screen.queryByTestId("plan-confirm")).toBeNull();
    const link = within(refusal).getByTestId("plan-open-decision");
    expect(link.textContent).toContain("Bridge");
    fireEvent.click(link);
    await waitFor(() => expect(router.state.location.pathname).toBe(`/encounters/${eid}`));
    expect((useDocuments.getState().encounters[eid] as unknown as Loose).encounter.pending).toBe(
      pending,
    );
    expect(level(id)).toBe(2);
  }, 60_000);
});

describe("History and import wording", () => {
  const entry = (level_up: unknown) => ({ kind: "level_up", level_up }) as unknown as HistoryEntry;
  it("a level gained from the plan and a bind read as such", () => {
    expect(
      titleOf(
        entry({ mode: "advance", from_level: 2, to_level: 3, class_id: "fighter", class_level: 3 }),
      ),
    ).toBe("Level 3 from the plan (Fighter 3)");
    expect(titleOf(entry({ mode: "bind", from_level: 3, to_level: 3 }))).toBe(
      "Follows a plan from level 3",
    );
  });
  it("the plan import's own message exists in both catalogs' shape", () => {
    expect(t("import.problem.progressionPlan")).not.toBe("import.problem.progressionPlan");
  });
});
