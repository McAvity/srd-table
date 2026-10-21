#!/usr/bin/env node
/**
 * kenli F-007 T05: controlled updates on PRODUCTION releases in a real browser (dnd5
 * docs/features/F-007-offline-packs/contracts/offline.md §2.7, §6, §7). Not product code.
 *
 *   node scripts/f007-update-probe.mjs --a <rel A> --b <rel B, --variant b> --c <rel C, --variant c>
 *     --d <rel D, --variant d --declare-db-version 5> --seed <seed.json> [--out r.json]
 *
 * Releases from `bun scripts/release.ts` (genuinely different entry/About/worker chunks per
 * release). One loopback host publishing like the dnd5 publisher (immutable files kept, root HTML
 * and pointer switched); isolated persistent Chromium profiles; "cold restart" = every page and the
 * browser closed (and, where said, the host server stopped), the same profile launched again.
 *  U1 A prepared; B published: offered, downloaded into its own cache, NOT registered; Later;
 *     every client closed, browser restarted → still A (registration, controller, About), same
 *     data, the immutable SW URL of A unchanged; again with the host stopped.
 *  U2 two tabs on A + an F006-like base page without the protocol + another base's page: Now →
 *     refused: the other tab's open rest preview, the unresponsive base page (never the other
 *     base); nothing registered, gates released (both tabs play on); with the base page closed
 *     and the preview closed, a CAS conflict in the other tab → save_conflict; after its reload,
 *     Now succeeds.
 *  U3 Now: both tabs reload into B (controller, About lazy view never visited), same data and
 *     history; the barrier cleared by B; no waiting/installing left.
 *  U4 cold restart with the host STOPPED: still B, same data/history/day; the next action uses
 *     the next seq, no cost replayed.
 *  U5 another profile: consent for B, then C published → C offered, the consent gone; a restart
 *     never registers B or C; a damaged C (hash) and an incompatible D (DB 5) are refused at
 *     download/offer; A and its data stay.
 *  U6 another profile: an update owner holding the lock with a stored barrier — a new window
 *     waits (no editable game, no writes); the owner window closes → the barrier is cleared
 *     (owner_lost) and the game opens on A.
 *  U9 (T05 r11) another profile: the update's own record can't be saved at `registering` (a
 *     QuotaExceededError injected into this page's IndexedDB writes of that phase) → Now ends with
 *     storage_quota, nothing registered, the barrier released, not busy, play goes on in the same
 *     page; the retry updates to B. Then an unreadable record (another schema, with a barrier):
 *     read only at two starts, the record byte-for-byte as stored; a malformed one without a
 *     barrier: the game opens, Settings says updates are paused, the start's own check and resume
 *     leave the record as stored; the valid record back → the game as before.
 */

import { createHash } from "node:crypto";
import {
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
    c: { type: "string" },
    d: { type: "string" },
    seed: { type: "string" },
    out: { type: "string" },
    keep: { type: "boolean", default: false },
    only: { type: "string" },
  },
});
for (const k of ["a", "b", "c", "d", "seed"])
  if (!args[k]) {
    console.error(
      "usage: node scripts/f007-update-probe.mjs --a A --b B --c C --d D --seed seed.json [--out r.json]",
    );
    process.exit(2);
  }
const work = mkdtempSync(join(tmpdir(), "f007-t05-update-probe-"));
const seed = JSON.parse(readFileSync(resolve(args.seed), "utf8"));
const results = {
  probe: "f007-t05-update",
  playwright: require("playwright-core/package.json").version,
  checks: [],
  observations: [],
};
let failures = 0;
const check = (id, pass, detail) => {
  results.checks.push({ id, pass: !!pass, ...(pass ? {} : { detail }) });
  if (!pass) failures++;
  console.log(
    `${pass ? "PASS" : "FAIL"} ${id}${pass ? "" : ` — ${String(JSON.stringify(detail) ?? "").slice(0, 800)}`}`,
  );
};
const note = (what, value) => {
  results.observations.push({ what, value });
  console.log(`NOTE ${what}: ${JSON.stringify(value).slice(0, 400)}`);
};
const sha = (b) => createHash("sha256").update(b).digest("hex");
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

// ───────────────────────── releases and the host ─────────────────────────

const rel = {};
for (const k of ["a", "b", "c", "d"]) {
  const dir = resolve(args[k]);
  const id = readdirSync(join(dir, "releases"))[0];
  rel[k] = {
    dir,
    id,
    descriptor: JSON.parse(readFileSync(join(dir, "releases", id, "release.json"), "utf8")),
  };
}
const BASE = rel.a.descriptor.base;
results.releases = Object.fromEntries(
  Object.entries(rel).map(([k, r]) => [
    k,
    {
      id: r.id,
      table_commit: r.descriptor.inputs.table_commit,
      variant: r.descriptor.inputs.variant ?? null,
      db_version: r.descriptor.inputs.data.db_version,
      worker: r.descriptor.assets.find((a) => a.role === "worker").path,
      entry: r.descriptor.assets.find((a) => a.role === "entry").path,
      about: r.descriptor.assets.find((a) => /AboutPage/.test(a.path))?.path ?? null,
    },
  ]),
);
note("releases", results.releases);
check(
  "R0.distinct-builds",
  new Set(Object.values(results.releases).map((r) => r.worker)).size === 4 &&
    new Set(Object.values(results.releases).map((r) => r.entry)).size === 4 &&
    new Set(Object.values(results.releases).map((r) => r.about)).size === 4,
  results.releases,
);
const srdDir = dirname(require.resolve("srd-rules-engine/srd-5.2.1/manifest.json"));
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

function makeSite(name) {
  const site = join(work, `site-${name}`);
  const d = join(site, BASE.slice(1));
  mkdirSync(d, { recursive: true });
  cpSync(srdDir, join(d, "content/srd-5.2.1"), { recursive: true });
  writeFileSync(
    join(d, "legacy.html"),
    "<!doctype html><title>F006-like page</title><p>an old page of the base, without the update protocol</p>",
  );
  mkdirSync(join(site, "other"), { recursive: true });
  writeFileSync(
    join(site, "other/index.html"),
    "<!doctype html><title>other app</title><p>another app of this origin</p>",
  );
  return { site, d };
}
/** Publish a release like the dnd5 publisher: immutable files added (never replaced), root HTML and pointer switched. */
function publish(host, r, { damage = false } = {}) {
  for (const f of readdirSync(join(r.dir, "assets"))) {
    const to = join(host.d, "assets", f);
    if (!existsSync(to)) cpSync(join(r.dir, "assets", f), to);
  }
  mkdirSync(join(host.d, "assets"), { recursive: true });
  cpSync(join(r.dir, "releases", r.id), join(host.d, "releases", r.id), { recursive: true });
  cpSync(join(r.dir, `sw-${r.id}.js`), join(host.d, `sw-${r.id}.js`));
  cpSync(join(r.dir, "index.html"), join(host.d, "index.html"));
  if (damage) {
    const about = r.descriptor.assets.find((a) => /AboutPage/.test(a.path)).path;
    writeFileSync(
      join(host.d, about),
      `${readFileSync(join(host.d, about), "utf8")}\n// damaged on the host`,
    );
  }
  const descriptorPath = `releases/${r.id}/release.json`;
  writeFileSync(
    join(host.d, "release.json"),
    JSON.stringify({
      format: "srd-table.release-pointer/1",
      base: BASE,
      release_id: r.id,
      descriptor: descriptorPath,
      descriptor_sha256: sha(readFileSync(join(host.d, descriptorPath))),
    }),
  );
}
function host(name) {
  const h = { ...makeSite(name), server: null, port: 0 };
  h.start = () =>
    new Promise((ok) => {
      h.server = createServer((req, res) => {
        const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
        let file = join(h.site, path);
        if (!file.startsWith(h.site)) return res.writeHead(400).end();
        if (path.endsWith("/")) file = join(file, "index.html");
        if (!existsSync(file) || !statSync(file).isFile())
          return res.writeHead(404, { "content-type": "text/plain" }).end("not found");
        const body = readFileSync(file);
        res.writeHead(200, {
          "content-type": TYPES[extname(file)] ?? "application/octet-stream",
          "content-length": body.length,
          "cache-control": "no-cache",
        });
        res.end(body);
      });
      h.server.listen(h.port, "127.0.0.1", () => {
        h.port = h.server.address().port;
        ok();
      });
    });
  h.stop = () =>
    new Promise((ok) => {
      h.server.closeAllConnections?.();
      h.server.close(() => ok());
    });
  h.url = (p = "") => `http://127.0.0.1:${h.port}${BASE}${p}`;
  return h;
}

// ───────────────────────── browser helpers ─────────────────────────

const pageErrors = [];
const contexts = new Set();
async function launch(dir) {
  const ctx = await pw.chromium.launchPersistentContext(join(work, dir), { headless: true });
  contexts.add(ctx);
  ctx.on("close", () => contexts.delete(ctx));
  return ctx;
}
async function tab(ctx, h, route = "characters") {
  const page = ctx.pages().find((p) => p.url() === "about:blank") ?? (await ctx.newPage());
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await page.goto(`${h.url()}#/${route}`);
  await page.waitForFunction(
    () =>
      document.body.innerText.includes("SRD Table") &&
      !document.body.innerText.includes("Opening the table"),
    null,
    { timeout: 60_000 },
  );
  return page;
}
async function reopen(page, h, route) {
  await page.goto(`${h.url()}#/${route}`);
  await page.reload();
  await page.waitForFunction(
    () =>
      document.body.innerText.includes("SRD Table") &&
      !document.body.innerText.includes("Opening the table"),
    null,
    { timeout: 60_000 },
  );
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
      new Promise((resolve, reject) => {
        const r = indexedDB.open("srd-table");
        r.onerror = () => reject(r.error);
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
            const q = n === "settings" ? tx.objectStore(n).getAll() : tx.objectStore(n).getAll();
            const k = n === "settings" ? tx.objectStore(n).getAllKeys() : null;
            q.onsuccess = () => {
              out[n] = n === "packs" ? q.result.map((p) => p.key) : q.result;
              if (k)
                k.onsuccess = () => {
                  out.settings = Object.fromEntries(k.result.map((key, i) => [key, q.result[i]]));
                  if (--left === 0) {
                    db.close();
                    resolve(out);
                  }
                };
              else if (--left === 0) {
                db.close();
                resolve(out);
              }
            };
          }
        };
      }),
  );
const game = (dump) =>
  jcs({
    characters: dump.characters,
    history: dump.history,
    history_meta: dump.history_meta,
    packs: dump.packs,
    campaign: dump.settings.campaign,
    ctx: dump.settings["offline.campaign-context.v1"] ?? null,
  });
const putRows = (page, rows) =>
  page.evaluate(
    (rows) =>
      new Promise((resolve, reject) => {
        const r = indexedDB.open("srd-table");
        r.onsuccess = () => {
          const db = r.result;
          const tx = db.transaction([...new Set(rows.map((x) => x.store))], "readwrite");
          for (const x of rows)
            x.key
              ? tx.objectStore(x.store).put(x.value, x.key)
              : tx.objectStore(x.store).put(x.value);
          tx.oncomplete = () => {
            db.close();
            resolve(true);
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
    rows,
  );
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
const aboutId = async (page, h) => {
  await reopen(page, h, "about");
  await page.getByTestId("about-version").waitFor({ timeout: 30_000 });
  return (await page.getByTestId("about-version").innerText()).replace(/^Version\s+/, "");
};
const CHAR = "c-updateprobe1";
const now = 1760900000000;
const seedRows = [
  {
    store: "characters",
    value: {
      id: CHAR,
      build: { ...seed.source.build, name: "Una" },
      state: seed.source.state,
      created: now,
      updated: now,
      rev: 1,
      gen: 0,
    },
  },
];
async function prepare(page, h) {
  await reopen(page, h, "settings");
  await page.getByTestId("offline-target").selectOption(`character:${CHAR}`);
  await page
    .getByTestId("offline-readiness")
    .getByRole("button", { name: "Prepare offline" })
    .click();
  await until(
    async () =>
      (await page.getByTestId("offline-status").getAttribute("data-status")) === "checking" &&
      (await page.getByRole("button", { name: "Reload to finish" }).count()) > 0,
    120_000,
    "prepared",
  );
  await reopen(page, h, "settings");
}
async function damage(page, h, n) {
  await reopen(page, h, `characters/${CHAR}/sheet`);
  const hp = page.getByRole("region", { name: "Hit Points" });
  await hp.waitFor({ timeout: 60_000 });
  const before = (await dumpDb(page)).history.length;
  await hp.getByPlaceholder("Amount").fill(String(n));
  await hp.getByRole("button", { name: "Damage" }).click();
  await until(
    async () => (await dumpDb(page)).history.length === before + 1,
    20_000,
    "damage saved",
  );
  await page.waitForTimeout(400);
}
/** Settings → App updates: check, download. */
async function checkAndDownload(page, h) {
  await reopen(page, h, "settings");
  await page.getByRole("button", { name: "Check for an update" }).click();
  const offer = page.getByTestId("update-offer").first();
  await until(
    async () => ["offered", "downloaded"].includes(await offer.getAttribute("data-phase")),
    30_000,
    "offer",
  );
  if ((await offer.getAttribute("data-phase")) === "offered") {
    await offer.getByRole("button", { name: "Download" }).click();
    await until(
      async () =>
        (await offer.getAttribute("data-phase")) !== "offered" ||
        (await page.getByTestId("update-last-error").count()) > 0,
      60_000,
      "download",
    );
  }
  return offer.getAttribute("data-phase");
}
async function clickNow(page) {
  const offer = page.getByTestId("update-offer").first();
  await offer.getByRole("button", { name: /^(Update now|Try again)$/ }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Update now" }).click();
}
const updateState = async (page) => (await dumpDb(page)).settings["offline.update.v1"] ?? null;

// ───────────────────────── scenarios ─────────────────────────

async function u1to4() {
  const h = host("main");
  publish(h, rel.a);
  await h.start();
  note("origin", h.url());
  let ctx = await launch("profile-main");
  let p1 = await tab(ctx, h);
  check("U0.no-sw-before-preparation", (await reg(p1)).active === null);
  await putRows(p1, seedRows);
  await prepare(p1, h);
  const r0 = await reg(p1);
  check("U0.prepared-on-A", r0.active === swOf(rel.a.id) && r0.controller === swOf(rel.a.id), r0);
  await damage(p1, h, 2);
  // U1 offer + download without registration, Later, cold restarts
  publish(h, rel.b);
  const phase = await checkAndDownload(p1, h);
  check("U1.downloaded", phase === "downloaded", phase);
  const cached = await p1.evaluate(
    async (id) => (await caches.keys()).filter((k) => k.includes(id)),
    rel.b.id,
  );
  const r1 = await reg(p1);
  check(
    "U1.candidate-cached-not-registered",
    cached.length >= 1 && r1.active === swOf(rel.a.id) && !r1.waiting && !r1.installing,
    { cached, r1 },
  );
  await p1.getByTestId("update-offer").first().getByRole("button", { name: "Later" }).click();
  await until(async () => (await updateState(p1))?.deferred_at, 10_000, "later");
  const s1 = await updateState(p1);
  check(
    "U1.later-no-consent",
    s1.consent === null && s1.phase === "downloaded" && s1.candidate.release_id === rel.b.id,
    s1,
  );
  const g1 = game(await dumpDb(p1));
  await ctx.close();
  ctx = await launch("profile-main");
  p1 = await tab(ctx, h);
  await p1.waitForTimeout(1500); // the start's own check of the pointer
  const r2 = await reg(p1);
  check(
    "U1.restart-still-A",
    r2.active === swOf(rel.a.id) &&
      r2.controller === swOf(rel.a.id) &&
      !r2.waiting &&
      !r2.installing,
    r2,
  );
  check("U1.restart-about-A", (await aboutId(p1, h)) === rel.a.id);
  check("U1.restart-same-data", game(await dumpDb(p1)) === g1);
  check("U1.restart-still-no-consent", (await updateState(p1)).consent === null);
  await ctx.close();
  await h.stop();
  ctx = await launch("profile-main");
  await h.start();
  await h.stop(); // host gone for this start
  p1 = await ctx.newPage();
  p1.on("pageerror", (e) => pageErrors.push(e.message));
  await p1.goto(h.url("#/characters")).catch(() => undefined);
  await p1.waitForFunction(
    () =>
      document.body.innerText.includes("SRD Table") &&
      !document.body.innerText.includes("Opening the table"),
    null,
    { timeout: 60_000 },
  );
  const r3 = await reg(p1);
  check(
    "U1.offline-restart-still-A",
    r3.active === swOf(rel.a.id) && !r3.waiting && game(await dumpDb(p1)) === g1,
    r3,
  );
  await ctx.close();
  await h.start();

  // U2 refusals with two tabs, an F006-like base page and another base's page
  ctx = await launch("profile-main");
  p1 = await tab(ctx, h, "settings");
  const p2 = await tab(ctx, h, `characters/${CHAR}/sheet`);
  const legacy = await ctx.newPage();
  await legacy.goto(h.url("legacy.html"));
  const other = await ctx.newPage();
  await other.goto(`http://127.0.0.1:${h.port}/other/`);
  await p2.getByRole("button", { name: "Long Rest" }).first().click(); // its preview stays open
  await reopen(p1, h, "settings");
  await clickNow(p1);
  const reasons = p1.getByTestId("update-reasons").first();
  await reasons.waitFor({ timeout: 30_000 });
  const codes = await reasons
    .locator("li")
    .evaluateAll((els) => els.map((e) => [e.dataset.code, e.textContent]));
  note("refusal reasons", codes);
  check(
    "U2.rest-preview-blocks",
    codes.some(([c]) => c === "rest_preview_open"),
    codes,
  );
  check(
    "U2.f006-page-unresponsive",
    codes.some(([c, t]) => c === "client_unresponsive" && /legacy\.html/.test(t)),
    codes,
  );
  check("U2.other-base-excluded", !codes.some(([, t]) => /\/other\//.test(t)), codes);
  const r4 = await reg(p1);
  check("U2.nothing-registered", r4.active === swOf(rel.a.id) && !r4.waiting && !r4.installing, r4);
  const s4 = await updateState(p1);
  check(
    "U2.barrier-released-consent-kept",
    s4.barrier === null && s4.consent?.release_id === rel.b.id && s4.phase === "consented",
    s4,
  );
  await p2.keyboard.press("Escape");
  await legacy.close();
  // the other tab plays on (thawed)
  const hp2 = p2.getByRole("region", { name: "Hit Points" });
  const h0 = (await dumpDb(p2)).history.length;
  await hp2.getByPlaceholder("Amount").fill("1");
  await hp2.getByRole("button", { name: "Damage" }).click();
  await until(async () => (await dumpDb(p2)).history.length === h0 + 1, 20_000, "thawed play");
  check("U2.thawed-play-goes-on", true);
  // a CAS conflict in the other tab: another write behind its back
  const row = (await dumpDb(p2)).characters.find((c) => c.id === CHAR);
  await putRows(p2, [{ store: "characters", value: { ...row, rev: row.rev + 40 } }]);
  await hp2.getByPlaceholder("Amount").fill("1");
  await hp2.getByRole("button", { name: "Heal" }).click();
  await p2.waitForTimeout(1200);
  await reopen(p1, h, "settings");
  await clickNow(p1);
  await reasons.waitFor({ timeout: 30_000 });
  const codes2 = await reasons.locator("li").evaluateAll((els) => els.map((e) => e.dataset.code));
  check("U2.conflict-blocks", codes2.includes("save_conflict"), codes2);
  check("U2.still-A", (await reg(p1)).active === swOf(rel.a.id));

  // U3 Now with both tabs coherent. The kept consent is withdrawn first ("Later"), so the reload
  // below doesn't resume it by itself (that path is U7); this one is the explicit "Now".
  await reopen(p1, h, "settings");
  await p1.getByTestId("update-offer").first().getByRole("button", { name: "Later" }).click();
  await until(async () => (await updateState(p1))?.consent === null, 10_000, "consent withdrawn");
  const before = await dumpDb(p1);
  await p2.reload();
  await p2.waitForFunction(
    () =>
      document.body.innerText.includes("SRD Table") &&
      !document.body.innerText.includes("Opening the table"),
    null,
    { timeout: 60_000 },
  );
  await other.close();
  const g3 = game(await dumpDb(p1));
  await reopen(p1, h, "settings");
  await clickNow(p1);
  await until(
    async () =>
      (await reg(p1)).controller === swOf(rel.b.id) &&
      (await reg(p2)).controller === swOf(rel.b.id) &&
      (await updateState(p1))?.barrier === null,
    90_000,
    "both on B",
  );
  await p1.waitForFunction(
    () =>
      document.body.innerText.includes("SRD Table") &&
      !document.body.innerText.includes("Opening the table"),
    null,
    { timeout: 60_000 },
  );
  const r5 = await reg(p1);
  check("U3.coherent-B", r5.active === swOf(rel.b.id) && !r5.waiting && !r5.installing, r5);
  check("U3.about-lazy-view-B", (await aboutId(p1, h)) === rel.b.id);
  check("U3.other-tab-reloaded-to-B", (await aboutId(p2, h)) === rel.b.id);
  const s5 = await updateState(p1);
  check(
    "U3.barrier-cleared",
    s5.barrier === null &&
      s5.phase === "idle" &&
      s5.active_release === rel.b.id &&
      s5.consent === null,
    s5,
  );
  check("U3.same-data", game(await dumpDb(p1)) === g3, { before: before.history.length });
  const worker = await p1.evaluate(
    () =>
      performance
        .getEntriesByType("resource")
        .map((e) => e.name)
        .find((n) => /worker-/.test(n)) ?? null,
  );
  check("U3.worker-B", worker?.endsWith(results.releases.b.worker), worker);
  const g4 = game(await dumpDb(p1));
  const hist = (await dumpDb(p1)).history
    .filter((e) => e.record_id === CHAR)
    .sort((a, b) => a.seq - b.seq);
  await ctx.close();

  // U4 cold restart with the host stopped: B, same data; the next action continues
  await h.stop();
  ctx = await launch("profile-main");
  p1 = await ctx.newPage();
  p1.on("pageerror", (e) => pageErrors.push(e.message));
  await p1.goto(h.url("#/characters")).catch(() => undefined);
  await p1.waitForFunction(
    () =>
      document.body.innerText.includes("SRD Table") &&
      !document.body.innerText.includes("Opening the table"),
    null,
    { timeout: 60_000 },
  );
  const r6 = await reg(p1);
  check("U4.offline-B", r6.active === swOf(rel.b.id) && r6.controller === swOf(rel.b.id), r6);
  check("U4.same-data", game(await dumpDb(p1)) === g4);
  await damage(p1, h, 1);
  const after = (await dumpDb(p1)).history
    .filter((e) => e.record_id === CHAR)
    .sort((a, b) => a.seq - b.seq);
  const last = after.at(-1);
  check(
    "U4.next-seq-no-replay",
    after.length === hist.length + 1 && last.seq === hist.at(-1).seq + 1 && last.kind === "play",
    { n: after.length, seq: last.seq },
  );
  await ctx.close();
}

async function u5() {
  const h = host("cand");
  publish(h, rel.a);
  await h.start();
  let ctx = await launch("profile-cand");
  let p = await tab(ctx, h);
  await putRows(p, seedRows);
  await prepare(p, h);
  const g0 = game(await dumpDb(p));
  publish(h, rel.b);
  check("U5.b-downloaded", (await checkAndDownload(p, h)) === "downloaded");
  // consent B (refused by an unresponsive base page): the consent stays…
  const legacy = await ctx.newPage();
  await legacy.goto(h.url("legacy.html"));
  await reopen(p, h, "settings");
  await clickNow(p);
  await p.getByTestId("update-reasons").first().waitFor({ timeout: 30_000 });
  check("U5.consent-B-kept", (await updateState(p)).consent?.release_id === rel.b.id);
  await legacy.close();
  // …until C is published: C is offered, the consent for B is gone (never C's)
  publish(h, rel.c);
  await reopen(p, h, "settings");
  await p.getByRole("button", { name: "Check for an update" }).click();
  await until(
    async () => (await updateState(p))?.candidate?.release_id === rel.c.id,
    30_000,
    "offer C",
  );
  const sc = await updateState(p);
  check("U5.c-offered-consent-cleared", sc.consent === null && sc.phase === "offered", sc);
  await ctx.close();
  ctx = await launch("profile-cand");
  p = await tab(ctx, h);
  await p.waitForTimeout(2000);
  const r = await reg(p);
  check(
    "U5.restart-registers-nothing",
    r.active === swOf(rel.a.id) && !r.waiting && !r.installing,
    r,
  );
  // a damaged C on the host: the download refuses it
  publish(h, rel.c, { damage: true });
  const phase = await checkAndDownload(p, h);
  const sd = await updateState(p);
  check(
    "U5.damaged-candidate-refused",
    phase === "offered" && sd.last_error?.code === "release_asset_hash",
    { phase, err: sd.last_error },
  );
  // an incompatible D (declares DB 5): offered as incompatible, no Now
  publish(h, rel.d);
  await reopen(p, h, "settings");
  await p.getByRole("button", { name: "Check for an update" }).click();
  await until(
    async () => (await updateState(p))?.candidate?.release_id === rel.d.id,
    30_000,
    "offer D",
  );
  const s = await updateState(p);
  await reopen(p, h, "settings");
  check(
    "U5.incompatible-not-offered-now",
    s.candidate.compatible === false &&
      s.last_error?.code === "update_incompatible" &&
      (await p.getByRole("button", { name: /^(Update now|Download)$/ }).count()) === 0,
    s,
  );
  const r2 = await reg(p);
  check(
    "U5.still-A-same-data",
    r2.active === swOf(rel.a.id) && !r2.waiting && game(await dumpDb(p)) === g0,
    r2,
  );
  await ctx.close();
  await h.stop();
}

async function u6() {
  const h = host("owner");
  publish(h, rel.a);
  await h.start();
  const ctx = await launch("profile-owner");
  const p = await tab(ctx, h);
  await putRows(p, seedRows);
  await prepare(p, h);
  // an owner window: holds the update lock and stores a barrier (as "Now" does before freezing)
  const owner = await ctx.newPage();
  await owner.goto(h.url("legacy.html"));
  await owner.evaluate((base) => {
    navigator.locks.request(`srd-table:${base}:update`, () => new Promise(() => {}));
  }, BASE);
  const st = await updateState(p);
  await putRows(p, [
    {
      store: "settings",
      key: "offline.update.v1",
      value: {
        ...(st ?? {
          schema: "srd-table.update-state/1",
          base: BASE,
          active_release: rel.a.id,
          candidate: null,
          deferred_at: null,
          last_error: null,
        }),
        phase: "gating",
        consent: { release_id: rel.b.id, at: 1, request_id: "u-probe00000001" },
        barrier: {
          request_id: "u-probe00000001",
          owner_client_id: "owner",
          target_release: rel.b.id,
          since: 1,
        },
      },
    },
  ]);
  const before = await dumpDb(p);
  const fresh = await ctx.newPage();
  fresh.on("pageerror", (e) => pageErrors.push(e.message));
  await fresh.goto(h.url("#/characters"));
  await fresh.waitForTimeout(3000);
  const text = await fresh.locator("body").innerText();
  check(
    "U6.new-window-waits",
    /new version of the app is installing|unfinished update/i.test(text) && !text.includes("Una"),
    text.slice(0, 200),
  );
  check("U6.no-writes-while-waiting", jcs(await dumpDb(p)) === jcs(before));
  await owner.close(); // the owner is gone: the browser releases its lock
  await until(
    async () => (await fresh.locator("body").innerText()).includes("Una"),
    30_000,
    "game opens",
  );
  const s = await updateState(fresh);
  check(
    "U6.owner-lost-recovered",
    // cleared by the new window (owner_lost); its own pointer check then finds nothing newer than A
    s.barrier === null && s.last_error?.code === "owner_lost",
    s,
  );
  check("U6.still-A", (await reg(fresh)).active === swOf(rel.a.id));
  await ctx.close();
  await h.stop();
}

/** U7: a consent kept after a refused "Now"; every window closed; the next start completes it. */
async function u7() {
  const h = host("resume");
  publish(h, rel.a);
  await h.start();
  let ctx = await launch("profile-resume");
  let p = await tab(ctx, h);
  await putRows(p, seedRows);
  await prepare(p, h);
  await damage(p, h, 2);
  const g0 = game(await dumpDb(p));
  publish(h, rel.b);
  check("U7.b-downloaded", (await checkAndDownload(p, h)) === "downloaded");
  const legacy = await ctx.newPage();
  await legacy.goto(h.url("legacy.html"));
  await reopen(p, h, "settings");
  await clickNow(p);
  await p.getByTestId("update-reasons").first().waitFor({ timeout: 30_000 });
  const s = await updateState(p);
  check(
    "U7.refused-consent-kept",
    s.consent?.release_id === rel.b.id &&
      s.barrier === null &&
      (await reg(p)).active === swOf(rel.a.id),
    s,
  );
  await ctx.close(); // every window, the old base page too
  ctx = await launch("profile-resume");
  p = await ctx.newPage();
  p.on("pageerror", (e) => pageErrors.push(e.message));
  await p.goto(h.url("#/characters"));
  await until(
    async () =>
      (await reg(p)).controller === swOf(rel.b.id) && (await updateState(p))?.barrier === null,
    90_000,
    "resumed update",
  );
  await p.waitForFunction(
    () =>
      document.body.innerText.includes("SRD Table") &&
      !document.body.innerText.includes("Opening the table"),
    null,
    { timeout: 60_000 },
  );
  const r = await reg(p);
  const st = await updateState(p);
  check(
    "U7.restart-completes-agreed-update",
    r.active === swOf(rel.b.id) &&
      !r.waiting &&
      st.phase === "idle" &&
      st.barrier === null &&
      st.active_release === rel.b.id,
    { r, st },
  );
  check("U7.same-data", game(await dumpDb(p)) === g0);
  check("U7.about-B", (await aboutId(p, h)) === rel.b.id);
  await ctx.close();
  await h.stop();
}

/**
 * U8: the browser is closed while the owner is registering B (its script held back by the host);
 * the next start: either the registration never finished (A active, barrier stored: cleared,
 * owner_lost, the kept consent tried again) or it did (B waiting/active): in both the agreed
 * update completes and the game opens on B — never A writing next to an active B.
 */
async function u8() {
  const h = host("late");
  publish(h, rel.a);
  await h.start();
  let ctx = await launch("profile-late");
  let p = await tab(ctx, h);
  await putRows(p, seedRows);
  await prepare(p, h);
  await damage(p, h, 3);
  const g0 = game(await dumpDb(p));
  publish(h, rel.b);
  check("U8.b-downloaded", (await checkAndDownload(p, h)) === "downloaded");
  await ctx.route(`**/sw-${rel.b.id}.js`, async (route) => {
    await new Promise((r) => setTimeout(r, 4000));
    await route.continue().catch(() => undefined);
  });
  await reopen(p, h, "settings");
  await clickNow(p);
  await until(async () => (await updateState(p))?.phase === "registering", 30_000, "registering");
  note("U8 closed at", (await updateState(p)).phase);
  await ctx.close();
  ctx = await launch("profile-late");
  p = await ctx.newPage();
  p.on("pageerror", (e) => pageErrors.push(e.message));
  await p.goto(h.url("#/characters"));
  await until(
    async () =>
      (await reg(p)).controller === swOf(rel.b.id) && (await updateState(p))?.phase === "idle",
    120_000,
    "the agreed update completed after the restart",
  );
  const r = await reg(p);
  const st = await updateState(p);
  check(
    "U8.restart-after-registering-completes",
    r.active === swOf(rel.b.id) &&
      !r.waiting &&
      st.barrier === null &&
      st.active_release === rel.b.id,
    { r, st },
  );
  check("U8.same-data", game(await dumpDb(p)) === g0);
  await ctx.close();
  await h.stop();
}

/** Damage in the page as it is (a same-document route change, no reload). */
async function damageInPlace(page, n) {
  await page.evaluate((id) => {
    location.hash = `#/characters/${id}/sheet`;
  }, CHAR);
  const hp = page.getByRole("region", { name: "Hit Points" });
  await hp.waitFor({ timeout: 60_000 });
  const before = (await dumpDb(page)).history.length;
  await hp.getByPlaceholder("Amount").fill(String(n));
  await hp.getByRole("button", { name: "Damage" }).click();
  await until(
    async () => (await dumpDb(page)).history.length === before + 1,
    20_000,
    "damage saved in place",
  );
  await page.waitForTimeout(400);
}

async function u9() {
  const h = host("fail");
  publish(h, rel.a);
  await h.start();
  const ctx = await launch("profile-fail");
  const p = await tab(ctx, h);
  await putRows(p, seedRows);
  await prepare(p, h);
  publish(h, rel.b);
  check("U9.b-downloaded", (await checkAndDownload(p, h)) === "downloaded");
  // R06-03: this page's write of the `registering` record fails as on a full metadata store.
  await p.evaluate(() => {
    const original = IDBObjectStore.prototype.put;
    window.__f007Put = original;
    IDBObjectStore.prototype.put = function (value, key) {
      if (this.name === "settings" && value && value.phase === "registering")
        throw new DOMException("metadata full (probe)", "QuotaExceededError");
      return original.call(this, value, key);
    };
  });
  await clickNow(p);
  const reasons = p.getByTestId("update-reasons").first();
  await reasons.waitFor({ timeout: 60_000 });
  const codes = await reasons.locator("li").evaluateAll((els) => els.map((e) => e.dataset.code));
  const s1 = await updateState(p);
  const r1 = await reg(p);
  check("U9.quota-reported", codes.includes("storage_quota"), codes);
  check(
    "U9.quota-nothing-registered-barrier-released",
    s1.phase === "consented" &&
      s1.barrier === null &&
      s1.consent?.release_id === rel.b.id &&
      s1.last_error?.code === "storage_quota" &&
      r1.active === swOf(rel.a.id) &&
      !r1.waiting &&
      !r1.installing,
    { s1, r1 },
  );
  check(
    "U9.quota-not-busy",
    await p
      .getByTestId("update-offer")
      .first()
      .getByRole("button", { name: "Try again" })
      .isEnabled(),
  );
  await damageInPlace(p, 1); // the gate is open: play goes on in this very page
  check("U9.quota-play-goes-on", true);
  const g = game(await dumpDb(p));
  await p.evaluate(() => {
    IDBObjectStore.prototype.put = window.__f007Put;
  });
  await p.evaluate(() => {
    location.hash = "#/settings";
  });
  await clickNow(p);
  await until(
    async () =>
      (await reg(p)).controller === swOf(rel.b.id) && (await updateState(p))?.phase === "idle",
    90_000,
    "retry updated to B",
  );
  const r2 = await reg(p);
  check("U9.retry-updates-B", r2.active === swOf(rel.b.id) && !r2.waiting && !r2.installing, r2);
  check("U9.retry-same-data", game(await dumpDb(p)) === g);

  // R06-02: an unreadable record with a barrier — read only, never written over.
  await reopen(p, h, "characters");
  const valid = await updateState(p);
  const future = {
    schema: "future-update/2",
    barrier: { request_id: "u-future", target_release: rel.c.id, owner: { n: [1, 2] } },
    consent: { release_id: rel.c.id, extra: true },
    opaque: "preserve",
  };
  await putRows(p, [{ store: "settings", key: "offline.update.v1", value: future }]);
  const readOnlyStart = async () => {
    await p.reload();
    await until(
      async () => (await p.locator("body").innerText()).includes("An unfinished update was found"),
      30_000,
      "read-only start",
    );
    await p.waitForTimeout(1000);
    return (await p.locator("body").innerText()).includes("Una");
  };
  const shown1 = await readOnlyStart();
  const after1 = await updateState(p);
  const shown2 = await readOnlyStart();
  const after2 = await updateState(p);
  check(
    "U9.unreadable-barrier-read-only-twice",
    !shown1 && !shown2 && jcs(after1) === jcs(future) && jcs(after2) === jcs(future),
    { after1, after2 },
  );
  // A malformed record without a barrier: the game opens, updates paused, the record kept.
  const malformed = { schema: "srd-table.update-state/1", phase: 42, barrier: null, extra: "keep" };
  await putRows(p, [{ store: "settings", key: "offline.update.v1", value: malformed }]);
  await reopen(p, h, "settings");
  await p.getByTestId("update-unreadable").waitFor({ timeout: 30_000 });
  check(
    "U9.unreadable-no-barrier-open-paused",
    (await p.getByRole("button", { name: "Check for an update" }).isDisabled()) &&
      (await p.getByTestId("update-offer").count()) === 0,
  );
  await p.waitForTimeout(6500); // the start's own pointer check and resume (after 5 s)
  check("U9.unreadable-no-barrier-kept", jcs(await updateState(p)) === jcs(malformed));
  await putRows(p, [{ store: "settings", key: "offline.update.v1", value: valid }]);
  await reopen(p, h, "characters");
  const back = {
    una: await until(
      async () => (await p.locator("body").innerText()).includes("Una"),
      30_000,
      "game back",
    ).catch(() => false),
    state: await updateState(p),
    reg: await reg(p),
  };
  check(
    "U9.valid-record-back",
    back.una && jcs(back.state) === jcs(valid) && back.reg.active === swOf(rel.b.id),
    { back, valid },
  );
  await ctx.close();
  await h.stop();
}

try {
  if (!args.only || args.only.includes("fail")) await u9();
  if (!args.only || args.only.includes("late")) await u8();
  if (!args.only || args.only.includes("main")) await u1to4();
  if (!args.only || args.only.includes("resume")) await u7();
  if (!args.only || args.only.includes("cand")) await u5();
  if (!args.only || args.only.includes("owner")) await u6();
} catch (error) {
  check("probe-completed", false, String(error?.stack ?? error));
  let i = 0;
  for (const ctx of contexts)
    for (const pg of ctx.pages()) {
      const body = await pg
        .locator("body")
        .innerText()
        .catch(() => "");
      note(`page ${i} at failure`, { url: pg.url(), body: body.slice(0, 300) });
      await pg.screenshot({ path: join(work, `fail-${i++}.png`) }).catch(() => undefined);
    }
}
check("no-page-errors", pageErrors.length === 0, pageErrors.slice(0, 10));
results.summary = { checks: results.checks.length, failed: failures };
console.log(`\n${results.checks.length - failures}/${results.checks.length} checks passed`);
if (args.out) writeFileSync(resolve(args.out), `${JSON.stringify(results, null, 2)}\n`);
if (!args.keep) rmSync(work, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
