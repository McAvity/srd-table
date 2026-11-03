/**
 * kenli F-014 T02: a rehearsal of two real releases A → B through the whole publisher, locally:
 * a bare Git repository as the GitHub repository (real compare-and-swap pushes, a fresh clone per
 * step), and a FAKE Pages host — a directory replaced wholesale by each "deployment" (as Pages
 * replaces the site by the artifact; dotfiles not served) and served over real HTTP under the base,
 * read by `httpLive`. Rulesets and deployment states are stated facts, not GitHub's. B is staged
 * with the runner "lost" after its checkpoint and redeployed from the archive (no build).
 *
 *   tsx scripts/publish/rehearse.ts --a REL_A --b REL_B --srd SRD_DIR --work NEW_DIR --report r.json
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { join, relative, resolve as resolvePath } from "node:path";
import { parseArgs } from "node:util";
import { Archive, initialize, receipt, retry, stage } from "./archive";
import { CURRENT_POINTER, fail, jcs, LEGACY_POINTER, MANIFEST, sha256 } from "./lib";
import { readStaging, siteManifest } from "./site";
import { type DeploymentState, httpLive, type Witnesses } from "./witness";

const { values } = parseArgs({
  options: {
    a: { type: "string" },
    b: { type: "string" },
    srd: { type: "string" },
    work: { type: "string" },
    report: { type: "string" },
  },
});
const need = (k: keyof typeof values) =>
  resolvePath((values[k] as string | undefined) ?? fail("usage", `--${k}`));
const work = need("work");
if (existsSync(work)) fail("usage", `${work} exists`);
mkdirSync(work, { recursive: true });
const BASE = "/srd-table/";
const remote = join(work, "remote.git");
const live = join(work, "pages");
mkdirSync(live);
const { execFileSync } = await import("node:child_process");
execFileSync("git", ["init", "-q", "--bare", remote]);

// the FAKE Pages host over real HTTP
const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
  if (!path.startsWith(BASE)) return void res.writeHead(404).end();
  const rel = path.slice(BASE.length) || "index.html";
  const file = join(live, rel);
  if (
    rel.split("/").some((s) => s.startsWith(".") || s === "") ||
    !existsSync(file) ||
    statSync(file).isDirectory()
  )
    return void res.writeHead(404).end();
  res.writeHead(200, { "cache-control": "max-age=600" }).end(readFileSync(file));
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const facts = { everSucceeded: false, deployments: 0, candidate: "none" as DeploymentState };
const witnesses: Witnesses = {
  rulesets: async () => ({
    pagesState: { deletion: true, nonFastForward: true },
    tags: { update: true, deletion: true },
    workflowBypass: false,
  }),
  deployments: async () => ({ ...facts }),
  live: httpLive(`${origin}${BASE}`),
};
const deploy = (site: string) => {
  rmSync(live, { recursive: true, force: true });
  cpSync(site, live, {
    recursive: true,
    filter: (s) =>
      !relative(site, s)
        .split("/")
        .some((x) => x.startsWith(".")),
  });
  facts.candidate = "success";
  facts.everSucceeded = true;
  facts.deployments++;
};
let n = 0;
const open = (fault?: (at: string) => void) =>
  Archive.open({ remote, workDir: join(work, `clone-${n++}`), anchor, witnesses, fault });
const fetchLive = async (p: string) => {
  const r = await fetch(`${origin}${BASE}${p}?n=${n++}`, { cache: "no-store" });
  return r.ok ? Buffer.from(await r.arrayBuffer()) : null;
};

const steps: Record<string, unknown>[] = [];
const { anchor } = await initialize(
  { remote, workDir: join(work, "clone-init"), witnesses },
  { base: BASE, siteUrl: "https://mcavity.github.io/srd-table/" },
);
steps.push({ step: "initialize", anchor });
try {
  const releases = [need("a"), need("b")].map((dir) => ({ dir, d: readStaging(dir).descriptor }));
  for (const [i, { dir, d }] of releases.entries()) {
    const version = d.inputs.app_version ?? fail("usage", `${dir} has no app_version`);
    facts.candidate = "none";
    let artifact = join(work, `artifact-${version}`);
    if (i === 0) {
      const a = await open();
      const r = await stage(a, {
        version,
        tagCommit: d.inputs.table_commit,
        releaseDir: dir,
        srdDir: need("srd"),
      });
      a.exportSite(artifact);
      steps.push({ step: "stage", ...r });
    } else {
      // the runner is lost right after the checkpoint: a new run takes the archived bytes
      const a = await open((at) => {
        if (at === "after-checkpoint") throw new Error("runner lost");
      });
      await stage(a, {
        version,
        tagCommit: d.inputs.table_commit,
        releaseDir: dir,
        srdDir: need("srd"),
      }).then(
        () => fail("rehearsal", "the fault did not fire"),
        (e: Error) => steps.push({ step: "stage", version, interrupted: e.message }),
      );
      const r = await open();
      const rr = await retry(r, version);
      artifact = join(work, `artifact-${version}-retry`);
      r.exportSite(artifact);
      const rec = r.record(version);
      steps.push({
        step: "retry",
        version,
        ...rr,
        exported_matches_record: true,
        files: rec.site.files.length,
      });
    }
    deploy(artifact);
    const rc = await receipt(await open(), version, {
      run_id: String(1000 + i),
      page_url: "https://mcavity.github.io/srd-table/",
      // stands for the Pages artifact digest: the hash of the uploaded files' manifest
      artifact_digest: sha256(jcs(siteManifest(artifact).files)),
    });
    steps.push({ step: "receipt", version, commit: rc.commit });
  }
  // over HTTP: every file of A's checkpoint (except the mutable ones) still served byte-exact after B
  const final = await open();
  const [A, B] = releases.map(({ d }) => final.record(d.inputs.app_version as string)) as [
    ReturnType<typeof final.record>,
    ReturnType<typeof final.record>,
  ];
  const mutable = new Set([
    "index.html",
    LEGACY_POINTER,
    CURRENT_POINTER,
    MANIFEST,
    ".srd-table-deploy.json",
  ]);
  let checked = 0;
  for (const f of A.site.files.filter((x) => !mutable.has(x.path))) {
    const b = await fetchLive(f.path);
    if (!b || sha256(b) !== f.sha256) fail("rehearsal", `A's ${f.path} not kept`);
    checked++;
  }
  const ptr = JSON.parse(((await fetchLive(LEGACY_POINTER)) ?? Buffer.from("{}")).toString());
  if (ptr.release_id !== B.release_id) fail("rehearsal", "live pointer is not B");
  const head = execFileSync("git", ["-C", remote, "rev-parse", "refs/heads/pages-state"], {
    encoding: "utf8",
  }).trim();
  const rA = await retry(await open(), A.version);
  const rB = await retry(await open(), B.version);
  const headAfter = execFileSync("git", ["-C", remote, "rev-parse", "refs/heads/pages-state"], {
    encoding: "utf8",
  }).trim();
  if (head !== headAfter) fail("rehearsal", "a retry wrote to pages-state");
  const report = {
    fake: "Pages host = local directory over HTTP; rulesets/deployments stated facts; GitHub not used",
    origin,
    anchor,
    steps,
    a: {
      version: A.version,
      release_id: A.release_id,
      site_files: A.site.files.length,
      site_bytes: A.site.total_bytes,
    },
    b: {
      version: B.version,
      release_id: B.release_id,
      site_files: B.site.files.length,
      site_bytes: B.site.total_bytes,
    },
    a_files_served_byte_exact_after_b: checked,
    live_pointer: ptr.release_id,
    retry: {
      [A.version]: rA.action,
      [B.version]: rB.action,
      pages_state_unchanged: head === headAfter,
    },
    final_state: final.state,
    pages_state_head: head,
  };
  if (values.report)
    writeFileSync(resolvePath(values.report), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
} finally {
  server.close();
}
