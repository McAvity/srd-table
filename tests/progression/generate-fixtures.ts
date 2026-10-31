/**
 * kenli F-002 T03: the frozen progression-plan fixtures (`e2e/fixtures/progression/`), shared by
 * the Vitest suite (Node facade) and the browser-worker parity probe. Positive plans are recorded
 * while building through the facade (they complete in the real SRD catalog); each negative one is
 * one deliberate change of a positive plan. `fixtures.test.ts` checks the files are current.
 *
 *   bun tests/progression/generate-fixtures.ts [--check]
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { EngineFacade } from "../../src/engine/facade";
import { nodeFacade } from "../../src/engine/node";
import { contentSha } from "../../src/lib/canonical";
import { clone, type J, POOL_PACK, packEnvelope, planBody, planFile, SPECS } from "./plans";

export const FIXTURE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../e2e/fixtures/progression",
);

export interface FixtureCase {
  readonly file: string;
  /** `ok`, or the refusal code compiling it must give. */
  readonly expect: string;
  readonly levels?: number;
  readonly why: string;
}

const choiceAt = (plan: J, level: number, suffix: string) =>
  plan.levels[level - 2].ops.findIndex((o: J) => o.op === "choice" && o.key.endsWith(suffix));

export async function buildFixtures(engine: EngineFacade = nodeFacade({ seed: 1 })) {
  const out = new Map<string, J>();
  const cases: FixtureCase[] = [];
  const add = async (
    name: string,
    expect: string,
    why: string,
    plan: J,
    envelopes?: J[],
    hash?: string,
  ) => {
    const file = `${name}.plan.json`;
    out.set(file, await planFile(plan, envelopes, hash));
    cases.push({
      file,
      expect,
      why,
      ...(expect === "ok" ? { levels: 1 + plan.levels.length } : {}),
    });
  };
  const srd = await engine.servedPack("srd-5.2.1");
  const fighter = (await planBody(engine, SPECS.fighter)).plan;
  const wizard = (await planBody(engine, SPECS.wizard)).plan;
  const sorcererBard = (await planBody(engine, SPECS.sorcererBard)).plan;
  const wizardFighter = (await planBody(engine, SPECS.wizardFighter)).plan;
  const warlock = (await planBody(engine, SPECS.warlock)).plan;
  const conAsi = (await planBody(engine, SPECS.fighterConAsi)).plan;
  const [poolRef] = await engine.registerPacks([POOL_PACK]);
  if (!poolRef) throw new Error("pool pack");
  const poolEnv = await packEnvelope(POOL_PACK, [srd]);
  const pool = (
    await planBody(engine, {
      id: "test-pool-feat",
      title: "Fighter 1–6 with a growing language feat",
      start: SPECS.fighter.start,
      levels: [
        { class_id: "fighter" },
        { class_id: "fighter" },
        {
          class_id: "fighter",
          edits: [{ type: "choice", key: "class:fighter:4#feat", values: ["test-tongues"] }],
        },
        { class_id: "fighter" },
        { class_id: "fighter" },
      ],
      content: { packs: [srd, poolRef], sources: null },
    })
  ).plan;

  // Positive: complete in the real catalog.
  await add(
    "fighter-1-6",
    "ok",
    "Fighter 1–6: S-new at each level, weapon mastery S-pool at 4",
    fighter,
  );
  await add("wizard-1-5", "ok", "Wizard 1–5: spellbook S-new, prepared/cantrips S-pool", wizard);
  await add("sorcerer-bard-1-3", "ok", "a legal multiclass Sorcerer 1 → Bard 2", sorcererBard);
  await add("wizard-fighter-1-2", "ok", "a legal multiclass Wizard 1 → Fighter 1", wizardFighter);
  await add(
    "pool-feat-1-6",
    "ok",
    "an invented feat's language pool grows at Fighter 6 (S-pool, no rest change), its pack carried as an envelope",
    pool,
    [poolEnv],
  );
  await add(
    "warlock-1-2",
    "ok",
    "Warlock 1–2: Eldritch Invocations (feature options) next to class traits",
    warlock,
  );
  await add(
    "fighter-con-asi-1-4",
    "ok",
    "Constitution +2 at Fighter 4: HP raised for every level (retroactive)",
    conAsi,
  );
  const partial = clone(fighter);
  partial.levels = partial.levels.slice(0, 2);
  await add("fighter-partial-1-3", "ok", "a partial plan (1–3) is legal", partial);

  // Negative: refused by the compiler (real catalog).
  const missing = clone(wizard);
  missing.levels[0].ops.splice(choiceAt(missing, 2, "#spellbook"), 1);
  await add(
    "wizard-missing-spellbook",
    "plan_choice_missing",
    "level 2's spellbook picks left out",
    missing,
  );
  const respec = clone(fighter);
  respec.levels[3].ops.push({
    op: "choice",
    key: "class:fighter#skills",
    values: ["acrobatics", "history"],
    origin: "author",
  });
  await add(
    "fighter-respec-skills",
    "plan_respec",
    "level 5 rewrites level 1's skills (S-frozen)",
    respec,
  );
  const vanished = clone(fighter);
  vanished.start.ops.push({ op: "species", id: "dwarf", origin: "author" });
  await add(
    "fighter-species-vanished",
    "plan_choice_vanished",
    "changing the species after its choices: normalisation deletes them",
    vanished,
  );
  const barbarian = clone(wizard);
  barbarian.levels = [
    { level: 2, ops: [{ op: "level_up", class_id: "barbarian", hp: null, origin: "author" }] },
  ];
  await add(
    "wizard-barbarian-illegal",
    "plan_step_illegal",
    "multiclass into Barbarian without Strength 13",
    barbarian,
  );
  const other = clone(wizardFighter);
  other.levels[0].ops.push({
    op: "choice",
    key: "class:wizard#prepared",
    values: ["sleep", "shield", "magic-missile", "detect-magic"],
    origin: "author",
  });
  await add(
    "wizard-fighter-pool-other-class",
    "plan_respec",
    "a Fighter level rewrites the Wizard's prepared pool (another class's)",
    other,
  );
  const shrink = clone(pool);
  const at = choiceAt(shrink, 6, "#tongues");
  if (at < 0) throw new Error("pool fixture: no tongues op at 6");
  const old = shrink.levels[4].ops[at].values;
  shrink.levels[4].ops[at].values = ["primordial", "sylvan", "infernal"]
    .filter((v) => !old.includes(v))
    .slice(0, 2);
  await add(
    "pool-feat-shrink",
    "plan_pool_shrink",
    "level 6 drops the pool's earlier language (no rest change)",
    shrink,
    [poolEnv],
  );
  const unknown = clone(fighter);
  unknown.levels[1].ops.push({
    op: "choice",
    key: "class:fighter:3#nothing",
    values: ["x"],
    origin: "author",
  });
  await add("fighter-unknown-key", "plan_step_illegal", "a key the build doesn't have", unknown);
  const missingPack = clone(fighter);
  missingPack.packs = [{ ...missingPack.packs[0], sha256: "0".repeat(64) }];
  await add(
    "fighter-pack-missing",
    "plan_pack_missing",
    "the SRD ref with another hash isn't here",
    missingPack,
  );
  const noEnvelope = clone(pool);
  await add(
    "pool-feat-no-envelope",
    "plan_pack_missing",
    "the invented pack isn't installed and isn't carried",
    noEnvelope,
  );
  const tampered = clone(fighter);
  const body = clone(fighter);
  tampered.start.ops.find((o: J) => o.op === "name").name = "Mallory";
  await add(
    "fighter-hash-tampered",
    "plan_hash_mismatch",
    "a changed op under the old hash",
    tampered,
    undefined,
    await contentSha(body),
  );
  const forbidden = clone(fighter);
  forbidden.levels[2].ops.push({ op: "level_hp", level: 2, hp: null, origin: "author" });
  await add(
    "fighter-level-hp-forbidden",
    "plan_op_forbidden",
    "rewriting a past level's HP",
    forbidden,
  );
  const split = clone(fighter);
  split.levels[4].ops.push({ op: "level_class", level: 3, class_id: "rogue", origin: "author" });
  await add(
    "split-decrease-forbidden",
    "plan_op_forbidden",
    "a later step lowering an earlier class's levels (a source's inconsistent split, B11-like)",
    split,
  );
  const envBad = clone(poolEnv) as J;
  envBad.content.files["feats.json"][0].name = "Test Tongues (changed)";
  await add(
    "pool-feat-envelope-tampered",
    "plan_pack_invalid",
    "an envelope whose files don't hash to its sha256",
    pool,
    [envBad],
  );
  const extraEnv = await packEnvelope(
    {
      ...POOL_PACK,
      "manifest.json": {
        ...(POOL_PACK["manifest.json"] as J),
        manifest: { ...(POOL_PACK["manifest.json"] as J).manifest, id: "test-other" },
      },
    },
    [srd],
  );
  await add(
    "fighter-envelope-unreferenced",
    "plan_pack_unreferenced",
    "an envelope of a pack the plan doesn't name",
    fighter,
    [extraEnv],
  );
  return { files: out, cases };
}

if (import.meta.main) {
  const { files, cases } = await buildFixtures();
  const all = new Map(files);
  all.set("index.json", { schema: "srd-table.progression-fixtures/1", cases });
  let diff = 0;
  for (const [name, value] of all) {
    const path = join(FIXTURE_DIR, name);
    const text = `${JSON.stringify(value, null, 2)}\n`;
    if (process.argv.includes("--check")) {
      let now = "";
      try {
        now = readFileSync(path, "utf8");
      } catch {}
      if (now !== text) {
        console.log(`DIFF ${name}`);
        diff++;
      }
    } else writeFileSync(path, text);
  }
  console.log(
    `${process.argv.includes("--check") ? (diff ? "FAIL" : "PASS") : "wrote"} ${all.size} files`,
  );
  process.exit(diff ? 1 : 0);
}
