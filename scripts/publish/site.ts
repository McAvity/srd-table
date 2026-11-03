/**
 * kenli F-014 T02: publish one Table release and the SRD pack into a site directory without deleting
 * anything (docs/deployment.md §5). Ported from dnd5 `tools/migration/app/publish.ts` (provenance:
 * scripts/publish/PROVENANCE.md): the same order, immutability, closed graph, two pointers, bridge
 * and database-downgrade refusal. Not ported: the F006 legacy inventory (a public site never had an
 * F006 deployment). Added: the SRD pack (immutable by path), the closed allowlist of the whole site,
 * the size guard and the full byte manifest of the result.
 *
 * Order (each step idempotent; a rerun finishes an interrupted one):
 *   verify     the release (descriptor, every byte, no dirty/variant build, app_version as asked), the
 *              SRD pack and the site (allowlist, no symlink/hardlink, retained files byte-exact, no
 *              immutable path with other bytes) — all BEFORE writing;
 *   content    content/<pack>/*.json, immutable;
 *   immutable  assets, sw-<id>.js, releases/<id>/{index.html,manifest.webmanifest};
 *   descriptor releases/<id>/release.json;
 *   manifest   releases/index.json lists the release (its files retained forever);
 *   pointer    release-current.json / release.json (and the manifest's bridge), atomic replaces;
 *   root       index.html = the release HTML;
 *   marker     .srd-table-deploy.json; then the whole site is re-checked.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  CURRENT_POINTER,
  compareVersions,
  type Descriptor,
  descriptorProblems,
  type FileRef,
  fail,
  fileRefOf,
  jcs,
  json,
  LEGACY_POINTER,
  MANIFEST,
  MARKER,
  type ManifestRelease,
  MUTABLE,
  type Pointer,
  type PublishManifest,
  releaseFiles,
  SRD_PACKS,
  sha256,
  sitePathAllowed,
  TEMP_FILE,
  walk,
} from "./lib";

export type Step =
  | "verify"
  | "content"
  | "immutable"
  | "descriptor"
  | "manifest"
  | "pointer"
  | "root"
  | "marker";
export interface Hooks {
  /** Fault injection (tests): before a step's write, and after its temp file is written but not renamed. */
  readonly fault?: (at: { step: Step; path: string; stage: "before" | "temp" }) => void;
}
export interface Staged {
  readonly dir: string;
  readonly descriptor: Descriptor;
  readonly descriptorBytes: Buffer;
  readonly files: FileRef[];
}
export interface SrdPack {
  readonly dir: string;
  readonly pack: string;
  /** Site paths `content/<pack>/<file>.json`. */
  readonly files: FileRef[];
}
/** 900 MiB: a margin under the Pages 1 GB site limit (no automatic removal of old releases). */
export const SITE_LIMIT = 900 * 1024 * 1024;

/** A staging release exactly as scripts/release.ts writes it, every byte checked. */
export function readStaging(dir: string, opts: { allowVariant?: boolean } = {}): Staged {
  if (!existsSync(join(dir, "releases"))) fail("staging_invalid", "no releases/");
  const ids = readdirSync(join(dir, "releases"));
  if (ids.length !== 1)
    fail("staging_invalid", `releases/ must hold one release, found ${ids.join(", ")}`);
  const id = ids[0] as string;
  const descriptorPath = `releases/${id}/release.json`;
  const descriptorBytes = readFileSync(join(dir, descriptorPath));
  let d: Descriptor;
  try {
    d = JSON.parse(descriptorBytes.toString("utf8")) as Descriptor;
  } catch {
    return fail("staging_invalid", "descriptor is not JSON");
  }
  const problems = descriptorProblems(d);
  if (problems.length) fail("staging_invalid", problems.join("; "));
  if (d.release_id !== id)
    fail("staging_invalid", `descriptor ${d.release_id} under releases/${id}`);
  if (d.inputs.dirty) fail("release_dirty", "built from a tree with uncommitted changes");
  if (d.inputs.variant !== undefined && !opts.allowVariant)
    fail("release_variant", String(d.inputs.variant));
  const files = releaseFiles(d);
  const { files: onDisk, symlinks, hardlinks } = walk(dir);
  if (symlinks.length) fail("staging_invalid", `symlinks: ${symlinks.join(", ")}`);
  if (hardlinks.length) fail("staging_invalid", `hard links: ${hardlinks.join(", ")}`);
  const expected = new Set(["index.html", descriptorPath, ...files.map((f) => f.path)]);
  const extra = onDisk.filter((p) => !expected.has(p));
  const missing = [...expected].filter((p) => !onDisk.includes(p));
  if (extra.length || missing.length)
    fail("staging_invalid", `extra: ${extra.join(", ")}; missing: ${missing.join(", ")}`);
  for (const f of files) {
    const b = readFileSync(join(dir, f.path));
    if (b.byteLength !== f.size || sha256(b) !== f.sha256)
      fail("staging_invalid", `bytes of ${f.path}`);
  }
  if (sha256(readFileSync(join(dir, "index.html"))) !== d.html.sha256)
    fail("staging_invalid", "index.html ≠ release HTML");
  return { dir, descriptor: d, descriptorBytes, files };
}

/** The engine's split SRD (`dist/srd-5.2.1/`): flat JSON files with its manifest, nothing else. */
export function readSrd(dir: string, pack: string = SRD_PACKS[0]): SrdPack {
  if (!(SRD_PACKS as readonly string[]).includes(pack)) fail("srd_invalid", `pack ${pack}`);
  if (!existsSync(join(dir, "manifest.json"))) fail("srd_missing", `${dir}/manifest.json`);
  const { files, symlinks, dirs, hardlinks } = walk(dir);
  if (symlinks.length || hardlinks.length || dirs.length)
    fail("srd_invalid", `only plain files: ${[...symlinks, ...hardlinks, ...dirs].join(", ")}`);
  let manifest: { name?: unknown; tables?: Record<string, { file?: unknown }> };
  try {
    manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  } catch {
    return fail("srd_invalid", "manifest.json is not JSON");
  }
  if (manifest.name !== pack) fail("srd_invalid", `manifest name ${String(manifest.name)}`);
  // exactly the files the pack's own manifest names (a closed list: nothing else in the directory,
  // e.g. a private or parent-workspace file dropped next to it, reaches the site)
  const tables = manifest.tables;
  if (typeof tables !== "object" || tables === null || Array.isArray(tables))
    fail("srd_invalid", "manifest.json has no tables");
  const named = new Set(["manifest.json"]);
  for (const [t, v] of Object.entries(tables as object)) {
    const file = (v as { file?: unknown })?.file;
    if (typeof file !== "string" || !sitePathAllowed(`content/${pack}/${file}`))
      fail("srd_invalid", `table ${t}: file ${String(file)}`);
    named.add(file as string);
  }
  const unlisted = files.filter((f) => !named.has(f));
  if (unlisted.length) fail("srd_unlisted", `not in the pack's manifest: ${unlisted.join(", ")}`);
  const missing = [...named].filter((f) => !files.includes(f));
  if (missing.length) fail("srd_missing", missing.join(", "));
  const refs: FileRef[] = [];
  for (const f of files) {
    const bytes = readFileSync(join(dir, f));
    try {
      JSON.parse(bytes.toString("utf8"));
    } catch {
      fail("srd_invalid", `${f} is not JSON`);
    }
    refs.push({ path: `content/${pack}/${f}`, sha256: sha256(bytes), size: bytes.byteLength });
  }
  return { dir, pack, files: refs };
}

const parseJson = <T>(bytes: Buffer, what: string): T => {
  try {
    return JSON.parse(bytes.toString("utf8")) as T;
  } catch {
    return fail("site_invalid", `${what} is not JSON`);
  }
};

interface Inspected {
  readonly manifest: PublishManifest | null;
  readonly retained: Map<string, FileRef>;
  readonly temps: string[];
}

/** The site as it is, strictly (also mid-publication): every refusal before any write. */
/**
 * R03-04 / D014-001: who owns each file of a site. A path is owned only by
 *  - the mutable files (root, pointers, marker, release manifest);
 *  - a release the manifest lists, through its own descriptor: the entry's record must be
 *    `releases/<id>/release.json` with the recorded hash, the descriptor must pass the publisher's
 *    checks under that id and base, and the entry's files must be exactly the descriptor's files
 *    (no file can be "listed" without its release declaring it);
 *  - the SRD pack: `content/<pack>/manifest.json` and exactly the table files it names;
 *  - `also`: the files of the release and SRD being published now (an interrupted publication's own
 *    files, before its manifest entry is written), already verified by readStaging/readSrd.
 * Anything else under an allowed prefix — an orphan asset, SW, release directory or content file —
 * is not srd-table's to publish. Temp files of an interrupted write are left to the caller.
 */
export function ownershipProblems(site: string, also: Iterable<string> = []): string[] {
  const out: string[] = [];
  const read = (p: string) => (existsSync(join(site, p)) ? readFileSync(join(site, p)) : null);
  const owned = new Set<string>([...MUTABLE, ...also]);
  const mb = read(MANIFEST);
  let manifest: PublishManifest | null = null;
  if (mb) {
    try {
      manifest = JSON.parse(mb.toString("utf8")) as PublishManifest;
    } catch {
      return [`${MANIFEST} is not JSON`];
    }
  }
  for (const r of manifest?.releases ?? []) {
    const record = `releases/${r.release_id}/release.json`;
    const db = read(record);
    if (r.kind !== "release" || r.record !== record || !db || sha256(db) !== r.record_sha256) {
      out.push(`release ${r.release_id}: record ${r.record} is not its descriptor`);
      continue;
    }
    let d: Descriptor;
    try {
      d = JSON.parse(db.toString("utf8")) as Descriptor;
    } catch {
      out.push(`release ${r.release_id}: descriptor is not JSON`);
      continue;
    }
    const problems = descriptorProblems(d);
    if (problems.length || d.release_id !== r.release_id || d.base !== manifest?.base) {
      out.push(`release ${r.release_id}: descriptor invalid (${problems.join("; ") || "id/base"})`);
      continue;
    }
    if (jcs(r.files) !== jcs(releaseFiles(d))) {
      out.push(`release ${r.release_id}: listed files are not its descriptor's`);
      continue;
    }
    owned.add(record);
    for (const f of r.files) owned.add(f.path);
  }
  for (const pack of SRD_PACKS) {
    const mp = `content/${pack}/manifest.json`;
    const m = read(mp);
    if (!m) continue;
    let tables: unknown;
    try {
      const parsed = JSON.parse(m.toString("utf8")) as { name?: unknown; tables?: unknown };
      if (parsed.name !== pack) throw new Error("name");
      tables = parsed.tables;
    } catch {
      out.push(`${mp} is not ${pack}'s manifest`);
      continue;
    }
    owned.add(mp);
    if (typeof tables !== "object" || tables === null) continue;
    for (const v of Object.values(tables as Record<string, { file?: unknown }>))
      if (typeof v?.file === "string") owned.add(`content/${pack}/${v.file}`);
  }
  const { files } = walk(site);
  for (const f of files)
    if (!owned.has(f) && !TEMP_FILE.test(basename(f))) out.push(`unowned ${f}`);
  return out;
}

export function inspectSite(site: string, base: string, also: Iterable<string> = []): Inspected {
  const { files, symlinks, hardlinks } = walk(site);
  if (symlinks.length) fail("site_symlink", symlinks.join(", "));
  if (hardlinks.length) fail("site_symlink", `hard links: ${hardlinks.join(", ")}`);
  const temps = files.filter((f) => TEMP_FILE.test(basename(f)));
  const foreign = files.filter((f) => !temps.includes(f) && !sitePathAllowed(f));
  if (foreign.length) fail("site_foreign_file", foreign.slice(0, 10).join(", "));
  let manifest: PublishManifest | null = null;
  if (files.includes(MANIFEST)) {
    manifest = parseJson<PublishManifest>(readFileSync(join(site, MANIFEST)), MANIFEST);
    if (manifest.format !== "srd-table.publish-manifest/1" || !Array.isArray(manifest.releases))
      fail("site_invalid", MANIFEST);
    if (manifest.base !== base) fail("site_base", `${manifest.base} ≠ ${base}`);
  }
  // Who owns the mutable files: without a release manifest, nobody we can trust.
  if (!manifest) {
    const owned = MUTABLE.filter((m) => files.includes(m));
    if (owned.length) fail("site_unmarked", `${owned.join(", ")} without a release manifest`);
  }
  const retained = new Map<string, FileRef>();
  for (const r of manifest?.releases ?? []) {
    for (const f of [...r.files, { path: r.record, sha256: r.record_sha256, size: 0 }]) {
      const p = join(site, f.path);
      if (!existsSync(p) || sha256(readFileSync(p)) !== f.sha256)
        fail("site_invalid", `retained ${f.path} missing or changed`);
      if (f.size) retained.set(f.path, f);
    }
  }
  // R03-04: every file owned (a verified release, the SRD's own list, or this publication's files)
  const unowned = ownershipProblems(site, also);
  if (unowned.length) fail("site_unowned", unowned.slice(0, 10).join("; "));
  return { manifest, retained, temps };
}

let counter = 0;
function atomicWrite(site: string, path: string, bytes: Buffer | string, step: Step, hooks: Hooks) {
  hooks.fault?.({ step, path, stage: "before" });
  const abs = join(site, path);
  mkdirSync(dirname(abs), { recursive: true });
  const tmp = join(dirname(abs), `.pages-publish-${process.pid}-${counter++}.tmp`);
  writeFileSync(tmp, bytes);
  hooks.fault?.({ step, path, stage: "temp" });
  renameSync(tmp, abs);
}
/** Immutable: absent → written; present with the same bytes → kept (never rewritten). */
function putImmutable(
  site: string,
  path: string,
  bytes: Buffer,
  step: Step,
  hooks: Hooks,
  written: string[],
) {
  const abs = join(site, path);
  if (existsSync(abs)) {
    if (sha256(readFileSync(abs)) !== sha256(bytes))
      fail(step === "content" ? "content_conflict" : "immutable_conflict", path);
    return;
  }
  atomicWrite(site, path, bytes, step, hooks);
  written.push(path);
}

/** The descriptor a pointer file names (`null`: no pointer), as on disk. */
function pointedAt(site: string, path: string): Descriptor | null {
  const p = join(site, path);
  if (!existsSync(p)) return null;
  const ptr = parseJson<Pointer>(readFileSync(p), path);
  return parseJson<Descriptor>(readFileSync(join(site, ptr.descriptor)), ptr.descriptor);
}
const dbOf = (d: Descriptor): number =>
  Number((d.inputs as { data?: { db_version?: unknown } }).data?.db_version ?? 0);

/** dnd5 F-002 T07: which pointers this publication moves (refusals before any write). */
export function pointerPlan(
  site: string,
  d: Descriptor,
  manifest: PublishManifest | null,
  bridge: boolean,
): { legacy: boolean; current: boolean; setBridge: boolean } {
  const legacy = pointedAt(site, LEGACY_POINTER);
  const current = pointedAt(site, CURRENT_POINTER);
  const fixed = manifest?.bridge ?? null;
  const db = dbOf(d);
  const newest = current ?? legacy;
  if (newest && db < dbOf(newest))
    fail(
      "release_downgrade",
      `${d.release_id} (database ${db}) after ${newest.release_id} (database ${dbOf(newest)})`,
    );
  // kenli F-014: a numbered release never goes below the numbered release the site points at
  const nv = d.inputs.app_version;
  const ov = newest?.inputs.app_version;
  if (newest && newest.release_id !== d.release_id && nv && ov && compareVersions(nv, ov) <= 0)
    fail("version_not_newer", `${nv} after ${ov}`);
  if (bridge) {
    if (fixed && fixed !== d.release_id) fail("bridge_exists", `release.json stays on ${fixed}`);
    if (legacy && legacy.release_id !== d.release_id && dbOf(legacy) !== db)
      fail(
        "bridge_database",
        `a bridge has the database of ${legacy.release_id} (${dbOf(legacy)}), not ${db}`,
      );
    return { legacy: true, current: true, setBridge: !fixed };
  }
  if (fixed) return { legacy: false, current: true, setBridge: false };
  if (legacy && db > dbOf(legacy))
    fail(
      "bridge_required",
      `release.json clients (${legacy.release_id}, database ${dbOf(legacy)}) can't take database ${db}: publish a bridge first (--bridge)`,
    );
  return { legacy: true, current: current !== null, setBridge: false };
}

export interface PublishOptions {
  readonly base: string;
  readonly version: string;
  readonly bridge?: boolean;
  readonly hooks?: Hooks;
}
export interface PublishResult {
  readonly release_id: string;
  readonly written: string[];
  readonly kept: number;
  readonly cleaned: string[];
  /** The mutable files as this publication left them (the version record keeps them). */
  readonly mutable: MutableState;
}
/** The mutable files of a site: pointer/marker JSON as written, the root as a release's HTML path. */
export interface MutableState {
  readonly root_html: string | null;
  readonly pointers: Readonly<Record<string, Pointer | null>>;
  readonly marker: Record<string, unknown> | null;
}

export const markerOf = (d: Descriptor, version: string) => ({
  publisher: "srd-table.pages-publish/1",
  version,
  release_id: d.release_id,
  table_commit: d.inputs.table_commit,
  engine_commit: d.inputs.engine_commit,
  base_url: d.base,
});

/** Publish the release and the SRD pack into `site` (a working copy; never the live host). */
export function publishRelease(
  site: string,
  staged: Staged,
  srd: SrdPack,
  opts: PublishOptions,
): PublishResult {
  const hooks = opts.hooks ?? {};
  const d = staged.descriptor;
  if (d.base !== opts.base) fail("release_base", `${d.base} ≠ ${opts.base}`);
  if (d.inputs.app_version !== opts.version)
    fail(
      "version_mismatch",
      `release is ${d.inputs.app_version ?? "unnumbered"}, not ${opts.version}`,
    );
  hooks.fault?.({ step: "verify", path: "", stage: "before" });
  const before = inspectSite(site, opts.base, [
    ...staged.files.map((f) => f.path),
    `releases/${d.release_id}/release.json`,
    ...srd.files.map((f) => f.path),
  ]);
  // immutable and content conflicts, before anything is written
  const descriptorPath = `releases/${d.release_id}/release.json`;
  const descriptorRef = {
    path: descriptorPath,
    sha256: sha256(staged.descriptorBytes),
    size: staged.descriptorBytes.byteLength,
  };
  for (const f of [...staged.files, descriptorRef, ...srd.files]) {
    const p = join(site, f.path);
    const code = f.path.startsWith("content/") ? "content_conflict" : "immutable_conflict";
    if (existsSync(p) && sha256(readFileSync(p)) !== f.sha256) fail(code, f.path);
    const r = before.retained.get(f.path);
    if (r && r.sha256 !== f.sha256) fail(code, f.path);
  }
  const listed = before.manifest?.releases.find((r) => r.release_id === d.release_id);
  if (listed && listed.record_sha256 !== descriptorRef.sha256)
    fail("release_conflict", d.release_id);
  const moves = pointerPlan(site, d, before.manifest, opts.bridge ?? false);
  const cleaned: string[] = [];
  for (const t of before.temps) {
    rmSync(join(site, t));
    cleaned.push(t);
  }
  const written: string[] = [];
  let manifest: PublishManifest = before.manifest ?? {
    format: "srd-table.publish-manifest/1",
    base: d.base,
    releases: [],
  };
  // content (the SRD the release reads), then the release's immutable files
  for (const f of srd.files)
    putImmutable(
      site,
      f.path,
      readFileSync(join(srd.dir, f.path.slice(`content/${srd.pack}/`.length))),
      "content",
      hooks,
      written,
    );
  for (const f of staged.files)
    putImmutable(site, f.path, readFileSync(join(staged.dir, f.path)), "immutable", hooks, written);
  putImmutable(site, descriptorPath, staged.descriptorBytes, "descriptor", hooks, written);
  if (!manifest.releases.some((x) => x.release_id === d.release_id)) {
    const rec: ManifestRelease = {
      release_id: d.release_id,
      kind: "release",
      record: descriptorPath,
      record_sha256: descriptorRef.sha256,
      files: staged.files,
    };
    manifest = { ...manifest, releases: [...manifest.releases, rec] };
    atomicWrite(site, MANIFEST, json(manifest), "manifest", hooks);
    written.push(MANIFEST);
  }
  const pointer: Pointer = {
    format: "srd-table.release-pointer/1",
    base: d.base,
    release_id: d.release_id,
    descriptor: descriptorPath,
    descriptor_sha256: descriptorRef.sha256,
  };
  if (moves.current) {
    atomicWrite(site, CURRENT_POINTER, json(pointer), "pointer", hooks);
    written.push(CURRENT_POINTER);
  }
  if (moves.legacy) {
    atomicWrite(site, LEGACY_POINTER, json(pointer), "pointer", hooks);
    written.push(LEGACY_POINTER);
  }
  if (moves.setBridge) {
    manifest = { ...manifest, bridge: d.release_id };
    atomicWrite(site, MANIFEST, json(manifest), "pointer", hooks);
    written.push(MANIFEST);
  }
  atomicWrite(site, "index.html", readFileSync(join(staged.dir, d.html.path)), "root", hooks);
  const marker = markerOf(d, opts.version);
  atomicWrite(site, MARKER, json(marker), "marker", hooks);
  written.push("index.html", MARKER);
  const problems = [...siteProblems(site), ...ownershipProblems(site)];
  if (problems.length) fail("site_invalid_after", problems.join("; "));
  return {
    release_id: d.release_id,
    written,
    kept:
      staged.files.length - written.filter((w) => staged.files.some((f) => f.path === w)).length,
    cleaned,
    mutable: mutableOf(site),
  };
}

/** The mutable files as they are now (pointers and marker parsed, the root as its release HTML). */
export function mutableOf(site: string): MutableState {
  const read = (p: string) => (existsSync(join(site, p)) ? readFileSync(join(site, p)) : null);
  const pointers: Record<string, Pointer | null> = {};
  for (const p of [LEGACY_POINTER, CURRENT_POINTER]) {
    const b = read(p);
    pointers[p] = b ? parseJson<Pointer>(b, p) : null;
  }
  const m = read(MARKER);
  const root = read("index.html");
  let rootHtml: string | null = null;
  if (root) {
    const h = sha256(root);
    const mb = read(MANIFEST);
    const manifest = mb ? parseJson<PublishManifest>(mb, MANIFEST) : null;
    rootHtml =
      manifest?.releases
        .flatMap((r) => r.files)
        .find((f) => /^releases\/r-[0-9a-f]{16}\/index\.html$/.test(f.path) && f.sha256 === h)
        ?.path ?? fail("site_invalid", "root index.html of no listed release");
  }
  return { root_html: rootHtml, pointers, marker: m ? parseJson(m, MARKER) : null };
}

/** Write exactly these mutable files (pointer/marker JSON, root from a retained HTML; absent → removed). */
export function restoreMutable(site: string, m: MutableState): void {
  const hooks: Hooks = {};
  for (const p of [CURRENT_POINTER, LEGACY_POINTER]) {
    const v = m.pointers[p] ?? null;
    if (v) atomicWrite(site, p, json(v), "pointer", hooks);
    else rmSync(join(site, p), { force: true });
  }
  if (m.root_html)
    atomicWrite(site, "index.html", readFileSync(join(site, m.root_html)), "root", hooks);
  else rmSync(join(site, "index.html"), { force: true });
  if (m.marker) atomicWrite(site, MARKER, json(m.marker), "marker", hooks);
  else rmSync(join(site, MARKER), { force: true });
  const problems = [...siteProblems(site), ...ownershipProblems(site)];
  if (problems.length) fail("site_invalid_after", problems.join("; "));
}

/**
 * What a reader can observe (also between steps of an interrupted publication): the allowlist, every
 * manifest-retained file byte-exact, each pointer naming a complete release, the bridge kept, the
 * root HTML a listed release's.
 */
export function siteProblems(site: string): string[] {
  const errs: string[] = [];
  const { files, symlinks, hardlinks } = walk(site);
  if (symlinks.length || hardlinks.length)
    errs.push(`links: ${[...symlinks, ...hardlinks].join(", ")}`);
  // an interrupted publication's temp files are never served nor archived (site-manifest.json)
  for (const f of files)
    if (!sitePathAllowed(f) && !TEMP_FILE.test(basename(f))) errs.push(`foreign ${f}`);
  const read = (p: string) => (existsSync(join(site, p)) ? readFileSync(join(site, p)) : null);
  const mb = read(MANIFEST);
  const manifest = mb ? (JSON.parse(mb.toString("utf8")) as PublishManifest) : null;
  const complete = (fs: readonly FileRef[]) =>
    fs.every((f) => sha256(read(f.path) ?? Buffer.alloc(0)) === f.sha256);
  for (const r of manifest?.releases ?? []) {
    if (!complete(r.files)) errs.push(`retained ${r.release_id} incomplete`);
    if (sha256(read(r.record) ?? Buffer.alloc(0)) !== r.record_sha256)
      errs.push(`record ${r.record}`);
  }
  const named: Record<string, string> = {};
  for (const path of [LEGACY_POINTER, CURRENT_POINTER]) {
    const pb = read(path);
    if (!pb) continue;
    const p = JSON.parse(pb.toString("utf8")) as Pointer;
    named[path] = p.release_id;
    const db = read(p.descriptor);
    if (!db || sha256(db) !== p.descriptor_sha256)
      errs.push(`${path}: pointer to a missing descriptor`);
    else if (!complete(releaseFiles(JSON.parse(db.toString("utf8")) as Descriptor)))
      errs.push(`${path}: pointer to incomplete ${p.release_id}`);
  }
  if (manifest?.bridge) {
    if (named[LEGACY_POINTER] !== manifest.bridge)
      errs.push(`release.json is not the bridge ${manifest.bridge}`);
    if (!named[CURRENT_POINTER]) errs.push(`no ${CURRENT_POINTER} after the bridge`);
  }
  const root = read("index.html");
  if (root) {
    const h = sha256(root);
    const owner = manifest?.releases.find((r) =>
      r.files.some((f) => f.path.endsWith("/index.html") && f.sha256 === h),
    );
    if (!owner) errs.push("root index.html of no listed release");
    else if (!complete(owner.files)) errs.push(`root of incomplete ${owner.release_id}`);
  }
  return errs;
}

/** The full byte manifest of a site: every file, sorted by path. */
export function siteManifest(site: string): { files: FileRef[]; total_bytes: number } {
  const { files, symlinks, hardlinks } = walk(site);
  if (symlinks.length || hardlinks.length)
    fail("site_symlink", [...symlinks, ...hardlinks].join(", "));
  const refs = files.sort().map((f) => fileRefOf(site, f));
  return { files: refs, total_bytes: refs.reduce((s, f) => s + f.size, 0) };
}

/** The site's bytes equal a manifest exactly: no file missing, changed or extra. */
export function manifestDiff(site: string, expected: readonly FileRef[]): string[] {
  const actual = new Map(siteManifest(site).files.map((f) => [f.path, f]));
  const out: string[] = [];
  for (const f of expected) {
    const a = actual.get(f.path);
    if (!a) out.push(`missing ${f.path}`);
    else if (a.sha256 !== f.sha256 || a.size !== f.size) out.push(`changed ${f.path}`);
    actual.delete(f.path);
  }
  for (const p of actual.keys()) out.push(`extra ${p}`);
  return out;
}
