// @vitest-environment node
// kenli F-014 T03: the GitHub facts adapter over a FAKE REST API whose responses have the shapes
// observed with real read-only calls (2026-11-03: rules/branches, rulesets, deployments + statuses
// with log_url …/actions/runs/<run>/job/<job>, workflow runs with display_title). No network.

import { describe, expect, it } from "vitest";
import {
  deploymentFacts,
  deploymentState,
  GithubError,
  rulesetFacts,
  runOfStatus,
} from "../../scripts/publish/github";
import { candidateSince } from "../../scripts/publish/witness";

type Routes = Record<
  string,
  unknown | ((url: URL) => { body: unknown; link?: string; status?: number })
>;
function fakeApi(routes: Routes) {
  const seen: string[] = [];
  const fetcher = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    seen.push(`${url.pathname}${url.search}`);
    expect((init?.headers as Record<string, string> | undefined)?.authorization).toBe(
      "Bearer t0ken",
    );
    const key = Object.keys(routes).find((k) => url.pathname === k);
    if (!key) return new Response("{}", { status: 404 });
    const r = routes[key];
    const out =
      typeof r === "function"
        ? (r as (u: URL) => { body: unknown; link?: string; status?: number })(url)
        : { body: r };
    return new Response(JSON.stringify(out.body), {
      status: out.status ?? 200,
      headers: out.link ? { link: out.link } : {},
    });
  }) as typeof fetch;
  return {
    fetcher,
    seen,
    o: { repo: "McAvity/srd-table", token: "t0ken", api: "https://api.test", fetcher },
  };
}
const R = "/repos/McAvity/srd-table";
const status = (state: string, run: number) => ({
  state,
  log_url: `https://github.com/McAvity/srd-table/actions/runs/${run}/job/9${run}`,
  target_url: `https://github.com/McAvity/srd-table/actions/runs/${run}/job/9${run}`,
  environment_url: state === "success" ? "https://mcavity.github.io/srd-table/" : "",
  created_at: "2026-11-03T12:00:00Z",
});

describe("rulesets", () => {
  it("pages-state and v* tag rules from active rulesets, no workflow bypass", async () => {
    const { o } = fakeApi({
      [`${R}/rules/branches/pages-state`]: [
        {
          type: "deletion",
          ruleset_source_type: "Repository",
          ruleset_source: "McAvity/srd-table",
          ruleset_id: 11,
        },
        {
          type: "non_fast_forward",
          ruleset_source_type: "Repository",
          ruleset_source: "McAvity/srd-table",
          ruleset_id: 11,
        },
      ],
      [`${R}/rulesets`]: [
        { id: 12, name: "tags", target: "tag", enforcement: "active", source_type: "Repository" },
        {
          id: 13,
          name: "draft",
          target: "tag",
          enforcement: "evaluate",
          source_type: "Repository",
        },
      ],
      [`${R}/rulesets/11`]: {
        id: 11,
        target: "branch",
        enforcement: "active",
        current_user_can_bypass: "never",
      },
      [`${R}/rulesets/12`]: {
        id: 12,
        target: "tag",
        enforcement: "active",
        conditions: { ref_name: { include: ["refs/tags/v*"], exclude: [] } },
        rules: [{ type: "update" }, { type: "deletion" }],
        current_user_can_bypass: "never",
      },
    });
    expect(await rulesetFacts(o)).toEqual({
      pagesState: { deletion: true, nonFastForward: true },
      tags: { update: true, deletion: true },
      workflowBypass: false,
    });
  });

  it("missing rules, an evaluate-only tag ruleset, or a bypass the token has: reported as such", async () => {
    const { o } = fakeApi({
      [`${R}/rules/branches/pages-state`]: [{ type: "deletion", ruleset_id: 11 }],
      [`${R}/rulesets`]: [{ id: 12, target: "tag", enforcement: "active" }],
      [`${R}/rulesets/11`]: { id: 11, enforcement: "active", current_user_can_bypass: "always" },
      [`${R}/rulesets/12`]: {
        id: 12,
        target: "tag",
        enforcement: "evaluate",
        conditions: { ref_name: { include: ["~ALL"], exclude: [] } },
        rules: [{ type: "update" }, { type: "deletion" }],
      },
    });
    expect(await rulesetFacts(o)).toEqual({
      pagesState: { deletion: true, nonFastForward: false },
      tags: { update: false, deletion: false },
      workflowBypass: true,
    });
  });

  // R04-02: only a ruleset covering the whole release tag space counts, never one sample tag
  const tagApi = (include: string[], exclude: string[] = [], bypass: string | null = "never") =>
    fakeApi({
      [`${R}/rules/branches/pages-state`]: [],
      [`${R}/rulesets`]: [{ id: 12, target: "tag", enforcement: "active" }],
      [`${R}/rulesets/12`]: {
        id: 12,
        target: "tag",
        enforcement: "active",
        conditions: { ref_name: { include, exclude } },
        rules: [{ type: "update" }, { type: "deletion" }],
        ...(bypass === null ? {} : { current_user_can_bypass: bypass }),
      },
    }).o;
  it.each([
    ["refs/tags/v0.0.0 only (a sample tag)", ["refs/tags/v0.0.0"], []],
    ["refs/tags/v0.2.0 only (the current release)", ["refs/tags/v0.2.0"], []],
    ["v* minus an older release", ["refs/tags/v*"], ["refs/tags/v0.1.*"]],
    ["v* minus the current release", ["refs/tags/v*"], ["refs/tags/v0.2.0"]],
    ["another namespace", ["refs/tags/release-*"], []],
    ["a pattern not in the operator's instructions", ["refs/tags/v**"], []],
  ])("tag protection of %s is not protection of the releases", async (_, include, exclude) => {
    expect((await rulesetFacts(tagApi(include, exclude))).tags).toEqual({
      update: false,
      deletion: false,
    });
  });
  it.each([["refs/tags/v*"], ["~ALL"]])(
    "%s without exclusion protects every release tag",
    async (p) => {
      const f = await rulesetFacts(tagApi([p]));
      expect(f.tags).toEqual({ update: true, deletion: true });
      expect(f.workflowBypass).toBe(false);
      expect((await rulesetFacts(tagApi([p], [], "always"))).workflowBypass).toBe(true);
      expect((await rulesetFacts(tagApi([p], [], null))).workflowBypass).toBe(true);
    },
  );

  it("any failed read is no fact (throws)", async () => {
    const { o } = fakeApi({
      [`${R}/rules/branches/pages-state`]: () => ({ body: { message: "x" }, status: 403 }),
    });
    await expect(rulesetFacts(o)).rejects.toBeInstanceOf(GithubError);
  });
});

describe("deployments: correlation by run, aggregation (§6)", () => {
  // rc.1 and 0.2.0 published from the same main SHA: only the run tells them apart
  const runs = {
    workflow_runs: [
      {
        id: 501,
        display_title: "pages publish v0.2.0-rc.1",
        event: "workflow_dispatch",
        path: ".github/workflows/pages-release.yml",
      },
      { id: 502, display_title: "pages publish v0.2.0", event: "workflow_dispatch" },
      { id: 503, display_title: "pages retry v0.2.0", event: "workflow_dispatch" },
      { id: 504, display_title: "pages resolve v0.2.0", event: "workflow_dispatch" },
    ],
  };
  const api = (statuses: Record<number, unknown[]>, extra: Routes = {}) =>
    fakeApi({
      [`${R}/deployments`]: Object.keys(statuses).map((id) => ({
        id: Number(id),
        sha: "a".repeat(40),
        ref: "main",
        task: "deploy",
        environment: "github-pages",
      })),
      [`${R}/actions/workflows/pages-release.yml/runs`]: runs,
      ...Object.fromEntries(
        Object.entries(statuses).map(([id, ss]) => [`${R}/deployments/${id}/statuses`, ss]),
      ),
      ...extra,
    });

  it("an earlier success, later inactive, is remembered; the candidate is its runs' deployments", async () => {
    const { o, seen } = api({
      1: [
        status("inactive", 501),
        status("success", 501),
        status("in_progress", 501),
        status("queued", 501),
      ],
      2: [status("in_progress", 502), status("queued", 502), status("waiting", 502)],
    });
    const f = await deploymentFacts(o, { workflow: "pages-release.yml", tag: "v0.2.0" });
    expect(f).toMatchObject({
      everSucceeded: true,
      candidate: "in_progress",
      candidate_runs: [502, 503],
    });
    expect(seen.some((u) => u.includes("environment=github-pages"))).toBe(true);
    expect(seen.some((u) => u.includes("event=workflow_dispatch"))).toBe(true);
    // rc.1's own deployment: success, although the latest status is inactive
    const rc = await deploymentFacts(o, { workflow: "pages-release.yml", tag: "v0.2.0-rc.1" });
    expect(rc.candidate).toBe("success");
  });

  it("failure of one attempt and success of a retry → success; only failures → failure; none", async () => {
    const both = api({
      2: [status("failure", 502), status("in_progress", 502)],
      3: [status("success", 503), status("in_progress", 503)],
    });
    expect(
      (await deploymentFacts(both.o, { workflow: "pages-release.yml", tag: "v0.2.0" })).candidate,
    ).toBe("success");
    const failed = api({ 2: [status("failure", 502)], 3: [status("error", 503)] });
    expect(
      (await deploymentFacts(failed.o, { workflow: "pages-release.yml", tag: "v0.2.0" })).candidate,
    ).toBe("failure");
    const none = api({ 1: [status("success", 501)] });
    const f = await deploymentFacts(none.o, { workflow: "pages-release.yml", tag: "v0.2.0" });
    expect(f).toMatchObject({ everSucceeded: true, candidate: "none" });
    // the current run counts even before the runs list shows it
    const current = api({ 7: [status("success", 777)] });
    expect(
      (
        await deploymentFacts(current.o, {
          workflow: "pages-release.yml",
          tag: "v0.2.0",
          extraRuns: [777],
        })
      ).candidate,
    ).toBe("success");
  });

  it("one deployment's state: success if any retained; inactive only, none or unknown → unknown", () => {
    expect(deploymentState([])).toBe("unknown");
    expect(deploymentState([{ state: "inactive" }])).toBe("unknown");
    expect(deploymentState([{ state: "inactive" }, { state: "success" }])).toBe("success");
    expect(deploymentState([{ state: "brand_new_state" }])).toBe("unknown");
    expect(deploymentState([{ state: "cancelled" }])).toBe("cancelled");
    expect(deploymentState([{ state: "waiting" }, { state: "queued" }])).toBe("waiting");
    const repo = "McAvity/srd-table";
    expect(
      runOfStatus(
        { state: "x", log_url: "https://github.com/McAvity/srd-table/actions/runs/123/job/4" },
        repo,
      ),
    ).toBe(123);
    expect(
      runOfStatus(
        { state: "x", log_url: "https://github.com/someone/else/actions/runs/123/job/4" },
        repo,
      ),
    ).toBeNull();
    expect(
      runOfStatus({ state: "x", log_url: null, target_url: "https://example.invalid/x" }, repo),
    ).toBeNull();
  });

  // R04-01 (manager repro evidence/T03/manager/api-repro.json): an existing deployment the adapter
  // can't tie to a run is not "none"; a deployment with only `inactive` left is not a failure
  it.each([
    ["in_progress, no log/target URL", [{ state: "in_progress" }]],
    ["no status at all", []],
    [
      "another repository's run URL",
      [{ state: "failure", log_url: "https://github.com/o/r/actions/runs/502/job/1" }],
    ],
  ])("an untied deployment (%s) makes the candidate unknown", async (_, statuses) => {
    const { o } = api({ 9: statuses });
    const f = await deploymentFacts(o, { workflow: "pages-release.yml", tag: "v0.2.0" });
    expect(f.candidate).toBe("unknown");
    expect(f.deployments).toBe(1);
    expect(f.records).toEqual([
      { created_at: "", run: null, state: expect.any(String), candidate: false },
    ]);
  });
  it("a deployment with statuses of two different runs is not tied to either", async () => {
    const { o } = api({ 9: [status("failure", 502), status("in_progress", 501)] });
    expect(
      (await deploymentFacts(o, { workflow: "pages-release.yml", tag: "v0.2.0" })).candidate,
    ).toBe("unknown");
  });
  it("inactive after retention plus a failure: unknown, not failure", async () => {
    const { o } = api({ 2: [status("inactive", 502)], 3: [status("failure", 503)] });
    const f = await deploymentFacts(o, { workflow: "pages-release.yml", tag: "v0.2.0" });
    expect(f).toMatchObject({ everSucceeded: false, deployments: 2, candidate: "unknown" });
  });
  it("candidateSince: deployments before the checkpoint can't be the candidate's", () => {
    const old = {
      created_at: "2026-01-01T00:00:00Z",
      run: null,
      state: "unknown" as const,
      candidate: false,
    };
    const fresh = {
      created_at: "2026-11-03T12:00:00Z",
      run: 9,
      state: "failure" as const,
      candidate: true,
    };
    const since = Date.parse("2026-11-03T11:00:00Z");
    expect(candidateSince([old, fresh], since)).toBe("failure");
    expect(candidateSince([old], since)).toBe("none");
    expect(candidateSince([old], Number.NEGATIVE_INFINITY)).toBe("unknown");
    expect(candidateSince([{ ...old, created_at: "2026-11-03T12:05:00Z" }, fresh], since)).toBe(
      "unknown",
    );
    expect(
      candidateSince(
        [
          { ...fresh, state: "success" },
          { ...old, created_at: "2026-11-03T12:05:00Z" },
        ],
        since,
      ),
    ).toBe("success");
    expect(candidateSince([{ ...fresh, state: "inactive" }], since)).toBe("unknown");
  });

  it("all pages are read (Link rel=next); more than the limit or an error is no fact", async () => {
    const { o } = fakeApi({
      [`${R}/deployments`]: (u: URL) =>
        u.searchParams.get("page") === "2"
          ? { body: [{ id: 2, environment: "github-pages" }] }
          : {
              body: [{ id: 1, environment: "github-pages" }],
              link: `<https://api.test${R}/deployments?environment=github-pages&per_page=100&page=2>; rel="next"`,
            },
      [`${R}/deployments/1/statuses`]: [status("success", 501)],
      [`${R}/deployments/2/statuses`]: [status("success", 502)],
      [`${R}/actions/workflows/pages-release.yml/runs`]: runs,
    });
    const f = await deploymentFacts(o, { workflow: "pages-release.yml", tag: "v0.2.0" });
    expect(f).toMatchObject({ deployments: 2, candidate: "success" });
    const broken = fakeApi({ [`${R}/deployments`]: () => ({ body: {}, status: 502 }) });
    await expect(
      deploymentFacts(broken.o, { workflow: "pages-release.yml", tag: "v0.2.0" }),
    ).rejects.toBeInstanceOf(GithubError);
  });
});
