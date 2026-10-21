#!/usr/bin/env node
/**
 * kenli F-007 T03: the local copy in a real browser (dnd5
 * docs/features/F-007-offline-packs/contracts/local-copy.md). Not product code. Each installation
 * is its own persistent Chromium profile (its own IndexedDB); files go from one to another only as
 * downloaded files through the app's own buttons.
 *
 *   node scripts/f007-local-copy-probe.mjs --release <bun scripts/release.ts output> --seed <seed.json> [--dev] [--out r.json]
 *
 * `--seed`: `npx tsx scripts/f007-local-copy-seed.ts` output (synthetic rogue, test pack, the
 * contract's 595-entry journal). `--dev`: also run the publication-failure scenario on a Vite dev
 * server (the fault seam exists only in development builds; the release build is checked not to
 * have it).
 *  L1 I1 (release): a source with the 595-entry journal, live c-wizard and e-src77; export through
 *     the card's button and the preview; the source's database byte-identical after it.
 *  L2 I2: live records with the copy's ids (record, participant, encounter); load the file through
 *     "Load local copy": preview, Create; every record/entry/head/pack compared with I1's after the
 *     permitted id mapping; nothing bound to I2's records; close the browser, reopen the profile and
 *     play (Damage) on the copy: seq 596 on the current day, head rev 2, HP from the copy's state.
 *  L3 generations: I2 → I3 (collisions, new play) → back to I1 (where c-wizard and e-src77 live):
 *     canonical ext refs, never nested, names kept, nothing re-bound; I1's source untouched.
 *  L4 the same file again in I2: "already loaded", Create disabled until the explicit separate copy.
 *  L5 I4: Undo → reload (gone, no Undo after reload); Undo → Redo (same rows), reload (kept).
 *  L6 F-008 unchanged: the ordinary transfer export (with its "history stays" notice) imports into
 *     I4 through Import… as a character without history.
 *  L7 (--dev) publication fails after the transaction: "saved, not shown" with the import id; the
 *     copy whole in the database, the autosave doesn't touch it; "Try to show it again" shows the
 *     same copy (one record for the import id); another failure, then Reload shows it.
 */

import { spawn } from "node:child_process";
import {
  cpSync,
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
    release: { type: "string" },
    seed: { type: "string" },
    dev: { type: "boolean", default: false },
    out: { type: "string" },
    keep: { type: "boolean", default: false },
  },
});
if (!args.release || !args.seed) {
  console.error(
    "usage: node scripts/f007-local-copy-probe.mjs --release <dir> --seed <seed.json> [--dev] [--out r.json]",
  );
  process.exit(2);
}
const work = mkdtempSync(join(tmpdir(), "f007-t03-local-copy-probe-"));
const seed = JSON.parse(readFileSync(resolve(args.seed), "utf8"));
const results = {
  probe: "f007-t03-local-copy",
  playwright: require("playwright-core/package.json").version,
  checks: [],
  observations: [],
};
let failures = 0;
const check = (id, pass, detail) => {
  results.checks.push({ id, pass: !!pass, ...(pass ? {} : { detail }) });
  if (!pass) failures++;
  console.log(
    `${pass ? "PASS" : "FAIL"} ${id}${pass ? "" : ` — ${JSON.stringify(detail).slice(0, 800)}`}`,
  );
};
const note = (what, value) => {
  results.observations.push({ what, value });
  console.log(`NOTE ${what}: ${JSON.stringify(value).slice(0, 300)}`);
};

// ───────────────────────── canonical JSON (as the app's) ─────────────────────────

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

// ───────────────────────── a static host for the release ─────────────────────────

const descriptor = (() => {
  const dir = join(resolve(args.release), "releases");
  const rel = require("node:fs").readdirSync(dir)[0];
  return JSON.parse(readFileSync(join(dir, rel, "release.json"), "utf8"));
})();
const BASE = descriptor.base;
results.release = { id: descriptor.release_id, inputs: descriptor.inputs };
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
function host() {
  const dir = join(work, "site");
  const d = join(dir, BASE.slice(1));
  mkdirSync(d, { recursive: true });
  cpSync(resolve(args.release), d, { recursive: true });
  cpSync(srdDir, join(d, "content/srd-5.2.1"), { recursive: true });
  const srv = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
    let file = join(dir, path);
    if (!file.startsWith(dir)) return res.writeHead(400).end();
    if (path.endsWith("/")) file = join(file, "index.html");
    // an SPA host: a route of the app is its index.html
    if (!existsSync(file) && path.startsWith(BASE) && !extname(path)) file = join(d, "index.html");
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
  return new Promise((ok) =>
    srv.listen(0, "127.0.0.1", () => ok({ srv, origin: `http://127.0.0.1:${srv.address().port}` })),
  );
}

// ───────────────────────── browser profiles ─────────────────────────

const profiles = new Map();
const pageErrors = [];
async function profile(name) {
  const dir = join(work, `profile-${name}`);
  const ctx = await pw.chromium.launchPersistentContext(dir, {
    headless: true,
    acceptDownloads: true,
  });
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  page.on("pageerror", (e) => pageErrors.push(`${name}: ${e.message}`));
  profiles.set(name, ctx);
  return { ctx, page };
}
async function closeProfile(name) {
  const ctx = profiles.get(name);
  if (ctx) await ctx.close();
  profiles.delete(name);
}

/** Open (load) the app at a route (hash history: `#/characters/<id>/sheet`). */
async function openApp(page, url, path = "characters") {
  await page.goto(`${url}#/${path}`);
  await page.reload(); // a full load of the app, also when only the hash changed
  await page.waitForFunction(() => document.body.innerText.includes("SRD Table"), null, {
    timeout: 60_000,
  });
  if (path === "characters") await toList(page);
}
/** The characters list (the app may open the character last opened instead). */
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

/** In the page: every store of the app's database (packs by key/ref only). */
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
              out[n] = n === "packs" ? q.result.map((p) => ({ key: p.key, ref: p.ref })) : q.result;
              if (--left === 0) {
                db.close();
                resolve(out);
              }
            };
          }
        };
      }),
  );

/** In the page: put rows straight into the app's database (data an earlier session saved). */
const putRows = (page, rows) =>
  page.evaluate(
    (rows) =>
      new Promise((resolve, reject) => {
        const r = indexedDB.open("srd-table");
        r.onerror = () => reject(r.error);
        r.onsuccess = () => {
          const db = r.result;
          const stores = [...new Set(rows.map((x) => x.store))];
          const tx = db.transaction(stores, "readwrite");
          for (const x of rows) tx.objectStore(x.store).put(x.value);
          tx.oncomplete = () => {
            db.close();
            resolve(true);
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
    rows,
  );

const now = 1760900000000;
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
const encounterRow = (id, name) => ({
  store: "encounters",
  value: {
    id,
    name,
    encounter: seed.encounter,
    log: [],
    created: now,
    updated: now,
    rev: 1,
    gen: 0,
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

/** Click a card's button (by the character's name and the button's label). */
async function cardButton(page, name, label) {
  const card = page
    .locator("article")
    .filter({ has: page.getByRole("heading", { name, exact: true }) })
    .first();
  await card.getByRole("button", { name: label }).click();
}

async function exportCopy(page, name, file) {
  await cardButton(page, name, "Local copy with state and history");
  const summary = page.getByTestId("local-copy-export-summary");
  await summary.waitFor({ timeout: 60_000 });
  const text = await summary.innerText();
  const [dl] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Save the file" }).click(),
  ]);
  await dl.saveAs(file);
  return { text, suggested: dl.suggestedFilename() };
}

async function loadCopy(page, file, { another = false } = {}) {
  await page.getByRole("button", { name: "Load local copy" }).click();
  await page.getByTestId("local-copy-file").setInputFiles(file);
  const preview = page.getByTestId("local-copy-preview");
  const problem = page.getByTestId("local-copy-problem");
  await Promise.race([preview.waitFor({ timeout: 60_000 }), problem.waitFor({ timeout: 60_000 })]);
  if (await problem.isVisible()) return { problem: await problem.innerText() };
  const entries = await page.getByTestId("local-copy-entries").innerText();
  const already = await page.getByTestId("local-copy-already").isVisible();
  const label = already ? "Create another separate copy" : "Create the copy";
  const button = page.getByRole("button", { name: label, exact: true }).last();
  const disabledBefore = await button.isDisabled();
  if (already && another) await page.getByTestId("local-copy-another").check();
  if (already && !another) return { entries, already, disabledBefore };
  await button.click();
  const unpublished = page.getByTestId("local-copy-unpublished");
  const done = page
    .waitForURL(/\/characters\/c-[^/]+\/sheet/, { timeout: 60_000 })
    .then(() => "sheet");
  const r = await Promise.race([
    done,
    unpublished.waitFor({ timeout: 60_000 }).then(() => "unpublished"),
  ]);
  if (r === "unpublished")
    return { entries, already, disabledBefore, unpublished: await unpublished.innerText() };
  const id = /\/characters\/(c-[^/]+)\/sheet/.exec(page.url())?.[1];
  return { entries, already, disabledBefore, id };
}

// ───────────────────────── comparison after the permitted mapping (contract §6.1) ─────────────────────────

const isExt = (x) =>
  typeof x === "string" && /^ext:i[0-9a-f]{16}:[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(x);
const extOf = (inst, id) => (isExt(id) ? id : `ext:${inst}:${id}`);
function preserved(e) {
  const {
    id,
    record_id,
    operation_id,
    group_id,
    parent_op,
    undone_with,
    links,
    participants,
    context,
    effect,
    ...rest
  } = e;
  return {
    ...rest,
    participants: participants.map((p) => p.name),
    context: { ...context, encounter_id: context.encounter_id === null ? null : "*" },
    effect: { ...effect, replaces_op: effect.replaces_op === null ? null : "*" },
  };
}
const rowsOf = (dump, rid) =>
  dump.history.filter((e) => e.record_id === rid).sort((a, b) => a.seq - b.seq);
const rests = (rows) => {
  const by = {};
  let total = 0;
  for (const e of rows)
    if (e.rest_kind === "long" && e.status === "done") {
      total++;
      by[e.day_id] = (by[e.day_id] ?? 0) + 1;
    }
  return jcs({ total, by });
};
/** Source rows (as exported from `inst`) against the copy's rows in a target dump. */
function compare(srcRows, srcMeta, inst, dst, rid) {
  const errs = [];
  const rows = rowsOf(dst, rid);
  if (rows.length < srcRows.length) errs.push(`rows ${rows.length} < ${srcRows.length}`);
  const ops = new Map();
  for (const [i, e] of srcRows.entries()) {
    const n = rows[i];
    if (!n) break;
    if (ops.has(e.operation_id) && ops.get(e.operation_id) !== n.operation_id)
      errs.push(`op ${e.seq}`);
    ops.set(e.operation_id, n.operation_id);
  }
  const inv = new Map([...ops].map(([a, b]) => [b, a]));
  if (inv.size !== ops.size) errs.push("op map not injective");
  for (const [i, e] of srcRows.entries()) {
    const n = rows[i];
    if (!n) break;
    if (jcs(preserved(e)) !== jcs(preserved(n))) errs.push(`entry ${e.seq} preserved fields`);
    for (const k of ["group_id", "parent_op", "undone_with"])
      if ((e[k] === null) !== (n[k] === null) || (e[k] !== null && inv.get(n[k]) !== e[k]))
        errs.push(`entry ${e.seq} ${k}`);
    for (const k of ["follows", "continues"]) {
      const a = e.links[k];
      const b = n.links[k];
      if (a === null ? b !== null : ops.has(a) ? b !== ops.get(a) : b !== extOf(inst, a))
        errs.push(`entry ${e.seq} links.${k}`);
    }
    for (const p of n.participants)
      if (
        p.record_id !== rid &&
        (!isExt(p.record_id) ||
          /^ext:[^:]+:ext:/.test(p.record_id) ||
          dst.characters.some((c) => c.id === p.record_id))
      )
        errs.push(`entry ${e.seq} participant ${p.record_id}`);
    const enc = n.context.encounter_id;
    if (
      enc !== null &&
      (!isExt(enc) || /^ext:[^:]+:ext:/.test(enc) || dst.encounters.some((x) => x.id === enc))
    )
      errs.push(`entry ${e.seq} encounter ${enc}`);
  }
  if (rests(srcRows) !== rests(rows.slice(0, srcRows.length))) errs.push("Long Rests");
  const meta = dst.history_meta.find((m) => m.record_id === rid);
  if (srcMeta && jcs(srcMeta.days) !== jcs(meta?.days)) errs.push("days");
  return { errs: errs.slice(0, 20), rows, meta };
}

// ───────────────────────── scenarios ─────────────────────────

async function until(fn, ms = 30_000) {
  const end = Date.now() + ms;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 200));
  }
}
const pathOf = (v, path) => path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), v);

const SRC = "c-probesrc1";
async function main() {
  const { srv, origin } = await host();
  const url = `${origin}${BASE}`;
  note("origin", url);
  const other = { build: seed.other.build, state: seed.other.state };

  // L1: the source installation I1
  const i1 = await profile("I1");
  await openApp(i1.page, url);
  check(
    "L1.no-fault-seam-in-release",
    await i1.page.evaluate(() => globalThis.__srdTableLocalCopyFaults === undefined),
  );
  await putRows(i1.page, [
    testPackRow(),
    character(SRC, seed.source, seed.content),
    character("c-wizard", other, seed.content, "Syn Wizard"),
    encounterRow("e-src77", "Cragmaw ambush"),
    ...journalRows(SRC),
  ]);
  await openApp(i1.page, url);
  const d1 = await dumpDb(i1.page);
  const inst1 = d1.settings.includes("installation")
    ? await i1.page.evaluate(
        () =>
          new Promise((ok) => {
            const r = indexedDB.open("srd-table");
            r.onsuccess = () => {
              const q = r.result
                .transaction("settings")
                .objectStore("settings")
                .get("installation");
              q.onsuccess = () => {
                r.result.close();
                ok(q.result);
              };
            };
          }),
      )
    : null;
  note("I1 installation", inst1);
  check(
    "L1.srd-stored-bundled",
    d1.packs.some((p) => p.ref.id === "srd-5.2.1" && p.ref.sha256 === seed.content.packs[0].sha256),
    d1.packs,
  );
  const f1 = join(work, "copy1.local-copy.json");
  const x1 = await exportCopy(i1.page, seed.source.build.name, f1);
  note("export preview", x1.text);
  check("L1.preview", /595 history entries \(4 undone\), 6 days/.test(x1.text), x1.text);
  check("L1.file-name", /\.local-copy\.json$/.test(x1.suggested), x1.suggested);
  const copy1 = JSON.parse(readFileSync(f1, "utf8"));
  check(
    "L1.file-format",
    copy1.format === "srd-table.local-copy/1" && copy1.payload.history.entry_count === 595,
    copy1.format,
  );
  check(
    "L1.file-packs-self-contained",
    jcs(copy1.payload.packs.map((p) => p.id)) === jcs(["srd-5.2.1", "test-actions"]) &&
      !JSON.stringify(copy1.payload.packs.map((p) => p.requires)).includes("http"),
  );
  check(
    "L1.file-release-id",
    copy1.payload.source.release_id === descriptor.release_id,
    copy1.payload.source.release_id,
  );
  check(
    "L1.file-external",
    jcs(copy1.payload.external.encounters) ===
      jcs([{ encounter_id: "e-src77", name: "Cragmaw ambush" }]),
    copy1.payload.external,
  );
  results.copy1 = { bytes: statSync(f1).size, payload_sha256: copy1.payload_sha256 };
  const d1after = await dumpDb(i1.page);
  check("L1.source-unchanged", jcs(d1after) === jcs(d1));
  const srcRows = rowsOf(d1, SRC);
  const srcMeta = d1.history_meta.find((m) => m.record_id === SRC);
  const srcRecord = d1.characters.find((c) => c.id === SRC);

  // L2: I2 with colliding ids
  const i2 = await profile("I2");
  await openApp(i2.page, url);
  await putRows(i2.page, [
    testPackRow(),
    character(SRC, other, seed.content, "Collider"),
    character("c-wizard", other, seed.content, "Local wizard"),
    encounterRow("e-src77", "I2 local"),
  ]);
  await openApp(i2.page, url);
  const d2before = await dumpDb(i2.page);
  const l2 = await loadCopy(i2.page, f1);
  check("L2.preview-entries", l2.entries === "595 history entries: 591 done, 4 undone", l2);
  check("L2.created", typeof l2.id === "string" && l2.id !== SRC, l2);
  const d2 = await dumpDb(i2.page);
  const rec2 = d2.characters.find((c) => c.id === l2.id);
  check(
    "L2.record-docs-exact",
    jcs([rec2?.build, rec2?.state, rec2?.content]) ===
      jcs([srcRecord.build, srcRecord.state, srcRecord.content]),
  );
  check(
    "L2.record-identity-new",
    rec2?.rev === 1 &&
      rec2?.origin?.kind === "import" &&
      rec2?.origin?.extensions?.local_copy?.entry_count === 595,
    rec2?.origin,
  );
  const c2 = compare(srcRows, srcMeta, inst1, d2, l2.id);
  check("L2.entries-mapped", c2.errs.length === 0 && c2.rows.length === 595, c2.errs);
  check(
    "L2.head",
    c2.meta?.rev === 1 &&
      c2.meta?.next_seq === 596 &&
      c2.meta?.current_day_id === srcMeta.current_day_id,
    c2.meta,
  );
  check(
    "L2.statuses",
    jcs(c2.rows.map((e) => [e.seq, e.status, e.kind])) ===
      jcs(srcRows.map((e) => [e.seq, e.status, e.kind])),
  );
  check(
    "L2.collisions-untouched",
    jcs(d2before.characters) === jcs(d2.characters.filter((c) => c.id !== l2.id)) &&
      jcs(d2before.encounters) === jcs(d2.encounters),
  );
  check(
    "L2.ext-participant",
    c2.rows.some((e) => e.participants.some((p) => p.record_id === `ext:${inst1}:c-wizard`)),
  );
  check(
    "L2.ext-encounter-name",
    rec2?.origin?.extensions?.local_copy?.external?.encounters?.some(
      (e) => e.encounter_id === `ext:${inst1}:e-src77` && e.name === "Cragmaw ambush",
    ),
  );
  check(
    "L2.packs",
    d2.packs.some((p) => p.ref.id === "test-actions") &&
      d2.packs.some((p) => p.ref.id === "srd-5.2.1"),
  );
  // close the browser, reopen the profile, play on
  await closeProfile("I2");
  const i2b = await profile("I2");
  await openApp(i2b.page, url, `characters/${l2.id}/sheet`);
  const hpRegion = i2b.page.getByRole("region", { name: "Hit Points" });
  await hpRegion.waitFor({ timeout: 60_000 });
  await hpRegion.getByPlaceholder("Amount").fill("3");
  await hpRegion.getByRole("button", { name: "Damage" }).click();
  await until(
    async () => (await dumpDb(i2b.page)).history_meta.find((m) => m.record_id === l2.id)?.rev === 2,
  );
  const d2b = await dumpDb(i2b.page);
  const rows2b = rowsOf(d2b, l2.id);
  const last = rows2b.at(-1);
  check(
    "L2.reload-then-play",
    rows2b.length === 596 &&
      last?.seq === 596 &&
      last?.day_id === srcMeta.current_day_id &&
      last?.kind === "play",
    last && { seq: last.seq, kind: last.kind, day: last.day_id },
  );
  const rec2b = d2b.characters.find((c) => c.id === l2.id);
  // the action ran on the copy's own state: its change starts from the source's values
  const delta = last?.effect?.state_delta ?? [];
  check(
    "L2.resources-from-copy",
    rec2b?.rev === 2 &&
      delta.length > 0 &&
      delta.every((c) => jcs(c.before ?? null) === jcs(pathOf(srcRecord.state, c.path) ?? null)),
    { rev: rec2b?.rev, delta },
  );
  const inst2 = await i2b.page.evaluate(
    () =>
      new Promise((ok) => {
        const r = indexedDB.open("srd-table");
        r.onsuccess = () => {
          const q = r.result.transaction("settings").objectStore("settings").get("installation");
          q.onsuccess = () => {
            r.result.close();
            ok(q.result);
          };
        };
      }),
  );

  // L3: generations I2 → I3 → I1
  await openApp(i2b.page, url);
  const f2 = join(work, "copy2.local-copy.json");
  await exportCopy(i2b.page, seed.source.build.name, f2);
  const copy2 = JSON.parse(readFileSync(f2, "utf8"));
  check(
    "L3.copy2-596",
    copy2.payload.history.entry_count === 596 && copy2.payload.source.installation_id === inst2,
  );
  check(
    "L3.copy2-external-inherited",
    copy2.payload.external.encounters.some(
      (e) => e.encounter_id === `ext:${inst1}:e-src77` && e.name === "Cragmaw ambush",
    ) && copy2.payload.external.participants.some((p) => p.record_id === `ext:${inst1}:c-wizard`),
    copy2.payload.external,
  );
  const i3 = await profile("I3");
  await openApp(i3.page, url);
  await putRows(i3.page, [
    character("c-wizard", other, seed.content, "I3 wizard"),
    encounterRow("e-src77", "I3 local"),
  ]);
  await openApp(i3.page, url);
  const l3 = await loadCopy(i3.page, f2);
  check("L3.created-in-I3", typeof l3.id === "string", l3);
  await openApp(i3.page, url, `characters/${l3.id}/sheet`);
  const hp3 = i3.page.getByRole("region", { name: "Hit Points" });
  await hp3.waitFor({ timeout: 60_000 });
  await hp3.getByPlaceholder("Amount").fill("1");
  await hp3.getByRole("button", { name: "Damage" }).click();
  await until(
    async () => (await dumpDb(i3.page)).history_meta.find((m) => m.record_id === l3.id)?.rev === 2,
  );
  await openApp(i3.page, url);
  const f3 = join(work, "copy3.local-copy.json");
  await exportCopy(i3.page, seed.source.build.name, f3);
  const copy3 = JSON.parse(readFileSync(f3, "utf8"));
  check(
    "L3.copy3-597",
    copy3.payload.history.entry_count === 597,
    copy3.payload.history.entry_count,
  );
  // back to I1
  await openApp(i1.page, url);
  const l1 = await loadCopy(i1.page, f3);
  check("L3.back-in-I1", typeof l1.id === "string" && l1.id !== SRC, l1);
  const d1back = await dumpDb(i1.page);
  const rows1 = rowsOf(d1back, l1.id);
  const refs = rows1.flatMap((e) => [
    ...e.participants.map((p) => p.record_id),
    e.context.encounter_id,
    e.links.follows,
    e.links.continues,
  ]);
  check("L3.no-nested-ext", !refs.some((x) => typeof x === "string" && /^ext:[^:]+:ext:/.test(x)));
  check(
    "L3.not-rebound-in-I1",
    !refs.includes("c-wizard") && !refs.includes("e-src77") && !refs.includes(SRC),
  );
  check(
    "L3.ext-from-I1-kept",
    refs.includes(`ext:${inst1}:c-wizard`) && refs.includes(`ext:${inst1}:e-src77`),
  );
  const rec1 = d1back.characters.find((c) => c.id === l1.id);
  check(
    "L3.names-kept",
    rec1?.origin?.extensions?.local_copy?.external?.encounters?.some(
      (e) => e.encounter_id === `ext:${inst1}:e-src77` && e.name === "Cragmaw ambush",
    ),
  );
  check("L3.full-journal", rows1.length === 597 && rests(rows1.slice(0, 595)) === rests(srcRows));
  check(
    "L3.I1-source-untouched",
    jcs(d1back.characters.find((c) => c.id === SRC)) === jcs(srcRecord) &&
      jcs(rowsOf(d1back, SRC)) === jcs(srcRows),
  );

  // L4: the same file again in I2
  await openApp(i2b.page, url);
  const dup = await loadCopy(i2b.page, f1);
  check("L4.already-needs-consent", dup.already === true && dup.disabledBefore === true, dup);
  await i2b.page.getByRole("button", { name: "Cancel" }).click();
  const d2c = await dumpDb(i2b.page);
  check("L4.cancel-writes-nothing", jcs(d2c) === jcs(d2b));
  await openApp(i2b.page, url);
  const dup2 = await loadCopy(i2b.page, f1, { another: true });
  check("L4.separate-copy", typeof dup2.id === "string" && dup2.id !== l2.id, dup2);
  const d2d = await dumpDb(i2b.page);
  check("L4.no-merge", rowsOf(d2d, dup2.id).length === 595 && rowsOf(d2d, l2.id).length === 596);

  // L5: Undo → reload; Undo → Redo
  const i4 = await profile("I4");
  await openApp(i4.page, url);
  const empty4 = await dumpDb(i4.page);
  const u1 = await loadCopy(i4.page, f1);
  await openApp(i4.page, url);
  // a reload ends the window: the bar is gone after openApp (navigation) — use client-side navigation instead
  check(
    "L5.undo-bar-gone-after-reload",
    (await i4.page.getByTestId("local-copy-last").count()) === 0,
  );
  const again = await loadCopy(i4.page, f1, { another: true });
  await toList(i4.page);
  await i4.page
    .getByTestId("local-copy-last")
    .getByRole("button", { name: "Undo the import" })
    .click();
  await i4.page
    .getByTestId("local-copy-last")
    .getByRole("button", { name: "Redo the import" })
    .waitFor();
  const d4u = await dumpDb(i4.page);
  check(
    "L5.undo-removes",
    !d4u.characters.some((c) => c.id === again.id) &&
      rowsOf(d4u, again.id).length === 0 &&
      !d4u.history_meta.some((m) => m.record_id === again.id),
    { chars: d4u.characters.length },
  );
  check(
    "L5.undo-keeps-packs",
    d4u.packs.some((p) => p.ref.id === "test-actions"),
  );
  await openApp(i4.page, url);
  const d4r = await dumpDb(i4.page);
  check(
    "L5.undo-reload",
    !d4r.characters.some((c) => c.id === again.id) &&
      (await i4.page.getByTestId("local-copy-last").count()) === 0,
  );
  const again2 = await loadCopy(i4.page, f1, { another: true });
  await toList(i4.page);
  const before = rowsOf(await dumpDb(i4.page), again2.id);
  await i4.page
    .getByTestId("local-copy-last")
    .getByRole("button", { name: "Undo the import" })
    .click();
  await i4.page
    .getByTestId("local-copy-last")
    .getByRole("button", { name: "Redo the import" })
    .waitFor();
  await i4.page
    .getByTestId("local-copy-last")
    .getByRole("button", { name: "Redo the import" })
    .click();
  await i4.page
    .getByTestId("local-copy-last")
    .getByRole("button", { name: "Undo the import" })
    .waitFor();
  const d4redo = await dumpDb(i4.page);
  check(
    "L5.redo-same-rows",
    jcs(rowsOf(d4redo, again2.id)) === jcs(before) && before.length === 595,
  );
  await openApp(i4.page, url);
  const d4rr = await dumpDb(i4.page);
  check(
    "L5.redo-reload",
    jcs(rowsOf(d4rr, again2.id)) === jcs(before) &&
      d4rr.history_meta.find((m) => m.record_id === again2.id)?.rev === 1,
  );
  void u1;
  void empty4;

  // L6: F-008 transfer unchanged
  await openApp(i1.page, url);
  const [dl] = await Promise.all([
    i1.page.waitForEvent("download"),
    cardButton(
      i1.page,
      seed.source.build.name,
      "Export for another device (with its content's identity)",
    ),
  ]);
  const ft = join(work, "transfer.json");
  await dl.saveAs(ft);
  const env = JSON.parse(readFileSync(ft, "utf8"));
  check(
    "L6.transfer-without-history",
    env.format === "srd-table.transfer/1" &&
      jcs(Object.keys(env.content).sort()) === jcs(["build", "context", "state", "state_origin"]),
  );
  check(
    "L6.history-stays-notice",
    await i1.page
      .getByText("History stays on this device: it isn't exported or imported.")
      .first()
      .isVisible()
      .catch(() => false),
  );
  await openApp(i4.page, url);
  const before6 = await dumpDb(i4.page);
  await i4.page.getByRole("button", { name: "Import…" }).click();
  await i4.page.getByLabel("Choose files").setInputFiles(ft);
  await i4.page.getByRole("button", { name: "Import", exact: true }).click();
  await i4.page.waitForTimeout(1500);
  const after6 = await dumpDb(i4.page);
  const added = after6.characters.filter((c) => !before6.characters.some((b) => b.id === c.id));
  check(
    "L6.f008-import",
    added.length === 1 &&
      added[0].origin?.kind === "import" &&
      rowsOf(after6, added[0].id).length === 0,
    added.map((c) => c.id),
  );

  // a local copy offered to F-008's Import… is pointed to its own import
  await openApp(i4.page, url);
  await i4.page.getByRole("button", { name: "Import…" }).click();
  await i4.page.getByLabel("Choose files").setInputFiles(f1);
  await i4.page
    .getByText(/A local copy with history: open it with/)
    .first()
    .waitFor({ timeout: 30_000 });
  check("L6.f008-points-to-local-copy", true);

  for (const n of [...profiles.keys()]) await closeProfile(n);
  srv.close();

  if (args.dev) await devScenario(f1);
}

/** L7 on a Vite dev server: the publication fails after the transaction. */
async function devScenario(f1) {
  const port = 5600 + Math.floor(Math.random() * 300);
  const vite = spawn(
    join(root, "node_modules/.bin/vite"),
    ["--port", String(port), "--strictPort", "--host", "127.0.0.1"],
    {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let ready = false;
  vite.stdout.on("data", (d) => {
    if (String(d).includes("Local")) ready = true;
  });
  for (let i = 0; i < 120 && !ready; i++) await new Promise((r) => setTimeout(r, 500));
  const url = `http://127.0.0.1:${port}/`;
  note("dev server", url);
  try {
    const f = await profile("F1");
    await openApp(f.page, url);
    check(
      "L7.seam-in-dev-build",
      await f.page.evaluate(() => typeof globalThis.__srdTableLocalCopyFaults === "object"),
    );
    await putRows(f.page, [testPackRow()]);
    await openApp(f.page, url);
    await f.page.evaluate(() => {
      globalThis.__srdTableLocalCopyFaults.publish = () => {
        throw new Error("injected publication failure");
      };
    });
    const r = await loadCopy(f.page, f1);
    check(
      "L7.saved-unpublished-said",
      typeof r.unpublished === "string" &&
        /saved but not shown/.test(r.unpublished) &&
        /lc-/.test(r.unpublished),
      r,
    );
    const d = await dumpDb(f.page);
    const saved = d.characters.filter((c) => c.origin?.extensions?.local_copy);
    check(
      "L7.copy-whole-in-db",
      saved.length === 1 && rowsOf(d, saved[0].id).length === 595,
      saved.length,
    );
    // the autosave runs (another change) and leaves it alone
    await f.page.evaluate(() => {
      globalThis.__srdTableLocalCopyFaults.publish = null;
    });
    await f.page.waitForTimeout(800);
    const d2 = await dumpDb(f.page);
    check(
      "L7.autosave-leaves-it",
      rowsOf(d2, saved[0].id).length === 595 &&
        d2.history_meta.find((m) => m.record_id === saved[0].id)?.rev === 1 &&
        d2.characters.some((c) => c.id === saved[0].id),
    );
    await f.page.getByRole("button", { name: "Try to show it again" }).click();
    await f.page.waitForURL(/\/characters\/c-[^/]+\/sheet/, { timeout: 60_000 });
    const shownId = /\/characters\/(c-[^/]+)\/sheet/.exec(f.page.url())?.[1];
    const d3 = await dumpDb(f.page);
    check(
      "L7.retry-same-copy",
      shownId === saved[0].id &&
        d3.characters.filter((c) => c.origin?.extensions?.local_copy).length === 1,
      { shownId, saved: saved[0].id },
    );
    // another failure, then Reload shows it
    await openApp(f.page, url);
    await f.page.evaluate(() => {
      globalThis.__srdTableLocalCopyFaults.publish = () => {
        throw new Error("injected");
      };
    });
    const r2 = await loadCopy(f.page, f1, { another: true });
    check("L7.second-unpublished", typeof r2.unpublished === "string", r2);
    await Promise.all([
      f.page.waitForEvent("load"),
      f.page.getByRole("button", { name: "Reload" }).click(),
    ]);
    await openApp(f.page, url);
    const d4 = await dumpDb(f.page);
    const copies = d4.characters.filter((c) => c.origin?.extensions?.local_copy);
    const listed = await f.page.locator("article h2").allInnerTexts();
    check(
      "L7.reload-shows",
      copies.length === 2 && listed.filter((n) => n === "Pip").length === 2,
      { copies: copies.length, listed },
    );
    await closeProfile("F1");
  } finally {
    vite.kill();
  }
}

try {
  await main();
} catch (error) {
  check("probe-completed", false, String(error?.stack ?? error));
  for (const [n, ctx] of profiles) {
    const pg = ctx.pages()[0];
    if (pg) await pg.screenshot({ path: join(work, `fail-${n}.png`) }).catch(() => undefined);
  }
} finally {
  for (const n of [...profiles.keys()]) await closeProfile(n).catch(() => undefined);
}
check("no-page-errors", pageErrors.length === 0, pageErrors.slice(0, 10));
results.summary = { checks: results.checks.length, failed: failures };
console.log(`\n${results.checks.length - failures}/${results.checks.length} checks passed`);
if (args.out) writeFileSync(resolve(args.out), `${JSON.stringify(results, null, 2)}\n`);
if (!args.keep) rmSync(work, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
