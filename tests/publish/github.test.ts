// @vitest-environment node
// kenli F-014 T03: the GitHub facts adapter over a FAKE REST API whose responses have the shapes
// observed with real read-only calls (2026-11-03: rules/branches, rulesets, deployments + statuses
// with log_url …/actions/runs/<run>/job/<job>, workflow runs with display_title). No network.

import { describe, expect, it } from "vitest";
import {
  aggregate,
  deploymentFacts,
  GithubError,
  refMatches,
  rulesetFacts,
  runOfStatus,
} from "../../scripts/publish/github";

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

  it("a ruleset not saying `never` counts as a bypass; tag patterns are matched, not assumed", async () => {
    const { o } = fakeApi({
      [`${R}/rules/branches/pages-state`]: [],
      [`${R}/rulesets`]: [{ id: 12, target: "tag", enforcement: "active" }],
      [`${R}/rulesets/12`]: {
        id: 12,
        target: "tag",
        enforcement: "active",
        conditions: { ref_name: { include: ["refs/tags/release-*"], exclude: [] } },
        rules: [{ type: "update" }, { type: "deletion" }],
      },
    });
    const f = await rulesetFacts(o);
    expect(f.tags).toEqual({ update: false, deletion: false });
    expect(refMatches("refs/tags/v*", "refs/tags/v0.2.0-rc.1")).toBe(true);
    expect(refMatches("refs/tags/v*", "refs/heads/v1")).toBe(false);
    expect(refMatches("~DEFAULT_BRANCH", "refs/tags/v1")).toBe(false);
    expect(refMatches("refs/**", "refs/tags/v1")).toBe(true);
  });

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

  it("aggregate: inactive alone is not a failure of a success; unknown states are not terminal", () => {
    expect(aggregate([])).toBe("none");
    expect(aggregate([[{ state: "inactive" }]])).toBe("inactive");
    expect(aggregate([[{ state: "inactive" }, { state: "success" }]])).toBe("success");
    expect(aggregate([[{ state: "brand_new_state" }]])).toBe("pending");
    expect(aggregate([[{ state: "cancelled" }], [{ state: "waiting" }]])).toBe("waiting");
    expect(
      runOfStatus({ state: "x", log_url: "https://github.com/o/r/actions/runs/123/job/4" }),
    ).toBe(123);
    expect(
      runOfStatus({ state: "x", log_url: null, target_url: "https://example.invalid/x" }),
    ).toBeNull();
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
    expect(f).toMatchObject({ deployments_read: 2, candidate: "success" });
    const broken = fakeApi({ [`${R}/deployments`]: () => ({ body: {}, status: 502 }) });
    await expect(
      deploymentFacts(broken.o, { workflow: "pages-release.yml", tag: "v0.2.0" }),
    ).rejects.toBeInstanceOf(GithubError);
  });
});
