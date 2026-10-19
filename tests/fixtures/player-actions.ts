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
