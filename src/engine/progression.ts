/**
 * kenli F-002 T03: a progression plan compiled against a real catalog (dnd5 contracts/progression.md
 * §3), in the worker with the facade (or in `nodeFacade`): the plan's ops replayed through the
 * builder's own setters, every one ending in its `commit()`; after each step the level must be the
 * step's, complete and in the class the step names. Which choices a step may write is judged from
 * the engine's resolution (`res.choice(key)`: level, definition, source), never from the key's
 * text (§3.1 S-new / S-pool / S-frozen); a key a setter's normalisation removes without being the
 * op's target is refused (`plan_choice_vanished`). Nothing is repaired; nothing is written.
 */

import {
  type ActiveChoice,
  BuildError,
  builder,
  type Catalog,
  type CharacterBuild,
  characterLevel,
  createBuild,
  type DerivedSheet,
  evaluate,
  lookup,
  resolve,
  skillName,
} from "srd-rules-engine";
import type { ContentContext } from "@/lib/canonical";
import type { ChoiceOp, LevelUpOp, ParsedPlan, PlanProblem, StartOp } from "@/progression/codec";
import { PlanRefusal, planRefuse } from "@/progression/codec";
import { prefixSha256 } from "@/progression/prefix";

/** The rule a choice of a step was allowed by (§3.1). */
export type ChoiceRule = "S-new" | "S-pool";

/** One op as a person reads it (T04 preview, T06 Markdown): the engine's labels and names. */
export interface ReadableOp {
  readonly index: number;
  readonly op: string;
  readonly origin: string;
  readonly why: string | null;
  /** `choice`: the engine's key, its label and the rule it was allowed by. */
  readonly key?: string;
  readonly label?: string;
  readonly rule?: ChoiceRule;
  readonly values?: readonly string[];
  /** The names of `values` (a replacement: `[old, new]`). */
  readonly names?: readonly string[];
  /** A `level_up`'s class, its name and the HP roll (`null`: fixed). */
  readonly class_id?: string;
  readonly class_name?: string;
  readonly hp?: number | null;
  /** Anything else (`class`, `species`, `name`…): the op's value as text. */
  readonly value?: string;
  /** kenli F-002 T06: `class`/`species`/`background`: the entity's name in the plan's catalog. */
  readonly value_name?: string;
  /**
   * kenli F-002 T06: `choice`: what grants the choice (its resolved source's name: a class
   * level, a feat, the background…), from the engine's resolution, not the key's text.
   */
  readonly source?: string;
}

/**
 * The numbers a checkpoint shows, read from the engine's typed `DerivedSheet` of the checkpoint's
 * build (nothing computed here). The build's sheet: the starting equipment the build itself takes,
 * never the armor a played state bought or wears (T04 previews that from the record's state).
 */
export interface CheckpointStats {
  readonly level: number;
  readonly classes: readonly { readonly class_id: string; readonly level: number }[];
  /** `max_hp.total`; `null` only when the engine has no HP yet (scores incomplete). */
  readonly max_hp: number | null;
  readonly armor_class: number;
  readonly proficiency_bonus: number;
  readonly initiative: number;
  readonly passive_perception: number;
  readonly attacks_per_action: number;
  readonly scores: Readonly<Record<string, number>>;
  readonly spell_slots: readonly number[];
  readonly feats: readonly string[];
  /** Chosen class feature options (Eldritch Invocations, Metamagic). */
  readonly features: readonly string[];
  /** Class, subclass, species and feat traits gained (Extra Attack, Action Surge…), by name. */
  readonly traits: readonly string[];
  readonly spells: readonly string[];
  /** kenli F-002 T06: proficient skills, those with Expertise, and languages, by name. */
  readonly skills: readonly string[];
  readonly expertise: readonly string[];
  readonly languages: readonly string[];
}

export interface StatChange {
  readonly field: string;
  readonly before: unknown;
  readonly after: unknown;
}

export interface PlanCheckpoint {
  readonly level: number;
  /** The class the level was gained in (level 1: the starting class). */
  readonly class_id: string;
  readonly class_level: number;
  /** The checkpoint's build: derived, never a second canon (§1). */
  readonly build: CharacterBuild;
  readonly prefix_sha256: string;
  readonly ops: readonly ReadableOp[];
  readonly stats: CheckpointStats;
  /** What changed against the previous checkpoint (level 1: nothing). */
  readonly changes: readonly StatChange[];
}

export type PlanCompileResult =
  | {
      readonly ok: true;
      readonly plan_sha256: string;
      readonly context: ContentContext;
      readonly context_key: string;
      readonly range: { readonly from: 1; readonly to: number };
      readonly checkpoints: readonly PlanCheckpoint[];
    }
  | {
      readonly ok: false;
      readonly plan_sha256: string | null;
      readonly problem: PlanProblem;
      /** Checkpoints before the refused step (informative only; the plan is refused). */
      readonly checkpoints: readonly PlanCheckpoint[];
    };

const keysOf = (b: CharacterBuild) => Object.keys(b.choices);

/** A setter, its refusal as `plan_step_illegal`, and no choice removed but its own target. */
function apply(
  build: CharacterBuild,
  fn: (b: CharacterBuild) => { build: CharacterBuild },
  where: { level: number; op: number; key?: string },
): CharacterBuild {
  let next: CharacterBuild;
  try {
    next = fn(build).build;
  } catch (error) {
    if (error instanceof BuildError)
      return planRefuse("plan_step_illegal", error.messages.join("; "), {
        ...where,
        messages: error.messages,
      });
    throw error;
  }
  const after = new Set(keysOf(next));
  const gone = keysOf(build).filter((k) => !after.has(k) && k !== where.key);
  if (gone.length)
    planRefuse("plan_choice_vanished", `removed by normalisation: ${gone.join(", ")}`, {
      ...where,
      key: gone[0] as string,
    });
  return next;
}

function startEdit(op: StartOp): (b: CharacterBuild, c: Catalog) => { build: CharacterBuild } {
  switch (op.op) {
    case "class":
      return (b, c) => builder.setClass(b, c, op.id);
    case "species":
      return (b, c) => builder.setSpecies(b, c, op.id);
    case "background":
      return (b, c) => builder.setBackground(b, c, op.id);
    case "ability_method":
      return (b, c) => builder.setAbilityMethod(b, c, op.method, [...(op.pool ?? [])]);
    case "base_scores":
      return (b, c) => builder.setBaseScores(b, c, op.scores);
    case "background_bonus":
      return (b, c) => builder.setBackgroundBonus(b, c, op.bonus);
    case "choice":
      return (b, c) => builder.setChoice(b, c, op.key, op.values);
    case "name":
      return (b, c) => builder.setName(b, c, op.name);
    case "alignment":
      return (b, c) => builder.setAlignment(b, c, op.alignment as never);
  }
}

/** The option names of a choice's values (unknown ids as themselves). */
function namesOf(
  res: ReturnType<typeof resolve>,
  ch: ActiveChoice,
  values: readonly string[],
): string[] {
  const options = [...res.options(ch), ...(ch.replaces ? res.replaceOld(ch) : [])];
  return values.map((v) => options.find((o) => o.id === v)?.name ?? v);
}

/**
 * §3.1: the rule a choice written in step `level` (class `classId`) is allowed by, from the
 * resolution after the step's `level_up`; `plan_respec` / `plan_pool_shrink` otherwise.
 */
function ruleOf(
  ch: ActiveChoice,
  op: ChoiceOp,
  build: CharacterBuild,
  level: number,
  classId: string | null,
  index: number,
): ChoiceRule {
  if (ch.level === level) return "S-new";
  if (
    ch.level < level &&
    ch.definition.scaling &&
    classId !== null &&
    ch.source.class_id === classId
  ) {
    if (ch.definition.rest_change === null) {
      const old = build.choices[op.key] ?? [];
      const missing = old.filter((v) => !op.values.includes(v));
      if (missing.length)
        planRefuse("plan_pool_shrink", `${op.key} drops ${missing.join(", ")}`, {
          level,
          op: index,
          key: op.key,
        });
    }
    return "S-pool";
  }
  return planRefuse(
    "plan_respec",
    `${op.key}: a choice of level ${ch.level} (${ch.definition.scaling ? `a pool of ${ch.source.class_id ?? "no class"}` : "fixed"}) can't change at level ${level}`,
    { level, op: index, key: op.key },
  );
}

function choiceStep(
  build: CharacterBuild,
  catalog: Catalog,
  op: ChoiceOp,
  level: number,
  classId: string | null,
  index: number,
): { build: CharacterBuild; readable: ReadableOp } {
  const res = resolve(build, catalog);
  const ch = res.choice(op.key);
  if (!ch) {
    // The setter names what's wrong with an unknown key (`builder.no_choice`).
    apply(build, (b) => builder.setChoice(b, catalog, op.key, op.values), {
      level,
      op: index,
      key: op.key,
    });
    return planRefuse("plan_step_illegal", `${op.key}: not a choice of this build`, {
      level,
      op: index,
      key: op.key,
    });
  }
  const rule = ruleOf(ch, op, build, level, classId, index);
  const next = apply(build, (b) => builder.setChoice(b, catalog, op.key, op.values), {
    level,
    op: index,
    key: op.key,
  });
  return {
    build: next,
    readable: {
      index,
      op: "choice",
      origin: op.origin,
      why: op.why ?? null,
      key: op.key,
      label: ch.label,
      rule,
      values: op.values,
      names: namesOf(res, ch, op.values),
      source: ch.source.name,
    },
  };
}

function statsOf(build: CharacterBuild, catalog: Catalog): CheckpointStats {
  const s: DerivedSheet = evaluate(build, catalog).sheet;
  return {
    level: s.level,
    classes: s.classes.map((c) => ({ class_id: c.class_id, level: c.level })),
    max_hp: s.max_hp ? s.max_hp.total : null,
    armor_class: s.armor_class.total,
    proficiency_bonus: s.proficiency_bonus,
    initiative: s.initiative.total,
    passive_perception: s.passive_perception,
    attacks_per_action: s.attacks_per_action,
    scores: { ...s.scores },
    spell_slots: [...s.spell_slots],
    feats: [...s.feats],
    features: [...s.features],
    traits: s.traits.map((t) => t.name),
    spells: s.spells.map((x) => x.name),
    skills: s.skills.filter((x) => x.proficient_from !== null).map((x) => skillName(x.skill)),
    expertise: s.skills.filter((x) => x.expertise).map((x) => skillName(x.skill)),
    languages: Object.keys(s.languages).map((id) => lookup(catalog.languages, id)?.name ?? id),
  };
}

/** `after` minus `before` as multisets: a trait or feat gained twice shows twice. */
function multisetMinus(after: readonly string[], before: readonly string[]): string[] {
  const left = new Map<string, number>();
  for (const x of before) left.set(x, (left.get(x) ?? 0) + 1);
  const out: string[] = [];
  for (const x of after) {
    const n = left.get(x) ?? 0;
    if (n > 0) left.set(x, n - 1);
    else out.push(x);
  }
  return out;
}

function changesOf(before: CheckpointStats | null, after: CheckpointStats): StatChange[] {
  if (!before) return [];
  const out: StatChange[] = [];
  for (const k of [
    "level",
    "max_hp",
    "armor_class",
    "proficiency_bonus",
    "initiative",
    "passive_perception",
    "attacks_per_action",
  ] as const)
    if (before[k] !== after[k]) out.push({ field: k, before: before[k], after: after[k] });
  for (const a of Object.keys({ ...before.scores, ...after.scores }))
    if (before.scores[a] !== after.scores[a])
      out.push({
        field: `scores.${a}`,
        before: before.scores[a] ?? null,
        after: after.scores[a] ?? null,
      });
  if (JSON.stringify(before.spell_slots) !== JSON.stringify(after.spell_slots))
    out.push({ field: "spell_slots", before: before.spell_slots, after: after.spell_slots });
  for (const k of [
    "feats",
    "features",
    "traits",
    "spells",
    "skills",
    "expertise",
    "languages",
  ] as const) {
    const added = multisetMinus(after[k], before[k]);
    const removed = multisetMinus(before[k], after[k]);
    if (added.length || removed.length) out.push({ field: k, before: removed, after: added });
  }
  return out;
}

/** After a step: the level is the step's and the whole build complete (§3). */
function checkComplete(build: CharacterBuild, catalog: Catalog, level: number): void {
  const at = characterLevel(build);
  if (at !== level)
    planRefuse("plan_level_mismatch", `character level ${at} after step ${level}`, { level });
  const ev = evaluate(build, catalog);
  const open = ev.report.issues.filter((i) => i.severity !== "note");
  const first = open[0];
  if (!first) return;
  const where = { level: first.level, ...(first.choice_key ? { key: first.choice_key } : {}) };
  if (first.severity === "pending")
    planRefuse(
      "plan_choice_missing",
      `level ${first.level}: ${first.choice_key ?? first.step}: ${first.message}`,
      where,
    );
  planRefuse("plan_step_illegal", `level ${first.level}: ${first.message}`, {
    ...where,
    messages: open.map((i) => i.message),
  });
}

/**
 * Compile a parsed plan against the catalog of its exact context. The plan's own `levels`
 * decide its range; a partial plan is legal (the delivery plans' 1–20 is checked by their own
 * harness, not here).
 */
export async function compileParsedPlan(
  parsed: ParsedPlan,
  catalog: Catalog,
  context: ContentContext,
  contextKeyText: string,
): Promise<PlanCompileResult> {
  const plan = parsed.file.plan;
  const checkpoints: PlanCheckpoint[] = [];
  try {
    if (parsed.range.to > catalog.creation.max_level)
      planRefuse(
        "plan_limit_levels",
        `level ${parsed.range.to} > the catalog's ${catalog.creation.max_level}`,
      );
    let build = createBuild();
    const readable: ReadableOp[] = [];
    for (const [i, op] of plan.start.ops.entries()) {
      if (op.op === "choice") {
        const r = choiceStep(build, catalog, op, 1, null, i);
        build = r.build;
        readable.push(r.readable);
        continue;
      }
      build = apply(build, (b) => startEdit(op)(b, catalog), { level: 1, op: i });
      readable.push({
        index: i,
        op: op.op,
        origin: op.origin,
        why: op.why ?? null,
        value:
          "id" in op
            ? op.id
            : "method" in op
              ? op.method
              : "name" in op
                ? op.name
                : "alignment" in op
                  ? op.alignment
                  : JSON.stringify("scores" in op ? op.scores : op.bonus),
        ...(op.op === "class" || op.op === "species" || op.op === "background"
          ? {
              value_name:
                (op.op === "class"
                  ? lookup(catalog.classes, op.id)?.name
                  : op.op === "species"
                    ? lookup(catalog.species, op.id)?.name
                    : lookup(catalog.backgrounds, op.id)?.name) ?? op.id,
            }
          : {}),
      });
    }
    checkComplete(build, catalog, 1);
    let stats = statsOf(build, catalog);
    checkpoints.push({
      level: 1,
      class_id: build.class_id ?? "",
      class_level: 1,
      build,
      prefix_sha256: await prefixSha256(build),
      ops: readable,
      stats,
      changes: [],
    });
    for (const step of plan.levels) {
      const L = step.level;
      const [first, ...rest] = step.ops as [LevelUpOp, ...ChoiceOp[]];
      build = apply(build, (b) => builder.levelUp(b, catalog, first.class_id, first.hp), {
        level: L,
        op: 0,
      });
      const gained = build.levels.at(-1)?.class_id;
      if (characterLevel(build) !== L || gained !== first.class_id)
        planRefuse(
          "plan_level_mismatch",
          `level_up ${first.class_id} gave level ${characterLevel(build)} in ${gained}`,
          {
            level: L,
            op: 0,
          },
        );
      const stepOps: ReadableOp[] = [
        {
          index: 0,
          op: "level_up",
          origin: first.origin,
          why: first.why ?? null,
          class_id: first.class_id,
          class_name: lookup(catalog.classes, first.class_id)?.name ?? first.class_id,
          hp: first.hp,
        },
      ];
      for (const [j, op] of rest.entries()) {
        const r = choiceStep(build, catalog, op, L, first.class_id, j + 1);
        build = r.build;
        stepOps.push(r.readable);
      }
      checkComplete(build, catalog, L);
      const next = statsOf(build, catalog);
      const classLevel =
        (build.class_id === first.class_id ? 1 : 0) +
        build.levels.filter((l) => l.class_id === first.class_id).length;
      checkpoints.push({
        level: L,
        class_id: first.class_id,
        class_level: classLevel,
        build,
        prefix_sha256: await prefixSha256(build),
        ops: stepOps,
        stats: next,
        changes: changesOf(stats, next),
      });
      stats = next;
    }
    return {
      ok: true,
      plan_sha256: parsed.plan_sha256,
      context,
      context_key: contextKeyText,
      range: parsed.range,
      checkpoints,
    };
  } catch (error) {
    if (error instanceof PlanRefusal)
      return { ok: false, plan_sha256: parsed.plan_sha256, problem: error.problem, checkpoints };
    throw error;
  }
}
