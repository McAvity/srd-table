/**
 * kenli F-007 T04: the boot order and the minimal update boot gate (contract offline.md §5.1,
 * §2.7.6, §7.5; the full gate is T05's). The gate runs before ANY game-data write: with a closed
 * gate the real `loadAll` (migrations, installation id, stored packs, campaign catalog), the
 * autosave and `persistBundled` never run and the database stays empty. Real store and fake
 * IndexedDB; registrations are labeled fakes of `observeRelease()`.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { startGameData } from "@/offline/boot";
import {
  type BootDecision,
  decideRecovery,
  emptyState,
  type Observed,
  updateBootGate,
} from "@/offline/update";
import { db } from "@/persistence/db";
import { loadAll, persistBundled, startAutosave } from "@/persistence/sync";
import { resetStores } from "../helpers/app";
import { engineWithDice } from "../helpers/transfer";

const A = "r-aaaaaaaaaaaaaaaa";
const B = "r-bbbbbbbbbbbbbbbb";
const seen = (o: Partial<Observed> = {}): Observed => ({
  exec: A,
  active: null,
  waiting: null,
  installing: null,
  controller: null,
  ...o,
});
let stop: (() => void) | null = null;
afterEach(() => {
  stop?.();
  stop = null;
});

describe("the boot order: the gate before any game-data write", () => {
  it.each<BootDecision>(["waiting", "reload", "read_only"])(
    "gate %s: nothing loads, nothing is written",
    async (decision) => {
      await resetStores();
      engineWithDice();
      const calls: string[] = [];
      const r = await startGameData({
        gate: async () => {
          calls.push("gate");
          return decision;
        },
        load: async () => {
          calls.push("load");
          await loadAll();
        },
        autosave: () => calls.push("autosave"),
        bundled: async () => calls.push("bundled"),
      });
      expect(r).toBe(decision);
      expect(calls).toEqual(["gate"]);
      const database = await db();
      expect(await database.getAllKeys("settings")).toEqual([]); // no installation id
      expect(await database.count("packs")).toBe(0);
      expect(await database.count("characters")).toBe(0);
    },
  );

  it("gate open: load, then the locale, the autosave and the served SRD, in that order", async () => {
    await resetStores();
    engineWithDice();
    const calls: string[] = [];
    const r = await startGameData({
      gate: async () => {
        calls.push("gate");
        return "open";
      },
      load: async () => {
        calls.push("load");
        await loadAll();
      },
      afterLoad: async () => {
        calls.push("afterLoad");
      },
      autosave: () => {
        calls.push("autosave");
        stop = startAutosave();
      },
      bundled: async () => {
        calls.push("bundled");
        return persistBundled();
      },
    });
    expect(r).toBe("open");
    expect(calls).toEqual(["gate", "load", "afterLoad", "autosave", "bundled"]);
    await vi.waitFor(async () =>
      expect((await (await db()).getAllKeys("settings")).includes("installation")).toBe(true),
    );
  });
});

describe("the boot gate's decision (offline.md §7.5, decideRecovery)", () => {
  const none = { barrier: null, consent: null };
  const barrier = (target: string) => ({
    barrier: { request_id: "u-1", owner_client_id: "x", target_release: target, since: 1 },
    consent: { release_id: target, at: 1, request_id: "u-1" },
  });
  it("one rule from what this page executes and what the base has registered", () => {
    expect(decideRecovery(seen(), none)).toBe("open");
    expect(decideRecovery(seen({ active: A, controller: A }), none)).toBe("open");
    // first explicit registration: active A, this page not controlled yet — coherent
    expect(decideRecovery(seen({ active: A }), none)).toBe("open");
    expect(decideRecovery(seen({ installing: B }), barrier(B))).toBe("wait");
    expect(decideRecovery(seen({ active: B }), none)).toBe("reload");
    expect(decideRecovery(seen({ active: "unknown" }), none)).toBe("reload");
    expect(decideRecovery(seen({ active: A, controller: B }), none)).toBe("reload");
    expect(decideRecovery(seen({ active: A, waiting: B }), barrier(B))).toBe("complete");
    expect(decideRecovery(seen({ active: A, waiting: B }), barrier("r-cccccccccccccccc"))).toBe(
      "fail_closed",
    );
    expect(decideRecovery(seen({ active: A, waiting: B }), none)).toBe("fail_closed");
    expect(decideRecovery(seen({ active: A }), barrier(B))).toBe("clear");
    expect(decideRecovery(seen({ exec: B, active: B, controller: B }), barrier(B))).toBe("clear");
  });

  it("reloads once for a mismatch, then stays read-only; an open start clears the guard", async () => {
    const store = new Map<string, string>();
    const session = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
    const read = async () => ({ state: emptyState(A), unreadable: false });
    const mismatch = async () => seen({ active: B });
    expect(await updateBootGate({ observe: mismatch, read, session })).toBe("reload");
    expect(await updateBootGate({ observe: mismatch, read, session })).toBe("read_only");
    expect(await updateBootGate({ observe: async () => seen({ active: A }), read, session })).toBe(
      "open",
    );
    expect(store.size).toBe(0);
    expect(await updateBootGate({ observe: mismatch, read, session })).toBe("reload");
  });

  it("a stored barrier is decided under the update lock (none in jsdom: fail closed, read only)", async () => {
    await resetStores();
    await (await db()).put(
      "settings",
      {
        ...emptyState(A),
        barrier: { request_id: "u-1", owner_client_id: "x", target_release: B, since: 1 },
      },
      "offline.update.v1",
    );
    expect(await updateBootGate({ observe: async () => seen({ active: A, controller: A }) })).toBe(
      "read_only",
    );
    await (await db()).put("settings", { ...emptyState(A), barrier: null }, "offline.update.v1");
    expect(await updateBootGate({ observe: async () => seen({ active: A, controller: A }) })).toBe(
      "open",
    );
  });
});
