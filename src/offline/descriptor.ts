/**
 * kenli F-007 T02: the release descriptor `srd-table.release/1` (dnd5
 * docs/features/F-007-offline-packs/contracts/offline.md §2). Shared by the release build
 * (scripts/release.ts), the service worker's precache list and the page API (release.ts). Pure:
 * hashing is passed in, so the same code runs in Node, Bun and the browser.
 */

import { canonicalJson } from "../lib/canonical";

export const RELEASE_FORMAT = "srd-table.release/1";
export const RELEASE_INPUTS_FORMAT = "srd-table.release-inputs/1";
/** The release protocol (messages between pages and the release SW). */
export const RELEASE_PROTOCOL = 1;

export interface FileRef {
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
}
export type AssetRole = "entry" | "chunk" | "worker" | "css" | "font" | "icon" | "static";
export interface Asset extends FileRef {
  readonly role: AssetRole;
}

export interface ReleaseInputs {
  readonly format: typeof RELEASE_INPUTS_FORMAT;
  readonly base: string;
  readonly table_commit: string;
  readonly engine_commit: string;
  readonly protocol: number;
  readonly data: {
    readonly db_version: number;
    readonly history_schema: string;
    readonly history_meta_schema: string;
    readonly transfer_formats: readonly string[];
    readonly local_copy_formats: readonly string[];
  };
  readonly toolchain: { readonly bun: string; readonly vite: string };
  /** A named variant of the same inputs (probes); absent in a normal release. */
  readonly variant?: string;
  /** Built from a tree with uncommitted changes: never published (the publisher refuses it). */
  readonly dirty?: true;
}

export interface ReleaseDescriptor {
  readonly format: typeof RELEASE_FORMAT;
  readonly release_id: string;
  readonly base: string;
  readonly inputs: ReleaseInputs;
  readonly sw: FileRef;
  readonly html: FileRef;
  readonly webmanifest: FileRef & {
    readonly id: string;
    readonly start_url: string;
    readonly scope: string;
  };
  readonly assets: readonly Asset[];
  readonly graph: {
    readonly roots: readonly string[];
    readonly edges: readonly (readonly [string, string])[];
  };
  readonly total_bytes: number;
}

/** What the release SW precaches: its HTML, its web manifest and every asset (never the SW itself). */
export interface SwRelease {
  readonly release_id: string;
  readonly base: string;
  readonly html: string;
  /** The HTML and what it loads directly (entry, CSS, preloads, icons): checked before every app navigation. */
  readonly critical: readonly string[];
  readonly files: readonly FileRef[];
}

/**
 * The one content type each release file is stored and served with (offline.md §2.5, R03-03):
 * the bytes are the release's own (SHA-256 checked), so their type comes from the release, not
 * from whatever header the host sent. A file of any other kind can't be in a release.
 */
export const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".js": "text/javascript",
  ".css": "text/css",
  ".html": "text/html; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};
export function contentTypeOf(path: string): string | null {
  const dot = path.lastIndexOf(".");
  return dot < 0 ? null : (CONTENT_TYPES[path.slice(dot)] ?? null);
}

export const RELEASE_ID = /^r-[0-9a-f]{16}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const SEG = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** Paths that are never part of an app release (other publishers, mutable pointers). */
export const EXCLUDED_PREFIXES = ["content/", "library/", "f005/", "releases/"] as const;
export const MUTABLE_PATHS = [
  "index.html",
  "release.json",
  ".srd-table-deploy.json",
  "releases/index.json",
] as const;

/** The release id: derived from inputs known before the build, so no file hashes itself. */
export function releaseIdOf(inputs: ReleaseInputs, sha256: (text: string) => string): string {
  return `r-${sha256(canonicalJson(inputs)).slice(0, 16)}`;
}

/** A path relative to the base: no traversal, absolute, backslash, percent, query, hidden segment. */
export function safePath(p: unknown): p is string {
  if (typeof p !== "string" || p.length === 0 || p.length > 200) return false;
  if (p.startsWith("/") || /[\\%?#]/.test(p)) return false;
  return p.split("/").every((s) => SEG.test(s) && s !== "." && s !== "..");
}

export function isBase(base: unknown): base is string {
  return (
    typeof base === "string" && /^\/([A-Za-z0-9._-]+\/)*$/.test(base) && !base.includes("/../")
  );
}

export const swPathOf = (releaseId: string) => `sw-${releaseId}.js`;
export const htmlPathOf = (releaseId: string) => `releases/${releaseId}/index.html`;
export const manifestPathOf = (releaseId: string) => `releases/${releaseId}/manifest.webmanifest`;
export const descriptorPathOf = (releaseId: string) => `releases/${releaseId}/release.json`;

/** Every file of a release the publisher writes (immutable): SW, HTML, web manifest, assets. */
export function releaseFiles(d: ReleaseDescriptor): FileRef[] {
  return [d.sw, d.html, d.webmanifest, ...d.assets].map(({ path, sha256, size }) => ({
    path,
    sha256,
    size,
  }));
}

/** The SW's precache list for a descriptor. */
export function swReleaseOf(d: ReleaseDescriptor): SwRelease {
  const direct = d.graph.edges.filter(([from]) => from === d.html.path).map(([, to]) => to);
  return {
    release_id: d.release_id,
    base: d.base,
    html: d.html.path,
    critical: [d.html.path, ...[...new Set(direct)].sort()],
    files: [d.html, d.webmanifest, ...d.assets].map(({ path, sha256, size }) => ({
      path,
      sha256,
      size,
    })),
  };
}

/** Contract checks of a descriptor (offline.md §2.2–2.4); `[]` when valid. */
export function descriptorProblems(
  d: ReleaseDescriptor,
  sha256: (text: string) => string,
): string[] {
  const errs: string[] = [];
  const bad = (code: string, detail: string) => errs.push(`${code}: ${detail}`);
  if (d.format !== RELEASE_FORMAT) bad("release_format", String(d.format));
  if (!isBase(d.base) || d.inputs?.base !== d.base) bad("release_base", String(d.base));
  if (d.inputs?.format !== RELEASE_INPUTS_FORMAT) bad("release_inputs", "format");
  if (!RELEASE_ID.test(d.release_id) || releaseIdOf(d.inputs, sha256) !== d.release_id)
    bad("release_id_mismatch", String(d.release_id));
  if (
    !/^[0-9a-f]{40}$/.test(d.inputs.table_commit) ||
    !/^[0-9a-f]{40}$/.test(d.inputs.engine_commit)
  )
    bad("release_inputs", "commits");
  if (d.sw.path !== swPathOf(d.release_id)) bad("release_sw_path", d.sw.path);
  if (d.html.path !== htmlPathOf(d.release_id)) bad("release_html_path", d.html.path);
  if (d.webmanifest.path !== manifestPathOf(d.release_id))
    bad("release_manifest_path", d.webmanifest.path);
  if (
    d.webmanifest.id !== d.base ||
    d.webmanifest.start_url !== d.base ||
    d.webmanifest.scope !== d.base
  )
    bad("release_manifest_identity", "id/start_url/scope must be the base");
  const seen = new Set<string>();
  for (const f of [d.sw, d.html, d.webmanifest, ...d.assets]) {
    if (!safePath(f.path)) bad("path_unsafe", String(f.path));
    if (!HEX64.test(f.sha256) || !Number.isSafeInteger(f.size) || f.size <= 0)
      bad("release_file", f.path);
    if (seen.has(f.path)) bad("path_duplicate", f.path);
    if (f !== d.sw && !contentTypeOf(f.path)) bad("release_asset_type", f.path);
    seen.add(f.path);
  }
  const paths = d.assets.map((a) => a.path);
  if (canonicalJson(paths) !== canonicalJson([...paths].sort()))
    bad("release_assets_order", "sorted by path");
  for (const a of d.assets) {
    if (
      EXCLUDED_PREFIXES.some((x) => a.path.startsWith(x)) ||
      (MUTABLE_PATHS as readonly string[]).includes(a.path) ||
      a.path.startsWith("sw-") ||
      !a.path.startsWith("assets/")
    )
      bad("release_excluded_path", a.path);
  }
  if (d.assets.filter((a) => a.role === "entry").length !== 1)
    bad("release_entry", "exactly one entry");
  if (!d.assets.some((a) => a.role === "worker")) bad("release_worker", "engine worker missing");
  const nodes = new Set([d.html.path, d.webmanifest.path, ...paths]);
  if (canonicalJson(d.graph.roots) !== canonicalJson([d.html.path, d.webmanifest.path]))
    bad("release_graph_roots", "html + webmanifest");
  for (const [a, b] of d.graph.edges) {
    if (!nodes.has(a)) bad("release_graph_source", a);
    if (!nodes.has(b)) bad("release_graph_missing", `${a} → ${b}`);
  }
  const reach = new Set(d.graph.roots);
  for (let changed = true; changed; ) {
    changed = false;
    for (const [a, b] of d.graph.edges)
      if (reach.has(a) && !reach.has(b)) {
        reach.add(b);
        changed = true;
      }
  }
  for (const n of nodes) if (!reach.has(n)) bad("release_graph_orphan", n);
  const total = [d.html, d.webmanifest, ...d.assets].reduce((s, f) => s + f.size, 0);
  if (d.total_bytes !== total) bad("release_total", `${d.total_bytes} ≠ ${total}`);
  return errs;
}
