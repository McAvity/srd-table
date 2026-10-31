// @vitest-environment node
/**
 * kenli F-011 T10 (dnd5 contracts/changes.md §7, examples/release-data.json D01–D08): the data a
 * release declares and the update gate. The installed F-007 release (Table a2e1bae, deployed
 * r-7d182a935ec966b5) is checked with ITS OWN `OWN_DATA` and `compatible()`, read verbatim from
 * that commit (`git show`), not rewritten here; this release's are the current module's. The
 * release builder's declaration equals `OWN_DATA`, and a malformed declaration is a bad descriptor.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { dataProblems, type ReleaseInputs } from "../../src/offline/descriptor";
import { compatible, OWN_DATA } from "../../src/offline/update";

const TABLE = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const EXAMPLES = join(
  TABLE,
  "../../../docs/features/F-011-character-export/contracts/examples/release-data.json",
);
// biome-ignore lint/suspicious/noExplicitAny: contract example values
type Loose = any;
type Data = ReleaseInputs["data"];

/** The installed release's gate, from its own source (Table a2e1bae), types stripped. */
function installedGate(): (data: Data | undefined) => boolean {
  const src = execFileSync("git", ["-C", TABLE, "show", "a2e1bae:src/offline/update.ts"], {
    encoding: "utf8",
  });
  const own = /export const OWN_DATA = (\{[\s\S]*?\}) as const;/.exec(src)?.[1];
  const gate =
    /const compatible = \(data: ReleaseDescriptor\["inputs"\]\["data"\] \| undefined\): boolean =>([\s\S]*?);\n/.exec(
      src,
    )?.[1];
  if (!own || !gate) throw new Error("a2e1bae's OWN_DATA/compatible not found");
  return new Function("data", `const OWN_DATA = ${own}; return (${gate});`) as (
    data: Data | undefined,
  ) => boolean;
}

const ex = JSON.parse(readFileSync(EXAMPLES, "utf8"));
function dataOf(v: Loose): Data {
  if (typeof v === "string") return structuredClone(ex[v]);
  return { ...structuredClone(ex[v.patch]), ...v.set };
}

describe("D01–D08: the installed release A and this release B", () => {
  const gateA = installedGate();
  for (const c of ex.cases as Loose[]) {
    it(`${c.id}: ${c.check === "a2e1bae" ? "installed A" : "this release"} ${c.expect ? "accepts" : "refuses"}`, () => {
      const own = dataOf(c.own);
      const data = dataOf(c.data);
      if (c.check === "a2e1bae") {
        expect(own).toEqual(ex.release_A_own); // the installed release's own data, as deployed
        expect(gateA(data)).toBe(c.expect);
      } else {
        expect(own).toEqual(structuredClone(OWN_DATA) as unknown as Data); // this release
        expect(compatible(data)).toBe(c.expect);
      }
    });
  }
  it("this release's data is release_B_data, which the installed A accepts", () => {
    expect(structuredClone(OWN_DATA)).toEqual(ex.release_B_data);
    expect(installedGate()(structuredClone(OWN_DATA) as unknown as Data)).toBe(true);
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
