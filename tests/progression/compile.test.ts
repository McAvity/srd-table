/**
 * kenli F-002 T03: `compilePlan` on the real SRD catalog (Node facade, the worker's own code): the
 * frozen fixtures give their expected outcome, positive plans complete at every level, choices are
 * classified from the engine's resolution (S-new / S-pool), checkpoints are derived and memoised by
 * `(plan_sha256, contextKey)`, and a call registers or changes nothing. Invented/SRD content only.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { nodeFacade } from "@/engine/node";
import { canonicalJson } from "@/lib/canonical";
import { prefixSha256 } from "@/progression/prefix";
import { buildFixtures, FIXTURE_DIR, type FixtureCase } from "./generate-fixtures";
import { clone, type J, POOL_PACK, planBody, SPECS } from "./plans";

const read = (name: string): J => JSON.parse(readFileSync(join(FIXTURE_DIR, name), "utf8"));
const index: { cases: FixtureCase[] } = read("index.json");

describe("compilePlan: the frozen fixtures", () => {
  it("are current (regenerated through the facade, byte for byte)", async () => {
    const { files, cases } = await buildFixtures(nodeFacade({ seed: 1 }));
    expect(cases).toEqual(index.cases);
    for (const [name, value] of files)
      expect(canonicalJson(read(name)), name).toBe(canonicalJson(value));
  }, 60_000);

  it.each(index.cases.map((c) => [c.file, c] as const))("%s", async (_name, c) => {
    const e = nodeFacade({ seed: 1 });
    const r = await e.compilePlan(read(c.file));
    if (c.expect === "ok") {
      if (!r.ok) throw new Error(`${r.problem.code}: ${r.problem.detail}`);
      expect(r.checkpoints).toHaveLength(c.levels as number);
      expect(r.range).toEqual({ from: 1, to: c.levels });
    } else {
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.problem.code).toBe(c.expect);
    }
  });
});

describe("compilePlan: checkpoints", () => {
  it("each checkpoint is the build replayed through the facade's setters, its prefix hash its own", async () => {
    const e = nodeFacade({ seed: 1 });
    const { builds } = await planBody(e, SPECS.wizard);
    const r = await e.compilePlan(read("wizard-1-5.plan.json"));
    if (!r.ok) throw new Error(r.problem.detail);
    for (const [i, cp] of r.checkpoints.entries()) {
      expect(canonicalJson(cp.build), `L${i + 1}`).toBe(canonicalJson(builds[i]));
      expect(cp.prefix_sha256).toBe(await prefixSha256(cp.build));
      expect(cp.level).toBe(i + 1);
    }
    expect(r.checkpoints[0]?.class_id).toBe("wizard");
  });

  it("choices are classified from the resolution: S-new at their level, S-pool for the gaining class's pools", async () => {
    const e = nodeFacade({ seed: 1 });
    const r = await e.compilePlan(read("fighter-1-6.plan.json"));
    if (!r.ok) throw new Error(r.problem.detail);
    const rules = r.checkpoints.flatMap((cp) =>
      cp.ops.filter((o) => o.op === "choice").map((o) => [cp.level, o.key, o.rule]),
    );
    expect(rules).toContainEqual([4, "class:fighter#weapon_mastery", "S-pool"]);
    expect(rules.filter(([, , rule]) => rule === "S-pool")).toHaveLength(1);
    expect(
      rules.filter(([level, , rule]) => rule === "S-new" && level === 4).length,
    ).toBeGreaterThan(0);
    // Nested feat keys (`feat:…@class:fighter:4#feat#…`) resolve as level-4 choices, not by their text.
    const nested = r.checkpoints[3]?.ops.find((o) => o.key?.startsWith("feat:"));
    expect(nested?.rule).toBe("S-new");
  });

  it("readable ops and the stats diff come from the engine's labels and sheet", async () => {
    const e = nodeFacade({ seed: 1 });
    const r = await e.compilePlan(read("fighter-1-6.plan.json"));
    if (!r.ok) throw new Error(r.problem.detail);
    const l5 = r.checkpoints[4];
    expect(l5?.ops[0]).toMatchObject({
      op: "level_up",
      class_id: "fighter",
      class_name: "Fighter",
      hp: null,
    });
    expect(l5?.changes.find((c) => c.field === "attacks_per_action")).toEqual({
      field: "attacks_per_action",
      before: 1,
      after: 2,
    });
    expect(l5?.changes.find((c) => c.field === "proficiency_bonus")).toEqual({
      field: "proficiency_bonus",
      before: 2,
      after: 3,
    });
    const mastery = r.checkpoints[3]?.ops.find((o) => o.key === "class:fighter#weapon_mastery");
    expect(mastery?.label).toBeTruthy();
    expect(mastery?.names?.length).toBe(mastery?.values?.length);
    expect(r.checkpoints[0]?.changes).toEqual([]);
  });

  it("a pack carried as an envelope compiles without being registered", async () => {
    const e = nodeFacade({ seed: 1 });
    const file = read("pool-feat-1-6.plan.json");
    const ref = file.plan.packs[1];
    const before = await e.localPackFiles(ref);
    const r = await e.compilePlan(file);
    expect(r.ok).toBe(true);
    expect(await e.localPackFiles(ref)).toEqual(before);
    expect(before).toEqual({ ok: false, code: "context_unavailable" });
    // Without the envelope the same plan is refused: nothing was kept from the first call.
    const bare = clone(file);
    delete bare.packs;
    const again = await e.compilePlan(bare);
    expect(again.ok ? "ok" : again.problem.code).toBe("plan_pack_missing");
  });

  it("an installed pack serves a plan without its envelope", async () => {
    const e = nodeFacade({ seed: 1 });
    await e.registerPacks([POOL_PACK]);
    const bare = clone(read("pool-feat-1-6.plan.json"));
    delete bare.packs;
    expect((await e.compilePlan(bare)).ok).toBe(true);
  });

  it("memoised by (plan_sha256, contextKey): the same result, the input never changed", async () => {
    const e = nodeFacade({ seed: 1 });
    const file = read("wizard-1-5.plan.json");
    const before = canonicalJson(file);
    const t0 = performance.now();
    const a = await e.compilePlan(file);
    const t1 = performance.now();
    const b = await e.compilePlan(clone(file));
    const t2 = performance.now();
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(t2 - t1).toBeLessThan(t1 - t0);
    expect(canonicalJson(file)).toBe(before);
    if (a.ok) expect(a.context_key).toContain(file.plan.packs[0].sha256);
  });

  it("a refused plan reports where: level, op index, key and the engine's words", async () => {
    const e = nodeFacade({ seed: 1 });
    const r = await e.compilePlan(read("wizard-barbarian-illegal.plan.json"));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.problem).toMatchObject({ code: "plan_step_illegal", level: 2, op: 0 });
    expect(r.problem.messages?.join(" ")).toMatch(/Strength 13/);
    const s = await e.compilePlan(read("fighter-respec-skills.plan.json"));
    if (!s.ok)
      expect(s.problem).toMatchObject({
        code: "plan_respec",
        level: 5,
        key: "class:fighter#skills",
      });
    const v = await e.compilePlan(read("fighter-species-vanished.plan.json"));
    if (!v.ok)
      expect(v.problem).toMatchObject({
        code: "plan_choice_vanished",
        level: 1,
        key: "species:human#size",
      });
  });

  it("the plan's sources filter is the catalog's: a source outside it makes a pack's content unavailable", async () => {
    const e = nodeFacade({ seed: 1 });
    const file = clone(read("pool-feat-1-6.plan.json"));
    file.plan.sources = ["srd-5.2.1"];
    const { contentSha } = await import("@/lib/canonical");
    file.plan_sha256 = await contentSha(file.plan);
    const r = await e.compilePlan(file);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problem).toMatchObject({ level: 4, code: "plan_step_illegal" });
  });
});

describe("nextStep (for T04's preview)", () => {
  it("the checkpoint after the character's level; done at the last; refused outside the range", async () => {
    const { nextStep } = await import("@/progression/steps");
    const e = nodeFacade({ seed: 1 });
    const r = await e.compilePlan(read("fighter-partial-1-3.plan.json"));
    const n = nextStep(r, 2);
    expect(n.kind).toBe("step");
    if (n.kind === "step") {
      expect(n.to.level).toBe(3);
      expect(n.to.ops[0]).toMatchObject({ op: "level_up", class_id: "fighter" });
    }
    expect(nextStep(r, 3)).toEqual({ kind: "done", level: 3 });
    expect(nextStep(r, 4)).toMatchObject({ kind: "refused", code: "plan_level_out_of_range" });
    const bad = await e.compilePlan(read("fighter-hash-tampered.plan.json"));
    expect(nextStep(bad, 1)).toMatchObject({
      kind: "refused",
      code: "plan_not_compiled",
      detail: "plan_hash_mismatch",
    });
  });
});
