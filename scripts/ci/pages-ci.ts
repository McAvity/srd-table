/**
 * kenli F-014 T03: the workflow's helper commands (docs/deployment.md §9). Run with Bun (no install
 * needed: Bun runs this TypeScript and its imports as they are). Inputs come as arguments and
 * environment variables, never interpolated into shell code; results are JSON on stdout and, for
 * `resolve`, `key=value` lines appended to $GITHUB_OUTPUT.
 *
 *   resolve    --mode M [--tag vX.Y.Z[-rc.N]] --repo-dir DIR --main REF
 *   pin        --repo-dir DIR [--commit REF]
 *   facts      --repo OWNER/NAME --workflow FILE [--tag T] [--run-id N] --out FILE [--wait-success S]
 *   pack       --site DIR --manifest FILE --out TAR [--canary DIR]... [--source DIR]
 *   verify-tar --tar TAR --manifest FILE [--sha256 HEX]
 *   smoke      --site-url URL --manifest FILE [--rounds N] [--delay-ms MS]
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve as resolvePath } from "node:path";
import { parseArgs } from "node:util";
import { canaryProblems, type Probe, packSite, verifyTar } from "../publish/artifact";
import { deploymentFacts, rulesetFacts } from "../publish/github";
import { type FileRef, fail, PublishError, parseVersion, sha256 } from "../publish/lib";
import { smokeSite } from "../publish/smoke";

export const MODES = ["initialize", "publish", "retry", "resolve"] as const;
export type Mode = (typeof MODES)[number];
const TAG = /^v[0-9][0-9.]*(?:-rc\.[0-9]+)?$/;
const SHA = /^[0-9a-f]{40}$/;

const git = (dir: string, ...args: string[]) =>
  execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const tryGit = (dir: string, ...args: string[]) => {
  try {
    return git(dir, ...args);
  } catch {
    return null;
  }
};

/** ENGINE_COMMIT of scripts/engine-pin.ts at `commit`: exactly one 40-hex pin. */
export function pinAt(repoDir: string, commit: string): string {
  const src =
    tryGit(repoDir, "show", `${commit}:scripts/engine-pin.ts`) ??
    fail("pin_missing", `no scripts/engine-pin.ts at ${commit}`);
  const pins = [...src.matchAll(/^export const ENGINE_COMMIT = "([^"]*)";$/gm)];
  if (pins.length !== 1) fail("pin_missing", `${pins.length} ENGINE_COMMIT lines at ${commit}`);
  const pin = (pins[0] as RegExpMatchArray)[1] as string;
  if (!SHA.test(pin)) fail("pin_invalid", `ENGINE_COMMIT ${JSON.stringify(pin)} is not a full SHA`);
  return pin;
}

export interface Resolved {
  readonly mode: Mode;
  readonly tag: string;
  readonly version: string;
  readonly tag_commit: string;
  readonly engine_commit: string;
}
/**
 * The dispatch inputs, checked: a known mode; for every mode but initialize a tag `v<version>` of
 * the supported subset that exists, resolves to a full commit contained in `main`, and pins one
 * engine commit there.
 */
export function resolveInputs(o: {
  mode: string;
  tag: string;
  repoDir: string;
  main: string;
}): Resolved {
  if (!(MODES as readonly string[]).includes(o.mode))
    fail("input_invalid", `mode ${JSON.stringify(o.mode)}`);
  const mode = o.mode as Mode;
  if (mode === "initialize") {
    if (o.tag) fail("input_invalid", "initialize takes no tag");
    return { mode, tag: "", version: "", tag_commit: "", engine_commit: "" };
  }
  if (!TAG.test(o.tag) || !parseVersion(o.tag.slice(1)))
    fail("input_invalid", `tag ${JSON.stringify(o.tag)}`);
  const version = o.tag.slice(1);
  const commit =
    tryGit(o.repoDir, "rev-parse", "--verify", "--quiet", `refs/tags/${o.tag}^{commit}`) ??
    fail("tag_missing", `${o.tag} does not exist`);
  if (!SHA.test(commit)) fail("tag_missing", `${o.tag} → ${commit}`);
  const main =
    tryGit(o.repoDir, "rev-parse", "--verify", "--quiet", `${o.main}^{commit}`) ??
    fail("main_missing", o.main);
  if (tryGit(o.repoDir, "merge-base", "--is-ancestor", commit, main) === null)
    fail("tag_not_on_main", `${o.tag} (${commit}) is not in ${o.main} (${main})`);
  return { mode, tag: o.tag, version, tag_commit: commit, engine_commit: pinAt(o.repoDir, commit) };
}

/** Every regular file under a directory, as canary probes. */
function probesOf(
  dir: string,
  byName: boolean,
  skip: (rel: string) => boolean = () => false,
): Probe[] {
  const out: Probe[] = [];
  const go = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      const rel = relative(dir, p);
      if (skip(rel)) continue;
      if (e.isDirectory()) go(p);
      else if (e.isFile() && statSync(p).size > 0)
        out.push({ path: rel, bytes: readFileSync(p), byName });
    }
  };
  go(dir);
  return out;
}
/**
 * A Table checkout's tracked source/config files (not `public/`, whose favicon and icons ship
 * renamed with the same bytes): none may be in the artifact by content.
 */
function sourceProbes(dir: string): Probe[] {
  return git(dir, "ls-files", "-z")
    .split("\0")
    .filter((p) => p && !p.startsWith("public/"))
    .flatMap((p) => {
      const abs = join(dir, p);
      const st = statSync(abs, { throwIfNoEntry: false });
      return st?.isFile() && st.size > 0
        ? [{ path: p, bytes: readFileSync(abs), byName: false }]
        : [];
    });
}

const readManifest = (path: string): FileRef[] => {
  const m = JSON.parse(readFileSync(path, "utf8")) as { format?: string; files?: FileRef[] };
  if (m.format !== "srd-table.site-manifest/1" || !Array.isArray(m.files))
    fail("usage", `${path} is not a site manifest`);
  return m.files as FileRef[];
};

async function main(): Promise<unknown> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      mode: { type: "string" },
      tag: { type: "string", default: "" },
      "repo-dir": { type: "string" },
      main: { type: "string" },
      commit: { type: "string", default: "HEAD" },
      repo: { type: "string" },
      workflow: { type: "string" },
      "run-id": { type: "string" },
      out: { type: "string" },
      "wait-success": { type: "string" },
      site: { type: "string" },
      manifest: { type: "string" },
      canary: { type: "string", multiple: true, default: [] },
      source: { type: "string" },
      tar: { type: "string" },
      sha256: { type: "string" },
      "site-url": { type: "string" },
      rounds: { type: "string" },
      "delay-ms": { type: "string" },
    },
  });
  const need = (k: keyof typeof values): string => {
    const v = values[k];
    return typeof v === "string" && v !== "" ? v : fail("usage", `--${k} is required`);
  };
  switch (positionals[0]) {
    case "resolve": {
      const r = resolveInputs({
        mode: need("mode"),
        tag: values.tag ?? "",
        repoDir: need("repo-dir"),
        main: need("main"),
      });
      const out = process.env.GITHUB_OUTPUT;
      if (out)
        appendFileSync(
          out,
          Object.entries(r)
            .map(([k, v]) => `${k}=${v}\n`)
            .join(""),
        );
      return r;
    }
    case "pin":
      return { engine_commit: pinAt(need("repo-dir"), values.commit ?? "HEAD") };
    case "facts": {
      const token = process.env.GITHUB_TOKEN ?? fail("usage", "GITHUB_TOKEN is required");
      const o = { repo: need("repo"), token, api: process.env.GITHUB_API_URL };
      const runId = values["run-id"] ? Number(values["run-id"]) : null;
      const waitS = values["wait-success"] ? Number(values["wait-success"]) : 0;
      const until = Date.now() + waitS * 1000;
      const rulesets = await rulesetFacts(o);
      let deployments = await deploymentFacts(o, {
        workflow: need("workflow"),
        tag: values.tag || null,
        extraRuns: runId ? [runId] : [],
      });
      while (waitS && deployments.candidate !== "success" && Date.now() < until) {
        await new Promise((r) => setTimeout(r, 10_000));
        deployments = await deploymentFacts(o, {
          workflow: need("workflow"),
          tag: values.tag || null,
          extraRuns: runId ? [runId] : [],
        });
      }
      const facts = {
        rulesets,
        deployments: {
          everSucceeded: deployments.everSucceeded,
          deployments: deployments.deployments,
          candidate: deployments.candidate,
          records: deployments.records,
        },
        read: { candidate_runs: deployments.candidate_runs },
      };
      writeFileSync(need("out"), `${JSON.stringify(facts, null, 2)}\n`);
      return facts;
    }
    case "pack": {
      const files = readManifest(need("manifest"));
      const out = resolvePath(need("out"));
      const packed = packSite(resolvePath(need("site")), files, out);
      const tar = readFileSync(out);
      const problems = verifyTar(tar, files);
      const probes = [
        ...(values.canary ?? []).flatMap((d) => probesOf(resolvePath(d), true)),
        ...(values.source ? sourceProbes(resolvePath(values.source)) : []),
      ];
      problems.push(...canaryProblems(tar, probes));
      if (problems.length) {
        writeFileSync(out, "");
        fail("artifact_invalid", problems.slice(0, 20).join("; "));
      }
      return { ...packed, files: files.length, canary_probes: probes.length };
    }
    case "verify-tar": {
      const tar = readFileSync(need("tar"));
      const problems = verifyTar(tar, readManifest(need("manifest")));
      if (values.sha256 && sha256(tar) !== values.sha256.replace(/^sha256:/, ""))
        problems.push(`tar sha256 ${sha256(tar)} ≠ ${values.sha256}`);
      if (problems.length) fail("artifact_invalid", problems.slice(0, 20).join("; "));
      return { sha256: sha256(tar), size: tar.byteLength };
    }
    case "smoke": {
      const r = await smokeSite(need("site-url"), readManifest(need("manifest")), {
        rounds: values.rounds ? Number(values.rounds) : undefined,
        delayMs: values["delay-ms"] ? Number(values["delay-ms"]) : undefined,
      });
      if (!r.ok) fail("smoke_failed", r.problems.join("; "));
      return r;
    }
    default:
      return fail("usage", `unknown command ${String(positionals[0])}`);
  }
}

if (import.meta.main) {
  main().then(
    (r) => console.log(JSON.stringify(r)),
    (e) => {
      if (e instanceof PublishError) {
        console.error(`pages-ci refused: ${e.message}`);
        process.exit(1);
      }
      console.error(e);
      process.exit(2);
    },
  );
}
