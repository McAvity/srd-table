// kenli F-014 T01: `inputs.app_version` in the release id and the descriptor checks, and the build
// metadata embedded in the JS (docs/deployment.md §2–3). The legacy descriptor is the verbatim
// release.json of a real `bun scripts/release.ts --base /srd-table/` build of Table 0d64dc4 (before
// F-014; sha256 545cb3258f396a6b4c53165b1c5e4bb196c4c095e6969269c30254eb509dbb16).

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BUILD_INFO,
  type BuildInfo,
  buildInfoProblems,
  buildInfoText,
  DEV_BUILD_INFO,
  versionLabel,
} from "@/offline/build-info";
import {
  appVersionProblems,
  descriptorProblems,
  type ReleaseDescriptor,
  type ReleaseInputs,
  releaseIdOf,
} from "@/offline/descriptor";
import { canonicalJson } from "../../src/lib/canonical";

const sha = (s: string | Uint8Array) => createHash("sha256").update(s).digest("hex");
const LEGACY_BYTES = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "fixtures/legacy-release-0d64dc4.json"),
);
const LEGACY = JSON.parse(LEGACY_BYTES.toString("utf8")) as ReleaseDescriptor;
const TABLE = "0d64dc4dae2cf7c1e973065297d53ed19a8618aa";
const ENGINE = "65ff5e28f6bd03a5abf7521c29913e3276b48013";

/** The legacy descriptor relabelled with other inputs (same files): only the identity changes. */
function withInputs(inputs: ReleaseInputs): ReleaseDescriptor {
  const id = releaseIdOf(inputs, sha);
  const rename = (p: string) => p.split(LEGACY.release_id).join(id);
  return {
    ...LEGACY,
    release_id: id,
    base: inputs.base,
    inputs,
    sw: { ...LEGACY.sw, path: rename(LEGACY.sw.path) },
    html: { ...LEGACY.html, path: rename(LEGACY.html.path) },
    webmanifest: {
      ...LEGACY.webmanifest,
      path: rename(LEGACY.webmanifest.path),
      id: inputs.base,
      start_url: inputs.base,
      scope: inputs.base,
    },
    graph: {
      roots: LEGACY.graph.roots.map(rename),
      edges: LEGACY.graph.edges.map(([a, b]) => [rename(a), rename(b)] as const),
    },
  };
}

describe("legacy release (no app_version)", () => {
  it("is the verbatim pre-F-014 descriptor and still valid, with the same id", () => {
    expect(sha(LEGACY_BYTES)).toBe(
      "545cb3258f396a6b4c53165b1c5e4bb196c4c095e6969269c30254eb509dbb16",
    );
    expect("app_version" in LEGACY.inputs).toBe(false);
    expect(LEGACY.release_id).toBe("r-0af9ad3bab7f73e6");
    expect(releaseIdOf(LEGACY.inputs, sha)).toBe(LEGACY.release_id);
    expect(descriptorProblems(LEGACY, sha)).toEqual([]);
  });
});

describe("app_version in the release id", () => {
  const legacyInputs = LEGACY.inputs;
  const v = (app_version: string, over: Partial<ReleaseInputs> = {}): ReleaseInputs => ({
    ...legacyInputs,
    ...over,
    app_version,
  });

  it("the same inputs give the same id, whatever the key order", () => {
    const a = v("0.2.0-rc.1");
    const reordered = JSON.parse(
      JSON.stringify(Object.fromEntries(Object.entries(a).reverse())),
    ) as ReleaseInputs;
    expect(releaseIdOf(a, sha)).toBe(releaseIdOf(reordered, sha));
    expect(releaseIdOf(a, sha)).toBe(`r-${sha(canonicalJson(a)).slice(0, 16)}`);
  });

  it("only the version, or only the base, changes the id", () => {
    const rc1 = releaseIdOf(v("0.2.0-rc.1"), sha);
    const final = releaseIdOf(v("0.2.0"), sha);
    const otherBase = releaseIdOf(v("0.2.0", { base: "/dnd/" }), sha);
    expect(new Set([LEGACY.release_id, rc1, final, otherBase]).size).toBe(4);
  });

  it("a versioned descriptor is valid", () => {
    const d = withInputs(v("0.2.0-rc.1"));
    expect(descriptorProblems(d, sha)).toEqual([]);
    expect(d.release_id).not.toBe(LEGACY.release_id);
  });

  it.each(["v0.2.0", "0.2.0-beta.1", "0.2.0+b", "", "01.0.0"])(
    "a descriptor with app_version %j is refused",
    (bad) => {
      const d = withInputs(v(bad));
      expect(descriptorProblems(d, sha)).toContain("release_inputs: app_version");
    },
  );

  it("a non-string or a dirty build's version is refused", () => {
    expect(appVersionProblems({ ...legacyInputs, app_version: 2 })).toEqual(["app_version"]);
    expect(appVersionProblems({ ...legacyInputs, app_version: null })).toEqual(["app_version"]);
    expect(appVersionProblems({ ...legacyInputs, app_version: "0.2.0", dirty: true })).toEqual([
      "app_version on a dirty build",
    ]);
    expect(appVersionProblems(legacyInputs)).toEqual([]);
  });
});

describe("build metadata", () => {
  const release: BuildInfo = {
    version: "0.2.0-rc.1",
    release_id: "r-0123456789abcdef",
    table_commit: TABLE,
    engine_commit: ENGINE,
  };

  it("tests and dev run as the development build: no version, never a stable label", () => {
    expect(BUILD_INFO).toEqual(DEV_BUILD_INFO);
    expect(buildInfoProblems(DEV_BUILD_INFO)).toEqual([]);
    expect(versionLabel(DEV_BUILD_INFO)).toBeNull();
    expect(buildInfoText(DEV_BUILD_INFO)).toContain("development build");
  });

  it("a release's metadata is valid and labelled by its version", () => {
    expect(buildInfoProblems(release)).toEqual([]);
    expect(versionLabel(release)).toBe("0.2.0-rc.1");
    expect(buildInfoText(release)).toBe(
      [
        "SRD Table 0.2.0-rc.1",
        "release: r-0123456789abcdef",
        `table: ${TABLE}`,
        `engine: ${ENGINE}`,
      ].join("\n"),
    );
  });

  it("a release without a number shows its own release id", () => {
    const legacy = { ...release, version: null };
    expect(buildInfoProblems(legacy)).toEqual([]);
    expect(versionLabel(legacy)).toBe("r-0123456789abcdef");
    expect(buildInfoText(legacy)).toContain("(no version)");
  });

  it("refuses malformed metadata (scripts/release.ts fails the build)", () => {
    const problems = (over: Record<string, unknown>) => buildInfoProblems({ ...release, ...over });
    expect(buildInfoProblems("{")).toEqual(["not an object"]);
    expect(problems({ release_id: "r-xyz" })).toContain("release_id");
    expect(problems({ version: "v0.2.0" })).toContain("version");
    expect(problems({ version: "<i>1.0.0</i>" })).toContain("version");
    expect(problems({ table_commit: "abc" })).toContain("table_commit");
    expect(problems({ html: "<b>" })).toContain("unknown field html");
    expect(problems({ dirty: true })).toContain("a version needs a clean build of known commits");
    expect(problems({ engine_commit: null })).toContain(
      "a version needs a clean build of known commits",
    );
    expect(problems({ dirty: false })).toContain("dirty");
    expect(buildInfoProblems({ ...DEV_BUILD_INFO, version: "0.2.0" })).toContain(
      "a dev build has no version or commits",
    );
  });

  it("a dirty release without a version is allowed and says so", () => {
    const dirty: BuildInfo = { ...release, version: null, dirty: true };
    expect(buildInfoProblems(dirty)).toEqual([]);
    expect(buildInfoText(dirty)).toContain("uncommitted changes: yes");
  });
});
