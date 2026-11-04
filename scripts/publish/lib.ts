/**
 * kenli F-014 T02: the publisher's own view of a Table release and of the public site
 * (docs/deployment.md §4–5). Ported from dnd5 `tools/migration/app/lib.ts` (provenance:
 * scripts/publish/PROVENANCE.md) and kept independent of the Table code that built the release:
 * its own canonical JSON, release id, safe paths and descriptor checks. Additions: the
 * `inputs.app_version` check (T01), the SRD pack area and the closed allowlist of the site.
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

export class PublishError extends Error {
  constructor(
    readonly code: string,
    readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = "PublishError";
  }
}
export const fail = (code: string, detail: string): never => {
  throw new PublishError(code, detail);
};

export const sha256 = (b: string | Uint8Array) => createHash("sha256").update(b).digest("hex");

/** Canonical JSON as Table `src/lib/canonical.ts` (keys by UTF-16 code units, no spaces, -0 → 0). */
export function jcs(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (v === null || typeof v === "string" || typeof v === "boolean") return v;
    if (typeof v === "number") {
      if (!Number.isFinite(v)) throw new Error("canonical JSON: non-finite number");
      return Object.is(v, -0) ? 0 : v;
    }
    if (Array.isArray(v)) return v.map(sort);
    if (typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as object).sort()) {
        const x = (v as Record<string, unknown>)[k];
        if (x !== undefined)
          Object.defineProperty(out, k, {
            value: sort(x),
            enumerable: true,
            writable: true,
            configurable: true,
          });
      }
      return out;
    }
    throw new Error(`canonical JSON: unsupported ${typeof v}`);
  };
  return JSON.stringify(sort(value));
}
/** The publisher's JSON files: two-space indent and a final newline (stable bytes). */
export const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;

export interface FileRef {
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
}
export interface Descriptor {
  readonly format: "srd-table.release/1";
  readonly release_id: string;
  readonly base: string;
  readonly inputs: Record<string, unknown> & {
    base: string;
    table_commit: string;
    engine_commit: string;
    app_version?: string;
    dirty?: true;
    variant?: string;
  };
  readonly sw: FileRef;
  readonly html: FileRef;
  readonly webmanifest: FileRef & { id: string; start_url: string; scope: string };
  readonly assets: readonly (FileRef & { role: string })[];
  readonly graph: {
    readonly roots: readonly string[];
    readonly edges: readonly (readonly [string, string])[];
  };
  readonly total_bytes: number;
}
export interface PublishManifest {
  readonly format: "srd-table.publish-manifest/1";
  readonly base: string;
  readonly releases: readonly ManifestRelease[];
  /** The bridge release the legacy `release.json` stays on for good (dnd5 F-002 T07, C6). */
  readonly bridge?: string;
}
export interface ManifestRelease {
  readonly release_id: string;
  readonly kind: "release";
  readonly record: string;
  readonly record_sha256: string;
  readonly files: readonly FileRef[];
}
export interface Pointer {
  readonly format: "srd-table.release-pointer/1";
  readonly base: string;
  readonly release_id: string;
  readonly descriptor: string;
  readonly descriptor_sha256: string;
}

export const RELEASE_ID = /^r-[0-9a-f]{16}$/;
const SEG = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const EXCLUDED_PREFIXES = ["content/", "library/", "f005/", "releases/"];
export const LEGACY_POINTER = "release.json";
export const CURRENT_POINTER = "release-current.json";
export const MANIFEST = "releases/index.json";
export const MARKER = ".srd-table-deploy.json";
export const MUTABLE = ["index.html", LEGACY_POINTER, CURRENT_POINTER, MARKER, MANIFEST];
/** The only content pack a public site carries (the engine's split SRD, CC-BY-4.0). */
export const SRD_PACKS = ["srd-5.2.1"] as const;
/** This publisher's temporary files (written then renamed in the same directory). */
export const TEMP_FILE = /^\.pages-publish-\d+-\d+\.tmp$/;

export function safePath(p: unknown): p is string {
  if (typeof p !== "string" || p.length === 0 || p.length > 200) return false;
  if (p.startsWith("/") || /[\\%?#]/.test(p)) return false;
  return p.split("/").every((s) => SEG.test(s) && s !== "." && s !== "..");
}
export const isBase = (b: unknown): b is string =>
  typeof b === "string" && /^\/([A-Za-z0-9._-]+\/)*$/.test(b);
export const releaseIdOf = (inputs: unknown) => `r-${sha256(jcs(inputs)).slice(0, 16)}`;

/** A supported app version (T01, src/offline/version.ts; the same subset, independently checked). */
const NUM = "(0|[1-9][0-9]*)";
const VERSION = new RegExp(`^${NUM}\\.${NUM}\\.${NUM}(?:-rc\\.([1-9][0-9]*))?$`);
export function parseVersion(v: unknown): [number, number, number, number] | null {
  if (typeof v !== "string" || v.length > 70) return null;
  const m = VERSION.exec(v);
  if (!m) return null;
  const n = [m[1], m[2], m[3]].map(Number);
  // a final version sorts after all of its release candidates
  const rc = m[4] === undefined ? Number.POSITIVE_INFINITY : Number(m[4]);
  if (![...n, rc].every((x) => Number.isSafeInteger(x) || x === Number.POSITIVE_INFINITY))
    return null;
  return [n[0] as number, n[1] as number, n[2] as number, rc];
}
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a) ?? fail("version_invalid", a);
  const y = parseVersion(b) ?? fail("version_invalid", b);
  for (let i = 0; i < 4; i++)
    if ((x[i] as number) !== (y[i] as number)) return (x[i] as number) < (y[i] as number) ? -1 : 1;
  return 0;
}
export const tagOf = (version: string) => `v${version}`;

/** All files under a directory (relative paths); symlinks and other non-files reported, never followed. */
export function walk(
  dir: string,
  skipTop: readonly string[] = [],
): { files: string[]; symlinks: string[]; dirs: string[]; hardlinks: string[] } {
  const files: string[] = [];
  const symlinks: string[] = [];
  const dirs: string[] = [];
  const hardlinks: string[] = [];
  if (!existsSync(dir)) return { files, symlinks, dirs, hardlinks };
  const go = (d: string) => {
    for (const n of readdirSync(d).sort()) {
      const abs = join(d, n);
      const rel = relative(dir, abs);
      if (d === dir && skipTop.includes(n)) continue;
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) symlinks.push(rel);
      else if (st.isDirectory()) {
        dirs.push(rel);
        go(abs);
      } else if (st.isFile()) {
        files.push(rel);
        if (st.nlink > 1) hardlinks.push(rel);
      } else symlinks.push(rel); // sockets, devices…: never part of a site
    }
  };
  go(dir);
  return { files, symlinks, dirs, hardlinks };
}

export const fileRefOf = (root: string, path: string): FileRef => {
  const b = readFileSync(join(root, path));
  return { path, sha256: sha256(b), size: b.byteLength };
};

/** The publisher's checks of a release descriptor (offline.md §2.2–2.4, T01 app_version); `[]` when valid. */
export function descriptorProblems(d: Descriptor): string[] {
  const errs: string[] = [];
  const bad = (code: string, detail: string) => errs.push(`${code}: ${detail}`);
  if (d.format !== "srd-table.release/1") bad("release_format", String(d.format));
  if (!isBase(d.base) || d.inputs?.base !== d.base) bad("release_base", String(d.base));
  if (!RELEASE_ID.test(d.release_id) || releaseIdOf(d.inputs) !== d.release_id)
    bad("release_id_mismatch", String(d.release_id));
  if (
    !/^[0-9a-f]{40}$/.test(String(d.inputs?.table_commit)) ||
    !/^[0-9a-f]{40}$/.test(String(d.inputs?.engine_commit))
  )
    bad("release_inputs", "commits");
  if (d.inputs && "app_version" in d.inputs && !parseVersion(d.inputs.app_version))
    bad("release_inputs", "app_version");
  if (d.sw.path !== `sw-${d.release_id}.js`) bad("release_sw_path", d.sw.path);
  if (d.html.path !== `releases/${d.release_id}/index.html`) bad("release_html_path", d.html.path);
  if (d.webmanifest.path !== `releases/${d.release_id}/manifest.webmanifest`)
    bad("release_manifest_path", d.webmanifest.path);
  if (
    d.webmanifest.id !== d.base ||
    d.webmanifest.start_url !== d.base ||
    d.webmanifest.scope !== d.base
  )
    bad("release_manifest_identity", "id/start_url/scope");
  const seen = new Set<string>();
  for (const f of [d.sw, d.html, d.webmanifest, ...d.assets]) {
    if (!safePath(f.path)) bad("path_unsafe", String(f.path));
    if (!/^[0-9a-f]{64}$/.test(f.sha256) || !Number.isSafeInteger(f.size) || f.size <= 0)
      bad("release_file", f.path);
    if (seen.has(f.path)) bad("path_duplicate", f.path);
    seen.add(f.path);
  }
  for (const a of d.assets)
    if (
      !a.path.startsWith("assets/") ||
      EXCLUDED_PREFIXES.some((x) => a.path.startsWith(x)) ||
      MUTABLE.includes(a.path)
    )
      bad("release_excluded_path", a.path);
  if (d.assets.filter((a) => a.role === "entry").length !== 1) bad("release_entry", "exactly one");
  if (!d.assets.some((a) => a.role === "worker")) bad("release_worker", "missing");
  const nodes = new Set([d.html.path, d.webmanifest.path, ...d.assets.map((a) => a.path)]);
  const reach = new Set(d.graph.roots);
  if (jcs(d.graph.roots) !== jcs([d.html.path, d.webmanifest.path]))
    bad("release_graph_roots", "html + webmanifest");
  for (const [a, b] of d.graph.edges)
    if (!nodes.has(a) || !nodes.has(b)) bad("release_graph_missing", `${a} → ${b}`);
  for (let changed = true; changed; ) {
    changed = false;
    for (const [a, b] of d.graph.edges)
      if (reach.has(a) && !reach.has(b)) {
        reach.add(b);
        changed = true;
      }
  }
  for (const n of nodes) if (!reach.has(n)) bad("release_graph_orphan", n);
  return errs;
}

export const releaseFiles = (d: Descriptor): FileRef[] =>
  [d.sw, d.html, d.webmanifest, ...d.assets].map(({ path, sha256: s, size }) => ({
    path,
    sha256: s,
    size,
  }));

/**
 * The closed allowlist of a public site (docs/deployment.md §5.1): the release layout, the mutable
 * pointers and marker, and the SRD pack. Anything else (another pack, `library/`, `f005/`, a
 * dotfile, a stray file) is refused.
 */
export function sitePathAllowed(p: string): boolean {
  if (!safePath(p.replace(/^\.srd-table-deploy\.json$/, "marker"))) return false;
  if (MUTABLE.includes(p)) return true;
  if (/^assets\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(p)) return true;
  if (/^sw-r-[0-9a-f]{16}\.js$/.test(p)) return true;
  if (/^releases\/r-[0-9a-f]{16}\/(index\.html|manifest\.webmanifest|release\.json)$/.test(p))
    return true;
  return SRD_PACKS.some((pack) =>
    new RegExp(`^content/${pack.replace(/\./g, "\\.")}/[a-z0-9_-]+\\.json$`).test(p),
  );
}
