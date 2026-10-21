#!/usr/bin/env node
/**
 * kenli F-007 T04: offline readiness on the PRODUCTION release in a real browser (dnd5
 * docs/features/F-007-offline-packs/contracts/offline.md §5). Not product code. One isolated
 * persistent Chromium profile on a loopback origin; "cold restart" = every page and the browser
 * closed, the host SERVER stopped (not navigator.onLine), the same profile launched again.
 *
 *   node scripts/f007-readiness-probe.mjs --release <bun scripts/release.ts output> --seed <seed.json> [--out r.json]
 *
 * `--seed`: `npx tsx scripts/f007-local-copy-seed.ts` output (synthetic SRD rogues, the F-005 test
 * pack); the probe adds a synthetic `test-extra` pack (1.0.0 served, 2.0.0 imported).
 *  R1 online, nothing prepared: no service worker registered; a legacy character (campaign packs
 *     srd + test-actions + test-extra, a dependency chain) and a pinned one (srd + test-actions +
 *     test-extra 2.0.0) not ready — campaign unprepared, app not prepared.
 *  R2 Prepare (Settings) the legacy character: the current release registered, the page left
 *     uncontrolled ("Reload to finish", no claim); reload → ready; the prepared context and stored
 *     packs exact; the pinned character ready too; storage protection shown apart.
 *  R3 cold restart, host stopped: the app opens from its own files; never-visited Compendium spell
 *     description and a monster (worker, tables from the device); on the legacy character damage,
 *     temporary HP, a Long Rest (DM's confirm), next day — saved; local copy export uses the exact
 *     prepared context.
 *  R4 cold restart again, host still stopped: the same records, full history, day, Long Rests;
 *     the next action continues at the next seq.
 *  R5 the host back with OTHER pack bytes (test-actions, test-extra 1.0.1): nothing replaced — the
 *     campaign still plays the prepared versions, no new pack rows, still ready.
 *  R6 failures: a missing release chunk → not ready → Prepare again restores the SAME release →
 *     ready; a damaged stored pack → damaged, the binding kept (no host fallback); a missing exact
 *     version → missing; another tab's write → save conflict, never ready.
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
    release: { type: "string" },
    seed: { type: "string" },
    out: { type: "string" },
    keep: { type: "boolean", default: false },
  },
});
if (!args.release || !args.seed) {
  console.error(
    "usage: node scripts/f007-readiness-probe.mjs --release <dir> --seed <seed.json> [--out r.json]",
  );
  process.exit(2);
}
const work = mkdtempSync(join(tmpdir(), "f007-t04-readiness-probe-"));
const seed = JSON.parse(readFileSync(resolve(args.seed), "utf8"));
const results = {
  probe: "f007-t04-readiness",
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
  console.log(`NOTE ${what}: ${JSON.stringify(value).slice(0, 300)}`);
};

// ───────────────────────── canonical JSON and pack refs (as the app's) ─────────────────────────

const sortKeys = (v) =>
  Array.isArray(v)
    ? v.map(sortKeys)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, sortKeys(v[k])]),
        )
      : v;
const jcs = (v) => JSON.stringify(sortKeys(v));
const sha = (s) => createHash("sha256").update(s).digest("hex");
const refOf = (files) => ({
  id: files["manifest.json"].manifest.id,
  version: files["manifest.json"].manifest.version ?? null,
  sha256: sha(jcs({ files })),
});
const keyOf = (r) => `${r.id}@${r.version ?? ""}#${r.sha256}`;

const extra = (version, name = `test-extra ${version}`) => ({
  "manifest.json": {
    name,
    manifest: { id: "test-extra", version, source: "test", requires: ["test-actions"] },
    tables: {},
  },
});
const TEST = seed.test_pack.files;
const EXTRA1 = extra("1.0.0");
const EXTRA2 = extra("2.0.0");
const TEST_OTHER = structuredClone(TEST);
TEST_OTHER["manifest.json"].name = "test-actions served later with other bytes";
const EXTRA_LATER = extra("1.0.1", "test-extra served later");
const srdRef = seed.content.packs[0];
const testRef = refOf(TEST);
const extra1Ref = refOf(EXTRA1);
const extra2Ref = refOf(EXTRA2);

// ───────────────────────── the host (a stoppable static server) ─────────────────────────

const descriptor = (() => {
  const dir = join(resolve(args.release), "releases");
  return JSON.parse(readFileSync(join(dir, readdirSync(dir)[0], "release.json"), "utf8"));
})();
const BASE = descriptor.base;
results.release = {
  id: descriptor.release_id,
  total_bytes: descriptor.total_bytes,
  files: descriptor.assets.length + 2,
  inputs: descriptor.inputs,
};
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
const site = join(work, "site");
const d = join(site, BASE.slice(1));
mkdirSync(d, { recursive: true });
cpSync(resolve(args.release), d, { recursive: true });
cpSync(srdDir, join(d, "content/srd-5.2.1"), { recursive: true });
function servePacks(later) {
  for (const [id, files] of [
    ["test-actions", later ? TEST_OTHER : TEST],
    ["test-extra", later ? EXTRA_LATER : EXTRA1],
  ]) {
    mkdirSync(join(d, `content/${id}`), { recursive: true });
    writeFileSync(join(d, `content/${id}/manifest.json`), JSON.stringify(files["manifest.json"]));
  }
}
servePacks(false);
let server = null;
let port = 0;
function startHost() {
  return new Promise((ok) => {
    server = createServer((req, res) => {
      const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
      let file = join(site, path);
      if (!file.startsWith(site)) return res.writeHead(400).end();
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
    server.listen(port, "127.0.0.1", () => {
      port = server.address().port;
      ok();
    });
  });
}
function stopHost() {
  return new Promise((ok) => {
    server.closeAllConnections?.();
    server.close(() => ok());
  });
}

// ───────────────────────── the browser ─────────────────────────

const profileDir = join(work, "profile");
let ctx = null;
const pageErrors = [];
async function launch() {
  ctx = await pw.chromium.launchPersistentContext(profileDir, { headless: true });
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  page.on("pageerror", (e) => pageErrors.push(e.message));
  return page;
}
async function closeBrowser() {
  if (ctx) await ctx.close();
  ctx = null;
}
const url = () => `http://127.0.0.1:${port}${BASE}`;
async function open(page, path = "characters") {
  const t0 = Date.now();
  await page.goto(`${url()}#/${path}`);
  await page.reload();
  await page.waitForFunction(
    () =>
      document.body.innerText.includes("SRD Table") &&
      !document.body.innerText.includes("Opening the table"),
    null,
    { timeout: 60_000 },
  );
  return Date.now() - t0;
}
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
            const q =
              n === "settings" ? tx.objectStore(n).getAllKeys() : tx.objectStore(n).getAll();
            q.onsuccess = () => {
              out[n] =
                n === "packs"
                  ? q.result.map((p) => ({ key: p.key, ref: p.ref, origin: p.origin.kind }))
                  : q.result;
              if (--left === 0) {
                db.close();
                resolve(out);
              }
            };
          }
        };
      }),
  );
const getSetting = (page, key) =>
  page.evaluate(
    (key) =>
      new Promise((resolve) => {
        const r = indexedDB.open("srd-table");
        r.onsuccess = () => {
          const q = r.result.transaction("settings").objectStore("settings").get(key);
          q.onsuccess = () => {
            r.result.close();
            resolve(q.result ?? null);
          };
        };
      }),
    key,
  );
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
const deleteRow = (page, store, key) =>
  page.evaluate(
    ([store, key]) =>
      new Promise((resolve) => {
        const r = indexedDB.open("srd-table");
        r.onsuccess = () => {
          const tx = r.result.transaction(store, "readwrite");
          tx.objectStore(store).delete(key);
          tx.oncomplete = () => {
            r.result.close();
            resolve(true);
          };
        };
      }),
    [store, key],
  );
async function until(fn, ms = 30_000) {
  const end = Date.now() + ms;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** Settings → Offline play for a character: its status and items. */
async function readiness(page, id, { prepare = false, check = false } = {}) {
  await open(page, "settings");
  const panel = page.getByTestId("offline-readiness");
  await page.getByTestId("offline-target").selectOption(`character:${id}`);
  await panel.waitFor({ timeout: 30_000 });
  if (check) await panel.getByRole("button", { name: "Check again" }).click();
  if (prepare) await panel.getByRole("button", { name: "Prepare offline" }).click();
  const status = page.getByTestId("offline-status");
  await until(async () => {
    const s = await status.getAttribute("data-status");
    return (
      s &&
      s !== "preparing" &&
      (await page.getByTestId("offline-item").count()) > 0 &&
      !(await page.getByRole("status").count())
    );
  }, 120_000);
  await page.waitForTimeout(300);
  const items = await page
    .getByTestId("offline-item")
    .evaluateAll((els) =>
      els.map((e) => ({ kind: e.dataset.kind, state: e.dataset.state, text: e.textContent })),
    );
  return {
    status: await status.getAttribute("data-status"),
    items,
    storage: await page.getByTestId("offline-storage").getAttribute("data-persisted"),
    reload: await page.getByRole("button", { name: "Reload to finish" }).count(),
  };
}
const history = (dump, id) =>
  dump.history.filter((e) => e.record_id === id).sort((a, b) => a.seq - b.seq);
const metaOf = (dump, id) => dump.history_meta.find((m) => m.record_id === id);

const LEGACY = "c-legacyprobe1";
const PINNED = "c-pinnedprobe1";
const now = 1760900000000;
const character = (id, docs, content, name) => ({
  store: "characters",
  value: {
    id,
    build: { ...docs.build, name },
    state: docs.state,
    created: now,
    updated: now,
    rev: 1,
    gen: 0,
    ...(content ? { content } : {}),
  },
});
const packRow = (ref, files, kind) => ({
  store: "packs",
  value: {
    key: keyOf(ref),
    ref,
    files,
    installed_at: now,
    origin:
      kind === "bundled" ? { kind } : { kind, file: `${ref.id}.transfer.json`, bytes_sha256: null },
  },
});

async function main() {
  await startHost();
  note("origin", url());
  let page = await launch();

  // R1 online, nothing prepared
  await open(page);
  check(
    "R1.no-sw-before-preparation",
    await page.evaluate(
      async () => !(await navigator.serviceWorker.getRegistration(location.pathname)),
    ),
  );
  await putRows(page, [
    {
      store: "settings",
      key: "campaign",
      value: { version: 1, packs: ["srd-5.2.1", "test-actions", "test-extra"], sources: null },
    },
    character(LEGACY, seed.source, null, "Lea"),
    character(PINNED, seed.other, { packs: [srdRef, testRef, extra2Ref], sources: null }, "Pim"),
    packRow(testRef, TEST, "import"),
    packRow(extra2Ref, EXTRA2, "import"),
  ]);
  const r1 = await readiness(page, LEGACY);
  check(
    "R1.legacy-not-ready",
    r1.status === "incomplete" &&
      r1.items.some((i) => i.kind === "pack" && /not prepared/.test(i.text)) &&
      r1.items.some((i) => i.kind === "app" && i.state === "missing"),
    r1,
  );
  check(
    "R1.no-sw-still",
    await page.evaluate(
      async () => !(await navigator.serviceWorker.getRegistration(location.pathname)),
    ),
  );

  // R2 prepare (legacy), first registration: not claimed → reload to finish
  const r2 = await readiness(page, LEGACY, { prepare: true });
  check("R2.prepared-reload-to-finish", r2.status === "checking" && r2.reload === 1, r2);
  const ctl = await page.evaluate(async () => ({
    controller: navigator.serviceWorker.controller?.scriptURL ?? null,
    active:
      (await navigator.serviceWorker.getRegistration(location.pathname))?.active?.scriptURL ?? null,
  }));
  check(
    "R2.registered-not-claimed",
    ctl.controller === null && ctl.active?.endsWith(`sw-${descriptor.release_id}.js`),
    ctl,
  );
  const r2b = await readiness(page, LEGACY); // open() reloads
  check(
    "R2.ready-after-reload",
    r2b.status === "ready" && r2b.items.every((i) => i.state === "ok"),
    r2b,
  );
  note("storage protection", r2b.storage);
  check(
    "R2.storage-shown-apart",
    ["granted", "denied", "unsupported", "unknown"].includes(r2b.storage ?? ""),
    r2b.storage,
  );
  const prepared = await getSetting(page, "offline.campaign-context.v1");
  check(
    "R2.prepared-context-exact",
    jcs(prepared?.context?.packs) === jcs([srdRef, testRef, extra1Ref]) &&
      jcs(prepared?.packs) === jcs(["srd-5.2.1", "test-actions", "test-extra"]) &&
      prepared?.release_id === descriptor.release_id,
    prepared?.context,
  );
  const dump2 = await dumpDb(page);
  check(
    "R2.packs-stored",
    [srdRef, testRef, extra1Ref, extra2Ref].every((r) =>
      dump2.packs.some((p) => p.key === keyOf(r)),
    ),
    dump2.packs.map((p) => p.key),
  );
  check("R2.record-not-pinned", !dump2.characters.find((c) => c.id === LEGACY).content);
  const p2 = await readiness(page, PINNED, { prepare: true });
  check("R2.pinned-ready", p2.status === "ready", p2);

  // R3 cold restart, host stopped
  await closeBrowser();
  await stopHost();
  const t0 = Date.now();
  page = await launch();
  const startMs = await open(page);
  note("cold start offline (launch→app)", {
    ms: Date.now() - t0,
    navigation_ms: startMs,
    release_bytes: descriptor.total_bytes,
  });
  await page
    .getByText(/^(Lea|Pim)$/)
    .first()
    .waitFor({ timeout: 30_000 })
    .catch(() => undefined);
  const body3 = await page.locator("body").innerText();
  check(
    "R3.opens-offline",
    (body3.includes("Lea") || body3.includes("Pim")) && !body3.includes("Something went wrong"),
    body3.slice(0, 300),
  );
  await open(page, "compendium?table=spells&id=fire-bolt");
  await page
    .getByText(/Fire Bolt/)
    .first()
    .waitFor({ timeout: 30_000 });
  const spell = await page.locator("body").innerText();
  check("R3.unvisited-compendium-spell", /hurl a mote of fire/i.test(spell), spell.slice(0, 300));
  await open(page, "compendium?table=monsters&id=goblin-warrior");
  await page
    .getByText(/Goblin Warrior/)
    .first()
    .waitFor({ timeout: 30_000 });
  check(
    "R3.unvisited-monster-table",
    (await page.locator("body").innerText()).includes("Goblin Warrior"),
  );
  await open(page, `characters/${LEGACY}/sheet`);
  const hp = page.getByRole("region", { name: "Hit Points" });
  await hp.waitFor({ timeout: 60_000 });
  await hp.getByPlaceholder("Amount").fill("3");
  await hp.getByRole("button", { name: "Damage" }).click();
  await page.waitForTimeout(500);
  await hp.getByPlaceholder("Amount").fill("5");
  await hp.getByRole("button", { name: "Temporary" }).click();
  await page.waitForTimeout(500);
  await page.getByRole("button", { name: "Long Rest" }).first().click();
  await page.getByRole("dialog").getByRole("button", { name: "Confirm" }).click();
  await page.waitForTimeout(800);
  await page.getByRole("button", { name: "History: what this character played" }).click();
  await page.getByRole("button", { name: "Next day" }).first().click();
  await page.keyboard.press("Escape");
  await until(
    async () => (await dumpDb(page)).history.filter((e) => e.record_id === LEGACY).length >= 3,
  );
  await page.waitForTimeout(1200);
  const d3 = await dumpDb(page);
  const h3 = history(d3, LEGACY);
  const m3 = metaOf(d3, LEGACY);
  check(
    "R3.actions-saved",
    h3.length >= 3 && h3.some((e) => e.kind === "long_rest") && m3?.days.length === 2,
    { kinds: h3.map((e) => e.kind), days: m3?.days.length },
  );
  const rec3 = d3.characters.find((c) => c.id === LEGACY);
  // damage, temporary HP and the Long Rest each changed the document (the rest restores it)
  check("R3.state-changed-by-play", rec3.rev >= 4 && h3.filter((e) => e.commit).length >= 3, {
    rev: rec3.rev,
  });
  await open(page);
  await page
    .locator("article")
    .filter({ has: page.getByRole("heading", { name: "Lea", exact: true }) })
    .getByRole("button", { name: "Local copy with state and history" })
    .click();
  await page.getByTestId("local-copy-export-summary").waitFor({ timeout: 60_000 });
  const [dl] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Save the file" }).click(),
  ]);
  const copyFile = join(work, "lea.local-copy.json");
  await dl.saveAs(copyFile);
  const copy = JSON.parse(readFileSync(copyFile, "utf8"));
  check(
    "R3.local-copy-uses-prepared-context",
    jcs(copy.payload.character.context) === jcs(prepared.context) &&
      copy.payload.source.legacy_context?.settings_fingerprint === prepared.settings_fingerprint,
  );

  // R4 second cold restart, host still stopped
  await closeBrowser();
  page = await launch();
  await open(page);
  const d4 = await dumpDb(page);
  check(
    "R4.same-after-restart",
    jcs(d4.characters) === jcs(d3.characters) &&
      jcs(history(d4, LEGACY)) === jcs(h3) &&
      jcs(metaOf(d4, LEGACY)) === jcs(m3),
  );
  await open(page, `characters/${LEGACY}/sheet`);
  const hp4 = page.getByRole("region", { name: "Hit Points" });
  await hp4.waitFor({ timeout: 60_000 });
  await hp4.getByPlaceholder("Amount").fill("1");
  await hp4.getByRole("button", { name: "Damage" }).click();
  await until(async () => history(await dumpDb(page), LEGACY).length === h3.length + 1);
  const d4b = await dumpDb(page);
  const last = history(d4b, LEGACY).at(-1);
  check(
    "R4.next-seq-on-current-day",
    last.seq === h3.at(-1).seq + 1 &&
      last.day_id === m3.current_day_id &&
      metaOf(d4b, LEGACY).next_seq === last.seq + 1,
    { seq: last.seq },
  );
  const lr = history(d4b, LEGACY).filter(
    (e) => e.rest_kind === "long" && e.status === "done",
  ).length;
  check(
    "R4.long-rests-kept",
    lr === h3.filter((e) => e.rest_kind === "long" && e.status === "done").length && lr >= 1,
  );
  const r4 = await readiness(page, LEGACY);
  check("R4.ready-offline", r4.status === "ready", r4);

  // R5 host back with other pack bytes: nothing replaced
  servePacks(true);
  await startHost();
  await closeBrowser();
  page = await launch();
  await open(page, "settings");
  await page.waitForTimeout(1500);
  const loaded = await page.locator("body").innerText();
  check(
    "R5.campaign-keeps-prepared-versions",
    /test-extra 1\.0\.0/.test(loaded) && !/test-extra 1\.0\.1/.test(loaded),
    loaded.match(/Loaded packs[^\n]*/)?.[0],
  );
  const d5 = await dumpDb(page);
  check(
    "R5.no-pack-replaced-or-added",
    !d5.packs.some((p) => p.key.startsWith("test-extra@1.0.1")) &&
      jcs(d5.packs.map((p) => p.key).sort()) === jcs(d4b.packs.map((p) => p.key).sort()),
  );
  check(
    "R5.prepared-key-unchanged",
    jcs(await getSetting(page, "offline.campaign-context.v1")) === jcs(prepared),
  );
  const r5 = await readiness(page, LEGACY);
  check("R5.still-ready", r5.status === "ready", r5);

  // R6 failures
  // (a) a missing chunk of this release → not ready → Prepare again restores the same release
  const removed = await page.evaluate(async () => {
    const names = await caches.keys();
    const name = names.find((n) => n.includes(":r-") && !n.endsWith(":install-failed"));
    const cache = await caches.open(name);
    const keys = await cache.keys();
    const victim =
      keys.find((k) => /\/assets\/AboutPage-[^/]+\.js$/.test(k.url)) ??
      keys.find((k) => k.url.includes("/assets/") && k.url.endsWith(".js"));
    await cache.delete(victim);
    return victim.url;
  });
  note("removed from the release cache", removed);
  const r6a = await readiness(page, LEGACY, { check: true });
  check(
    "R6a.missing-chunk-not-ready",
    r6a.status === "incomplete" && r6a.items.some((i) => i.kind === "app" && i.state === "missing"),
    r6a,
  );
  const r6b = await readiness(page, LEGACY, { prepare: true });
  check("R6a.same-release-restored", r6b.status === "ready", r6b);
  const regs = await page.evaluate(async () =>
    (await navigator.serviceWorker.getRegistrations()).map((r) => r.active?.scriptURL),
  );
  check(
    "R6a.no-other-release",
    regs.length === 1 && regs[0].endsWith(`sw-${descriptor.release_id}.js`),
    regs,
  );
  // (b) a damaged stored pack (the pinned 2.0.0): damaged, no host fallback; (c) missing exact version
  await putRows(page, [
    packRow(
      extra2Ref,
      { "manifest.json": { ...EXTRA2["manifest.json"], name: "tampered" } },
      "import",
    ),
  ]);
  const r6c = await readiness(page, PINNED);
  check(
    "R6b.damaged-pack-not-ready",
    r6c.status === "incomplete" &&
      r6c.items.some((i) => i.kind === "pack" && i.state === "corrupt"),
    r6c,
  );
  await deleteRow(page, "packs", keyOf(extra2Ref));
  const r6d = await readiness(page, PINNED, { prepare: true });
  check(
    "R6c.missing-exact-version",
    r6d.status === "incomplete" &&
      r6d.items.some((i) => i.kind === "pack" && i.state === "missing" && /Import/.test(i.text)),
    r6d,
  );
  check(
    "R6c.not-replaced-by-another-version",
    !(await dumpDb(page)).packs.some(
      (p) => p.key.startsWith("test-extra@2.0.0") || p.key.startsWith("test-extra@1.0.1"),
    ),
  );
  // (d) another tab wrote the record → save conflict, never ready
  const row = (await dumpDb(page)).characters.find((c) => c.id === LEGACY);
  await putRows(page, [{ store: "characters", value: { ...row, rev: row.rev + 10 } }]);
  await open(page, `characters/${LEGACY}/sheet`);
  await page.waitForTimeout(500);
  await putRows(page, [{ store: "characters", value: { ...row, rev: row.rev + 20 } }]);
  const hp6 = page.getByRole("region", { name: "Hit Points" });
  await hp6.waitFor({ timeout: 60_000 });
  await hp6.getByPlaceholder("Amount").fill("1");
  await hp6.getByRole("button", { name: "Heal" }).click();
  await page.waitForTimeout(1500);
  await page.getByRole("link", { name: /^Offline:/ }).click();
  await page.getByTestId("offline-target").selectOption(`character:${LEGACY}`);
  await until(async () =>
    ["failed", "ready", "incomplete"].includes(
      await page.getByTestId("offline-status").getAttribute("data-status"),
    ),
  );
  const conflict = await page.getByTestId("offline-status").getAttribute("data-status");
  const items = await page.getByTestId("offline-item").allTextContents();
  check(
    "R6d.conflict-never-ready",
    conflict === "failed" && items.some((t) => /another tab/.test(t)),
    { conflict, items },
  );

  await closeBrowser();
  await stopHost();
}

try {
  await main();
} catch (error) {
  check("probe-completed", false, String(error?.stack ?? error));
  if (ctx)
    await ctx
      .pages()[0]
      ?.screenshot({ path: join(work, "fail.png") })
      .catch(() => undefined);
} finally {
  if (ctx) await closeBrowser().catch(() => undefined);
  if (server?.listening) await stopHost().catch(() => undefined);
}
check("no-page-errors", pageErrors.length === 0, pageErrors.slice(0, 10));
results.summary = { checks: results.checks.length, failed: failures };
console.log(`\n${results.checks.length - failures}/${results.checks.length} checks passed`);
if (args.out) writeFileSync(resolve(args.out), `${JSON.stringify(results, null, 2)}\n`);
if (!args.keep) rmSync(work, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
