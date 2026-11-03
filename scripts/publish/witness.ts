/**
 * kenli F-014 T02: the independent witnesses the archive is checked against before any write
 * (docs/deployment.md §6): the repository rulesets, the github-pages deployments and the live site.
 * The archive is the only source of files; the witnesses only refuse. T03 implements `Witnesses`
 * over the GitHub API and `httpLive`; tests use an explicit fake (tests/publish/fake-github.ts).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CURRENT_POINTER,
  fail,
  jcs,
  LEGACY_POINTER,
  MANIFEST,
  type PublishManifest,
  sha256,
} from "./lib";

/** The effective rules the runner can see (R02-02: T03 maps the API; the operator confirms in T05). */
export interface RulesetFacts {
  /** `pages-state`: deletion and non-fast-forward updates are blocked. */
  readonly pagesState: { readonly deletion: boolean; readonly nonFastForward: boolean };
  /** `refs/tags/v*`: updates and deletion are blocked. */
  readonly tags: { readonly update: boolean; readonly deletion: boolean };
  /** Whether the workflow's identity may bypass any of them (must be false). */
  readonly workflowBypass: boolean;
}
/** github-pages deployment states (GitHub deployment statuses), plus `unknown`: no evidence either way. */
export type DeploymentState =
  | "none"
  | "queued"
  | "pending"
  | "waiting"
  | "in_progress"
  | "success"
  | "failure"
  | "error"
  | "inactive"
  | "cancelled"
  | "unknown";
/**
 * One github-pages deployment as the adapter read it (R04-01): when it was created, the run its
 * statuses name (`null`: none, or not a run of this repository), its own state (`success` if any
 * retained status was; `unknown` when only `inactive` or no status is left — GitHub keeps statuses
 * for a limited time, so an old success may be gone), and whether the run is the candidate's.
 */
export interface DeploymentRecord {
  readonly created_at: string;
  readonly run: number | null;
  readonly state: DeploymentState;
  readonly candidate: boolean;
}
export interface DeploymentFacts {
  /**
   * A success is visible in the retained statuses. A lower bound only: `false` proves nothing
   * (old statuses expire), so it is never evidence that the site was not deployed.
   */
  readonly everSucceeded: boolean;
  /** github-pages deployment objects that exist (any state): > 0 means the site may have history. */
  readonly deployments: number;
  /** The candidate's state over all deployments (no time bound). The archive prefers `records`. */
  readonly candidate: DeploymentState;
  /** Every deployment read, for the archive to judge the pending version from its checkpoint on. */
  readonly records?: readonly DeploymentRecord[];
}
/** A live file: its bytes, `absent` (HTTP 404) or `error` (anything else: not a witness). */
export type LiveFile =
  | { readonly status: "ok"; readonly bytes: Buffer }
  | { readonly status: "absent" }
  | { readonly status: "error"; readonly detail: string };
export interface Witnesses {
  rulesets(): Promise<RulesetFacts>;
  deployments(): Promise<DeploymentFacts>;
  /** A file of the live site, bypassing caches. */
  live(path: string): Promise<LiveFile>;
}

export const IN_PROGRESS: readonly DeploymentState[] = [
  "queued",
  "pending",
  "waiting",
  "in_progress",
];
/**
 * Terminal evidence that a deployment did not succeed. `inactive` is not (an earlier success may
 * have expired), nor is `unknown`.
 */
export const FAILED: readonly DeploymentState[] = ["none", "failure", "error", "cancelled"];

const PROGRESS_ORDER: readonly DeploymentState[] = ["in_progress", "pending", "waiting", "queued"];
/**
 * The pending version's deployment state from the records created since `sinceMs` (its checkpoint,
 * with a margin): `success` if any candidate deployment succeeded; else in progress if any is; else
 * `unknown` if any candidate deployment is unknown or any deployment of that period can't be tied to
 * a run of this repository (it could be the candidate's); else the terminal failure; else `none`.
 * A deployment tied to another run of this workflow is not the candidate's.
 */
export function candidateSince(
  records: readonly DeploymentRecord[],
  sinceMs: number,
): DeploymentState {
  const recent = records.filter((r) => {
    const t = Date.parse(r.created_at);
    return Number.isNaN(t) || t >= sinceMs; // an unreadable date: can't be excluded
  });
  const mine = recent.filter((r) => r.candidate);
  if (mine.some((r) => r.state === "success")) return "success";
  for (const p of PROGRESS_ORDER) if (mine.some((r) => r.state === p)) return p;
  if (mine.some((r) => !FAILED.includes(r.state)) || recent.some((r) => r.run === null))
    return "unknown";
  const failed = mine.find((r) => FAILED.includes(r.state));
  return failed ? failed.state : "none";
}

export function rulesetProblems(r: RulesetFacts): string[] {
  const out: string[] = [];
  if (!r.pagesState.deletion) out.push("pages-state deletion not blocked");
  if (!r.pagesState.nonFastForward) out.push("pages-state non-fast-forward not blocked");
  if (!r.tags.update) out.push("v* tag update not blocked");
  if (!r.tags.deletion) out.push("v* tag deletion not blocked");
  if (r.workflowBypass) out.push("the workflow can bypass a ruleset");
  return out;
}

/** The live mutable files (root, pointers, release manifest): what every client reads. */
export const LIVE_PATHS = ["index.html", LEGACY_POINTER, CURRENT_POINTER, MANIFEST] as const;
export type LiveSnapshot = Readonly<Record<(typeof LIVE_PATHS)[number], LiveFile>>;

export async function readLive(w: Witnesses): Promise<LiveSnapshot> {
  const out: Record<string, LiveFile> = {};
  for (const p of LIVE_PATHS) out[p] = await w.live(p);
  return out as LiveSnapshot;
}

/** What a site serves if a version's root/pointers are live: bytes (`null`: absent) and its release. */
export interface Expected {
  readonly files: Readonly<
    Record<"index.html" | typeof LEGACY_POINTER | typeof CURRENT_POINTER, Buffer | null>
  >;
  /** The release the live manifest must list; `null`: no manifest at all (nothing published yet). */
  readonly release_id: string | null;
}

/** Live equals the expected root and pointers exactly, and its release manifest lists the release. */
export function liveMatches(live: LiveSnapshot, expected: Expected): boolean {
  const filesOk = (Object.keys(expected.files) as (keyof Expected["files"])[]).every((p) => {
    const l = live[p];
    const e = expected.files[p];
    if (l.status === "error") return false;
    if (e === null) return l.status === "absent";
    return l.status === "ok" && sha256(l.bytes) === sha256(e);
  });
  const m = live[MANIFEST];
  if (expected.release_id === null) return filesOk && m.status === "absent";
  if (!filesOk || m.status !== "ok") return false;
  try {
    const lm = JSON.parse(m.bytes.toString("utf8")) as PublishManifest;
    return lm.releases.some((r) => r.release_id === expected.release_id);
  } catch {
    return false;
  }
}

/**
 * Every release the live manifest lists is kept by the archive byte-exact (its record and files):
 * a live release the archive doesn't know means the archive lost history (or was reset to an older
 * descendant of the anchor).
 */
export function liveHistoryProblems(
  live: LiveSnapshot,
  archived: PublishManifest | null,
): string[] {
  const m = live[MANIFEST];
  if (m.status !== "ok") return [];
  let lm: PublishManifest;
  try {
    lm = JSON.parse(m.bytes.toString("utf8")) as PublishManifest;
  } catch {
    return ["live releases/index.json is not JSON"];
  }
  const out: string[] = [];
  if (!Array.isArray(lm.releases)) return ["live releases/index.json has no releases"];
  for (const r of lm.releases) {
    const a = archived?.releases.find((x) => x.release_id === r.release_id);
    if (!a) out.push(`live release ${r.release_id} is not in the archive`);
    else if (jcs(a) !== jcs(r)) out.push(`live release ${r.release_id} differs from the archive`);
  }
  if (lm.bridge !== undefined && lm.bridge !== archived?.bridge)
    out.push(`live bridge ${lm.bridge} is not the archive's`);
  return out;
}

export function liveSummary(live: LiveSnapshot): Record<string, string> {
  return Object.fromEntries(
    LIVE_PATHS.map((p) => {
      const l = live[p];
      return [
        p,
        l.status === "ok"
          ? `sha256:${sha256(l.bytes)}`
          : l.status === "absent"
            ? "absent"
            : `error:${l.detail}`,
      ];
    }),
  );
}

/** A local directory as the live site (rehearsal, tests): a missing file is a 404. */
export function dirLive(dir: string): (path: string) => Promise<LiveFile> {
  return async (path) => {
    const p = join(dir, path);
    return existsSync(p) ? { status: "ok", bytes: readFileSync(p) } : { status: "absent" };
  };
}

/**
 * The live site over HTTP(S), every read past caches (`cache: "no-store"`, a unique query string,
 * no-cache request headers). 404 is `absent`; any other status or network failure is `error`.
 */
export function httpLive(
  siteUrl: string,
  fetcher: typeof fetch = fetch,
): (path: string) => Promise<LiveFile> {
  if (!/^https?:\/\/[^?#]+\/$/.test(siteUrl)) fail("config_invalid", `site URL ${siteUrl}`);
  let n = 0;
  return async (path) => {
    const url = `${siteUrl}${path}?pages-check=${Date.now()}-${n++}`;
    try {
      const res = await fetcher(url, {
        cache: "no-store",
        redirect: "error",
        headers: { "cache-control": "no-cache", pragma: "no-cache" },
      });
      if (res.status === 404) return { status: "absent" };
      if (!res.ok) return { status: "error", detail: `HTTP ${res.status}` };
      return { status: "ok", bytes: Buffer.from(await res.arrayBuffer()) };
    } catch (e) {
      return { status: "error", detail: String((e as Error).message ?? e) };
    }
  };
}
