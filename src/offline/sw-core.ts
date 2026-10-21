/**
 * kenli F-007 T02: the pure parts of the release service worker (offline.md §2.5–2.7, §7.1), kept
 * apart from `sw.ts` so they are unit-tested without a service-worker global.
 */

import { contentTypeOf, type FileRef, type SwRelease } from "./descriptor";

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

/** A header's media type equals the release's type for this path (parameters such as charset ignored). */
export function typeMatches(header: string | null, path: string): boolean {
  const want = contentTypeOf(path);
  const essence = (t: string) => t.split(";")[0]?.trim().toLowerCase() ?? "";
  return !!want && !!header && essence(header) === essence(want);
}

export type Problem = "absent" | "type" | "hash";
export interface Inspected {
  readonly release_id: string;
  readonly complete: boolean;
  readonly missing: readonly string[];
  readonly problems?: readonly { readonly path: string; readonly reason: Problem }[];
}
export interface RepairResult {
  readonly release_id: string;
  readonly complete: boolean;
  /** Files fetched again, checked and stored. */
  readonly repaired: readonly string[];
  /** Files still not restored, with the reason (http status, hash, type, network, quota…). */
  readonly failed: readonly { readonly path: string; readonly error: string }[];
  /** `release_mismatch` when the request named another release (nothing was done). */
  readonly error?: string;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
/**
 * The recovery document (offline.md §2.6 exception, R03-01): served with 503 for an app navigation
 * when this release's HTML or a file it loads directly is not in the cache intact. Self-contained
 * (inline style and script, no app chunk, no game data, no other release): it can only ask THIS
 * worker to restore THIS release's files, then reload when they are complete.
 */
export function recoveryHtml(
  r: Pick<SwRelease, "release_id" | "base">,
  missing: readonly string[],
): string {
  const id = JSON.stringify(r.release_id);
  const base = JSON.stringify(r.base);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>SRD Table — restore app files</title>
<style>body{font:16px/1.5 system-ui,sans-serif;margin:0;padding:2rem;background:#1d3b2a;color:#f2ead3}main{max-width:36rem;margin:auto}button{font:inherit;padding:.6rem 1rem;border-radius:.4rem;border:0;background:#f2ead3;color:#1d3b2a}button[disabled]{opacity:.6}#status{white-space:pre-wrap}</style>
</head><body><main data-recovery="${esc(r.release_id)}">
<h1>Some app files of this version are missing</h1>
<p>Your characters, history and packs are kept on this device and are not touched here. This page only restores the files of the app version <code>${esc(r.release_id)}</code> from the server it was installed from (a connection is needed).</p>
<p>Missing or damaged: ${esc(String(missing.length))} file(s).</p>
<p><button id="restore" type="button">Restore the files of this version</button></p>
<p id="status" role="status"></p>
</main>
<script>
(function () {
  var id = ${id}, base = ${base};
  var button = document.getElementById("restore"), status = document.getElementById("status");
  function worker() {
    if (navigator.serviceWorker.controller) return Promise.resolve(navigator.serviceWorker.controller);
    return navigator.serviceWorker.getRegistration(base).then(function (r) { return r && r.active; });
  }
  button.addEventListener("click", function () {
    button.disabled = true;
    status.textContent = "Restoring…";
    worker().then(function (w) {
      if (!w) throw new Error("the app's offline worker is not active");
      return new Promise(function (resolve) {
        var ch = new MessageChannel();
        ch.port1.onmessage = function (e) { resolve(e.data); };
        w.postMessage({ proto: "srd-table.release/1", type: "repair", release_id: id }, [ch.port2]);
      });
    }).then(function (r) {
      if (r && r.release_id === id && r.complete) { status.textContent = "Restored. Reloading…"; location.reload(); return; }
      var why = r && r.error ? r.error : (r && r.failed || []).map(function (f) { return f.path + ": " + f.error; }).join("\\n");
      status.textContent = "Not restored yet (nothing else was changed):\\n" + why;
      button.disabled = false;
    }).catch(function (e) {
      status.textContent = "Not restored yet (nothing else was changed): " + e.message;
      button.disabled = false;
    });
  });
})();
</script>
</body></html>
`;
}

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
