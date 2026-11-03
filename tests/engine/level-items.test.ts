import { describe, expect, it } from "vitest";
import { nodeFacade } from "../../src/engine/node";
import type { ContentContext, PackFiles } from "../../src/lib/canonical";
import { fighter } from "../fixtures/characters";

// kenli F-002 T12 (D043): the facade's `gainLevelItems` (the engine's), with an invented pack
// (`source: test`) whose SRD Champion grants a kit at Fighter 3. The app computes nothing.

const GIFT_PACK: PackFiles = {
  "manifest.json": {
    name: "test-gift",
    manifest: { id: "test-gift", version: "1.0.0", source: "test", requires: ["srd-5.2.1"] },
    patches: [
      {
        target: "subclasses/champion",
        op: "set",
        path: "features.3.items",
        value: [{ item: "disguise-kit", qty: 1 }],
      },
    ],
    tables: {},
  },
};

describe("D043: a level gained in play adds what its features grant (facade)", () => {
  const engine = nodeFacade({ seed: 1 });
  it("Fighter 2 → 3 (Champion with the test gift): the kit once, coins unchanged; 3 → 4 nothing", async () => {
    const [ref] = await engine.registerPacks([GIFT_PACK]);
    const srd = await engine.servedPack("srd-5.2.1");
    if (!ref) throw new Error("pack not registered");
    const ctx: ContentContext = { packs: [srd, ref], sources: null };
    const b2 = await fighter(engine, 2);
    const b3 = await fighter(engine, 3);
    const b4 = await fighter(engine, 4);
    const s2 = await engine.createState(b2, ctx);
    const r = await engine.gainLevelItems(b2, b3, s2, ctx);
    expect(r.items).toEqual([{ item: "disguise-kit", name: "Disguise Kit", qty: 1 }]);
    expect(r.state.currency).toEqual(s2.currency);
    expect(r.state.inventory.filter((i) => i.item === "disguise-kit").length).toBe(1);
    const again = await engine.gainLevelItems(b3, b4, r.state, ctx);
    expect(again.items).toEqual([]);
    expect(again.state).toEqual(r.state);
    // Without the pack (the SRD only): nothing, the state as given.
    const plain = await engine.gainLevelItems(b2, b3, s2);
    expect(plain.items).toEqual([]);
    expect(plain.state).toEqual(s2);
  });
});
