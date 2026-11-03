/**
 * kenli F-002 T07 (dnd5 contracts/progression.md §10): a character following a plan is ready
 * offline only when every pack of its plan is stored here as a row. The served SRD alone (in this
 * session's memory, from the host) is not enough; Prepare offline stores it with its exact bytes.
 * A plan pack the host doesn't serve (a private or add-on pack) can't be prepared: it stays
 * missing until it is brought (Import…), and nothing else is written. Synthetic/SRD plans only.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkReadiness,
  prepareOffline,
  type ReleaseApi,
  setReleaseApi,
} from "@/offline/readiness";
import type { Inspection } from "@/offline/release";
import { db, packKey } from "@/persistence/db";
import { flushNow } from "@/persistence/sync";
import { startFromPlan } from "@/progression/advance";
import { useDocuments } from "@/store/documents";
import { installTestEngine } from "../helpers/app";
import { Installations, type Loose } from "../localCopy/helpers";
import { FIXTURE_DIR } from "../progression/generate-fixtures";

installTestEngine(9);
const RID = "r-0123456789abcdef";
const inst = new Installations();
const read = (name: string): Loose => JSON.parse(readFileSync(join(FIXTURE_DIR, name), "utf8"));
const granted = async () => "granted" as const;

beforeEach(() => {
  const inspection = (): Inspection => ({ release_id: RID, complete: true, missing: [] });
  const api: ReleaseApi = {
    releaseId: RID,
    isRelease: true,
    inspect: async () => inspection(),
    prepare: async () => inspection(),
    controller: () => RID,
  };
  setReleaseApi(api);
});
afterEach(() => setReleaseApi(null));
afterAll(() => inst.close());

const planItems = (r: {
  items: readonly { id: string; status: string; detail: string | null }[];
}) => r.items.filter((i) => i.id.startsWith("plan:")).map((i) => [i.id, i.status, i.detail]);

async function planned(name: string) {
  await inst.open(name);
  const file = read("pool-feat-1-6.plan.json");
  const r = await startFromPlan(file, 3);
  if (!r.ok) throw new Error(r.code);
  await flushNow();
  const [srd, pool] = file.plan.packs as Loose[];
  return { id: r.id, srd: packKey(srd), pool: packKey(pool) };
}

describe("readiness of a character following a plan", () => {
  it("prepared, every plan pack stored: ready", async () => {
    const { id, srd, pool } = await planned("R7-1");
    await prepareOffline({ kind: "character", id }, { storage: granted });
    const r = await checkReadiness({ kind: "character", id });
    expect(planItems(r)).toEqual([
      [`plan:${srd}`, "ok", null],
      [`plan:${pool}`, "ok", null],
    ]);
    expect(r.items.filter((i) => i.status !== "ok")).toEqual([]);
    expect(r.status).toBe("ready");
  }, 60_000);

  it("the SRD only served (no row): incomplete; Prepare offline stores it with its exact bytes → ready", async () => {
    const { id, srd } = await planned("R7-2");
    await prepareOffline({ kind: "character", id }, { storage: granted });
    // The row gone, the SRD still in this session's memory (and served): only the plan says no.
    await (await db()).delete("packs", srd);
    const r = await checkReadiness({ kind: "character", id });
    expect(r.items.filter((i) => i.status !== "ok").map((i) => [i.id, i.detail])).toEqual([
      [`plan:${srd}`, "plan_pack_unstored"],
    ]);
    expect(r.status).toBe("incomplete");
    const p = await prepareOffline({ kind: "character", id }, { storage: granted });
    expect(await (await db()).get("packs", srd)).toBeTruthy();
    expect(p.status).toBe("ready");
  }, 60_000);

  it("a plan pack the host doesn't serve, without its row: stays incomplete; nothing else written", async () => {
    const { id, pool } = await planned("R7-3");
    await (await db()).delete("packs", pool);
    const before = (await (await db()).getAllKeys("packs")) as string[];
    const p = await prepareOffline({ kind: "character", id }, { storage: granted });
    expect(planItems(p)).toContainEqual([`plan:${pool}`, "missing", "plan_pack_unstored"]);
    expect(p.status).toBe("incomplete");
    expect((await (await db()).getAllKeys("packs")) as string[]).toEqual(before);
    expect(useDocuments.getState().characters[id]).toBeTruthy();
  }, 60_000);
});

describe("kenli F-002 T13a: a character following a guided plan (/2)", () => {
  it("started with its kit: prepared offline, ready, the plan and its guide kept exactly", async () => {
    await inst.open("R7-guided");
    const file = read("pool-feat-1-6.plan.json");
    file.format = "srd-table.progression-plan/2";
    file.plan.guide = {
      kits: [
        {
          from_level: 1,
          title: "Kit",
          items: [{ item: "whip", units: 1, equip: false, origin: "author" }],
          origin: "author",
        },
      ],
      play: { base: { text: "Base.", origin: "author" }, levels: [] },
      purchases: [],
      alternatives: [],
      controls: [],
    };
    const { contentSha } = await import("@/lib/canonical");
    file.plan_sha256 = await contentSha(file.plan);
    const r = await startFromPlan(file, 3, { kit: true });
    if (!r.ok) throw new Error(`${r.code} ${r.detail}`);
    await flushNow();
    await prepareOffline({ kind: "character", id: r.id }, { storage: granted });
    const ready = await checkReadiness({ kind: "character", id: r.id });
    expect(ready.items.filter((i) => i.status !== "ok")).toEqual([]);
    expect(ready.status).toBe("ready");
    const progression = (useDocuments.getState().characters[r.id] as Loose).progression;
    expect(progression.plan.format).toBe("srd-table.progression-plan/2");
    expect(JSON.stringify(progression.plan.plan.guide)).toBe(JSON.stringify(file.plan.guide));
  }, 60_000);
});
