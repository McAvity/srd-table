/**
 * Importing a character refuses, before anything is written, files that wouldn't arrive whole: a
 * pack the build needs that isn't loaded (or is the wrong one), fields the parse would drop, and a
 * play state `reconcileState` would change. The packs here are synthetic: an SRD species copied
 * under a new id.
 */

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { type CharacterBuild, type CharacterState, splitPack } from "srd-rules-engine";
import { beforeEach, describe, expect, it } from "vitest";
import { setEngine } from "../../src/engine/client";
import { createInProcessFacade, type EngineFacade } from "../../src/engine/facade";
import { useDocuments } from "../../src/store/documents";
import { useSettings } from "../../src/store/settings";
import { fighter } from "../fixtures/characters";
import { resetStores } from "../helpers/app";

const require = createRequire(import.meta.url);
const srdDir = dirname(require.resolve("srd-rules-engine/srd-5.2.1/manifest.json"));
const docs = () => useDocuments.getState();

const MANIFEST = {
  id: "test-pack",
  version: "1.0.0",
  ruleset: "2024",
  source: "test-pack",
  requires: ["srd-5.2.1"],
};

/** `test-pack` with a copy of the SRD Human as `test-folk` (`withSpecies: false`: the wrong pack). */
async function testPack(withSpecies: boolean): Promise<Record<string, unknown>> {
  const species = JSON.parse(await readFile(join(srdDir, "species.json"), "utf8")) as {
    id: string;
  }[];
  const human = species.find((s) => s.id === "human");
  const folk = { ...human, id: "test-folk", name: "Test Folk", source: "test-pack" };
  return splitPack(withSpecies ? { manifest: MANIFEST, species: [folk] } : { manifest: MANIFEST });
}

/** The in-process facade over the SRD on disk and `test-pack` in memory, installed for the store. */
function install(pack: Record<string, unknown> | null): EngineFacade {
  const facade = createInProcessFacade({
    seed: 3,
    fetchFile: async (id, file) => {
      if (id === "srd-5.2.1") return JSON.parse(await readFile(join(srdDir, file), "utf8"));
      if (id === "test-pack" && pack && file in pack) return pack[file];
      throw new Error(`Unknown pack file ${id}/${file}`);
    },
  });
  setEngine(facade);
  return facade;
}

async function setPacks(packs: string[]) {
  await useSettings.getState().setContent(packs, null);
}

/** A level 1 Fighter of the pack's species that records the pack, with a state spent at the table. */
async function packCharacter(engine: EngineFacade) {
  await setPacks(["srd-5.2.1", "test-pack"]);
  const base = await fighter(engine, 1);
  const edited = await engine.editBuild(base, { type: "species", id: "test-folk" });
  if (!edited.ok) throw new Error(edited.reasons.join("; "));
  const build: CharacterBuild = { ...edited.build, packs: ["test-pack"] };
  let state = await engine.createState(build);
  const spent = await engine.applyPlayAction(build, state, [
    { type: "damage", amount: 3 },
    { type: "use", key: "fighter:second-wind" },
  ]);
  if (!spent.ok) throw new Error(spent.reasons.join("; "));
  state = spent.state;
  return { build, state };
}

/** What a file holds: the documents' JSON, as the export writes it. */
const file = <T>(doc: T): T => JSON.parse(JSON.stringify(doc)) as T;

beforeEach(resetStores);

describe("importing a character", () => {
  it("keeps the spent play state when the packs the build needs are loaded", async () => {
    const engine = install(await testPack(true));
    const { build, state } = await packCharacter(engine);
    expect(state.hp.current).not.toBeNull();
    expect(state.uses_spent).not.toEqual({});
    const result = await docs().importCharacter(file(build), file(state));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const record = docs().characters[result.id];
    expect(record?.state).toEqual(state);
    expect(record?.build.packs).toEqual(["test-pack"]);
  });

  it("refuses a build whose pack isn't loaded, and keeps the characters already there", async () => {
    const engine = install(await testPack(true));
    const { build, state } = await packCharacter(engine);
    const first = await docs().importCharacter(file(build), file(state));
    if (!first.ok) throw new Error(first.reasons.join("; "));
    const before = docs().characters;
    await setPacks(["srd-5.2.1"]);
    const result = await docs().importCharacter(file(build), file(state));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reasons.join(" ")).toMatch(/test-pack/);
    expect(docs().characters).toBe(before);
  });

  it("refuses the wrong pack under the build's pack id", async () => {
    const engine = install(await testPack(true));
    const { build, state } = await packCharacter(engine);
    install(await testPack(false));
    await setPacks(["srd-5.2.1", "test-pack"]);
    const result = await docs().importCharacter(file(build), file(state));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons.join(" ")).toMatch(/test-folk/);
    expect(Object.keys(docs().characters)).toHaveLength(0);
  });

  it("refuses a state reconcileState would change, before writing it", async () => {
    const engine = install(await testPack(true));
    const { build, state } = await packCharacter(engine);
    const stale: CharacterState = { ...state, active: ["nope:toggle"] };
    expect(
      (await engine.validateState(build, stale)).filter((i) => i.severity === "error"),
    ).toEqual([]);
    const result = await docs().importCharacter(file(build), file(stale));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons[0]).toMatch(/active/);
    expect(Object.keys(docs().characters)).toHaveLength(0);
  });

  it("refuses a state the engine finds invalid instead of clamping it", async () => {
    const engine = install(await testPack(true));
    const { build, state } = await packCharacter(engine);
    const over = { ...file(state), hp: { current: 999, temp: 0 } };
    const result = await docs().importCharacter(file(build), over);
    expect(result.ok).toBe(false);
    expect(Object.keys(docs().characters)).toHaveLength(0);
  });

  it("refuses files with data the documents don't keep (another app's envelope, stored items)", async () => {
    const engine = install(await testPack(true));
    const { build, state } = await packCharacter(engine);
    const envelope = {
      format: "other.app/2",
      state: file(state),
      session: { stored_items: ["i1"] },
    };
    const asEnvelope = await docs().importCharacter(file(build), envelope);
    expect(asEnvelope.ok).toBe(false);
    if (!asEnvelope.ok) expect(asEnvelope.reasons[0]).toMatch(/format, state, session/);
    const withStored = await docs().importCharacter(file(build), {
      ...file(state),
      stored_items: ["i1"],
    });
    expect(withStored.ok).toBe(false);
    if (!withStored.ok) expect(withStored.reasons[0]).toMatch(/stored_items/);
    const located = file(state);
    const item = { ...(located.inventory[0] ?? { id: "i1", item: "dagger" }), location: "home" };
    const withLocation = await docs().importCharacter(file(build), {
      ...located,
      inventory: [item, ...located.inventory.slice(1)],
    });
    expect(withLocation.ok).toBe(false);
    // Only "stored" is a location (kenli F-005 DEC-01): another one is refused, not dropped.
    if (!withLocation.ok)
      expect(withLocation.reasons.join("\n")).toMatch(
        /expected "stored"[\s\S]*inventory\[0\]\.location/,
      );
    expect(Object.keys(docs().characters)).toHaveLength(0);
  });

  it("still imports a build alone with a new play state", async () => {
    const engine = install(await testPack(true));
    const { build } = await packCharacter(engine);
    const result = await docs().importCharacter(file(build));
    expect(result.ok).toBe(true);
  });
});
