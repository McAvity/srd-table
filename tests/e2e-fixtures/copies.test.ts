/**
 * kenli F-011 T04: the full copies the browser tests import (e2e/), made by the app's own export on
 * a fake installation: Aerin and Brann (Fighter 3, no portrait: the F-006 flows) and Cora (Fighter 3)
 * with a real PNG portrait, and Lirael (Wizard 3, the M1–M5 flows), all pinned to the SRD and the test pack. Runs only when the e2e global setup asks for it
 * (`F011_E2E_FIXTURES` = the /tmp folder); a skipped test in the ordinary run.
 */

import "../helpers/node-blob";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { exportLocalCopy } from "../../src/import/localCopy/export";
import { setImageDecoder } from "../../src/lib/image";
import { useDocuments } from "../../src/store/documents";
import { usePortraits } from "../../src/store/portraits";
import { fighter, wizard } from "../fixtures/characters";
import { testContext } from "../fixtures/player-actions";
import { headerDecoder, realPng } from "../helpers/images";
import { addCharacter, bytesOf, Installations, ok, storeTestPack } from "../localCopy/helpers";

const out = process.env.F011_E2E_FIXTURES;
const inst = new Installations();
afterAll(async () => {
  await inst.close();
  setImageDecoder(null);
});

describe.runIf(out)("e2e copies", () => {
  it("Aerin, Brann and Lirael without a portrait, Cora with one", async () => {
    mkdirSync(out as string, { recursive: true });
    await inst.open("E2E");
    await storeTestPack();
    const ctx = await testContext(inst.fx.engine);
    // jsdom has no decoder: the portrait is a real PNG, decoded for real by the browsers later.
    setImageDecoder(headerDecoder);
    for (const name of ["Aerin", "Brann", "Cora", "Lirael"]) {
      const base = name === "Lirael" ? wizard(inst.fx.engine, 3) : fighter(inst.fx.engine, 3);
      const built = await inst.fx.engine.editBuild(await base, {
        type: "name",
        name,
      });
      if (!built.ok) throw new Error(built.reasons.join("; "));
      const id = await addCharacter(built.build, ctx, inst.fx.engine);
      if (name === "Cora") ok(await usePortraits.getState().set(id, new Blob([realPng(96, 64)])));
      const x = ok(await exportLocalCopy(id));
      writeFileSync(
        join(out as string, `${name.toLowerCase()}.local-copy.json`),
        await bytesOf(x.blob),
      );
      expect(useDocuments.getState().characters[id]?.build.name).toBe(name);
    }
  }, 120_000);
});
