/**
 * kenli F-007 T04, the engine side (contract offline.md §5.1.2, §5.2) on the real in-process facade
 * with the real SRD: stored pack rows are registered only when their whole files hash to their own
 * ref and key; `localPackFiles` says what is here without network; the campaign catalog bound to a
 * prepared exact context reads only those registered files — never the host, never another
 * version, also when one of them is missing or damaged.
 */

import { beforeAll, describe, expect, it } from "vitest";
import type { StoredPackRow } from "@/engine/content";
import { createInProcessFacade } from "@/engine/facade";
import { nodeFacade } from "@/engine/node";
import { type PackFiles, type PackRef, packRefOf } from "@/lib/canonical";
import { TEST_PACK } from "../fixtures/player-actions";

const key = (r: PackRef) => `${r.id}@${r.version ?? ""}#${r.sha256}`;
let srd: { ref: PackRef; files: PackFiles };
const disk = nodeFacade();

beforeAll(async () => {
  srd = await disk.servedPackFiles("srd-5.2.1");
});

/** A facade whose host counts every request and can be switched off or serve other bytes. */
function hosted() {
  const host = { calls: 0, down: false, other: false };
  const engine = createInProcessFacade({
    seed: 1,
    fetchFile: async (pack, file) => {
      host.calls++;
      if (host.down) throw new TypeError("Failed to fetch");
      const files = pack === "srd-5.2.1" ? srd.files : pack === "test-actions" ? TEST_PACK : null;
      if (!files || !Object.hasOwn(files, file)) throw new Error(`404 ${pack}/${file}`);
      const value = structuredClone(files[file]);
      if (host.other && file === "manifest.json")
        (value as { name?: string }).name = "served later with other bytes";
      return value;
    },
  });
  return { host, engine };
}

const row = (ref: PackRef, files: PackFiles, bundled = false): StoredPackRow => ({
  key: key(ref),
  ref,
  files,
  bundled,
});

describe("stored rows are verified before they are registered", () => {
  it("good rows register; a damaged, mis-keyed or incomplete row is reported corrupt and kept out", async () => {
    const { engine } = hosted();
    const test = await packRefOf(TEST_PACK);
    const damaged = structuredClone(TEST_PACK) as Record<string, unknown>;
    (damaged["manifest.json"] as { name: string }).name = "tampered";
    const noTable = { "manifest.json": srd.files["manifest.json"] } as PackFiles;
    const out = await engine.registerStoredPacks([
      row(srd.ref, srd.files, true),
      row(test, damaged),
      { ...row(test, TEST_PACK), key: `test-actions@9.9.9#${test.sha256}` },
      row({ ...srd.ref, sha256: "f".repeat(64) }, noTable),
    ]);
    expect(out.map((r) => r.status)).toEqual(["ok", "corrupt", "corrupt", "corrupt"]);
    expect(out[3]?.detail).toMatch(/^missing /);
    expect(await engine.localPackFiles(srd.ref)).toEqual({ ok: true });
    expect(await engine.localPackFiles(test)).toEqual({ ok: false, code: "pack_corrupt" });
    expect(await engine.localPackFiles({ ...test, sha256: "0".repeat(64) })).toEqual({
      ok: false,
      code: "context_unavailable",
    });
    // the good copy registered later is used; a bad row never takes a good registration out
    await engine.registerStoredPacks([row(test, TEST_PACK)]);
    expect(await engine.localPackFiles(test)).toEqual({ ok: true });
    await engine.registerStoredPacks([row(test, damaged)]);
    expect(await engine.localPackFiles(test)).toEqual({ ok: true });
  });
});

describe("the campaign catalog on a prepared exact context", () => {
  it("reads only the registered exact files: no host request, even with the host down", async () => {
    const { host, engine } = hosted();
    const test = await packRefOf(TEST_PACK);
    await engine.registerStoredPacks([row(srd.ref, srd.files, true), row(test, TEST_PACK)]);
    const settings = { packs: ["srd-5.2.1", "test-actions"], sources: null };
    host.down = true;
    expect(
      await engine.configureCampaign({
        settings,
        prepared: { packs: [srd.ref, test], sources: null },
      }),
    ).toBe(true);
    const packs = await engine.packs();
    expect(packs.map((p) => p.id)).toEqual(["srd-5.2.1", "test-actions"]);
    expect((await engine.entry("spells", "fire-bolt")) as { name?: string }).toMatchObject({
      name: "Fire Bolt",
    });
    expect(host.calls).toBe(0);
  });

  it("a prepared pack missing here is unavailable — never the host's (other) bytes instead", async () => {
    const { host, engine } = hosted();
    const test = await packRefOf(TEST_PACK);
    await engine.registerStoredPacks([row(srd.ref, srd.files, true)]);
    host.other = true; // the host is back, serving test-actions with other bytes
    await engine.configureCampaign({
      settings: { packs: ["srd-5.2.1", "test-actions"], sources: null },
      prepared: { packs: [srd.ref, test], sources: null },
    });
    await expect(engine.packs()).rejects.toThrow(/context_unavailable/);
    expect(host.calls).toBe(0);
  });

  it("other settings than the prepared ones: the settings' served packs, as before", async () => {
    const { host, engine } = hosted();
    const test = await packRefOf(TEST_PACK);
    await engine.registerStoredPacks([row(srd.ref, srd.files, true), row(test, TEST_PACK)]);
    const used = await engine.configureCampaign({
      settings: { packs: ["srd-5.2.1"], sources: null },
      prepared: { packs: [srd.ref, test], sources: null },
    });
    expect(used).toBe(false);
    expect((await engine.packs()).map((p) => p.id)).toEqual(["srd-5.2.1"]);
    expect(host.calls).toBeGreaterThan(0);
    // sources differ (canonically) → not used either; the same set in another order → used
    expect(
      await engine.configureCampaign({
        settings: { packs: ["srd-5.2.1"], sources: ["srd", "x"] },
        prepared: { packs: [srd.ref], sources: ["x", "srd", "x"] },
      }),
    ).toBe(true);
    expect(
      await engine.configureCampaign({
        settings: { packs: ["srd-5.2.1"], sources: ["srd"] },
        prepared: { packs: [srd.ref], sources: null },
      }),
    ).toBe(false);
  });

  it("two versions of a pack registered side by side: the prepared ref decides which one", async () => {
    const { host, engine } = hosted();
    const v1 = TEST_PACK;
    const v2 = structuredClone(TEST_PACK) as Record<string, { manifest: { version: string } }>;
    (v2["manifest.json"] as { manifest: { version: string } }).manifest.version = "2.0.0";
    const r1 = await packRefOf(v1);
    const r2 = await packRefOf(v2 as PackFiles);
    await engine.registerStoredPacks([
      row(srd.ref, srd.files, true),
      row(r1, v1),
      row(r2, v2 as PackFiles),
    ]);
    host.down = true;
    for (const ref of [r1, r2]) {
      await engine.configureCampaign({
        settings: { packs: ["srd-5.2.1", "test-actions"], sources: null },
        prepared: { packs: [srd.ref, ref], sources: null },
      });
      expect((await engine.packs()).find((p) => p.id === "test-actions")?.version).toBe(
        ref.version,
      );
    }
    expect(host.calls).toBe(0);
  });
});
