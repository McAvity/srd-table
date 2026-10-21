/**
 * kenli F-007 T03 probe seed (not product code): synthetic data for the real-browser local-copy
 * probe, made with the engine in Node — a level 5 rogue (build + play state) pinned to the SRD and
 * the F-005 test pack, a level 3 rogue for the colliding records, an empty encounter document, the
 * pack's files and exact refs, and the contract's 595-entry synthetic journal (record id to be
 * filled in). Printed as JSON on stdout; no private data.
 *
 *   npx tsx scripts/f007-local-copy-seed.ts > seed.json
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { nodeFacade } from "../src/engine/node";
import { rogue } from "../tests/fixtures/characters";
import { TEST_PACK, testContext } from "../tests/fixtures/player-actions";

const here = dirname(fileURLToPath(import.meta.url));
const engine = nodeFacade({ seed: 7 });
const content = await testContext(engine);
const build = await rogue(engine, 5);
const state = await engine.createState(build, content);
const other = await rogue(engine, 3);
const otherState = await engine.createState(other, content);
const encounter = await engine.newEncounter();
const copy = JSON.parse(
  readFileSync(join(here, "../tests/localCopy/fixtures/long-pinned.local-copy.fixture"), "utf8"),
);
process.stdout.write(
  JSON.stringify({
    content,
    test_pack: { ref: content.packs[1], files: TEST_PACK },
    source: { build, state },
    other: { build: other, state: otherState },
    encounter,
    journal: {
      record_id: copy.payload.source.record_id,
      meta: copy.payload.history.meta,
      entries: copy.payload.history.entries,
    },
  }),
);
