/**
 * kenli F-007 T02: the release this page runs, its explicit registration and its inspection
 * (offline.md §2.5, §2.7, §8). Frozen API for T04/T05. Nothing here runs by itself: the app does
 * not register a service worker until T04's explicit "Prepare offline" calls
 * `registerCurrentRelease()`, and this module never registers another release (T05's job, after
 * consent and gates).
 */

import {
  descriptorPathOf,
  RELEASE_ID as RELEASE_ID_PATTERN,
  type ReleaseDescriptor,
  swPathOf,
} from "./descriptor";
import { RELEASE_PROTO } from "./sw-core";

/** The release of the code running in this page (`r-dev` outside a release build). */
export const RELEASE_ID: string = __RELEASE_ID__;
/** The base the app is served under (`/dnd/` in the deployment). */
export const BASE: string = import.meta.env.BASE_URL;

export class ReleaseError extends Error {
  constructor(
    readonly code:
      | "release_dev_build"
      | "sw_unsupported"
      | "release_other_registered"
      | "release_install_failed"
      | "descriptor_unavailable",
    readonly detail = "",
  ) {
    super(`${code}${detail ? `: ${detail}` : ""}`);
    this.name = "ReleaseError";
  }
}

export interface Inspection {
  readonly release_id: string;
  readonly complete: boolean;
  readonly missing: readonly string[];
}

export interface ReleaseOptions {
  readonly container?: ServiceWorkerContainer;
  readonly releaseId?: string;
  readonly base?: string;
}

export const isReleaseBuild = (id: string = RELEASE_ID): boolean => RELEASE_ID_PATTERN.test(id);

/** The release of a registered worker's script URL (`sw-<id>.js` directly under the base), else null. */
export function releaseOfScriptUrl(
  scriptUrl: string | null | undefined,
  base: string = BASE,
): string | null {
  if (!scriptUrl) return null;
  let path: string;
  try {
    path = new URL(scriptUrl, "http://x").pathname;
  } catch {
    return null;
  }
  const m = new RegExp(
    `^${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}sw-(r-[0-9a-f]{16})\\.js$`,
  ).exec(path);
  return m?.[1] ?? null;
}

const containerOf = (o: ReleaseOptions) =>
  o.container ?? (typeof navigator !== "undefined" ? navigator.serviceWorker : undefined);

/**
 * Register THIS page's release (explicit preparation only) and wait until its worker is active.
 * Refused in a dev build, without service workers, or when another release is registered for the
 * base (its replacement is an update: consent and gates, T05).
 */
export async function registerCurrentRelease(
  o: ReleaseOptions = {},
): Promise<ServiceWorkerRegistration> {
  const id = o.releaseId ?? RELEASE_ID;
  const base = o.base ?? BASE;
  if (!isReleaseBuild(id)) throw new ReleaseError("release_dev_build", id);
  const sw = containerOf(o);
  if (!sw) throw new ReleaseError("sw_unsupported");
  const existing = await sw.getRegistration(base);
  for (const w of [existing?.active, existing?.waiting, existing?.installing]) {
    const other = w ? releaseOfScriptUrl(w.scriptURL, base) : null;
    if (w && other !== id) throw new ReleaseError("release_other_registered", other ?? w.scriptURL);
  }
  const reg = await sw.register(`${base}${swPathOf(id)}`, { scope: base, updateViaCache: "none" });
  await new Promise<void>((resolve, reject) => {
    const check = () => {
      if (
        reg.active &&
        releaseOfScriptUrl(reg.active.scriptURL, base) === id &&
        reg.active.state === "activated"
      ) {
        resolve();
        return true;
      }
      const w = reg.installing ?? reg.waiting ?? reg.active;
      if (!w || w.state === "redundant") {
        reject(new ReleaseError("release_install_failed", id));
        return true;
      }
      w.addEventListener("statechange", () => void check(), { once: true });
      return false;
    };
    check();
  });
  return reg;
}

/**
 * Ask the active worker which files of this release are present and byte-exact (it re-checks every
 * file, never only its marker). Not complete when no worker of this release is active.
 */
export async function inspectRelease(
  o: ReleaseOptions & { readonly timeoutMs?: number } = {},
): Promise<Inspection> {
  const id = o.releaseId ?? RELEASE_ID;
  const base = o.base ?? BASE;
  const sw = containerOf(o);
  const reg = sw ? await sw.getRegistration(base) : undefined;
  const active = reg?.active;
  if (!active || releaseOfScriptUrl(active.scriptURL, base) !== id)
    return { release_id: id, complete: false, missing: ["service_worker"] };
  const channel = new MessageChannel();
  return new Promise<Inspection>((resolve) => {
    const timer = setTimeout(() => {
      channel.port1.close();
      resolve({ release_id: id, complete: false, missing: ["service_worker_unresponsive"] });
    }, o.timeoutMs ?? 10_000);
    channel.port1.onmessage = (e: MessageEvent<Inspection>) => {
      clearTimeout(timer);
      channel.port1.close();
      const r = e.data;
      resolve(
        r && r.release_id === id
          ? r
          : { release_id: id, complete: false, missing: ["service_worker_mismatch"] },
      );
    };
    active.postMessage({ proto: RELEASE_PROTO, type: "inspect" }, [channel.port2]);
  });
}

/** This release's descriptor (immutable; from the network: descriptors are never precached, §2.6). */
export async function releaseDescriptor(
  o: { readonly releaseId?: string; readonly base?: string; readonly fetch?: typeof fetch } = {},
): Promise<ReleaseDescriptor> {
  const id = o.releaseId ?? RELEASE_ID;
  if (!isReleaseBuild(id)) throw new ReleaseError("release_dev_build", id);
  const res = await (o.fetch ?? fetch)(`${o.base ?? BASE}${descriptorPathOf(id)}`);
  if (!res.ok) throw new ReleaseError("descriptor_unavailable", String(res.status));
  const d = (await res.json()) as ReleaseDescriptor;
  if (d.release_id !== id) throw new ReleaseError("descriptor_unavailable", "another release");
  return d;
}
