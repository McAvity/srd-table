/**
 * kenli F-006 T04: build the characters the browser tests import (as files, through the app's
 * import dialog), with the in-process engine, into a /tmp folder (never into the repository).
 */

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
}
