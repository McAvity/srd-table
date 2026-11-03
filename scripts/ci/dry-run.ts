/**
 * kenli F-014 T03: a local dry run of pages-release.yml on a fresh machine-like directory
 * (docs/deployment.md §9.6). It clones the two repositories fresh (no node_modules, dist or private
 * files carried over, an empty npm cache), runs the same steps the workflow runs — resolve, the build
 * script, state-op.sh, the tar transport, receipt.sh — and stands in only for GitHub itself:
 *   - pages-state is a local bare repository (REMOTE),
 *   - the facts are stated per step (FACTS; no GitHub API),
 *   - "deploy-pages" extracts the checked tar into a directory served over real HTTP under the base,
 *     dotfiles not served (LIVE_DIR for the witnesses, SMOKE_URL for the smoke).
 * Then: publish 0.2.0-rc.1; publish 0.2.0 with the runner lost after the checkpoint and a retry
 * run transporting the archived bytes (no build); retries of both; refused inputs.
 *
 *   bun scripts/ci/dry-run.ts --table-repo <url|path> --table-commit <sha> --engine-repo <url>
 *     --work <new dir> [--report r.json] [--skip-tests]
 */
import { spawn } from "node:child_process";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { join, resolve as resolvePath } from "node:path";
import { parseArgs } from "node:util";
import { readTar } from "../publish/artifact";

const { values } = parseArgs({
  options: {
    "table-repo": { type: "string" },
    "table-commit": { type: "string" },
    "engine-repo": { type: "string" },
    work: { type: "string" },
    report: { type: "string" },
    "skip-tests": { type: "boolean", default: false },
  },
});
const need = (k: keyof typeof values) => {
  const v = values[k];
  if (typeof v !== "string" || !v) throw new Error(`--${k} is required`);
  return v;
};
const work = resolvePath(need("work"));
if (existsSync(work)) throw new Error(`${work} exists`);
const ws = join(work, "workspace"); // GITHUB_WORKSPACE: only the checkouts, nothing else
const home = join(work, "home"); // an empty HOME: no user npmrc, git config or caches
for (const d of [ws, home, join(work, "npm-cache")]) mkdirSync(d, { recursive: true });
writeFileSync(
  join(home, ".gitconfig"),
  "[user]\n\tname = dry run\n\temail = dry-run@example.invalid\n",
);
const baseEnv: NodeJS.ProcessEnv = {
  PATH: process.env.PATH,
  HOME: home,
  LANG: "C.UTF-8",
  npm_config_cache: join(work, "npm-cache"),
  npm_config_update_notifier: "false",
  GITHUB_REPOSITORY: "McAvity/srd-table",
  SITE_URL: "https://mcavity.github.io/srd-table/",
  BASE: "/srd-table/",
};

const log: { step: string; command: string; exit: number | null; ms: number; tail?: string }[] = [];
function run(
  step: string,
  cmd: string,
  args: string[],
  o: { cwd?: string; env?: NodeJS.ProcessEnv; expectFail?: boolean } = {},
) {
  const t = Date.now();
  return new Promise<string>((done, failed) => {
    const child = spawn(cmd, args, { cwd: o.cwd ?? work, env: { ...baseEnv, ...o.env } });
    let out = "";
    let err = "";
    child.stdout.on("data", (b) => {
      out += b;
    });
    child.stderr.on("data", (b) => {
      err += b;
    });
    child.on("close", (code) => {
      const tail = `${out}\n${err}`.trim().split("\n").slice(-6).join("\n");
      log.push({
        step,
        command: [cmd, ...args].join(" ").replaceAll(work, "$WORK"),
        exit: code,
        ms: Date.now() - t,
        tail: tail.replaceAll(work, "$WORK"),
      });
      writeFileSync(
        join(work, `log-${log.length}-${step.replace(/\W+/g, "_")}.txt`),
        `${out}\n--- stderr\n${err}`,
      );
      if ((code === 0) !== !o.expectFail) failed(new Error(`${step}: exit ${code}\n${tail}`));
      else done(out);
    });
  });
}
function walk(dir: string): string[] {
  const out: string[] = [];
  const go = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) go(p);
      else out.push(p.slice(work.length + 1));
    }
  };
  go(dir);
  return out;
}
const lastJson = (out: string) =>
  JSON.parse(
    out
      .trim()
      .split("\n")
      .filter((l) => l.startsWith("{"))
      .pop() ?? "{}",
  );

// the FAKE Pages host: a directory served over HTTP under the base, no dotfiles
const live = join(work, "pages-live");
mkdirSync(live);
const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
  if (!path.startsWith("/srd-table/")) return void res.writeHead(404).end();
  const rel = path.slice("/srd-table/".length) || "index.html";
  const file = join(live, rel);
  if (
    rel.split("/").some((s) => s.startsWith(".") || !s) ||
    !existsSync(file) ||
    statSync(file).isDirectory()
  )
    return void res.writeHead(404).end();
  res.writeHead(200, { "cache-control": "max-age=600" }).end(readFileSync(file));
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const smokeUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/srd-table/`;
const deployTar = (tar: string) => {
  deployedCount++;
  rmSync(live, { recursive: true, force: true });
  mkdirSync(live);
  for (const e of readTar(readFileSync(tar))) {
    const p = join(live, e.name.slice(2));
    if (e.type === "dir") mkdirSync(p, { recursive: true });
    else writeFileSync(p, e.bytes);
  }
};
const RULES = {
  pagesState: { deletion: true, nonFastForward: true },
  tags: { update: true, deletion: true },
  workflowBypass: false,
};
/** Stated facts for a step; the deployment count is the fake host's (every deployment so far). */
let deployedCount = 0;
const factsFile = (name: string, deployments: { everSucceeded: boolean; candidate: string }) => {
  const f = join(work, `facts-${name}.json`);
  writeFileSync(
    f,
    JSON.stringify({
      rulesets: RULES,
      deployments: { ...deployments, deployments: deployedCount },
      stated: "dry run: stated facts, not the GitHub API",
    }),
  );
  return f;
};

const report: Record<string, unknown> = {
  fake: "pages-state = local bare repository; Pages = local HTTP directory; facts stated; GitHub not used",
};
try {
  // ── checkouts: fresh clones (what actions/checkout does), the tools = main ──
  const tableCommit = need("table-commit");
  await run("clone tools (main)", "git", [
    "clone",
    "--quiet",
    "--no-local",
    need("table-repo"),
    join(ws, "tools"),
  ]);
  await run("checkout tools", "git", [
    "-C",
    join(ws, "tools"),
    "checkout",
    "--quiet",
    "--detach",
    tableCommit,
  ]);
  // the tags exist only in this local clone (never pushed)
  await run("tag rc.1 (local)", "git", [
    "-C",
    join(ws, "tools"),
    "tag",
    "-a",
    "v0.2.0-rc.1",
    "-m",
    "dry run",
    tableCommit,
  ]);
  await run("tag final (local)", "git", [
    "-C",
    join(ws, "tools"),
    "tag",
    "-a",
    "v0.2.0",
    "-m",
    "dry run",
    tableCommit,
  ]);
  const tools = join(ws, "tools");
  const ci = join(tools, "scripts/ci/pages-ci.ts");

  // ── refused inputs (prepare job) ──
  for (const [tag, code] of [
    ["v0.2", "input_invalid"],
    ["v0.3.0", "tag_missing"],
    ["v0.2.0;id", "input_invalid"],
  ] as const) {
    await run(
      `resolve refuses ${tag}`,
      "bun",
      [
        ci,
        "resolve",
        "--mode",
        "publish",
        "--tag",
        tag,
        "--repo-dir",
        tools,
        "--main",
        tableCommit,
      ],
      { expectFail: true },
    );
    const tail = log[log.length - 1]?.tail ?? "";
    if (!tail.includes(code)) throw new Error(`resolve ${tag}: expected ${code}, got ${tail}`);
    report[`refused ${tag}`] = code;
  }
  await run("side commit (local)", "git", [
    "-C",
    tools,
    "commit",
    "--quiet",
    "--allow-empty",
    "-m",
    "not on main",
  ]);
  await run("tag off main (local)", "git", ["-C", tools, "tag", "v0.9.0"]);
  await run(
    "resolve refuses a tag off main",
    "bun",
    [
      ci,
      "resolve",
      "--mode",
      "publish",
      "--tag",
      "v0.9.0",
      "--repo-dir",
      tools,
      "--main",
      tableCommit,
    ],
    { expectFail: true },
  );
  await run("back to main", "git", ["-C", tools, "checkout", "--quiet", "--detach", tableCommit]);

  const runs: Record<string, unknown>[] = [];
  let anchor = "";
  let builds = 0;
  const ghRun = async (
    n: number,
    mode: string,
    tag: string,
    deployments: { everSucceeded: boolean; candidate: string },
    opts: { faultAfterCheckpoint?: boolean } = {},
  ) => {
    const tmp = join(work, `run-${n}-tmp`);
    mkdirSync(tmp);
    const out = join(tmp, "github-output");
    writeFileSync(out, "");
    const r = lastJson(
      await run(
        `run ${n}: prepare ${mode} ${tag}`,
        "bun",
        [ci, "resolve", "--mode", mode, "--tag", tag, "--repo-dir", tools, "--main", tableCommit],
        { env: { GITHUB_OUTPUT: out } },
      ),
    );
    const env = {
      RUNNER_TEMP: tmp,
      GITHUB_WORKSPACE: ws,
      GITHUB_OUTPUT: out,
      GITHUB_RUN_ID: String(9000 + n),
      TOOLS: tools,
      REMOTE: join(work, "pages-state.git"),
      LIVE_DIR: live,
      MODE: mode,
      TAG: tag,
      VERSION: r.version,
      TAG_COMMIT: r.tag_commit,
      ANCHOR: anchor,
    };
    if (mode === "publish") {
      // build job: the tag's commit and the pinned engine, fresh clones
      const build = join(work, `run-${n}-build`);
      await run(`run ${n}: clone table at the tag`, "git", [
        "clone",
        "--quiet",
        "--no-local",
        need("table-repo"),
        join(build, "srd-table"),
      ]);
      await run(`run ${n}: checkout`, "git", [
        "-C",
        join(build, "srd-table"),
        "checkout",
        "--quiet",
        "--detach",
        r.tag_commit,
      ]);
      await run(`run ${n}: clone engine at the pin`, "git", [
        "clone",
        "--quiet",
        need("engine-repo"),
        join(build, "srd-rules-engine-main"),
      ]);
      await run(`run ${n}: checkout pin`, "git", [
        "-C",
        join(build, "srd-rules-engine-main"),
        "checkout",
        "--quiet",
        "--detach",
        r.engine_commit,
      ]);
      const args = [
        join(build, "srd-table/scripts/ci/build.sh"),
        join(build, "srd-table"),
        "--app-version",
        r.version,
        "--out",
        join(tmp, "candidate/release"),
        "--report",
        join(tmp, "release-report.json"),
      ];
      // the full checks (lint, typecheck, Vitest) in the first build; the second repeats the release
      if (values["skip-tests"] || builds++ > 0) args.push("--skip-tests");
      await run(`run ${n}: build.sh`, "bash", args);
      cpSync(join(build, "srd-rules-engine-main/dist/srd-5.2.1"), join(tmp, "candidate/srd"), {
        recursive: true,
      });
      report[`release ${r.version}`] = JSON.parse(
        readFileSync(join(tmp, "release-report.json"), "utf8"),
      ).release_id;
    }
    // state job
    const stateEnv = { ...env, FACTS: factsFile(`${n}-state`, deployments) };
    if (opts.faultAfterCheckpoint) {
      // the runner is lost after the checkpoint push (before the artifact upload): simulated by
      // running only the publisher's publish step, then dropping this run's local files
      await run(`run ${n}: state (checkpoint, then the runner is lost)`, "bun", [
        join(tools, "scripts/publish/cli.ts"),
        "publish",
        "--remote",
        env.REMOTE,
        "--work",
        join(tmp, "work-state"),
        "--facts",
        stateEnv.FACTS,
        "--live-dir",
        live,
        "--anchor",
        anchor,
        "--version",
        r.version,
        "--tag-commit",
        r.tag_commit,
        "--release",
        join(tmp, "candidate/release"),
        "--srd",
        join(tmp, "candidate/srd"),
        "--site-out",
        join(tmp, "site"),
      ]);
      rmSync(tmp, { recursive: true });
      runs.push({ run: n, mode, tag, lost_after_checkpoint: true });
      return null;
    }
    const st = await run(
      `run ${n}: state-op.sh ${mode}`,
      "bash",
      [join(tools, "scripts/ci/state-op.sh")],
      { env: stateEnv },
    );
    if (mode === "initialize") anchor = lastJson(st).anchor;
    const outputs = Object.fromEntries(
      readFileSync(out, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => l.split("=") as [string, string]),
    );
    runs.push({
      run: n,
      mode,
      tag,
      outputs: { deploy: outputs.deploy, artifact_sha256: outputs.artifact_sha256 },
    });
    if (outputs.deploy !== "true") return outputs;
    // deploy job (fake Pages), then the receipt job with the downloaded artifact
    const tar = join(tmp, "pages/artifact.tar");
    deployTar(tar);
    mkdirSync(join(tmp, "deployed"));
    cpSync(tar, join(tmp, "deployed/artifact.tar"));
    await run(`run ${n}: receipt.sh`, "bash", [join(tools, "scripts/ci/receipt.sh")], {
      env: {
        ...env,
        FACTS: factsFile(`${n}-receipt`, { everSucceeded: true, candidate: "success" }),
        PAGE_URL: "https://mcavity.github.io/srd-table/",
        ARTIFACT_SHA256: outputs.artifact_sha256,
        SMOKE_URL: smokeUrl,
        SMOKE_ROUNDS: "2",
        SMOKE_DELAY_MS: "200",
      },
    });
    return outputs;
  };

  await run("pages-state remote (local bare)", "git", [
    "init",
    "--quiet",
    "--bare",
    join(work, "pages-state.git"),
  ]);
  await ghRun(1, "initialize", "", { everSucceeded: false, candidate: "none" });
  report.anchor = anchor;
  const rc = await ghRun(2, "publish", "v0.2.0-rc.1", { everSucceeded: false, candidate: "none" });
  await ghRun(
    3,
    "publish",
    "v0.2.0",
    { everSucceeded: true, candidate: "none" },
    { faultAfterCheckpoint: true },
  );
  // a new run retries the pending 0.2.0: the archived bytes, packed, deployed, received
  const retried = await ghRun(4, "retry", "v0.2.0", { everSucceeded: true, candidate: "none" });
  const again = await ghRun(5, "retry", "v0.2.0", { everSucceeded: true, candidate: "none" });
  const older = await ghRun(6, "retry", "v0.2.0-rc.1", { everSucceeded: true, candidate: "none" });
  // a resolve with nothing pending is refused
  mkdirSync(join(work, "run-7-tmp"));
  await run(
    "run 7: resolve with nothing pending (refused)",
    "bash",
    [join(tools, "scripts/ci/state-op.sh")],
    {
      expectFail: true,
      env: {
        RUNNER_TEMP: join(work, "run-7-tmp"),
        GITHUB_WORKSPACE: ws,
        TOOLS: tools,
        REMOTE: join(work, "pages-state.git"),
        LIVE_DIR: live,
        MODE: "resolve",
        TAG: "v0.2.0",
        VERSION: "0.2.0",
        ANCHOR: anchor,
        FACTS: factsFile("7", { everSucceeded: true, candidate: "none" }),
      },
    },
  );
  const pointer = JSON.parse(readFileSync(join(live, "release.json"), "utf8"));
  Object.assign(report, {
    runs,
    rc_artifact_sha256: rc?.artifact_sha256,
    retry_artifact_sha256: retried?.artifact_sha256,
    retry_already_deployed: again,
    retry_historical: older,
    live_pointer: pointer.release_id,
    live_files: Object.keys(
      Object.fromEntries(
        readTar(readFileSync(join(work, "run-4-tmp/pages/artifact.tar"))).map((e) => [e.name, 1]),
      ),
    ).length,
    parent_canary_planted: existsSync(join(ws, "parent-canary.json")),
    // nothing of the parent workspace in this machine-like directory (paths), checked here
    dnd5_paths_in_work: walk(work).filter((p) => /dnd5/i.test(p)),
  });
} finally {
  server.close();
  report.steps = log;
  if (values.report)
    writeFileSync(resolvePath(values.report), `${JSON.stringify(report, null, 2)}\n`);
  appendFileSync(join(work, "dry-run-report.json"), `${JSON.stringify(report, null, 2)}\n`);
}
console.log(
  JSON.stringify({ ok: true, report: values.report ?? join(work, "dry-run-report.json") }),
);
