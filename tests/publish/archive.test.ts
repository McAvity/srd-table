// @vitest-environment node
// kenli F-014 T02: the pages-state archive on a real local bare Git repository (compare-and-swap
// pushes, fresh clones = restarts) with an explicitly FAKE GitHub/Pages (tests/publish/helpers.ts).
// Checked: pointers and bytes (archive, exported artifact, fake live), not only status JSON.

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Archive, initialize, receipt, resolve, retry, stage } from "../../scripts/publish/archive";
import { CURRENT_POINTER, json, LEGACY_POINTER, sha256 } from "../../scripts/publish/lib";
import { siteManifest } from "../../scripts/publish/site";
import {
  BASE,
  bareRepo,
  DATA4,
  DATA5,
  FakePages,
  git,
  makeRelease,
  makeSrd,
  put,
  type Rel,
  refused,
  remoteHead,
  SITE_URL,
  tmp,
  tree,
} from "./helpers";

const SRD = makeSrd();
const RECEIPT = { run_id: "4242", page_url: SITE_URL, artifact_digest: `sha256:${"a".repeat(64)}` };

async function setup() {
  const remote = bareRepo();
  const pages = new FakePages();
  const { anchor } = await initialize(
    { remote, workDir: join(tmp("w"), "c"), witnesses: pages },
    { base: BASE, siteUrl: SITE_URL },
  );
  const open = (o: { siteLimit?: number; fault?: (at: string) => void; anchor?: string } = {}) =>
    Archive.open({ remote, workDir: join(tmp("w"), "c"), anchor, witnesses: pages, ...o });
  /** publish step 1 + export: what the workflow uploads. */
  const stageRel = async (
    rel: Rel,
    o: { srd?: string; bridge?: boolean; tagCommit?: string; version?: string } = {},
  ) => {
    const a = await open();
    const r = await stage(a, {
      version: o.version ?? (rel.version as string),
      tagCommit: o.tagCommit ?? rel.commit,
      releaseDir: rel.dir,
      srdDir: o.srd ?? SRD,
      bridge: o.bridge,
    });
    const artifact = join(tmp("art"), "site");
    a.exportSite(artifact);
    return { ...r, artifact };
  };
  const ship = async (rel: Rel, o: { bridge?: boolean } = {}) => {
    const s = await stageRel(rel, o);
    pages.deploy(s.artifact, "success");
    await receipt(await open(), rel.version as string, RECEIPT);
    pages.next();
    return s;
  };
  const state = async () => (await open()).state;
  return { remote, pages, anchor, open, stageRel, ship, state };
}
const livePointer = (pages: FakePages, p: string) => {
  try {
    return JSON.parse(readFileSync(join(pages.liveDir, p), "utf8")).release_id as string;
  } catch {
    return null;
  }
};
/** Refused, and neither the archive branch nor the live site changed. */
async function unchanged(ctx: Awaited<ReturnType<typeof setup>>, fn: () => unknown, code: string) {
  const head = remoteHead(ctx.remote);
  const live = tree(ctx.pages.liveDir);
  await refused(fn, code);
  expect(remoteHead(ctx.remote)).toBe(head);
  expect(tree(ctx.pages.liveDir)).toEqual(live);
}

describe("initialize", () => {
  it("is one empty root commit, only for a new branch and an empty, never-deployed site", async () => {
    const ctx = await setup();
    expect(git(ctx.remote, "rev-list", "--parents", "-n", "1", ctx.anchor)).toBe(ctx.anchor);
    expect((await ctx.state()).versions).toEqual({});
    await refused(
      () =>
        initialize(
          { remote: ctx.remote, workDir: join(tmp("w"), "c"), witnesses: ctx.pages },
          { base: BASE, siteUrl: SITE_URL },
        ),
      "already_initialized",
    );
    const fresh = bareRepo();
    const pages = new FakePages();
    pages.everSucceeded = true;
    await refused(
      () =>
        initialize(
          { remote: fresh, workDir: join(tmp("w"), "c"), witnesses: pages },
          { base: BASE, siteUrl: SITE_URL },
        ),
      "history_lost",
    );
    const served = new FakePages();
    put(served.liveDir, "index.html", "<html>someone else</html>");
    await refused(
      () =>
        initialize(
          { remote: fresh, workDir: join(tmp("w"), "c"), witnesses: served },
          { base: BASE, siteUrl: SITE_URL },
        ),
      "live_present",
    );
    expect(remoteHead(fresh)).toBeNull();
    await refused(
      () =>
        Archive.open({ remote: ctx.remote, workDir: join(tmp("w"), "c"), witnesses: ctx.pages }),
      "anchor_required",
    );
  });
});

describe("A → B", () => {
  it("checkpoints before transport, keeps every A byte, retries without a build", async () => {
    const ctx = await setup();
    const A = makeRelease("a", { version: "0.2.0-rc.1" });
    const B = makeRelease("b", { version: "0.2.0", commit: A.commit });
    const sa = await ctx.stageRel(A);
    // the checkpoint is on the remote before anything is deployed
    let s = await ctx.state();
    expect(s.pending).toBe("0.2.0-rc.1");
    expect(tree(ctx.pages.liveDir)).toEqual({});
    ctx.pages.deploy(sa.artifact, "success");
    await receipt(await ctx.open(), "0.2.0-rc.1", RECEIPT);
    ctx.pages.next();
    const liveA = tree(ctx.pages.liveDir);
    await ctx.ship(B);
    s = await ctx.state();
    expect(s).toMatchObject({ pending: null, served: "0.2.0" });
    expect(s.versions["0.2.0-rc.1"]?.status).toBe("deployed");
    expect(s.versions["0.2.0"]?.status).toBe("deployed");
    expect(s.versions["0.2.0"]?.receipt?.state_commit).toMatch(/^[0-9a-f]{40}$/);
    const liveB = tree(ctx.pages.liveDir);
    for (const [p, h] of Object.entries(liveA))
      if (!["index.html", LEGACY_POINTER, CURRENT_POINTER, "releases/index.json"].includes(p))
        expect(liveB[p], p).toBe(h);
    expect(livePointer(ctx.pages, LEGACY_POINTER)).toBe(B.id);
    // retry the newest: verified, no write; retry the older one: no pointer moves
    const head = remoteHead(ctx.remote);
    const a = await ctx.open();
    expect((await retry(a, "0.2.0")).action).toBe("already-deployed");
    const again = join(tmp("art"), "site");
    a.exportSite(again);
    expect(tree(again)).toEqual(tree(a.site));
    expect((await retry(await ctx.open(), "0.2.0-rc.1")).action).toBe("historical-verified");
    expect(remoteHead(ctx.remote)).toBe(head);
    expect(tree(ctx.pages.liveDir)).toEqual(liveB);
    await refused(async () => retry(await ctx.open(), "0.3.0"), "version_unknown");
  });

  it("legacy/current/bridge through the archive, and no database downgrade", async () => {
    const ctx = await setup();
    await ctx.ship(makeRelease("a4", { version: "0.1.0", data: DATA4 }));
    await unchanged(
      ctx,
      () => ctx.stageRel(makeRelease("b5", { version: "0.2.0", data: DATA5 })),
      "bridge_required",
    );
    const B0 = makeRelease("b0", { version: "0.1.1", data: DATA4 });
    await ctx.ship(B0, { bridge: true });
    const B1 = makeRelease("b1", { version: "0.2.0", data: DATA5 });
    await ctx.ship(B1);
    expect(livePointer(ctx.pages, LEGACY_POINTER)).toBe(B0.id);
    expect(livePointer(ctx.pages, CURRENT_POINTER)).toBe(B1.id);
    await unchanged(
      ctx,
      () => ctx.stageRel(makeRelease("c4", { version: "0.3.0", data: DATA4 })),
      "release_downgrade",
    );
  });
});

describe("collisions: number, tag, config, content", () => {
  it("are refused without touching the archive or the site", async () => {
    const ctx = await setup();
    const A = makeRelease("a", { version: "0.2.0" });
    await ctx.ship(A);
    await unchanged(ctx, () => ctx.stageRel(A), "version_reserved");
    await unchanged(
      ctx,
      () => ctx.stageRel(makeRelease("a-other", { version: "0.2.0" })),
      "version_conflict",
    );
    await unchanged(
      ctx,
      () => ctx.stageRel(makeRelease("old", { version: "0.1.9" })),
      "version_not_newer",
    );
    await unchanged(
      ctx,
      () => ctx.stageRel(makeRelease("rc3", { version: "0.2.0-rc.3" })),
      "version_not_newer",
    );
    const C = makeRelease("c", { version: "0.2.1" });
    await unchanged(ctx, () => ctx.stageRel(C, { tagCommit: "f".repeat(40) }), "tag_mismatch");
    await unchanged(
      ctx,
      () => ctx.stageRel(makeRelease("dnd", { version: "0.2.1", base: "/dnd/" })),
      "config_changed",
    );
    await unchanged(
      ctx,
      () => ctx.stageRel(makeRelease("nonum", { commit: C.commit }), { version: "0.2.1" }),
      "version_mismatch",
    );
    await unchanged(ctx, () => ctx.stageRel(C, { srd: makeSrd("changed") }), "content_conflict");
    await unchanged(ctx, () => ctx.stageRel(C, { srd: tmp("nosrd") }), "srd_missing");
    // and the same C, unchanged, still goes through
    await ctx.ship(C);
    expect(livePointer(ctx.pages, LEGACY_POINTER)).toBe(C.id);
  });

  it("a pending version must be settled before another; the size guard refuses", async () => {
    const ctx = await setup();
    await ctx.stageRel(makeRelease("p", { version: "0.2.0" }));
    await unchanged(
      ctx,
      () => ctx.stageRel(makeRelease("q", { version: "0.3.0" })),
      "pending_unresolved",
    );
    const ctx2 = await setup();
    await unchanged(
      ctx2,
      async () =>
        stage(await ctx2.open({ siteLimit: 100 }), {
          version: "0.2.0",
          tagCommit: makeRelease("big", { version: "0.2.0" }).commit,
          releaseDir: makeRelease("big", { version: "0.2.0" }).dir,
          srdDir: SRD,
        }),
      "site_too_large",
    );
  });
});

describe("concurrency, restarts and faults", () => {
  it("compare-and-swap: a publication on a stale head is refused", async () => {
    const ctx = await setup();
    const a1 = await ctx.open();
    const a2 = await ctx.open();
    const A = makeRelease("a", { version: "0.2.0" });
    const r = await stage(a1, {
      version: "0.2.0",
      tagCommit: A.commit,
      releaseDir: A.dir,
      srdDir: SRD,
    });
    const B = makeRelease("b", { version: "0.3.0" });
    await unchanged(
      ctx,
      () => stage(a2, { version: "0.3.0", tagCommit: B.commit, releaseDir: B.dir, srdDir: SRD }),
      "state_conflict",
    );
    expect(remoteHead(ctx.remote)).toBe(r.checkpoint);
  });

  it("killed before the checkpoint or before its push: nothing reserved, nothing live", async () => {
    for (const point of ["before-checkpoint", "before-push"]) {
      const ctx = await setup();
      const A = makeRelease("a", { version: "0.2.0" });
      const head = remoteHead(ctx.remote);
      const a = await ctx.open({
        fault: (at) => {
          if (at === point) throw new Error(`killed ${at}`);
        },
      });
      await expect(
        stage(a, { version: "0.2.0", tagCommit: A.commit, releaseDir: A.dir, srdDir: SRD }),
      ).rejects.toThrow(/killed/);
      expect(remoteHead(ctx.remote)).toBe(head);
      expect((await ctx.state()).versions).toEqual({});
      await ctx.ship(A);
    }
  });

  it("killed after the checkpoint: a new run redeploys the archived bytes, never a build", async () => {
    const ctx = await setup();
    const A = makeRelease("a", { version: "0.2.0" });
    const a = await ctx.open({
      fault: (at) => {
        if (at === "after-checkpoint") throw new Error("runner lost");
      },
    });
    await expect(
      stage(a, { version: "0.2.0", tagCommit: A.commit, releaseDir: A.dir, srdDir: SRD }),
    ).rejects.toThrow(/runner lost/);
    rmSync(A.dir, { recursive: true }); // the build is gone with the runner
    const r = await ctx.open();
    expect((await retry(r, "0.2.0")).action).toBe("redeploy-pending");
    const artifact = join(tmp("art"), "site");
    r.exportSite(artifact);
    const rec = r.record("0.2.0");
    expect(Object.entries(tree(artifact)).sort()).toEqual(
      rec.site.files.map((f) => [f.path, f.sha256]).sort(),
    );
    ctx.pages.deploy(artifact);
    // killed again after the deployment, before the receipt: the receipt in a new run
    const done = await receipt(await ctx.open(), "0.2.0", RECEIPT);
    expect(remoteHead(ctx.remote)).toBe(done.commit);
    expect((await ctx.state()).served).toBe("0.2.0");
  });
});

describe("resolve (R01-04, R02-01)", () => {
  it("abandoned: never deployed and live is the previous site; only root/pointers/marker go back", async () => {
    const ctx = await setup();
    const A = makeRelease("a", { version: "0.2.0" });
    await ctx.ship(A);
    const liveA = tree(ctx.pages.liveDir);
    const B = makeRelease("b", { version: "0.3.0" });
    await ctx.stageRel(B);
    ctx.pages.candidate = "none";
    const { outcome } = await resolve(await ctx.open(), "0.3.0");
    expect(outcome).toBe("abandoned");
    const a = await ctx.open();
    expect(a.state).toMatchObject({ pending: null, served: "0.2.0" });
    expect(a.state.versions["0.3.0"]?.status).toBe("abandoned");
    // archive: root and pointers are A's again; B's immutable files and record kept
    expect(JSON.parse(readFileSync(join(a.site, LEGACY_POINTER), "utf8")).release_id).toBe(A.id);
    expect(readFileSync(join(a.site, "index.html"))).toEqual(
      readFileSync(join(A.dir, "index.html")),
    );
    for (const f of a.record("0.3.0").release_files)
      expect(sha256(readFileSync(join(a.site, f.path)))).toBe(f.sha256);
    expect(tree(ctx.pages.liveDir)).toEqual(liveA);
    // the number stays reserved with its bytes; a higher one follows
    await unchanged(ctx, () => ctx.stageRel(B), "version_reserved");
    await unchanged(
      ctx,
      () => ctx.stageRel(makeRelease("b2", { version: "0.3.0" })),
      "version_conflict",
    );
    const C = makeRelease("c", { version: "0.3.1" });
    await ctx.ship(C);
    expect(livePointer(ctx.pages, LEGACY_POINTER)).toBe(C.id);
    expect((await retry(await ctx.open(), "0.3.0")).action).toBe("historical-verified");
  });

  it("abandoned first candidate: the site goes back to no root and no pointers", async () => {
    const ctx = await setup();
    await ctx.stageRel(makeRelease("a", { version: "0.2.0" }));
    ctx.pages.candidate = "failure";
    expect((await resolve(await ctx.open(), "0.2.0")).outcome).toBe("abandoned");
    const a = await ctx.open();
    expect(tree(a.site)["index.html"]).toBeUndefined();
    expect(tree(a.site)[LEGACY_POINTER]).toBeUndefined();
    await ctx.ship(makeRelease("b", { version: "0.2.1" }));
  });

  it("observed-unverified: the candidate is live (smoke failed); kept, data direction kept", async () => {
    const ctx = await setup();
    await ctx.ship(makeRelease("a", { version: "0.2.0", data: DATA5 }));
    const B = makeRelease("b", { version: "0.3.0", data: DATA5 });
    const sb = await ctx.stageRel(B);
    ctx.pages.deploy(sb.artifact, "success"); // served, but no receipt (smoke failed)
    expect((await resolve(await ctx.open(), "0.3.0")).outcome).toBe("observed-unverified");
    const s = await ctx.state();
    expect(s).toMatchObject({ pending: null, served: "0.3.0" });
    expect(livePointer(ctx.pages, LEGACY_POINTER)).toBe(B.id);
    ctx.pages.next();
    await unchanged(
      ctx,
      () => ctx.stageRel(makeRelease("c4", { version: "0.3.1", data: DATA4 })),
      "release_downgrade",
    );
    await ctx.ship(makeRelease("c", { version: "0.3.1", data: DATA5 }));
  });

  it("R03-02: the first release live under a failed status → observed-unverified → a higher fix", async () => {
    const ctx = await setup();
    const A = makeRelease("first", { version: "0.2.0", data: DATA5 });
    const sa = await ctx.stageRel(A);
    // Pages serves it, but the job/smoke failed and github-pages records no success at all
    ctx.pages.deploy(sa.artifact, "success");
    ctx.pages.everSucceeded = false;
    ctx.pages.candidate = "failure";
    expect((await resolve(await ctx.open(), "0.2.0")).outcome).toBe("observed-unverified");
    const s = await ctx.state();
    expect(s).toMatchObject({ served: "0.2.0", pending: null });
    expect(s.versions["0.2.0"]?.resolution?.deployment).toBe("failure");
    expect(s.versions["0.2.0"]?.resolution?.live[LEGACY_POINTER]).toMatch(/^sha256:/);
    // the live evidence still has to hold: a missing or unreadable live site is refused
    const live = tree(ctx.pages.liveDir);
    ctx.pages.liveError = "HTTP 502";
    await unchanged(
      ctx,
      () => ctx.stageRel(makeRelease("x", { version: "0.2.1" })),
      "live_unavailable",
    );
    ctx.pages.liveError = null;
    rmSync(ctx.pages.liveDir, { recursive: true });
    await refused(() => ctx.stageRel(makeRelease("x", { version: "0.2.1" })), "live_missing");
    ctx.pages.deploy(sa.artifact, "success");
    ctx.pages.everSucceeded = false;
    expect(tree(ctx.pages.liveDir)).toEqual(live);
    // no database downgrade from it, no lower or equal number
    await unchanged(
      ctx,
      () => ctx.stageRel(makeRelease("down", { version: "0.2.1", data: DATA4 })),
      "release_downgrade",
    );
    await unchanged(
      ctx,
      () => ctx.stageRel(makeRelease("same", { version: "0.2.0" })),
      "version_conflict",
    );
    // the forward fix goes through
    ctx.pages.candidate = "none";
    const B = makeRelease("fix", { version: "0.2.1", data: DATA5 });
    await ctx.ship(B);
    expect(livePointer(ctx.pages, LEGACY_POINTER)).toBe(B.id);
    // R04-01: years later github-pages keeps the deployments but no retained success: a confirmed
    // receipt is held to the live site, not refused for ever
    ctx.pages.everSucceeded = false;
    ctx.pages.candidate = "none";
    await ctx.ship(makeRelease("c", { version: "0.2.2" }));
  });

  it("a deployment still running, success with the old live, or a mixed live: refused", async () => {
    const ctx = await setup();
    await ctx.ship(makeRelease("a", { version: "0.2.0" }));
    const B = makeRelease("b", { version: "0.3.0" });
    const sb = await ctx.stageRel(B);
    for (const st of ["queued", "in_progress"] as const) {
      ctx.pages.candidate = st;
      await unchanged(
        ctx,
        async () => resolve(await ctx.open(), "0.3.0"),
        "deployment_in_progress",
      );
    }
    ctx.pages.candidate = "success"; // reported, but live still the previous site
    await unchanged(ctx, async () => resolve(await ctx.open(), "0.3.0"), "live_ambiguous");
    ctx.pages.candidate = "failure";
    const live = tree(ctx.pages.liveDir);
    writeFileSync(
      join(ctx.pages.liveDir, LEGACY_POINTER),
      readFileSync(join(sb.artifact, LEGACY_POINTER)),
    );
    await unchanged(ctx, async () => resolve(await ctx.open(), "0.3.0"), "live_ambiguous");
    writeFileSync(
      join(ctx.pages.liveDir, LEGACY_POINTER),
      readFileSync(join(sb.artifact, LEGACY_POINTER))
        .toString()
        .replace(B.id, "r-0000000000000000"),
    );
    rmSync(join(ctx.pages.liveDir, LEGACY_POINTER));
    ctx.pages.liveError = "HTTP 503";
    await unchanged(ctx, async () => resolve(await ctx.open(), "0.3.0"), "live_unavailable");
    ctx.pages.liveError = null;
    // the deployment finishes: the candidate is live → observed-unverified
    ctx.pages.deploy(sb.artifact, "success");
    expect(Object.keys(live).length).toBeGreaterThan(0);
    expect((await resolve(await ctx.open(), "0.3.0")).outcome).toBe("observed-unverified");
  });
});

describe("history and witnesses", () => {
  it("a reset to an older descendant of the anchor, with B live, is refused", async () => {
    const ctx = await setup();
    await ctx.ship(makeRelease("a", { version: "0.2.0" }));
    const afterA = remoteHead(ctx.remote) as string;
    await ctx.ship(makeRelease("b", { version: "0.3.0" }));
    const afterB = remoteHead(ctx.remote) as string;
    git(ctx.remote, "update-ref", "refs/heads/pages-state", afterA); // a consistent older state
    await refused(() => ctx.stageRel(makeRelease("c", { version: "0.4.0" })), "history_rollback");
    await refused(async () => retry(await ctx.open(), "0.2.0"), "history_rollback");
    expect(remoteHead(ctx.remote)).toBe(afterA);
    git(ctx.remote, "update-ref", "refs/heads/pages-state", afterB);
    await ctx.ship(makeRelease("c", { version: "0.4.0" }));
  });

  it("a deleted, emptied or replaced history is refused, never recreated", async () => {
    const ctx = await setup();
    await ctx.ship(makeRelease("a", { version: "0.2.0" }));
    const head = remoteHead(ctx.remote) as string;
    git(ctx.remote, "update-ref", "-d", "refs/heads/pages-state");
    await refused(() => ctx.open(), "history_missing");
    git(ctx.remote, "update-ref", "refs/heads/pages-state", ctx.anchor); // back to the empty anchor
    await refused(() => ctx.stageRel(makeRelease("b", { version: "0.3.0" })), "history_lost");
    git(ctx.remote, "update-ref", "-d", "refs/heads/pages-state");
    const pages = new FakePages(); // someone initializes a new history (a witness that never deployed)
    await initialize(
      {
        remote: ctx.remote,
        workDir: join(tmp("w"), "c"),
        witnesses: pages,
        // another author: a different root commit (same content and second would be the same SHA)
        identity: { name: "someone else", email: "else@example.invalid" },
      },
      { base: BASE, siteUrl: SITE_URL },
    );
    await refused(() => ctx.open(), "history_foreign");
    git(ctx.remote, "update-ref", "refs/heads/pages-state", head);
    await ctx.ship(makeRelease("b", { version: "0.3.0" }));
  });

  it("missing rulesets, an unavailable or missing live site, disagreeing deployments: refused", async () => {
    const ctx = await setup();
    await ctx.ship(makeRelease("a", { version: "0.2.0" }));
    const B = makeRelease("b", { version: "0.3.0" });
    ctx.pages.rules = { ...ctx.pages.rules, pagesState: { deletion: true, nonFastForward: false } };
    await unchanged(ctx, () => ctx.stageRel(B), "ruleset_missing");
    ctx.pages.rules = {
      ...ctx.pages.rules,
      pagesState: { deletion: true, nonFastForward: true },
      workflowBypass: true,
    };
    await unchanged(ctx, () => ctx.stageRel(B), "ruleset_missing");
    ctx.pages.rules = { ...ctx.pages.rules, workflowBypass: false };
    ctx.pages.liveError = "ECONNRESET";
    await unchanged(ctx, () => ctx.stageRel(B), "live_unavailable");
    ctx.pages.liveError = null;
    const live = tree(ctx.pages.liveDir);
    rmSync(ctx.pages.liveDir, { recursive: true });
    await refused(() => ctx.stageRel(B), "live_missing");
    // a garbage live site is not the archive's history; an archive claiming a served version while
    // the site serves nothing is refused by the live witness (no API "success" needed)
    for (const p of Object.keys(live)) put(ctx.pages.liveDir, p, "x");
    await refused(() => ctx.stageRel(B), "history_rollback");
  });

  it("an archive byte off its manifest is refused", async () => {
    const ctx = await setup();
    await ctx.ship(makeRelease("a", { version: "0.2.0" }));
    const a = await ctx.open();
    const f = Object.keys(tree(a.site)).find((p) => p.startsWith("assets/")) as string;
    writeFileSync(join(a.site, f), "tampered");
    git(a.dir, "-c", "user.name=x", "-c", "user.email=x@x", "commit", "-qam", "tamper");
    git(a.dir, "push", "-q", "origin", "HEAD:refs/heads/pages-state");
    await refused(() => ctx.open(), "archive_invalid");
  });
});

describe("R03-04 / D014-001: the archive and the artifact hold only owned files", () => {
  const CANARY = "SYNTHETIC_PARENT_CANARY_DO_NOT_PUBLISH";
  /** Commit a change to site/ with a consistent site-manifest.json and state hash (a forged archive). */
  async function forge(ctx: Awaited<ReturnType<typeof setup>>, change: (site: string) => void) {
    const a = await ctx.open();
    change(a.site);
    const m = siteManifest(a.site);
    const mf = json({ format: "srd-table.site-manifest/1", ...m });
    writeFileSync(join(a.dir, "site-manifest.json"), mf);
    const state = JSON.parse(readFileSync(join(a.dir, "state.json"), "utf8"));
    writeFileSync(join(a.dir, "state.json"), json({ ...state, site_manifest_sha256: sha256(mf) }));
    git(a.dir, "add", "-A");
    git(a.dir, "-c", "user.name=x", "-c", "user.email=x@x", "commit", "-qm", "forge");
    git(a.dir, "push", "-q", "origin", "HEAD:refs/heads/pages-state");
  }

  it.each([
    ["assets/parent-canary.json"],
    ["sw-r-0123456789abcdef.js"],
    ["releases/r-0123456789abcdef/index.html"],
    ["content/srd-5.2.1/kenli-character.json"],
  ])("an orphan %s listed in the full site manifest is refused", async (path) => {
    const ctx = await setup();
    await ctx.ship(makeRelease("a", { version: "0.2.0" }));
    await forge(ctx, (site) => put(site, path, CANARY));
    await refused(() => ctx.open(), "archive_invalid");
  });

  it("an SRD manifest rewritten to name a parent file is refused by the version records", async () => {
    const ctx = await setup();
    await ctx.ship(makeRelease("a", { version: "0.2.0" }));
    await forge(ctx, (site) => {
      const p = join(site, "content/srd-5.2.1/manifest.json");
      const m = JSON.parse(readFileSync(p, "utf8"));
      m.tables.k = { file: "kenli.json" };
      writeFileSync(p, JSON.stringify(m));
      put(site, "content/srd-5.2.1/kenli.json", CANARY);
    });
    const e = await refused(() => ctx.open(), "archive_invalid");
    expect(e.message).toMatch(/no version owns: .*content\/srd-5\.2\.1\/kenli\.json/);
  });

  it("export refuses a file that appeared after the archive was verified; nothing exported", async () => {
    const ctx = await setup();
    await ctx.ship(makeRelease("a", { version: "0.2.0" }));
    const a = await ctx.open();
    put(a.site, "assets/parent-canary.json", CANARY);
    const out = join(tmp("art"), "site");
    await refused(() => a.exportSite(out), "export_invalid");
    expect(existsSync(out)).toBe(false);
    // the valid archive still exports exactly its owned files
    const b = await ctx.open();
    const ok = join(tmp("art"), "site");
    const files = b.exportSite(ok);
    const owned = b.recordedPaths();
    expect(files.every((f) => owned.has(f.path))).toBe(true);
    expect(Object.keys(tree(ok)).sort()).toEqual(files.map((f) => f.path).sort());
  });
});
