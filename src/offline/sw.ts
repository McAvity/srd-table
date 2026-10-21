/**
 * kenli F-007 T02: the service worker of ONE release (offline.md §2.5–2.7, §7.1). Built by
 * scripts/release.ts into `sw-<release_id>.js` with this release's precache list prepended
 * (`self.__F007_RELEASE__`); immutable once published. It never registers or activates another
 * release by itself: no skipWaiting on install, no clients.claim, no deletion of other caches.
 */

import { contentTypeOf, type SwRelease } from "./descriptor";
import {
  BROADCAST_TYPES,
  bytesMatch,
  cacheNameOf,
  completeKeyOf,
  describeError,
  failureCacheOf,
  failureKeyOf,
  type Inspected,
  inBase,
  type Problem,
  RELEASE_PROTO,
  type RepairResult,
  recoveryHtml,
  routeOf,
  stamp,
  typeMatches,
  UPDATE_PROTO,
} from "./sw-core";

// The app's tsconfig has the DOM lib, not the WebWorker one (they conflict): the few SW globals used here.
interface ExtendableEvent extends Event {
  waitUntil(p: Promise<unknown>): void;
}
interface FetchEvent extends ExtendableEvent {
  readonly request: Request;
  respondWith(r: Response | Promise<Response>): void;
}
interface WindowClient {
  readonly id: string;
  readonly url: string;
  postMessage(m: unknown): void;
}
interface ExtendableMessageEvent extends ExtendableEvent {
  readonly data: unknown;
  readonly source: WindowClient | null;
  readonly ports: readonly MessagePort[];
}
interface SwScope {
  readonly __F007_RELEASE__: SwRelease;
  readonly location: Location;
  readonly clients: {
    matchAll(o: { type: "window"; includeUncontrolled: boolean }): Promise<WindowClient[]>;
    get(id: string): Promise<WindowClient | undefined>;
  };
  skipWaiting(): Promise<void>;
  addEventListener(type: "install" | "activate", f: (e: ExtendableEvent) => void): void;
  addEventListener(type: "fetch", f: (e: FetchEvent) => void): void;
  addEventListener(type: "message", f: (e: ExtendableMessageEvent) => void): void;
}
const self = globalThis as unknown as SwScope;
const R = self.__F007_RELEASE__;
const CACHE = cacheNameOf(R);
const url = (path: string) => `${R.base}${path}`;

/** A cached file is verified only with its release type AND its exact bytes (R03-03). */
async function problemOf(cache: Cache, f: SwRelease["files"][number]): Promise<Problem | null> {
  const hit = await cache.match(url(f.path));
  if (!hit) return "absent";
  if (!typeMatches(hit.headers.get("content-type"), f.path)) return "type";
  return (await bytesMatch(await hit.arrayBuffer(), f)) ? null : "hash";
}

/**
 * This release's own file from the network, checked (status, size, SHA-256) and returned with the
 * release's content type for its kind: the bytes are ours, so a host's wrong header can't make an
 * unusable but "complete" copy. Never anything but a path of this release's list.
 */
async function fetchVerified(f: SwRelease["files"][number]): Promise<Response> {
  const type = contentTypeOf(f.path);
  if (!type) throw new Error(`release_asset_type ${f.path}`);
  const res = await fetch(url(f.path), { cache: "no-store", credentials: "same-origin" });
  if (!res.ok) throw new Error(`release_asset_http ${f.path} ${res.status}`);
  const bytes = await res.arrayBuffer();
  if (!(await bytesMatch(bytes, f))) throw new Error(`release_asset_hash ${f.path}`);
  return new Response(bytes, { headers: { "content-type": type } });
}

const marker = () =>
  new Response(JSON.stringify({ release_id: R.release_id, files: R.files.length }), {
    headers: { "content-type": "application/json" },
  });

/** Every listed file checked (kept if already right, else fetched and checked), the marker last. */
async function install(): Promise<void> {
  const cache = await caches.open(CACHE);
  for (const f of R.files) {
    if ((await problemOf(cache, f)) === null) continue;
    await cache.put(url(f.path), await fetchVerified(f));
  }
  await cache.put(completeKeyOf(R), marker());
}

/** Present, typed and byte-exact now (never trusts the marker alone). */
async function inspect(): Promise<Inspected> {
  const cache = await caches.open(CACHE);
  const problems: { path: string; reason: Problem }[] = [];
  for (const f of R.files) {
    const p = await problemOf(cache, f);
    if (p) problems.push({ path: f.path, reason: p });
  }
  const done = !!(await cache.match(completeKeyOf(R)));
  return {
    release_id: R.release_id,
    complete: done && problems.length === 0,
    missing: problems.map((p) => p.path),
    problems,
  };
}

/**
 * Restore THIS release in place (R03-01): only the files of its own embedded list, fetched and
 * checked like an install; good files are kept, a file that can't be restored stays missing with
 * its reason, the marker is written only when every file is intact. No registration change, no
 * activation, no other release, no latest pointer, no game data.
 */
let repairing: Promise<RepairResult> | null = null;
async function repair(): Promise<RepairResult> {
  const cache = await caches.open(CACHE);
  const bad: SwRelease["files"][number][] = [];
  for (const f of R.files) if ((await problemOf(cache, f)) !== null) bad.push(f);
  const repaired: string[] = [];
  const failed: { path: string; error: string }[] = [];
  if (bad.length) await cache.delete(completeKeyOf(R));
  for (const f of bad) {
    try {
      await cache.put(url(f.path), await fetchVerified(f));
      repaired.push(f.path);
    } catch (e) {
      failed.push({ path: f.path, error: describeError(e) });
    }
  }
  if (failed.length === 0) await cache.put(completeKeyOf(R), marker());
  return { release_id: R.release_id, complete: failed.length === 0, repaired, failed };
}

/** The app's HTML when it and everything it loads directly are intact; else the recovery document. */
async function navigation(): Promise<Response> {
  const cache = await caches.open(CACHE);
  const missing: string[] = [];
  for (const path of R.critical) {
    const f = R.files.find((x) => x.path === path);
    if (!f || (await problemOf(cache, f)) !== null) missing.push(path);
  }
  const html = missing.length === 0 ? await cache.match(url(R.html)) : undefined;
  return (
    html ??
    new Response(recoveryHtml(R, missing), {
      status: 503,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    })
  );
}

/**
 * A failed install is never "ready": its incomplete cache is dropped (own staging only, §2.5) and
 * the reason is kept in a separate small cache for the preparation UI (T04), then the install fails.
 */
async function failed(e: unknown): Promise<never> {
  try {
    await caches.delete(CACHE);
    const c = await caches.open(failureCacheOf(R));
    await c.put(
      failureKeyOf(R),
      new Response(JSON.stringify({ release_id: R.release_id, error: describeError(e) }), {
        headers: { "content-type": "application/json" },
      }),
    );
  } catch {
    // the diagnosis is best effort; the failure itself is what matters
  }
  throw e;
}

self.addEventListener("install", (event) =>
  event.waitUntil(caches.delete(failureCacheOf(R)).then(install).catch(failed)),
);
self.addEventListener("activate", () => {
  // Nothing: no claim, no cleanup of other releases' caches (offline.md §2.7).
});

self.addEventListener("fetch", (event) => {
  const route = routeOf(event.request, self.location.origin, R);
  if (route.kind === "network") return;
  if (route.kind === "html") {
    event.respondWith(navigation());
    return;
  }
  const path = route.path;
  event.respondWith(
    caches
      .open(CACHE)
      .then((c) => c.match(url(path)))
      .then(
        (hit) =>
          hit ??
          new Response(`release_incomplete ${R.release_id} ${path}`, {
            status: 503,
            headers: { "content-type": "text/plain" },
          }),
      ),
  );
});

const windows = () => self.clients.matchAll({ type: "window", includeUncontrolled: true });

self.addEventListener("message", (event) => {
  const src = event.source;
  const m = event.data as {
    proto?: string;
    type?: string;
    target_release?: string;
    to?: string | null;
  } | null;
  if (!src || !m || !("url" in src) || !inBase(src.url, R.base)) return;
  if (m.proto === RELEASE_PROTO && m.type === "inspect" && event.ports[0]) {
    const port = event.ports[0];
    event.waitUntil(inspect().then((r) => port.postMessage(r)));
    return;
  }
  if (m.proto === RELEASE_PROTO && m.type === "repair" && event.ports[0]) {
    const port = event.ports[0];
    const expected = (m as { release_id?: unknown }).release_id;
    if (expected !== R.release_id) {
      port.postMessage({
        release_id: R.release_id,
        complete: false,
        repaired: [],
        failed: [],
        error: "release_mismatch",
      });
      return;
    }
    repairing ??= repair().finally(() => {
      repairing = null;
    });
    event.waitUntil(
      repairing.then(
        (r) => port.postMessage(r),
        (e) =>
          port.postMessage({
            release_id: R.release_id,
            complete: false,
            repaired: [],
            failed: [{ path: "", error: describeError(e) }],
          }),
      ),
    );
    return;
  }
  if (m.proto !== UPDATE_PROTO) return;
  // Activation only on the coordinator's explicit message for THIS release (offline.md §7.2.8).
  if (m.type === "activate") {
    if (m.target_release === R.release_id) event.waitUntil(self.skipWaiting());
    return;
  }
  const stamped = stamp(m, { id: src.id, url: src.url }, R.base);
  if (!stamped) return;
  event.waitUntil(
    (async () => {
      if (m.type === "hello")
        return src.postMessage({
          proto: UPDATE_PROTO,
          type: "welcome",
          client_id: src.id,
          release_id: R.release_id,
        });
      if (m.type === "clients") {
        const all = (await windows()).filter((c) => inBase(c.url, R.base));
        return src.postMessage({
          proto: UPDATE_PROTO,
          type: "clients",
          request_id: stamped.request_id,
          clients: all.map((c) => ({ client_id: c.id, path: new URL(c.url).pathname })),
        });
      }
      if (typeof m.to === "string") {
        const c = await self.clients.get(m.to);
        if (c && inBase(c.url, R.base)) c.postMessage(stamped);
        return;
      }
      if (BROADCAST_TYPES.has(stamped.type))
        for (const c of await windows()) if (inBase(c.url, R.base)) c.postMessage(stamped);
    })(),
  );
});
