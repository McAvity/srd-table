import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../../src/persistence/db";
import { loadAll, startAutosave } from "../../src/persistence/sync";
import { useDocuments } from "../../src/store/documents";
import { useSettings } from "../../src/store/settings";
import { useUi } from "../../src/store/ui";
import { installTestEngine, resetStores } from "../helpers/app";

installTestEngine(3);
beforeEach(resetStores);

describe("persistence", () => {
  it("loads documents through the engine's parse, and writes the migrated result back", async () => {
    const database = await db();
    // A build saved without a `version` (format 1, older files) and a state without one.
    await database.put("characters", {
      id: "c-old",
      build: { name: "Old", class_id: "fighter" },
      state: { hp: { current: 3 } },
      created: 1,
      updated: 1,
    });
    await database.put("encounters", {
      id: "e-old",
      name: "Old fight",
      encounter: {},
      log: "garbage",
      declared: [{ id: "d-1", round: 1, result: { manual: true, targets: [] } }, { id: 2 }],
      modes: { goblin: "manual", orc: "sideways" },
      created: 1,
      updated: 1,
    });
    await database.put("settings", { theme: "parchment", dev_seed: 5 }, "campaign");

    await loadAll();

    const state = useDocuments.getState();
    expect(state.characters["c-old"]?.build.version).toBe(1);
    expect(state.characters["c-old"]?.build.choices).toEqual({});
    expect(state.encounters["e-old"]?.encounter.round).toBe(0);
    expect(state.encounters["e-old"]?.log).toEqual([]);
    // Declared actions and play modes keep only entries that still make sense.
    expect(state.encounters["e-old"]?.declared?.map((d) => d.id)).toEqual(["d-1"]);
    expect(state.encounters["e-old"]?.modes).toEqual({ goblin: "manual" });
    expect(useSettings.getState().settings.character_play).toBe("auto");
    expect(useSettings.getState().settings.monster_dice).toBe("engine");
    // Saved before the Mat and Marker look: parchment is now Mat.
    expect(useSettings.getState().settings.theme).toBe("mat");
    const saved = await database.get("characters", "c-old");
    expect((saved?.build as { version?: number } | undefined)?.version).toBe(1);
  });

  it("skips a document that doesn't parse, keeps it in the database, and says so", async () => {
    const database = await db();
    await database.put("characters", {
      id: "c-bad",
      build: { version: 99 },
      state: {},
      created: 1,
      updated: 1,
    });
    await loadAll();
    expect(useDocuments.getState().characters["c-bad"]).toBeUndefined();
    expect(await database.get("characters", "c-bad")).toBeDefined();
    expect(useUi.getState().toasts.at(-1)?.tone).toBe("error");
  });

  it("saves changes and deletions after a short delay", async () => {
    await loadAll();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const stop = startAutosave();
    try {
      const id = await useDocuments.getState().createCharacter();
      await useDocuments.getState().editBuild(id, { type: "name", name: "Saved" });
      await vi.advanceTimersByTimeAsync(400);
      vi.useRealTimers();
      await waitFor(
        async () =>
          ((await (await db()).get("characters", id))?.build as { name?: string })?.name ===
          "Saved",
      );
      useDocuments.getState().deleteCharacter(id);
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      await vi.advanceTimersByTimeAsync(400);
      vi.useRealTimers();
      await waitFor(async () => (await (await db()).get("characters", id)) === undefined);
    } finally {
      vi.useRealTimers();
      stop();
    }
  });
});

async function waitFor(check: () => Promise<boolean>, timeout = 3000): Promise<void> {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeout) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}
