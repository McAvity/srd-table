/**
 * kenli F-002 T03: progression plans for tests, recorded while a character is built through the
 * facade's own setters (the same first-legal-option fill as `tests/fixtures/characters.ts`), so
 * every positive fixture completes in the real SRD catalog; negative fixtures are made from them
 * by one deliberate change, the hash recomputed unless the change is the hash. SRD and invented
 * test content only.
 */

import type { CharacterBuild } from "srd-rules-engine";
import type { BuildEdit, EngineFacade } from "../../src/engine/facade";
import type { Envelope } from "../../src/import/transfer";
import {
  type ContentContext,
  contentSha,
  type PackFiles,
  type PackRef,
} from "../../src/lib/canonical";
import { PLAN_FORMAT } from "../../src/progression/codec";

// biome-ignore lint/suspicious/noExplicitAny: plan JSON is built and mutated field by field.
export type J = any;

export interface PlanSpec {
  readonly id: string;
  readonly title: string;
  readonly start: readonly BuildEdit[];
  /** Levels 2…N: the class, and edits made right after the level-up (before the fill). */
  readonly levels: readonly { readonly class_id: string; readonly edits?: readonly BuildEdit[] }[];
  readonly content?: ContentContext;
  /** Envelopes carried in the file (packs not installed where it's compiled). */
  readonly envelopes?: readonly Envelope[];
}

const opOf = (edit: BuildEdit): J => {
  const { type, ...rest } = edit as J;
  return { op: type, ...rest, origin: "author" };
};

async function applyRecorded(
  engine: EngineFacade,
  build: CharacterBuild,
  edit: BuildEdit,
  ops: J[],
  content?: ContentContext,
): Promise<CharacterBuild> {
  const r = await engine.editBuild(build, edit, content);
  if (!r.ok) throw new Error(`${JSON.stringify(edit)}: ${r.reasons.join("; ")}`);
  ops.push(opOf(edit));
  return r.build;
}

/** Answer every pending choice up to `level` with the first available options, recording them. */
async function fillRecorded(
  engine: EngineFacade,
  build: CharacterBuild,
  level: number,
  ops: J[],
  content?: ContentContext,
): Promise<CharacterBuild> {
  let current = build;
  for (let guard = 0; guard < 60; guard++) {
    const view = await engine.evaluate(current, content);
    const open = view.choices.find(
      (c) => c.level <= level && !c.fixed && !c.replaces && c.selected.length < c.required,
    );
    if (!open) return current;
    const picks = [...open.selected];
    for (const o of open.options) {
      if (picks.length >= open.required) break;
      if (!o.unavailable && !picks.includes(o.id)) picks.push(o.id);
    }
    if (open.repeats) while (picks.length < open.required) picks.push(picks[0] ?? "str");
    current = await applyRecorded(
      engine,
      current,
      { type: "choice", key: open.key, values: picks },
      ops,
      content,
    );
  }
  throw new Error("choices didn't settle");
}

export async function planBody(
  engine: EngineFacade,
  spec: PlanSpec,
): Promise<{ plan: J; builds: CharacterBuild[] }> {
  const content = spec.content;
  const start: J[] = [];
  let build = await engine.newBuild();
  for (const edit of spec.start) build = await applyRecorded(engine, build, edit, start, content);
  build = await fillRecorded(engine, build, 1, start, content);
  const builds = [build];
  const levels: J[] = [];
  for (const [i, l] of spec.levels.entries()) {
    const level = i + 2;
    const ops: J[] = [];
    build = await applyRecorded(
      engine,
      build,
      { type: "level_up", class_id: l.class_id, hp: null },
      ops,
      content,
    );
    for (const e of l.edits ?? []) build = await applyRecorded(engine, build, e, ops, content);
    build = await fillRecorded(engine, build, level, ops, content);
    levels.push({ level, ops });
    builds.push(build);
  }
  const packs: PackRef[] = content ? [...content.packs] : [await engine.servedPack("srd-5.2.1")];
  const plan = {
    id: spec.id,
    revision: 1,
    title: spec.title,
    language: "en",
    authorship: { source: "invented test plan", adaptation: "none", author: "srd-table tests" },
    packs,
    sources: content?.sources ?? null,
    start: { equipment: "starting", ops: start },
    levels,
  };
  return { plan, builds };
}

/** A plan file with its hash (`withHash: false` keeps the given one). */
export async function planFile(
  plan: J,
  envelopes?: readonly Envelope[],
  hash?: string,
): Promise<J> {
  return {
    format: PLAN_FORMAT,
    plan_sha256: hash ?? (await contentSha(plan)),
    plan,
    ...(envelopes?.length ? { packs: envelopes } : {}),
  };
}

/** A pack as a transfer envelope, requiring the given exact refs. */
export async function packEnvelope(
  files: PackFiles,
  requires: readonly PackRef[],
): Promise<Envelope> {
  const manifest = (files["manifest.json"] as { manifest: { id: string; version: string | null } })
    .manifest;
  return {
    format: "srd-table.transfer/1",
    kind: "pack",
    id: manifest.id,
    revision: null,
    title: `${manifest.id} ${manifest.version ?? ""}`.trim(),
    sha256: await contentSha({ files }),
    content: { files },
    requires: requires.map((r) => ({
      kind: "pack" as const,
      id: r.id,
      version: r.version,
      sha256: r.sha256,
      href: null,
      bytes_sha256: null,
    })),
    provenance: {},
    extensions: {},
  } as Envelope;
}

export const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

// ───────────────────────── the specs ─────────────────────────

const FIGHTER_START: readonly BuildEdit[] = [
  { type: "class", id: "fighter" },
  { type: "species", id: "human" },
  { type: "background", id: "soldier" },
  { type: "ability_method", method: "standard_array" },
  { type: "base_scores", scores: { str: 15, dex: 14, con: 13, int: 8, wis: 10, cha: 12 } },
  { type: "background_bonus", bonus: { str: 2, con: 1 } },
  { type: "name", name: "Aerin" },
  { type: "alignment", alignment: "NG" },
];
const WIZARD_START: readonly BuildEdit[] = [
  { type: "class", id: "wizard" },
  { type: "species", id: "elf" },
  { type: "background", id: "sage" },
  { type: "ability_method", method: "standard_array" },
  { type: "base_scores", scores: { str: 8, dex: 14, con: 13, int: 15, wis: 12, cha: 10 } },
  { type: "background_bonus", bonus: { int: 2, con: 1 } },
  { type: "name", name: "Lirael" },
  { type: "alignment", alignment: "CG" },
];
const SORCERER_START: readonly BuildEdit[] = [
  { type: "class", id: "sorcerer" },
  { type: "species", id: "human" },
  { type: "background", id: "acolyte" },
  { type: "ability_method", method: "standard_array" },
  { type: "base_scores", scores: { str: 8, dex: 14, con: 13, int: 10, wis: 12, cha: 15 } },
  { type: "background_bonus", bonus: { cha: 2, wis: 1 } },
  { type: "name", name: "Kai" },
  { type: "alignment", alignment: "NG" },
];
const WARLOCK_START: readonly BuildEdit[] = [
  { type: "class", id: "warlock" },
  { type: "species", id: "human" },
  { type: "background", id: "acolyte" },
  { type: "ability_method", method: "standard_array" },
  { type: "base_scores", scores: { str: 8, dex: 14, con: 13, int: 10, wis: 12, cha: 15 } },
  { type: "background_bonus", bonus: { cha: 2, wis: 1 } },
  { type: "name", name: "Vex" },
  { type: "alignment", alignment: "CN" },
];
const times = (n: number, class_id: string) => Array.from({ length: n }, () => ({ class_id }));

export const SPECS = {
  fighter: {
    id: "test-fighter",
    title: "Fighter 1–6",
    start: FIGHTER_START,
    levels: times(5, "fighter"),
  },
  wizard: {
    id: "test-wizard",
    title: "Wizard 1–5",
    start: WIZARD_START,
    levels: times(4, "wizard"),
  },
  sorcererBard: {
    id: "test-sorcerer-bard",
    title: "Sorcerer 1 / Bard 2",
    start: SORCERER_START,
    levels: times(2, "bard"),
  },
  wizardFighter: {
    id: "test-wizard-fighter",
    title: "Wizard 1 / Fighter 1",
    start: WIZARD_START,
    levels: times(1, "fighter"),
  },
  warlock: {
    id: "test-warlock",
    title: "Warlock 1–2 (Eldritch Invocations: feature options)",
    start: WARLOCK_START,
    levels: times(1, "warlock"),
  },
  fighterConAsi: {
    id: "test-fighter-con-asi",
    title: "Fighter 1–4, Constitution +2 at 4 (HP raised for every level)",
    start: FIGHTER_START,
    levels: [
      { class_id: "fighter" },
      { class_id: "fighter" },
      {
        class_id: "fighter",
        edits: [
          { type: "choice", key: "class:fighter:4#feat", values: ["ability-score-improvement"] },
          {
            type: "choice",
            key: "feat:ability-score-improvement@class:fighter:4#feat#increase",
            values: ["con", "con"],
          },
        ],
      },
    ],
  },
} as const satisfies Record<string, PlanSpec>;

/** An invented pack: a general feat whose language list grows with the class (no rest change). */
export const POOL_PACK: PackFiles = {
  "manifest.json": {
    manifest: { id: "test-pool-feat", version: "1.0.0", source: "test", requires: ["srd-5.2.1"] },
    tables: { feats: { file: "feats.json", count: 1 } },
  },
  "feats.json": [
    {
      id: "test-tongues",
      name: "Test Tongues",
      category: "general",
      prerequisite: { level: 4 },
      grants: {
        choices: [
          {
            id: "tongues",
            label: "Test Tongues",
            kind: "language",
            count: 1,
            scaling: {
              count: [1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2],
              max_spell_level: null,
            },
          },
        ],
      },
    },
  ],
};
