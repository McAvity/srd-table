/**
 * kenli F-014 T03: the real GitHub facts for the publisher's witnesses (docs/deployment.md §6, §9.3),
 * read with the workflow's own token (no PAT): effective rulesets, github-pages deployments and
 * their statuses correlated to the pending version's workflow runs. Read-only REST GETs; any failed
 * read throws (no facts are invented: the witness refuses).
 *
 * Response shapes as observed with read-only calls (2026-11-03, see the T03 ledger):
 *  - GET /repos/{o}/{r}/rules/branches/{branch} → [{type, ruleset_source_type, ruleset_source,
 *    ruleset_id, parameters?}] (effective rules of active rulesets);
 *  - GET /repos/{o}/{r}/rulesets?includes_parents=true&targets=tag → [{id, name, target,
 *    enforcement, source_type}]; GET /repos/{o}/{r}/rulesets/{id} → {…, conditions:{ref_name:
 *    {include, exclude}}, rules:[{type}], current_user_can_bypass} (bypass_actors only for admins);
 *  - GET /repos/{o}/{r}/deployments?environment=github-pages → [{id, sha, ref, task: "deploy", …}];
 *    GET …/deployments/{id}/statuses → newest first [{state, log_url, target_url,
 *    environment_url, created_at}], log_url = https://github.com/{o}/{r}/actions/runs/{run}/job/{job};
 *  - GET /repos/{o}/{r}/actions/workflows/{file}/runs → {workflow_runs:[{id, display_title, event,
 *    head_branch, status, conclusion, path}]}; display_title is the workflow's `run-name`.
 */
import type { DeploymentFacts, DeploymentState, RulesetFacts } from "./witness";

export interface GithubOptions {
  /** `owner/repo`. */
  readonly repo: string;
  readonly token: string;
  /** GITHUB_API_URL (default https://api.github.com). */
  readonly api?: string;
  readonly fetcher?: typeof fetch;
}

export class GithubError extends Error {
  constructor(
    readonly url: string,
    readonly status: number,
  ) {
    super(`GitHub API ${status} for ${url}`);
    this.name = "GithubError";
  }
}

/** Every page of a list endpoint (Link rel="next"), up to `maxPages`; any non-2xx throws. */
async function getAll<T>(
  o: GithubOptions,
  path: string,
  pick?: (body: unknown) => T[],
  maxPages = 20,
): Promise<T[]> {
  const fetcher = o.fetcher ?? fetch;
  const base = (o.api ?? "https://api.github.com").replace(/\/$/, "");
  let url: string | null = `${base}${path}${path.includes("?") ? "&" : "?"}per_page=100`;
  const out: T[] = [];
  for (let page = 0; url && page < maxPages; page++) {
    const res: Response = await fetcher(url, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${o.token}`,
        "x-github-api-version": "2022-11-28",
      },
    });
    if (!res.ok) throw new GithubError(url, res.status);
    const body = (await res.json()) as unknown;
    out.push(...(pick ? pick(body) : (body as T[])));
    const next = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get("link") ?? "");
    url = next ? (next[1] as string) : null;
  }
  if (url) throw new GithubError(url, 0); // more pages than we read: not a complete fact
  return out;
}
async function getOne<T>(o: GithubOptions, path: string): Promise<T> {
  const fetcher = o.fetcher ?? fetch;
  const url = `${(o.api ?? "https://api.github.com").replace(/\/$/, "")}${path}`;
  const res = await fetcher(url, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${o.token}`,
      "x-github-api-version": "2022-11-28",
    },
  });
  if (!res.ok) throw new GithubError(url, res.status);
  return (await res.json()) as T;
}

interface EffectiveRule {
  readonly type: string;
  readonly ruleset_id?: number;
}
interface Ruleset {
  readonly id: number;
  readonly target: string;
  readonly enforcement: string;
  readonly conditions?: {
    readonly ref_name?: { readonly include?: string[]; readonly exclude?: string[] };
  };
  readonly rules?: readonly { readonly type: string }[];
  readonly current_user_can_bypass?: string;
}

/**
 * A ruleset ref pattern (fnmatch-style as GitHub shows them: `refs/tags/v*`, `~ALL`): `*` any run
 * of characters but `/`, `**` any run, `?` one character. Unknown syntax never matches.
 */
export function refMatches(pattern: string, ref: string): boolean {
  if (pattern === "~ALL") return true;
  if (pattern.startsWith("~")) return false; // ~DEFAULT_BRANCH and others: not a tag/our branch
  let re = "^";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i] as string;
    if (c === "*" && pattern[i + 1] === "*") {
      re += ".*";
      i++;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else if (/[\\^$.|+()[\]{}]/.test(c)) re += `\\${c}`;
    else re += c;
  }
  return new RegExp(`${re}$`).test(ref);
}

/**
 * The rules protecting `pages-state` and `v*` tags as the workflow's token sees them. A rule counts
 * only from an active ruleset; the workflow may bypass when any such ruleset says
 * `current_user_can_bypass` other than `never` (or doesn't say). The full configuration (bypass
 * actors) is confirmed by the operator (R02-02, T05).
 */
export async function rulesetFacts(
  o: GithubOptions,
  branch = "pages-state",
  sampleTag = "refs/tags/v0.0.0",
): Promise<RulesetFacts> {
  const [owner, name] = o.repo.split("/");
  const rules = await getAll<EffectiveRule>(
    o,
    `/repos/${owner}/${name}/rules/branches/${encodeURIComponent(branch)}`,
  );
  const branchTypes = new Set(rules.map((r) => r.type));
  const tagSets = await getAll<Ruleset>(
    o,
    `/repos/${owner}/${name}/rulesets?includes_parents=true&targets=tag`,
  );
  const tagTypes = new Set<string>();
  const used = new Set<number>(
    rules.map((r) => r.ruleset_id).filter((x): x is number => typeof x === "number"),
  );
  for (const s of tagSets) {
    if (s.target !== "tag" || s.enforcement !== "active") continue;
    const full = await getOne<Ruleset>(o, `/repos/${owner}/${name}/rulesets/${s.id}`);
    if (full.enforcement !== "active") continue;
    const inc = full.conditions?.ref_name?.include ?? [];
    const exc = full.conditions?.ref_name?.exclude ?? [];
    if (!inc.some((p) => refMatches(p, sampleTag)) || exc.some((p) => refMatches(p, sampleTag)))
      continue;
    for (const r of full.rules ?? []) tagTypes.add(r.type);
    used.add(full.id);
  }
  let workflowBypass = false;
  for (const id of used) {
    const full = await getOne<Ruleset>(o, `/repos/${owner}/${name}/rulesets/${id}`);
    if (full.current_user_can_bypass !== "never") workflowBypass = true;
  }
  return {
    pagesState: {
      deletion: branchTypes.has("deletion"),
      nonFastForward: branchTypes.has("non_fast_forward"),
    },
    tags: { update: tagTypes.has("update"), deletion: tagTypes.has("deletion") },
    workflowBypass,
  };
}

interface Deployment {
  readonly id: number;
  readonly environment: string;
}
interface Status {
  readonly state: string;
  readonly log_url?: string | null;
  readonly target_url?: string | null;
}
interface Run {
  readonly id: number;
  readonly display_title: string;
  readonly path?: string;
}

const RUN_OF = /\/actions\/runs\/(\d+)(?:\/|$)/;
/** The workflow run a deployment status belongs to (its log/target URL), or `null`. */
export function runOfStatus(s: Status): number | null {
  const m = RUN_OF.exec(s.log_url ?? "") ?? RUN_OF.exec(s.target_url ?? "");
  return m ? Number(m[1]) : null;
}

const PROGRESS: readonly string[] = ["queued", "pending", "waiting", "in_progress"];
const TERMINAL_FAIL: readonly string[] = ["failure", "error", "cancelled"];
/**
 * §6 aggregation for one version's deployments (all statuses of all its deployments): `success` if
 * any ever succeeded (a later `inactive` included); else in progress if any deployment's latest
 * status is not terminal; else `failure`/`error`/`cancelled`; `none` without any deployment.
 * `inactive` alone never becomes a failure.
 */
export function aggregate(deployments: readonly (readonly Status[])[]): DeploymentState {
  if (deployments.length === 0) return "none";
  if (deployments.some((ss) => ss.some((s) => s.state === "success"))) return "success";
  const latest = deployments.map((ss) => ss[0]?.state ?? "pending"); // statuses are newest first
  const progress = latest.find((s) => PROGRESS.includes(s));
  if (progress) return progress as DeploymentState;
  // a state this adapter doesn't know is not a terminal fact: treated as still running
  if (latest.some((s) => !TERMINAL_FAIL.includes(s) && s !== "inactive")) return "pending";
  const fail = latest.find((s) => TERMINAL_FAIL.includes(s));
  return (fail ?? "inactive") as DeploymentState;
}

/** The run-name of pages-release.yml (`run-name: pages <mode> <tag>`). */
export const runTitle = (mode: string, tag: string) => `pages ${mode} ${tag}`;

/**
 * github-pages deployment facts. The candidate is `tag`'s publication: the deployments made by
 * the runs of `workflow` titled `pages publish <tag>` or `pages retry <tag>` (plus `extraRuns`, the
 * current run), matched by the run in each status's log URL. The deployment SHA is not used: the
 * workflow's SHA is main's, the same for 0.2.0-rc.1 and 0.2.0 built from one commit.
 */
export async function deploymentFacts(
  o: GithubOptions,
  opts: { workflow: string; tag: string | null; extraRuns?: readonly number[] },
): Promise<DeploymentFacts & { candidate_runs: number[]; deployments_read: number }> {
  const [owner, name] = o.repo.split("/");
  const deployments = await getAll<Deployment>(
    o,
    `/repos/${owner}/${name}/deployments?environment=github-pages`,
  );
  const candidateRuns = new Set<number>(opts.extraRuns ?? []);
  if (opts.tag) {
    const titles = new Set([runTitle("publish", opts.tag), runTitle("retry", opts.tag)]);
    const runs = await getAll<Run>(
      o,
      `/repos/${owner}/${name}/actions/workflows/${encodeURIComponent(opts.workflow)}/runs?event=workflow_dispatch`,
      (b) => (b as { workflow_runs: Run[] }).workflow_runs,
    );
    for (const r of runs) if (titles.has(r.display_title)) candidateRuns.add(r.id);
  }
  let everSucceeded = false;
  const candidate: Status[][] = [];
  for (const d of deployments) {
    if (d.environment !== "github-pages") continue;
    const statuses = await getAll<Status>(
      o,
      `/repos/${owner}/${name}/deployments/${d.id}/statuses`,
    );
    if (statuses.some((s) => s.state === "success")) everSucceeded = true;
    const run = statuses.map(runOfStatus).find((x) => x !== null) ?? null;
    if (run !== null && candidateRuns.has(run)) candidate.push(statuses);
  }
  return {
    everSucceeded,
    candidate: aggregate(candidate),
    candidate_runs: [...candidateRuns].sort((a, b) => a - b),
    deployments_read: deployments.length,
  };
}
