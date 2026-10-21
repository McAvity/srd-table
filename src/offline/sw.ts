/**
 * kenli F-007 T02: the service worker of ONE release (offline.md §2.5–2.7, §7.1). Built by
 * scripts/release.ts into `sw-<release_id>.js` with this release's precache list prepended
 * (`self.__F007_RELEASE__`); immutable once published. It never registers or activates another
 * release by itself: no skipWaiting on install, no clients.claim, no deletion of other caches.
 */

import type { SwRelease } from "./descriptor";
import {
  BROADCAST_TYPES,
  bytesMatch,
  cacheNameOf,
  completeKeyOf,
  inBase,
  RELEASE_PROTO,
  routeOf,
  stamp,
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

async function verified(
  cache: Cache,
  path: string,
  f: SwRelease["files"][number],
): Promise<boolean> {
  const hit = await cache.match(url(path));
  return !!hit && (await bytesMatch(await hit.arrayBuffer(), f));
}

/** Every listed byte checked (kept if already right, else fetched and checked), the marker last. */
async function install(): Promise<void> {
  const cache = await caches.open(CACHE);
  for (const f of R.files) {
    if (await verified(cache, f.path, f)) continue;
    const res = await fetch(url(f.path), { cache: "no-store", credentials: "same-origin" });
    if (!res.ok) throw new Error(`release_asset_http ${f.path} ${res.status}`);
    const bytes = await res.arrayBuffer();
    if (!(await bytesMatch(bytes, f))) throw new Error(`release_asset_hash ${f.path}`);
    await cache.put(
      url(f.path),
      new Response(bytes, { headers: { "content-type": res.headers.get("content-type") ?? "" } }),
    );
  }
  await cache.put(
    completeKeyOf(R),
    new Response(JSON.stringify({ release_id: R.release_id, files: R.files.length }), {
      headers: { "content-type": "application/json" },
    }),
  );
}

/** Present and byte-exact now (never trusts the marker alone). */
async function inspect(): Promise<{ release_id: string; complete: boolean; missing: string[] }> {
  const cache = await caches.open(CACHE);
  const missing: string[] = [];
  for (const f of R.files) if (!(await verified(cache, f.path, f))) missing.push(f.path);
  const marker = !!(await cache.match(completeKeyOf(R)));
  return { release_id: R.release_id, complete: marker && missing.length === 0, missing };
}

self.addEventListener("install", (event) => event.waitUntil(install()));
self.addEventListener("activate", () => {
  // Nothing: no claim, no cleanup of other releases' caches (offline.md §2.7).
});

self.addEventListener("fetch", (event) => {
  const route = routeOf(event.request, self.location.origin, R);
  if (route.kind === "network") return;
  const path = route.kind === "html" ? R.html : route.path;
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
