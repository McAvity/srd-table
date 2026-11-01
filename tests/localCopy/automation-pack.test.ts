import { afterAll, describe, expect, it } from "vitest";
import { commitLocalCopy } from "../../src/import/localCopy/commit";
import { exportLocalCopy } from "../../src/import/localCopy/export";
import { validateLocalCopy } from "../../src/import/localCopy/format";
import { planLocalCopy } from "../../src/import/localCopy/plan";
import { type ContentContext, type PackFiles, packRefOf } from "../../src/lib/canonical";
import { db, packKey } from "../../src/persistence/db";
import { useDocuments } from "../../src/store/documents";
import { rogue } from "../fixtures/characters";
import { addCharacter, bytesOf, Installations, ok } from "./helpers";

// kenli F-002 T12 final integration: a full local copy of a character whose pack keeps its play
// automation (R14-04: `automation` in manifest.json, as the engine's splitPack writes it) — the
// export was refused as `pack_invalid` (manifest.json.automation) before. Invented pack, `source: test`.

const AUTO_PACK: PackFiles = {
  "manifest.json": {
    name: "test-automation",
    manifest: { id: "test-automation", version: "1.0.0", source: "test", requires: ["srd-5.2.1"] },
    automation: [
      {
        id: "t-auto",
        name: "Test Auto",
        when: { class: "rogue" },
        grants: { actions: [{ id: "auto-x", name: "Test Auto Action", economy: "free" }] },
      },
    ],
    tables: {},
  },
};

const inst = new Installations();
afterAll(async () => {
  await inst.close();
});

async function autoContext(): Promise<ContentContext> {
  const ref = await packRefOf(AUTO_PACK);
  const database = await db();
  if (!(await database.get("packs", packKey(ref))))
    await database.add("packs", {
      key: packKey(ref),
      ref,
      files: AUTO_PACK,
      installed_at: 1,
      origin: { kind: "import", file: "test-automation.transfer.json", bytes_sha256: null },
    });
  await inst.fx.engine.registerPacks([AUTO_PACK]);
  const srd = await inst.fx.engine.servedPack("srd-5.2.1");
  return { packs: [srd, ref], sources: null };
}

describe("a full copy of a character on a pack with automation", () => {
  it("exported, validated and imported into another installation (no pack_invalid)", async () => {
    await inst.open("AU1");
    const ctx = await autoContext();
    const build = await rogue(inst.fx.engine, 3);
    const sheet = await inst.fx.engine.playSheet(
      build,
      await inst.fx.engine.createState(build, ctx),
      ctx,
    );
    expect(sheet.sheet.actions.some((a) => a.name === "Test Auto Action")).toBe(true);
    const id = await addCharacter(build, ctx, inst.fx.engine);
    const exported = ok(await exportLocalCopy(id));
    const bytes = await bytesOf(exported.blob);
    const v = await validateLocalCopy(bytes);
    expect(v.ok, v.ok ? "" : `${v.code}: ${v.detail}`).toBe(true);
    if (!v.ok) return;
    await inst.open("AU2");
    const plan = await planLocalCopy(v.copy, v.bytes_sha256, "auto.local-copy.json", {
      size: bytes.byteLength,
    });
    expect(plan.packs.new.map((p) => p.id)).toEqual(["test-automation"]);
    const r = ok(await commitLocalCopy(plan));
    expect(useDocuments.getState().characters[r.recordId]?.content?.packs.map((p) => p.id)).toEqual(
      ["srd-5.2.1", "test-automation"],
    );
  }, 90_000);
});
