/**
 * Review 03 (R03-01) reproduction, its assertions unchanged: a pinned character's spell list shows
 * its own pack's definition, without a page scope around it.
 */

import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it } from "vitest";
import { SpellsTab } from "../../src/features/sheet/SpellsTab";
import { createQueryClient } from "../../src/queries";
import { type CharacterRecord, useDocuments } from "../../src/store/documents";
import { installTestEngine, resetStores } from "../helpers/app";
import { fixtureJson, refs } from "../helpers/transfer";

const engine = installTestEngine();
beforeEach(resetStores);

it("review: pinned spell exposes its own definition", async () => {
  const pack = fixtureJson("packs/synthetic-a-2.0.0.transfer.json").content.files;
  const env = fixtureJson("characters/sable.r1.transfer.json");
  await engine.registerPacks([pack]);
  const { build, state } = env.content;
  const sable = { id: "sable", build, state, content: refs.context_v2, rev: 1, gen: 0 };
  useDocuments.setState({
    characters: { sable: sable as unknown as CharacterRecord },
    revs: { sable: 1 },
  });
  const result = await engine.playSheet(build, state, refs.context_v2);
  render(
    <QueryClientProvider client={createQueryClient()}>
      <SpellsTab id="sable" sheet={result.sheet} />
    </QueryClientProvider>,
  );
  await screen.findByText("Synthetic Spark");
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Details: Synthetic Spark" })).toBeDefined(),
  );
});
