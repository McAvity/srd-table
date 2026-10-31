/**
 * kenli F-002 T03: the mechanical prefix (§4.1) ignores exactly name, alignment, version and the
 * declared packs — never a historical choice or HP; differences are listed field by field (§4.2);
 * a bind's context is compared exactly (§6.1: refs as a prefix, `sources` as `contextKey`, `null`
 * distinct from every list); `build.packs` only grows at its end (§6.2).
 */

import type { CharacterBuild } from "srd-rules-engine";
import { describe, expect, it } from "vitest";
import { nodeFacade } from "@/engine/node";
import type { PackRef } from "@/lib/canonical";
import {
  appendBuildPack,
  compareContext,
  isAppendOnly,
  mech,
  mechDifferences,
  prefixSha256,
  sourcesDifference,
} from "@/progression/prefix";
import { fighter } from "../fixtures/characters";
import { clone, type J } from "./plans";

const ref = (id: string, sha = "a", version: string | null = "1"): PackRef => ({
  id,
  version,
  sha256: sha.repeat(64),
});
const SRD = ref("srd-5.2.1", "4");

describe("prefix", () => {
  it("ignores name, alignment, version and packs only", async () => {
    const e = nodeFacade({ seed: 1 });
    const b = await fighter(e, 3);
    const h = await prefixSha256(b);
    const cosmetic = {
      ...b,
      name: "Other",
      alignment: "LE",
      packs: ["x"],
      version: 99,
    } as unknown as CharacterBuild;
    expect(await prefixSha256(cosmetic)).toBe(h);
    expect(Object.keys(mech(b))).not.toContain("name");
    expect(mechDifferences(b, cosmetic)).toEqual([]);
  });

  it("any historical choice or HP changes it, listed by field", async () => {
    const e = nodeFacade({ seed: 1 });
    const b = await fighter(e, 3);
    const h = await prefixSha256(b);
    const hp = clone(b) as J;
    hp.levels[0].hp = 6;
    expect(await prefixSha256(hp)).not.toBe(h);
    expect(mechDifferences(hp, b)).toEqual([
      {
        path: "levels[0]",
        record: { class_id: "fighter", hp: 6 },
        plan: { class_id: "fighter", hp: null },
      },
    ]);
    const pick = clone(b) as J;
    pick.choices["class:fighter#skills"] = ["acrobatics", "history"];
    expect(await prefixSha256(pick)).not.toBe(h);
    expect(mechDifferences(pick, b).map((d) => d.path)).toEqual(["choices[class:fighter#skills]"]);
    const extra = clone(b) as J;
    extra.choices["test#x"] = ["y"];
    expect(mechDifferences(extra, b)).toEqual([
      { path: "choices[test#x]", record: ["y"], plan: null },
    ]);
    const shorter = clone(b) as J;
    shorter.levels.pop();
    expect(mechDifferences(shorter, b).map((d) => d.path)).toContain("levels.length");
  });
});

describe("context (§6.1)", () => {
  it("equal, add-on, old ref changed, other pack", () => {
    const base = { packs: [SRD, ref("kenli-pack", "5", "0.5.0")], sources: null };
    expect(compareContext(base, base)).toEqual({ ok: true, kind: "equal" });
    const addon = ref("kenli-k01-addon", "c", "1.0.1");
    expect(compareContext(base, { packs: [...base.packs, addon], sources: null })).toEqual({
      ok: true,
      kind: "addon",
      extra: [addon],
    });
    const old = compareContext(
      { packs: [SRD, ref("kenli-pack", "4", "0.4.0")], sources: null },
      { packs: [...base.packs, addon], sources: null },
    );
    expect(old.ok ? "ok" : old.code).toBe("bind_old_ref_changed");
    const other = compareContext({ packs: [SRD, ref("other")], sources: null }, base);
    expect(other.ok ? "ok" : other.code).toBe("bind_context_mismatch");
    const longer = compareContext({ packs: [...base.packs, addon], sources: null }, base);
    expect(longer.ok ? "ok" : longer.code).toBe("bind_context_mismatch");
  });

  it("sources: a set, null distinct from every list (also [])", () => {
    expect(sourcesDifference(null, null)).toBeNull();
    expect(sourcesDifference(["b", "a", "a"], ["a", "b"])).toBeNull();
    expect(sourcesDifference(null, [])).toBe("null_to_list");
    expect(sourcesDifference([], null)).toBe("list_to_null");
    expect(sourcesDifference(["a"], ["a", "b"])).toBe("list_changed");
    const r = compareContext({ packs: [SRD], sources: null }, { packs: [SRD], sources: [] });
    expect(r).toMatchObject({
      ok: false,
      code: "context_sources_mismatch",
      sources: "null_to_list",
    });
  });
});

describe("build.packs, append only (§6.2)", () => {
  const e = nodeFacade({ seed: 1 });
  const parse = (v: unknown) => e.parseBuild(v);

  it("adds at the end; already last: unchanged; elsewhere: refused", async () => {
    const b = { ...(await fighter(e, 1)), packs: ["kenli-pack"] } as CharacterBuild;
    const r = await appendBuildPack(b, "kenli-k01-addon", parse);
    expect(r.ok && r.build.packs).toEqual(["kenli-pack", "kenli-k01-addon"]);
    if (!r.ok) return;
    const again = await appendBuildPack(r.build, "kenli-k01-addon", parse);
    expect(again).toMatchObject({ ok: true, appended: false });
    const moved = await appendBuildPack(r.build, "kenli-pack", parse);
    expect(moved).toMatchObject({ ok: false, code: "bind_build_packs_not_append" });
    const none = await appendBuildPack(await fighter(e, 1), "x", parse);
    expect(none.ok && none.build.packs).toEqual(["x"]);
  });

  it("isAppendOnly: removal or reordering refused", () => {
    expect(isAppendOnly(["a"], ["a", "b"])).toBe(true);
    expect(isAppendOnly(undefined, ["a"])).toBe(true);
    expect(isAppendOnly(["a", "b"], ["a"])).toBe(false);
    expect(isAppendOnly(["a", "b"], ["b", "a"])).toBe(false);
  });
});
