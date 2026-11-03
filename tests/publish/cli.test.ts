// @vitest-environment node
// kenli F-014 T02: the live witness over real HTTP (a local server: no cache, 404 = absent, any other
// failure = error) and the command line end to end on a local bare repository (initialize → publish
// → fake deploy → receipt → verify → retry), with `--facts` and `--live-dir` (explicitly fake).

import { spawnSync } from "node:child_process";
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { httpLive } from "../../scripts/publish/witness";
import { BASE, bareRepo, makeRelease, makeSrd, OK_RULES, remoteHead, tmp, tree } from "./helpers";

describe("httpLive", () => {
  it("reads past caches; 404 is absent, anything else an error", async () => {
    const seen: { url: string; headers: IncomingHttpHeaders }[] = [];
    const server = createServer((req, res) => {
      seen.push({ url: req.url ?? "", headers: req.headers });
      if (req.url?.startsWith("/srd-table/index.html")) res.writeHead(200).end("<html>");
      else if (req.url?.startsWith("/srd-table/release.json")) res.writeHead(503).end();
      else res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as { port: number };
    try {
      const live = httpLive(`http://127.0.0.1:${port}/srd-table/`);
      const ok = await live("index.html");
      expect(ok.status === "ok" && ok.bytes.toString()).toBe("<html>");
      expect((await live("release-current.json")).status).toBe("absent");
      expect(await live("release.json")).toEqual({ status: "error", detail: "HTTP 503" });
      await live("index.html");
      expect(seen[0]?.headers["cache-control"]).toBe("no-cache");
      expect(new Set(seen.map((s) => s.url)).size).toBe(seen.length); // a unique query each read
    } finally {
      server.close();
    }
    const down = httpLive(`http://127.0.0.1:${port}/srd-table/`);
    expect((await down("index.html")).status).toBe("error");
    expect(() => httpLive("https://example.invalid/srd-table")).toThrow(/config_invalid/);
  });
});

const tsx = join(process.cwd(), "node_modules/.bin/tsx");
const cli = (args: string[]) => {
  const r = spawnSync(tsx, [join(process.cwd(), "scripts/publish/cli.ts"), ...args], {
    encoding: "utf8",
  });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
};

describe("cli", () => {
  it("initialize, publish, receipt, verify, retry and a refusal", () => {
    const remote = bareRepo();
    const live = tmp("live");
    const facts = join(tmp("facts"), "facts.json");
    const writeFacts = (everSucceeded: boolean, candidate: string) =>
      writeFileSync(
        facts,
        JSON.stringify({ rulesets: OK_RULES, deployments: { everSucceeded, candidate } }),
      );
    writeFacts(false, "none");
    const common = (work: string) => [
      "--remote",
      remote,
      "--work",
      join(tmp("w"), work),
      "--facts",
      facts,
      "--live-dir",
      live,
    ];
    const init = cli([
      "initialize",
      ...common("i"),
      "--base",
      BASE,
      "--site-url",
      "https://example.invalid/srd-table/",
    ]);
    expect(init.code, init.err).toBe(0);
    const anchor = JSON.parse(init.out).anchor as string;
    const A = makeRelease("cli-a", { version: "0.2.0-rc.1" });
    const site = join(tmp("art"), "site");
    const pub = cli([
      "publish",
      ...common("p"),
      "--anchor",
      anchor,
      "--version",
      "0.2.0-rc.1",
      "--tag-commit",
      A.commit,
      "--release",
      A.dir,
      "--srd",
      makeSrd(),
      "--site-out",
      site,
    ]);
    expect(pub.code, pub.err).toBe(0);
    expect(JSON.parse(pub.out)).toMatchObject({ version: "0.2.0-rc.1", release_id: A.id });
    expect(readFileSync(join(site, ".srd-table-deploy.json"), "utf8")).toContain(
      '"version": "0.2.0-rc.1"',
    );
    cpSync(site, live, { recursive: true }); // the (fake) Pages deployment
    writeFacts(true, "success");
    const rc = cli([
      "receipt",
      ...common("r"),
      "--anchor",
      anchor,
      "--version",
      "0.2.0-rc.1",
      "--run-id",
      "77",
      "--page-url",
      "https://example.invalid/srd-table/",
      "--artifact-digest",
      "b".repeat(64),
    ]);
    expect(rc.code, rc.err).toBe(0);
    const verify = cli(["verify", ...common("v"), "--anchor", anchor]);
    expect(verify.code, verify.err).toBe(0);
    expect(JSON.parse(verify.out).state).toMatchObject({ served: "0.2.0-rc.1", pending: null });
    const head = remoteHead(remote);
    const again = join(tmp("art"), "site");
    const retry = cli([
      "retry",
      ...common("t"),
      "--anchor",
      anchor,
      "--version",
      "0.2.0-rc.1",
      "--site-out",
      again,
    ]);
    expect(retry.code, retry.err).toBe(0);
    expect(JSON.parse(retry.out).action).toBe("already-deployed");
    expect(tree(again)).toEqual(tree(site));
    expect(remoteHead(remote)).toBe(head);
    const old = cli([
      "publish",
      ...common("o"),
      "--anchor",
      anchor,
      "--version",
      "0.1.0",
      "--tag-commit",
      A.commit,
      "--release",
      makeRelease("cli-o", { version: "0.1.0", commit: A.commit }).dir,
      "--srd",
      makeSrd(),
      "--site-out",
      join(tmp("art"), "site"),
    ]);
    expect(old.code).toBe(1);
    expect(old.err).toMatch(/^publish refused: version_not_newer/);
    expect(remoteHead(remote)).toBe(head);
  }, 60_000);
});
