// @vitest-environment node
// kenli F-014 T04, R04-01 (D014-003): the real facts adapter (scripts/publish/github.ts, over a FAKE
// REST API with the shapes observed in T03) as the archive's deployment witness, on a real local bare
// Git archive. Untied, expired or unknown deployment evidence never becomes "no deployment"; old
// statuses expiring never blocks a legitimate archive; a lost archive with deployments never
// bootstraps.

import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Archive, initialize, receipt, resolve, stage } from "../../scripts/publish/archive";
import { deploymentFacts } from "../../scripts/publish/github";
import type { Witnesses } from "../../scripts/publish/witness";
import {
  BASE,
  bareRepo,
  FakePages,
  git,
  makeRelease,
  makeSrd,
  OK_RULES,
  type Rel,
  refused,
  remoteHead,
  SITE_URL,
  tmp,
  tree,
} from "./helpers";

const R = "/repos/McAvity/srd-table";
const SRD = makeSrd();
interface Dep {
  id: number;
  created_at: string;
  statuses: { state: string; log_url?: string | null; target_url?: string | null }[];
}
const runUrl = (run: number) =>
  `https://github.com/McAvity/srd-table/actions/runs/${run}/job/7${run}`;
const st = (state: string, run?: number) =>
  run ? { state, log_url: runUrl(run), target_url: runUrl(run) } : { state };

function world() {
  const deployments: Dep[] = [];
  const runs: { id: number; display_title: string }[] = [];
  const fetcher = (async (input: string | URL) => {
    const u = new URL(String(input));
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
    if (u.pathname === `${R}/deployments`)
      return json(
        deployments.map((d) => ({
          id: d.id,
          created_at: d.created_at,
          environment: "github-pages",
          task: "deploy",
          ref: "main",
        })),
      );
    const m = /\/deployments\/(\d+)\/statuses$/.exec(u.pathname);
    if (m) return json(deployments.find((d) => d.id === Number(m[1]))?.statuses ?? []);
    if (u.pathname === `${R}/actions/workflows/pages-release.yml/runs`)
      return json({ workflow_runs: runs });
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  const pages = new FakePages();
  let tag: string | null = null;
  const witnesses: Witnesses = {
    rulesets: async () => OK_RULES,
    deployments: () =>
      deploymentFacts(
        { repo: "McAvity/srd-table", token: "t", api: "https://api.test", fetcher },
        { workflow: "pages-release.yml", tag },
      ),
    live: (p) => pages.live(p),
  };
  return { deployments, runs, pages, witnesses, setTag: (t: string | null) => (tag = t) };
}

async function setup() {
  const w = world();
  const remote = bareRepo();
  const { anchor } = await initialize(
    { remote, workDir: join(tmp("w"), "c"), witnesses: w.witnesses },
    { base: BASE, siteUrl: SITE_URL },
  );
  const open = () =>
    Archive.open({ remote, workDir: join(tmp("w"), "c"), anchor, witnesses: w.witnesses });
  let nextRun = 500;
  let nextDep = 1;
  /** stage + export (a workflow run titled for the tag) → its run id and artifact. */
  const stageRel = async (rel: Rel) => {
    const tag = `v${rel.version}`;
    w.setTag(tag);
    const run = nextRun++;
    w.runs.push({ id: run, display_title: `pages publish ${tag}` });
    const a = await open();
    await stage(a, {
      version: rel.version as string,
      tagCommit: rel.commit,
      releaseDir: rel.dir,
      srdDir: SRD,
    });
    const artifact = join(tmp("art"), "site");
    a.exportSite(artifact);
    return { run, artifact };
  };
  /** the deploy job of that run: a github-pages deployment with these statuses (newest first). */
  const deployment = (statuses: Dep["statuses"], created_at = new Date().toISOString()) => {
    const d = { id: nextDep++, created_at, statuses };
    w.deployments.push(d);
    return d;
  };
  const ship = async (rel: Rel) => {
    const { run, artifact } = await stageRel(rel);
    w.pages.deploy(artifact);
    deployment([st("success", run), st("in_progress", run), st("queued", run)]);
    await receipt(await open(), rel.version as string, {
      run_id: String(run),
      page_url: SITE_URL,
      artifact_digest: "a".repeat(64),
    });
    return run;
  };
  return { ...w, remote, anchor, open, stageRel, deployment, ship };
}

describe("R04-01: adapter → archive", () => {
  it("an untied in-progress deployment (no run URL) is unknown: resolve refuses; told apart later: abandoned", async () => {
    const ctx = await setup();
    await ctx.ship(makeRelease("a", { version: "0.2.0" }));
    const liveA = tree(ctx.pages.liveDir);
    const { run } = await ctx.stageRel(makeRelease("b", { version: "0.3.0" }));
    const d = ctx.deployment([{ state: "in_progress" }]); // the manager's repro: no log/target URL
    const head = remoteHead(ctx.remote);
    await refused(async () => resolve(await ctx.open(), "0.3.0"), "deployment_unknown");
    expect(remoteHead(ctx.remote)).toBe(head);
    expect(tree(ctx.pages.liveDir)).toEqual(liveA);
    // a foreign repository's run URL is no better
    d.statuses = [
      { state: "failure", log_url: "https://github.com/someone/else/actions/runs/1/job/2" },
    ];
    await refused(async () => resolve(await ctx.open(), "0.3.0"), "deployment_unknown");
    // only `inactive` left (an old success may have expired): still unknown
    d.statuses = [st("inactive", run)];
    await refused(async () => resolve(await ctx.open(), "0.3.0"), "deployment_unknown");
    // its own run, in progress → wait
    d.statuses = [st("in_progress", run)];
    await refused(async () => resolve(await ctx.open(), "0.3.0"), "deployment_in_progress");
    // its own run, terminally failed, live the previous site → abandoned
    d.statuses = [st("failure", run), st("in_progress", run)];
    expect((await resolve(await ctx.open(), "0.3.0")).outcome).toBe("abandoned");
  });

  it("deployments from before the checkpoint (expired, untied) don't block resolving a pending version", async () => {
    const ctx = await setup();
    await ctx.ship(makeRelease("a", { version: "0.2.0" }));
    const first = ctx.deployments[0] as Dep;
    first.created_at = "2025-06-01T10:00:00Z";
    first.statuses = []; // statuses expired long ago
    await ctx.stageRel(makeRelease("b", { version: "0.3.0" }));
    // B's deployment never started: none since its checkpoint
    expect((await resolve(await ctx.open(), "0.3.0")).outcome).toBe("abandoned");
  });

  it("a long-lived archive after status retention: no success visible, stage and receipt still work", async () => {
    const ctx = await setup();
    await ctx.ship(makeRelease("a", { version: "0.2.0" }));
    const first = ctx.deployments[0] as Dep;
    first.created_at = "2025-06-01T10:00:00Z";
    first.statuses = [st("inactive", 500)]; // > 90 days: the success is gone, only inactive left
    const f = await ctx.witnesses.deployments();
    expect(f).toMatchObject({ everSucceeded: false, deployments: 1 });
    await ctx.ship(makeRelease("b", { version: "0.3.0" }));
    expect((await ctx.open()).state).toMatchObject({ served: "0.3.0", pending: null });
    // and the receipt needs the candidate's own success: none yet → refused, not assumed
    const { run } = await ctx.stageRel(makeRelease("c", { version: "0.4.0" }));
    ctx.pages.deploy((await ctx.open()).site);
    ctx.deployment([st("in_progress", run)]);
    await refused(
      async () =>
        receipt(await ctx.open(), "0.4.0", {
          run_id: String(run),
          page_url: SITE_URL,
          artifact_digest: "b".repeat(64),
        }),
      "not_deployed",
    );
  });

  it("a lost archive with deployments (no success visible) never bootstraps", async () => {
    const ctx = await setup();
    await ctx.ship(makeRelease("a", { version: "0.2.0" }));
    const first = ctx.deployments[0] as Dep;
    first.statuses = []; // expired: everSucceeded false, but the deployment exists
    // the branch reset to the empty anchor: refused, not a new site
    git(ctx.remote, "update-ref", "refs/heads/pages-state", ctx.anchor);
    await refused(() => ctx.stageRel(makeRelease("b", { version: "0.3.0" })), "history_lost");
    // the branch deleted, a new initialize: refused while github-pages has deployments
    git(ctx.remote, "update-ref", "-d", "refs/heads/pages-state");
    await refused(
      () =>
        initialize(
          { remote: ctx.remote, workDir: join(tmp("w"), "c"), witnesses: ctx.witnesses },
          { base: BASE, siteUrl: SITE_URL },
        ),
      "history_lost",
    );
    expect(remoteHead(ctx.remote)).toBeNull();
  });
});
