// @vitest-environment node
// kenli F-014 T03: static checks of the two workflows (triggers, least privilege, main-only writes,
// pinned actions, no input interpolated into shell) and the input/tag/pin resolution on a real
// temporary Git repository. Nothing here talks to GitHub.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { pinAt, resolveInputs } from "../../scripts/ci/pages-ci";
import { PublishError } from "../../scripts/publish/lib";

const read = (p: string) => readFileSync(join(process.cwd(), ".github/workflows", p), "utf8");
/** The YAML without comment lines (comments may name what the workflow never does). */
const code = (y: string) =>
  y
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");
const RELEASE = code(read("pages-release.yml"));
const CI = code(read("ci.yml"));
/** The pins checked against the upstream tags (gh api …/git/ref/tags/<tag>, T03 ledger). */
const PINS: Record<string, string> = {
  "actions/checkout": "3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1",
  "actions/setup-node": "949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0",
  "actions/upload-artifact": "cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7.0.2",
  "actions/download-artifact": "9000827ccba6bdab643e8b6fd33ac0654aef8333 # v8.0.2",
  "actions/deploy-pages": "368f82528645a54fb793d4d04e342629a3f51346 # v5.0.1",
  "oven-sh/setup-bun": "0c5077e51419868618aeaa5fe8019c62421857d6 # v2.2.0",
};

/** The jobs of a workflow as text blocks (two-space job keys under `jobs:`). */
function jobs(yaml: string): Record<string, string> {
  const body = yaml.slice(yaml.indexOf("\njobs:\n") + 7);
  const out: Record<string, string> = {};
  const parts = body.split(/^ {2}([a-z][a-z0-9_-]*):\n/m);
  for (let i = 1; i < parts.length; i += 2) out[parts[i] as string] = parts[i + 1] as string;
  return out;
}

describe("workflows", () => {
  it("every action is pinned to a checked full commit SHA", () => {
    for (const y of [RELEASE, CI]) {
      const uses = [...y.matchAll(/uses: ([^@\s]+)@(.+)$/gm)];
      expect(uses.length).toBeGreaterThan(3);
      for (const [, name, ref] of uses) expect(PINS[name as string], `${name}@${ref}`).toBe(ref);
    }
    expect(RELEASE).not.toMatch(/upload-pages-artifact/); // our own checked tar instead (§9.4)
  });

  it("release: only a dispatch, serialized, no default permissions, writes only on main", () => {
    const on = RELEASE.slice(RELEASE.indexOf("\non:\n"), RELEASE.indexOf("\npermissions:"));
    expect(on).toMatch(/workflow_dispatch:/);
    expect(on).not.toMatch(
      /\b(push|pull_request|pull_request_target|schedule|workflow_run|repository_dispatch):/,
    );
    expect(RELEASE).toMatch(/^permissions: \{\}$/m);
    expect(RELEASE).toMatch(
      /concurrency:\n {2}group: pages-release\n {2}cancel-in-progress: false/,
    );
    const js = jobs(RELEASE);
    expect(Object.keys(js)).toEqual(["prepare", "build", "state", "deploy", "receipt"]);
    for (const [name, block] of Object.entries(js)) {
      expect(block, name).toMatch(/github\.ref == 'refs\/heads\/main'/);
      expect(block, name).toMatch(/\n {4}permissions:\n/);
    }
    const perms = (b: string) =>
      (b.match(/\n {4}permissions:\n((?: {6}.+\n)+)/)?.[1] ?? "").trim().split(/\n\s*/).sort();
    expect(perms(js.prepare as string)).toEqual(["contents: read"]);
    expect(perms(js.build as string)).toEqual(["contents: read"]);
    expect(perms(js.state as string)).toEqual([
      "actions: read",
      "contents: write",
      "deployments: read",
    ]);
    expect(perms(js.deploy as string)).toEqual(["id-token: write", "pages: write"]);
    expect(perms(js.receipt as string)).toEqual([
      "actions: read",
      "contents: write",
      "deployments: read",
    ]);
    expect(js.deploy).toMatch(/environment:\n {6}name: github-pages/);
    // the jobs that write run main's own code, never the tag's or a PR's
    for (const name of ["prepare", "state", "receipt"])
      expect(js[name], name).toMatch(/ref: \$\{\{ github\.sha \}\}/);
    expect(js.build).toMatch(/ref: \$\{\{ needs\.prepare\.outputs\.tag_commit \}\}/);
    expect(js.build).not.toMatch(/: write/);
  });

  it("inputs reach shell code only as environment variables; checkouts keep no credentials", () => {
    for (const y of [RELEASE, CI]) {
      for (const line of y.split("\n").filter((l) => /^\s+run: /.test(l)))
        expect(line, line).not.toMatch(/\$\{\{/);
      const checkouts = y.split("uses: actions/checkout@").length - 1;
      expect((y.match(/persist-credentials: false/g) ?? []).length).toBe(checkouts);
      expect(y).not.toMatch(/secrets\./);
    }
    expect(RELEASE).toMatch(/INPUT_TAG: \$\{\{ inputs\.tag \}\}/);
  });

  it("CI: push and pull_request only, read-only, no publication", () => {
    expect(CI).toMatch(/^permissions:\n {2}contents: read$/m);
    expect(CI).not.toMatch(/pull_request_target|: write|deploy-pages|upload-artifact|pages-state/);
    expect(CI).toMatch(/scripts\/ci\/build\.sh/);
  });
});

// ───────── resolve: a real temporary repository ─────────
const PIN = "65ff5e28f6bd03a5abf7521c29913e3276b48013";
function repo() {
  const dir = mkdtempSync(join(tmpdir(), "f014-t03-resolve-"));
  const g = (...a: string[]) =>
    execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...a], {
      encoding: "utf8",
    }).trim();
  const commit = (pinLine: string | null, msg: string) => {
    const f = join(dir, "scripts/engine-pin.ts");
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, `// ${msg}\n${pinLine ?? "// no pin"}\n`);
    g("add", "-A");
    g("commit", "-qm", msg);
    return g("rev-parse", "HEAD");
  };
  g("init", "-q", "-b", "main");
  return { dir, g, commit };
}
const refusedCode = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof PublishError) return e.code;
    throw e;
  }
  return null;
};

describe("resolve inputs, tag, main and pin", () => {
  it("a tag on main resolves to its full commit and that commit's pin", () => {
    const { dir, g, commit } = repo();
    const c1 = commit(`export const ENGINE_COMMIT = "${PIN}";`, "one");
    g("tag", "-a", "v0.2.0-rc.1", "-m", "rc1"); // an annotated tag: its commit, not the tag object
    commit(`export const ENGINE_COMMIT = "${"b".repeat(40)}";`, "two");
    const r = resolveInputs({ mode: "publish", tag: "v0.2.0-rc.1", repoDir: dir, main: "main" });
    expect(r).toEqual({
      mode: "publish",
      tag: "v0.2.0-rc.1",
      version: "0.2.0-rc.1",
      tag_commit: c1,
      engine_commit: PIN,
    });
    expect(pinAt(dir, "HEAD")).toBe("b".repeat(40));
    expect(resolveInputs({ mode: "initialize", tag: "", repoDir: dir, main: "main" }).mode).toBe(
      "initialize",
    );
  });

  it("refuses a bad mode or number, a missing tag, a tag outside main, a missing or invalid pin", () => {
    const { dir, g, commit } = repo();
    commit(`export const ENGINE_COMMIT = "${PIN}";`, "one");
    g("tag", "v0.2.0");
    const R = (mode: string, tag: string) => () =>
      resolveInputs({ mode, tag, repoDir: dir, main: "main" });
    expect(refusedCode(R("deploy", "v0.2.0"))).toBe("input_invalid");
    expect(refusedCode(R("initialize", "v0.2.0"))).toBe("input_invalid");
    for (const t of [
      "",
      "0.2.0",
      "v0.2",
      "v0.2.0-beta.1",
      "v00.2.0",
      "v0.2.0;rm -rf /",
      "v0.2.0+b",
    ])
      expect(refusedCode(R("publish", t)), t).toBe("input_invalid");
    expect(refusedCode(R("retry", "v0.3.0"))).toBe("tag_missing");
    g("checkout", "-q", "-b", "side");
    commit(`export const ENGINE_COMMIT = "${PIN}";`, "side");
    g("tag", "v0.9.0");
    expect(refusedCode(R("publish", "v0.9.0"))).toBe("tag_not_on_main");
    g("checkout", "-q", "main");
    commit(null, "pin removed");
    g("tag", "v0.4.0");
    expect(refusedCode(R("publish", "v0.4.0"))).toBe("pin_missing");
    commit('export const ENGINE_COMMIT = "main";', "pin a branch name");
    g("tag", "v0.5.0");
    expect(refusedCode(R("publish", "v0.5.0"))).toBe("pin_invalid");
    expect(refusedCode(R("resolve", "v0.2.0"))).toBeNull();
  });
});
