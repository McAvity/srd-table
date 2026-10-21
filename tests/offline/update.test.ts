/**
 * kenli F-007 T05: the update protocol's page side and the recovery rule, at UNIT level (labeled:
 * a fake ServiceWorkerContainer stands in for the browser; the real multi-window behaviour with
 * real service workers, Client.id stamps and Web Locks is scripts/f007-update-probe.mjs).
 *  - decideRecovery over every observation × stored state: an incoherent page never opens or
 *    clears; only the agreed waiting release is completed; anything else waiting fails closed.
 *  - a freeze from another client closes the admission gate and answers `frozen` to that client
 *    with what isn't saved; a thaw of another request opens nothing, the same request opens;
 *    `controllerchange` closes the gate until a reload.
 */

import { afterAll, describe, expect, it } from "vitest";
import { admission, resetAdmission } from "@/offline/admission";
import { UPDATE_PROTO } from "@/offline/sw-core";
import {
  coherent,
  decideRecovery,
  type Observed,
  startUpdateProtocol,
  useUpdateStore,
} from "@/offline/update";
import { Installations } from "../localCopy/helpers";

const A = "r-aaaaaaaaaaaaaaaa";
const B = "r-bbbbbbbbbbbbbbbb";
const C = "r-cccccccccccccccc";

describe("decideRecovery: one rule for every observation (offline.md §7.5)", () => {
  it("never opens or clears an incoherent page; completes only the agreed waiting release", () => {
    const values = [null, A, B, C, "unknown"];
    const states = [
      { barrier: null, consent: null },
      {
        barrier: { request_id: "u-1", owner_client_id: "o", target_release: B, since: 1 },
        consent: { release_id: B, at: 1, request_id: "u-1" },
      },
      {
        barrier: { request_id: "u-1", owner_client_id: "o", target_release: B, since: 1 },
        consent: { release_id: C, at: 1, request_id: "u-1" },
      },
      { barrier: null, consent: { release_id: B, at: 1, request_id: "u-1" } },
    ];
    let n = 0;
    for (const exec of [A, B])
      for (const active of values)
        for (const waiting of values)
          for (const installing of values)
            for (const controller of values)
              for (const state of states) {
                const o: Observed = { exec, active, waiting, installing, controller };
                const d = decideRecovery(o, state);
                n++;
                if (!coherent(o))
                  expect(["open", "clear"], JSON.stringify({ o, d })).not.toContain(d);
                if (d === "complete") {
                  expect(o.waiting).toBe(state.barrier?.target_release);
                  expect(state.consent?.release_id).toBe(o.waiting);
                }
                if (o.waiting && !o.installing && d !== "reload" && d !== "complete")
                  expect(d).toBe("fail_closed");
                if (coherent(o)) expect(d).toBe(state.barrier ? "clear" : "open");
              }
    expect(n).toBe(2 * 5 * 5 * 5 * 5 * 4);
  });
});

/** A fake service worker container: one active worker that records what the page posts. */
function fakeContainer() {
  const target = new EventTarget();
  const posted: Record<string, unknown>[] = [];
  const active = {
    scriptURL: `http://x/sw-${A}.js`,
    state: "activated",
    postMessage: (m: Record<string, unknown>) => {
      posted.push(m);
      if (m.type === "hello") deliver({ proto: UPDATE_PROTO, type: "welcome", client_id: "me" });
    },
  };
  const deliver = (data: unknown) =>
    target.dispatchEvent(Object.assign(new Event("message"), { data }));
  const container = Object.assign(target, {
    controller: active,
    getRegistration: async () => ({ active, waiting: null, installing: null }),
    startMessages: () => {},
  });
  return { container, posted, deliver };
}

const inst = new Installations();
afterAll(() => inst.close());

describe("the page side of the protocol (fake container, labeled)", () => {
  it("freeze → gate closed and a frozen answer to the owner; stale thaw ignored; same thaw opens; controllerchange closes until reload", async () => {
    await inst.open("P1");
    resetAdmission();
    const fake = fakeContainer();
    Object.defineProperty(navigator, "serviceWorker", {
      value: fake.container,
      configurable: true,
    });
    startUpdateProtocol();
    await new Promise((r) => setTimeout(r, 20));
    fake.deliver({
      proto: UPDATE_PROTO,
      type: "freeze",
      request_id: "u-1",
      source_client_id: "owner",
      to: null,
    });
    expect(admission.isClosed()).toBe(true);
    await new Promise((r) => setTimeout(r, 400));
    const frozen = fake.posted.find((m) => m.type === "frozen");
    expect(frozen).toMatchObject({ type: "frozen", to: "owner", request_id: "u-1", ok: true });
    // a late thaw of another request opens nothing
    fake.deliver({
      proto: UPDATE_PROTO,
      type: "thaw",
      request_id: "u-0",
      source_client_id: "owner",
    });
    expect(admission.isClosed()).toBe(true);
    fake.deliver({
      proto: UPDATE_PROTO,
      type: "thaw",
      request_id: "u-1",
      source_client_id: "owner",
    });
    expect(admission.isClosed()).toBe(false);
    expect(useUpdateStore.getState().frozen).toBeNull();
    // our own freeze (we are the owner) doesn't freeze us
    fake.deliver({
      proto: UPDATE_PROTO,
      type: "freeze",
      request_id: "u-2",
      source_client_id: "me",
    });
    expect(admission.isClosed()).toBe(false);
    // another release took control: no more mutations until a reload
    fake.container.dispatchEvent(new Event("controllerchange"));
    expect(admission.isClosed()).toBe(true);
    expect(useUpdateStore.getState().needsReload).toBe(true);
    expect(admission.open(null)).toBe(false);
  }, 60_000);
});
