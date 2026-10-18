/**
 * Turn a character bundle (`kenli.bundle/1`, made by kenli-content-pipeline) into the files the
 * app's Import reads: `<name>.json` (the build) and, if asked, `<name>.state.json` (a play state).
 *
 *   npm run bundle:character -- <bundle.json> [--fixture r1] [--state FX-R1-RESTED] [--out dir]
 *
 * Both documents go through the engine's `parseBuild` / `parseState`, so a file that fails here
 * would fail the Import too. The build is also checked against the SRD alone and its errors are
 * listed: content from the bundle's own pack (custom species, feats, spells…) isn't loaded by the
 * app yet, so those choices show up as unknown until it is.
 *
 * The output goes to `content/private/<bundle_id>/` by default (git-ignored: a bundle is private).
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { evaluate, parseBuild, parseState } from "srd-rules-engine";
import { srdCatalog } from "srd-rules-engine/srd";

interface Fixture {
  build: unknown;
  default_initial_state?: unknown;
  states?: Record<string, unknown>;
}

interface Bundle {
  format: string;
  bundle_id: string;
  fixtures: Record<string, Fixture>;
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    fixture: { type: "string" },
    state: { type: "string" },
    out: { type: "string" },
  },
});

const input = positionals[0];
if (!input) {
  fail("Usage: npm run bundle:character -- <bundle.json> [--fixture id] [--state id] [--out dir]");
}

const bundle = JSON.parse(readFileSync(input, "utf8")) as Bundle;
if (!bundle.format?.startsWith("kenli.bundle/")) {
  fail(`${basename(input)}: not a character bundle (format ${JSON.stringify(bundle.format)})`);
}

const fixtureIds = Object.keys(bundle.fixtures ?? {});
const fixtureId = values.fixture ?? fixtureIds[0];
const fixture = fixtureId ? bundle.fixtures[fixtureId] : undefined;
if (!fixtureId || !fixture) {
  fail(`No fixture ${JSON.stringify(values.fixture)}; the bundle has: ${fixtureIds.join(", ")}`);
}

const build = (() => {
  try {
    return parseBuild(fixture.build);
  } catch (error) {
    return fail(`The build doesn't parse: ${(error as Error).message}`);
  }
})();

// The state: the one asked for, else the bundle's default (none means the app starts a fresh one).
const stateIds = Object.keys(fixture.states ?? {});
let rawState: unknown = fixture.default_initial_state ?? null;
if (values.state) {
  rawState = fixture.states?.[values.state];
  if (rawState === undefined) {
    fail(`No state ${JSON.stringify(values.state)}; the fixture has: ${stateIds.join(", ")}`);
  }
}
const state = (() => {
  if (rawState === null) return null;
  try {
    return parseState(rawState);
  } catch (error) {
    return fail(`The state doesn't parse: ${(error as Error).message}`);
  }
})();

const slug =
  (build.name || fixtureId)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || fixtureId;
const outDir = resolve(values.out ?? join(root, "content", "private", bundle.bundle_id));
mkdirSync(outDir, { recursive: true });

const write = (name: string, data: unknown) => {
  const path = join(outDir, name);
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
  console.log(`Wrote ${path}`);
};
write(`${slug}.json`, build);
if (state) write(`${slug}.state.json`, state);
else console.log("No state written: the app starts a fresh one on import.");
if (stateIds.length > 0) console.log(`States in the bundle (--state): ${stateIds.join(", ")}`);

// What the app will flag with the SRD alone.
const errors = evaluate(build, srdCatalog()).report.issues.filter((i) => i.severity === "error");
if (errors.length > 0) {
  console.log(`\nWith the SRD alone the build has ${errors.length} error(s):`);
  for (const issue of errors) console.log(`  - ${issue.message}`);
}
