/**
 * kenli F-014 T03: the Pages artifact (docs/deployment.md §9.4). The site exported from the archive is
 * packed here — not by upload-pages-artifact — into one deterministic ustar `artifact.tar` holding
 * exactly the site manifest's files (the hidden marker included), as upload-pages-artifact lays it
 * out (`./` and its directories, then the files; uploaded as the `github-pages` artifact for
 * deploy-pages). The tar is then read back by our own reader and checked file by file against the
 * manifest, and a canary proves nothing else is in it: no parent-workspace, source, config or
 * private file (by content and name), no link, no unsafe path.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { type FileRef, fail, safePath, sha256 } from "./lib";

const BLOCK = 512;
const MAX_NAME = 100; // ustar `name` without the prefix field: every site path fits (checked)

function octal(n: number, width: number): string {
  return `${n.toString(8).padStart(width - 1, "0")}\0`;
}
function header(name: string, size: number, type: "0" | "5"): Buffer {
  if (Buffer.byteLength(name) > MAX_NAME)
    fail("artifact_invalid", `path too long for the tar: ${name}`);
  const h = Buffer.alloc(BLOCK, 0);
  h.write(name, 0, "utf8");
  h.write(octal(type === "5" ? 0o755 : 0o644, 8), 100, "ascii");
  h.write(octal(0, 8), 108, "ascii"); // uid
  h.write(octal(0, 8), 116, "ascii"); // gid
  h.write(octal(size, 12), 124, "ascii");
  h.write(octal(0, 12), 136, "ascii"); // mtime: fixed, so equal sites give equal bytes
  h.write("        ", 148, "ascii"); // checksum placeholder
  h.write(type, 156, "ascii");
  h.write("ustar\0", 257, "ascii");
  h.write("00", 263, "ascii");
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
  return h;
}

/** Path for the tar: the manifest path with `./` (the marker is a hidden file and stays). */
const entryName = (p: string) => `./${p}`;
const sitePathOk = (p: string) => safePath(p === ".srd-table-deploy.json" ? "marker" : p);

/**
 * Pack `files` (the archive's site manifest) from `siteDir` into `out`: the directories they need
 * and the files, sorted, regular files only, each checked against its manifest hash while packing.
 * Nothing in the directory that the manifest doesn't list is packed (and its presence refuses).
 */
export function packSite(
  siteDir: string,
  files: readonly FileRef[],
  out: string,
): { sha256: string; size: number; entries: number } {
  const listed = new Set(files.map((f) => f.path));
  const onDisk = walkFiles(siteDir);
  const extra = onDisk.filter((p) => !listed.has(p));
  if (extra.length)
    fail("artifact_invalid", `files not in the site manifest: ${extra.slice(0, 10).join(", ")}`);
  const dirs = new Set<string>();
  for (const f of files) {
    if (!sitePathOk(f.path)) fail("artifact_invalid", `unsafe path ${f.path}`);
    const parts = f.path.split("/");
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
  }
  const chunks: Buffer[] = [header("./", 0, "5")];
  for (const d of [...dirs].sort()) chunks.push(header(`${entryName(d)}/`, 0, "5"));
  for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    const st = statSync(join(siteDir, f.path), { throwIfNoEntry: false });
    if (!st?.isFile()) fail("artifact_invalid", `${f.path} is not a regular file`);
    const bytes = readFileSync(join(siteDir, f.path));
    if (bytes.byteLength !== f.size || sha256(bytes) !== f.sha256)
      fail("artifact_invalid", `bytes of ${f.path}`);
    chunks.push(header(entryName(f.path), bytes.byteLength, "0"), bytes);
    const pad = (BLOCK - (bytes.byteLength % BLOCK)) % BLOCK;
    if (pad) chunks.push(Buffer.alloc(pad, 0));
  }
  chunks.push(Buffer.alloc(BLOCK * 2, 0));
  const tar = Buffer.concat(chunks);
  writeFileSync(out, tar);
  return { sha256: sha256(tar), size: tar.byteLength, entries: files.length + dirs.size + 1 };
}

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  const go = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) go(p);
      else if (e.isFile()) out.push(relative(dir, p));
      else fail("artifact_invalid", `not a regular file: ${relative(dir, p)}`);
    }
  };
  go(dir);
  return out.sort();
}

export interface TarEntry {
  readonly name: string;
  readonly type: "file" | "dir";
  readonly bytes: Buffer;
}
/** Our own reader: ustar/GNU headers, regular files and directories only; anything else refuses. */
export function readTar(tar: Buffer): TarEntry[] {
  const out: TarEntry[] = [];
  let off = 0;
  while (off + BLOCK <= tar.byteLength) {
    const h = tar.subarray(off, off + BLOCK);
    if (h.every((b) => b === 0)) break;
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : (h[i] as number);
    const stored = Number.parseInt(
      h.subarray(148, 156).toString("ascii").replace(/\0.*$/, "").trim(),
      8,
    );
    if (stored !== sum) fail("artifact_invalid", `tar header checksum at ${off}`);
    const cstr = (a: number, b: number) => h.subarray(a, b).toString("utf8").replace(/\0.*$/s, "");
    const prefix = cstr(345, 500);
    const name = prefix ? `${prefix}/${cstr(0, 100)}` : cstr(0, 100);
    const size = Number.parseInt(cstr(124, 136).trim() || "0", 8);
    const type = String.fromCharCode(h[156] as number);
    off += BLOCK;
    if (type === "0" || type === "\0") {
      out.push({ name, type: "file", bytes: Buffer.from(tar.subarray(off, off + size)) });
      off += Math.ceil(size / BLOCK) * BLOCK;
    } else if (type === "5") out.push({ name, type: "dir", bytes: Buffer.alloc(0) });
    else
      fail(
        "artifact_invalid",
        `tar entry ${name}: type ${JSON.stringify(type)} (links and others refused)`,
      );
  }
  return out;
}

/**
 * The tar holds exactly the manifest: every file once with its bytes, the directories they need and
 * `./`, nothing else; names safe (no `..`, absolute, backslash or hidden segment but the marker).
 */
export function verifyTar(tar: Buffer, files: readonly FileRef[]): string[] {
  const errs: string[] = [];
  const expected = new Map(files.map((f) => [entryName(f.path), f]));
  const dirs = new Set(["./"]);
  for (const f of files) {
    const parts = f.path.split("/");
    for (let i = 1; i < parts.length; i++) dirs.add(`${entryName(parts.slice(0, i).join("/"))}/`);
  }
  const seen = new Set<string>();
  for (const e of readTar(tar)) {
    if (seen.has(e.name)) errs.push(`duplicate ${e.name}`);
    seen.add(e.name);
    if (e.type === "dir") {
      if (!dirs.has(e.name)) errs.push(`unexpected directory ${e.name}`);
      continue;
    }
    const f = expected.get(e.name);
    if (!f) errs.push(`unexpected file ${e.name}`);
    else if (e.bytes.byteLength !== f.size || sha256(e.bytes) !== f.sha256)
      errs.push(`bytes of ${e.name}`);
    if (!e.name.startsWith("./") || !sitePathOk(e.name.slice(2)))
      errs.push(`unsafe name ${e.name}`);
  }
  for (const n of expected.keys()) if (!seen.has(n)) errs.push(`missing ${n}`);
  return errs;
}

/** Paths that are never part of a site, whatever ownership said (defense in depth for the canary). */
const NEVER =
  /(^|\/)(\.git|\.github|node_modules|src|scripts|tests|docs|private|library|f005)(\/|$)|(^|\/)(package(-lock)?\.json|tsconfig[^/]*\.json|biome\.json|vite\.config\.ts|\.env[^/]*|.*\.tsx?|.*\.map)$/;

/**
 * The pre-upload canary: none of these files (planted parent-workspace/private canaries and every
 * tracked source/config file of the checkout, given as directories or files) is in the tar — not
 * by content, not by name — and no entry has a path a site never has.
 */
export interface Probe {
  readonly path: string;
  readonly bytes: Buffer;
  /** Also refuse an entry of the same relative name (planted canaries; not source files, whose
   * names like `index.html` the site legitimately has). */
  readonly byName: boolean;
}
export function canaryProblems(tar: Buffer, probes: readonly Probe[]): string[] {
  const errs: string[] = [];
  const entries = readTar(tar).filter((e) => e.type === "file");
  const hashes = new Map(entries.map((e) => [sha256(e.bytes), e.name]));
  const names = new Set(entries.map((e) => e.name.slice(2)));
  for (const e of entries) if (NEVER.test(e.name.slice(2))) errs.push(`never-site path ${e.name}`);
  for (const p of probes) {
    if (p.bytes.byteLength === 0) continue;
    const hit = hashes.get(sha256(p.bytes));
    if (hit) errs.push(`content of ${p.path} is in the artifact as ${hit}`);
    if (p.byName && names.has(p.path)) errs.push(`${p.path} is in the artifact by name`);
  }
  return errs;
}
