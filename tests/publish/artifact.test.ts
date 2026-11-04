// @vitest-environment node
// kenli F-014 T03: the exact Pages artifact (our own deterministic tar with the hidden marker), its
// reader and pre-upload canary, transport of the archived bytes without a rebuild, and the HTTP
// smoke against a local server.

import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Archive, initialize, receipt, retry, stage } from "../../scripts/publish/archive";
import { canaryProblems, packSite, readTar, verifyTar } from "../../scripts/publish/artifact";
import { sha256 } from "../../scripts/publish/lib";
import { siteManifest } from "../../scripts/publish/site";
import { smokeSite } from "../../scripts/publish/smoke";
import {
  BASE,
  bareRepo,
  FakePages,
  makeRelease,
  makeSrd,
  put,
  refused,
  SITE_URL,
  tmp,
  tree,
} from "./helpers";

const SRD = makeSrd();
const RECEIPT = { run_id: "1", page_url: SITE_URL, artifact_digest: `sha256:${"a".repeat(64)}` };

async function archived() {
  const remote = bareRepo();
  const pages = new FakePages();
  const { anchor } = await initialize(
    { remote, workDir: join(tmp("w"), "c"), witnesses: pages },
    { base: BASE, siteUrl: SITE_URL },
  );
  const open = (fault?: (at: string) => void) =>
    Archive.open({ remote, workDir: join(tmp("w"), "c"), anchor, witnesses: pages, fault });
  return { remote, pages, open };
}
const manifestOf = (a: Archive) =>
  JSON.parse(readFileSync(join(a.dir, "site-manifest.json"), "utf8")).files;

describe("the artifact tar", () => {
  it("holds exactly the archived site, the hidden marker included, deterministically", async () => {
    const ctx = await archived();
    const A = makeRelease("a", { version: "0.2.0" });
    const a = await ctx.open();
    await stage(a, { version: "0.2.0", tagCommit: A.commit, releaseDir: A.dir, srdDir: SRD });
    const site = join(tmp("site"), "s");
    const files = a.exportSite(site);
    const t1 = join(tmp("t"), "artifact.tar");
    const t2 = join(tmp("t"), "artifact.tar");
    const p1 = packSite(site, files, t1);
    const p2 = packSite(site, files, t2);
    expect(p1.sha256).toBe(p2.sha256);
    const tar = readFileSync(t1);
    expect(verifyTar(tar, files)).toEqual([]);
    const names = readTar(tar).map((e) => e.name);
    expect(names[0]).toBe("./");
    expect(names).toContain("./.srd-table-deploy.json");
    expect(names).toContain("./content/srd-5.2.1/manifest.json");
    expect(names.filter((n) => !n.endsWith("/")).length).toBe(files.length);
    // GNU tar reads it too, and gets the same files
    const { execFileSync } = await import("node:child_process");
    const listed = execFileSync("tar", ["-tf", t1], { encoding: "utf8" }).trim().split("\n");
    expect(listed).toEqual(names);
  });

  it("refuses a file the manifest doesn't list, changed bytes, a link; verify finds every difference", async () => {
    const ctx = await archived();
    const A = makeRelease("a", { version: "0.2.0" });
    const a = await ctx.open();
    await stage(a, { version: "0.2.0", tagCommit: A.commit, releaseDir: A.dir, srdDir: SRD });
    const site = join(tmp("site"), "s");
    const files = a.exportSite(site);
    put(site, "assets/parent-canary.json", "SYNTHETIC");
    await refused(() => packSite(site, files, join(tmp("t"), "x.tar")), "artifact_invalid");
    rmSync(join(site, "assets/parent-canary.json"));
    const asset = files.find((f) => f.path.startsWith("assets/"))?.path as string;
    const good = readFileSync(join(site, asset));
    writeFileSync(join(site, asset), "tampered");
    await refused(() => packSite(site, files, join(tmp("t"), "x.tar")), "artifact_invalid");
    writeFileSync(join(site, asset), good);
    const tarPath = join(tmp("t"), "ok.tar");
    packSite(site, files, tarPath);
    const tar = readFileSync(tarPath);
    expect(verifyTar(tar, files.slice(1)).join(" ")).toMatch(/unexpected file/);
    expect(
      verifyTar(tar, [...files, { path: "assets/x.js", sha256: "0".repeat(64), size: 1 }]).join(
        " ",
      ),
    ).toMatch(/missing \.\/assets\/x\.js/);
  });

  it("the reader refuses links and other entry types; unsafe names are reported", () => {
    const linkTar = Buffer.alloc(2048, 0);
    const h = linkTar.subarray(0, 512);
    h.write("./evil", 0);
    h.write("0000644\0", 100);
    h.write("00000000000\0", 124);
    h.write("2", 156); // symlink
    h.write("/etc/passwd", 157);
    h.write("ustar\0", 257);
    h.write("        ", 148);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    expect(() => readTar(linkTar)).toThrow(/links and others refused/);
  });

  it("the canary: planted parent/private files and tracked sources are not in it", async () => {
    const ctx = await archived();
    const A = makeRelease("a", { version: "0.2.0" });
    const a = await ctx.open();
    await stage(a, { version: "0.2.0", tagCommit: A.commit, releaseDir: A.dir, srdDir: SRD });
    const site = join(tmp("site"), "s");
    const files = a.exportSite(site);
    const t = join(tmp("t"), "a.tar");
    packSite(site, files, t);
    const tar = readFileSync(t);
    const canary = {
      path: "kenli-private.json",
      bytes: Buffer.from('{"canary":"parent 1"}'),
      byName: true,
    };
    const source = { path: "src/main.tsx", bytes: readFileSync("src/main.tsx"), byName: false };
    expect(canaryProblems(tar, [canary, source])).toEqual([]);
    // if a parent file's bytes were in the site (whatever its name), the canary sees them
    const leaked = {
      path: "notes.md",
      bytes: readFileSync(join(site, "index.html")),
      byName: false,
    };
    expect(canaryProblems(tar, [leaked]).join(" ")).toMatch(
      /content of notes\.md is in the artifact/,
    );
    const byName = { path: "index.html", bytes: Buffer.from("other"), byName: true };
    expect(canaryProblems(tar, [byName]).join(" ")).toMatch(/by name/);
  });

  it("transport without a rebuild: after a lost runner, the archive's tar is the same bytes", async () => {
    const ctx = await archived();
    const A = makeRelease("a", { version: "0.2.0" });
    const a = await ctx.open((at) => {
      if (at === "after-checkpoint") throw new Error("runner lost");
    });
    await expect(
      stage(a, { version: "0.2.0", tagCommit: A.commit, releaseDir: A.dir, srdDir: SRD }),
    ).rejects.toThrow(/runner lost/);
    const first = join(tmp("site"), "s");
    const t1 = join(tmp("t"), "first.tar");
    // what the lost run had built locally, packed from its working copy (for comparison only)
    packSite(a.site, siteManifest(a.site).files, t1);
    rmSync(A.dir, { recursive: true }); // the build is gone
    const r = await ctx.open();
    expect((await retry(r, "0.2.0")).action).toBe("redeploy-pending");
    const files = r.exportSite(first);
    const t2 = join(tmp("t"), "again.tar");
    const p2 = packSite(first, files, t2);
    expect(p2.sha256).toBe(sha256(readFileSync(t1)));
    expect(verifyTar(readFileSync(t2), manifestOf(r))).toEqual([]);
    // deployed from that tar, received
    const live = tmp("live-from-tar");
    for (const e of readTar(readFileSync(t2)))
      if (e.type === "file") put(live, e.name.slice(2), e.bytes);
    ctx.pages.deploy(live);
    await receipt(await ctx.open(), "0.2.0", RECEIPT);
    expect(tree(ctx.pages.liveDir)["index.html"]).toBe(tree(first)["index.html"]);
  });
});

describe("HTTP smoke", () => {
  it("passes when every served file has its hash, fails (bounded) otherwise; the marker isn't fetched", async () => {
    const site = tmp("smoke");
    put(site, "index.html", "<html>");
    put(site, "assets/a.js", "a");
    put(site, ".srd-table-deploy.json", "{}");
    const files = siteManifest(site).files;
    let served = { "index.html": "<html>", "assets/a.js": "a" } as Record<string, string>;
    const asked: string[] = [];
    const server = createServer((req, res) => {
      const p = new URL(req.url ?? "/", "http://x").pathname.replace(/^\/srd-table\//, "");
      asked.push(p);
      if (served[p] === undefined) return void res.writeHead(404).end();
      res.writeHead(200).end(served[p]);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/srd-table/`;
    try {
      expect(await smokeSite(url, files, { rounds: 2, delayMs: 10 })).toMatchObject({
        ok: true,
        checked: 2,
      });
      expect(asked).not.toContain(".srd-table-deploy.json");
      served = { "index.html": "<html>", "assets/a.js": "b" };
      const bad = await smokeSite(url, files, { rounds: 3, delayMs: 10 });
      expect(bad).toMatchObject({ ok: false, rounds: 3 });
      expect(bad.problems).toEqual(["assets/a.js: other bytes"]);
    } finally {
      server.close();
    }
  });
});
