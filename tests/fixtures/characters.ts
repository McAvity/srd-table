/**
 * Complete characters built through the facade (the engine's own setters), for tests and
 * screenshots: a level 3 Fighter (Champion), a level 3 Wizard, a level 5 Rogue.
 */

import type { CharacterBuild } from "srd-rules-engine";
import type { BuildEdit, EngineFacade } from "../../src/engine/facade";

async function apply(engine: EngineFacade, build: CharacterBuild, edits: readonly BuildEdit[]) {
  let current = build;
  for (const edit of edits) {
    const r = await engine.editBuild(current, edit);
    if (!r.ok) throw new Error(`${JSON.stringify(edit)}: ${r.reasons.join("; ")}`);
    current = r.build;
  }
  return current;
}

/** Answer every pending choice up to `level` with the first available options. */
async function fillLevel(engine: EngineFacade, build: CharacterBuild, level: number) {
  let current = build;
  for (let guard = 0; guard < 40; guard++) {
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
    if (open.repeats) while (picks.length < open.required) picks.push(picks[0] ?? "str");
    current = await apply(engine, current, [{ type: "choice", key: open.key, values: picks }]);
  }
  throw new Error("choices didn't settle");
}

export async function fighter(engine: EngineFacade, level = 3): Promise<CharacterBuild> {
  let build = await apply(engine, await engine.newBuild(), [
    { type: "class", id: "fighter" },
    { type: "species", id: "human" },
    { type: "background", id: "soldier" },
    { type: "ability_method", method: "standard_array" },
    { type: "base_scores", scores: { str: 15, dex: 14, con: 13, int: 8, wis: 10, cha: 12 } },
    { type: "background_bonus", bonus: { str: 2, con: 1 } },
    { type: "name", name: "Aerin" },
    { type: "alignment", alignment: "NG" },
  ]);
  build = await fillLevel(engine, build, 1);
  for (let l = 2; l <= level; l++) {
    build = await apply(engine, build, [{ type: "level_up", class_id: "fighter", hp: null }]);
    build = await fillLevel(engine, build, l);
  }
  return build;
}

export async function wizard(engine: EngineFacade, level = 3): Promise<CharacterBuild> {
  let build = await apply(engine, await engine.newBuild(), [
    { type: "class", id: "wizard" },
    { type: "species", id: "elf" },
    { type: "background", id: "sage" },
    { type: "ability_method", method: "standard_array" },
    { type: "base_scores", scores: { str: 8, dex: 14, con: 13, int: 15, wis: 12, cha: 10 } },
    { type: "background_bonus", bonus: { int: 2, con: 1 } },
    { type: "name", name: "Lirael" },
    { type: "alignment", alignment: "CG" },
  ]);
  build = await fillLevel(engine, build, 1);
  for (let l = 2; l <= level; l++) {
    build = await apply(engine, build, [{ type: "level_up", class_id: "wizard", hp: null }]);
    build = await fillLevel(engine, build, l);
  }
  return build;
}

export async function rogue(engine: EngineFacade, level = 5): Promise<CharacterBuild> {
  let build = await apply(engine, await engine.newBuild(), [
    { type: "class", id: "rogue" },
    { type: "species", id: "halfling" },
    { type: "background", id: "criminal" },
    { type: "ability_method", method: "standard_array" },
    { type: "base_scores", scores: { str: 8, dex: 15, con: 13, int: 12, wis: 14, cha: 10 } },
    { type: "background_bonus", bonus: { dex: 2, con: 1 } },
    { type: "name", name: "Pip" },
    { type: "alignment", alignment: "CN" },
  ]);
  build = await fillLevel(engine, build, 1);
  for (let l = 2; l <= level; l++) {
    build = await apply(engine, build, [{ type: "level_up", class_id: "rogue", hp: null }]);
    build = await fillLevel(engine, build, l);
  }
  return build;
}

/** A Sorcerer 1 / Bard 1 (Charisma for both): spells on both class lists, prepared through one. */
export async function sorcererBard(engine: EngineFacade): Promise<CharacterBuild> {
  let build = await apply(engine, await engine.newBuild(), [
    { type: "class", id: "sorcerer" },
    { type: "species", id: "human" },
    { type: "background", id: "acolyte" },
    { type: "ability_method", method: "standard_array" },
    { type: "base_scores", scores: { str: 8, dex: 14, con: 13, int: 10, wis: 12, cha: 15 } },
    { type: "background_bonus", bonus: { cha: 2, wis: 1 } },
    { type: "name", name: "Kai" },
    { type: "alignment", alignment: "NG" },
  ]);
  build = await fillLevel(engine, build, 1);
  build = await apply(engine, build, [{ type: "level_up", class_id: "bard", hp: null }]);
  return fillLevel(engine, build, 2);
}
