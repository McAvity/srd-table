// @vitest-environment node
/**
 * kenli F-011 T10 (dnd5 contracts/changes.md §7, examples/release-data.json D01–D08): the data a
 * release declares and the update gate. The installed F-007 release (Table a2e1bae, deployed
 * r-7d182a935ec966b5) is checked with ITS OWN `OWN_DATA` and `compatible()`, kept verbatim as a
 * fixture (fixtures/installed-a2e1bae.ts), not rewritten; this release's are the current
 * module's. The release builder's declaration equals `OWN_DATA`, and a malformed declaration is a
 * bad descriptor. Self-contained (review03 R03-15): the cases are a fixture copy of the dnd5
 * contract example, and no git history is read; dnd5 checks both copies against their sources.
 *
 * kenli F-002 T07 (dnd5 contracts/progression.md §10): F-011's release is now the installed one
 * (r-bccac419bfb8a6ba, Table 28c4d4d): D05–D08 check ITS gate, kept verbatim as a fixture
 * (fixtures/installed-28c4d4d.ts). This release declares database 5, `/3` copies and `/3` entries
 * and accepts a candidate with a database at least its own; F-011 refuses it (the bridge B0 is
 * needed), and this release refuses both older ones (no downgrade).
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { dataProblems, type ReleaseInputs } from "../../src/offline/descriptor";
import { compatible, OWN_DATA } from "../../src/offline/update";
import * as installedF011 from "./fixtures/installed-28c4d4d";
import * as installedA from "./fixtures/installed-a2e1bae";
import { RELEASE_DATA_JSON } from "./fixtures/release-data";

const TABLE = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
// biome-ignore lint/suspicious/noExplicitAny: contract example values
type Loose = any;
type Data = ReleaseInputs["data"];

const ex = JSON.parse(RELEASE_DATA_JSON);
function dataOf(v: Loose): Data {
  if (typeof v === "string") return structuredClone(ex[v]);
  return { ...structuredClone(ex[v.patch]), ...v.set };
}

describe("D01–D08: the installed release A and this release B", () => {
  const gateA = installedA.compatible; // the installed release's gate (Table a2e1bae)
  for (const c of ex.cases as Loose[]) {
    it(`${c.id}: ${c.check === "a2e1bae" ? "installed A" : "this release"} ${c.expect ? "accepts" : "refuses"}`, () => {
      const own = dataOf(c.own);
      const data = dataOf(c.data);
      if (c.check === "a2e1bae") {
        expect(own).toEqual(ex.release_A_own); // the installed release's own data, as deployed
        expect(structuredClone(installedA.OWN_DATA)).toEqual(ex.release_A_own);
        expect(gateA(data)).toBe(c.expect);
      } else {
        // F-011's release (then "this release"), with its own gate.
        expect(own).toEqual(structuredClone(installedF011.OWN_DATA) as unknown as Data);
        expect(installedF011.compatible(data)).toBe(c.expect);
      }
    });
  }
  it("F-011's data is release_B_data, which the installed A accepts", () => {
    expect(structuredClone(installedF011.OWN_DATA)).toEqual(ex.release_B_data);
    expect(installedA.compatible(structuredClone(installedF011.OWN_DATA) as unknown as Data)).toBe(
      true,
    );
  });
});

describe("kenli F-002 T07: this release's data (database 5) and the gate", () => {
  const f011 = structuredClone(ex.release_B_data) as Data;
  const own = structuredClone(OWN_DATA) as unknown as Data;
  it("is F-011's with database 5 and /3 copies and entries added (nothing removed)", () => {
    expect(own).toEqual({
      ...f011,
      db_version: 5,
      local_copy_formats: [...f011.local_copy_formats, "srd-table.local-copy/3"],
      history_entry_schemas: [...(f011.history_entry_schemas ?? []), "kenli.history/3"],
    });
  });
  it("accepts itself and a later database; refuses F-011 and A (no downgrade)", () => {
    expect(compatible(own)).toBe(true);
    expect(compatible({ ...own, db_version: 6 })).toBe(true);
    expect(compatible(f011)).toBe(false);
    expect(compatible(structuredClone(ex.release_A_own) as Data)).toBe(false);
  });
  it("the other checks stay: a /3 copy, a /3 entry, the journal family are still required", () => {
    expect(compatible({ ...own, local_copy_formats: f011.local_copy_formats })).toBe(false);
    expect(compatible({ ...own, history_entry_schemas: f011.history_entry_schemas })).toBe(false);
    expect(compatible({ ...own, history_schema: "kenli.history/2" })).toBe(false);
    expect(compatible({ ...own, state_versions: [1, 2] })).toBe(false);
  });
  it("installed F-011 refuses this release (its gate wants database 4): only the bridge B0 leads here", () => {
    expect(installedF011.compatible(own)).toBe(false);
    expect(installedA.compatible(own)).toBe(false);
  });
});

describe("the release builder declares OWN_DATA, and malformed declarations are refused", () => {
  it("scripts/release.ts writes the same data as OWN_DATA (the descriptor's inputs)", () => {
    const text = readFileSync(join(TABLE, "scripts/release.ts"), "utf8");
    for (const [k, v] of Object.entries(OWN_DATA))
      if (k !== "db_version")
        expect(text).toContain(`${k}: ${JSON.stringify(v).replaceAll(",", ", ")}`);
  });
  it("well-formed: B's data and A's (without the additive lists)", () => {
    expect(dataProblems(ex.release_B_data)).toEqual([]);
    expect(dataProblems(ex.release_A_own)).toEqual([]);
  });
  it("malformed: an unknown field, wrong types, a non-list or non-integer version", () => {
    const b = ex.release_B_data;
    expect(dataProblems({ ...b, history_schemas: [] })).toEqual(["unknown field history_schemas"]);
    expect(dataProblems({ ...b, db_version: "4" })).toEqual(["db_version"]);
    expect(dataProblems({ ...b, history_entry_schemas: "kenli.history/2" })).toEqual([
      "history_entry_schemas",
    ]);
    expect(dataProblems({ ...b, state_versions: [1, 2.5] })).toEqual(["state_versions"]);
    expect(dataProblems({ ...b, local_copy_formats: [""] })).toEqual(["local_copy_formats"]);
    expect(dataProblems(null)).toEqual(["not an object"]);
  });
});
