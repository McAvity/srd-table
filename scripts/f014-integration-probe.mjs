#!/usr/bin/env node
/**
 * kenli F-014 T04: the integrated local trial (dnd5 docs/features/F-014-github-pages-deploy/tasks/T04).
 * Not product code. Two real releases under /srd-table/, published exactly as pages-release.yml does
 * (pages-state archive in a local bare repository → exported site → checked tar → the host directory
 * replaced by the tar, as Pages replaces a site), served over HTTP; then in Chromium and in WebKit
 * (Playwright's builds: an emulation, not Safari on an iPad):
 *   I1 A: launch, footer/About metadata, the engine worker and the SRD (a play action), prepare offline
 *   I2 shared-origin canaries (another app's IndexedDB, Cache Storage, localStorage on the same origin)
 *   I3 B published: every file of A's site still served with its hash; offered, downloaded, Later
 *   I4 restart with the host stopped: still A, same data and history
 *   I5 Update now → B; restart with the host stopped: B, same data and history, metadata of B
 *   I6 the canaries untouched; the app's caches are its own
 *   I7 F-011 full copy (state + history) exported on origin 1, imported on origin 2 (another port);
 *      the source unchanged
 *
 *   node scripts/f014-integration-probe.mjs --a <release A> --b <release B> --srd <dist/srd-5.2.1>
 *     --seed <seed.json> [--browsers chromium,webkit] [--out report.json]
 * `--seed`: `npx tsx scripts/f007-local-copy-seed.ts` (synthetic; no private data). GitHub and Pages
 * are stood in for: stated facts, a local bare pages-state, a local HTTP host.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "package.json"));
const pw = require("playwright-core");
const { values: args } = parseArgs({
  options: {
    a: { type: "string" },
    b: { type: "string" },
    srd: { type: "string" },
    seed: { type: "string" },
    browsers: { type: "string", default: "chromium,webkit" },
    out: { type: "string" },
  },
});
for (const k of ["a", "b", "srd", "seed"])
  if (!args[k]) {
    console.error(
      "usage: node scripts/f014-integration-probe.mjs --a A --b B --srd SRD --seed seed.json",
    );
    process.exit(2);
  }
const work = mkdtempSync(join(tmpdir(), "f014-t04-probe-"));
const seed = JSON.parse(readFileSync(resolve(args.seed), "utf8"));
const BASE = "/srd-table/";
const SITE_URL = "https://mcavity.github.io/srd-table/";
const sha = (b) => createHash("sha256").update(b).digest("hex");
const results = {
  probe: "f014-t04-integration",
  playwright: require("playwright-core/package.json").version,
  emulation: "Playwright Chromium and WebKit builds on Linux; not Safari/iPadOS",
  fake: "pages-state = local bare repository; Pages = local HTTP directory replaced by the tar; facts stated",
  checks: [],
  notes: [],
};
let failures = 0;
const check = (id, pass, detail) => {
  results.checks.push({ id, pass: !!pass, ...(pass ? {} : { detail }) });
  if (!pass) failures++;
  console.log(
    `${pass ? "PASS" : "FAIL"} ${id}${pass ? "" : ` — ${String(JSON.stringify(detail) ?? "").slice(0, 600)}`}`,
  );
};
const note = (what, value) => {
  results.notes.push({ what, value });
  console.log(`NOTE ${what}: ${JSON.stringify(value).slice(0, 300)}`);
};
const run = (cmd, a, opts = {}) =>
  execFileSync(cmd, a, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...opts,
  }).trim();
const lastJson = (out) =>
  JSON.parse(
    out
      .split("\n")
      .filter((l) => l.startsWith("{"))
      .pop() ?? "{}",
  );

const rel = Object.fromEntries(
  ["a", "b"].map((k) => {
    const dir = resolve(args[k]);
    const id = execFileSync("ls", [join(dir, "releases")], { encoding: "utf8" }).trim();
    const d = JSON.parse(readFileSync(join(dir, "releases", id, "release.json"), "utf8"));
    return [k, { dir, id, version: d.inputs.app_version, commit: d.inputs.table_commit }];
  }),
);
results.releases = rel;

// ───────── the publication path of pages-release.yml (local stand-ins for GitHub) ─────────
function pagesWorld(tag) {
  const w = join(work, `pages-${tag}`);
  mkdirSync(w);
  const remote = join(w, "pages-state.git");
  run("git", ["init", "-q", "--bare", remote]);
  const host = join(w, "host"); // what Pages serves at /srd-table/
  mkdirSync(host);
  let deployed = 0;
  let n = 0;
  const facts = (everSucceeded, candidate) => {
    const f = join(w, `facts-${n++}.json`);
    writeFileSync(
      f,
      JSON.stringify({
        rulesets: {
          pagesState: { deletion: true, nonFastForward: true },
          tags: { update: true, deletion: true },
          workflowBypass: false,
        },
        deployments: { everSucceeded, deployments: deployed, candidate },
      }),
    );
    return f;
  };
  const cli = (...a) => lastJson(run("bun", ["scripts/publish/cli.ts", ...a]));
  const ci = (...a) => lastJson(run("bun", ["scripts/ci/pages-ci.ts", ...a]));
  const common = (k) => [
    "--remote",
    remote,
    "--work",
    join(w, `work-${k}-${n}`),
    "--live-dir",
    host,
  ];
  const { anchor } = cli(
    "initialize",
    ...common("init"),
    "--facts",
    facts(false, "none"),
    "--base",
    BASE,
    "--site-url",
    SITE_URL,
  );
  const canary = join(w, "parent-canary");
  mkdirSync(canary);
  writeFileSync(
    join(canary, "kenli-private.json"),
    JSON.stringify({ canary: `parent ${tag} ${Date.now()}` }),
  );
  const manifests = {};
  return {
    host,
    manifests,
    publish(r) {
      const work1 = join(w, `work-publish-${r.version}`);
      const site = join(w, `site-${r.version}`);
      const staged = cli(
        "publish",
        "--remote",
        remote,
        "--work",
        work1,
        "--live-dir",
        host,
        "--facts",
        facts(deployed > 0, "none"),
        "--anchor",
        anchor,
        "--version",
        r.version,
        "--tag-commit",
        r.commit,
        "--release",
        r.dir,
        "--srd",
        resolve(args.srd),
        "--site-out",
        site,
      );
      const tar = join(w, `artifact-${r.version}.tar`);
      const packed = ci(
        "pack",
        "--site",
        site,
        "--manifest",
        join(work1, "site-manifest.json"),
        "--out",
        tar,
        "--canary",
        canary,
        "--source",
        root,
      );
      manifests[r.version] = JSON.parse(
        readFileSync(join(work1, "site-manifest.json"), "utf8"),
      ).files;
      // "deploy-pages": the whole site replaced by the tar
      rmSync(host, { recursive: true, force: true });
      mkdirSync(host);
      run("tar", ["-xf", tar, "-C", host]);
      ci(
        "verify-tar",
        "--tar",
        tar,
        "--manifest",
        join(work1, "site-manifest.json"),
        "--sha256",
        packed.sha256,
      );
      deployed++;
      cli(
        "receipt",
        "--remote",
        remote,
        "--work",
        join(w, `work-receipt-${r.version}`),
        "--live-dir",
        host,
        "--facts",
        facts(true, "success"),
        "--anchor",
        anchor,
        "--version",
        r.version,
        "--run-id",
        String(1000 + deployed),
        "--page-url",
        SITE_URL,
        "--artifact-digest",
        `sha256:${packed.sha256}`,
      );
      return {
        release_id: staged.release_id,
        tar_sha256: packed.sha256,
        files: manifests[r.version].length,
        canary_probes: packed.canary_probes,
      };
    },
  };
}

// ───────── the HTTP host: /srd-table/ from the Pages directory (no dotfiles), another app's page ─────────
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
};
function server(pagesDir) {
  const s = { port: 0, srv: null };
  s.start = () =>
    new Promise((ok) => {
      s.srv = createServer((req, res) => {
        const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
        if (path === "/is-it-dark-yet/" || path === "/is-it-dark-yet/index.html")
          return res
            .writeHead(200, { "content-type": TYPES[".html"] })
            .end("<!doctype html><title>another app</title><p>is it dark yet?</p>");
        if (!path.startsWith(BASE)) return res.writeHead(404).end();
        const rel = path.slice(BASE.length) || "index.html";
        const file = join(pagesDir(), rel);
        if (
          rel.split("/").some((x) => x.startsWith(".") || !x) ||
          !existsSync(file) ||
          !statSync(file).isFile()
        )
          return res.writeHead(404).end();
        const body = readFileSync(file);
        res.writeHead(200, {
          "content-type": TYPES[extname(file)] ?? "application/octet-stream",
          "content-length": body.length,
          "cache-control": "max-age=600",
        });
        res.end(body);
      });
      s.srv.listen(s.port, "127.0.0.1", () => {
        s.port = s.srv.address().port;
        ok();
      });
    });
  s.stop = () =>
    new Promise((ok) => {
      s.srv.closeAllConnections?.();
      s.srv.close(() => ok());
    });
  s.url = (p = "") => `http://127.0.0.1:${s.port}${BASE}${p}`;
  s.origin = () => `http://127.0.0.1:${s.port}`;
  return s;
}

// ───────── browser helpers (from the F-007 probes) ─────────
const pageErrors = [];
async function until(fn, ms = 30_000, what = "condition") {
  const end = Date.now() + ms;
  for (;;) {
    try {
      if (await fn()) return true;
    } catch {
      // a page reloading: try again
    }
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}
async function launch(engine, dir) {
  return pw[engine].launchPersistentContext(join(work, dir), {
    headless: true,
    acceptDownloads: true,
  });
}
async function open(ctx, s, route = "characters", label = "") {
  const page =
    ctx.pages().find((p) => p.url() === "about:blank") ?? ctx.pages()[0] ?? (await ctx.newPage());
  if (!page.__f014) {
    page.on("pageerror", (e) => pageErrors.push(`${label}: ${e.message}`));
    page.__f014 = true;
  }
  await page.goto(`${s.url()}#/${route}`);
  await page.reload();
  await page.waitForFunction(
    () =>
      document.body.innerText.includes("SRD Table") &&
      !document.body.innerText.includes("Opening the table"),
    null,
    { timeout: 90_000 },
  );
  return page;
}
const reg = (page) =>
  page.evaluate(async (base) => {
    const r = await navigator.serviceWorker.getRegistration(base);
    const name = (w) => (w ? w.scriptURL.split("/").pop() : null);
    return {
      controller: name(navigator.serviceWorker.controller),
      active: name(r?.active),
      waiting: name(r?.waiting),
      installing: name(r?.installing),
    };
  }, BASE);
const swOf = (id) => `sw-${id}.js`;
const dumpDb = (page) =>
  page.evaluate(
    () =>
      new Promise((done, fail) => {
        const r = indexedDB.open("srd-table");
        r.onerror = () => fail(r.error);
        r.onsuccess = () => {
          const db = r.result;
          const names = [
            "characters",
            "encounters",
            "history",
            "history_meta",
            "packs",
            "settings",
          ];
          const tx = db.transaction(names, "readonly");
          const out = {};
          let left = names.length;
          for (const n of names) {
            const q = tx.objectStore(n).getAll();
            const k = n === "settings" ? tx.objectStore(n).getAllKeys() : null;
            q.onsuccess = () => {
              out[n] = n === "packs" ? q.result.map((p) => p.key) : q.result;
              const fin = () => {
                if (--left === 0) {
                  db.close();
                  done(out);
                }
              };
              if (k)
                k.onsuccess = () => {
                  out.settings = Object.fromEntries(k.result.map((key, i) => [key, q.result[i]]));
                  fin();
                };
              else fin();
            };
          }
        };
      }),
  );
const jcs = (v) =>
  JSON.stringify(
    (function sort(x) {
      return Array.isArray(x)
        ? x.map(sort)
        : x && typeof x === "object"
          ? Object.fromEntries(
              Object.keys(x)
                .sort()
                .map((k) => [k, sort(x[k])]),
            )
          : x;
    })(v),
  );
const game = (d) =>
  jcs({
    characters: d.characters,
    history: d.history,
    history_meta: d.history_meta,
    packs: d.packs,
    campaign: d.settings.campaign ?? null,
  });
const putRows = (page, rows) =>
  page.evaluate(
    (rows) =>
      new Promise((done, fail) => {
        const r = indexedDB.open("srd-table");
        r.onsuccess = () => {
          const db = r.result;
          const tx = db.transaction([...new Set(rows.map((x) => x.store))], "readwrite");
          for (const x of rows) tx.objectStore(x.store).put(x.value);
          tx.oncomplete = () => {
            db.close();
            done(true);
          };
          tx.onerror = () => fail(tx.error);
        };
      }),
    rows,
  );
const footer = async (page) => (await page.getByTestId("footer-version").innerText()).trim();
const about = async (page, s) => {
  await open(page.context(), s, "about");
  await page.getByTestId("about-build").waitFor({ timeout: 30_000 });
  return {
    marker: (await page.getByTestId("about-version").innerText()).replace(/^Version\s+/, ""),
    version: (await page.getByTestId("about-build-version").innerText()).trim(),
    text: await page.getByTestId("about-build-text").innerText(),
    footer: await footer(page),
  };
};

const now = 1760900000000;
const UNA = "c-f014una1";
async function prepare(page, s) {
  await open(page.context(), s, "settings");
  await page.getByTestId("offline-target").selectOption(`character:${UNA}`);
  await page
    .getByTestId("offline-readiness")
    .getByRole("button", { name: "Prepare offline" })
    .click();
  await until(
    async () =>
      (await page.getByTestId("offline-status").getAttribute("data-status")) === "checking" &&
      (await page.getByRole("button", { name: "Reload to finish" }).count()) > 0,
    180_000,
    "prepared",
  );
  await open(page.context(), s, "settings");
}
async function damage(page, s, n) {
  await open(page.context(), s, `characters/${UNA}/sheet`);
  const hp = page.getByRole("region", { name: "Hit Points" });
  await hp.waitFor({ timeout: 60_000 });
  const before = (await dumpDb(page)).history.length;
  await hp.getByPlaceholder("Amount").fill(String(n));
  await hp.getByRole("button", { name: "Damage" }).click();
  await until(
    async () => (await dumpDb(page)).history.length === before + 1,
    30_000,
    "damage saved",
  );
  await page.waitForTimeout(400);
}
async function checkAndDownload(page, s) {
  await open(page.context(), s, "settings");
  await page.getByRole("button", { name: "Check for an update" }).click();
  const offer = page.getByTestId("update-offer").first();
  await until(
    async () => ["offered", "downloaded"].includes(await offer.getAttribute("data-phase")),
    60_000,
    "offer",
  );
  if ((await offer.getAttribute("data-phase")) === "offered") {
    await offer.getByRole("button", { name: "Download" }).click();
    await until(
      async () =>
        (await offer.getAttribute("data-phase")) !== "offered" ||
        (await page.getByTestId("update-last-error").count()) > 0,
      120_000,
      "download",
    );
  }
  return offer.getAttribute("data-phase");
}

// ───────── F-011 full copy helpers (from the F-007 local-copy probe) ─────────
const SRC = "c-f014src1";
const character = (id, docs, content, name) => ({
  store: "characters",
  value: {
    id,
    build: name ? { ...docs.build, name } : docs.build,
    state: docs.state,
    created: now,
    updated: now,
    rev: 1,
    gen: 0,
    ...(content ? { content } : {}),
  },
});
const testPackRow = () => ({
  store: "packs",
  value: {
    key: `${seed.test_pack.ref.id}@${seed.test_pack.ref.version}#${seed.test_pack.ref.sha256}`,
    ref: seed.test_pack.ref,
    files: seed.test_pack.files,
    installed_at: now,
    origin: { kind: "import", file: "test-actions.transfer.json", bytes_sha256: null },
  },
});
function journalRows(recordId) {
  const src = seed.journal.record_id;
  const entries = seed.journal.entries.map((e) => ({
    ...e,
    record_id: recordId,
    participants: e.participants.map((p) =>
      p.record_id === src ? { ...p, record_id: recordId } : p,
    ),
  }));
  return [
    ...entries.map((value) => ({ store: "history", value })),
    { store: "history_meta", value: { ...seed.journal.meta, record_id: recordId } },
  ];
}
async function toList(page) {
  const list = page.getByRole("heading", { name: "Characters", exact: true });
  const back = page.getByRole("link", { name: "All characters" });
  await Promise.race([
    list.waitFor({ timeout: 60_000 }),
    back.first().waitFor({ timeout: 60_000 }),
  ]);
  if (!(await list.isVisible())) {
    await back.first().click();
    await list.waitFor({ timeout: 30_000 });
  }
}
async function exportCopy(page, name, file) {
  const card = page
    .locator("article")
    .filter({ has: page.getByRole("heading", { name, exact: true }) })
    .first();
  await card.getByRole("button", { name: "Local copy with state and history" }).click();
  await page.getByTestId("local-copy-export-summary").waitFor({ timeout: 60_000 });
  const [dl] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Save the file" }).click(),
  ]);
  await dl.saveAs(file);
}
async function loadCopy(page, file) {
  await page.getByRole("button", { name: "Load local copy" }).click();
  await page.getByTestId("local-copy-file").setInputFiles(file);
  await page.getByTestId("local-copy-preview").waitFor({ timeout: 60_000 });
  await page.getByRole("button", { name: "Create the copy", exact: true }).last().click();
  await page.waitForURL(/\/characters\/c-[^/]+\/sheet/, { timeout: 60_000 });
  return /\/characters\/(c-[^/]+)\/sheet/.exec(page.url())?.[1];
}

// ───────── one engine ─────────
async function engineRun(engine) {
  const tag = engine;
  const pages = pagesWorld(tag);
  const pubA = pages.publish(rel.a);
  note(`${tag} published A`, pubA);
  const s1 = server(() => pages.host);
  await s1.start();
  let ctx = await launch(engine, `profile-${tag}-1`);
  let page = await open(ctx, s1, "characters", tag);
  // I1 A: metadata, worker, SRD, prepare
  const aboutA = await about(page, s1);
  check(
    `${tag}.I1.metadata-A`,
    aboutA.footer === rel.a.version &&
      aboutA.version === rel.a.version &&
      aboutA.marker === rel.a.id &&
      aboutA.text.includes(rel.a.commit),
    aboutA,
  );
  check(`${tag}.I1.no-sw-before-preparation`, (await reg(page)).active === null, await reg(page));
  // I2 another app of the same origin: its database, cache and storage
  const nonce = `canary-${tag}-${Date.now()}`;
  const other = await ctx.newPage();
  await other.goto(`${s1.origin()}/is-it-dark-yet/`);
  await other.evaluate(async (nonce) => {
    await new Promise((done, fail) => {
      const r = indexedDB.open("is-it-dark-yet", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("kv");
      r.onsuccess = () => {
        const tx = r.result.transaction("kv", "readwrite");
        tx.objectStore("kv").put(nonce, "canary");
        tx.oncomplete = () => {
          r.result.close();
          done();
        };
        tx.onerror = () => fail(tx.error);
      };
      r.onerror = () => fail(r.error);
    });
    const c = await caches.open("is-it-dark-yet-v1");
    await c.put("/is-it-dark-yet/canary.txt", new Response(nonce));
    localStorage.setItem("is-it-dark-yet.canary", nonce);
  }, nonce);
  const readCanary = (p) =>
    p.evaluate(async () => {
      const db = await new Promise((done, fail) => {
        const r = indexedDB.open("is-it-dark-yet");
        r.onsuccess = () => done(r.result);
        r.onerror = () => fail(r.error);
      });
      const v = await new Promise((done) => {
        const q = db.transaction("kv").objectStore("kv").get("canary");
        q.onsuccess = () => done(q.result);
        q.onerror = () => done(null);
      });
      db.close();
      const c = await caches.open("is-it-dark-yet-v1");
      const m = await c.match("/is-it-dark-yet/canary.txt");
      return {
        idb: v,
        cache: m ? await m.text() : null,
        local: localStorage.getItem("is-it-dark-yet.canary"),
        caches: await caches.keys(),
        dbs: indexedDB.databases ? (await indexedDB.databases()).map((d) => d.name).sort() : null,
      };
    });
  await other.close();
  await putRows(page, [character(UNA, seed.source, null, "Una")]);
  await prepare(page, s1);
  const rA = await reg(page);
  check(
    `${tag}.I1.prepared-on-A`,
    rA.active === swOf(rel.a.id) && rA.controller === swOf(rel.a.id),
    rA,
  );
  await damage(page, s1, 2); // the engine worker plays an action with the SRD
  const g1 = game(await dumpDb(page));
  check(`${tag}.I1.worker-played`, (await dumpDb(page)).history.length >= 1, null);
  // I3 B published: A's files still served, offered and downloaded, Later
  const pubB = pages.publish(rel.b);
  note(`${tag} published B`, pubB);
  const keptA = pages.manifests[rel.a.version].filter(
    (f) =>
      !["index.html", "release.json", "release-current.json", "releases/index.json"].includes(
        f.path,
      ) && !f.path.startsWith("."),
  );
  let served = 0;
  const notServed = [];
  for (const f of keptA) {
    const r = await fetch(`${s1.url(f.path)}`);
    if (r.ok && sha(Buffer.from(await r.arrayBuffer())) === f.sha256) served++;
    else notServed.push(f.path);
  }
  check(`${tag}.I3.A-files-kept-byte-exact`, served === keptA.length, {
    served,
    of: keptA.length,
    notServed: notServed.slice(0, 5),
  });
  const phase = await checkAndDownload(page, s1);
  check(`${tag}.I3.B-downloaded`, phase === "downloaded", phase);
  await page.getByTestId("update-offer").first().getByRole("button", { name: "Later" }).click();
  const rLater = await reg(page);
  check(`${tag}.I3.later-still-A`, rLater.active === swOf(rel.a.id) && !rLater.waiting, rLater);
  // I4 restart with the host stopped: still A
  await ctx.close();
  await s1.stop();
  ctx = await launch(engine, `profile-${tag}-1`);
  page = await open(ctx, s1, "characters", tag);
  const offA = await about(page, s1);
  check(
    `${tag}.I4.offline-restart-A`,
    offA.marker === rel.a.id && offA.footer === rel.a.version,
    offA,
  );
  check(`${tag}.I4.offline-data-kept`, game(await dumpDb(page)) === g1, null);
  // I5 Update now → B, then offline restart
  await s1.start();
  await open(ctx, s1, "settings", tag);
  await page.getByRole("button", { name: "Check for an update" }).click();
  const offer = page.getByTestId("update-offer").first();
  await until(
    async () => ["offered", "downloaded"].includes(await offer.getAttribute("data-phase")),
    60_000,
    "offer again",
  );
  if ((await offer.getAttribute("data-phase")) === "offered") {
    await offer.getByRole("button", { name: "Download" }).click();
    await until(
      async () => (await offer.getAttribute("data-phase")) === "downloaded",
      120_000,
      "download again",
    );
  }
  await offer.getByRole("button", { name: /^(Update now|Try again)$/ }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Update now" }).click();
  await until(async () => (await reg(page)).controller === swOf(rel.b.id), 120_000, "B controls");
  const onB = await about(page, s1);
  check(
    `${tag}.I5.updated-to-B`,
    onB.marker === rel.b.id &&
      onB.version === rel.b.version &&
      onB.footer === rel.b.version &&
      onB.text.includes(rel.b.commit),
    onB,
  );
  check(`${tag}.I5.data-kept-after-update`, game(await dumpDb(page)) === g1, null);
  await ctx.close();
  await s1.stop();
  ctx = await launch(engine, `profile-${tag}-1`);
  page = await open(ctx, s1, "characters", tag);
  const offB = await about(page, s1);
  check(
    `${tag}.I5.offline-restart-B`,
    offB.marker === rel.b.id && offB.footer === rel.b.version,
    offB,
  );
  check(`${tag}.I5.offline-data-kept`, game(await dumpDb(page)) === g1, null);
  await damage(page, s1, 1); // play goes on offline on B
  check(
    `${tag}.I5.offline-play-on-B`,
    (await dumpDb(page)).history.length === JSON.parse(g1).history.length + 1,
    null,
  );
  // I6 canaries
  await s1.start();
  const other2 = await ctx.newPage();
  await other2.goto(`${s1.origin()}/is-it-dark-yet/`);
  const canary = await readCanary(other2);
  await other2.close();
  check(
    `${tag}.I6.other-app-untouched`,
    canary.idb === nonce && canary.cache === nonce && canary.local === nonce,
    canary,
  );
  const own = canary.caches.filter((c) => c !== "is-it-dark-yet-v1");
  note(`${tag} caches on the origin`, canary.caches);
  note(`${tag} databases on the origin`, canary.dbs);
  check(
    `${tag}.I6.app-caches-are-its-own`,
    own.every(
      (c) =>
        c.includes("srd-table") || c.includes(rel.a.id) || c.includes(rel.b.id) || c.includes(BASE),
    ),
    canary.caches,
  );
  // I7 F-011 full copy: origin 1 → file → origin 2
  page = await open(ctx, s1, "characters", tag);
  await putRows(page, [
    testPackRow(),
    character(SRC, seed.source, seed.content, "Rhea"),
    ...journalRows(SRC),
  ]);
  page = await open(ctx, s1, "characters", tag);
  await toList(page);
  const before = game(await dumpDb(page));
  const file = join(work, `${tag}-rhea.local-copy.json`);
  await exportCopy(page, "Rhea", file);
  const after = game(await dumpDb(page));
  check(`${tag}.I7.source-unchanged-by-export`, before === after, null);
  const s2 = server(() => pages.host);
  await s2.start();
  const ctx2 = await launch(engine, `profile-${tag}-2`);
  const p2 = await open(ctx2, s2, "characters", `${tag}-origin2`);
  await toList(p2);
  const id = await loadCopy(p2, file);
  const d2 = await dumpDb(p2);
  const src = JSON.parse(after);
  const sRec = src.characters.find((c) => c.id === SRC);
  const cRec = d2.characters.find((c) => c.id === id);
  const sRows = src.history.filter((e) => e.record_id === SRC);
  const cRows = d2.history.filter((e) => e.record_id === id);
  check(
    `${tag}.I7.full-copy-on-origin-2`,
    !!cRec &&
      jcs(cRec.build) === jcs(sRec.build) &&
      jcs(cRec.state) === jcs(sRec.state) &&
      cRows.length === sRows.length &&
      sRows.length === seed.journal.entries.length,
    { origin1: s1.origin(), origin2: s2.origin(), id, rows: [sRows.length, cRows.length] },
  );
  check(`${tag}.I7.origin-2-is-B`, (await footer(p2)) === rel.b.version, await footer(p2));
  await ctx2.close();
  await s2.stop();
  await ctx.close();
  await s1.stop();
  return { pubA, pubB };
}

try {
  for (const engine of args.browsers.split(",")) {
    try {
      results[engine] = await engineRun(engine);
    } catch (e) {
      check(`${engine}.completed`, false, String(e?.stack ?? e).slice(0, 1500));
    }
  }
} finally {
  results.page_errors = pageErrors.slice(0, 20);
  results.failures = failures;
  if (args.out) writeFileSync(resolve(args.out), `${JSON.stringify(results, null, 2)}\n`);
  console.log(
    `${failures === 0 ? "ALL PASS" : `${failures} FAILED`} (${results.checks.length} checks)`,
  );
}
process.exit(failures === 0 ? 0 : 1);
