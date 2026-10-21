/**
 * kenli F-007 — update boot gate, MINIMAL T04 STUB (contract offline.md §5.1.5, §2.7.6, §7.5).
 *
 * This file belongs to T05, which replaces it with the full updater (offer, consent, gates, the
 * owner lock, the barrier and its recovery, the only `register()` of another release and the only
 * `activate`). Until then the app must not open a game in an incoherent state, so the stub only
 * observes and FAILS CLOSED; it never registers, activates, claims, writes or clears anything:
 *
 *  - a release installing for this base → `waiting` (no game);
 *  - another release active than the one this page executes (also an unknown script) → one full
 *    `reload` (sessionStorage guard), then `read_only`;
 *  - a controller of another release than this page's → the same;
 *  - a waiting release, or a barrier in `offline.update.v1` → `read_only` (only T05 completes or
 *    clears them);
 *  - otherwise `open`.
 *
 * It runs BEFORE any game-data write (`boot.ts`: before `loadAll` and its migrations, the
 * installation id, `persistBundled` and the autosave). Hand-off: T05 keeps the signature
 * `updateBootGate(): Promise<"open" | "waiting" | "reload" | "read_only">` and `observeRelease()`.
 */

import { db } from "@/persistence/db";
import { BASE, RELEASE_ID, releaseOfScriptUrl } from "./release";

export const UPDATE_KEY = "offline.update.v1";

export interface Observed {
  /** The release this page executes. */
  readonly exec: string;
  readonly active: string | null;
  readonly waiting: string | null;
  readonly installing: string | null;
  readonly controller: string | null;
}

export type BootDecision = "open" | "waiting" | "reload" | "read_only";

/** The release of a worker (`unknown` for a script that isn't `sw-<id>.js` under the base). */
const releaseOf = (w: ServiceWorker | null | undefined, base: string) =>
  w ? (releaseOfScriptUrl(w.scriptURL, base) ?? "unknown") : null;

export async function observeRelease(
  o: {
    readonly container?: ServiceWorkerContainer;
    readonly base?: string;
    readonly exec?: string;
  } = {},
): Promise<Observed> {
  const base = o.base ?? BASE;
  const exec = o.exec ?? RELEASE_ID;
  const sw =
    o.container ?? (typeof navigator !== "undefined" ? navigator.serviceWorker : undefined);
  const reg = sw ? await sw.getRegistration(base) : undefined;
  return {
    exec,
    active: releaseOf(reg?.active, base),
    waiting: releaseOf(reg?.waiting, base),
    installing: releaseOf(reg?.installing, base),
    controller: releaseOf(sw?.controller, base),
  };
}

/** The stub's decision (pure): see the file comment. `reloaded`: this page already reloaded once. */
export function decideBoot(o: Observed, barrier: boolean, reloaded: boolean): BootDecision {
  if (o.installing) return "waiting";
  const otherActive = o.active !== null && o.active !== o.exec;
  const otherController = o.controller !== null && o.controller !== o.exec;
  if (otherActive || otherController) return reloaded ? "read_only" : "reload";
  if (o.waiting) return "read_only";
  if (barrier) return "read_only";
  return "open";
}

const RELOAD_FLAG = "srd-table:boot-reload";

/** Whether `offline.update.v1` holds a barrier (read only; an unreadable state counts as none). */
async function hasBarrier(): Promise<boolean> {
  const raw = (await (await db()).get("settings", UPDATE_KEY)) as { barrier?: unknown } | undefined;
  return !!raw && typeof raw === "object" && raw.barrier !== null && raw.barrier !== undefined;
}

/** The boot gate (T04 stub of the T05 API): runs before any game-data write. */
export async function updateBootGate(
  o: {
    readonly observe?: () => Promise<Observed>;
    readonly barrier?: () => Promise<boolean>;
    readonly session?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  } = {},
): Promise<BootDecision> {
  const session = o.session ?? (typeof sessionStorage !== "undefined" ? sessionStorage : undefined);
  const observed = await (o.observe ?? observeRelease)();
  const flag = `${RELOAD_FLAG}:${observed.exec}`;
  const decision = decideBoot(
    observed,
    await (o.barrier ?? hasBarrier)(),
    session?.getItem(flag) === "1",
  );
  if (decision === "reload") session?.setItem(flag, "1");
  else if (decision === "open") session?.removeItem(flag);
  return decision;
}
