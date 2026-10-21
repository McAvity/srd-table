/**
 * kenli F-007 T02: the closed resource graph of a release (contracts/offline.md §2.3). Built from
 * the ACTUAL build output — every file under assets/ — with edges from the Vite manifest AND from
 * scanning HTML, the web manifest, JS and CSS (the engine worker is only reachable by the scan:
 * `new URL("…worker…", import.meta.url)` is not in the Vite manifest). A reference to a file that
 * is not there, or a file nobody reaches, fails the build.
 */

import type { Asset, AssetRole } from "../../src/offline/descriptor";

export interface GraphInput {
  /** assets/… → bytes (every file Vite emitted under assets/, plus the hashed icons). */
  readonly assets: ReadonlyMap<string, Uint8Array>;
  readonly html: { readonly path: string; readonly text: string };
  readonly webmanifest: { readonly path: string; readonly text: string };
  /** `.vite/manifest.json` of the build. */
  readonly viteManifest: Readonly<Record<string, ViteChunk>>;
  readonly base: string;
}
export interface ViteChunk {
  readonly file: string;
  readonly isEntry?: boolean;
  readonly isDynamicEntry?: boolean;
  readonly imports?: readonly string[];
  readonly dynamicImports?: readonly string[];
  readonly css?: readonly string[];
  readonly assets?: readonly string[];
}
export interface Graph {
  readonly roots: [string, string];
  readonly edges: [string, string][];
  readonly roles: Map<string, AssetRole>;
  readonly problems: string[];
}

const REF =
  /(?:\.\/|assets\/|\/)([A-Za-z0-9_.-]+\.(?:js|css|woff2?|png|svg|webp|ico|json|webmanifest))/g;

export function buildGraph(g: GraphInput): Graph {
  const problems: string[] = [];
  const names = new Map<string, string>(); // basename → assets/basename
  for (const p of g.assets.keys()) {
    if (!p.startsWith("assets/") || p.slice(7).includes("/"))
      problems.push(`release_asset_layout: ${p}`);
    names.set(p.slice(7), p);
  }
  const edges = new Map<string, Set<string>>();
  const add = (from: string, to: string) => {
    if (from === to) return;
    let s = edges.get(from);
    if (!s) {
      s = new Set();
      edges.set(from, s);
    }
    s.add(to);
  };
  const decoder = new TextDecoder();
  /** Every assets/… reference in a text file; a referenced asset that does not exist is a problem. */
  const scan = (from: string, text: string) => {
    // absolute or base-relative asset URLs must exist
    const abs = new RegExp(`${escapeRe(g.base)}assets/([A-Za-z0-9_.-]+)`, "g");
    for (const m of text.matchAll(abs)) {
      const to = names.get(m[1] as string);
      if (to) add(from, to);
      else problems.push(`release_graph_missing: ${from} → assets/${m[1]}`);
    }
    for (const m of text.matchAll(REF)) {
      const to = names.get(m[1] as string);
      if (to) add(from, to);
    }
  };
  scan(g.html.path, g.html.text);
  scan(g.webmanifest.path, g.webmanifest.text);
  for (const [p, bytes] of g.assets) if (/\.(js|css)$/.test(p)) scan(p, decoder.decode(bytes));
  // the Vite manifest: everything it names must exist, and it adds the edges it knows
  const fileOf = (key: string) => g.viteManifest[key]?.file;
  for (const [key, c] of Object.entries(g.viteManifest)) {
    for (const f of [c.file, ...(c.css ?? []), ...(c.assets ?? [])])
      if (!g.assets.has(f)) problems.push(`release_graph_missing: vite manifest ${key} → ${f}`);
    const from = c.isEntry ? g.html.path : c.file;
    if (c.isEntry) add(g.html.path, c.file);
    for (const f of [...(c.css ?? []), ...(c.assets ?? [])]) add(c.isEntry ? c.file : from, f);
    for (const k of [...(c.imports ?? []), ...(c.dynamicImports ?? [])]) {
      const f = fileOf(k);
      if (f) add(c.file, f);
      else problems.push(`release_graph_missing: vite manifest ${key} imports ${k}`);
    }
  }
  const roots: [string, string] = [g.html.path, g.webmanifest.path];
  const reach = new Set<string>(roots);
  const queue = [...roots];
  while (queue.length) {
    const n = queue.shift() as string;
    for (const m of edges.get(n) ?? [])
      if (!reach.has(m)) {
        reach.add(m);
        queue.push(m);
      }
  }
  for (const p of g.assets.keys()) if (!reach.has(p)) problems.push(`release_graph_orphan: ${p}`);
  const entries = Object.values(g.viteManifest)
    .filter((c) => c.isEntry)
    .map((c) => c.file);
  if (entries.length !== 1) problems.push(`release_entry: ${entries.length} entries`);
  const roles = new Map<string, AssetRole>();
  const workers = new Set<string>();
  for (const [p, bytes] of g.assets)
    if (p.endsWith(".js"))
      for (const m of decoder.decode(bytes).matchAll(/new Worker\(new URL\(["'`]([^"'`]+)["'`]/g)) {
        const to = names.get((m[1] as string).split("/").pop() as string);
        if (to) workers.add(to);
      }
  for (const p of g.assets.keys()) roles.set(p, roleOf(p, entries.includes(p), workers.has(p)));
  if (!workers.size) problems.push("release_worker: no `new Worker(new URL(…))` target found");
  const flat: [string, string][] = [];
  for (const [a, s] of [...edges].sort(([x], [y]) => cmp(x, y)))
    for (const b of [...s].sort(cmp)) flat.push([a, b]);
  return { roots, edges: flat, roles, problems };
}

function roleOf(p: string, entry: boolean, worker: boolean): AssetRole {
  if (entry) return "entry";
  if (worker) return "worker";
  if (p.endsWith(".js")) return "chunk";
  if (p.endsWith(".css")) return "css";
  if (/\.woff2?$/.test(p)) return "font";
  if (/\.(png|svg|webp|ico)$/.test(p)) return "icon";
  return "static";
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function sortedAssets(
  assets: ReadonlyMap<string, Uint8Array>,
  roles: Map<string, AssetRole>,
  sha256: (b: Uint8Array) => string,
): Asset[] {
  return [...assets.keys()].sort(cmp).map((path) => {
    const bytes = assets.get(path) as Uint8Array;
    return {
      path,
      sha256: sha256(bytes),
      size: bytes.byteLength,
      role: roles.get(path) ?? "static",
    };
  });
}
