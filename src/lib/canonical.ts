/**
 * Canonical JSON and SHA-256 for content identities (kenli F-008 transfer contract §3): object keys
 * sorted by UTF-16 code units, no whitespace, ECMAScript number and string forms. Runs on the main
 * thread and in the worker (Web Crypto).
 */

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value, "$"));
}

function sortKeys(value: unknown, path: string): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`canonical JSON: a non-finite number at ${path}`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map((v, i) => sortKeys(v, `${path}[${i}]`));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as object).sort()) {
      const v = (value as Record<string, unknown>)[k];
      if (v === undefined) continue;
      Object.defineProperty(out, k, {
        value: sortKeys(v, `${path}.${k}`),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  }
  throw new Error(`canonical JSON: unsupported ${typeof value} at ${path}`);
}

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Identity hash of a JSON value: SHA-256 of its canonical JSON. */
export const contentSha = (value: unknown) => sha256Hex(canonicalJson(value));

/** A pack's exact content: id, version and the hash of its split files (`{ files }`). */
export interface PackRef {
  readonly id: string;
  readonly version: string | null;
  readonly sha256: string;
}

/** The content a document is played with: packs in load order (the SRD first), allowed sources. */
export interface ContentContext {
  readonly packs: readonly PackRef[];
  readonly sources: readonly string[] | null;
}

/** A stable key for a context (query keys, the worker's catalogs): its canonical JSON. */
export function contextKey(content: ContentContext): string {
  return canonicalJson({
    packs: content.packs.map((p) => ({ id: p.id, version: p.version, sha256: p.sha256 })),
    sources: content.sources === null ? null : [...new Set(content.sources)].sort(),
  });
}

/** Split pack files (`manifest.json` and the files it lists) as one object, by file name. */
export type PackFiles = Readonly<Record<string, unknown>>;

export async function packRefOf(files: PackFiles): Promise<PackRef> {
  const manifest = (files["manifest.json"] as { manifest?: { id?: unknown; version?: unknown } })
    ?.manifest;
  if (typeof manifest?.id !== "string") throw new Error("pack_manifest_missing");
  return {
    id: manifest.id,
    version: typeof manifest.version === "string" ? manifest.version : null,
    sha256: await contentSha({ files }),
  };
}
