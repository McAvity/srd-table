/**
 * kenli F-007 T05: controlled updates (contract offline.md §2.7, §6, §7). Replaces the T04 stub.
 *
 * A new release is only ever OFFERED: the pointer `release.json` is read online, its descriptor
 * checked (bytes hash, id from its inputs, data compatibility) and — on "Download" — its files
 * fetched, checked and stored in its own cache WITHOUT registering anything. "Later" is no consent
 * and survives every restart as just that. "Now" persists a consent for that one release, then the
 * owner of the update lock (`srd-table:<base>:update`, Web Locks: one owner per base) writes a
 * barrier, closes its own admission gate, asks every other client of the base (their `Client.id`
 * as the service worker stamps it, uncontrolled ones too) to freeze — each closes its gate, waits
 * for what already runs, flushes and answers whether everything is saved — waits at most 5 s,
 * checks the set of clients again, and only then registers the candidate's own `sw-<id>.js`,
 * sends `activate` to it, marks `transitioning`, sends `transition` and reloads. Any reason before
 * registration releases everything: the barrier goes, the clients thaw, play goes on on the
 * current release, the consent stays (a restart tries the gates again; "Later" withdraws it).
 *
 * Recovery is ONE rule (§7.5, `decideRecovery`): from what this page observes — the release it
 * executes and the base registration's active/waiting/installing workers, controlled or not — and
 * the stored state. It runs at every start BEFORE any game-data write (`boot.ts`) and whenever a
 * frozen page gets the lock: a coherent page (active none or this release, nothing waiting or
 * installing) may open or clear a barrier; any other page reloads, waits, completes the agreed
 * transition, or fails closed — never a mutation with old code next to a newer active release.
 * After `controllerchange` this page refuses every mutation until it reloads.
 */

import { create } from "zustand";
import { contentSha, sha256Hex } from "@/lib/canonical";
import { db } from "@/persistence/db";
import { writeQueue } from "@/persistence/sync";
import { admission, type Reason } from "./admission";
import {
  contentTypeOf,
  descriptorPathOf,
  RELEASE_ID as RELEASE_ID_PATTERN,
  type ReleaseDescriptor,
  swPathOf,
  swReleaseOf,
} from "./descriptor";
import { blockers, savedReasons } from "./gates";
import { BASE, isReleaseBuild, RELEASE_ID, releaseOfScriptUrl } from "./release";
import { bytesMatch, cacheNameOf, completeKeyOf, UPDATE_PROTO } from "./sw-core";

export const UPDATE_KEY = "offline.update.v1";
export const UPDATE_SCHEMA = "srd-table.update-state/1";
/** The data this release reads and writes (as its descriptor declares them, §2.2). */
export const OWN_DATA = {
  db_version: 4,
  history_schema: "kenli.history/1",
  history_meta_schema: "kenli.history-meta/1",
  transfer_formats: ["srd-table.transfer/1"],
  local_copy_formats: ["srd-table.local-copy/1"],
} as const;
const FREEZE_TIMEOUT_MS = 5_000;

export type Phase =
  | "idle"
  | "offered"
  | "downloaded"
  | "consented"
  | "gating"
  | "registering"
  | "installed"
  | "activating"
  | "transitioning";

export interface UpdateState {
  readonly schema: typeof UPDATE_SCHEMA;
  readonly base: string;
  readonly active_release: string;
  readonly phase: Phase;
  readonly candidate: {
    readonly release_id: string;
    readonly descriptor_sha256: string;
    readonly sw: string;
    readonly compatible: boolean;
  } | null;
  readonly consent: {
    readonly release_id: string;
    readonly at: number;
    readonly request_id: string;
  } | null;
  readonly deferred_at: number | null;
  readonly last_error: Reason | null;
  readonly barrier: {
    readonly request_id: string;
    readonly owner_client_id: string;
    readonly target_release: string;
    readonly since: number;
  } | null;
}

export interface Observed {
  /** The release this page executes. */
  readonly exec: string;
  readonly active: string | null;
  readonly waiting: string | null;
  readonly installing: string | null;
  readonly controller: string | null;
}

export type Recovery = "wait" | "reload" | "complete" | "fail_closed" | "clear" | "open";
export type BootDecision = "open" | "waiting" | "reload" | "read_only";

const lockName = (base: string) => `srd-table:${base}:update`;
const hex = (n: number) =>
  Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
const newRequestId = () => `u-${hex(8)}`;
const PAGE_ID = `w-${hex(6)}`;

export function emptyState(exec: string = RELEASE_ID, base: string = BASE): UpdateState {
  return {
    schema: UPDATE_SCHEMA,
    base,
    active_release: exec,
    phase: "idle",
    candidate: null,
    consent: null,
    deferred_at: null,
    last_error: null,
    barrier: null,
  };
}

/** A stored state when its shape is right (else `null`: treated as none, never repaired). */
export function parseState(raw: unknown): UpdateState | null {
  const o = raw as Partial<UpdateState> | null;
  if (typeof o !== "object" || o === null || o.schema !== UPDATE_SCHEMA) return null;
  if (typeof o.phase !== "string" || typeof o.active_release !== "string") return null;
  const b = o.barrier;
  if (b !== null && b !== undefined && (typeof b !== "object" || typeof b.request_id !== "string"))
    return null;
  return {
    ...emptyState(o.active_release, typeof o.base === "string" ? o.base : BASE),
    ...o,
    barrier: b ?? null,
  } as UpdateState;
}

/** The stored update state; `barrierRaw`: whether any barrier is stored (also an unreadable one). */
export async function readState(): Promise<{ state: UpdateState; unreadable: boolean }> {
  const raw = await (await db()).get("settings", UPDATE_KEY);
  if (raw === undefined) return { state: emptyState(), unreadable: false };
  const state = parseState(raw);
  if (state) return { state, unreadable: false };
  const hasBarrier = !!raw && typeof raw === "object" && (raw as { barrier?: unknown }).barrier;
  return { state: emptyState(), unreadable: !!hasBarrier };
}

/** Write the state (only the lock holder does: §6). */
async function writeState(state: UpdateState): Promise<void> {
  await writeQueue(async () => (await db()).put("settings", state, UPDATE_KEY));
  useUpdateStore.setState({ state });
}

// ───────────────────────── observation and the one recovery rule (§7.5) ─────────────────────────

const releaseOf = (w: ServiceWorker | null | undefined, base: string) =>
  w ? (releaseOfScriptUrl(w.scriptURL, base) ?? "unknown") : null;

const container = (): ServiceWorkerContainer | undefined =>
  typeof navigator !== "undefined" ? navigator.serviceWorker : undefined;

export async function observeRelease(
  o: {
    readonly container?: ServiceWorkerContainer;
    readonly base?: string;
    readonly exec?: string;
  } = {},
): Promise<Observed> {
  const base = o.base ?? BASE;
  const exec = o.exec ?? RELEASE_ID;
  const sw = o.container ?? container();
  const reg = sw ? await sw.getRegistration(base) : undefined;
  return {
    exec,
    active: releaseOf(reg?.active, base),
    waiting: releaseOf(reg?.waiting, base),
    installing: releaseOf(reg?.installing, base),
    controller: releaseOf(sw?.controller, base),
  };
}

/** Whether this page may mutate: active none or this release, nothing waiting or installing. */
export const coherent = (o: Observed): boolean =>
  (o.active === null || o.active === o.exec) &&
  !o.waiting &&
  !o.installing &&
  (o.controller === null || o.controller === o.exec);

/**
 * The one rule (offline.md §7.5), pure: what this page does from what it observes and the stored
 * state. Phases are only messages; they decide nothing here.
 */
export function decideRecovery(
  o: Observed,
  state: Pick<UpdateState, "barrier" | "consent">,
): Recovery {
  if (o.installing) return "wait";
  if (
    (o.active !== null && o.active !== o.exec) ||
    (o.controller !== null && o.controller !== o.exec)
  )
    return "reload";
  if (o.waiting) {
    const agreed =
      !!state.barrier &&
      state.barrier.target_release === o.waiting &&
      state.consent?.release_id === o.waiting;
    return agreed ? "complete" : "fail_closed";
  }
  return state.barrier ? "clear" : "open";
}

// ───────────────────────── the session store (UI) ─────────────────────────

interface UpdateUi {
  readonly state: UpdateState | null;
  readonly busy: "checking" | "downloading" | "updating" | null;
  /** Why the last "Now" didn't go through (what to finish or close first). */
  readonly reasons: readonly Reason[];
  /** This page must reload (another release took control, or a transition was announced). */
  readonly needsReload: boolean;
  /** The request this page is frozen for (another window is updating). */
  readonly frozen: string | null;
  readonly readOnly: boolean;
}

export const useUpdateStore = create<UpdateUi>()(() => ({
  state: null,
  busy: null,
  reasons: [],
  needsReload: false,
  frozen: null,
  readOnly: false,
}));

// ───────────────────────── the protocol client (§7.1) ─────────────────────────

interface Delivered {
  readonly proto: string;
  readonly type: string;
  readonly request_id?: string;
  readonly to?: string | null;
  readonly ok?: boolean;
  readonly reasons?: readonly Reason[];
  readonly source_client_id?: string;
  readonly client_id?: string;
  readonly clients?: readonly { readonly client_id: string; readonly path: string }[];
}

let myClientId: string | null = null;
const listeners = new Set<(m: Delivered) => void>();

async function activeWorker(): Promise<ServiceWorker | null> {
  const sw = container();
  return ((await sw?.getRegistration(BASE))?.active as ServiceWorker | undefined) ?? null;
}

async function send(msg: Record<string, unknown>): Promise<boolean> {
  const w = await activeWorker();
  if (!w) return false;
  w.postMessage({
    proto: UPDATE_PROTO,
    page_id: PAGE_ID,
    release_id: RELEASE_ID,
    to: null,
    ...msg,
  });
  return true;
}

function next(predicate: (m: Delivered) => boolean, timeoutMs: number): Promise<Delivered | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      listeners.delete(listener);
      resolve(null);
    }, timeoutMs);
    const listener = (m: Delivered) => {
      if (!predicate(m)) return;
      clearTimeout(timer);
      listeners.delete(listener);
      resolve(m);
    };
    listeners.add(listener);
  });
}

/** This page's own `Client.id`, as the service worker sees it (`hello` → `welcome`). */
export async function clientId(): Promise<string | null> {
  if (myClientId) return myClientId;
  const reply = next((m) => m.type === "welcome", 3_000);
  if (!(await send({ type: "hello" }))) return null;
  myClientId = (await reply)?.client_id ?? null;
  return myClientId;
}

/** The base's window clients, as the active service worker lists them (uncontrolled ones too). */
async function listClients(
  requestId: string,
): Promise<{ client_id: string; path: string }[] | null> {
  const reply = next((m) => m.type === "clients" && m.request_id === requestId, 3_000);
  if (!(await send({ type: "clients", request_id: requestId }))) return null;
  const r = await reply;
  return r?.clients ? [...r.clients] : null;
}

async function withLock<T>(
  fn: () => Promise<T>,
  ifAvailable: boolean,
): Promise<T | "busy" | "unsupported"> {
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  if (!locks) return "unsupported";
  return locks.request(lockName(BASE), { mode: "exclusive", ifAvailable }, async (lock) =>
    lock ? fn() : ("busy" as const),
  );
}

/** A member page: frozen for one request, answers it, thaws or reloads only for that request. */
async function onFreeze(m: Delivered): Promise<void> {
  const requestId = m.request_id;
  const owner = m.source_client_id;
  if (!requestId || !owner || owner === myClientId) return;
  if (useUpdateStore.getState().frozen === requestId) return;
  admission.close("freeze", requestId);
  useUpdateStore.setState({ frozen: requestId });
  // Queue for the owner's lock: whoever gets it next knows no live owner runs and decides (§7.5).
  void withLock(async () => {
    await resolveAfterLock(requestId);
  }, false);
  const reasons = [...blockers(), ...(await savedReasons())];
  await send({
    type: "frozen",
    to: owner,
    request_id: requestId,
    ok: reasons.length === 0,
    reasons,
  });
}

function onThaw(m: Delivered): void {
  const frozen = useUpdateStore.getState().frozen;
  if (!m.request_id || m.request_id !== frozen) return; // a late thaw of another request: nothing
  if (admission.open(frozen)) useUpdateStore.setState({ frozen: null });
}

function onTransition(m: Delivered): void {
  const frozen = useUpdateStore.getState().frozen;
  if (!m.request_id || m.request_id !== frozen) return;
  admission.close("reload", null);
  useUpdateStore.setState({ needsReload: true });
  location.reload();
}

/** A frozen page got the lock (the owner finished or is gone): decide again from what it sees. */
async function resolveAfterLock(requestId: string): Promise<void> {
  const o = await observeRelease();
  const { state } = await readState();
  const d = decideRecovery(o, state);
  if (d === "reload" || d === "complete" || d === "wait") {
    admission.close("reload", null);
    useUpdateStore.setState({ needsReload: true });
    if (d === "complete") await completeTransition(state);
    location.reload();
    return;
  }
  if (d === "fail_closed") {
    await failClosed(state);
    return;
  }
  if (d === "clear") await clearBarrier(state, o);
  if (useUpdateStore.getState().frozen === requestId && admission.open(requestId))
    useUpdateStore.setState({ frozen: null });
}

let started = false;
/** Listen to the protocol and to `controllerchange` (after the boot gate opened the game). */
export function startUpdateProtocol(): void {
  const sw = container();
  if (started || !sw) return;
  started = true;
  sw.addEventListener("message", (e: MessageEvent) => {
    const m = e.data as Delivered | null;
    if (!m || m.proto !== UPDATE_PROTO) return;
    for (const l of [...listeners]) l(m);
    if (m.type === "freeze") void onFreeze(m);
    else if (m.type === "thaw") onThaw(m);
    else if (m.type === "transition") onTransition(m);
  });
  sw.startMessages();
  // Another release took control of this page: old code never mutates again (§7.5).
  sw.addEventListener("controllerchange", () => {
    admission.close("reload", null);
    useUpdateStore.setState({ needsReload: true });
  });
  void clientId();
}

// ───────────────────────── the boot gate (§5.1.5) ─────────────────────────

const RELOAD_FLAG = "srd-table:boot-reload";

async function clearBarrier(state: UpdateState, o: Observed): Promise<void> {
  const b = state.barrier;
  if (!b) return;
  const arrived = o.exec === b.target_release;
  await writeState({
    ...state,
    phase: arrived ? "idle" : "consented",
    active_release: arrived ? o.exec : state.active_release,
    candidate: arrived ? null : state.candidate,
    consent: arrived ? null : state.consent,
    last_error:
      state.phase === "transitioning" ? null : { code: "owner_lost", detail: b.request_id },
    barrier: null,
  });
  await send({ type: "thaw", request_id: b.request_id });
}

async function failClosed(state: UpdateState): Promise<void> {
  admission.close("reload", null);
  useUpdateStore.setState({ readOnly: true });
  await writeState({ ...state, last_error: { code: "update_state_unknown", detail: "" } });
}

/** Activate the agreed waiting release (the barrier's), then announce the transition. */
async function completeTransition(state: UpdateState): Promise<void> {
  const target = state.barrier?.target_release;
  const reg = await container()?.getRegistration(BASE);
  if (!target || !reg) return;
  await writeState({ ...state, phase: "activating" });
  await activateWaiting(reg, target);
  await writeState({ ...state, phase: "transitioning" });
  if (state.barrier) await send({ type: "transition", request_id: state.barrier.request_id });
}

async function decideWithLock(): Promise<BootDecision> {
  const o = await observeRelease();
  const { state, unreadable } = await readState();
  const d = unreadable ? "fail_closed" : decideRecovery(o, state);
  if (d === "wait") return "waiting";
  if (d === "reload") return "reload";
  if (d === "open") return "open";
  if (d === "fail_closed") {
    await writeState({ ...state, last_error: { code: "update_state_unknown", detail: "" } });
    return "read_only";
  }
  if (d === "complete") {
    await completeTransition(state);
    return "reload";
  }
  await clearBarrier(state, o);
  return "open";
}

/**
 * The boot gate (frozen T05 API): runs before any game-data write. A coherent page without a
 * barrier opens at once; one with a barrier queues for the update lock (a live owner keeps it
 * waiting) and then applies the rule; a reload for another release is done once, then read-only.
 */
export async function updateBootGate(
  o: {
    readonly observe?: () => Promise<Observed>;
    readonly read?: () => Promise<{ state: UpdateState; unreadable: boolean }>;
    readonly locked?: () => Promise<BootDecision>;
    readonly session?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  } = {},
): Promise<BootDecision> {
  const session = o.session ?? (typeof sessionStorage !== "undefined" ? sessionStorage : undefined);
  const observed = await (o.observe ?? observeRelease)();
  const { state, unreadable } = await (o.read ?? readState)();
  useUpdateStore.setState({ state });
  const flag = `${RELOAD_FLAG}:${observed.exec}`;
  let d: BootDecision;
  const first = unreadable ? "fail_closed" : decideRecovery(observed, state);
  if (first === "open") d = "open";
  else if (first === "wait") d = "waiting";
  else if (first === "reload") d = "reload";
  else {
    const locked = await withLock(o.locked ?? decideWithLock, false);
    d = locked === "unsupported" || locked === "busy" ? "read_only" : locked;
  }
  if (d === "reload") {
    if (session?.getItem(flag) === "1") d = "read_only";
    else session?.setItem(flag, "1");
  } else if (d === "open") session?.removeItem(flag);
  if (d === "read_only") useUpdateStore.setState({ readOnly: true });
  return d;
}

// ───────────────────────── offer, download, Later (§6) ─────────────────────────

/** Whether this page runs a prepared release (its own worker active): only then are updates offered. */
export async function updatesApply(): Promise<boolean> {
  if (!isReleaseBuild()) return false;
  return (await observeRelease()).active === RELEASE_ID;
}

const compatible = (data: ReleaseDescriptor["inputs"]["data"] | undefined): boolean =>
  !!data &&
  data.db_version === OWN_DATA.db_version &&
  data.history_schema === OWN_DATA.history_schema &&
  data.history_meta_schema === OWN_DATA.history_meta_schema &&
  OWN_DATA.transfer_formats.every((f) => data.transfer_formats.includes(f)) &&
  OWN_DATA.local_copy_formats.every((f) => data.local_copy_formats.includes(f));

/** A candidate's descriptor, from the network, checked against the pointer's hash and its inputs. */
async function candidateDescriptor(
  releaseId: string,
  descriptorSha: string,
  fetcher: typeof fetch = fetch,
): Promise<ReleaseDescriptor> {
  const res = await fetcher(`${BASE}${descriptorPathOf(releaseId)}`, { cache: "no-store" });
  if (!res.ok)
    throw Object.assign(new Error(`descriptor ${res.status}`), { code: "update_download_failed" });
  const bytes = new Uint8Array(await res.arrayBuffer());
  if ((await sha256Hex(bytes)) !== descriptorSha)
    throw Object.assign(new Error("descriptor bytes ≠ pointer"), {
      code: "update_descriptor_hash",
    });
  const d = JSON.parse(new TextDecoder().decode(bytes)) as ReleaseDescriptor;
  const id = `r-${(await contentSha(d.inputs)).slice(0, 16)}`;
  if (
    d.release_id !== releaseId ||
    id !== releaseId ||
    d.base !== BASE ||
    d.sw?.path !== swPathOf(releaseId)
  )
    throw Object.assign(new Error("descriptor identity"), { code: "update_descriptor_invalid" });
  return d;
}

/** Read the pointer (online) and offer what it names; never registers anything. */
export async function checkForUpdate(fetcher: typeof fetch = fetch): Promise<UpdateState | null> {
  if (!(await updatesApply())) return null;
  useUpdateStore.setState({ busy: "checking" });
  try {
    const res = await fetcher(`${BASE}release.json`, { cache: "no-store" });
    if (!res.ok) return null;
    const p = (await res.json()) as { release_id?: unknown; descriptor_sha256?: unknown };
    if (typeof p.release_id !== "string" || !RELEASE_ID_PATTERN.test(p.release_id)) return null;
    if (typeof p.descriptor_sha256 !== "string") return null;
    const pointer = { release_id: p.release_id, sha: p.descriptor_sha256 };
    const r = await withLock(async () => {
      const { state } = await readState();
      if (state.barrier) return state;
      if (pointer.release_id === RELEASE_ID) {
        const idle = {
          ...state,
          phase: "idle" as const,
          candidate: null,
          consent: null,
          active_release: RELEASE_ID,
        };
        if (state.phase !== "idle" || state.candidate) await writeState(idle);
        return idle;
      }
      if (state.candidate?.release_id === pointer.release_id) return state;
      const d = await candidateDescriptor(pointer.release_id, pointer.sha, fetcher);
      // A new candidate (C after B): an earlier consent never carries over.
      const next: UpdateState = {
        ...state,
        phase: "offered",
        active_release: RELEASE_ID,
        candidate: {
          release_id: d.release_id,
          descriptor_sha256: pointer.sha,
          sw: d.sw.path,
          compatible: compatible(d.inputs.data),
        },
        consent: null,
        deferred_at: null,
        last_error: compatible(d.inputs.data)
          ? null
          : { code: "update_incompatible", detail: d.release_id },
      };
      await writeState(next);
      return next;
    }, true);
    return typeof r === "string" ? null : r;
  } catch {
    return null; // offline or a bad pointer: the current release goes on
  } finally {
    useUpdateStore.setState({ busy: null });
  }
}

/**
 * Fetch the candidate's files into its own cache with the same checks as its service worker
 * (size, SHA-256, its type), the completeness marker last — without registering it.
 */
export async function downloadCandidate(
  fetcher: typeof fetch = fetch,
): Promise<UpdateState | null> {
  useUpdateStore.setState({ busy: "downloading" });
  try {
    const r = await withLock(async () => {
      const { state } = await readState();
      const c = state.candidate;
      if (!c?.compatible || state.barrier) return state;
      try {
        const d = await candidateDescriptor(c.release_id, c.descriptor_sha256, fetcher);
        const sw = await fetcher(`${BASE}${d.sw.path}`, { cache: "no-store" });
        if (!sw.ok || !(await bytesMatch(await sw.arrayBuffer(), d.sw)))
          throw Object.assign(new Error(d.sw.path), { code: "release_asset_hash" });
        const rel = swReleaseOf(d);
        const cache = await caches.open(cacheNameOf(rel));
        for (const f of rel.files) {
          const url = `${rel.base}${f.path}`;
          const hit = await cache.match(url);
          if (
            hit &&
            hit.headers.get("content-type") === contentTypeOf(f.path) &&
            (await bytesMatch(await hit.arrayBuffer(), f))
          )
            continue;
          const res = await fetcher(url, { cache: "no-store" });
          if (!res.ok)
            throw Object.assign(new Error(`${f.path} ${res.status}`), {
              code: "release_asset_http",
            });
          const bytes = await res.arrayBuffer();
          if (!(await bytesMatch(bytes, f)))
            throw Object.assign(new Error(f.path), { code: "release_asset_hash" });
          await cache.put(
            url,
            new Response(bytes, {
              headers: { "content-type": contentTypeOf(f.path) ?? "application/octet-stream" },
            }),
          );
        }
        await cache.put(
          completeKeyOf(rel),
          new Response(JSON.stringify({ release_id: rel.release_id, files: rel.files.length }), {
            headers: { "content-type": "application/json" },
          }),
        );
        const next = { ...state, phase: "downloaded" as const, last_error: null };
        await writeState(next);
        return next;
      } catch (error) {
        const e = error as { code?: string; name?: string; message?: string };
        const code =
          e.name === "QuotaExceededError" ? "storage_quota" : (e.code ?? "update_download_failed");
        const next = {
          ...state,
          phase: "offered" as const,
          last_error: { code, detail: e.message ?? "" },
        };
        await writeState(next);
        return next;
      }
    }, true);
    return typeof r === "string" ? null : r;
  } finally {
    useUpdateStore.setState({ busy: null });
  }
}

/** "Later": no consent (an earlier one withdrawn); nothing registered, now or at a restart. */
export async function later(): Promise<void> {
  await withLock(async () => {
    const { state } = await readState();
    if (state.barrier) return;
    await writeState({
      ...state,
      phase: state.phase === "consented" ? "downloaded" : state.phase,
      consent: null,
      deferred_at: Date.now(),
    });
  }, true);
}

// ───────────────────────── "Now": the owner (§7.2) ─────────────────────────

/** Wait until the registration's worker for `target` is installed (waiting) or active. */
function settled(
  reg: ServiceWorkerRegistration,
  target: string,
  timeoutMs = 120_000,
): Promise<"installed" | "active" | "failed"> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (r: "installed" | "active" | "failed") => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => finish("failed"), timeoutMs);
    const check = () => {
      if (done) return;
      if (releaseOf(reg.active, BASE) === target && reg.active?.state === "activated")
        return finish("active");
      if (releaseOf(reg.waiting, BASE) === target) return finish("installed");
      const installing = releaseOf(reg.installing, BASE) === target ? reg.installing : null;
      const mine = installing ?? (releaseOf(reg.active, BASE) === target ? reg.active : null);
      if (!mine) return; // not there yet: `updatefound` checks again
      if (mine.state === "redundant") return finish("failed");
      mine.addEventListener("statechange", check, { once: true });
    };
    reg.addEventListener("updatefound", check);
    check();
  });
}

async function activateWaiting(reg: ServiceWorkerRegistration, target: string): Promise<void> {
  const waiting = reg.waiting;
  if (waiting && releaseOf(waiting, BASE) === target)
    waiting.postMessage({
      proto: UPDATE_PROTO,
      type: "activate",
      target_release: target,
      page_id: PAGE_ID,
    });
  for (let i = 0; i < 300; i++) {
    if (releaseOf(reg.active, BASE) === target && reg.active?.state === "activated") return;
    await new Promise((r) => setTimeout(r, 100));
  }
}

const sameSet = (a: readonly { client_id: string }[], b: readonly { client_id: string }[]) =>
  JSON.stringify(a.map((c) => c.client_id).sort()) ===
  JSON.stringify(b.map((c) => c.client_id).sort());

/**
 * "Now" (or the retry of a consent after a restart). `{ok:false, reasons}`: nothing registered,
 * every gate released, play goes on; `{ok:true}`: the page reloads into the new release.
 */
export async function updateNow(): Promise<{ ok: boolean; reasons: readonly Reason[] }> {
  useUpdateStore.setState({ busy: "updating", reasons: [] });
  const r = await withLock(async () => {
    const { state } = await readState();
    const target = state.candidate;
    if (!target || state.phase === "offered" || !target.compatible)
      return { ok: false, reasons: [{ code: "update_not_downloaded", detail: "" }] };
    const me = await clientId();
    if (!me)
      return { ok: false, reasons: [{ code: "update_unsupported", detail: "no service worker" }] };
    const requestId = newRequestId();
    const gating: UpdateState = {
      ...state,
      phase: "gating",
      consent: { release_id: target.release_id, at: Date.now(), request_id: requestId },
      last_error: null,
      barrier: {
        request_id: requestId,
        owner_client_id: me,
        target_release: target.release_id,
        since: Date.now(),
      },
    };
    await writeState(gating);
    admission.close("owner", requestId);
    const abort = async (reasons: Reason[]) => {
      await writeState({
        ...gating,
        phase: "consented",
        last_error: reasons[0] ?? null,
        barrier: null,
      });
      await send({ type: "thaw", request_id: requestId });
      admission.open(requestId);
      return { ok: false, reasons };
    };
    const members = ((await listClients(requestId)) ?? []).filter((c) => c.client_id !== me);
    const answers = new Map<string, Delivered>();
    const memberIds = new Set(members.map((c) => c.client_id));
    const collecting = new Promise<void>((resolve) => {
      if (memberIds.size === 0) return resolve();
      const timer = setTimeout(() => {
        listeners.delete(listener);
        resolve();
      }, FREEZE_TIMEOUT_MS);
      const listener = (m: Delivered) => {
        if (m.type !== "frozen" || m.request_id !== requestId || m.to !== me) return;
        if (!m.source_client_id || !memberIds.has(m.source_client_id)) return;
        answers.set(m.source_client_id, m);
        if (answers.size === memberIds.size) {
          clearTimeout(timer);
          listeners.delete(listener);
          resolve();
        }
      };
      listeners.add(listener);
    });
    await send({ type: "freeze", request_id: requestId, target_release: target.release_id });
    const own = [...blockers(), ...(await savedReasons())];
    await collecting;
    const reasons: Reason[] = [...own];
    for (const c of members) {
      const a = answers.get(c.client_id);
      if (!a) reasons.push({ code: "client_unresponsive", detail: `${c.client_id} ${c.path}` });
      else if (!a.ok)
        reasons.push(...(a.reasons ?? [{ code: "client_refused", detail: c.client_id }]));
    }
    const again = await listClients(requestId);
    if (!again || !sameSet([...members, { client_id: me, path: "" }], again))
      reasons.push({ code: "client_set_changed", detail: "" });
    if (reasons.length) return abort(reasons);
    // Every gate passed: register the agreed release (the only `register()` of another release).
    await writeState({ ...gating, phase: "registering" });
    let reg: ServiceWorkerRegistration;
    try {
      reg = await (container() as ServiceWorkerContainer).register(`${BASE}${target.sw}`, {
        scope: BASE,
        updateViaCache: "none",
      });
    } catch (error) {
      return abort([{ code: "release_install_failed", detail: String(error) }]);
    }
    const s = await settled(reg, target.release_id);
    if (s === "failed")
      return abort([{ code: "release_install_failed", detail: target.release_id }]);
    await writeState({ ...gating, phase: "activating" });
    await activateWaiting(reg, target.release_id);
    await writeState({ ...gating, phase: "transitioning" });
    admission.close("reload", null);
    useUpdateStore.setState({ needsReload: true });
    await send({ type: "transition", request_id: requestId });
    return { ok: true, reasons: [] };
  }, true);
  const out =
    r === "busy"
      ? { ok: false, reasons: [{ code: "update_busy", detail: "" }] }
      : r === "unsupported"
        ? { ok: false, reasons: [{ code: "update_unsupported", detail: "Web Locks" }] }
        : r;
  useUpdateStore.setState({ busy: null, reasons: out.reasons });
  if (out.ok) location.reload();
  return out;
}

/** After the start: a consent that was interrupted (restart in gating/registering) is tried again. */
export async function resumeConsented(): Promise<void> {
  const { state } = await readState();
  useUpdateStore.setState({ state });
  if (
    state.consent &&
    state.candidate?.release_id === state.consent.release_id &&
    ["consented", "gating", "registering", "installed"].includes(state.phase) &&
    (await updatesApply())
  )
    await updateNow();
}

/** Frozen T05 API: the update UI's state and actions. */
export function useUpdate() {
  const ui = useUpdateStore();
  return {
    ...ui,
    check: () => checkForUpdate(),
    download: () => downloadCandidate(),
    now: () => updateNow(),
    later: async () => {
      await later();
      const { state } = await readState();
      useUpdateStore.setState({ state });
    },
  };
}
