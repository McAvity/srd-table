/**
 * kenli F-002 T04: planned start, bind and advance through the real store, autosave and (fake)
 * IndexedDB — one installation per test, reloads included. Plans are the Table's own fixtures
 * (SRD and an invented pack). Checked: the played state, identity, name and declared packs kept;
 * one transaction, one publication, one undo step, one journal entry; every refusal leaves the
 * store, the database and the undo stack as they were.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CharacterBuild } from "srd-rules-engine";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalJson, contentSha } from "@/lib/canonical";
import { db, packKey } from "@/persistence/db";
import { journal } from "@/persistence/history";
import { flushNow, savedHead } from "@/persistence/sync";
import {
  type Confirmed,
  confirmHooks,
  confirmStep,
  detachProgression,
  type ProgressionRefusal,
  previewAdvance,
  previewBind,
  type StepPreview,
  startFromPlan,
} from "@/progression/advance";
import { mech } from "@/progression/prefix";
import { readProgression } from "@/progression/record";
import { useDocuments } from "@/store/documents";
import { useHistory } from "@/store/history";
import { useRolls } from "@/store/rolls";
import { useSettings } from "@/store/settings";
import { addCharacter, dumpDb, Installations, type Loose } from "../localCopy/helpers";
import { FIXTURE_DIR } from "./generate-fixtures";
import { clone, POOL_PACK, packEnvelope } from "./plans";

const read = (name: string): Loose => JSON.parse(readFileSync(join(FIXTURE_DIR, name), "utf8"));
const FIGHTER = () => read("fighter-1-6.plan.json");
const POOL = () => read("pool-feat-1-6.plan.json");
const docs = () => useDocuments.getState();
const rec = (id: string) =>
  docs().characters[id] as NonNullable<ReturnType<typeof docs>["characters"][string]>;
const inst = new Installations();
const SRD_CREATION = JSON.parse(
  readFileSync(
    join(FIXTURE_DIR, "../../../node_modules/srd-rules-engine/dist/srd-5.2.1/manifest.json"),
    "utf8",
  ),
).creation;

function must<T extends { ok: boolean }>(r: T | ProgressionRefusal): T {
  if (r.ok !== true) throw new Error(JSON.stringify(r).slice(0, 1500));
  return r as T;
}
const code = (r: { ok: boolean; code?: string }) => (r.ok ? "ok" : r.code);
const rehash = async (f: Loose) => ({ ...f, plan_sha256: await contentSha(f.plan) });

/** A checkpoint build of a plan (compiled in the worker). */
async function checkpoint(file: Loose, level: number): Promise<CharacterBuild> {
  const r = await inst.fx.engine.compilePlan(file);
  if (!r.ok) throw new Error(r.problem.detail);
  return r.checkpoints[level - 1]?.build as CharacterBuild;
}

/** The character's state played at the table: damage, temp HP, a Hit Die, a use, coins, items, a condition. */
async function play(id: string) {
  const r = await docs().playAction(id, [{ type: "short_rest", hit_dice: [{ die: 10, roll: 4 }] }]);
  if (!r.ok) throw new Error(r.reasons.join("; "));
  const chain = rec(id).state.inventory.find((i) => i.item === "chain-mail");
  for (const a of [
    { type: "damage", amount: 7 },
    { type: "set_temp_hp", amount: 4 },
    { type: "use", key: "fighter:second-wind" },
    { type: "adjust_currency", changes: { gp: -3 } },
    { type: "add_custom_item", name: "Lucky stone", description: "grey", weight_lb: null },
    { type: "add_condition", condition: "poisoned" },
    { type: "set_inspiration", value: true },
    ...(chain ? [{ type: "remove_item", id: chain.id }] : []),
  ] as Loose[]) {
    const x = await docs().playAction(id, a);
    if (!x.ok) throw new Error(`${JSON.stringify(a)}: ${x.reasons.join("; ")}`);
  }
  await flushNow();
}

async function advance(id: string): Promise<Confirmed> {
  const p = must(await previewAdvance(id)) as StepPreview;
  return must(await confirmStep(p)) as Confirmed;
}

beforeEach(async () => {
  await inst.open(`T04-${Math.random().toString(36).slice(2)}`);
});
afterEach(() => {
  confirmHooks.beforeDone = undefined;
});
afterAll(() => inst.close());

describe("start a new character at a checkpoint (§5)", () => {
  it.each([1, 3, 6])(
    "level %i: new id, fresh state, the plan's exact context and association; saved and reloaded",
    async (level) => {
      const file = FIGHTER();
      const r = must(await startFromPlan(file, level)) as { ok: true; id: string };
      const c = rec(r.id);
      expect(canonicalJson(mech(c.build))).toBe(canonicalJson(mech(await checkpoint(file, level))));
      expect(c.state.hp.current).toBeNull();
      expect(c.state.inventory.length).toBeGreaterThan(0);
      expect(c.content).toEqual({ packs: file.plan.packs, sources: null });
      expect(c.progression?.applied_level).toBe(level);
      expect(Object.hasOwn(c.progression?.plan ?? {}, "packs")).toBe(false);
      await inst.reload();
      const back = rec(r.id);
      expect(back.progression?.applied_level).toBe(level);
      expect((await readProgression(back.progression)).ok).toBe(true);
    },
  );

  it("outside the plan, or a broken plan: refused, nothing written", async () => {
    const before = await dumpDb();
    expect(code(await startFromPlan(FIGHTER(), 7))).toBe("start_level_out_of_range");
    expect(code(await startFromPlan({ ...FIGHTER(), plan_sha256: "f".repeat(64) }, 2))).toBe(
      "plan_hash_mismatch",
    );
    expect(await dumpDb()).toBe(before);
  });
});

describe("advance one planned level (§7)", () => {
  it("3 → 4: the played state, identity, name and journal kept; one transaction, entry, undo step", async () => {
    const { id } = must(await startFromPlan(FIGHTER(), 3)) as { ok: true; id: string };
    await play(id);
    const named = await docs().editBuild(id, { type: "name", name: "Renamed by the player" });
    expect(named.ok).toBe(true);
    await flushNow();
    const before = rec(id);
    const oldRows = await journal(id);
    const days = canonicalJson(useHistory.getState().meta[id]?.days);
    const day = useHistory.getState().meta[id]?.current_day_id;
    const p = must(await previewAdvance(id)) as StepPreview;
    expect(p.from_level).toBe(3);
    expect(p.to_level).toBe(4);
    // The played state's numbers (no chain mail any more), not the checkpoint's fresh AC 16.
    expect(p.before.armor_class).toBe(12);
    expect(p.after.armor_class).toBe(12);
    expect(p.after.hp_current).toBe(p.before.hp_current);
    expect(p.after.hp_max).toBe(36);
    expect(p.choices.some((o) => o.op === "level_up")).toBe(true);
    const done = must(await confirmStep(p)) as Confirmed;
    const after = rec(id);
    expect(after).toBe(done.record);
    expect(after.rev).toBe((before.rev ?? 0) + 1);
    expect(after.gen ?? 0).toBe(before.gen ?? 0);
    expect(after.build.name).toBe("Renamed by the player");
    expect(after.build.levels).toHaveLength(3);
    expect(canonicalJson(after.state)).toBe(canonicalJson(before.state));
    expect(after.progression?.applied_level).toBe(4);
    expect(after.content).toEqual(before.content);
    // No rest, no new day.
    expect(canonicalJson(useHistory.getState().meta[id]?.days)).toBe(days);
    expect(useHistory.getState().meta[id]?.current_day_id).toBe(day);
    // The database holds exactly what was published; the autosave writes nothing more.
    const database = await db();
    expect(canonicalJson(await database.get("characters", id))).toBe(canonicalJson(after));
    const dump = await dumpDb();
    await flushNow();
    expect(await dumpDb()).toBe(dump);
    expect(useHistory.getState().saveState.status).toBe("saved");
    // One new journal row, the old ones unchanged.
    const rows = await journal(id);
    expect(rows).toHaveLength(oldRows.length + 1);
    expect(canonicalJson(rows.slice(0, oldRows.length))).toBe(canonicalJson(oldRows));
    const entry = rows.at(-1) as Loose;
    expect(entry).toMatchObject({
      schema: "kenli.history/3",
      kind: "level_up",
      operation_id: done.op,
      status: "done",
    });
    expect(entry.level_up).toMatchObject({
      mode: "advance",
      from_level: 3,
      to_level: 4,
      class_id: "fighter",
      class_level: 4,
    });
    expect(entry.level_up.step_choices.length).toBeGreaterThan(0);
    // One undo step: back to 3 (state and progression), the entry undone; redo symmetrically.
    await docs().undo(id);
    expect(rec(id).build.levels).toHaveLength(2);
    expect(rec(id).progression?.applied_level).toBe(3);
    expect(canonicalJson(rec(id).state)).toBe(canonicalJson(before.state));
    expect(
      Object.values(useHistory.getState().entries).find((e) => e.operation_id === done.op)?.status,
    ).toBe("undone");
    await docs().redo(id);
    expect(rec(id).progression?.applied_level).toBe(4);
    expect(rec(id).build.levels).toHaveLength(3);
    await flushNow();
    await inst.reload();
    expect(rec(id).progression?.applied_level).toBe(4);
    expect(rec(id).build.levels).toHaveLength(3);
    expect((await journal(id)).at(-1)?.kind).toBe("level_up");
  });

  it("current HP null, 0 and explicit stay as they are (0: a warning, no revival, death saves kept)", async () => {
    for (const hp of [null, 0, 9] as const) {
      const { id } = must(await startFromPlan(FIGHTER(), 2)) as { ok: true; id: string };
      if (hp !== null) {
        const x = await docs().playAction(id, { type: "set_hp", current: hp });
        expect(x.ok).toBe(true);
      }
      if (hp === 0)
        expect((await docs().playAction(id, { type: "death_save", roll: 5 })).ok).toBe(true);
      await flushNow();
      const before = rec(id).state;
      const p = must(await previewAdvance(id)) as StepPreview;
      expect(p.warnings.map((w) => w.code)).toEqual(hp === 0 ? ["zero_hp_no_revive"] : []);
      must(await confirmStep(p));
      expect(rec(id).state.hp.current).toBe(hp);
      expect(canonicalJson(rec(id).state)).toBe(canonicalJson(before));
    }
  });

  it("an open roll or a pending decision: advance_busy saying which; forgetting the roll lets it go", async () => {
    const { id } = must(await startFromPlan(FIGHTER(), 2)) as { ok: true; id: string };
    expect((await docs().rollTest(id, { kind: "check", ability: "str" } as Loose)).ok).toBe(true);
    const busy = await previewAdvance(id);
    expect(busy).toMatchObject({
      ok: false,
      code: "advance_busy",
      busy: { kind: "roll", record_id: id },
    });
    useRolls.getState().forget(id);
    expect((await previewAdvance(id)).ok).toBe(true);
    const eid = await docs().createEncounter("Bridge");
    const enc = docs().encounters[eid] as Loose;
    useDocuments.setState((s) => ({
      encounters: {
        ...s.encounters,
        [eid]: {
          ...enc,
          encounter: {
            ...enc.encounter,
            combatants: [{ ...(enc.encounter.combatants[0] ?? {}), id: "x", character: id }],
            pending: { kind: "test" },
          },
        },
      },
    }));
    expect(await previewAdvance(id)).toMatchObject({
      ok: false,
      code: "advance_busy",
      busy: { kind: "decision", encounters: [eid] },
    });
  });

  it("stale preview, another tab, an injected storage failure: refused with nothing published or written; a fresh preview then works", async () => {
    const { id } = must(await startFromPlan(FIGHTER(), 2)) as { ok: true; id: string };
    await flushNow();
    // Stale: the character changed after the preview.
    const p1 = must(await previewAdvance(id)) as StepPreview;
    expect((await docs().playAction(id, { type: "damage", amount: 1 })).ok).toBe(true);
    expect(code(await confirmStep(p1))).toBe("preview_stale");
    expect(rec(id).progression?.applied_level).toBe(2);
    // Storage failure in the transaction: nothing kept, nothing published, no undo step.
    await flushNow();
    const dump = await dumpDb();
    const store = rec(id);
    const past = docs().history[id]?.past.length ?? 0;
    const p2 = must(await previewAdvance(id)) as StepPreview;
    confirmHooks.beforeDone = () => {
      throw new DOMException("full", "QuotaExceededError");
    };
    expect(code(await confirmStep(p2))).toBe("storage_quota");
    confirmHooks.beforeDone = undefined;
    expect(await dumpDb()).toBe(dump);
    expect(rec(id)).toBe(store);
    expect(docs().history[id]?.past.length ?? 0).toBe(past);
    expect(Object.values(useHistory.getState().entries).some((e) => e.kind === "level_up")).toBe(
      false,
    );
    // An abort the same.
    confirmHooks.beforeDone = (tx) => tx.abort();
    expect(["storage_failed", "storage_quota"]).toContain(code(await confirmStep(p2)));
    confirmHooks.beforeDone = undefined;
    expect(await dumpDb()).toBe(dump);
    // Another tab wrote the record: target_changed, nothing written here.
    const database = await db();
    const row = await database.get("characters", id);
    await database.put("characters", { ...(row as Loose), rev: (row?.rev ?? 0) + 1, updated: 1 });
    const theirs = await dumpDb();
    expect(code(await confirmStep(p2))).toBe("target_changed");
    expect(await dumpDb()).toBe(theirs);
    expect(rec(id)).toBe(store);
  });

  it("another tab's journal: history_changed, nothing written", async () => {
    const { id } = must(await startFromPlan(FIGHTER(), 2)) as { ok: true; id: string };
    expect((await docs().playAction(id, { type: "damage", amount: 1 })).ok).toBe(true);
    await flushNow();
    const p = must(await previewAdvance(id)) as StepPreview;
    const database = await db();
    const head = await database.get("history_meta", id);
    await database.put("history_meta", { ...(head as Loose), rev: (head?.rev ?? 0) + 5 });
    const theirs = await dumpDb();
    expect(code(await confirmStep(p))).toBe("history_changed");
    expect(await dumpDb()).toBe(theirs);
    expect(savedHead(id).conflicted).toBe(false);
  });

  it("a build changed outside the plan: advance_diverged with the differences, nothing repaired", async () => {
    const { id } = must(await startFromPlan(FIGHTER(), 2)) as { ok: true; id: string };
    const key = Object.keys(rec(id).build.choices).find(
      (k) => k === "class:fighter#skills",
    ) as string;
    const x = await docs().editBuild(id, { type: "choice", key, values: ["history", "insight"] });
    expect(x.ok).toBe(true);
    await flushNow();
    const before = await dumpDb();
    const r = await previewAdvance(id);
    expect(r).toMatchObject({ ok: false, code: "advance_diverged" });
    expect((r as ProgressionRefusal).differences?.[0]?.path).toBe(`choices[${key}]`);
    expect(await dumpDb()).toBe(before);
  });

  it("a step that would change the stored state (a spent key the reconcile drops): refused with the path, nothing dropped", async () => {
    const { id } = must(await startFromPlan(FIGHTER(), 2)) as { ok: true; id: string };
    const r0 = rec(id);
    useDocuments.setState((st) => ({
      characters: {
        ...st.characters,
        [id]: {
          ...r0,
          state: { ...r0.state, uses_spent: { ...r0.state.uses_spent, "test:gone": 1 } },
        },
      },
    }));
    await flushNow();
    const dump = await dumpDb();
    const r = await previewAdvance(id);
    expect(r).toMatchObject({ ok: false, code: "spent_lost" });
    expect((r as ProgressionRefusal).state?.map((d) => d.path)).toEqual(["uses_spent.test:gone"]);
    expect(await dumpDb()).toBe(dump);
    expect(rec(id).state.uses_spent["test:gone"]).toBe(1);
  });

  it("the publication refuses a record version the store no longer holds (nothing changed)", async () => {
    const { id } = must(await startFromPlan(FIGHTER(), 2)) as { ok: true; id: string };
    const old = rec(id);
    expect((await docs().playAction(id, { type: "damage", amount: 1 })).ok).toBe(true);
    const now = rec(id);
    const past = docs().history[id]?.past.length ?? 0;
    expect(docs().publishProgression(old, { ...old, rev: 99 }, null)).toBe(false);
    expect(rec(id)).toBe(now);
    expect(docs().history[id]?.past.length ?? 0).toBe(past);
  });

  it("at the plan's last level: advance_done", async () => {
    const { id } = must(await startFromPlan(FIGHTER(), 6)) as { ok: true; id: string };
    expect(code(await previewAdvance(id))).toBe("advance_done");
  });
});

describe("bind (§4.2, §6)", () => {
  /** An ordinary character at a plan's checkpoint, on the campaign's packs, played and renamed. */
  async function ordinary(file: Loose, level: number, name = "Mine") {
    const build = { ...(await checkpoint(file, level)), name };
    const id = await addCharacter(build, null, inst.fx.engine);
    await play(id);
    return id;
  }

  it("an ordinary character at 3: bound (content pinned, gen + 1, name, state and journal kept), then advanced", async () => {
    const file = FIGHTER();
    const id = await ordinary(file, 3);
    const before = rec(id);
    const p = must(await previewBind(id, file)) as StepPreview;
    expect(p).toMatchObject({ kind: "bind", from_level: 3, to_level: 3, packs_added: [] });
    const done = must(await confirmStep(p)) as Confirmed;
    const after = rec(id);
    expect(after.gen).toBe((before.gen ?? 0) + 1);
    expect(after.content).toEqual({ packs: file.plan.packs, sources: null });
    expect(after.build).toEqual(before.build);
    expect(canonicalJson(after.state)).toBe(canonicalJson(before.state));
    expect(after.progression?.applied_level).toBe(3);
    const entry = (await journal(id)).at(-1) as Loose;
    expect(entry.level_up).toMatchObject({ mode: "bind", from_level: 3, to_level: 3 });
    expect(entry.operation_id).toBe(done.op);
    expect(code(await previewBind(id, file))).toBe("progression_bound");
    // Advance after the bind.
    const a = await advance(id);
    expect(a.record.progression?.applied_level).toBe(4);
    expect(a.record.gen).toBe(after.gen);
    expect(a.record.build.name).toBe("Mine");
    // Undo the advance, then the bind: the ordinary record again (unpinned).
    await docs().undo(id);
    await docs().undo(id);
    expect(rec(id).progression ?? null).toBeNull();
    expect(rec(id).content).toBeUndefined();
  });

  it("a different prefix, another level, sources that differ: refused precisely, nothing written", async () => {
    const file = FIGHTER();
    const build = await checkpoint(file, 3);
    const other = await addCharacter(
      {
        ...build,
        choices: { ...build.choices, "class:fighter#skills": ["athletics", "history"] },
      } as CharacterBuild,
      null,
      inst.fx.engine,
    );
    await flushNow();
    const dump = await dumpDb();
    const mismatch = await previewBind(other, file);
    expect(mismatch).toMatchObject({ ok: false, code: "bind_prefix_mismatch" });
    expect((mismatch as ProgressionRefusal).differences?.map((d) => d.path)).toEqual([
      "choices[class:fighter#skills]",
    ]);
    const listed = clone(file);
    listed.plan.sources = ["srd-5.2.1"];
    expect(code(await previewBind(other, await rehash(listed)))).toBe("context_sources_mismatch");
    expect(await dumpDb()).toBe(dump);
  });

  it("on the campaign's packs: the settings changing between preview and confirm make it stale", async () => {
    const file = FIGHTER();
    const id = await ordinary(file, 2);
    const p = must(await previewBind(id, file)) as StepPreview;
    await useSettings.getState().setContent(["srd-5.2.1"], ["srd-5.2.1"]);
    await flushNow();
    const dump = await dumpDb();
    // The effective context moved with the settings: refused (never silently narrowed or re-pinned).
    expect(["preview_stale", "context_sources_mismatch"]).toContain(code(await confirmStep(p)));
    expect(rec(id).progression ?? null).toBeNull();
    expect(rec(id).content).toBeUndefined();
    expect(await dumpDb()).toBe(dump);
  });

  it("an add-on plan: only new ids, packs appended and stored, then the add-on's feat at the next level", async () => {
    const file = POOL();
    const id = await ordinary(file, 3);
    const p = must(await previewBind(id, file)) as StepPreview;
    expect(p.packs_added.map((r) => r.id)).toEqual(["test-pool-feat"]);
    must(await confirmStep(p));
    const c = rec(id);
    expect(c.build.packs).toEqual(["test-pool-feat"]);
    expect(c.content?.packs.map((r) => r.id)).toEqual(["srd-5.2.1", "test-pool-feat"]);
    const database = await db();
    expect(
      (await database.getAllKeys("packs")).some((k) =>
        String(k).startsWith("test-pool-feat@1.0.0#"),
      ),
    ).toBe(true);
    const a = await advance(id);
    expect(a.record.build.choices["class:fighter:4#feat"]).toEqual(["test-tongues"]);
    await inst.reload();
    expect(rec(id).progression?.applied_level).toBe(4);
  });

  it.each([
    [
      "an SRD id (feats/alert)",
      (f: Loose) =>
        f["feats.json"].push({ id: "alert", name: "Alert", category: "origin", grants: {} }),
      "addon_id_collision",
    ],
    [
      "a patch",
      (f: Loose) =>
        (f["manifest.json"].patches = [
          { target: "feats/alert", op: "set", path: "name", value: "x" },
        ]),
      "addon_patch",
    ],
    ["creation", (f: Loose) => (f["manifest.json"].creation = SRD_CREATION), "addon_creation"],
  ])("an add-on with %s: refused before any preview, nothing written", async (_n, change, want) => {
    const files = clone(POOL_PACK) as Loose;
    change(files);
    const srd = await inst.fx.engine.servedPack("srd-5.2.1");
    const env = await packEnvelope(files, [srd]);
    const file = clone(POOL());
    file.plan.levels = file.plan.levels.slice(0, 2); // 1–3: the step using the feat isn't needed
    file.plan.packs = [srd, { id: "test-pool-feat", version: "1.0.0", sha256: env.sha256 }];
    file.packs = [env];
    const id = await ordinary(FIGHTER(), 3);
    const dump = await dumpDb();
    expect(code(await previewBind(id, await rehash(file)))).toBe(want);
    expect(await dumpDb()).toBe(dump);
  });

  it("an old ref changed or a filter that excludes the add-on: refused, the filter never widened", async () => {
    const file = clone(POOL());
    file.plan.levels = file.plan.levels.slice(0, 2);
    const srd = file.plan.packs[0];
    const build = await checkpoint(FIGHTER(), 3);
    // A record pinned to another version of the pack the plan names (its files needn't be here:
    // the refs are compared before any catalog).
    const old = "c-old-ref";
    const state = await inst.fx.engine.createState(build);
    useDocuments.setState((st) => ({
      characters: {
        ...st.characters,
        [old]: {
          id: old,
          build,
          state,
          created: 1,
          updated: 1,
          rev: 1,
          gen: 0,
          content: {
            packs: [srd, { ...file.plan.packs[1], version: "0.9.0", sha256: "e".repeat(64) }],
            sources: null,
          },
        },
      },
    }));
    expect(code(await previewBind(old, await rehash(file)))).toBe("bind_old_ref_changed");
    // A record filtered to the SRD only, a plan with the same filter: the add-on's source is out.
    const filtered = clone(file);
    filtered.plan.sources = ["srd-5.2.1"];
    const fid = await addCharacter(build, { packs: [srd], sources: ["srd-5.2.1"] }, inst.fx.engine);
    const r = await previewBind(fid, await rehash(filtered));
    expect(code(r)).toBe("addon_source_filtered");
    expect(rec(fid).content?.sources).toEqual(["srd-5.2.1"]);
  });
});

describe("the association itself", () => {
  it("a duplicate keeps it; detaching drops only it (one undo step restores it)", async () => {
    const { id } = must(await startFromPlan(FIGHTER(), 3)) as { ok: true; id: string };
    const copy = (await docs().duplicateCharacter(id)) as string;
    expect(rec(copy).progression).toEqual(rec(id).progression);
    const before = rec(id);
    must(await detachProgression(id));
    expect(rec(id).progression).toBeNull();
    expect(rec(id).build).toBe(before.build);
    expect(rec(id).state).toBe(before.state);
    expect(rec(id).content).toEqual(before.content);
    expect(code(await previewAdvance(id))).toBe("progression_none");
    await docs().undo(id);
    expect(rec(id).progression).toEqual(before.progression);
    await flushNow();
    await inst.reload();
    expect(rec(id).progression?.applied_level).toBe(3);
  });

  it("an unsupported stored value is kept as it is, and planned actions refuse it", async () => {
    const { id } = must(await startFromPlan(FIGHTER(), 2)) as { ok: true; id: string };
    await flushNow();
    const database = await db();
    const row = await database.get("characters", id);
    await database.put("characters", {
      ...(row as Loose),
      progression: { schema: "srd-table.progression/9" },
    });
    await inst.reload();
    expect((rec(id) as Loose).progression).toEqual({ schema: "srd-table.progression/9" });
    expect(code(await previewAdvance(id))).toBe("progression_unsupported");
    await flushNow();
    expect((await (await db()).get("characters", id))?.progression).toEqual({
      schema: "srd-table.progression/9",
    });
  });
});

describe("R06: nothing fallible after the durable write; the served SRD without a stored copy", () => {
  /** An ordinary character at the pool plan's level 3, on the campaign's packs, played. */
  async function poolCharacter() {
    const r = await inst.fx.engine.compilePlan(POOL());
    if (!r.ok) throw new Error(r.problem.detail);
    const id = await addCharacter(
      { ...(r.checkpoints[2]?.build as CharacterBuild), name: "Pool" },
      null,
      inst.fx.engine,
    );
    await play(id);
    return id;
  }
  /** Every facade call from now on, by name (the methods of the installed engine wrapped). */
  function recordCalls() {
    const e = inst.fx.engine as unknown as Record<string, unknown>;
    const calls: string[] = [];
    const originals = new Map<string, unknown>();
    for (const [name, fn] of Object.entries(e)) {
      if (typeof fn !== "function") continue;
      originals.set(name, fn);
      e[name] = (...args: unknown[]) => {
        calls.push(name);
        return (fn as (...a: unknown[]) => unknown)(...args);
      };
    }
    return { calls, restore: () => originals.forEach((fn, name) => (e[name] = fn)) };
  }

  it("the registration a bind needs fails under the confirm's lock: refused before the transaction, nothing written or published", async () => {
    const id = await poolCharacter();
    const p = must(await previewBind(id, POOL())) as StepPreview;
    await flushNow();
    const dump = await dumpDb();
    const before = rec(id);
    const past = docs().history[id]?.past.length ?? 0;
    const e = inst.fx.engine as unknown as { registerPacks: (...a: unknown[]) => Promise<unknown> };
    const original = e.registerPacks;
    e.registerPacks = async () => {
      throw new Error("synthetic worker failure");
    };
    try {
      const r = await confirmStep(p);
      expect(r).toMatchObject({ ok: false, code: "pack_register_failed" });
    } finally {
      e.registerPacks = original;
    }
    expect(await dumpDb()).toBe(dump);
    expect(rec(id)).toBe(before);
    expect(docs().history[id]?.past.length ?? 0).toBe(past);
    expect(Object.values(useHistory.getState().entries).some((x) => x.kind === "level_up")).toBe(
      false,
    );
    // The worker back: a fresh preview and confirm work.
    must(await confirmStep(must(await previewBind(id, POOL())) as StepPreview));
    expect(rec(id).progression?.applied_level).toBe(3);
  });

  it.each(["bind", "advance"] as const)(
    "%s: no worker call after the transaction's last write; the database, store, journal and baseline agree",
    async (kind) => {
      const id = await poolCharacter();
      if (kind === "advance")
        must(await confirmStep(must(await previewBind(id, POOL())) as StepPreview));
      const p = must(
        await (kind === "bind" ? previewBind(id, POOL()) : previewAdvance(id)),
      ) as StepPreview;
      const past = docs().history[id]?.past.length ?? 0;
      const spy = recordCalls();
      let mark = -1;
      confirmHooks.beforeDone = () => {
        mark = spy.calls.length;
      };
      let done: Confirmed;
      try {
        done = must(await confirmStep(p)) as Confirmed;
      } finally {
        confirmHooks.beforeDone = undefined;
        spy.restore();
      }
      expect(mark).toBeGreaterThanOrEqual(0);
      expect(spy.calls.slice(mark)).toEqual([]);
      const database = await db();
      expect(canonicalJson(await database.get("characters", id))).toBe(canonicalJson(rec(id)));
      expect(rec(id)).toBe(done.record);
      expect(docs().history[id]?.past.length ?? 0).toBe(past + 1);
      const memory = Object.values(useHistory.getState().entries).find(
        (x) => x.operation_id === done.op,
      );
      expect(canonicalJson((await journal(id)).at(-1))).toBe(canonicalJson(memory));
      expect(canonicalJson(await database.get("history_meta", id))).toBe(
        canonicalJson(useHistory.getState().meta[id]),
      );
      const dump = await dumpDb();
      await flushNow();
      expect(await dumpDb()).toBe(dump);
      expect(useHistory.getState().saveState.status).toBe("saved");
    },
  );

  it("an add-on bind with the served SRD and no stored copy of it: bound; a missing private pack is still refused", async () => {
    const id = await poolCharacter();
    const srd = await inst.fx.engine.servedPack("srd-5.2.1");
    const database = await db();
    await database.delete("packs", packKey(srd));
    const p = must(await previewBind(id, POOL())) as StepPreview;
    expect(p.packs_added.map((r) => r.id)).toEqual(["test-pool-feat"]);
    must(await confirmStep(p));
    expect(rec(id).content?.packs[0]).toEqual(srd);
    expect(await database.getKey("packs", packKey(srd))).toBeUndefined();
    // Without its envelope, and not installed: the private pack is missing (nothing fetched).
    const other = await poolCharacter();
    const bare = clone(POOL());
    delete bare.packs;
    const pool = await (await db()).getAllKeys("packs");
    for (const k of pool)
      if (String(k).startsWith("test-pool-feat@")) await database.delete("packs", k);
    await inst.reload();
    const dump = await dumpDb();
    expect(code(await previewBind(other, bare))).toBe("plan_pack_missing");
    expect(await dumpDb()).toBe(dump);
  });
});
