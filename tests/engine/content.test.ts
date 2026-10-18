/**
 * The worker's catalogs per exact content (kenli F-008): imported packs by hash, the served SRD
 * read whole once, a bounded number of context catalogs (least recently used let go) that are
 * rebuilt with the host gone, and an unknown pack refused instead of falling back.
 */

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { ContentRegistry, ContextUnavailable } from "../../src/engine/content";
import { createInProcessFacade } from "../../src/engine/facade";
import { fixtureJson, refs } from "../helpers/transfer";

const srdDir = dirname(
  createRequire(import.meta.url).resolve("srd-rules-engine/srd-5.2.1/manifest.json"),
);

function registry() {
  let up = true;
  let fetches = 0;
  const r = new ContentRegistry(async (pack, file) => {
    if (!up) throw new Error("host down");
    if (pack !== "srd-5.2.1") throw new Error(`no ${pack}`);
    fetches++;
    return JSON.parse(await readFile(join(srdDir, file), "utf8"));
  });
  return { r, down: () => (up = false), fetches: () => fetches };
}
const a1 = fixtureJson("packs/synthetic-a-1.0.0.transfer.json").content.files;
const a2 = fixtureJson("packs/synthetic-a-2.0.0.transfer.json").content.files;

describe("content registry", () => {
  it("registers packs by their verified hash; the served SRD has the contract's ref", async () => {
    const { r } = registry();
    expect(await r.register([a1, a2])).toEqual([
      refs["synthetic-a@1.0.0"],
      refs["synthetic-a@2.0.0"],
    ]);
    expect(await r.servedRef("srd-5.2.1")).toEqual(refs.srd);
  });

  it("two versions in two catalogs; LRU bounded; rebuilt without the host; unknown packs refused", async () => {
    const { r, down, fetches } = registry();
    await r.register([a1, a2]);
    const v1 = await r.catalog(refs.context_v1, ["spells"]);
    const v2 = await r.catalog(refs.context_v2, ["spells"]);
    expect(v1.spells["synthetic-spark"]?.level).toBe(0);
    expect(v2.spells["synthetic-spark"]?.level).toBe(1);
    // Ten distinct contexts (same packs, different allowed sources): at most eight kept.
    for (let i = 0; i < 10; i++)
      await r.catalog({ ...refs.context_v1, sources: ["srd-5.2.1", "synthetic-a", `x${i}`] }, [
        "spells",
      ]);
    expect(r.contexts).toBeLessThanOrEqual(8);
    const before = fetches();
    down();
    // v1's catalog was let go: rebuilt from the session's SRD and the registered pack, with a
    // table never opened before.
    const again = await r.catalog(refs.context_v1, ["monsters", "magic_items"]);
    expect(again.monsters["synthetic-dummy"]?.hit_points).toBe(30);
    expect(fetches()).toBe(before);
    const unknown = {
      packs: [refs.srd, { id: "synthetic-a", version: "9.9.9", sha256: "0".repeat(64) }],
      sources: null,
    };
    await expect(r.catalog(unknown, ["spells"])).rejects.toBeInstanceOf(ContextUnavailable);
  });

  it("the facade judges each character of an encounter by its own catalog", async () => {
    const facade = createInProcessFacade({
      rng: { int: (min) => min },
      fetchFile: async (_pack, file) => JSON.parse(await readFile(join(srdDir, file), "utf8")),
    });
    await facade.registerPacks([a1, a2]);
    const wren = fixtureJson("characters/wren.r2.transfer.json").content;
    const sable = fixtureJson("characters/sable.r1.transfer.json").content;
    const encounter = fixtureJson("encounters/mixed-duel.transfer.json").content.encounter;
    const party = {
      wren: { build: wren.build, state: wren.state, content: wren.context },
      sable: { build: sable.build, state: sable.state, content: sable.context },
    };
    const view = await facade.encounterView(encounter, party, refs.context_v1);
    expect(view.combatants.map((c) => c.error)).toEqual([null, null, null]);
    expect(view.combatants.find((c) => c.id === "synthetic-dummy")?.max_hp).toBe(30);
    const spark = (o: Awaited<ReturnType<typeof facade.combatantOptions>>) =>
      o.spells.find((s) => (s.action as { spell?: string }).spell === "synthetic-spark")?.action;
    // Sable's v2 spell (1st level) in a v1 world.
    expect(
      spark(await facade.combatantOptions(encounter, party, "sable", refs.context_v1)),
    ).toMatchObject({ slot_level: 1 });
    // A character without its own content plays on the campaign's packs (here the SRD alone).
    const plain = { wren: party.wren, sable: { build: sable.build, state: sable.state } };
    expect(
      spark(await facade.combatantOptions(encounter, plain, "sable", refs.context_v1)),
    ).toBeUndefined();
  });
});
