/**
 * The import graph (kenli F-008 contract §5.3): from a URL (a library pointer or a transfer) or a
 * set of chosen files, every dependency to its exact bytes, checked and deduplicated, in memory.
 * Nothing is installed or written here. One problem anywhere stops the whole import (Q-01).
 *
 * A dependency is satisfied, in order, by: a pack served with the app or already installed (same
 * hash; same id and version with another hash is a conflict); a local record this installation
 * exported (`table/<installation>/<record>`, matched exactly); a chosen file with that identity
 * hash (never by name); its `href` for a URL import. Otherwise it's missing.
 */

import { contentSha, type PackRef, sha256Hex } from "@/lib/canonical";
import { Budget, checkUrl, fetchBounded, LIMITS, type Limits } from "./fetch";
import {
  checkEnvelope,
  type DependencyRef,
  depKey,
  type Envelope,
  ImportError,
  packOfEnvelope,
  recognize,
} from "./transfer";

export type Source =
  | { readonly url: string }
  | { readonly files: readonly { readonly name: string; readonly bytes: Uint8Array }[] };

export interface LocalCharacter {
  readonly recordId: string;
  readonly rev: number;
  /** Identity hash of the record's export now (the same function that exported it). */
  readonly sha256: string;
}

export interface Environment {
  /** Installed packs (the `packs` store). */
  readonly installed: readonly PackRef[];
  /** Packs served with the app (the SRD), with their exact hash. */
  readonly served: readonly PackRef[];
  /** This installation's id, and its records by id, for local exports (§5.3 a′). */
  readonly installation: string | null;
  readonly localCharacter: (recordId: string) => Promise<LocalCharacter | null>;
  readonly signal: AbortSignal;
  readonly fetch?: typeof fetch;
  readonly limits?: Partial<Limits>;
}

export interface GraphNode {
  readonly key: string;
  readonly envelope: Envelope;
  readonly bytes_sha256: string | null;
  readonly source: { readonly url: string } | { readonly file: string };
}

/** A party character satisfied by a record of this installation. */
export interface LocalMatch {
  readonly key: string;
  readonly ref: DependencyRef;
  readonly recordId: string;
  readonly rev: number;
  /** The record changed since it was exported (another `sha256` now). */
  readonly changed: boolean;
}

export type Graph =
  | {
      readonly kind: "transfer";
      readonly root: GraphNode;
      /** Deps first, the root last; each node once. */
      readonly nodes: readonly GraphNode[];
      readonly satisfied: readonly { readonly ref: PackRef; readonly by: "served" | "installed" }[];
      readonly local: readonly LocalMatch[];
      readonly spent: { readonly resources: number; readonly bytes: number };
    }
  | {
      readonly kind: "raw";
      readonly files: readonly { readonly name: string; readonly value: unknown }[];
    };

const LOCAL_ID = /^table\/([^/]+)\/(.+)$/;

export async function resolveGraph(source: Source, env: Environment): Promise<Graph> {
  const limits: Limits = { ...LIMITS, ...env.limits };
  const budget = new Budget(env.signal, limits);
  const pool = new Map<string, { envelope: Envelope; name: string }>();
  const nodes = new Map<string, GraphNode>();
  const order: GraphNode[] = [];
  const satisfied = new Map<string, { ref: PackRef; by: "served" | "installed" }>();
  const local = new Map<string, LocalMatch>();
  const graphPacks: PackRef[] = [];

  const conflictWith = (ref: PackRef) => {
    for (const p of [...env.installed, ...graphPacks])
      if (p.id === ref.id && p.version === ref.version && p.sha256 !== ref.sha256)
        throw new ImportError("pack_identity_conflict", `${ref.id}@${ref.version ?? ""}`);
  };

  const get = async (href: string, base: URL | null, bytesSha: string | null) => {
    if (env.signal.aborted) throw new ImportError("cancelled");
    const url = base ? checkUrl(href, base) : checkUrl(href);
    const fetched = await fetchBounded(url, budget, env.fetch ?? fetch);
    if (bytesSha !== null && (await sha256Hex(fetched.bytes)) !== bytesSha)
      throw new ImportError("bytes_mismatch", url.href);
    return { ...fetched, recognized: recognize(fetched.bytes, fetched.contentType) };
  };

  const visit = async (node: GraphNode, url: URL | null, stack: string[]): Promise<void> => {
    if (stack.length > limits.depth) throw new ImportError("limit_depth", String(limits.depth));
    if (stack.includes(node.key))
      throw new ImportError("dependency_cycle", [...stack, node.key].join(" → "));
    if (nodes.has(node.key)) return;
    const env0 = node.envelope;
    await checkEnvelope(env0);
    if (env0.kind === "pack") {
      const ref = packOfEnvelope(env0);
      conflictWith(ref);
      graphPacks.push(ref);
    }
    for (const dep of env0.requires) {
      const key = depKey(dep);
      if (nodes.has(key) || satisfied.has(key) || local.has(key)) continue;
      if (stack.includes(key) || key === node.key)
        throw new ImportError("dependency_cycle", [...stack, node.key, key].join(" → "));
      if (dep.kind === "pack") {
        const ref = { id: dep.id, version: dep.version ?? null, sha256: dep.sha256 };
        const served = env.served.find((p) => p.sha256 === dep.sha256);
        if (served) {
          satisfied.set(key, { ref, by: "served" });
          continue;
        }
        if (env.installed.some((p) => p.sha256 === dep.sha256)) {
          satisfied.set(key, { ref, by: "installed" });
          continue;
        }
        conflictWith(ref);
      }
      let child: GraphNode | null = null;
      let childUrl: URL | null = null;
      if (dep.kind === "character" && env.installation) {
        const m = LOCAL_ID.exec(dep.id);
        if (m && m[1] === env.installation) {
          const record = await env.localCharacter(m[2] as string);
          if (record) {
            const changed = record.sha256 !== dep.sha256;
            const file = pool.get(dep.sha256);
            if (!changed || !file) {
              local.set(key, {
                key,
                ref: dep,
                recordId: record.recordId,
                rev: record.rev,
                changed,
              });
              continue;
            }
          }
        }
      }
      const file = pool.get(dep.sha256);
      if (file)
        child = { key, envelope: file.envelope, bytes_sha256: null, source: { file: file.name } };
      else if (dep.href !== null && url) {
        const got = await get(dep.href, url, dep.bytes_sha256);
        if (got.recognized.kind !== "envelope")
          throw new ImportError("dependency_not_envelope", dep.href);
        child = {
          key,
          envelope: got.recognized.value,
          bytes_sha256: dep.bytes_sha256,
          source: { url: got.url.href },
        };
        childUrl = got.url;
      }
      if (!child) throw new ImportError("dependency_missing", key);
      const e = child.envelope;
      if (e.sha256 !== dep.sha256 || e.kind !== dep.kind || e.id !== dep.id)
        throw new ImportError("dependency_identity_mismatch", key);
      await visit(child, childUrl, [...stack, node.key]);
    }
    nodes.set(node.key, node);
    order.push(node);
  };

  let root: GraphNode;
  let rootUrl: URL | null = null;
  if ("files" in source) {
    const raw: { name: string; value: unknown }[] = [];
    const envelopes: { name: string; envelope: Envelope; bytes: string }[] = [];
    for (const f of source.files) {
      budget.resource();
      if (f.bytes.byteLength > limits.resourceBytes)
        throw new ImportError("limit_resource_bytes", f.name);
      budget.add(f.bytes.byteLength);
      const r = recognize(f.bytes);
      if (r.kind === "pointer") throw new ImportError("pointer_needs_url", f.name);
      if (r.kind === "raw") raw.push({ name: f.name, value: r.value });
      else envelopes.push({ name: f.name, envelope: r.value, bytes: await sha256Hex(f.bytes) });
    }
    if (raw.length && envelopes.length) throw new ImportError("mixed_selection");
    if (raw.length) return { kind: "raw", files: raw };
    for (const e of envelopes) pool.set(e.envelope.sha256, { envelope: e.envelope, name: e.name });
    // The root: the chosen file no other chosen file depends on (an encounter before its party).
    const needed = new Set(envelopes.flatMap((e) => e.envelope.requires.map((d) => d.sha256)));
    const roots = envelopes.filter((e) => !needed.has(e.envelope.sha256));
    const first = (roots.length === 1 ? roots[0] : envelopes[0]) as (typeof envelopes)[number];
    if (roots.length > 1)
      throw new ImportError("several_roots", roots.map((r) => r.name).join(", "));
    root = {
      key: depKey({
        ...first.envelope,
        version: first.envelope.kind === "pack" ? packOfEnvelope(first.envelope).version : null,
      }),
      envelope: first.envelope,
      bytes_sha256: first.bytes,
      source: { file: first.name },
    };
  } else {
    let got = await get(source.url, null, null);
    if (got.recognized.kind === "pointer") {
      const cur = got.recognized.value.current;
      got = await get(cur.href, got.url, cur.bytes_sha256);
    }
    if (got.recognized.kind !== "envelope")
      throw new ImportError("format_unknown", "a raw document needs a file import");
    const e = got.recognized.value;
    root = {
      key: depKey({ ...e, version: e.kind === "pack" ? packOfEnvelope(e).version : null }),
      envelope: e,
      bytes_sha256: await sha256Hex(got.bytes),
      source: { url: got.url.href },
    };
    rootUrl = got.url;
  }
  if (root.envelope.sha256 !== (await contentSha(root.envelope.content)))
    throw new ImportError("hash_mismatch", root.envelope.id);
  await visit(root, rootUrl, []);
  return {
    kind: "transfer",
    root,
    nodes: order,
    satisfied: [...satisfied.values()],
    local: [...local.values()],
    spent: budget.spent,
  };
}
