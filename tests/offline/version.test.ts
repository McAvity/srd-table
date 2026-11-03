// kenli F-014 T01: the readable version subset and its order (docs/deployment.md §1, R01-03).

import { describe, expect, it } from "vitest";
import {
  compareAppVersions,
  isAppVersion,
  parseAppVersion,
  tagOfVersion,
  versionOfTag,
} from "@/offline/version";

describe("app version subset", () => {
  it.each([
    ["0.2.0", { major: 0, minor: 2, patch: 0, rc: null }],
    ["0.2.0-rc.1", { major: 0, minor: 2, patch: 0, rc: 1 }],
    ["1.10.100-rc.25", { major: 1, minor: 10, patch: 100, rc: 25 }],
    ["0.0.0", { major: 0, minor: 0, patch: 0, rc: null }],
    [
      `${Number.MAX_SAFE_INTEGER}.0.0`,
      { major: Number.MAX_SAFE_INTEGER, minor: 0, patch: 0, rc: null },
    ],
  ])("accepts %s", (text, parsed) => {
    expect(parseAppVersion(text)).toEqual(parsed);
    expect(isAppVersion(text)).toBe(true);
  });

  it.each([
    "v0.2.0", // the tag, not the version
    "0.2",
    "0.2.0.1",
    "00.2.0",
    "0.02.0",
    "0.2.00",
    "0.2.0-rc.0",
    "0.2.0-rc.01",
    "0.2.0-rc",
    "0.2.0-rc.1.1",
    "0.2.0-beta.1",
    "0.2.0-RC.1",
    "0.2.0-alpha",
    "0.2.0+build.5",
    "0.2.0-rc.1+build",
    " 0.2.0",
    "0.2.0\n",
    "-1.0.0",
    "1.0.0-",
    "",
    `${Number.MAX_SAFE_INTEGER + 2}.0.0`, // not a safe integer
    "0.2.0-rc.99999999999999999999",
    "<b>1.0.0</b>",
  ])("refuses %j", (text) => {
    expect(parseAppVersion(text)).toBeNull();
    expect(isAppVersion(text)).toBe(false);
  });

  it("refuses what isn't a string", () => {
    for (const v of [null, undefined, 1, { major: 0 }, ["0.2.0"]])
      expect(parseAppVersion(v)).toBeNull();
  });
});

describe("app version order", () => {
  it("orders release candidates numerically, below the final version", () => {
    const chain = ["0.2.0-rc.2", "0.2.0-rc.10", "0.2.0", "0.2.1"];
    for (let i = 0; i + 1 < chain.length; i++) {
      expect(compareAppVersions(chain[i] as string, chain[i + 1] as string)).toBe(-1);
      expect(compareAppVersions(chain[i + 1] as string, chain[i] as string)).toBe(1);
    }
    expect(compareAppVersions("0.9.0", "0.10.0")).toBe(-1);
    expect(compareAppVersions("0.2.0-rc.1", "0.2.0-rc.1")).toBe(0);
    expect(compareAppVersions("1.0.0-rc.1", "0.99.99")).toBe(1);
    expect(compareAppVersions("0.2.0", "0.2.0-rc.3")).toBe(1);
  });

  it("sorts a mixed list", () => {
    const list = ["0.10.0", "0.2.0", "0.2.0-rc.10", "0.9.0", "0.2.0-rc.2", "0.2.1", "1.0.0-rc.1"];
    expect([...list].sort(compareAppVersions)).toEqual([
      "0.2.0-rc.2",
      "0.2.0-rc.10",
      "0.2.0",
      "0.2.1",
      "0.9.0",
      "0.10.0",
      "1.0.0-rc.1",
    ]);
  });

  it("throws on an unsupported version", () => {
    expect(() => compareAppVersions("0.2.0", "0.2.0-beta.1")).toThrow(/unsupported/);
    expect(() => compareAppVersions("v1.0.0", "1.0.0")).toThrow(/unsupported/);
  });
});

describe("tags", () => {
  it("maps a version to its tag and back", () => {
    expect(tagOfVersion("0.2.0-rc.1")).toBe("v0.2.0-rc.1");
    expect(versionOfTag("v0.2.0-rc.1")).toBe("0.2.0-rc.1");
    expect(versionOfTag("v0.2.0")).toBe("0.2.0");
  });
  it("refuses other refs", () => {
    for (const ref of ["0.2.0", "vv0.2.0", "v0.2.0+b", "refs/tags/v0.2.0", "main", "V0.2.0"])
      expect(versionOfTag(ref)).toBeNull();
    expect(() => tagOfVersion("v0.2.0")).toThrow();
  });
});
