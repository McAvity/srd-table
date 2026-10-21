#!/usr/bin/env node
/**
 * kenli F-007 T02: the PRODUCTION release in a real browser (dnd5
 * docs/features/F-007-offline-packs/contracts/offline.md §2.5–2.7). Not product code and not T04:
 * there is no "Prepare offline" UI yet, so the probe registers the release's SW natively, exactly as
 * `registerCurrentRelease()` would (unit-tested separately).
 *
 *   node scripts/f007-release-probe.mjs --a <release dir A> --b <release dir B (same base, variant)> [--out r.json]
 *
 * Builds come from `bun scripts/release.ts` on a committed tree. Each scenario has its own loopback
 * origin and Chromium profile (Playwright and the Chromium already installed with this checkout).
 *  S1 A: no SW before preparation; explicit registration; complete inspection; JSON routes stay JSON;
 *     then every client closed, host gone, browser restarted on the same profile: the app opens, the
 *     never-visited lazy routes (Compendium with the engine worker and the SRD from IndexedDB,
 *     Settings, About), fonts and worker come from the release cache; pointer, library, content,
 *     transfers and other routes are network errors, never the app's HTML.
 *  S2 a missing file, a corrupted file, a connection cut mid-file, a storage quota: no active worker,
 *     no completeness marker (never "ready").
 *  S3 A prepared and in use; B registered with one corrupt B-only file: B fails, A stays active,
 *     complete and usable.
 */

import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
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
    out: { type: "string" },
    keep: { type: "boolean", default: false },
  },
});
if (!args.a || !args.b) {
  console.error(
    "usage: node scripts/f007-release-probe.mjs --a <release A> --b <release B> [--out r.json]",
  );
  process.exit(2);
}
const work = mkdtempSync(join(tmpdir(), "f007-t02-release-probe-"));
const results = {
  probe: "f007-t02-release",
  playwright: require("playwright-core/package.json").version,
  checks: [],
  observations: [],
};
let failures = 0;
const check = (id, pass, detail) => {
  results.checks.push({ id, pass: !!pass, ...(pass ? {} : { detail }) });
  if (!pass) failures++;
  console.log(
    `${pass ? "PASS" : "FAIL"} ${id}${pass ? "" : ` — ${JSON.stringify(detail).slice(0, 600)}`}`,
  );
};
const note = (what, value) => results.observations.push({ what, value });

const descriptorOf = (dir) => {
  const rel = readdirSync(join(dir, "releases"))[0];
  return JSON.parse(readFileSync(join(dir, "releases", rel, "release.json"), "utf8"));
};
const A = descriptorOf(resolve(args.a));
const B = descriptorOf(resolve(args.b));
if (A.base !== B.base) throw new Error("A and B must share the base");
const BASE = A.base;
results.release_a = {
  id: A.release_id,
  total_bytes: A.total_bytes,
  files: A.assets.length + 2,
  inputs: A.inputs,
};
results.release_b = { id: B.release_id };
const srd = dirname(require.resolve("srd-rules-engine/srd-5.2.1/manifest.json"));

/** A deployment-like site: the release(s), content/srd, a library, transfers, the pointer, another app. */
function site(name, { withB = false, mutate } = {}) {
  const dir = join(work, `site-${name}`);
  const d = join(dir, BASE.slice(1));
  mkdirSync(d, { recursive: true });
  cpSync(resolve(args.a), d, { recursive: true });
  if (withB) {
    copyFileSync(join(resolve(args.b), B.sw.path), join(d, B.sw.path));
    cpSync(join(resolve(args.b), "releases", B.release_id), join(d, "releases", B.release_id), {
      recursive: true,
    });
    for (const f of B.assets)
      if (!existsSync(join(d, f.path)))
        copyFileSync(join(resolve(args.b), f.path), join(d, f.path));
  }
  cpSync(srd, join(d, "content/srd-5.2.1"), { recursive: true });
  mkdirSync(join(d, "library/d/character"), { recursive: true });
  writeFileSync(
    join(d, "library/manifest.json"),
    JSON.stringify({ format: "srd-table.library-manifest/1", snapshots: [], pointers: [] }),
  );
  writeFileSync(
    join(d, "library/d/character/probe.json"),
    JSON.stringify({
      format: "srd-table.library-pointer/1",
      kind: "character",
      id: "synthetic/probe",
    }),
  );
  mkdirSync(join(d, "f005"), { recursive: true });
  writeFileSync(
    join(d, "f005/probe.transfer.json"),
    JSON.stringify({ format: "srd-table.transfer/1", kind: "pack", id: "synthetic-probe" }),
  );
  writeFileSync(
    join(d, "release.json"),
    JSON.stringify({
      format: "srd-table.release-pointer/1",
      base: BASE,
      release_id: (withB ? B : A).release_id,
      descriptor: `releases/${(withB ? B : A).release_id}/release.json`,
    }),
  );
  mkdirSync(join(dir, "other"), { recursive: true });
  writeFileSync(
    join(dir, "other/index.html"),
    "<!doctype html><title>other app</title><p>another app on the origin</p>",
  );
  mutate?.(d);
  return dir;
}

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
};
function serve(dir, { cut } = {}) {
  const log = [];
  const srv = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
    let file = join(dir, path);
    if (!file.startsWith(dir)) return res.writeHead(400).end();
    if (path.endsWith("/")) file = join(file, "index.html");
    log.push(path);
    if (!existsSync(file) || !statSync(file).isFile())
      return res.writeHead(404, { "content-type": "text/plain" }).end("not found");
    const body = readFileSync(file);
    res.writeHead(200, {
      "content-type": TYPES[extname(file)] ?? "application/octet-stream",
      "content-length": body.length,
      "cache-control": "no-cache",
    });
    if (cut && path.endsWith(cut)) {
      res.write(body.subarray(0, Math.floor(body.length / 2)));
      setTimeout(() => res.destroy(), 50); // connection cut mid-file
      return;
    }
    res.end(body);
  });
  return {
    log,
    port: 0,
    async start(port = 0) {
      await new Promise((ok) => srv.listen(port, "127.0.0.1", ok));
      this.port = srv.address().port;
      return `http://127.0.0.1:${this.port}`;
    },
    stop: () => new Promise((ok) => srv.close(() => ok())),
  };
}

const launch = (profile) => pw.chromium.launchPersistentContext(profile, { headless: true });
const P = (page, fn, arg) => page.evaluate(fn, arg);
const appReady = (page, timeout = 30000) =>
  page.waitForFunction(
    () => {
      const t = document.body?.innerText ?? "";
      return document.querySelector("#root")?.children.length && !t.includes("Opening the table");
    },
    null,
    { timeout },
  );
const register = (page, swPath) =>
  P(
    page,
    async ({ base, swPath }) => {
      try {
        const reg = await navigator.serviceWorker.register(base + swPath, {
          scope: base,
          updateViaCache: "none",
        });
        const w = reg.installing ?? reg.waiting ?? reg.active;
        await new Promise((ok) => {
          if (!w || w.state === "activated" || w.state === "redundant") return ok();
          w.addEventListener(
            "statechange",
            () => (w.state === "activated" || w.state === "redundant") && ok(),
          );
        });
        return { state: w?.state ?? "none" };
      } catch (e) {
        return { error: String(e) };
      }
    },
    { base: BASE, swPath },
  );
const swState = (page) =>
  P(
    page,
    async (base) => {
      const r = await navigator.serviceWorker.getRegistration(base);
      const name = (w) => (w ? new URL(w.scriptURL).pathname.split("/").pop() : null);
      return {
        active: name(r?.active),
        waiting: name(r?.waiting),
        installing: name(r?.installing),
        controller: name(navigator.serviceWorker.controller),
        caches: (await caches.keys()).sort(),
      };
    },
    BASE,
  );
const inspect = (page) =>
  P(
    page,
    async (base) => {
      const r = await navigator.serviceWorker.getRegistration(base);
      if (!r?.active) return null;
      const ch = new MessageChannel();
      const got = new Promise((ok) => (ch.port1.onmessage = (e) => ok(e.data)));
      r.active.postMessage({ proto: "srd-table.release/1", type: "inspect" }, [ch.port2]);
      return got;
    },
    BASE,
  );
const markerOf = (page, release) =>
  P(
    page,
    async ({ base, id }) =>
      !!(await (
        await caches.open(`srd-table:${base}:${id}`)
      ).match(`${base}__release/${id}/complete`)),
    { base: BASE, id: release },
  );
/** The reason the release SW recorded for its failed install (src/offline/sw.ts `failed`). */
const failureOf = (page, release) =>
  P(
    page,
    async ({ base, id }) => {
      const name = `srd-table:${base}:${id}:install-failed`;
      if (!(await caches.has(name))) return null;
      const hit = await (await caches.open(name)).match(`${base}__release/${id}/install-failed`);
      return hit ? hit.json() : null;
    },
    { base: BASE, id: release },
  );
/** What a fetch from the page gets: status + content-type, or a network error. */
const probeFetch = (page, path) =>
  P(
    page,
    async (u) => {
      try {
        const r = await fetch(u, { cache: "no-store" });
        const text = await r.text();
        return { status: r.status, type: r.headers.get("content-type"), html: /^\s*</.test(text) };
      } catch {
        return { error: "network" };
      }
    },
    path,
  );

try {
  // ───────── S1 ─────────
  {
    const srv = serve(site("s1"));
    const origin = await srv.start();
    const profile = join(work, "profile-s1");
    let ctx = await launch(profile);
    results.browser_version = ctx.browser()?.version() ?? null;
    let page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto(`${origin}${BASE}`);
    await appReady(page);
    let st = await swState(page);
    check(
      "no-sw-before-explicit-preparation",
      !st.active && !st.installing && !st.controller && st.caches.length === 0,
      st,
    );
    // the app keeps the served SRD in IndexedDB in the background (F-008 §9.5): offline packs need it
    await page.waitForFunction(
      () =>
        new Promise((ok) => {
          const r = indexedDB.open("srd-table");
          r.onsuccess = () => {
            const db = r.result;
            if (!db.objectStoreNames.contains("packs")) return ok(false);
            const q = db.transaction("packs").objectStore("packs").getAllKeys();
            q.onsuccess = () => ok(q.result.some((k) => String(k).startsWith("srd-5.2.1@")));
          };
          r.onerror = () => ok(false);
        }),
      null,
      { timeout: 60000, polling: 500 },
    );
    const reg = await register(page, A.sw.path);
    check("explicit-registration-of-own-release-activates", reg.state === "activated", reg);
    const insp = await inspect(page);
    check(
      "inspection-complete-every-byte",
      insp?.complete === true && insp.missing.length === 0 && insp.release_id === A.release_id,
      insp,
    );
    check("completeness-marker-written", await markerOf(page, A.release_id));
    await page.reload();
    await appReady(page);
    st = await swState(page);
    check(
      "page-controlled-by-own-release",
      st.controller === A.sw.path && st.caches.includes(`srd-table:${BASE}:${A.release_id}`),
      st,
    );
    const onlineLoaded = await P(page, () =>
      performance.getEntriesByType("resource").map((e) => new URL(e.name).pathname),
    );
    note(
      "assets-loaded-online",
      onlineLoaded.filter((p) => p.includes("/assets/")).map((p) => p.split("/").pop()),
    );
    // JSON routes are never the app's HTML (online)
    const online = {};
    for (const p of [
      "release.json",
      "library/manifest.json",
      "library/d/character/probe.json",
      "content/srd-5.2.1/manifest.json",
      "f005/probe.transfer.json",
      "library/nope.json",
      `releases/${A.release_id}/release.json`,
    ])
      online[p] = await probeFetch(page, `${BASE}${p}`);
    note("online-json-routes", online);
    check(
      "online-json-routes-are-json-from-network",
      Object.entries(online).every(([p, r]) =>
        p === "library/nope.json"
          ? r.status === 404 && !r.html
          : r.status === 200 && /json/.test(r.type ?? "") && !r.html,
      ),
      online,
    );
    const nav = await ctx.newPage();
    const navRes = await nav.goto(`${origin}${BASE}library/manifest.json`);
    check(
      "navigation-to-library-json-is-json",
      /json/.test(navRes?.headers()["content-type"] ?? ""),
      navRes?.headers()["content-type"],
    );
    await nav.close();

    // every client closed, host gone, browser restarted on the same profile
    await ctx.close();
    await srv.stop();
    ctx = await launch(profile);
    page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto(`${origin}${BASE}`);
    await appReady(page, 60000);
    st = await swState(page);
    check("restart-host-gone-app-opens-from-release", st.controller === A.sw.path, st);
    const routes = {
      compendium: "#/compendium?table=spells&q=Fireball",
      settings: "#/settings",
      about: "#/about",
    };
    const routeText = {};
    for (const [name, hash] of Object.entries(routes)) {
      await P(
        page,
        (h) => {
          location.hash = h;
        },
        hash,
      );
      await page.waitForFunction(
        (n) => {
          const t = document.body.innerText;
          return n === "compendium"
            ? t.includes("Fireball")
            : n === "settings"
              ? t.includes("Settings")
              : t.includes("About");
        },
        name,
        { timeout: 60000 },
      );
      routeText[name] = true;
    }
    check(
      "never-visited-lazy-routes-render-offline",
      Object.keys(routeText).length === 3,
      routeText,
    );
    const offlineLoaded = await P(page, () =>
      performance
        .getEntriesByType("resource")
        .map((e) => new URL(e.name).pathname.split("/").pop()),
    );
    const lazy = A.assets
      .filter((a) => /^(CompendiumPage|SettingsPage|AboutPage)-/.test(a.path.split("/").pop()))
      .map((a) => a.path.split("/").pop());
    const onlineNames = new Set(onlineLoaded.map((p) => p.split("/").pop()));
    check(
      "lazy-chunks-loaded-offline-were-never-loaded-online",
      lazy.length === 3 && lazy.every((n) => offlineLoaded.includes(n) && !onlineNames.has(n)),
      { lazy, offlineLoaded },
    );
    const worker = A.assets
      .find((a) => a.role === "worker")
      .path.split("/")
      .pop();
    check("engine-worker-from-release-cache-offline", offlineLoaded.includes(worker), { worker });
    const fonts = await P(page, async () => {
      await document.fonts.ready;
      return [...document.fonts]
        .filter((f) => f.status === "loaded")
        .map((f) => `${f.family} ${f.weight}`);
    });
    note("fonts-loaded-offline", fonts);
    check(
      "fonts-from-release-cache-offline",
      fonts.some((f) => /Atkinson Hyperlegible Next/.test(f)),
      fonts,
    );
    const assetSet = new Set(A.assets.map((a) => a.path.split("/").pop()));
    const scripts = offlineLoaded.filter((n) => /\.(js|css|woff2?)$/.test(n));
    check(
      "offline-page-uses-only-own-release-files",
      scripts.length > 0 && scripts.every((n) => assetSet.has(n)),
      scripts.filter((n) => !assetSet.has(n)),
    );
    const offline = {};
    for (const p of [
      "release.json",
      "library/manifest.json",
      "content/srd-5.2.1/manifest.json",
      "f005/probe.transfer.json",
      `releases/${A.release_id}/release.json`,
      "assets/not-in-release-0000.js",
    ])
      offline[p] = await probeFetch(page, `${BASE}${p}`);
    note("offline-routes", offline);
    check(
      "offline-pointer-library-content-transfers-are-errors-not-html",
      Object.values(offline).every((r) => r.error === "network"),
      offline,
    );
    const navs = {};
    for (const p of [`${BASE}library/manifest.json`, "/other/", "/dnd5/", `${BASE}characters`]) {
      const t = await ctx.newPage();
      try {
        const r = await t.goto(`${origin}${p}`);
        navs[p] = { status: r?.status(), html: (await t.content()).includes('id="root"') };
      } catch (e) {
        navs[p] = { error: String(e).split("\n")[0].slice(0, 80) };
      }
      await t.close();
    }
    note("offline-navigations", navs);
    check(
      "offline-no-app-html-for-other-routes",
      Object.values(navs).every((r) => r.error || !r.html),
      navs,
    );
    await ctx.close();
  }

  // ───────── S2: never ready on missing / corrupt / cut / quota ─────────
  const lazyChunk = A.assets.find((a) => /^assets\/SettingsPage-/.test(a.path)).path;
  const failing = [
    [
      "missing-file",
      { mutate: (d) => rmSync(join(d, lazyChunk)) },
      { cause: (e) => e.startsWith(`release_asset_http ${lazyChunk} 404`) },
    ],
    [
      "corrupt-file",
      {
        mutate: (d) => {
          const f = join(d, lazyChunk);
          const b = readFileSync(f);
          b[10] ^= 0xff;
          writeFileSync(f, b);
        },
      },
      { cause: (e) => e === `release_asset_hash ${lazyChunk}` },
    ],
    [
      "connection-cut-mid-file",
      {},
      { cut: lazyChunk.split("/").pop(), cause: (e) => /^TypeError|^release_asset_hash/.test(e) },
    ],
    ["storage-quota", {}, { quota: 300_000, cause: (e) => /^QuotaExceededError/.test(e) }],
  ];
  for (const [name, siteOpts, opts] of failing) {
    const srv = serve(site(name, siteOpts), { cut: opts.cut });
    const origin = await srv.start();
    const ctx = await launch(join(work, `profile-${name}`));
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    if (opts.quota) {
      const cdp = await ctx.newCDPSession(page);
      await cdp.send("Storage.overrideQuotaForOrigin", { origin, quotaSize: opts.quota });
    }
    await page.goto(`${origin}${BASE}`);
    const reg = await register(page, A.sw.path);
    await page.waitForTimeout(300);
    const st = await swState(page);
    const marker = await markerOf(page, A.release_id);
    const why = await failureOf(page, A.release_id);
    note(`failure-${name}`, { reg, st, marker, recorded: why });
    check(
      `${name}-never-active-never-complete`,
      !st.active && !st.controller && marker === false && (reg.state === "redundant" || reg.error),
      { reg, st, marker },
    );
    // the cause, as the SW recorded it (the quota override is not visible to storage.estimate())
    check(
      `${name}-failure-recorded-with-its-cause-incomplete-cache-dropped`,
      why?.release_id === A.release_id &&
        opts.cause(why.error) &&
        !st.caches.includes(`srd-table:${BASE}:${A.release_id}`),
      { why, caches: st.caches },
    );
    await ctx.close();
    await srv.stop();
  }

  // ───────── S3: A retained after a failing B ─────────
  {
    const srv = serve(
      site("s3", {
        withB: true,
        mutate: (d) =>
          writeFileSync(join(d, "releases", B.release_id, "index.html"), "corrupted B html"),
      }),
    );
    const origin = await srv.start();
    const ctx = await launch(join(work, "profile-s3"));
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto(`${origin}${BASE}`);
    await appReady(page);
    check("s3-A-registered", (await register(page, A.sw.path)).state === "activated");
    await page.reload();
    await appReady(page);
    const regB = await register(page, B.sw.path); // what T05 does after consent and gates
    await page.waitForTimeout(500);
    const st = await swState(page);
    const insp = await inspect(page);
    note("s3-after-failing-B", { regB, st, insp });
    check(
      "failing-B-never-waiting-or-active",
      regB.state === "redundant" && st.active === A.sw.path && !st.waiting && !st.installing,
      { regB, st },
    );
    check(
      "A-still-controls-and-is-complete",
      st.controller === A.sw.path && insp?.complete === true && insp.release_id === A.release_id,
      { st, insp },
    );
    check("B-has-no-completeness-marker", (await markerOf(page, B.release_id)) === false);
    const whyB = await failureOf(page, B.release_id);
    check(
      "B-failure-recorded-A-cache-intact",
      whyB?.error === `release_asset_hash releases/${B.release_id}/index.html` &&
        st.caches.includes(`srd-table:${BASE}:${A.release_id}`) &&
        (await failureOf(page, A.release_id)) === null,
      { whyB, caches: st.caches },
    );
    await page.reload();
    await appReady(page);
    check("A-app-still-opens", (await swState(page)).controller === A.sw.path);
    await ctx.close();
    await srv.stop();
  }
} catch (e) {
  failures++;
  results.error = String(e?.stack ?? e)
    .replaceAll(work, "<tmp>")
    .split("\n")
    .slice(0, 8)
    .join("\n");
  console.error(results.error);
}
results.required_failures = failures;
results.outcome = failures === 0 ? "PASS" : "FAIL";
results.limitations = [
  "Chromium on Linux driven by Playwright over loopback http://127.0.0.1; not iPadOS Safari, not a Home Screen app, not HTTPS under /dnd/ on the tailnet.",
  "Native registration stands in for T04's explicit preparation UI (not built yet); registerCurrentRelease() is unit-tested separately.",
  "Host cut = local server stopped; quota = Chromium DevTools quota override (simulation).",
];
if (args.out)
  writeFileSync(
    resolve(args.out),
    `${JSON.stringify(results, null, 2).replaceAll(work, "<tmp>")}\n`,
  );
console.log(`${results.outcome}: ${failures} required failure(s)`);
if (!args.keep) rmSync(work, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);
