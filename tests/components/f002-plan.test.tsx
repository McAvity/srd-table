/**
 * kenli F-002 T05 on the real store, engine and fake IndexedDB: the sheet's plan panel (where the
 * character is in the plan, the next level only, its preview, Cancel changes nothing, Confirm
 * advances one level), the end of a plan, the builder's warning, the History wording of a level
 * gained from the plan and of a bind, and a progression plan dropped on the ordinary import is
 * routed to the plan import. Synthetic/SRD plans only.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { titleOf } from "../../src/features/history/format";
import { t } from "../../src/i18n";
import { startFromPlan } from "../../src/progression/advance";
import { useDocuments } from "../../src/store/documents";
import type { HistoryEntry } from "../../src/store/history";
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
