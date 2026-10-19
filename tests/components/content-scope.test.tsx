/**
 * Catalog lookups on screen use the document's own content (kenli F-008 §9.5, review R03-01): a
 * pinned character's sheet and builder, the encounter's world for its monster picker, and each
 * version's own definition of the same spell id in one query cache.
 */

import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setEngine } from "../../src/engine/client";
import { loadConstants } from "../../src/engine/constants";
import type { EngineFacade } from "../../src/engine/facade";
import { nodeFacade } from "../../src/engine/node";
import { SpellsTab } from "../../src/features/sheet/SpellsTab";
import { commitPlan, previewImport } from "../../src/import";
import type { ContentContext } from "../../src/lib/canonical";
import { createQueryClient } from "../../src/queries";
import { useDocuments } from "../../src/store/documents";
import { renderApp, resetStores } from "../helpers/app";
import { LIB, libraryFetch, refs } from "../helpers/transfer";

/** The in-process engine, recording the content of every catalog lookup. */
const calls: { method: string; table: string; content: ContentContext | undefined }[] = [];
const base = nodeFacade({ seed: 3 });
const engine: EngineFacade = {
  ...base,
  entries: (table, content) => {
    calls.push({ method: "entries", table, content });
    return base.entries(table, content);
  },
  entry: (table, id, content) => {
    calls.push({ method: "entry", table, content });
    return base.entry(table, id, content);
  },
};
setEngine(engine);
beforeAll(() => loadConstants(engine));
beforeEach(async () => {
  cleanup();
  await resetStores();
  calls.length = 0;
});

async function importDuel() {
  const p = await previewImport(
    { url: `${LIB}d/encounter/mixed-duel.json` },
    { signal: new AbortController().signal, fetch: libraryFetch() },
  );
  if (!p.ok) throw new Error(p.problem.code);
  expect((await commitPlan(p.plan, { characters: {} })).ok).toBe(true);
  const s = useDocuments.getState();
  const id = (name: string) =>
    Object.values(s.characters).find((c) => c.build.name === name)?.id as string;
  return {
    wren: id("Wren"),
    sable: id("Sable"),
    encounter: Object.keys(s.encounters)[0] as string,
  };
}

describe("catalog lookups in the document's content", () => {
  it("each version's own definition of the same spell, in one query cache", async () => {
    const { wren, sable } = await importDuel();
    const client = createQueryClient();
    const user = userEvent.setup();
    for (const [id, version] of [
      [sable, "version 2"],
      [wren, "version 1"],
      [sable, "version 2"],
    ] as const) {
      const record = useDocuments.getState().characters[id];
      if (!record) throw new Error("no character");
      const { sheet } = await engine.playSheet(record.build, record.state, record.content);
      const view = render(
        <QueryClientProvider client={client}>
          <SpellsTab id={id} sheet={sheet} />
        </QueryClientProvider>,
      );
      await user.click(await view.findByRole("button", { name: "Details: Synthetic Spark" }));
      expect(await view.findByText(new RegExp(`test spell, ${version}`))).toBeInTheDocument();
      view.unmount();
    }
  });

  it("a pinned sheet, its builder and the encounter's monster picker never use the campaign's", async () => {
    const { sable, encounter } = await importDuel();
    const user = userEvent.setup();
    const v2 = refs.context_v2;
    await renderApp(`/characters/${sable}/sheet`);
    for (const tab of ["Overview", "Combat", "Spells", "Inventory", "Features"]) {
      await user.click(await screen.findByRole("tab", { name: tab }));
    }
    await waitFor(() => expect(calls.some((c) => c.table === "spells")).toBe(true));
    cleanup();
    await renderApp(`/characters/${sable}/build?step=species`);
    await waitFor(() => expect(calls.some((c) => c.table === "species")).toBe(true));
    const characterCalls = [...calls];
    expect(characterCalls.length).toBeGreaterThan(0);
    for (const c of characterCalls)
      expect({ ...c, content: c.content ?? null }).toEqual({ ...c, content: v2 });
    cleanup();
    calls.length = 0;
    await renderApp(`/encounters/${encounter}`);
    await user.click(await screen.findByRole("button", { name: "Add a monster" }));
    await screen.findByRole("dialog");
    // The picker's list is virtualized (nothing measured in jsdom): its data source is checked.
    await waitFor(() => expect(calls.some((c) => c.table === "monsters")).toBe(true));
    const monsters = calls.filter((c) => c.table === "monsters");
    for (const c of monsters) expect(c.content).toEqual(refs.context_v1);
    const offered = (await base.entries("monsters", refs.context_v1)) as { id: string }[];
    expect(offered.some((m) => m.id === "synthetic-dummy")).toBe(true);
    const campaign = (await base.entries("monsters")) as { id: string }[];
    expect(campaign.some((m) => m.id === "synthetic-dummy")).toBe(false);
  });
});
