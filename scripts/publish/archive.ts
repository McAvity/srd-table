/**
 * kenli F-014 T02: the durable archive of the public site — the `pages-state` branch of the Table
 * repository (docs/deployment.md §6–7). A fresh runner rebuilds the complete site from it instead of
 * the live server or Actions retention. Layout of the branch (nothing else):
 *
 *   state.json          srd-table.pages-state/1: base, site URL, every reserved version and its
 *                       status (pending → deployed | abandoned | observed-unverified), `pending`,
 *                       `served` (whose root/pointers the site holds), the site manifest's hash
 *   site-manifest.json  srd-table.site-manifest/1: every file of site/ with SHA-256 and size
 *   versions/<v>.json   srd-table.pages-version/1, immutable: tag → commits → release id/descriptor,
 *                       the SRD files, the mutable files it set and the complete candidate site
 *   site/               the complete public site (all earlier releases' files kept)
 *
 * Every operation works in a fresh clone (`workDir`, created here), checks the archive (anchor
 * ancestry, every byte of site/ against its manifest, records) and the witnesses, and writes at most
 * one commit, pushed as a compare-and-swap on the branch head it read
 * (`--force-with-lease=refs/heads/pages-state:<parent>`). A refused or failed operation leaves the
 * remote branch and the live site as they were.
 */
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  CURRENT_POINTER,
  compareVersions,
  type FileRef,
  fail,
  json,
  LEGACY_POINTER,
  MANIFEST,
  MUTABLE,
  type PublishManifest,
  parseVersion,
  sha256,
  tagOf,
} from "./lib";
import {
  inspectSite,
  type MutableState,
  manifestDiff,
  mutableOf,
  ownershipProblems,
  publishRelease,
  readSrd,
  readStaging,
  restoreMutable,
  SITE_LIMIT,
  siteManifest,
  siteProblems,
} from "./site";
import {
  candidateSince,
  type DeploymentFacts,
  type DeploymentState,
  type Expected,
  FAILED,
  IN_PROGRESS,
  type LiveSnapshot,
  liveHistoryProblems,
  liveMatches,
  liveSummary,
  readLive,
  rulesetProblems,
  type Witnesses,
} from "./witness";

export const BRANCH = "pages-state";
const REF = `refs/heads/${BRANCH}`;

export type VersionStatus = "pending" | "deployed" | "abandoned" | "observed-unverified";
export interface Receipt {
  readonly run_id: string;
  readonly state_commit: string;
  readonly page_url: string;
  readonly artifact_digest: string;
}
export interface VersionEntry {
  readonly status: VersionStatus;
  readonly record: string;
  readonly record_sha256: string;
  readonly release_id: string;
  /** The checkpoint commit that reserved it (known from the next commit on). */
  readonly checkpoint?: string;
  readonly receipt?: Receipt;
  readonly resolution?: { readonly deployment: string; readonly live: Record<string, string> };
}
export interface PagesState {
  readonly format: "srd-table.pages-state/1";
  readonly base: string;
  readonly site_url: string;
  readonly versions: Readonly<Record<string, VersionEntry>>;
  readonly pending: string | null;
  readonly served: string | null;
  readonly site_manifest_sha256: string;
}
export interface SiteManifestFile {
  readonly format: "srd-table.site-manifest/1";
  readonly files: readonly FileRef[];
  readonly total_bytes: number;
}
export interface VersionRecord {
  readonly format: "srd-table.pages-version/1";
  readonly version: string;
  readonly tag: string;
  readonly table_commit: string;
  readonly engine_commit: string;
  readonly base: string;
  readonly release_id: string;
  readonly descriptor_sha256: string;
  readonly release_files: readonly FileRef[];
  readonly srd: { readonly pack: string; readonly files: readonly FileRef[] };
  readonly mutable: MutableState;
  readonly site: { readonly files: readonly FileRef[]; readonly total_bytes: number };
  /** The pages-state commit the candidate was built on. */
  readonly parent_state: string;
}

export type FaultPoint = "before-checkpoint" | "before-push" | "after-checkpoint";
export interface ArchiveOptions {
  /** The repository holding `pages-state` (a URL or a path; tests use a local bare repository). */
  readonly remote: string;
  /** A new directory for this operation's clone (must not exist). */
  readonly workDir: string;
  /** PAGES_STATE_ANCHOR: the full SHA of the initialize commit. Required except to initialize. */
  readonly anchor?: string;
  readonly witnesses: Witnesses;
  readonly identity?: { readonly name: string; readonly email: string };
  readonly fault?: (at: FaultPoint) => void;
  /** The site size limit (default SITE_LIMIT, 900 MiB); tests lower it. */
  readonly siteLimit?: number;
}

const IDENTITY = {
  name: "srd-table pages publisher",
  email: "srd-table-pages@users.noreply.github.com",
};

class Git {
  constructor(
    readonly dir: string,
    readonly identity: { name: string; email: string },
  ) {}
  run(...args: string[]): string {
    return execFileSync(
      "git",
      [
        "-c",
        "core.autocrlf=false",
        "-c",
        "core.symlinks=false",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "core.hooksPath=/dev/null",
        "-C",
        this.dir,
        ...args,
      ],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 256 * 1024 * 1024,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: this.identity.name,
          GIT_AUTHOR_EMAIL: this.identity.email,
          GIT_COMMITTER_NAME: this.identity.name,
          GIT_COMMITTER_EMAIL: this.identity.email,
          GIT_TERMINAL_PROMPT: "0",
        },
      },
    ).trim();
  }
  tryRun(...args: string[]): { ok: true; out: string } | { ok: false; err: string } {
    try {
      return { ok: true, out: this.run(...args) };
    } catch (e) {
      const err = e as { stderr?: string; message: string };
      return { ok: false, err: String(err.stderr || err.message) };
    }
  }
}

const SHA = /^[0-9a-f]{40}$/;
const emptyManifest = (): SiteManifestFile => ({
  format: "srd-table.site-manifest/1",
  files: [],
  total_bytes: 0,
});
const readJson = <T>(path: string, code = "archive_invalid"): T => {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fail(code, `${path} missing or not JSON`);
  }
};

/** A checked-out pages-state (read and verified), ready for one operation. */
export class Archive {
  private constructor(
    readonly opts: ArchiveOptions,
    readonly git: Git,
    /** The remote branch head this operation read (the compare-and-swap parent). */
    readonly head: string,
    public state: PagesState,
  ) {}

  get dir() {
    return this.opts.workDir;
  }
  get site() {
    return join(this.opts.workDir, "site");
  }

  /** Clone and verify. A missing branch, a foreign history or any byte off its manifest refuses. */
  static async open(opts: ArchiveOptions): Promise<Archive> {
    if (!opts.anchor || !SHA.test(opts.anchor))
      fail("anchor_required", "PAGES_STATE_ANCHOR (the initialize commit) is required");
    const git = cloneInto(opts);
    const fetched = git.tryRun(
      "fetch",
      "--no-tags",
      "origin",
      `+${REF}:refs/remotes/origin/${BRANCH}`,
    );
    if (!fetched.ok)
      fail(
        "history_missing",
        `${BRANCH} is not in ${opts.remote}: never recreated here (initialize is a separate mode)`,
      );
    const head = git.run("rev-parse", `refs/remotes/origin/${BRANCH}`);
    const anchor = opts.anchor as string;
    if (!git.tryRun("cat-file", "-e", `${anchor}^{commit}`).ok)
      fail("history_foreign", `anchor ${anchor} is not in ${BRANCH}'s history`);
    if (git.run("rev-list", "--parents", "-n", "1", anchor) !== anchor)
      fail("history_foreign", `anchor ${anchor} is not a root commit`);
    if (!git.tryRun("merge-base", "--is-ancestor", anchor, head).ok)
      fail("history_foreign", `${BRANCH} ${head} does not descend from the anchor ${anchor}`);
    const initial = JSON.parse(git.run("show", `${anchor}:state.json`)) as PagesState;
    if (initial.format !== "srd-table.pages-state/1" || Object.keys(initial.versions).length)
      fail("history_foreign", "the anchor is not an initialize commit");
    git.run("checkout", "-q", "-B", BRANCH, head);
    const a = new Archive(opts, git, head, readJson<PagesState>(join(opts.workDir, "state.json")));
    if (a.state.base !== initial.base || a.state.site_url !== initial.site_url)
      fail(
        "config_changed",
        `base/site URL differ from the anchor's ${initial.base} ${initial.site_url}`,
      );
    a.verify();
    return a;
  }

  /** Every check of the archive itself (layout, records, site bytes, site rules). */
  verify(): void {
    const s = this.state;
    if (s.format !== "srd-table.pages-state/1") fail("archive_invalid", "state.json format");
    const top = readdirSync(this.dir).filter((n) => n !== ".git");
    const extra = top.filter(
      (n) => !["state.json", "site-manifest.json", "versions", "site"].includes(n),
    );
    if (extra.length) fail("archive_invalid", `unexpected ${extra.join(", ")}`);
    const versionFiles = existsSync(join(this.dir, "versions"))
      ? readdirSync(join(this.dir, "versions"))
      : [];
    const listed = new Set(Object.values(s.versions).map((v) => v.record));
    for (const f of versionFiles)
      if (!listed.has(`versions/${f}`))
        fail("archive_invalid", `versions/${f} is not a reserved version`);
    for (const [v, e] of Object.entries(s.versions)) {
      if (!parseVersion(v) || e.record !== `versions/${v}.json`)
        fail("archive_invalid", `entry ${v}`);
      const p = join(this.dir, e.record);
      if (!existsSync(p) || sha256(readFileSync(p)) !== e.record_sha256)
        fail("archive_invalid", `record ${e.record}`);
      const rec = this.record(v);
      if (rec.version !== v || rec.release_id !== e.release_id || rec.tag !== tagOf(v))
        fail("archive_invalid", `record ${v} identity`);
    }
    if (s.pending && s.versions[s.pending]?.status !== "pending")
      fail("archive_invalid", "pending");
    if (Object.entries(s.versions).some(([v, e]) => e.status === "pending" && v !== s.pending))
      fail("archive_invalid", "a pending version that is not `pending`");
    if (s.served) {
      const st = s.versions[s.served]?.status;
      if (st !== "deployed" && st !== "observed-unverified") fail("archive_invalid", "served");
    }
    const mfBytes = existsSync(join(this.dir, "site-manifest.json"))
      ? readFileSync(join(this.dir, "site-manifest.json"))
      : fail("archive_invalid", "site-manifest.json");
    if (sha256(mfBytes) !== s.site_manifest_sha256)
      fail("archive_invalid", "site-manifest.json ≠ state");
    const mf = JSON.parse(mfBytes.toString("utf8")) as SiteManifestFile;
    if (!existsSync(this.site)) mkdirSync(this.site);
    const diff = manifestDiff(this.site, mf.files);
    if (diff.length)
      fail("archive_invalid", `site/ ≠ site-manifest.json: ${diff.slice(0, 10).join(", ")}`);
    const problems = [...siteProblems(this.site), ...ownershipProblems(this.site)];
    if (problems.length) fail("archive_invalid", `site: ${problems.slice(0, 10).join("; ")}`);
    if (mf.files.length) inspectSite(this.site, s.base);
    // R03-04: every archived site path belongs to a reserved version's verified release or SRD
    // (as stage recorded them from readStaging/readSrd), or is a mutable file
    const recorded = this.recordedPaths();
    const orphans = mf.files.map((f) => f.path).filter((p) => !recorded.has(p));
    if (orphans.length)
      fail("archive_invalid", `site files no version owns: ${orphans.slice(0, 10).join(", ")}`);
    // the root, pointers and marker are the pending or served version's (or absent before any)
    const owner = s.pending ?? s.served;
    const expected: MutableState = owner
      ? this.record(owner).mutable
      : {
          root_html: null,
          pointers: { [LEGACY_POINTER]: null, [CURRENT_POINTER]: null },
          marker: null,
        };
    if (!sameMutable(mutableOf(this.site), expected))
      fail("archive_invalid", `site root/pointers/marker are not ${owner ?? "absent"}`);
  }

  /** The paths the reserved versions' records own (release files, descriptors, SRD), and the mutable files. */
  recordedPaths(): Set<string> {
    const owned = new Set<string>(MUTABLE);
    for (const v of Object.keys(this.state.versions)) {
      const r = this.record(v);
      owned.add(`releases/${r.release_id}/release.json`);
      for (const f of [...r.release_files, ...r.srd.files]) owned.add(f.path);
    }
    return owned;
  }

  record(version: string): VersionRecord {
    return readJson<VersionRecord>(join(this.dir, `versions/${version}.json`));
  }
  siteRelease(): PublishManifest | null {
    const p = join(this.site, MANIFEST);
    return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as PublishManifest) : null;
  }

  /** The bytes clients get at the live paths if `version`'s root/pointers are served (`null`: none yet). */
  expectedLive(version: string | null): Expected {
    if (!version)
      return {
        files: { "index.html": null, [LEGACY_POINTER]: null, [CURRENT_POINTER]: null },
        release_id: null,
      };
    const rec = this.record(version);
    const m = rec.mutable;
    const ptr = (p: string) => {
      const v = m.pointers[p];
      return v ? Buffer.from(json(v)) : null;
    };
    return {
      files: {
        "index.html": m.root_html ? readFileSync(join(this.site, m.root_html)) : null,
        [LEGACY_POINTER]: ptr(LEGACY_POINTER),
        [CURRENT_POINTER]: ptr(CURRENT_POINTER),
      },
      // the rest of the release manifest is compared as history (liveHistoryProblems)
      release_id: rec.release_id,
    };
  }

  /**
   * The witnesses before any write (§6): rulesets active, deployments consistent with the archive,
   * the live site readable when it should be and holding no release the archive lacks.
   */
  async witness(): Promise<{ deployments: DeploymentFacts; live: LiveSnapshot }> {
    const w = this.opts.witnesses;
    const rules = rulesetProblems(await w.rulesets());
    if (rules.length) fail("ruleset_missing", rules.join("; "));
    const deployments = await w.deployments();
    const live = await readLive(w);
    const s = this.state;
    const everServed = Object.values(s.versions).some(
      (v) => v.status === "deployed" || v.status === "observed-unverified",
    );
    if (!Number.isSafeInteger(deployments.deployments) || deployments.deployments < 0)
      fail("witness_invalid", "the deployment facts have no deployment count");
    if (deployments.everSucceeded && !everServed && !s.pending)
      fail(
        "history_lost",
        "the site has been deployed, but the archive has no served version (archive reset or replaced)",
      );
    // R04-01: an archive that reserved nothing while github-pages has deployments (of any state:
    // old statuses expire, a missing success proves nothing) is a lost archive, not a first one
    if (Object.keys(s.versions).length === 0 && deployments.deployments > 0)
      fail(
        "history_lost",
        `github-pages has ${deployments.deployments} deployments, but the archive reserved no version`,
      );
    // R04-01: no "no success visible ⇒ never deployed" check: GitHub keeps deployment statuses for a
    // limited time, so a long-lived receipt would be refused for ever. A served version is held to
    // the live site instead (live_missing / live_mismatch / history_rollback below and per operation).
    const errors = Object.entries(live).filter(([, l]) => l.status === "error");
    if ((deployments.everSucceeded || everServed || deployments.deployments > 0) && errors.length)
      fail(
        "live_unavailable",
        errors.map(([p, l]) => `${p}: ${l.status === "error" ? l.detail : ""}`).join("; "),
      );
    if (s.served && (live[MANIFEST].status !== "ok" || live["index.html"].status !== "ok"))
      fail("live_missing", `${s.served} is served, but the site has no root or release manifest`);
    const history = liveHistoryProblems(live, this.siteRelease());
    if (history.length) fail("history_rollback", history.join("; "));
    return { deployments, live };
  }

  /** Live is exactly the served version's (or nothing before the first deployment). */
  requireLiveServed(live: LiveSnapshot): void {
    if (!liveMatches(live, this.expectedLive(this.state.served)))
      fail(
        "live_mismatch",
        `live is not ${this.state.served ?? "an empty site"}: ${JSON.stringify(liveSummary(live))}`,
      );
  }

  /**
   * The pending version's deployment state (R04-01): from the adapter's records created since its
   * checkpoint commit (10 minutes of margin for clocks), else the facts' own `candidate`.
   */
  pendingDeployment(d: DeploymentFacts): DeploymentState {
    if (!this.state.pending || !d.records) return d.candidate;
    const at = Date.parse(this.git.run("log", "-1", "--format=%cI", this.head));
    return candidateSince(d.records, Number.isNaN(at) ? Number.NEGATIVE_INFINITY : at - 600_000);
  }

  /** Commit everything under the archive and push it as a compare-and-swap on `head`. */
  checkpoint(message: string): string {
    const git = this.git;
    this.opts.fault?.("before-checkpoint");
    git.run("add", "-A", "--", ".");
    git.run("commit", "-q", "--no-verify", "-m", message);
    const sha = git.run("rev-parse", "HEAD");
    if (git.run("rev-parse", "HEAD^") !== this.head)
      fail("archive_invalid", "the commit is not on the head read");
    this.opts.fault?.("before-push");
    const pushed = git.tryRun(
      "push",
      "--porcelain",
      `--force-with-lease=${REF}:${this.head}`,
      "origin",
      `${sha}:${REF}`,
    );
    if (!pushed.ok)
      fail(
        "state_conflict",
        `${BRANCH} moved since ${this.head} (another publication?): nothing written. ${pushed.err.split("\n")[0]}`,
      );
    this.opts.fault?.("after-checkpoint");
    return sha;
  }

  writeState(next: PagesState): void {
    this.state = next;
    writeFileSync(join(this.dir, "state.json"), json(next));
  }
  /** Rewrite site-manifest.json from site/ (after a change) and return its hash. */
  writeSiteManifest(): { manifest: SiteManifestFile; sha: string } {
    const m = siteManifest(this.site);
    const limit = this.opts.siteLimit ?? SITE_LIMIT;
    if (m.total_bytes > limit)
      fail(
        "site_too_large",
        `${m.total_bytes} bytes > ${limit} (no automatic removal of old releases)`,
      );
    const manifest: SiteManifestFile = { format: "srd-table.site-manifest/1", ...m };
    const bytes = json(manifest);
    writeFileSync(join(this.dir, "site-manifest.json"), bytes);
    return { manifest, sha: sha256(bytes) };
  }

  /** A copy of site/ for the Pages artifact (new directory), checked against the archive's manifest. */
  exportSite(out: string): FileRef[] {
    if (existsSync(out)) fail("export_exists", out);
    cpSync(this.site, out, { recursive: true });
    const mf = readJson<SiteManifestFile>(join(this.dir, "site-manifest.json"));
    // the archive's exact bytes, and (R03-04) only owned files: verified releases, the SRD's list,
    // the mutable files — anything else and no artifact is left behind
    const recorded = this.recordedPaths();
    const problems = [
      ...manifestDiff(out, mf.files),
      ...ownershipProblems(out),
      ...mf.files.filter((f) => !recorded.has(f.path)).map((f) => `unrecorded ${f.path}`),
    ];
    if (problems.length) {
      rmSync(out, { recursive: true, force: true });
      fail("export_invalid", problems.slice(0, 10).join("; "));
    }
    return [...mf.files];
  }
}

const sameMutable = (a: MutableState, b: MutableState) => json(a) === json(b);

function cloneInto(opts: ArchiveOptions): Git {
  if (existsSync(opts.workDir))
    fail("workdir_exists", `${opts.workDir} (each operation uses a new clone)`);
  mkdirSync(opts.workDir, { recursive: true });
  const git = new Git(opts.workDir, opts.identity ?? IDENTITY);
  git.run("init", "-q");
  git.run("remote", "add", "origin", opts.remote);
  return git;
}

// ───────────────────────── operations ─────────────────────────

/**
 * initialize (§7.1): the first, empty state commit — only when the branch doesn't exist and nothing is
 * deployed or served at the site. Never a recovery: an existing or lost history is refused.
 */
export async function initialize(
  opts: Omit<ArchiveOptions, "anchor">,
  config: { base: string; siteUrl: string },
): Promise<{ anchor: string }> {
  const git = cloneInto(opts);
  const remoteHas = git.tryRun("ls-remote", "--exit-code", "origin", REF);
  if (remoteHas.ok)
    fail("already_initialized", `${BRANCH} exists: initialize never replaces a history`);
  if (!/^\/([A-Za-z0-9._-]+\/)+$/.test(config.base)) fail("config_invalid", `base ${config.base}`);
  if (!/^https:\/\/[^?#]+\/$/.test(config.siteUrl) || !config.siteUrl.endsWith(config.base))
    fail("config_invalid", `site URL ${config.siteUrl} for base ${config.base}`);
  const rules = rulesetProblems(await opts.witnesses.rulesets());
  if (rules.length) fail("ruleset_missing", rules.join("; "));
  const dep = await opts.witnesses.deployments();
  if (!Number.isSafeInteger(dep.deployments)) fail("witness_invalid", "no deployment count");
  if (dep.everSucceeded || dep.deployments > 0)
    fail(
      "history_lost",
      `github-pages has ${dep.deployments} deployments: the archive is lost, not new (initialize never recovers)`,
    );
  const live = await readLive(opts.witnesses);
  const present = Object.entries(live).filter(([, l]) => l.status !== "absent");
  if (present.length)
    fail(
      "live_present",
      `the site already serves ${present.map(([p, l]) => `${p} (${l.status})`).join(", ")}`,
    );
  git.run("checkout", "-q", "--orphan", BRANCH);
  const mf = json(emptyManifest());
  writeFileSync(join(opts.workDir, "site-manifest.json"), mf);
  const state: PagesState = {
    format: "srd-table.pages-state/1",
    base: config.base,
    site_url: config.siteUrl,
    versions: {},
    pending: null,
    served: null,
    site_manifest_sha256: sha256(mf),
  };
  writeFileSync(join(opts.workDir, "state.json"), json(state));
  git.run("add", "state.json", "site-manifest.json");
  git.run("commit", "-q", "--no-verify", "-m", "pages-state: initialize (empty)");
  const sha = git.run("rev-parse", "HEAD");
  const pushed = git.tryRun(
    "push",
    "--porcelain",
    `--force-with-lease=${REF}:`,
    "origin",
    `${sha}:${REF}`,
  );
  if (!pushed.ok)
    fail("state_conflict", `${BRANCH} appeared meanwhile: ${pushed.err.split("\n")[0]}`);
  return { anchor: sha };
}

export interface StageInput {
  readonly version: string;
  /** The commit the tag `v<version>` resolves to (T03 resolves and checks it is on main). */
  readonly tagCommit: string;
  readonly releaseDir: string;
  readonly srdDir: string;
  readonly bridge?: boolean;
}
export interface StageResult {
  readonly version: string;
  readonly release_id: string;
  readonly checkpoint: string;
  readonly site_files: number;
  readonly site_bytes: number;
}

/**
 * publish, step 1 (§7.2): a new, higher version → the complete candidate site, checked, committed as
 * `pending` and pushed (the checkpoint) BEFORE any Pages transport. Then export the site from it.
 */
export async function stage(a: Archive, input: StageInput): Promise<StageResult> {
  const s = a.state;
  const v = input.version;
  if (!parseVersion(v)) fail("version_invalid", v);
  if (!SHA.test(input.tagCommit)) fail("tag_invalid", input.tagCommit);
  const staged = readStaging(input.releaseDir);
  const srd = readSrd(input.srdDir);
  const d = staged.descriptor;
  if (d.inputs.app_version !== v)
    fail("version_mismatch", `release is ${d.inputs.app_version ?? "unnumbered"}, not ${v}`);
  if (d.inputs.table_commit !== input.tagCommit)
    fail(
      "tag_mismatch",
      `${tagOf(v)} is ${input.tagCommit}, the release was built from ${d.inputs.table_commit}`,
    );
  if (d.base !== s.base) fail("config_changed", `release base ${d.base} ≠ ${s.base}`);
  const known = s.versions[v];
  if (known) {
    const rec = a.record(v);
    const same =
      rec.table_commit === d.inputs.table_commit &&
      rec.release_id === d.release_id &&
      rec.descriptor_sha256 === sha256(staged.descriptorBytes) &&
      json(rec.srd.files) === json(srd.files);
    fail(
      same ? "version_reserved" : "version_conflict",
      same
        ? `${v} is ${known.status}: use retry (never a rebuild)`
        : `${v} is reserved with other tag/commit/base/content`,
    );
  }
  if (s.pending)
    fail("pending_unresolved", `${s.pending} is pending: retry, receipt or resolve it first`);
  const higher = Object.keys(s.versions).filter((r) => compareVersions(v, r) <= 0);
  if (higher.length)
    fail("version_not_newer", `${v} is not above ${higher.sort(compareVersions).join(", ")}`);
  const { live } = await a.witness();
  a.requireLiveServed(live);
  const result = publishRelease(a.site, staged, srd, {
    base: s.base,
    version: v,
    bridge: input.bridge,
  });
  const { manifest, sha } = a.writeSiteManifest();
  const record: VersionRecord = {
    format: "srd-table.pages-version/1",
    version: v,
    tag: tagOf(v),
    table_commit: d.inputs.table_commit,
    engine_commit: d.inputs.engine_commit,
    base: d.base,
    release_id: d.release_id,
    descriptor_sha256: sha256(staged.descriptorBytes),
    release_files: staged.files,
    srd: { pack: srd.pack, files: srd.files },
    mutable: result.mutable,
    site: { files: manifest.files, total_bytes: manifest.total_bytes },
    parent_state: a.head,
  };
  mkdirSync(join(a.dir, "versions"), { recursive: true });
  const recBytes = json(record);
  writeFileSync(join(a.dir, `versions/${v}.json`), recBytes);
  a.writeState({
    ...s,
    versions: {
      ...s.versions,
      [v]: {
        status: "pending",
        record: `versions/${v}.json`,
        record_sha256: sha256(recBytes),
        release_id: d.release_id,
      },
    },
    pending: v,
    site_manifest_sha256: sha,
  });
  const checkpoint = a.checkpoint(`pages-state: ${tagOf(v)} pending (${d.release_id})`);
  return {
    version: v,
    release_id: d.release_id,
    checkpoint,
    site_files: manifest.files.length,
    site_bytes: manifest.total_bytes,
  };
}

/** receipt (§7.3): the pending version is live (smoke passed): deployed, with its receipt. Site unchanged. */
export async function receipt(
  a: Archive,
  version: string,
  r: Omit<Receipt, "state_commit">,
): Promise<{ commit: string }> {
  const s = a.state;
  if (s.pending !== version)
    fail("not_pending", `${version} is not pending (${s.pending ?? "none"})`);
  if (
    !/^[0-9]+$/.test(r.run_id) ||
    !/^https:\/\//.test(r.page_url) ||
    !/^(sha256:)?[0-9a-f]{64}$/.test(r.artifact_digest)
  )
    fail("receipt_invalid", JSON.stringify(r));
  const { deployments, live } = await a.witness();
  const dep = a.pendingDeployment(deployments);
  if (dep !== "success") fail("not_deployed", `the deployment is ${dep}`);
  if (!liveMatches(live, a.expectedLive(version)))
    fail("live_mismatch", `live is not ${version}: ${JSON.stringify(liveSummary(live))}`);
  const e = s.versions[version] as VersionEntry;
  a.writeState({
    ...s,
    versions: {
      ...s.versions,
      [version]: {
        ...e,
        status: "deployed",
        checkpoint: a.head,
        receipt: { ...r, state_commit: a.head },
      },
    },
    pending: null,
    served: version,
  });
  return { commit: a.checkpoint(`pages-state: ${tagOf(version)} deployed (run ${r.run_id})`) };
}

export type ResolveOutcome = "abandoned" | "observed-unverified";
/**
 * resolve (§7.4, R01-04, R02-01): settle a pending version that won't be receipted.
 *  - its deployment queued/in progress → refused (it may still succeed);
 *  - live is the candidate (whatever its deployment says, even after a failed smoke) →
 *    observed-unverified: kept as served (its data direction stays), a higher version follows;
 *  - its deployment never started or ended in failure and live is exactly the previous site →
 *    abandoned: only the root, pointers and marker go back to the served version's; its record and
 *    immutable files stay (the number stays reserved with these bytes);
 *  - anything else → refused, nothing written: live unreadable or mixed, or a successful deployment
 *    while live still shows the previous site (never abandoned after success: wait and resolve again).
 */
export async function resolve(
  a: Archive,
  version: string,
): Promise<{ outcome: ResolveOutcome; commit: string }> {
  const s = a.state;
  if (s.pending !== version)
    fail("not_pending", `${version} is not pending (${s.pending ?? "none"})`);
  const { deployments, live } = await a.witness();
  const dep = a.pendingDeployment(deployments);
  if (IN_PROGRESS.includes(dep))
    fail("deployment_in_progress", `the deployment of ${version} is ${dep}: wait, then resolve`);
  if (Object.values(live).some((l) => l.status === "error"))
    fail("live_unavailable", JSON.stringify(liveSummary(live)));
  const isCandidate = liveMatches(live, a.expectedLive(version));
  const isPrevious = liveMatches(live, a.expectedLive(s.served));
  const e = s.versions[version] as VersionEntry;
  const resolution = { deployment: dep, live: liveSummary(live) };
  if (isCandidate) {
    a.writeState({
      ...s,
      versions: {
        ...s.versions,
        [version]: { ...e, status: "observed-unverified", checkpoint: a.head, resolution },
      },
      pending: null,
      served: version,
    });
    return {
      outcome: "observed-unverified",
      commit: a.checkpoint(`pages-state: ${tagOf(version)} observed-unverified`),
    };
  }
  // R04-01: no evidence either way (a deployment of this period not tied to a run, only expired or
  // unknown statuses) never becomes "abandoned"
  if (dep === "unknown" && isPrevious)
    fail(
      "deployment_unknown",
      `the deployment of ${version} can't be told (statuses missing, expired or not tied to its run): nothing written`,
    );
  if (FAILED.includes(dep) && isPrevious) {
    const prev: MutableState = s.served
      ? a.record(s.served).mutable
      : {
          root_html: null,
          pointers: { [LEGACY_POINTER]: null, [CURRENT_POINTER]: null },
          marker: null,
        };
    restoreMutable(a.site, prev);
    const { sha } = a.writeSiteManifest();
    a.writeState({
      ...s,
      versions: {
        ...s.versions,
        [version]: { ...e, status: "abandoned", checkpoint: a.head, resolution },
      },
      pending: null,
      site_manifest_sha256: sha,
    });
    return {
      outcome: "abandoned",
      commit: a.checkpoint(`pages-state: ${tagOf(version)} abandoned`),
    };
  }
  return fail(
    "live_ambiguous",
    `deployment ${dep}, live neither ${version} nor ${s.served ?? "empty"}: ${JSON.stringify(liveSummary(live))}`,
  );
}

export type RetryAction = "redeploy-pending" | "already-deployed" | "historical-verified";
/**
 * retry (§7.5): a reserved version again — never a build. Pending: the archived candidate, every byte
 * checked, for the same Pages transport. Served and deployed: verified (an identical redeploy may
 * follow). Older or settled: its record and files are verified to be kept; no pointer moves.
 */
export async function retry(
  a: Archive,
  version: string,
): Promise<{ action: RetryAction; release_id: string }> {
  const s = a.state;
  const e = s.versions[version] ?? fail("version_unknown", `${version} is not reserved`);
  const rec = a.record(version);
  const { live } = await a.witness();
  const kept = (files: readonly FileRef[]) => {
    const all = new Map(siteManifest(a.site).files.map((f) => [f.path, f.sha256]));
    const lost = files.filter((f) => all.get(f.path) !== f.sha256).map((f) => f.path);
    if (lost.length)
      fail(
        "archive_invalid",
        `${version}'s files changed or missing: ${lost.slice(0, 10).join(", ")}`,
      );
  };
  kept([...rec.release_files, ...rec.srd.files]);
  if (s.pending === version) {
    const diff = manifestDiff(a.site, rec.site.files);
    if (diff.length)
      fail("archive_invalid", `site ≠ ${version}'s checkpoint: ${diff.slice(0, 10).join(", ")}`);
    if (!liveMatches(live, a.expectedLive(version))) a.requireLiveServed(live);
    return { action: "redeploy-pending", release_id: e.release_id };
  }
  if (s.served === version && !s.pending) {
    a.requireLiveServed(live);
    return { action: "already-deployed", release_id: e.release_id };
  }
  if (!s.pending) a.requireLiveServed(live);
  return { action: "historical-verified", release_id: e.release_id };
}
