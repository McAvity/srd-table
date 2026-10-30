/**
 * Before the browser tests: build fixture characters through the engine (saved as the files the
 * app imports) and find a dice seed for the decision flow (the seed the tests set in Settings).
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nodeFacade } from "../../src/engine/node";
import { fighter, wizard } from "../fixtures/characters";

export const FIXTURES = join(import.meta.dirname, "..", "..", "test-results", "e2e-fixtures");

export default async function globalSetup(): Promise<void> {
  mkdirSync(FIXTURES, { recursive: true });
  const engine = nodeFacade({ seed: 1 });
  writeFileSync(join(FIXTURES, "aerin.json"), JSON.stringify(await fighter(engine, 3), null, 2));
  writeFileSync(join(FIXTURES, "lirael.json"), JSON.stringify(await wizard(engine, 3), null, 2));
  writeFileSync(join(FIXTURES, "decision-seed.json"), JSON.stringify(await decisionSeed()));
  // kenli F-011 T04: characters are imported as full copies now, exported by the app itself.
  execFileSync("npx", ["vitest", "run", "tests/e2e-fixtures/copies.test.ts"], {
    env: { ...process.env, F011_E2E_FIXTURES: FIXTURES },
    stdio: "inherit",
  });
}

/** The same actions the decision test sends, in order: a seed where the save fails. */
async function decisionSeed(): Promise<number> {
  for (let seed = 1; seed < 500; seed++) {
    const e = nodeFacade({ seed });
    const r = await e.applyEncounterAction(await e.newEncounter({ decisions: "ask" }), {}, [
      { type: "add_monster", monster: "adult-red-dragon", side: "enemies", decisions: "ask" },
      { type: "add_monster", monster: "adult-blue-dragon", side: "enemies", decisions: "ask" },
      { type: "set_initiative", id: "adult-red-dragon", value: 20 },
      { type: "set_initiative", id: "adult-blue-dragon", value: 5 },
      { type: "start" },
      {
        type: "save_action",
        id: "adult-red-dragon",
        ability: "Fire Breath",
        targets: ["adult-blue-dragon"],
      },
    ]);
    if (r.ok && r.pending) return seed;
  }
  throw new Error("no seed found");
}
