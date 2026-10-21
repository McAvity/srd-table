/**
 * kenli F-007 T02: the pure parts of the release service worker (offline.md §2.5–2.7, §7.1), kept
 * apart from `sw.ts` so they are unit-tested without a service-worker global.
 */

import type { FileRef, SwRelease } from "./descriptor";

export const UPDATE_PROTO = "srd-table.update/1";
export const RELEASE_PROTO = "srd-table.release/1";

export const cacheNameOf = (r: Pick<SwRelease, "base" | "release_id">) =>
  `srd-table:${r.base}:${r.release_id}`;
/** Written last, after every byte of the release was checked. */
export const completeKeyOf = (r: Pick<SwRelease, "base" | "release_id">) =>
  `${r.base}__release/${r.release_id}/complete`;

/** A failed install's reason, in its own small cache (the incomplete release cache is dropped). */
export const failureCacheOf = (r: Pick<SwRelease, "base" | "release_id">) =>
  `srd-table:${r.base}:${r.release_id}:install-failed`;
export const failureKeyOf = (r: Pick<SwRelease, "base" | "release_id">) =>
  `${r.base}__release/${r.release_id}/install-failed`;
export interface InstallFailure {
  readonly release_id: string;
  /** `release_asset_http <path> <status>`, `release_asset_hash <path>`, or the error's name and message. */
  readonly error: string;
}
export const describeError = (e: unknown): string =>
  e instanceof Error
    ? e.message.startsWith("release_asset_")
      ? e.message
      : `${e.name}: ${e.message}`
    : String(e);

export const inBase = (url: string, base: string): boolean => {
  try {
    return new URL(url).pathname.startsWith(base);
  } catch {
    return false;
  }
};

export type Route =
  | { readonly kind: "html" }
  | { readonly kind: "asset"; readonly path: string }
  | { readonly kind: "network" };

/**
 * What the SW does with a request. Only this origin, under the base: an app navigation (the base
 * or `index.html`) gets this release's HTML, a file of this release's precache list gets its
 * cached bytes; everything else (pointer, descriptors, library, content, transfers, other routes,
 * other origins) goes to the network untouched — no SPA or stale fallback.
 */
export function routeOf(
  req: { readonly url: string; readonly mode: string },
  scopeOrigin: string,
  r: SwRelease,
): Route {
  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    return { kind: "network" };
  }
  if (url.origin !== scopeOrigin || !url.pathname.startsWith(r.base)) return { kind: "network" };
  const rel = url.pathname.slice(r.base.length);
  if (req.mode === "navigate")
    return rel === "" || rel === "index.html" ? { kind: "html" } : { kind: "network" };
  return r.files.some((f) => f.path === rel) ? { kind: "asset", path: rel } : { kind: "network" };
}

export const toHex = (buf: ArrayBuffer): string =>
  Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");

/** The exact bytes a release lists (size and SHA-256), with any WebCrypto. */
export async function bytesMatch(
  bytes: ArrayBuffer,
  f: Pick<FileRef, "sha256" | "size">,
  subtle: SubtleCrypto = crypto.subtle,
): Promise<boolean> {
  return bytes.byteLength === f.size && toHex(await subtle.digest("SHA-256", bytes)) === f.sha256;
}

export interface Source {
  readonly id: string;
  readonly url: string;
}
export interface UpdateMessage {
  readonly proto: typeof UPDATE_PROTO;
  readonly type: string;
  readonly request_id?: string;
  readonly to?: string | null;
  readonly target_release?: string;
  readonly [key: string]: unknown;
}

/**
 * The relay's stamp (offline.md §7.1): the SW, not the page, says who sent a protocol message.
 * `null` when it is not a protocol message or comes from outside the base.
 */
export function stamp(
  m: unknown,
  src: Source | null,
  base: string,
): (UpdateMessage & { source_client_id: string; source_url: string }) | null {
  if (!src || !m || typeof m !== "object") return null;
  const msg = m as Partial<UpdateMessage>;
  if (msg.proto !== UPDATE_PROTO || typeof msg.type !== "string") return null;
  if (!inBase(src.url, base)) return null;
  return {
    ...(msg as UpdateMessage),
    source_client_id: src.id,
    source_url: new URL(src.url).pathname,
  };
}

export const BROADCAST_TYPES: ReadonlySet<string> = new Set(["freeze", "thaw", "transition"]);
