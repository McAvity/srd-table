/**
 * kenli F-002 T03: the pure codec of a progression plan (`srd-table.progression-plan/1`, dnd5
 * docs/features/F-002-level-up/contracts/progression.md §2; kenli F-002 T13: `/2`, the same plan
 * plus its guided starting kits and play guide, contracts/progression-guide.md). Strict: unknown fields and versions
 * are refused, never stripped; limits are checked before anything else is read; the plan's hash is
 * the canonical JSON's (`canonical.ts`); pack envelopes are checked by the transfer format's own
 * `checkEnvelope`. No engine, worker, DOM or storage here: the rules are judged by the engine
 * (`compilePlan` in the worker), and nothing here writes. Ids and keys are data, never property
 * names or paths (Map/own-key reads only).
 */

import { jsonDepth } from "@/import/localCopy/codec";
import {
  checkEnvelope,
  type Envelope,
  ImportError,
  packOfEnvelope,
  TRANSFER_FORMAT,
} from "@/import/transfer";
import { canonicalJson, contentSha, type PackRef } from "@/lib/canonical";

export const PLAN_FORMAT = "srd-table.progression-plan/1";
/** kenli F-002 T13: `/1` plus `plan.guide` (required there, never in `/1`), hashed with the plan. */
export const PLAN_FORMAT_GUIDED = "srd-table.progression-plan/2";
/** The formats this reader takes; a higher `/N` is `plan_format_newer` (an older app's answer). */
export const PLAN_FORMATS = [PLAN_FORMAT, PLAN_FORMAT_GUIDED] as const;
export type PlanFormat = (typeof PLAN_FORMATS)[number];
const FORMAT_FAMILY = /^srd-table\.progression-plan\/(\d+)$/;

/** The contract's limits (§2.6). Raising one goes back to review. */
export const PLAN_LIMITS = {
  /** The whole file with its envelopes, UTF-8 bytes (= the import's fetch limit). */
  fileBytes: 20 * 2 ** 20,
  /** The canonical `plan` object, UTF-8 bytes. */
  planBytes: 2 * 2 ** 20,
  /** Steps after level 1 (level ≤ 20). */
  levels: 19,
  maxLevel: 20,
  ops: 2048,
  stepOps: 128,
  packs: 64,
  jsonDepth: 64,
  /** Levels of `manifest.requires` below a pack (= the local copy's `dependencyDepth`). */
  dependencyDepth: 8,
  title: 200,
  why: 1000,
  authorship: 2000,
  key: 200,
  values: 64,
  value: 128,
  name: 200,
  id: 200,
  sources: 64,
  /** kenli F-002 T13, `/2` guide (contracts/progression-guide.md §2). */
  kits: 8,
  kitItems: 32,
  units: 1000,
  guideList: 32,
  guideText: 1000,
  guideBase: 4000,
  guideLevel: 2000,
  priority: 64,
} as const;

/** Refusal codes of the codec and the compiler (contract §2–3, §6). */
export type PlanCode =
  | "plan_unknown_field"
  | "plan_missing_field"
  | "plan_format_newer"
  | "plan_format_unknown"
  | "plan_field_invalid"
  | "plan_hash_mismatch"
  | "plan_pack_missing"
  /** A pack's files aren't the exact ref the plan names (id, version and hash). */
  | "plan_pack_identity"
  | "plan_pack_invalid"
  | "plan_pack_unreferenced"
  | "plan_pack_order"
  | "plan_op_forbidden"
  | "plan_level_up_position"
  | "plan_hp_invalid"
  | "plan_replace_arity"
  | "plan_level_gap"
  | "plan_limit_bytes"
  | "plan_limit_plan_bytes"
  | "plan_limit_levels"
  | "plan_limit_ops"
  | "plan_limit_step_ops"
  | "plan_limit_packs"
  | "plan_limit_depth"
  | "plan_limit_text"
  | "plan_step_illegal"
  | "plan_choice_missing"
  | "plan_choice_vanished"
  | "plan_respec"
  | "plan_pool_shrink"
  | "plan_level_mismatch"
  /** kenli F-002 T13: a guide's item not in the plan's catalog, or a kit item without a price. */
  | "plan_guide_item";

export interface PlanProblem {
  readonly code: PlanCode;
  readonly detail: string;
  /** The character level of the step (1: `start`), when the problem is in one. */
  readonly level?: number;
  /** The op's index in its step, when the problem is in one. */
  readonly op?: number;
  readonly key?: string;
  /** The engine's refusal, verbatim (`plan_step_illegal`). */
  readonly messages?: readonly string[];
}

export type Origin = "source" | "adaptation" | "author";
export const ORIGINS: readonly Origin[] = ["source", "adaptation", "author"];
export type AbilityId = "str" | "dex" | "con" | "int" | "wis" | "cha";
export const ABILITY_IDS: readonly AbilityId[] = ["str", "dex", "con", "int", "wis", "cha"];

interface OpBase {
  readonly origin: Origin;
  readonly why?: string;
}
export type StartOp = OpBase &
  (
    | { readonly op: "class" | "species" | "background"; readonly id: string }
    | {
        readonly op: "ability_method";
        readonly method: "standard_array" | "point_buy" | "roll";
        readonly pool?: readonly number[];
      }
    | { readonly op: "base_scores"; readonly scores: Readonly<Record<AbilityId, number>> }
    | {
        readonly op: "background_bonus";
        readonly bonus: Readonly<Partial<Record<AbilityId, number>>>;
      }
    | { readonly op: "choice"; readonly key: string; readonly values: readonly string[] }
    | { readonly op: "name"; readonly name: string }
    | { readonly op: "alignment"; readonly alignment: string }
  );
export type LevelUpOp = OpBase & {
  readonly op: "level_up";
  readonly class_id: string;
  readonly hp: number | null;
};
export type ChoiceOp = Extract<StartOp, { op: "choice" }>;
export type LevelOp = LevelUpOp | ChoiceOp;
export type PlanOp = StartOp | LevelUpOp;

export interface PlanStep {
  readonly level: number;
  readonly ops: readonly LevelOp[];
}
export interface ProgressionPlan {
  readonly id: string;
  readonly revision: number;
  readonly title: string;
  readonly language: string;
  readonly authorship: {
    readonly source: string;
    readonly adaptation: string;
    readonly author: string;
  };
  readonly packs: readonly PackRef[];
  readonly sources: readonly string[] | null;
  readonly start: { readonly equipment: "starting" | "none"; readonly ops: readonly StartOp[] };
  readonly levels: readonly PlanStep[];
  /** kenli F-002 T13: `/2` only (required there); absent in `/1`. */
  readonly guide?: PlanGuide;
}

/** kenli F-002 T13 (`/2`): one item of a kit — `units` wanted on the character, worn/held or not. */
export interface KitItem {
  readonly item: string;
  readonly units: number;
  readonly equip: boolean;
  readonly why?: string;
  readonly origin: Origin;
}
/** A starting kit from a character level on (until the next kit's `from_level`). */
export interface PlanKit {
  readonly from_level: number;
  readonly title: string;
  readonly items: readonly KitItem[];
  readonly why?: string;
  readonly origin: Origin;
}
export interface GuideNote {
  readonly text: string;
  readonly origin: Origin;
}
/** kenli F-002 T13: the guided plan's metadata (contracts/progression-guide.md §2). */
export interface PlanGuide {
  readonly kits: readonly PlanKit[];
  readonly play: {
    readonly base: GuideNote;
    readonly levels: readonly (GuideNote & { readonly level: number })[];
  };
  /** Later purchases, by priority (a recommendation: owning or affording it is not implied). */
  readonly purchases: readonly (GuideNote & { readonly item: string; readonly priority: number })[];
  /** Cheaper or different choices: `item` instead of `instead_of`. */
  readonly alternatives: readonly (GuideNote & {
    readonly item: string;
    readonly instead_of: string;
  })[];
  /** What the app's controls do here, and what stays the player's or the DM's. */
  readonly controls: readonly GuideNote[];
}
export interface PlanFile {
  readonly format: PlanFormat;
  readonly plan_sha256: string;
  readonly plan: ProgressionPlan;
  readonly packs?: readonly Envelope[];
}

/** A plan read whole: the document, its envelopes verified, the levels it covers. */
export interface ParsedPlan {
  readonly ok: true;
  readonly file: PlanFile;
  readonly plan_sha256: string;
  /** The envelopes by their pack's hash (each verified against its own `sha256`). */
  readonly envelopes: ReadonlyMap<string, Envelope>;
  readonly range: { readonly from: 1; readonly to: number };
}
export type PlanRefused = { readonly ok: false; readonly problem: PlanProblem };

/** A controlled refusal inside the codec (returned as `PlanRefused`, never escapes). */
export class PlanRefusal extends Error {
  override name = "PlanRefusal";
  constructor(readonly problem: PlanProblem) {
    super(`${problem.code}: ${problem.detail}`);
  }
}
export function planRefuse(
  code: PlanCode,
  detail: string,
  extra: Omit<PlanProblem, "code" | "detail"> = {},
): never {
  throw new PlanRefusal({ code, detail, ...extra });
}

// ───────────────────────── typed reads ─────────────────────────

const HEX64 = /^[0-9a-f]{64}$/;
const SLUG = /^[a-z0-9][a-z0-9._-]*$/;
/** An engine choice key (§2.8): opaque, `:` `#` `@` `+` `=` separators, at least one `#`. */
export const CHOICE_KEY = /^[a-z0-9][a-z0-9:#._@+=-]*$/;
const VALUE = /^[a-z0-9][a-z0-9._:-]*$/;
const LANGUAGE = /^[a-z]{2,3}(-[A-Za-z0-9]{1,8})*$/;
const SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._ -]*$/;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const codePoints = (s: string) => [...s].length;

/** Exact keys: unknown → `plan_unknown_field`, a required one absent → `plan_missing_field`. */
function fields(
  v: unknown,
  where: string,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (!isObj(v)) return planRefuse("plan_field_invalid", `${where}: not an object`);
  for (const k of Object.keys(v))
    if (!required.includes(k) && !optional.includes(k))
      planRefuse("plan_unknown_field", `${where}.${k}`);
  for (const k of required)
    if (!Object.hasOwn(v, k)) planRefuse("plan_missing_field", `${where}.${k}`);
  return v;
}
function str(
  v: unknown,
  where: string,
  max: number,
  pattern?: RegExp,
  limitCode?: PlanCode,
): string {
  if (typeof v !== "string") return planRefuse("plan_field_invalid", `${where}: not a string`);
  if (codePoints(v) > max) planRefuse(limitCode ?? "plan_field_invalid", `${where}: over ${max}`);
  if (pattern && !pattern.test(v))
    planRefuse("plan_field_invalid", `${where}: ${JSON.stringify(v.slice(0, 80))}`);
  return v;
}
function text(v: unknown, where: string, max: number): string {
  const s = str(v, where, Number.POSITIVE_INFINITY);
  if (codePoints(s) > max) planRefuse("plan_limit_text", `${where}: ${codePoints(s)} > ${max}`);
  return s;
}
function int(v: unknown, where: string, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max)
    return planRefuse("plan_field_invalid", `${where}: ${JSON.stringify(v)}`);
  return v;
}
function arr(v: unknown, where: string): unknown[] {
  if (!Array.isArray(v)) return planRefuse("plan_field_invalid", `${where}: not a list`);
  return v;
}

// ───────────────────────── ops ─────────────────────────

const FORBIDDEN = new Set(["remove_level", "level_class", "level_hp"]);
const START_OPS = new Set([
  "class",
  "species",
  "background",
  "ability_method",
  "base_scores",
  "background_bonus",
  "choice",
  "name",
  "alignment",
]);

function opCommon(o: Record<string, unknown>, where: string): void {
  if (!(typeof o.origin === "string" && (ORIGINS as readonly string[]).includes(o.origin)))
    planRefuse("plan_field_invalid", `${where}.origin: ${JSON.stringify(o.origin)}`);
  if (o.why !== undefined) text(o.why, `${where}.why`, PLAN_LIMITS.why);
}

function abilityMap(v: unknown, where: string, all: boolean, min: number, max: number): void {
  if (!isObj(v)) planRefuse("plan_field_invalid", `${where}: not an object`);
  const m = v as Record<string, unknown>;
  for (const k of Object.keys(m)) {
    if (!(ABILITY_IDS as readonly string[]).includes(k))
      planRefuse("plan_unknown_field", `${where}.${k}`);
    int(m[k], `${where}.${k}`, min, max);
  }
  if (all)
    for (const a of ABILITY_IDS)
      if (!Object.hasOwn(m, a)) planRefuse("plan_missing_field", `${where}.${a}`);
}

function choiceOp(o: Record<string, unknown>, where: string): void {
  fields(o, where, ["op", "key", "values", "origin"], ["why"]);
  const key = str(o.key, `${where}.key`, PLAN_LIMITS.key, CHOICE_KEY);
  if (!key.includes("#")) planRefuse("plan_field_invalid", `${where}.key: no '#' in ${key}`);
  const values = arr(o.values, `${where}.values`);
  if (values.length > PLAN_LIMITS.values)
    planRefuse("plan_field_invalid", `${where}.values: over ${PLAN_LIMITS.values}`);
  for (const [i, x] of values.entries()) str(x, `${where}.values[${i}]`, PLAN_LIMITS.value, VALUE);
  if (key.includes("#replace:") && !(values.length === 2 && values[0] !== values[1]))
    planRefuse("plan_replace_arity", `${where}: ${JSON.stringify(values)}`, { key });
  opCommon(o, where);
}

function startOp(v: unknown, where: string): void {
  if (!isObj(v)) planRefuse("plan_field_invalid", `${where}: not an object`);
  const op = v.op;
  if (typeof op !== "string") planRefuse("plan_missing_field", `${where}.op`);
  if (FORBIDDEN.has(op) || op === "level_up")
    planRefuse("plan_op_forbidden", `${where}: ${op} in start`);
  if (!START_OPS.has(op)) planRefuse("plan_field_invalid", `${where}.op: ${op}`);
  switch (op) {
    case "class":
    case "species":
    case "background":
      fields(v, where, ["op", "id", "origin"], ["why"]);
      str(v.id, `${where}.id`, PLAN_LIMITS.id, SLUG);
      break;
    case "ability_method": {
      fields(v, where, ["op", "method", "origin"], ["pool", "why"]);
      if (!["standard_array", "point_buy", "roll"].includes(String(v.method)))
        planRefuse("plan_field_invalid", `${where}.method: ${JSON.stringify(v.method)}`);
      if (v.pool !== undefined) {
        if (v.method !== "roll") planRefuse("plan_field_invalid", `${where}.pool: only for roll`);
        const pool = arr(v.pool, `${where}.pool`);
        if (pool.length !== 6) planRefuse("plan_field_invalid", `${where}.pool: six scores`);
        for (const [i, x] of pool.entries()) int(x, `${where}.pool[${i}]`, 3, 18);
      }
      break;
    }
    case "base_scores":
      fields(v, where, ["op", "scores", "origin"], ["why"]);
      abilityMap(v.scores, `${where}.scores`, true, 1, 30);
      break;
    case "background_bonus":
      fields(v, where, ["op", "bonus", "origin"], ["why"]);
      abilityMap(v.bonus, `${where}.bonus`, false, 0, 2);
      break;
    case "choice":
      choiceOp(v, where);
      return;
    case "name":
      fields(v, where, ["op", "name", "origin"], ["why"]);
      text(v.name, `${where}.name`, PLAN_LIMITS.name);
      break;
    case "alignment":
      fields(v, where, ["op", "alignment", "origin"], ["why"]);
      str(v.alignment, `${where}.alignment`, 8, /^[A-Za-z]{1,8}$/);
      break;
  }
  opCommon(v, where);
}

function levelOp(v: unknown, where: string, index: number, level: number): void {
  if (!isObj(v)) planRefuse("plan_field_invalid", `${where}: not an object`);
  const op = v.op;
  if (typeof op !== "string") planRefuse("plan_missing_field", `${where}.op`);
  if (FORBIDDEN.has(op) || (START_OPS.has(op) && op !== "choice"))
    planRefuse("plan_op_forbidden", `${where}: ${op} in a step`, { level, op: index });
  if (op === "level_up") {
    if (index !== 0)
      planRefuse("plan_level_up_position", `${where}: level_up at ${index}`, { level, op: index });
    fields(v, where, ["op", "class_id", "hp", "origin"], ["why"]);
    str(v.class_id, `${where}.class_id`, PLAN_LIMITS.id, SLUG);
    if (!(v.hp === null || (typeof v.hp === "number" && Number.isInteger(v.hp) && v.hp >= 1)))
      planRefuse("plan_hp_invalid", `${where}.hp: ${JSON.stringify(v.hp)}`, { level, op: index });
    opCommon(v, where);
    return;
  }
  if (op !== "choice") planRefuse("plan_field_invalid", `${where}.op: ${op}`);
  if (index === 0)
    planRefuse("plan_level_up_position", `${where}: no level_up first`, { level, op: 0 });
  try {
    choiceOp(v, where);
  } catch (e) {
    if (e instanceof PlanRefusal) throw new PlanRefusal({ level, op: index, ...e.problem });
    throw e;
  }
}

// ───────────────────────── the document ─────────────────────────

function packRef(v: unknown, where: string): PackRef {
  const p = fields(v, where, ["id", "version", "sha256"]);
  str(p.id, `${where}.id`, PLAN_LIMITS.id, SLUG);
  if (p.version !== null) str(p.version, `${where}.version`, PLAN_LIMITS.id);
  str(p.sha256, `${where}.sha256`, 64, HEX64);
  return p as unknown as PackRef;
}

// ───────────────────────── the guide (`/2`) ─────────────────────────

/** Plain text: no control characters but a line break (shown escaped, never as HTML/Markdown). */
const isControl = (c: number) => (c <= 0x1f && c !== 0x0a) || (c >= 0x7f && c <= 0x9f);
function guideText(v: unknown, where: string, max: number): string {
  const s = text(v, where, max);
  for (const ch of s)
    if (isControl(ch.codePointAt(0) as number))
      planRefuse("plan_field_invalid", `${where}: a control character`);
  return s;
}
function origin(v: unknown, where: string): void {
  if (!(typeof v === "string" && (ORIGINS as readonly string[]).includes(v)))
    planRefuse("plan_field_invalid", `${where}: ${JSON.stringify(v)}`);
}
function note(v: unknown, where: string, extra: readonly string[], max: number) {
  const n = fields(v, where, ["text", "origin", ...extra]);
  guideText(n.text, `${where}.text`, max);
  origin(n.origin, `${where}.origin`);
  return n;
}
function list(v: unknown, where: string, max: number): unknown[] {
  const l = arr(v, where);
  if (l.length > max) planRefuse("plan_field_invalid", `${where}: over ${max}`);
  return l;
}

/** The `/2` guide (contracts/progression-guide.md §2): strict, bounded, its levels in the plan. */
export function checkGuide(v: unknown, top: number): PlanGuide {
  const g = fields(v, "plan.guide", ["kits", "play", "purchases", "alternatives", "controls"]);
  const kits = list(g.kits, "plan.guide.kits", PLAN_LIMITS.kits);
  if (kits.length === 0) planRefuse("plan_field_invalid", "plan.guide.kits: empty");
  let last = 0;
  for (const [i, k] of kits.entries()) {
    const w = `plan.guide.kits[${i}]`;
    const kit = fields(k, w, ["from_level", "title", "items", "origin"], ["why"]);
    const from = int(kit.from_level, `${w}.from_level`, 1, top);
    if (i === 0 && from !== 1) planRefuse("plan_field_invalid", `${w}.from_level: the first is 1`);
    if (from <= last) planRefuse("plan_field_invalid", `${w}.from_level: not after ${last}`);
    last = from;
    guideText(kit.title, `${w}.title`, PLAN_LIMITS.title);
    if (kit.why !== undefined) guideText(kit.why, `${w}.why`, PLAN_LIMITS.guideText);
    origin(kit.origin, `${w}.origin`);
    const items = list(kit.items, `${w}.items`, PLAN_LIMITS.kitItems);
    const ids = new Set<string>();
    for (const [j, x] of items.entries()) {
      const iw = `${w}.items[${j}]`;
      const it = fields(x, iw, ["item", "units", "equip", "origin"], ["why"]);
      const id = str(it.item, `${iw}.item`, PLAN_LIMITS.id, SLUG);
      if (ids.has(id)) planRefuse("plan_field_invalid", `${iw}.item: ${id} twice`);
      ids.add(id);
      int(it.units, `${iw}.units`, 1, PLAN_LIMITS.units);
      if (typeof it.equip !== "boolean")
        planRefuse("plan_field_invalid", `${iw}.equip: ${JSON.stringify(it.equip)}`);
      if (it.why !== undefined) guideText(it.why, `${iw}.why`, PLAN_LIMITS.guideText);
      origin(it.origin, `${iw}.origin`);
    }
  }
  const play = fields(g.play, "plan.guide.play", ["base", "levels"]);
  note(play.base, "plan.guide.play.base", [], PLAN_LIMITS.guideBase);
  const levels = list(play.levels, "plan.guide.play.levels", PLAN_LIMITS.levels);
  let prev = 1;
  for (const [i, l] of levels.entries()) {
    const w = `plan.guide.play.levels[${i}]`;
    const n = note(l, w, ["level"], PLAN_LIMITS.guideLevel);
    const level = int(n.level, `${w}.level`, 2, top);
    if (level <= prev) planRefuse("plan_field_invalid", `${w}.level: not after ${prev}`);
    prev = level;
  }
  for (const [i, x] of list(g.purchases, "plan.guide.purchases", PLAN_LIMITS.guideList).entries()) {
    const n = note(x, `plan.guide.purchases[${i}]`, ["item", "priority"], PLAN_LIMITS.guideText);
    str(n.item, `plan.guide.purchases[${i}].item`, PLAN_LIMITS.id, SLUG);
    int(n.priority, `plan.guide.purchases[${i}].priority`, 1, PLAN_LIMITS.priority);
  }
  for (const [i, x] of list(
    g.alternatives,
    "plan.guide.alternatives",
    PLAN_LIMITS.guideList,
  ).entries()) {
    const n = note(
      x,
      `plan.guide.alternatives[${i}]`,
      ["item", "instead_of"],
      PLAN_LIMITS.guideText,
    );
    str(n.item, `plan.guide.alternatives[${i}].item`, PLAN_LIMITS.id, SLUG);
    str(n.instead_of, `plan.guide.alternatives[${i}].instead_of`, PLAN_LIMITS.id, SLUG);
  }
  for (const [i, x] of list(g.controls, "plan.guide.controls", PLAN_LIMITS.guideList).entries())
    note(x, `plan.guide.controls[${i}]`, [], PLAN_LIMITS.guideText);
  return g as unknown as PlanGuide;
}

/** The kit for a start at `level`: the last one from that level or before (`null`: none). */
export function kitFor(plan: ProgressionPlan, level: number): PlanKit | null {
  let found: PlanKit | null = null;
  for (const k of plan.guide?.kits ?? []) if (k.from_level <= level) found = k;
  return found;
}

/**
 * The plan object's structure (§2), in reading order; throws the first `PlanRefusal`. `/2` (kenli
 * F-002 T13) has the same fields plus a required `guide`; `/1` has none (an extra one is
 * `plan_unknown_field`, as before).
 */
export function checkPlanShape(v: unknown, format: PlanFormat = PLAN_FORMAT): ProgressionPlan {
  const guided = format === PLAN_FORMAT_GUIDED;
  const p = fields(v, "plan", [
    "id",
    "revision",
    "title",
    "language",
    "authorship",
    "packs",
    "sources",
    "start",
    "levels",
    ...(guided ? ["guide"] : []),
  ]);
  str(p.id, "plan.id", PLAN_LIMITS.id, SLUG);
  int(p.revision, "plan.revision", 1, Number.MAX_SAFE_INTEGER);
  text(p.title, "plan.title", PLAN_LIMITS.title);
  str(p.language, "plan.language", 35, LANGUAGE);
  const a = fields(p.authorship, "plan.authorship", ["source", "adaptation", "author"]);
  for (const k of ["source", "adaptation", "author"])
    text(a[k], `plan.authorship.${k}`, PLAN_LIMITS.authorship);
  const packs = arr(p.packs, "plan.packs");
  if (packs.length > PLAN_LIMITS.packs)
    planRefuse("plan_limit_packs", `${packs.length} > ${PLAN_LIMITS.packs}`);
  if (packs.length === 0) planRefuse("plan_field_invalid", "plan.packs: empty");
  const ids = new Set<string>();
  for (const [i, x] of packs.entries()) {
    const ref = packRef(x, `plan.packs[${i}]`);
    if (ids.has(ref.id)) planRefuse("plan_field_invalid", `plan.packs: ${ref.id} twice`);
    ids.add(ref.id);
  }
  if ((packs[0] as PackRef).id !== "srd-5.2.1")
    planRefuse("plan_pack_order", "plan.packs[0]: the SRD first");
  if (p.sources !== null) {
    const s = arr(p.sources, "plan.sources");
    if (s.length > PLAN_LIMITS.sources)
      planRefuse("plan_field_invalid", `plan.sources: over ${PLAN_LIMITS.sources}`);
    for (const [i, x] of s.entries()) str(x, `plan.sources[${i}]`, PLAN_LIMITS.id, SOURCE_ID);
  }
  const start = fields(p.start, "plan.start", ["equipment", "ops"]);
  if (start.equipment !== "starting" && start.equipment !== "none")
    planRefuse("plan_field_invalid", `plan.start.equipment: ${JSON.stringify(start.equipment)}`);
  const startOps = arr(start.ops, "plan.start.ops");
  if (startOps.length > PLAN_LIMITS.stepOps)
    planRefuse("plan_limit_step_ops", `start: ${startOps.length} > ${PLAN_LIMITS.stepOps}`, {
      level: 1,
    });
  const levels = arr(p.levels, "plan.levels");
  if (levels.length > PLAN_LIMITS.levels)
    planRefuse("plan_limit_levels", `${levels.length} steps > ${PLAN_LIMITS.levels}`);
  let total = startOps.length;
  for (const [i, l] of levels.entries()) {
    const ops = isObj(l) && Array.isArray(l.ops) ? l.ops.length : 0;
    if (ops > PLAN_LIMITS.stepOps)
      planRefuse("plan_limit_step_ops", `level ${i + 2}: ${ops} > ${PLAN_LIMITS.stepOps}`, {
        level: i + 2,
      });
    total += ops;
  }
  if (total > PLAN_LIMITS.ops) planRefuse("plan_limit_ops", `${total} > ${PLAN_LIMITS.ops}`);
  for (const [i, o] of startOps.entries()) {
    try {
      startOp(o, `plan.start.ops[${i}]`);
    } catch (e) {
      if (e instanceof PlanRefusal) throw new PlanRefusal({ level: 1, op: i, ...e.problem });
      throw e;
    }
  }
  for (const [i, l] of levels.entries()) {
    const step = fields(l, `plan.levels[${i}]`, ["level", "ops"]);
    if (step.level !== i + 2)
      planRefuse(
        "plan_level_gap",
        `plan.levels[${i}].level: ${JSON.stringify(step.level)}, expected ${i + 2}`,
        { level: i + 2 },
      );
    const ops = arr(step.ops, `plan.levels[${i}].ops`);
    if (ops.length === 0)
      planRefuse("plan_level_up_position", `level ${i + 2}: no level_up`, { level: i + 2 });
    for (const [j, o] of ops.entries()) levelOp(o, `plan.levels[${i}].ops[${j}]`, j, i + 2);
  }
  if (guided) checkGuide(p.guide, 1 + levels.length);
  return p as unknown as ProgressionPlan;
}

/** Bytes from any realm (a worker's, jsdom's): `instanceof` alone isn't enough. */
const isBytes = (v: unknown): v is Uint8Array =>
  v instanceof Uint8Array || Object.prototype.toString.call(v) === "[object Uint8Array]";

/** Bytes of a UTF-8 string. */
const utf8Length = (s: string) => new TextEncoder().encode(s).byteLength;

/**
 * Read a plan file (bytes, text or an already parsed JSON value) whole: limits, format, strict
 * structure, the plan's hash and every envelope. Never throws; nothing is written or registered.
 */
export async function parsePlanFile(
  input: Uint8Array | string | unknown,
): Promise<ParsedPlan | PlanRefused> {
  try {
    return await parse(input);
  } catch (error) {
    if (error instanceof PlanRefusal) return { ok: false, problem: error.problem };
    return {
      ok: false,
      problem: {
        code: "plan_field_invalid",
        detail: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

async function parse(input: unknown): Promise<ParsedPlan> {
  let doc: unknown;
  if (isBytes(input) || typeof input === "string") {
    const size = typeof input === "string" ? utf8Length(input) : (input as Uint8Array).byteLength;
    if (size > PLAN_LIMITS.fileBytes)
      planRefuse("plan_limit_bytes", `${size} > ${PLAN_LIMITS.fileBytes}`);
    let textIn: string;
    try {
      textIn =
        typeof input === "string" ? input : new TextDecoder("utf-8", { fatal: true }).decode(input);
    } catch {
      return planRefuse("plan_field_invalid", "not UTF-8");
    }
    try {
      doc = JSON.parse(textIn);
    } catch {
      return planRefuse("plan_field_invalid", "not JSON");
    }
  } else {
    doc = input;
    let size: number;
    try {
      size = utf8Length(JSON.stringify(doc) ?? "");
    } catch {
      return planRefuse("plan_field_invalid", "not JSON data");
    }
    if (size > PLAN_LIMITS.fileBytes)
      planRefuse("plan_limit_bytes", `${size} > ${PLAN_LIMITS.fileBytes}`);
  }
  const depth = jsonDepth(doc, PLAN_LIMITS.jsonDepth);
  if (depth > PLAN_LIMITS.jsonDepth)
    planRefuse("plan_limit_depth", `JSON depth over ${PLAN_LIMITS.jsonDepth}`);
  if (!isObj(doc)) return planRefuse("plan_field_invalid", "not an object");
  const format = doc.format;
  if (typeof format !== "string") return planRefuse("plan_missing_field", "format");
  if (!(PLAN_FORMATS as readonly string[]).includes(format)) {
    const m = FORMAT_FAMILY.exec(format);
    if (m && Number(m[1]) > PLAN_FORMATS.length) planRefuse("plan_format_newer", format);
    planRefuse("plan_format_unknown", format.slice(0, 80));
  }
  fields(doc, "$", ["format", "plan_sha256", "plan"], ["packs"]);
  str(doc.plan_sha256, "plan_sha256", 64, HEX64);
  let canonical: string;
  try {
    canonical = canonicalJson(doc.plan);
  } catch (e) {
    return planRefuse("plan_field_invalid", e instanceof Error ? e.message : String(e));
  }
  const planBytes = utf8Length(canonical);
  if (planBytes > PLAN_LIMITS.planBytes)
    planRefuse("plan_limit_plan_bytes", `${planBytes} > ${PLAN_LIMITS.planBytes}`);
  const plan = checkPlanShape(doc.plan, format as PlanFormat);
  const sha = await contentSha(doc.plan);
  if (sha !== doc.plan_sha256) planRefuse("plan_hash_mismatch", `${doc.plan_sha256} ≠ ${sha}`);
  const envelopes = new Map<string, Envelope>();
  if (doc.packs !== undefined) {
    const list = arr(doc.packs, "packs");
    if (list.length > PLAN_LIMITS.packs) planRefuse("plan_limit_packs", `envelopes ${list.length}`);
    for (const [i, env] of list.entries()) {
      if (!isObj(env) || env.format !== TRANSFER_FORMAT)
        planRefuse("plan_pack_invalid", `packs[${i}]: not a ${TRANSFER_FORMAT} envelope`);
      try {
        await checkEnvelope(env as unknown as Envelope);
      } catch (e) {
        const code = e instanceof ImportError ? e.code : "envelope";
        return planRefuse(
          "plan_pack_invalid",
          `packs[${i}]: ${code}${e instanceof ImportError && e.detail ? ` ${e.detail}` : ""}`,
        );
      }
      const e = env as unknown as Envelope;
      if (e.kind !== "pack") planRefuse("plan_pack_invalid", `packs[${i}]: kind ${e.kind}`);
      const ref = packOfEnvelope(e);
      const named = plan.packs.find((p) => p.id === ref.id);
      if (!named || named.version !== ref.version || named.sha256 !== ref.sha256)
        planRefuse("plan_pack_unreferenced", `packs[${i}]: ${refLabel(ref)}`);
      if (envelopes.has(ref.sha256))
        planRefuse("plan_pack_invalid", `packs[${i}]: ${ref.id} twice`);
      envelopes.set(ref.sha256, e);
    }
  }
  return {
    ok: true,
    file: doc as unknown as PlanFile,
    plan_sha256: sha,
    envelopes,
    range: { from: 1, to: 1 + plan.levels.length },
  };
}

/** `id@version#sha256`, as refusals name a pack. */
export const refLabel = (r: PackRef) => `${r.id}@${r.version ?? ""}#${r.sha256}`;

/**
 * The plan's packs in their load order against their manifests' `requires` (§2.3): every required
 * pack earlier in the list, at most `dependencyDepth` levels deep.
 */
export function checkPackOrder(
  refs: readonly PackRef[],
  requires: ReadonlyMap<string, readonly string[]>,
): void {
  const pos = new Map(refs.map((r, i) => [r.id, i]));
  const depth = new Map<string, number>();
  for (const [i, r] of refs.entries()) {
    let d = 0;
    for (const dep of requires.get(r.id) ?? []) {
      const at = pos.get(dep);
      if (at === undefined || at >= i) planRefuse("plan_pack_order", `${r.id} requires ${dep}`);
      d = Math.max(d, (depth.get(dep) ?? 0) + 1);
    }
    if (d > PLAN_LIMITS.dependencyDepth)
      planRefuse("plan_limit_depth", `${r.id}: requires depth ${d}`);
    depth.set(r.id, d);
  }
}

/** The step of a level (2…N) or `null`; level 1 is `start`. */
export const stepOf = (plan: ProgressionPlan, level: number): PlanStep | null =>
  level >= 2 ? (plan.levels[level - 2] ?? null) : null;

export { PLAN_FORMAT as PROGRESSION_PLAN_FORMAT };
