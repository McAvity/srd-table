/**
 * kenli F-007 T05 (R06-01): the asynchronous settings changes (`setContent`, `setDevSeed`) are
 * admitted operations as a whole, on the real stores and IndexedDB: one started before the gate
 * closes is counted until its `set`, so `savedReasons()` waits for it (or says
 * `operation_in_flight` when the time is up) and only then flushes — never a saved answer while
 * it is still pending or unsaved. With the gate closed a new change is refused with no side
 * effect: no engine call, no setting, nothing written.
 */

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { admission, resetAdmission } from "@/offline/admission";
import { savedReasons } from "@/offline/gates";
import { db } from "@/persistence/db";
import { flushNow, unsavedSettings } from "@/persistence/sync";
import { useSettings } from "@/store/settings";
import { dumpDb, Installations } from "../localCopy/helpers";

const inst = new Installations();
afterEach(() => {
  vi.restoreAllMocks();
  resetAdmission();
});
afterAll(() => inst.close());

/** A promise and its release. */
function held(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((r) => {
    release = r;
  });
  return { promise, release };
}

const storedSettings = async () => {
  const database = await db();
  return (await database.getAll("settings")).find(
    (v) => typeof v === "object" && v !== null && "packs" in v && "sources" in v,
  ) as { packs: string[]; sources: string[] | null; dev_seed: number | null } | undefined;
};

const settled = <T>(p: Promise<T>) => {
  let done = false;
  void p.then(() => {
    done = true;
  });
  return () => done;
};

describe("settings changes started before a freeze are drained, then saved (R06-01)", () => {
  it("setContent: counted while pending; time up → operation_in_flight; drain waits, then flush saves it", async () => {
    await inst.open("settings-content");
    resetAdmission();
    await flushNow();
    const gate = held();
    vi.spyOn(inst.fx.engine, "configureCampaign").mockImplementation(async () => {
      await gate.promise;
      return true;
    });
    const pending = useSettings.getState().setContent(["srd-5.2.1"], ["srd"]);
    expect(admission.inFlight()).toBe(1);
    admission.close("owner", "u-r0601");
    // A short wait ends with the reason, not a saved answer.
    expect(await savedReasons(5)).toEqual([{ code: "operation_in_flight", detail: "1" }]);
    // A full wait does not answer before the change is done.
    const reasons = savedReasons(10_000);
    const answered = settled(reasons);
    await new Promise((r) => setTimeout(r, 30));
    expect(answered()).toBe(false);
    gate.release();
    await pending;
    expect(await reasons).toEqual([]);
    // The answer came after the change and its save.
    expect(unsavedSettings()).toBe(false);
    expect(useSettings.getState().settings.sources).toEqual(["srd"]);
    expect((await storedSettings())?.sources).toEqual(["srd"]);
    expect(admission.inFlight()).toBe(0);
  });

  it("setDevSeed: the same — the drain waits for the engine call and its set, the flush saves it", async () => {
    await inst.open("settings-seed");
    resetAdmission();
    await flushNow();
    const gate = held();
    vi.spyOn(inst.fx.engine, "setSeed").mockImplementation(async () => {
      await gate.promise;
    });
    const pending = useSettings.getState().setDevSeed(4242);
    expect(admission.inFlight()).toBe(1);
    admission.close("owner", "u-r0601b");
    expect(await savedReasons(5)).toEqual([{ code: "operation_in_flight", detail: "1" }]);
    const reasons = savedReasons(10_000);
    const answered = settled(reasons);
    await new Promise((r) => setTimeout(r, 30));
    expect(answered()).toBe(false);
    gate.release();
    await pending;
    expect(await reasons).toEqual([]);
    expect(unsavedSettings()).toBe(false);
    expect((await storedSettings())?.dev_seed).toBe(4242);
  });

  it("a failing change still ends its count (the drain is not stuck)", async () => {
    await inst.open("settings-fail");
    resetAdmission();
    vi.spyOn(inst.fx.engine, "configureCampaign").mockRejectedValue(new Error("worker gone"));
    await expect(useSettings.getState().setContent(["srd-5.2.1"], ["srd"])).rejects.toThrow(
      "worker gone",
    );
    expect(admission.inFlight()).toBe(0);
    expect(useSettings.getState().settings.sources).toBeNull();
    expect(await admission.drain(5)).toBe(true);
  });

  it("closed gate: setContent and setDevSeed refused — no engine call, no setting, nothing written", async () => {
    await inst.open("settings-closed");
    resetAdmission();
    await flushNow();
    const configure = vi.spyOn(inst.fx.engine, "configureCampaign");
    const seed = vi.spyOn(inst.fx.engine, "setSeed");
    const before = await dumpDb();
    const settings = useSettings.getState().settings;
    admission.close("owner", "u-closed");
    await expect(useSettings.getState().setContent(["srd-5.2.1"], ["srd"])).resolves.toBe(
      undefined,
    );
    await expect(useSettings.getState().setDevSeed(7)).resolves.toBe(undefined);
    expect(configure).not.toHaveBeenCalled();
    expect(seed).not.toHaveBeenCalled();
    expect(admission.inFlight()).toBe(0);
    expect(useSettings.getState().settings).toBe(settings);
    expect(unsavedSettings()).toBe(false);
    await flushNow();
    expect(await dumpDb()).toBe(before);
  });

  it("open gate: setContent and setDevSeed apply as before", async () => {
    await inst.open("settings-open");
    resetAdmission();
    await useSettings.getState().setContent(["srd-5.2.1"], ["srd"]);
    await useSettings.getState().setDevSeed(11);
    expect(useSettings.getState().settings).toMatchObject({
      packs: ["srd-5.2.1"],
      sources: ["srd"],
      dev_seed: 11,
    });
    expect(await savedReasons()).toEqual([]);
    expect(await storedSettings()).toMatchObject({ sources: ["srd"], dev_seed: 11 });
  });
});
