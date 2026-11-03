/**
 * kenli F-014 T02 test helpers: synthetic staging releases (real hashes and graph, as
 * scripts/release.ts writes them; ported from dnd5 tools/migration/app/pointers.test.ts), an SRD
 * pack, local bare Git repositories, and an explicitly FAKE GitHub/Pages (`FakePages`): rulesets,
 * github-pages deployments and the live site as a directory. Nothing here talks to GitHub.
 */
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { PublishError, releaseIdOf, sha256 } from "../../scripts/publish/lib";
import {
  type DeploymentFacts,
  type DeploymentState,
  dirLive,
  type LiveFile,
  type RulesetFacts,
  type Witnesses,
} from "../../scripts/publish/witness";

export const BASE = "/srd-table/";
export const SITE_URL = "https://example.invalid/srd-table/";
export const ENGINE = "65ff5e28f6bd03a5abf7521c29913e3276b48013";
export const tmp = (tag: string) => mkdtempSync(join(tmpdir(), `f014-t02-${tag}-`));
export const put = (root: string, path: string, bytes: string | Buffer) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), bytes);
};
export const DATA4 = {
  db_version: 4,
  history_schema: "kenli.history/1",
  history_meta_schema: "kenli.history-meta/1",
  transfer_formats: ["srd-table.transfer/1"],
  local_copy_formats: ["srd-table.local-copy/1", "srd-table.local-copy/2"],
  history_entry_schemas: ["kenli.history/1", "kenli.history/2"],
  state_versions: [1, 2, 3],
};
export const DATA5 = {
  ...DATA4,
  db_version: 5,
  local_copy_formats: [...DATA4.local_copy_formats, "srd-table.local-copy/3"],
  history_entry_schemas: [...DATA4.history_entry_schemas, "kenli.history/3"],
};
export const commitOf = (tag: string) => sha256(`commit-${tag}`).slice(0, 40);

export interface Rel {
  readonly dir: string;
  readonly id: string;
  readonly version: string | undefined;
  readonly commit: string;
}
/** A staging release (synthetic bytes, real hashes and graph). */
export function makeRelease(
  tag: string,
  opts: {
    version?: string;
    data?: typeof DATA4;
    base?: string;
    commit?: string;
    extra?: string;
  } = {},
): Rel {
  const base = opts.base ?? BASE;
  const dir = tmp(`rel-${tag}`);
  const commit = opts.commit ?? commitOf(tag);
  const inputs = {
    format: "srd-table.release-inputs/1",
    base,
    table_commit: commit,
    engine_commit: ENGINE,
    protocol: 1,
    data: opts.data ?? DATA5,
    toolchain: { bun: "1.3.10", vite: "8.3.2" },
    ...(opts.version ? { app_version: opts.version } : {}),
  };
  const id = releaseIdOf(inputs);
  const assets: Record<string, [string, string]> = {
    [`assets/index-${tag}.js`]: [
      `new Worker(new URL("${base}assets/worker-${tag}.js",import.meta.url))${opts.extra ?? ""}`,
      "entry",
    ],
    [`assets/worker-${tag}.js`]: [`self.onmessage = () => "${tag}"`, "worker"],
    [`assets/icon-${tag}.png`]: [`png ${tag}`, "icon"],
  };
  const html = `<!doctype html><script type="module" src="${base}assets/index-${tag}.js"></script><link rel="manifest" href="${base}releases/${id}/manifest.webmanifest">`;
  const manifest = JSON.stringify({
    id: base,
    start_url: base,
    scope: base,
    icons: [{ src: `${base}assets/icon-${tag}.png` }],
  });
  const sw = `self.__F007_RELEASE__ = ${JSON.stringify({ release_id: id })};`;
  for (const [p, [b]] of Object.entries(assets)) put(dir, p, b);
  put(dir, `releases/${id}/index.html`, html);
  put(dir, "index.html", html);
  put(dir, `releases/${id}/manifest.webmanifest`, manifest);
  put(dir, `sw-${id}.js`, sw);
  const ref = (path: string, b: string) => ({
    path,
    sha256: sha256(b),
    size: Buffer.byteLength(b),
  });
  const assetList = Object.entries(assets)
    .map(([p, [b, role]]) => ({ ...ref(p, b), role }))
    .sort((a, b) => (a.path < b.path ? -1 : 1));
  const htmlRef = ref(`releases/${id}/index.html`, html);
  const manRef = {
    ...ref(`releases/${id}/manifest.webmanifest`, manifest),
    id: base,
    start_url: base,
    scope: base,
  };
  const d = {
    format: "srd-table.release/1",
    release_id: id,
    base,
    inputs,
    sw: ref(`sw-${id}.js`, sw),
    html: htmlRef,
    webmanifest: manRef,
    assets: assetList,
    graph: {
      roots: [htmlRef.path, manRef.path],
      edges: [
        [htmlRef.path, `assets/index-${tag}.js`],
        [manRef.path, `assets/icon-${tag}.png`],
        [`assets/index-${tag}.js`, `assets/worker-${tag}.js`],
      ],
    },
    total_bytes: htmlRef.size + manRef.size + assetList.reduce((s, a) => s + a.size, 0),
  };
  put(dir, `releases/${id}/release.json`, `${JSON.stringify(d, null, 2)}\n`);
  return { dir, id, version: opts.version, commit };
}

/** An SRD pack directory (the engine's `dist/srd-5.2.1/`, synthetic). */
export function makeSrd(variant = "a", extra: Record<string, string> = {}): string {
  const dir = tmp(`srd-${variant}`);
  put(dir, "manifest.json", JSON.stringify({ name: "srd-5.2.1", variant: "base" }));
  put(dir, "spells.json", JSON.stringify([{ id: "fire-bolt", v: variant === "changed" ? 2 : 1 }]));
  for (const [f, b] of Object.entries(extra)) put(dir, f, b);
  return dir;
}

export function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[relative(dir, p)] = sha256(readFileSync(p));
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

export const git = (dir: string, ...args: string[]) =>
  execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
/** A local bare repository standing in for the GitHub repository's `pages-state` branch. */
export function bareRepo(): string {
  const dir = tmp("remote");
  git(dir, "init", "-q", "--bare");
  return dir;
}
export const remoteHead = (remote: string): string | null => {
  try {
    return git(remote, "rev-parse", "refs/heads/pages-state");
  } catch {
    return null;
  }
};

export async function refused(fn: () => unknown, code: string): Promise<PublishError> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof PublishError && e.code === code) return e;
    throw new Error(`expected ${code}, got ${e instanceof PublishError ? e.message : String(e)}`);
  }
  throw new Error(`expected ${code}, nothing refused`);
}

export const OK_RULES: RulesetFacts = {
  pagesState: { deletion: true, nonFastForward: true },
  tags: { update: true, deletion: true },
  workflowBypass: false,
};

/**
 * FAKE GitHub Pages. `deploy` stands for upload-pages-artifact + deploy-pages: the whole site is
 * replaced by the artifact (Pages keeps no earlier files), dotfiles not served by default. Deployment
 * states and rulesets are set by the test.
 */
export class FakePages implements Witnesses {
  readonly liveDir = tmp("live");
  rules: RulesetFacts = OK_RULES;
  everSucceeded = false;
  candidate: DeploymentState = "none";
  liveError: string | null = null;
  private readonly fromDir = dirLive(this.liveDir);
  async rulesets() {
    return this.rules;
  }
  async deployments(): Promise<DeploymentFacts> {
    return { everSucceeded: this.everSucceeded, candidate: this.candidate };
  }
  async live(path: string): Promise<LiveFile> {
    if (this.liveError) return { status: "error", detail: this.liveError };
    return this.fromDir(path);
  }
  /** A deployment of `site`: `success` replaces the live site; `failure` leaves it. */
  deploy(site: string, outcome: "success" | "failure" | "in_progress" = "success") {
    this.candidate = outcome;
    if (outcome !== "success") return;
    rmSync(this.liveDir, { recursive: true, force: true });
    cpSync(site, this.liveDir, {
      recursive: true,
      filter: (src) =>
        !relative(site, src)
          .split("/")
          .some((s) => s.startsWith(".")),
    });
    this.everSucceeded = true;
  }
  /** The next publication's deployment hasn't started. */
  next() {
    this.candidate = "none";
  }
}
