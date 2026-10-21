/**
 * kenli F-007 T04: the boot order and the minimal update boot gate (contract offline.md §5.1,
 * §2.7.6, §7.5; the full gate is T05's). The gate runs before ANY game-data write: with a closed
 * gate the real `loadAll` (migrations, installation id, stored packs, campaign catalog), the
 * autosave and `persistBundled` never run and the database stays empty. Real store and fake
 * IndexedDB; registrations are labeled fakes of `observeRelease()`.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { startGameData } from "@/offline/boot";
import { type BootDecision, decideBoot, type Observed, updateBootGate } from "@/offline/update";
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

describe("the minimal update boot gate (fail closed; never registers, activates or clears)", () => {
  it("decides from what this page executes and what the base has registered", () => {
    expect(decideBoot(seen(), false, false)).toBe("open");
    expect(decideBoot(seen({ active: A, controller: A }), false, false)).toBe("open");
    // first explicit registration: active A, this page not controlled yet — coherent
    expect(decideBoot(seen({ active: A }), false, false)).toBe("open");
    expect(decideBoot(seen({ installing: B }), false, false)).toBe("waiting");
    expect(decideBoot(seen({ active: B }), false, false)).toBe("reload");
    expect(decideBoot(seen({ active: B }), false, true)).toBe("read_only");
    expect(decideBoot(seen({ active: "unknown" }), false, false)).toBe("reload");
    expect(decideBoot(seen({ active: A, controller: B }), false, false)).toBe("reload");
    expect(decideBoot(seen({ active: A, waiting: B }), false, false)).toBe("read_only");
    expect(decideBoot(seen({ active: A }), true, false)).toBe("read_only");
  });

  it("reloads once for a mismatch, then stays read-only; an open start clears the guard", async () => {
    const store = new Map<string, string>();
    const session = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
    const mismatch = async () => seen({ active: B });
    const none = async () => false;
    expect(await updateBootGate({ observe: mismatch, barrier: none, session })).toBe("reload");
    expect(await updateBootGate({ observe: mismatch, barrier: none, session })).toBe("read_only");
    expect(
      await updateBootGate({ observe: async () => seen({ active: A }), barrier: none, session }),
    ).toBe("open");
    expect(store.size).toBe(0);
    expect(await updateBootGate({ observe: mismatch, barrier: none, session })).toBe("reload");
  });

  it("a barrier stored by an update in progress keeps the game closed (read only)", async () => {
    await resetStores();
    await (await db()).put(
      "settings",
      { schema: "srd-table.update-state/1", barrier: { request_id: "u-1" } },
      "offline.update.v1",
    );
    expect(await updateBootGate({ observe: async () => seen({ active: A, controller: A }) })).toBe(
      "read_only",
    );
    await (await db()).put(
      "settings",
      { schema: "srd-table.update-state/1", barrier: null },
      "offline.update.v1",
    );
    expect(await updateBootGate({ observe: async () => seen({ active: A, controller: A }) })).toBe(
      "open",
    );
  });
});
