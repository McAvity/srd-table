/**
 * F-005 player-action fixtures: an invented pack (`source: test`, kenli F-005 contract) that patches the SRD the way
 * a private pack does (Font of Inspiration on the Bard, Magic Initiate's free cast, and on humans a luck-style use,
 * a feature with its own die, one paid with a slot instead of its use, and a d20 floor), characters built through
 * the facade, and records pinned to it (as an F-008 import pins them). No private content.
 */

import type { CharacterBuild, CharacterState } from "srd-rules-engine";
import type { EngineFacade } from "../../src/engine/facade";
import type { ContentContext, PackFiles } from "../../src/lib/canonical";
import { useDocuments } from "../../src/store/documents";
import { wizard } from "./characters";

const human = (op: "append" | "set", path: string, value: unknown) => ({
  target: "species/human",
  op,
  path,
  value,
});

export const TEST_PACK: PackFiles = {
  "manifest.json": {
    name: "test-actions",
    manifest: { id: "test-actions", version: "1.0.0", source: "test", requires: ["srd-5.2.1"] },
    patches: [
      {
        target: "classes/bard",
        op: "append",
        path: "features.5.actions",
        value: {
          id: "font-of-inspiration",
          name: "Font of Inspiration",
          economy: "free",
          restores: "bardic-inspiration",
          slot_payment: "required",
        },
      },
      {
        target: "feats/magic-initiate",
        op: "append",
        path: "grants.free_casts",
        value: { uses: "free-cast", choice: "spell" },
      },
      human("append", "grants.resources", {
        id: "test-luck",
        name: "Test Luck",
        max: { value: 3 },
        recharge: "long",
        spend_for: ["d20_advantage", "impose_disadvantage"],
      }),
      human("append", "grants.resources", {
        id: "test-word",
        name: "Test Word",
        max: { value: 1 },
        recharge: "long",
      }),
      human("append", "grants.resources", {
        id: "test-spur",
        name: "Test Spur",
        max: { value: 2 },
        recharge: "long",
      }),
      human("append", "grants.actions", {
        id: "test-word",
        name: "Test Word",
        economy: "action",
        uses: "test-word",
        slot_payment: "instead",
      }),
      human("append", "grants.actions", {
        id: "test-taunt",
        name: "Test Taunt",
        economy: "bonus_action",
        uses: "test-spur",
        target: "other",
        roll: { dice: "1d8" },
      }),
      human("set", "grants.d20_floors", [
        {
          min: 10,
          kind: "check",
          skills: ["persuasion", "deception"],
          abilities: ["cha"],
          label: "Test Tongue",
        },
      ]),
    ],
    tables: {},
  },
};

export const LUCK = "species:human:test-luck";
export const WORD = "species:human:test-word";
export const TAUNT = "species:human:test-taunt";
export const BI = "bard:bardic-inspiration";
export const FONT = "bard:font-of-inspiration";

async function apply(engine: EngineFacade, build: CharacterBuild, edits: readonly unknown[]) {
  let current = build;
  for (const edit of edits) {
    const r = await engine.editBuild(current, edit as never);
    if (!r.ok) throw new Error(`${JSON.stringify(edit)}: ${r.reasons.join("; ")}`);
    current = r.build;
  }
  return current;
}

async function fill(engine: EngineFacade, build: CharacterBuild, level: number) {
  let current = build;
  for (let guard = 0; guard < 60; guard++) {
    const view = await engine.evaluate(current);
    const open = view.choices.find(
      (c) => c.level <= level && !c.fixed && !c.replaces && c.selected.length < c.required,
    );
    if (!open) return current;
    const picks = [...open.selected];
    for (const o of open.options) {
      if (picks.length >= open.required) break;
      if (!o.unavailable && !picks.includes(o.id)) picks.push(o.id);
    }
    if (open.repeats) while (picks.length < open.required) picks.push(picks[0] ?? "cha");
    current = await apply(engine, current, [{ type: "choice", key: open.key, values: picks }]);
  }
  throw new Error("choices didn't settle");
}

/** A level 5 human Bard (Acolyte: Magic Initiate, Cleric): Font of Inspiration with the pack. */
export async function bard(engine: EngineFacade, level = 5): Promise<CharacterBuild> {
  let build = await apply(engine, await engine.newBuild(), [
    { type: "class", id: "bard" },
    { type: "species", id: "human" },
    { type: "background", id: "acolyte" },
    { type: "ability_method", method: "standard_array" },
    { type: "base_scores", scores: { str: 8, dex: 14, con: 13, int: 10, wis: 12, cha: 15 } },
    { type: "background_bonus", bonus: { cha: 2, wis: 1 } },
    { type: "name", name: "Syn Bard" },
    { type: "alignment", alignment: "NG" },
  ]);
  build = await fill(engine, build, 1);
  for (let l = 2; l <= level; l++) {
    build = await apply(engine, build, [{ type: "level_up", class_id: "bard", hp: null }]);
    build = await fill(engine, build, l);
  }
  return build;
}

/**
 * A level 3 human Wizard (the test pack's luck-style use on humans) whose spellbook has Ray of
 * Sickness, a level 1 spell attack the engine rolls: Lucky declared for a spell paid with a slot.
 */
export async function humanWizard(engine: EngineFacade): Promise<CharacterBuild> {
  const build = await fill(
    engine,
    await apply(engine, await wizard(engine, 3), [{ type: "species", id: "human" }]),
    3,
  );
  let current = build;
  // In the spellbook, then prepared: the first choice offering it, then the next one.
  for (let step = 0; step < 2; step++) {
    const view = await engine.evaluate(current);
    const open = view.choices.find(
      (c) => c.required > 0 && c.options.some((o) => o.id === RAY) && !c.selected.includes(RAY),
    );
    if (!open) break;
    const values = [RAY, ...open.selected].slice(0, open.required);
    current = await apply(engine, current, [{ type: "choice", key: open.key, values }]);
  }
  return current;
}
export const RAY = "ray-of-sickness";

/**
 * kenli F-002 T11: Mystic Arcanum as a free cast (the f002 pack's patch shape on the SRD Warlock):
 * the level 6 arcanum spell, once per Long Rest with its `mystic-arcanum-6` use. A Warlock 11's Pact
 * slots are level 5, so the spell has no slot line at all: only that free cast.
 */
export const ARCANUM_PACK: PackFiles = {
  "manifest.json": {
    name: "test-arcanum",
    manifest: { id: "test-arcanum", version: "1.0.0", source: "test", requires: ["srd-5.2.1"] },
    patches: [
      {
        target: "classes/warlock",
        op: "set",
        path: "features.11.free_casts",
        value: [{ uses: "mystic-arcanum-6", choice: "mystic_arcanum" }],
      },
    ],
    tables: {},
  },
};
export const ARCANUM_USE = "warlock:mystic-arcanum-6";

/** A level 11 human Warlock, every choice the first legal one (its Mystic Arcanum too). */
export async function warlock11(engine: EngineFacade): Promise<CharacterBuild> {
  let build = await apply(engine, await engine.newBuild(), [
    { type: "class", id: "warlock" },
    { type: "species", id: "human" },
    { type: "background", id: "acolyte" },
    { type: "ability_method", method: "standard_array" },
    { type: "base_scores", scores: { str: 8, dex: 14, con: 13, int: 10, wis: 12, cha: 15 } },
    { type: "background_bonus", bonus: { cha: 2, wis: 1 } },
    { type: "name", name: "Syn Warlock" },
    { type: "alignment", alignment: "NG" },
  ]);
  build = await fill(engine, build, 1);
  for (let l = 2; l <= 11; l++) {
    build = await apply(engine, build, [{ type: "level_up", class_id: "warlock", hp: null }]);
    build = await fill(engine, build, l);
  }
  return build;
}

/** The arcanum pack installed in the facade, with the SRD, as a record pinned to it has it. */
export async function arcanumContext(engine: EngineFacade): Promise<ContentContext> {
  const [ref] = await engine.registerPacks([ARCANUM_PACK]);
  const srd = await engine.servedPack("srd-5.2.1");
  if (!ref) throw new Error("arcanum pack not registered");
  return { packs: [srd, ref], sources: null };
}

/** The test pack installed in the facade and the content context a record pinned to it has. */
export async function testContext(engine: EngineFacade): Promise<ContentContext> {
  const [ref] = await engine.registerPacks([TEST_PACK]);
  const srd = await engine.servedPack("srd-5.2.1");
  if (!ref) throw new Error("test pack not registered");
  return { packs: [srd, ref], sources: null };
}

/** A character record in the store, pinned to `content` (as an F-008 import writes it). */
export async function storeCharacter(
  engine: EngineFacade,
  build: CharacterBuild,
  content?: ContentContext,
  state?: CharacterState,
): Promise<string> {
  const id = `c-${Math.random().toString(36).slice(2, 8)}`;
  const s = state ?? (await engine.createState(build, content));
  const now = Date.now();
  useDocuments.setState((st) => ({
    characters: {
      ...st.characters,
      [id]: {
        id,
        build,
        state: s,
        created: now,
        updated: now,
        rev: 0,
        gen: 0,
        ...(content ? { content } : {}),
      },
    },
  }));
  return id;
}

/**
 * kenli F-002 T12 B2b: an invented pack (`source: test`) giving the SRD's Empowered Spell and
 * Careful Spell their cast options (Empowered's typed `effect: empowered`, after the damage roll).
 */
export const EMPOWER_PACK: PackFiles = {
  "manifest.json": {
    name: "test-empower",
    manifest: { id: "test-empower", version: "1.0.0", source: "test", requires: ["srd-5.2.1"] },
    patches: [
      ["empowered-spell", "empowered", true],
      ["careful-spell", "careful", false],
    ].map(([id, effect, combinable]) => ({
      target: `features/${id}`,
      op: "set",
      path: "grants.cast_options",
      value: [
        {
          id,
          name: id === "empowered-spell" ? "Empowered Spell" : "Careful Spell",
          cost: 1,
          resource_class: "sorcerer",
          resource: "sorcery-points",
          combinable,
          effect,
        },
      ],
    })),
    tables: {},
  },
};
export const SORCERY = "sorcerer:sorcery-points";

export async function empowerContext(engine: EngineFacade): Promise<ContentContext> {
  const [ref] = await engine.registerPacks([EMPOWER_PACK]);
  const srd = await engine.servedPack("srd-5.2.1");
  if (!ref) throw new Error("empower pack not registered");
  return { packs: [srd, ref], sources: null };
}

/** A level 3 human Sorcerer (CHA 17: +3) with Burning Hands, Fire Bolt and Empowered + Careful Spell. */
export async function empoweredSorcerer(engine: EngineFacade): Promise<CharacterBuild> {
  let build = await apply(engine, await engine.newBuild(), [
    { type: "class", id: "sorcerer" },
    { type: "species", id: "human" },
    { type: "background", id: "acolyte" },
    { type: "ability_method", method: "standard_array" },
    { type: "base_scores", scores: { str: 8, dex: 14, con: 13, int: 10, wis: 12, cha: 15 } },
    { type: "background_bonus", bonus: { cha: 2, wis: 1 } },
    { type: "name", name: "Syn Sorcerer" },
    { type: "alignment", alignment: "NG" },
    {
      type: "choice",
      key: "class:sorcerer#cantrips",
      values: ["fire-bolt", "light", "mage-hand", "prestidigitation"],
    },
    { type: "choice", key: "class:sorcerer#prepared", values: ["burning-hands", "magic-missile"] },
  ]);
  build = await fill(engine, build, 1);
  build = await apply(engine, build, [{ type: "level_up", class_id: "sorcerer", hp: null }]);
  build = await apply(engine, build, [
    {
      type: "choice",
      key: "class:sorcerer:2#metamagic",
      values: ["empowered-spell", "careful-spell"],
    },
  ]);
  build = await fill(engine, build, 2);
  build = await apply(engine, build, [{ type: "level_up", class_id: "sorcerer", hp: null }]);
  return fill(engine, build, 3);
}
