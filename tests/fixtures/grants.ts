/**
 * kenli F-011 review03 R03-09 fixtures: an invented pack (`source: test`) giving Mage Hand through
 * both Elf and Sage and Magic Initiate's free cast, and the characters that show grant provenance —
 * a Wizard who gets Mage Hand twice (Elf, Sage) and a Human Wizard with two Magic Initiates (Human
 * Versatile with the Cleric list, Sage). Every open choice answered with its first legal options.
 */

import type { CharacterBuild } from "srd-rules-engine";
import type { EngineFacade } from "../../src/engine/facade";
import { type ContentContext, type PackFiles, packRefOf } from "../../src/lib/canonical";
import { db, packKey } from "../../src/persistence/db";
import { wizard } from "./characters";

export const GRANTS_PACK: PackFiles = {
  "manifest.json": {
    name: "grants-review",
    manifest: { id: "grants-review", version: "1.0.0", source: "test", requires: ["srd-5.2.1"] },
    patches: [
      { target: "backgrounds/sage", op: "append", path: "grants.cantrips", value: "mage-hand" },
      { target: "species/elf", op: "append", path: "grants.cantrips", value: "mage-hand" },
      {
        target: "feats/magic-initiate",
        op: "append",
        path: "grants.free_casts",
        value: { uses: "free-cast", choice: "spell" },
      },
    ],
    tables: {},
  },
};

/** The pack registered with the engine and stored as an imported pack (a reload reads it). */
export async function grantsContext(engine: EngineFacade): Promise<ContentContext> {
  const [ref] = await engine.registerPacks([GRANTS_PACK]);
  const pack = await packRefOf(GRANTS_PACK);
  const database = await db();
  if (!(await database.get("packs", packKey(pack))))
    await database.add("packs", {
      key: packKey(pack),
      ref: pack,
      files: GRANTS_PACK,
      installed_at: 1,
      origin: { kind: "import", file: "grants-review.transfer.json", bytes_sha256: null },
    });
  return { packs: [await engine.servedPack("srd-5.2.1"), ref], sources: null } as ContentContext;
}

async function edit(e: EngineFacade, b: CharacterBuild, x: unknown, ctx: ContentContext) {
  const r = await e.editBuild(b, x as never, ctx);
  if (!r.ok) throw new Error(JSON.stringify(r.reasons));
  return r.build as CharacterBuild;
}
async function complete(e: EngineFacade, b: CharacterBuild, ctx: ContentContext) {
  let build = b;
  for (let i = 0; i < 60; i++) {
    const v = await e.evaluate(build, ctx);
    const c = v.choices.find((x) => !x.fixed && !x.replaces && x.selected.length < x.required);
    if (!c) return build;
    const picks = [...c.selected];
    for (const o of c.options) {
      if (picks.length >= c.required) break;
      if (!o.unavailable && !picks.includes(o.id)) picks.push(o.id);
    }
    build = await edit(e, build, { type: "choice", key: c.key, values: picks }, ctx);
  }
  throw new Error("choices didn't settle");
}

/** Wizard 1, Elf, Sage: Mage Hand from both (with the pack). */
export async function elfSage(e: EngineFacade, ctx: ContentContext, name = "Nell") {
  const b = await complete(e, await wizard(e, 1), ctx);
  return edit(e, b, { type: "name", name }, ctx);
}

/** Wizard 1, Human with Magic Initiate (Cleric) from Versatile, and Sage's Magic Initiate (Wizard). */
export async function twoInitiates(e: EngineFacade, ctx: ContentContext, name = "Mira") {
  let b = await wizard(e, 1);
  b = await edit(e, b, { type: "species", id: "human" }, ctx);
  b = await edit(
    e,
    b,
    { type: "choice", key: "species:human#versatile", values: ["magic-initiate"] },
    ctx,
  );
  b = await edit(
    e,
    b,
    {
      type: "choice",
      key: "feat:magic-initiate@species:human#versatile#spell_list",
      values: ["cleric"],
    },
    ctx,
  );
  b = await complete(e, b, ctx);
  return edit(e, b, { type: "name", name }, ctx);
}
