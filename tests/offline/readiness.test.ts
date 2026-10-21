/**
 * kenli F-007 T04: readiness and preparation (contract offline.md §5.3–§5.5) on the real store,
 * autosave, in-process engine (the real SRD) and fake IndexedDB, each "installation" its own
 * database. The app release is a labeled fake of the T02 API (no service worker in jsdom): its
 * inspection and `prepare()` (the same-release `prepareCurrentRelease`) are recorded; the real
 * worker/cache behaviour is `scripts/f007-readiness-probe.mjs`.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { campaignContext } from "@/import/export";
import { exportLocalCopy } from "@/import/localCopy/export";
import { packRefOf } from "@/lib/canonical";
import {
  CAMPAIGN_CONTEXT_KEY,
  parsePrepared,
  preparedCampaign,
  readCampaignContext,
} from "@/offline/campaign";
import {
  checkReadiness,
  prepareOffline,
  type ReleaseApi,
  readinessKey,
  setReleaseApi,
} from "@/offline/readiness";
import type { Inspection } from "@/offline/release";
import { STORAGE_KEY } from "@/offline/storage";
import { db, packKey } from "@/persistence/db";
import { flushNow } from "@/persistence/sync";
import { useDocuments } from "@/store/documents";
import { useHistory } from "@/store/history";
import { useSettings } from "@/store/settings";
import { rogue } from "../fixtures/characters";
import { TEST_PACK, testContext } from "../fixtures/player-actions";
import {
  addCharacter,
  dumpDb,
  Installations,
  type Loose,
  ok,
  storeTestPack,
} from "../localCopy/helpers";

const RID = "r-0123456789abcdef";
const inst = new Installations();
const docs = () => useDocuments.getState();

/** A fake of the T02 release API (labeled): complete or not, controlling the page or not. */
function fakeRelease(o: { complete?: boolean; controller?: string | null } = {}) {
  const state = {
    complete: o.complete ?? true,
    controller: o.controller === undefined ? RID : o.controller,
  };
  const inspection = (): Inspection => ({
    release_id: RID,
    complete: state.complete,
    missing: state.complete ? [] : ["assets/AboutPage-x.js"],
  });
  const api: ReleaseApi & { prepared: number; state: typeof state } = {
    releaseId: RID,
    isRelease: true,
    inspect: async () => inspection(),
    prepare: async () => {
      api.prepared++;
      state.complete = true; // the same release, restored in place
      return inspection();
    },
    controller: () => state.controller,
    prepared: 0,
    state,
  };
  setReleaseApi(api);
  return api;
}

const granted = async () => "granted" as const;
const item = (
  r: { items: readonly { kind: string; id: string; status: string; detail: string | null }[] },
  kind: string,
) => r.items.filter((i) => i.kind === kind);

beforeEach(() => {
  fakeRelease();
});
afterEach(() => {
  vi.restoreAllMocks();
  setReleaseApi(null);
});
afterAll(() => inst.close());

describe("a legacy character (the campaign's packs)", () => {
  it("unprepared → incomplete; prepared → the exact context stored and used everywhere; reload keeps it; other settings invalidate", async () => {
    await inst.open("L1");
    const id = await addCharacter(await rogue(inst.fx.engine, 3), null, inst.fx.engine);
    const before = await checkReadiness({ kind: "character", id });
    expect(before.status).toBe("incomplete");
    expect(item(before, "pack")).toEqual([
      { kind: "pack", id: "campaign", status: "missing", detail: "campaign_unprepared" },
    ]);
    const r = await prepareOffline({ kind: "character", id }, { storage: granted });
    expect(r.status).toBe("ready");
    expect(r.legacy_settings_fingerprint).toMatch(/^[0-9a-f]{64}$/);
    const stored = parsePrepared(await (await db()).get("settings", CAMPAIGN_CONTEXT_KEY));
    expect(stored?.packs).toEqual(["srd-5.2.1"]);
    expect(stored?.release_id).toBe(RID);
    const srd = await inst.fx.engine.servedPack("srd-5.2.1");
    expect(stored?.context.packs).toEqual([srd]);
    expect(await (await db()).get("packs", packKey(srd))).toBeDefined();
    expect(docs().characters[id]?.content).toBeUndefined(); // the record isn't pinned
    expect((await (await db()).get("settings", readinessKey(id))) as Loose).toMatchObject({
      status: "ready",
    });
    expect((await (await db()).get("settings", STORAGE_KEY)) as Loose).toMatchObject({
      persisted: "granted",
    });

    // a new start reads it back; exports use exactly it, without asking the host
    await inst.reload();
    fakeRelease();
    expect(preparedCampaign()?.context).toEqual(stored?.context);
    const served = vi.spyOn(inst.fx.engine, "servedPack");
    expect(await campaignContext()).toEqual(stored?.context);
    const copy = ok(await exportLocalCopy(id)).copy;
    expect(copy.payload.character.context).toEqual(stored?.context);
    expect(served).not.toHaveBeenCalled();
    expect((await checkReadiness({ kind: "character", id })).status).toBe("ready");

    // other settings: unused (incomplete), never "the latest"; the same settings again: used again
    await useSettings.getState().setContent(["srd-5.2.1"], ["srd"]);
    expect((await readCampaignContext(useSettings.getState().settings)).matches).toBe(false);
    expect((await checkReadiness({ kind: "character", id })).status).toBe("incomplete");
    await useSettings.getState().setContent(["srd-5.2.1"], null);
    await flushNow();
    expect((await checkReadiness({ kind: "character", id })).status).toBe("ready");
    expect(docs().characters[id]?.content).toBeUndefined();
  }, 60_000);

  it("a stored row with the same pack version and other bytes: failed, nothing replaced or written", async () => {
    await inst.open("L2");
    const id = await addCharacter(await rogue(inst.fx.engine, 3), null, inst.fx.engine);
    const srd = await inst.fx.engine.servedPack("srd-5.2.1");
    const database = await db();
    for (const k of await database.getAllKeys("packs")) await database.delete("packs", k);
    const other = { ...srd, sha256: "e".repeat(64) };
    await database.add("packs", {
      key: packKey(other),
      ref: other,
      files: { "manifest.json": { manifest: { id: "srd-5.2.1", version: "5.2.1" }, tables: {} } },
      installed_at: 1,
      origin: { kind: "bundled" },
    });
    const packsBefore = await database.getAllKeys("packs");
    const r = await prepareOffline({ kind: "character", id }, { storage: granted });
    expect(r.status).toBe("failed");
    expect(r.items.find((i) => i.id === "campaign" && i.status === "failed")?.detail).toMatch(
      /^pack_identity_conflict/,
    );
    expect(await (await db()).getAllKeys("packs")).toEqual(packsBefore);
    expect(await (await db()).get("settings", CAMPAIGN_CONTEXT_KEY)).toBeUndefined();
  }, 60_000);

  it("a full storage or a cancel during preparation keeps everything that was there", async () => {
    await inst.open("L3");
    const id = await addCharacter(await rogue(inst.fx.engine, 3), null, inst.fx.engine);
    const database = await db();
    for (const k of await database.getAllKeys("packs")) await database.delete("packs", k);
    const before = await dumpDb();
    const put = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (
      this: IDBObjectStore,
      ...args
    ) {
      if (this.name === "packs") throw new DOMException("full", "QuotaExceededError");
      return put.apply(this, args as Parameters<typeof put>);
    });
    const r = await prepareOffline({ kind: "character", id }, { storage: granted });
    expect(r.items.find((i) => i.id === "campaign")?.detail).toMatch(/^storage_quota/);
    vi.restoreAllMocks();
    const after = JSON.parse(await dumpDb());
    const was = JSON.parse(before);
    expect(after.characters).toEqual(was.characters);
    expect(after.packs).toEqual(was.packs);
    expect(after.settings).not.toContain(CAMPAIGN_CONTEXT_KEY);
    // cancel before the content step: nothing of the campaign written either
    const controller = new AbortController();
    controller.abort();
    const c = await prepareOffline(
      { kind: "character", id },
      { signal: controller.signal, storage: granted },
    );
    expect(c.items.some((i) => i.detail === "cancelled")).toBe(true);
    expect(await (await db()).get("settings", CAMPAIGN_CONTEXT_KEY)).toBeUndefined();
  }, 60_000);
});

describe("pinned characters, damaged and missing exact packs", () => {
  it("a missing exact version stays missing (brought with Import…, never another version); the served SRD with these bytes is stored", async () => {
    await inst.open("P1");
    await storeTestPack();
    const ctx = await testContext(inst.fx.engine);
    const v2 = structuredClone(TEST_PACK) as Loose;
    v2["manifest.json"].manifest.version = "2.0.0";
    const ref2 = await packRefOf(v2);
    const pinned = { packs: [ctx.packs[0] as Loose, ref2], sources: null };
    const id = await addCharacter(await rogue(inst.fx.engine, 3), ctx, inst.fx.engine);
    useDocuments.setState((s) => ({
      characters: { ...s.characters, [id]: { ...(s.characters[id] as Loose), content: pinned } },
    }));
    await flushNow();
    const r = await prepareOffline({ kind: "character", id }, { storage: granted });
    expect(r.status).toBe("incomplete");
    expect(item(r, "pack").map((i) => [i.id, i.status, i.detail])).toEqual([
      [packKey(ctx.packs[0] as Loose), "ok", null],
      [packKey(ref2), "missing", "context_unavailable"],
    ]);
    // the 1.0.0 row is there; nothing took the place of 2.0.0
    const keys = (await (await db()).getAllKeys("packs")) as string[];
    expect(keys.some((k) => k.startsWith("test-actions@2.0.0#"))).toBe(false);
  }, 60_000);

  it("a damaged stored pack: corrupt after a reload, the prepared binding kept (unavailable, not the host's)", async () => {
    await inst.open("P2");
    const id = await addCharacter(await rogue(inst.fx.engine, 3), null, inst.fx.engine);
    expect((await prepareOffline({ kind: "character", id }, { storage: granted })).status).toBe(
      "ready",
    );
    const srd = preparedCampaign()?.context.packs[0] as Loose;
    const database = await db();
    const row = (await database.get("packs", packKey(srd))) as Loose;
    await database.put("packs", { ...row, files: { ...row.files, "spells.json": [] } });
    await inst.reload();
    fakeRelease();
    const r = await checkReadiness({ kind: "character", id });
    expect(r.status).toBe("incomplete");
    expect(item(r, "pack")[0]).toMatchObject({ status: "corrupt", detail: "pack_corrupt" });
    await expect(inst.fx.engine.packs()).rejects.toThrow(/context_unavailable/);
    // a retry with the host having these exact bytes restores the same identity
    expect((await prepareOffline({ kind: "character", id }, { storage: granted })).status).toBe(
      "ready",
    );
    expect((await inst.fx.engine.packs()).map((p) => p.id)).toEqual(["srd-5.2.1"]);
  }, 60_000);
});

describe("the app release and the saved state", () => {
  it("an incomplete release is incomplete; preparation restores the SAME release; uncontrolled until a reload", async () => {
    await inst.open("A1");
    const id = await addCharacter(await rogue(inst.fx.engine, 3), null, inst.fx.engine);
    const api = fakeRelease({ complete: false, controller: null });
    const before = await checkReadiness({ kind: "character", id }, { fresh: true });
    expect(item(before, "app")[0]).toMatchObject({
      status: "missing",
      detail: "assets/AboutPage-x.js",
    });
    const r = await prepareOffline({ kind: "character", id }, { storage: granted });
    expect(api.prepared).toBe(1);
    expect(r.status).toBe("checking");
    expect(item(r, "app")[0]).toMatchObject({ status: "pending", detail: "reload_to_finish" });
    api.state.controller = RID; // after the reload
    expect((await checkReadiness({ kind: "character", id }, { fresh: true })).status).toBe("ready");
  }, 60_000);

  it("a day not saved, a failed save, a conflict and unsaved settings are never ready", async () => {
    await inst.open("S1");
    const id = await addCharacter(await rogue(inst.fx.engine, 3), null, inst.fx.engine);
    expect((await prepareOffline({ kind: "character", id }, { storage: granted })).status).toBe(
      "ready",
    );
    const check = () => checkReadiness({ kind: "character", id });
    ok(useHistory.getState().startNextDay(id, "Camp"));
    expect(item(await check(), "history")[0]).toMatchObject({
      status: "pending",
      detail: "days_unsaved",
    });
    expect((await check()).status).toBe("checking");
    await flushNow();
    expect((await check()).status).toBe("ready");
    useSettings.getState().update({ theme: "felt" });
    expect(item(await check(), "save")[0]).toMatchObject({ detail: "settings_unsaved" });
    await flushNow();
    expect((await check()).status).toBe("ready");
    useHistory.getState().setSaveState({ status: "failed", reason: "labeled: a save that failed" });
    expect((await check()).status).toBe("failed");
    useHistory.getState().setSaveState({ status: "saved" });
    // a real conflict: another tab wrote the record
    const database = await db();
    await database.put("characters", {
      ...((await database.get("characters", id)) as Loose),
      rev: 50,
    });
    inst.fx.dice.push(10);
    ok(await docs().rollTest(id, { skill: "stealth" }));
    await flushNow();
    const c = await check();
    expect(c.status).toBe("failed");
    expect(item(c, "save")[0]).toMatchObject({ detail: "save_conflict" });
  }, 60_000);

  it("the storage protection is shown apart: denied or unsupported doesn't change a ready status", async () => {
    await inst.open("G1");
    const id = await addCharacter(await rogue(inst.fx.engine, 3), null, inst.fx.engine);
    const denied = await prepareOffline(
      { kind: "character", id },
      { storage: async () => "denied" },
    );
    expect(denied).toMatchObject({ status: "ready", storage: { persisted: "denied" } });
    const none = await prepareOffline(
      { kind: "character", id },
      { storage: async () => "unsupported" },
    );
    expect(none).toMatchObject({ status: "ready", storage: { persisted: "unsupported" } });
  }, 60_000);
});

describe("an encounter: its world and its whole party", () => {
  it("one ready member doesn't make the encounter ready", async () => {
    await inst.open("E1");
    const a = await addCharacter(await rogue(inst.fx.engine, 3), null, inst.fx.engine);
    const pinnedCtx = {
      packs: [{ id: "x-missing", version: "1.0.0", sha256: "a".repeat(64) }],
      sources: null,
    };
    const b = await addCharacter(await rogue(inst.fx.engine, 3), null, inst.fx.engine);
    const eid = await docs().createEncounter("Bridge");
    ok(
      await docs().encounterAction(eid, [
        { type: "add_character", character: a, id: "a" },
        { type: "add_character", character: b, id: "b" },
      ]),
    );
    await flushNow();
    expect((await prepareOffline({ kind: "character", id: a }, { storage: granted })).status).toBe(
      "ready",
    );
    expect((await checkReadiness({ kind: "encounter", id: eid })).status).toBe("ready");
    // b now pinned to a pack this device doesn't have: the encounter isn't ready, a still is
    useDocuments.setState((s) => ({
      characters: { ...s.characters, [b]: { ...(s.characters[b] as Loose), content: pinnedCtx } },
    }));
    await flushNow();
    const e = await checkReadiness({ kind: "encounter", id: eid });
    expect(e.status).toBe("incomplete");
    expect(item(e, "party").map((i) => [i.id, i.status])).toEqual([
      [a, "ok"],
      [b, "missing"],
    ]);
    expect((await checkReadiness({ kind: "character", id: a })).status).toBe("ready");
  }, 60_000);
});
