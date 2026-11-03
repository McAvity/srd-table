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
import {
  candidateSince,
  type DeploymentFacts,
  type DeploymentRecord,
  type DeploymentState,
  type RulesetFacts,
} from "./witness";

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
 * R04-02: the ref patterns that cover every release tag. Only these literal forms count — no
 * attempt at fnmatch semantics: the operator configures exactly one of them (docs/deployment.md
 * §10), with no exclusion.
 */
export const RELEASE_TAG_PATTERNS = ["refs/tags/v*", "~ALL"] as const;
export const coversReleaseTags = (r: Ruleset): boolean => {
  const inc = r.conditions?.ref_name?.include ?? [];
  const exc = r.conditions?.ref_name?.exclude ?? [];
  return (
    exc.length === 0 && inc.some((p) => (RELEASE_TAG_PATTERNS as readonly string[]).includes(p))
  );
};

/**
 * The rules protecting `pages-state` and the release tags as the workflow's token sees them. A rule
 * counts only from an active ruleset; tag rules only from an active tag ruleset covering the whole
 * release tag space (`refs/tags/v*` or `~ALL`, no exclusion). The workflow may bypass when any such
 * ruleset says `current_user_can_bypass` other than `never` (or doesn't say). The full configuration
 * (bypass actors) is confirmed by the operator (R02-02, T05).
 */
export async function rulesetFacts(
  o: GithubOptions,
  branch = "pages-state",
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
    if (full.target !== "tag" || full.enforcement !== "active" || !coversReleaseTags(full))
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
  readonly created_at?: string;
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

/**
 * The run of this repository a status names (`https://github.com/<repo>/actions/runs/<run>…` in its
 * log or target URL), or `null` — no URL, or one of another repository or host.
 */
export function runOfStatus(s: Status, repo: string): number | null {
  const re = new RegExp(
    `^https://github\\.com/${repo.replace(/[.]/g, "\\.")}/actions/runs/(\\d+)(?:/|$)`,
    "i",
  );
  const m = re.exec(s.log_url ?? "") ?? re.exec(s.target_url ?? "");
  return m ? Number(m[1]) : null;
}

const PROGRESS: readonly string[] = ["queued", "pending", "waiting", "in_progress"];
const TERMINAL_FAIL: readonly string[] = ["failure", "error", "cancelled"];
/**
 * One deployment's own state from its retained statuses (newest first): `success` if any; else its
 * latest state when that is in progress or a terminal failure; else `unknown` (only `inactive`, no
 * status at all, or a state this adapter doesn't know: an earlier success may have expired).
 */
export function deploymentState(statuses: readonly Status[]): DeploymentState {
  if (statuses.some((s) => s.state === "success")) return "success";
  const latest = statuses[0]?.state;
  if (latest && (PROGRESS.includes(latest) || TERMINAL_FAIL.includes(latest)))
    return latest as DeploymentState;
  return "unknown";
}

/** The run-name of pages-release.yml (`run-name: pages <mode> <tag>`). */
export const runTitle = (mode: string, tag: string) => `pages ${mode} ${tag}`;

/**
 * github-pages deployment facts (§6, R04-01): every deployment with the run its statuses name and
 * its own state, whether it is the candidate's (a run of `workflow` titled `pages publish <tag>` or
 * `pages retry <tag>`, or `extraRuns`), the number of deployments, and whether a success is visible.
 * The deployment SHA is not used (it is main's for every version built from one commit). The
 * pending version's state is judged by the archive from these records (`candidateSince`); the
 * `candidate` here is the same rule over all of them.
 */
export async function deploymentFacts(
  o: GithubOptions,
  opts: { workflow: string; tag: string | null; extraRuns?: readonly number[] },
): Promise<DeploymentFacts & { candidate_runs: number[]; records: DeploymentRecord[] }> {
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
  const records: DeploymentRecord[] = [];
  for (const d of deployments) {
    if (d.environment !== "github-pages") continue;
    const statuses = await getAll<Status>(
      o,
      `/repos/${owner}/${name}/deployments/${d.id}/statuses`,
    );
    if (statuses.some((s) => s.state === "success")) everSucceeded = true;
    const runs = new Set(statuses.map((s) => runOfStatus(s, o.repo)));
    // one run per deployment; none, another repository's, or several: not tied to a run
    const only = runs.size === 1 ? [...runs][0] : null;
    const run = only ?? null;
    records.push({
      created_at: d.created_at ?? "",
      run,
      state: deploymentState(statuses),
      candidate: run !== null && candidateRuns.has(run),
    });
  }
  return {
    everSucceeded,
    deployments: records.length,
    candidate: candidateSince(records, Number.NEGATIVE_INFINITY),
    records,
    candidate_runs: [...candidateRuns].sort((a, b) => a - b),
  };
}
