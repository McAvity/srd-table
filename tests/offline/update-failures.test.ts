/**
 * kenli F-007 T05 (R06-02, R06-03): the update owner's failures and an unreadable stored record,
 * on the real update module, real stores and (fake) IndexedDB. Labeled: a fake
 * ServiceWorkerContainer and Web Locks stand in for the browser (the real ones run in
 * scripts/f007-update-probe.mjs); this page executes release A, the candidate is B.
 *  - R06-03: a write of the update's own record fails at gating, registering, activating,
 *    transitioning and in the abort's cleanup; `register()` rejects; the activation times out; the
 *    lock itself fails. Every outcome ends `busy` with its reason. Before registration the barrier
 *    goes, this request thaws and the page goes on (a retry updates: one registration); when the
 *    cleanup isn't saved, or a release may be registered and the page isn't coherent, the barrier
 *    stays, the page stays closed (no thaw, no transition) and the next start decides by the rule.
 *  - R06-02: an unreadable record (another schema with a barrier; a malformed one without) stays
 *    byte-for-byte as stored through two starts, a frozen page's recovery and check / download /
 *    Later / Now / resume; a valid record with a stale barrier still recovers.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { admission, resetAdmission, useAdmission } from "@/offline/admission";
import { UPDATE_PROTO } from "@/offline/sw-core";
import {
  _setActivatePollMs,
  checkForUpdate,
  downloadCandidate,
  emptyState,
  later,
  resumeConsented,
  startUpdateProtocol,
  UPDATE_KEY,
  UPDATE_SCHEMA,
  type UpdateState,
  updateBootGate,
  updateNow,
  useUpdateStore,
} from "@/offline/update";
import { db } from "@/persistence/db";
import { flushNow } from "@/persistence/sync";
import { Installations } from "../localCopy/helpers";

// This page executes release A (a release build), so it observes its own worker as coherent.
vi.mock("@/offline/release", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/offline/release")>()),
  RELEASE_ID: "r-aaaaaaaaaaaaaaaa",
  isReleaseBuild: () => true,
}));

const A = "r-aaaaaaaaaaaaaaaa";
const B = "r-bbbbbbbbbbbbbbbb";
const C = "r-cccccccccccccccc";

type Msg = Record<string, unknown>;

/** A fake worker: its script URL names its release; what pages post to it is recorded. */
class FakeWorker extends EventTarget {
  state: string;
  readonly scriptURL: string;
  private readonly onMessage: (m: Msg) => void;
  constructor(release: string, state: string, onMessage: (m: Msg) => void) {
    super();
    this.scriptURL = `http://localhost/sw-${release}.js`;
    this.state = state;
    this.onMessage = onMessage;
  }
  postMessage(m: Msg): void {
    this.onMessage(m);
  }
}

const posted: Msg[] = [];
const target = new EventTarget();
const deliver = (data: unknown) =>
  target.dispatchEvent(Object.assign(new Event("message"), { data }));
const workerA = new FakeWorker(A, "activated", (m) => {
  posted.push(m);
  if (m.type === "hello") deliver({ proto: UPDATE_PROTO, type: "welcome", client_id: "me" });
  if (m.type === "clients")
    deliver({
      proto: UPDATE_PROTO,
      type: "clients",
      request_id: m.request_id,
      clients: [{ client_id: "me", path: "/" }],
    });
});
const reg = {
  active: workerA as FakeWorker | null,
  waiting: null as FakeWorker | null,
  installing: null as FakeWorker | null,
  addEventListener: () => {},
};
/** Whether B activates when asked (`false`: the activation times out). */
let activates = true;
const workerB = () =>
  new FakeWorker(B, "installed", (m) => {
    posted.push({ ...m, to_worker: B });
    if (m.type === "activate" && activates && reg.waiting) {
      reg.active = reg.waiting;
      reg.active.state = "activated";
      reg.waiting = null;
    }
  });
const register = vi.fn(async (_url: string, _o?: unknown) => {
  reg.waiting = workerB();
  return reg;
});
const container = Object.assign(target, {
  controller: workerA,
  getRegistration: async () => reg,
  register: (url: string, o?: unknown) => register(url, o),
  startMessages: () => {},
});

const immediateLocks = {
  request: async (_n: string, _o: unknown, fn: (lock: object) => unknown) => fn({}),
};
const define = (name: "serviceWorker" | "locks", value: unknown) =>
  Object.defineProperty(navigator, name, { value, configurable: true });

const memorySession = () => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
};

/** A new page: the session store, the gate and the reload flag as after a load. */
function freshPage(): void {
  useUpdateStore.setState({
    state: null,
    busy: null,
    reasons: [],
    needsReload: false,
    frozen: null,
    readOnly: false,
    unreadable: false,
    halted: null,
  });
  resetAdmission();
}

const inst = new Installations();
beforeAll(async () => {
  define("serviceWorker", container);
  define("locks", immediateLocks);
  startUpdateProtocol();
  await new Promise((r) => setTimeout(r, 10));
});
afterAll(() => inst.close());
beforeEach(() => {
  vi.restoreAllMocks();
  define("locks", immediateLocks);
  register.mockClear();
  reg.active = workerA;
  reg.waiting = null;
  reg.installing = null;
  activates = true;
  posted.length = 0;
  _setActivatePollMs(100);
  freshPage();
});

const DOWNLOADED: UpdateState = {
  ...emptyState(A, "/"),
  phase: "downloaded",
  candidate: {
    release_id: B,
    descriptor_sha256: "a".repeat(64),
    sw: `sw-${B}.js`,
    compatible: true,
  },
};

const stored = async (): Promise<unknown> => (await db()).get("settings", UPDATE_KEY);
const put = async (v: unknown) => {
  await (await db()).put("settings", v, UPDATE_KEY);
};

/** The update record's writes of these phases fail as on a full metadata store. */
function failPhases(...phases: string[]) {
  const original = IDBObjectStore.prototype.put;
  return vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (
    this: IDBObjectStore,
    ...args: Parameters<IDBObjectStore["put"]>
  ) {
    const v = args[0] as { phase?: unknown } | null;
    if (this.name === "settings" && typeof v?.phase === "string" && phases.includes(v.phase))
      throw new DOMException("metadata full", "QuotaExceededError");
    return original.apply(this, args);
  });
}

const codes = (r: { reasons: readonly { code: string }[] }) => r.reasons.map((x) => x.code);
const sent = (type: string) => posted.filter((m) => m.type === type);

async function page(name: string): Promise<void> {
  await inst.open(name);
  freshPage();
  await flushNow();
}

describe("R06-03: the owner's failures end busy, with the truth, and never thaw unsafely", () => {
  it("gating write fails: refused, nothing closed or written; a retry updates (one registration)", async () => {
    await page("u-gating");
    await put(DOWNLOADED);
    const spy = failPhases("gating");
    const r = await updateNow();
    expect(r.ok).toBe(false);
    expect(codes(r)).toEqual(["storage_quota"]);
    expect(admission.isClosed()).toBe(false);
    expect(useUpdateStore.getState()).toMatchObject({ busy: null, halted: null });
    expect(await stored()).toEqual(DOWNLOADED);
    expect(register).not.toHaveBeenCalled();
    expect(sent("freeze")).toHaveLength(0);
    spy.mockRestore();
    const again = await updateNow();
    expect(again).toEqual({ ok: true, reasons: [] });
    expect(register).toHaveBeenCalledTimes(1);
    expect(await stored()).toMatchObject({
      phase: "transitioning",
      barrier: { target_release: B },
    });
    expect(sent("transition")).toHaveLength(1);
  });

  it("registering write fails before register(): barrier released, this request thawed, play goes on; retry works", async () => {
    await page("u-registering");
    await put(DOWNLOADED);
    const spy = failPhases("registering");
    const r = await updateNow();
    expect(codes(r)).toEqual(["storage_quota"]);
    const s = (await stored()) as UpdateState;
    expect(s).toMatchObject({
      phase: "consented",
      barrier: null,
      consent: { release_id: B },
      last_error: { code: "storage_quota" },
    });
    expect(sent("thaw").map((m) => m.request_id)).toEqual([s.consent?.request_id]);
    expect(register).not.toHaveBeenCalled();
    expect(admission.isClosed()).toBe(false);
    expect(useUpdateStore.getState()).toMatchObject({
      busy: null,
      halted: null,
      reasons: r.reasons,
    });
    spy.mockRestore();
    expect((await updateNow()).ok).toBe(true);
    expect(register).toHaveBeenCalledTimes(1);
  });

  it("the cleanup fails too: barrier kept, page halted and closed, no thaw; Now refused; the next start clears it by the rule (stays read only while it can't save)", async () => {
    await page("u-cleanup");
    await put(DOWNLOADED);
    const spy = failPhases("registering", "consented");
    const r = await updateNow();
    expect(r.ok).toBe(false);
    expect(codes(r)).toEqual(["storage_quota", "storage_quota", "update_reload_required"]);
    const kept = (await stored()) as UpdateState;
    expect(kept.phase).toBe("gating");
    expect(kept.barrier).toMatchObject({ target_release: B, owner_client_id: "me" });
    expect(kept.barrier?.request_id).toBe(kept.consent?.request_id);
    expect(useAdmission.getState().closed).toEqual({ by: "reload", request_id: null });
    expect(useUpdateStore.getState()).toMatchObject({
      busy: null,
      halted: { code: "storage_quota" },
    });
    expect(sent("thaw")).toHaveLength(0);
    expect(register).not.toHaveBeenCalled();
    // This page never tries again (no second barrier, no double action): a reload is the retry.
    expect(codes(await updateNow())).toEqual(["update_reload_required"]);
    expect(await stored()).toEqual(kept);
    expect(admission.open(kept.barrier?.request_id ?? null)).toBe(false);

    // Next start, the metadata store still full: read only, the barrier as it was.
    freshPage();
    const session = memorySession();
    expect(await updateBootGate({ session })).toBe("read_only");
    expect(await stored()).toEqual(kept);
    expect(useUpdateStore.getState().halted?.code).toBe("storage_quota");

    // Next start, it saves again: coherent A clears the stale barrier and opens.
    spy.mockRestore();
    freshPage();
    expect(await updateBootGate({ session })).toBe("open");
    expect(await stored()).toMatchObject({
      phase: "consented",
      barrier: null,
      consent: { release_id: B },
      last_error: { code: "owner_lost", detail: kept.barrier?.request_id },
    });
    expect(admission.isClosed()).toBe(false);
  });

  it("register() rejects (transport/script): nothing registered, coherent → released as before", async () => {
    await page("u-register-rejects");
    await put(DOWNLOADED);
    register.mockImplementationOnce(async () => {
      throw new TypeError("script fetch failed");
    });
    const r = await updateNow();
    expect(codes(r)).toEqual(["release_install_failed"]);
    expect(await stored()).toMatchObject({ phase: "consented", barrier: null });
    expect(sent("thaw")).toHaveLength(1);
    expect(admission.isClosed()).toBe(false);
    expect(useUpdateStore.getState()).toMatchObject({ busy: null, halted: null });
  });

  it("activating write fails after registration: barrier kept, halted, no thaw or transition; the next start completes the agreed release", async () => {
    await page("u-activating");
    await put(DOWNLOADED);
    const spy = failPhases("activating");
    const r = await updateNow();
    expect(codes(r)).toEqual(["storage_quota", "update_reload_required"]);
    expect(register).toHaveBeenCalledTimes(1);
    expect(reg.waiting?.scriptURL).toContain(B);
    const kept = (await stored()) as UpdateState;
    expect(kept).toMatchObject({ phase: "registering", barrier: { target_release: B } });
    expect(useAdmission.getState().closed?.by).toBe("reload");
    expect(useUpdateStore.getState()).toMatchObject({
      busy: null,
      halted: { code: "storage_quota" },
    });
    expect(sent("thaw")).toHaveLength(0);
    expect(sent("transition")).toHaveLength(0);
    spy.mockRestore();
    freshPage();
    expect(await updateBootGate({ session: memorySession() })).toBe("reload");
    expect(reg.active?.scriptURL).toContain(B);
    expect(await stored()).toMatchObject({ phase: "transitioning", barrier: kept.barrier });
    expect(sent("transition").map((m) => m.request_id)).toEqual([kept.barrier?.request_id]);
  });

  it("the activation times out: update_activation_timeout, barrier kept, halted", async () => {
    await page("u-activation-timeout");
    await put(DOWNLOADED);
    activates = false;
    _setActivatePollMs(1);
    const r = await updateNow();
    expect(codes(r)).toEqual(["update_activation_timeout", "update_reload_required"]);
    expect(await stored()).toMatchObject({ phase: "activating", barrier: { target_release: B } });
    expect(useAdmission.getState().closed?.by).toBe("reload");
    expect(useUpdateStore.getState()).toMatchObject({
      busy: null,
      halted: { code: "update_activation_timeout" },
    });
    expect(sent("thaw")).toHaveLength(0);
    expect(sent("transition")).toHaveLength(0);
  });

  it("transitioning write fails after the switch: halted with the barrier, no fake way back to A", async () => {
    await page("u-transitioning");
    await put(DOWNLOADED);
    failPhases("transitioning");
    const r = await updateNow();
    expect(codes(r)).toEqual(["storage_quota", "update_reload_required"]);
    expect(reg.active?.scriptURL).toContain(B);
    expect(await stored()).toMatchObject({ phase: "activating", barrier: { target_release: B } });
    expect(useAdmission.getState().closed?.by).toBe("reload");
    expect(useUpdateStore.getState()).toMatchObject({
      busy: null,
      halted: { code: "storage_quota" },
    });
    expect(sent("thaw")).toHaveLength(0);
    expect(sent("transition")).toHaveLength(0);
  });

  it("the lock itself fails: a result, busy cleared, nothing closed or written", async () => {
    await page("u-lock");
    await put(DOWNLOADED);
    define("locks", {
      request: async () => {
        throw new DOMException("locks broken", "InvalidStateError");
      },
    });
    const r = await updateNow();
    expect(r).toEqual({
      ok: false,
      reasons: [{ code: "update_metadata_failed", detail: "locks broken" }],
    });
    expect(admission.isClosed()).toBe(false);
    expect(useUpdateStore.getState().busy).toBeNull();
    expect(await stored()).toEqual(DOWNLOADED);
  });
});

describe("R06-02: an unreadable update record is never written, in every path", () => {
  const pointerFetch = vi.fn(async (url: RequestInfo | URL) =>
    String(url).endsWith("release.json")
      ? new Response(JSON.stringify({ release_id: C, descriptor_sha256: "c".repeat(64) }))
      : new Response("{}", { status: 404 }),
  );

  /** Every update entry point of an open page; the record stays exactly as stored after each. */
  async function everyEntryPoint(exact: () => Promise<void>): Promise<void> {
    pointerFetch.mockClear();
    expect(await checkForUpdate(pointerFetch as unknown as typeof fetch)).toBeNull();
    await exact();
    expect(await downloadCandidate(pointerFetch as unknown as typeof fetch)).toBeNull();
    await exact();
    await later();
    await exact();
    expect(await updateNow()).toEqual({
      ok: false,
      reasons: [{ code: "update_state_unknown", detail: "" }],
    });
    await exact();
    await resumeConsented();
    await exact();
    // Only the pointer was read; no descriptor, no download, no registration, no freeze.
    expect(pointerFetch.mock.calls.map((c) => String(c[0]))).toEqual(["/release.json"]);
    expect(register).not.toHaveBeenCalled();
    expect(sent("freeze")).toHaveLength(0);
    expect(useUpdateStore.getState()).toMatchObject({ busy: null, unreadable: true, state: null });
  }

  it("another schema with a barrier: read only at two starts, a frozen page fails closed, every entry point leaves it exact", async () => {
    await page("u-future");
    const raw = {
      schema: "future-update/2",
      barrier: { request_id: "u-future", target_release: B, owner: { id: "x", n: [1, 2] } },
      consent: { release_id: B, extra: true },
      opaque: "preserve",
    };
    await put(raw);
    const json = JSON.stringify(raw);
    const exact = async () => {
      const v = await stored();
      expect(v).toEqual(raw);
      expect(JSON.stringify(v)).toBe(json);
    };
    const session = memorySession();
    expect(await updateBootGate({ session })).toBe("read_only");
    expect(useUpdateStore.getState()).toMatchObject({
      readOnly: true,
      unreadable: true,
      state: null,
    });
    await exact();
    freshPage();
    expect(await updateBootGate({ session })).toBe("read_only");
    await exact();

    // A frozen page (another window's request) gets the lock and finds it: closed, nothing written.
    freshPage();
    deliver({
      proto: UPDATE_PROTO,
      type: "freeze",
      request_id: "u-other",
      source_client_id: "owner",
      to: null,
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(useAdmission.getState().closed).toEqual({ by: "reload", request_id: null });
    expect(useUpdateStore.getState().readOnly).toBe(true);
    await exact();

    // The entry points (as if this page were open): none writes, none proceeds.
    freshPage();
    await everyEntryPoint(exact);
  });

  it("a malformed record without a barrier: the game opens, updates paused, the record never written", async () => {
    await page("u-malformed");
    const raw = {
      schema: UPDATE_SCHEMA,
      phase: 42,
      active_release: A,
      barrier: null,
      extra: "keep",
    };
    await put(raw);
    const exact = async () => expect(JSON.stringify(await stored())).toBe(JSON.stringify(raw));
    expect(await updateBootGate({ session: memorySession() })).toBe("open");
    expect(useUpdateStore.getState()).toMatchObject({
      readOnly: false,
      unreadable: true,
      state: null,
    });
    await exact();
    await everyEntryPoint(exact);
    expect(admission.isClosed()).toBe(false);
  });

  it("a valid record with a stale barrier still recovers normally (cleared, consent kept, thawed)", async () => {
    await page("u-valid");
    const valid: UpdateState = {
      ...DOWNLOADED,
      phase: "gating",
      consent: { release_id: B, at: 1, request_id: "u-old" },
      barrier: { request_id: "u-old", owner_client_id: "gone", target_release: B, since: 1 },
    };
    await put(valid);
    expect(await updateBootGate({ session: memorySession() })).toBe("open");
    expect(await stored()).toMatchObject({
      phase: "consented",
      barrier: null,
      consent: valid.consent,
      last_error: { code: "owner_lost", detail: "u-old" },
    });
    expect(sent("thaw").map((m) => m.request_id)).toEqual(["u-old"]);
    expect(useUpdateStore.getState()).toMatchObject({ readOnly: false, unreadable: false });
  });
});
