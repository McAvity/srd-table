/**
 * kenli F-006 T04: build the characters the browser tests import (as files, through the app's
 * import dialog), with the in-process engine, into a /tmp folder (never into the repository).
 * kenli F-011 T04: a character is imported only as a full copy now — Aerin, Brann and Cora (with
 * a real PNG portrait) are exported by the app itself (`tests/e2e-fixtures/copies.test.ts`, run
 * under Vitest's jsdom) as `<name>.local-copy.json` next to the raw builds.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nodeFacade } from "../src/engine/node";
import { fighter } from "../tests/fixtures/characters";

export const FIXTURES = process.env.F006_FIXTURES ?? "/tmp/f006-e2e-fixtures";

export default async function globalSetup(): Promise<void> {
  mkdirSync(FIXTURES, { recursive: true });
  const engine = nodeFacade({ seed: 1 });
  for (const name of ["Aerin", "Brann"]) {
    const built = await engine.editBuild(await fighter(engine, 3), { type: "name", name });
    if (!built.ok) throw new Error(built.reasons.join("; "));
    writeFileSync(
      join(FIXTURES, `${name.toLowerCase()}.json`),
      JSON.stringify(built.build, null, 2),
    );
  }
  execFileSync("npx", ["vitest", "run", "tests/e2e-fixtures/copies.test.ts"], {
    env: { ...process.env, F011_E2E_FIXTURES: FIXTURES },
    stdio: "inherit",
  });
}
