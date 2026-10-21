/**
 * kenli F-007 T02: build one immutable app release (dnd5 contracts/offline.md §2).
 *
 *   bun scripts/release.ts --base /dnd/ --out /tmp/rel [--variant name] [--allow-dirty] [--report r.json]
 *
 * 1. Inputs known before the build (Table/engine commits, base, protocol, data formats, Bun/Vite
 *    versions) → release id `r-<16 hex>`; a dirty tree is refused (or marked `dirty`, never publishable).
 * 2. `vite build` with that id (`__RELEASE_ID__`), base and the Vite manifest.
 * 3. App files only: `content/` (the SRD/private packs Vite copies from public/) is removed; the
 *    public favicon/icons get hashed names under assets/; the web manifest and the HTML snapshot go
 *    to releases/<id>/ (the root index.html is the same bytes).
 * 4. The closed graph of every emitted file (scripts/release/graph.ts), the self-contained SW
 *    `sw-<id>.js` (src/offline/sw.ts bundled by Bun, its precache list prepended) and the
 *    descriptor releases/<id>/release.json. Any problem fails the build; nothing is published here.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  descriptorPathOf,
  descriptorProblems,
  htmlPathOf,
  isBase,
  manifestPathOf,
  RELEASE_FORMAT,
  RELEASE_INPUTS_FORMAT,
  RELEASE_PROTOCOL,
  type ReleaseDescriptor,
  type ReleaseInputs,
  releaseIdOf,
  swPathOf,
  swReleaseOf,
} from "../src/offline/descriptor";
import { buildGraph, sortedAssets, type ViteChunk } from "./release/graph";

// Run with Bun (its bundler builds the SW); the app's tsconfig has no Bun types.
declare const Bun: {
  build(o: {
    entrypoints: string[];
    target: "browser";
    format: "iife";
    minify: boolean;
  }): Promise<{ success: boolean; logs: unknown[]; outputs: Blob[] }>;
};

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sha256 = (b: string | Uint8Array) => createHash("sha256").update(b).digest("hex");
const fail = (msg: string): never => {
  console.error(`release: ${msg}`);
  process.exit(1);
};

const { values: args } = parseArgs({
  options: {
    base: { type: "string", default: "/dnd/" },
    out: { type: "string" },
    variant: { type: "string" },
    "allow-dirty": { type: "boolean", default: false },
    report: { type: "string" },
  },
});
const base = args.base as string;
if (!isBase(base)) fail(`invalid base ${base} (want /segment/)`);
if (!args.out) fail("--out is required");
const out = resolve(args.out as string);
if (existsSync(out)) fail(`${out} exists (a release is built into a new directory)`);

// ── 1. inputs and id ──
const git = (dir: string, ...a: string[]) =>
  execFileSync("git", ["-C", dir, ...a], { encoding: "utf8" }).trim();
const tableCommit = git(root, "rev-parse", "HEAD");
const dirty = git(root, "status", "--porcelain", "--untracked-files=all") !== "";
if (dirty && !args["allow-dirty"])
  fail(
    "Table has uncommitted changes: commit first (or --allow-dirty for a never-publishable build)",
  );
const pin =
  /ENGINE_COMMIT = "([0-9a-f]{40})"/.exec(
    readFileSync(join(root, "scripts/engine-pin.ts"), "utf8"),
  )?.[1] ?? fail("ENGINE_COMMIT not found");
const engineDir = join(root, "..", "srd-rules-engine-main");
const engineHead = git(engineDir, "rev-parse", "HEAD");
if (engineHead !== pin)
  fail(`engine worktree ${engineHead} ≠ pinned ${pin} (npm run engine:update)`);
if (git(engineDir, "status", "--porcelain") !== "") fail("engine worktree is not clean");
const viteVersion = JSON.parse(readFileSync(join(root, "node_modules/vite/package.json"), "utf8"))
  .version as string;
const bunVersion =
  (process.versions as Record<string, string | undefined>).bun ?? fail("run with bun");
const inputs: ReleaseInputs = {
  format: RELEASE_INPUTS_FORMAT,
  base,
  table_commit: tableCommit,
  engine_commit: pin,
  protocol: RELEASE_PROTOCOL,
  data: {
    db_version: 4,
    history_schema: "kenli.history/1",
    history_meta_schema: "kenli.history-meta/1",
    transfer_formats: ["srd-table.transfer/1"],
    local_copy_formats: ["srd-table.local-copy/1"],
  },
  toolchain: { bun: bunVersion, vite: viteVersion },
  ...(args.variant ? { variant: args.variant as string } : {}),
  ...(dirty ? { dirty: true as const } : {}),
};
const releaseId = releaseIdOf(inputs, sha256);

// ── 2. vite build ──
const vite = spawnSync(
  "bun",
  [
    "--bun",
    join(root, "node_modules/.bin/vite"),
    "build",
    `--base=${base}`,
    `--outDir=${out}`,
    "--manifest",
    "--emptyOutDir",
  ],
  {
    cwd: root,
    env: { ...process.env, F007_RELEASE_ID: releaseId },
    encoding: "utf8",
  },
);
if (vite.status !== 0) fail(`vite build failed:\n${vite.stdout}\n${vite.stderr}`);

// ── 3. app files only, hashed public files, release HTML and web manifest ──
rmSync(join(out, "content"), { recursive: true, force: true });
const viteManifest = JSON.parse(readFileSync(join(out, ".vite/manifest.json"), "utf8")) as Record<
  string,
  ViteChunk
>;
rmSync(join(out, ".vite"), { recursive: true });
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) =>
    statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)],
  );
let html = readFileSync(join(out, "index.html"), "utf8");
const template = JSON.parse(readFileSync(join(out, "manifest.webmanifest"), "utf8")) as {
  icons: { src: string }[];
} & Record<string, unknown>;
rmSync(join(out, "manifest.webmanifest"));
/** public/ app files (favicon, icons) → assets/<stem>-<hash8>.<ext>: immutable names like Vite's. */
const renamed = new Map<string, string>();
for (const abs of walk(out)) {
  const rel = relative(out, abs);
  if (rel === "index.html" || rel.startsWith("assets/")) continue;
  if (!/^(favicon\.svg|icons\/[a-z0-9-]+\.png)$/.test(rel))
    fail(`unexpected public file in the build: ${rel}`);
  const bytes = readFileSync(abs);
  const name = rel.split("/").pop() as string;
  const dot = name.lastIndexOf(".");
  const to = `assets/${name.slice(0, dot)}-${sha256(bytes).slice(0, 8)}${name.slice(dot)}`;
  renameSync(abs, join(out, to));
  renamed.set(`${base}${rel}`, `${base}${to}`);
}
rmSync(join(out, "icons"), { recursive: true, force: true });
for (const [from, to] of renamed) html = html.split(`"${from}"`).join(`"${to}"`);
html = html.split(`"${base}manifest.webmanifest"`).join(`"${base}${manifestPathOf(releaseId)}"`);
const unresolved = [...html.matchAll(/(?:href|src)="([^"]+)"/g)]
  .map((m) => m[1] as string)
  .filter((u) => !u.startsWith(`${base}assets/`) && !u.startsWith(`${base}releases/${releaseId}/`));
if (unresolved.length) fail(`HTML references outside the release: ${unresolved.join(", ")}`);
const webmanifest = {
  ...template,
  id: base,
  start_url: base,
  scope: base,
  icons: template.icons.map((i) => ({
    ...i,
    src:
      renamed.get(`${base}${i.src.replace(/^\//, "")}`) ?? fail(`manifest icon ${i.src} not built`),
  })),
};
const manifestText = `${JSON.stringify(webmanifest, null, 2)}\n`;
mkdirSync(join(out, `releases/${releaseId}`), { recursive: true });
writeFileSync(join(out, htmlPathOf(releaseId)), html);
writeFileSync(join(out, "index.html"), html);
writeFileSync(join(out, manifestPathOf(releaseId)), manifestText);

// ── 4. graph, SW, descriptor ──
const assets = new Map<string, Uint8Array>();
for (const abs of walk(join(out, "assets"))) assets.set(relative(out, abs), readFileSync(abs));
const graph = buildGraph({
  assets,
  html: { path: htmlPathOf(releaseId), text: html },
  webmanifest: { path: manifestPathOf(releaseId), text: manifestText },
  viteManifest,
  base,
});
if (graph.problems.length) fail(`graph:\n  ${graph.problems.join("\n  ")}`);
const assetList = sortedAssets(assets, graph.roles, sha256);
const htmlRef = {
  path: htmlPathOf(releaseId),
  sha256: sha256(html),
  size: Buffer.byteLength(html),
};
const manifestRef = {
  path: manifestPathOf(releaseId),
  sha256: sha256(manifestText),
  size: Buffer.byteLength(manifestText),
  id: base,
  start_url: base,
  scope: base,
};
const partial = {
  release_id: releaseId,
  base,
  html: htmlRef,
  webmanifest: manifestRef,
  assets: assetList,
};
const swBuild = await Bun.build({
  entrypoints: [join(root, "src/offline/sw.ts")],
  target: "browser",
  format: "iife",
  minify: false,
});
if (!swBuild.success) fail(`SW build failed: ${swBuild.logs.join("\n")}`);
const swRelease = swReleaseOf({ ...partial, sw: htmlRef } as unknown as ReleaseDescriptor);
const swText = `// srd-table release ${releaseId} (immutable; offline.md §2.7)\nself.__F007_RELEASE__ = ${JSON.stringify(swRelease)};\n${await (swBuild.outputs[0] as Blob).text()}`;
writeFileSync(join(out, swPathOf(releaseId)), swText);
const descriptor: ReleaseDescriptor = {
  format: RELEASE_FORMAT,
  release_id: releaseId,
  base,
  inputs,
  sw: { path: swPathOf(releaseId), sha256: sha256(swText), size: Buffer.byteLength(swText) },
  html: htmlRef,
  webmanifest: manifestRef,
  assets: assetList,
  graph: { roots: graph.roots, edges: graph.edges },
  total_bytes: htmlRef.size + manifestRef.size + assetList.reduce((s, a) => s + a.size, 0),
};
const problems = descriptorProblems(descriptor, sha256);
if (problems.length) fail(`descriptor:\n  ${problems.join("\n  ")}`);
writeFileSync(join(out, descriptorPathOf(releaseId)), `${JSON.stringify(descriptor, null, 2)}\n`);

// the release directory holds exactly the release (and the root index.html copy)
const expected = new Set([
  "index.html",
  descriptorPathOf(releaseId),
  swPathOf(releaseId),
  htmlRef.path,
  manifestRef.path,
  ...assetList.map((a) => a.path),
]);
const extra = walk(out)
  .map((a) => relative(out, a))
  .filter((p) => !expected.has(p));
if (extra.length) fail(`unexpected files in the release: ${extra.join(", ")}`);

const report = {
  release_id: releaseId,
  base,
  inputs,
  files: expected.size,
  total_bytes: descriptor.total_bytes,
  sw: descriptor.sw,
  worker: assetList.filter((a) => a.role === "worker"),
  roles: Object.fromEntries(
    ["entry", "chunk", "worker", "css", "font", "icon", "static"].map((r) => [
      r,
      assetList.filter((a) => a.role === r).length,
    ]),
  ),
  edges: graph.edges.length,
  descriptor_sha256: sha256(readFileSync(join(out, descriptorPathOf(releaseId)))),
};
if (args.report)
  writeFileSync(resolve(args.report as string), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report));
