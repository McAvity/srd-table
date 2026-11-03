// @vitest-environment node
// kenli F-014 T02: the live witness over real HTTP (a local server: no cache, 404 = absent, any other
// failure = error) and the command line end to end on a local bare repository (initialize → publish
// → fake deploy → receipt → verify → retry), with `--facts` and `--live-dir` (explicitly fake).

import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { createServer as createHttpsServer } from "node:https";
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
        JSON.stringify({
          rulesets: OK_RULES,
          deployments: { everSucceeded, deployments: everSucceeded ? 1 : 0, candidate },
        }),
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

/** The CLI as a child process, without blocking this process (the local HTTPS server answers it). */
function cliAsync(args: string[], env: Record<string, string>) {
  return new Promise<{ code: number | null; out: string; err: string }>((done) => {
    const child = spawn(tsx, [join(process.cwd(), "scripts/publish/cli.ts"), ...args], {
      env: { ...process.env, ...env },
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (b) => {
      out += b;
    });
    child.stderr.on("data", (b) => {
      err += b;
    });
    child.on("close", (code) => done({ code, out: out.trim(), err: err.trim() }));
  });
}

describe("cli over HTTPS (R03-01: the default live reader, no --live-dir)", () => {
  it("initialize, publish, receipt and verify read the site URL of the archive over HTTPS", async () => {
    const certDir = tmp("cert");
    const openssl = spawnSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "1",
        "-subj",
        "/CN=127.0.0.1",
        "-addext",
        "subjectAltName=IP:127.0.0.1",
        "-keyout",
        join(certDir, "key.pem"),
        "-out",
        join(certDir, "cert.pem"),
      ],
      { encoding: "utf8" },
    );
    expect(openssl.status, openssl.stderr).toBe(0);
    const live = tmp("https-live");
    const requests: string[] = [];
    const server = createHttpsServer(
      {
        key: readFileSync(join(certDir, "key.pem")),
        cert: readFileSync(join(certDir, "cert.pem")),
      },
      (req, res) => {
        const path = new URL(req.url ?? "/", "https://x").pathname;
        requests.push(req.url ?? "");
        const file = join(live, path.replace(/^\/srd-table\//, ""));
        if (!path.startsWith("/srd-table/") || !existsSync(file) || statSync(file).isDirectory())
          return void res.writeHead(404).end();
        res.writeHead(200).end(readFileSync(file));
      },
    );
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const siteUrl = `https://127.0.0.1:${(server.address() as { port: number }).port}/srd-table/`;
    const env = { NODE_EXTRA_CA_CERTS: join(certDir, "cert.pem") };
    try {
      const remote = bareRepo();
      const facts = join(tmp("facts"), "facts.json");
      const writeFacts = (everSucceeded: boolean, candidate: string) =>
        writeFileSync(
          facts,
          JSON.stringify({
            rulesets: OK_RULES,
            deployments: { everSucceeded, deployments: everSucceeded ? 1 : 0, candidate },
          }),
        );
      writeFacts(false, "none");
      const common = (w: string) => [
        "--remote",
        remote,
        "--work",
        join(tmp("w"), w),
        "--facts",
        facts,
      ];
      const init = await cliAsync(
        ["initialize", ...common("i"), "--base", BASE, "--site-url", siteUrl],
        env,
      );
      expect(init.code, init.err).toBe(0);
      const anchor = JSON.parse(init.out).anchor as string;
      const A = makeRelease("https-a", { version: "0.2.0" });
      const site = join(tmp("art"), "site");
      requests.length = 0;
      const pub = await cliAsync(
        [
          "publish",
          ...common("p"),
          "--anchor",
          anchor,
          "--version",
          "0.2.0",
          "--tag-commit",
          A.commit,
          "--release",
          A.dir,
          "--srd",
          makeSrd(),
          "--site-out",
          site,
        ],
        env,
      );
      expect(pub.code, pub.err).toBe(0);
      // the witness really read the live site over HTTPS, past caches (a unique query per read)
      expect(
        requests.filter((u) => u.startsWith("/srd-table/index.html?pages-check=")).length,
      ).toBe(1);
      cpSync(site, live, { recursive: true }); // the (fake) Pages deployment
      writeFacts(true, "success");
      const rc = await cliAsync(
        [
          "receipt",
          ...common("r"),
          "--anchor",
          anchor,
          "--version",
          "0.2.0",
          "--run-id",
          "5",
          "--page-url",
          siteUrl.replace(/:\d+\//, "/"),
          "--artifact-digest",
          "c".repeat(64),
        ],
        env,
      );
      expect(rc.code, rc.err).toBe(0);
      const verify = await cliAsync(["verify", ...common("v"), "--anchor", anchor], env);
      expect(verify.code, verify.err).toBe(0);
      expect(JSON.parse(verify.out).state).toMatchObject({ served: "0.2.0", site_url: siteUrl });
      // the live site disappears: the default HTTP reader is a real witness (refused)
      rmSync(live, { recursive: true });
      const gone = await cliAsync(["verify", ...common("g"), "--anchor", anchor], env);
      expect(gone.code).toBe(1);
      expect(gone.err).toMatch(/^publish refused: live_missing/);
    } finally {
      server.close();
    }
  }, 120_000);
});
