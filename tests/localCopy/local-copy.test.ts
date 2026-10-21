/**
 * kenli F-007 T03: the local copy end to end on the real store, autosave, in-process engine (real
 * SRD + the F-005 test pack) and IndexedDB — each installation its own fake database, side by side.
 * Export from one, import as a new character into another, compare everything after the permitted
 * id mapping; >500 entries, undone/raw/effective, interleaved groups, an off-page child, days, Long
 * Rests and a DM override, a historical pending decision, legacy and empty journals; ids colliding
 * with the target's live records; generations of copies; repeated import; publication failure and
 * technical retry; Undo→reload, Undo→Redo; refusals that write nothing (contract local-copy.md).
 */

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { exportCharacter } from "../../src/import/export";
import {
  commitLocalCopy,
  localCopyFaults,
  redoLocalCopyImport,
  undoLocalCopyImport,
  useLocalCopySession,
} from "../../src/import/localCopy/commit";
import {
  CAMPAIGN_CONTEXT_KEY,
  exportLocalCopy,
  settingsFingerprint,
} from "../../src/import/localCopy/export";
import {
  inheritedEncounterNames,
  LOCAL_COPY_LIMITS,
  localCopyOf,
  validateLocalCopy,
} from "../../src/import/localCopy/format";
import { planLocalCopy } from "../../src/import/localCopy/plan";
import { canonicalJson, contentSha, packRefOf } from "../../src/lib/canonical";
import { db, packKey } from "../../src/persistence/db";
import { byOperations, groupFrom, longRests, page } from "../../src/persistence/history";
import { flushNow, installationId, unsavedState } from "../../src/persistence/sync";
import { useDocuments } from "../../src/store/documents";
import { type HistoryEntry, useHistory } from "../../src/store/history";
import { rogue } from "../fixtures/characters";
import { TEST_PACK, testContext } from "../fixtures/player-actions";
import {
  addCharacter,
  bytesOf,
  dumpDb,
  exampleJournal,
  Installations,
  type Loose,
  mappingInvariants,
  ok,
  rowsOf,
  storeTestPack,
  writeJournal,
} from "./helpers";

const docs = () => useDocuments.getState();
const inst = new Installations();
afterEach(async () => {
  localCopyFaults.publish = null;
  vi.restoreAllMocks();
});
afterAll(async () => {
  await inst.close();
});

async function context() {
  await storeTestPack();
  return testContext(inst.fx.engine);
}

/** A live encounter record with this id and name (collisions with ids in a copy). */
async function liveEncounter(id: string, name: string) {
  const enc = await inst.fx.engine.newEncounter();
  const now = Date.now();
  useDocuments.setState((s) => ({
    encounters: {
      ...s.encounters,
      [id]: { id, name, encounter: enc, log: [], created: now, updated: now, rev: 1, gen: 0 },
    },
  }));
  await flushNow();
}

/** I1: a rogue pinned to SRD + test pack carrying the contract's 595-entry journal as saved. */
async function bigSource(name = "I1") {
  const installation = await inst.open(name);
  const ctx = await context();
  const build = await rogue(inst.fx.engine, 5);
  const id = await addCharacter(build, ctx, inst.fx.engine);
  // live things with the ids the journal names (in I1 they are live)
  await addCharacter(await rogue(inst.fx.engine, 3), ctx, inst.fx.engine, "c-wizard");
  await liveEncounter("e-src77", "Cragmaw ambush");
  const j = exampleJournal(id);
  await writeJournal(j.entries, j.meta);
  await inst.reload();
  return { installation, id, entries: j.entries, meta: j.meta };
}

async function exportBytes(id: string) {
  const r = ok(await exportLocalCopy(id));
  return { ...r, bytes: await bytesOf(r.blob) };
}

async function importBytes(
  bytes: Uint8Array,
  fileName = "copy.local-copy.json",
  confirmNewCopy = false,
) {
  const v = await validateLocalCopy(bytes);
  if (!v.ok) throw new Error(`${v.code}: ${v.detail}`);
  const plan = await planLocalCopy(v.copy, v.bytes_sha256, fileName, { size: bytes.byteLength });
  const r = await commitLocalCopy(plan, { confirmNewCopy });
  return { plan, result: r, copy: v.copy };
}

describe("export → separate installation → import as a new character", () => {
  it("595 entries: everything kept after the permitted mapping; the source unchanged; reload and play on", async () => {
    const src = await bigSource();
    const sourceDump = await dumpDb();
    const sourceRests = await longRests(src.id);
    const x = await exportBytes(src.id);
    expect(await dumpDb()).toBe(sourceDump); // export writes nothing
    expect(x.summary).toMatchObject({ entries: 595, days: 6, legacy: false });
    expect(x.fileName).toMatch(/\.local-copy\.json$/);
    expect(x.copy.payload.packs.map((p) => p.id)).toEqual(["srd-5.2.1", "test-actions"]);
    expect(x.copy.payload.external.encounters).toEqual([
      { encounter_id: "e-src77", name: "Cragmaw ambush" },
    ]);
    const srdRow = await (await db()).get(
      "packs",
      packKey(x.copy.payload.character.context.packs[0] as Loose),
    );
    expect(canonicalJson(x.copy.payload.packs[0]?.content)).toBe(
      canonicalJson({ files: srdRow?.files }),
    );
    const srcRecord = docs().characters[src.id];

    // I2: other live records with the same ids as the copy's (record, participant, encounter)
    const i2 = await inst.open("I2");
    expect(i2).not.toBe(src.installation);
    const ctx2 = await context();
    await addCharacter(await rogue(inst.fx.engine, 3), ctx2, inst.fx.engine, src.id);
    await addCharacter(await rogue(inst.fx.engine, 3), ctx2, inst.fx.engine, "c-wizard");
    await liveEncounter("e-src77", "Something else in I2");
    const before = await dumpDb();
    const { result, copy, plan } = await importBytes(x.bytes);
    expect(plan.summary.entries).toEqual({ total: 595, done: 591, undone: 4 });
    expect(plan.summary.days).toHaveLength(6);
    expect(plan.packs.present.map((p) => p.id)).toEqual(["srd-5.2.1", "test-actions"]);
    const { recordId } = ok(result);
    expect(recordId).not.toBe(src.id);
    const record = docs().characters[recordId] as Loose;
    const rows = await rowsOf(recordId);
    const meta = (await (await db()).get("history_meta", recordId)) ?? null;
    expect(rows).toHaveLength(595);
    expect(
      mappingInvariants(copy, record, rows, meta, {
        characters: docs().characters,
        encounters: docs().encounters,
      }),
    ).toEqual([]);
    // build, state and context exact; identity new; origin keeps the source's
    expect(canonicalJson(record.build)).toBe(canonicalJson(srcRecord?.build));
    expect(canonicalJson(record.state)).toBe(canonicalJson(srcRecord?.state));
    expect(record.content).toEqual(srcRecord?.content);
    expect(record).toMatchObject({
      rev: 1,
      gen: 0,
      origin: { kind: "import", sha256: copy.payload_sha256 },
    });
    expect(meta).toMatchObject({ rev: 1, next_seq: 596, current_day_id: src.meta.current_day_id });
    expect(meta?.days).toEqual(src.meta.days);
    // raw/effective/status/outcome verbatim, entry by entry
    for (const [i, e] of src.entries.entries()) {
      const n = rows[i] as HistoryEntry;
      expect([n.seq, n.status, n.kind, n.day_id]).toEqual([e.seq, e.status, e.kind, e.day_id]);
      expect(
        canonicalJson([
          n.outcome,
          n.request,
          n.result,
          n.messages,
          n.costs,
          n.effect.state_delta,
          n.rest ?? null,
        ]),
      ).toBe(
        canonicalJson([
          e.outcome,
          e.request,
          e.result,
          e.messages,
          e.costs,
          e.effect.state_delta,
          e.rest ?? null,
        ]),
      );
    }
    expect(await longRests(recordId)).toEqual(sourceRests);
    // external refs canonical, never bound to I2's live c-wizard / e-src77
    const extParticipant = `ext:${src.installation}:c-wizard`;
    expect(rows.some((e) => e.participants.some((p) => p.record_id === extParticipant))).toBe(true);
    expect(rows.some((e) => e.participants.some((p) => p.record_id === "c-wizard"))).toBe(false);
    expect(
      rows
        .filter((e) => e.context.encounter_id !== null)
        .every((e) => e.context.encounter_id === `ext:${src.installation}:e-src77`),
    ).toBe(true);
    expect(inheritedEncounterNames(record.origin).get(`ext:${src.installation}:e-src77`)).toBe(
      "Cragmaw ambush",
    );
    expect(docs().encounters["e-src77"]?.name).toBe("Something else in I2"); // untouched
    // the historical pending decision is kept as it was, nothing resumed
    expect(rows.filter((e) => e.pending_decision)).toHaveLength(1);
    expect(
      Object.values(docs().encounters).every(
        (e) => e.encounter.pending === null || e.encounter.pending === undefined,
      ),
    ).toBe(true);
    // the panel reads it as for any character: a page, an off-page group root by its id
    const firstPage = await page(recordId, { limit: 50 });
    const offPage = firstPage.find(
      (e) => e.parent_op !== null && !firstPage.some((f) => f.operation_id === e.group_id),
    );
    if (offPage) {
      const [root] = await byOperations(recordId, [offPage.group_id]);
      expect(root).toBeDefined();
      const group = await groupFrom(root as HistoryEntry);
      expect(group.some((g) => g.id === offPage.id)).toBe(true);
    }
    const child = rows.find((e) => {
      const root = rows.find((r) => r.operation_id === e.group_id);
      return root && e.seq - root.seq > 50;
    });
    expect(child).toBeDefined(); // the example's child 56 entries after its root
    expect(await dumpDb()).not.toBe(before);
    // the autosave took it as saved: nothing unsaved, a flush writes nothing
    expect(unsavedState(recordId)).toEqual({ entries: 0, days: false });
    const afterImport = await dumpDb();
    await flushNow();
    expect(await dumpDb()).toBe(afterImport);

    // close/reopen, then a normal action: next seq, current day, resources from the copy's state
    await inst.reload();
    expect(docs().characters[recordId]?.rev).toBe(1);
    expect(useHistory.getState().meta[recordId]?.next_seq).toBe(596);
    inst.fx.dice.push(12);
    ok(await docs().rollTest(recordId, { skill: "stealth" }));
    await flushNow();
    const after = await rowsOf(recordId);
    expect(after).toHaveLength(596);
    expect(after[595]).toMatchObject({ seq: 596, day_id: src.meta.current_day_id, status: "done" });
    expect((await (await db()).get("history_meta", recordId))?.rev).toBe(2);
    // the source installation is unchanged by all of it
    await inst.open("I1");
    expect(await dumpDb()).toBe(sourceDump);
  }, 120_000);

  it("an empty journal and a legacy record: needs the prepared matching campaign context; nothing invented", async () => {
    await inst.open("L1");
    const build = await rogue(inst.fx.engine, 3);
    const id = await addCharacter(build, null, inst.fx.engine); // legacy: plays on the campaign's packs
    expect(await exportLocalCopy(id)).toMatchObject({ ok: false, code: "context_unprepared" });
    const srd = await inst.fx.engine.servedPack("srd-5.2.1");
    const settings = useSettings();
    const fingerprint = await settingsFingerprint(settings.packs, settings.sources);
    const put = async (fp: string) => {
      const database = await db();
      await database.put(
        "settings",
        {
          schema: "srd-table.campaign-context/1",
          settings_fingerprint: fp,
          packs: [...settings.packs],
          sources: settings.sources,
          context: { packs: [srd], sources: null },
          prepared_at: 1,
          release_id: null,
        },
        CAMPAIGN_CONTEXT_KEY,
      );
    };
    await put("0".repeat(64)); // prepared for other settings
    expect(await exportLocalCopy(id)).toMatchObject({ ok: false, code: "context_unprepared" });
    await put(fingerprint);
    const before = await dumpDb();
    const x = await exportBytes(id);
    expect(await dumpDb()).toBe(before);
    expect(x.copy.payload.history).toEqual({
      schema: "kenli.history/1",
      entry_count: 0,
      meta: null,
      entries: [],
    });
    expect(x.copy.payload.source.legacy_context).toEqual({
      settings_fingerprint: fingerprint,
      packs: ["srd-5.2.1"],
      sources: null,
    });
    expect(x.copy.payload.character.context).toEqual({ packs: [srd], sources: null });
    expect(docs().characters[id]?.content).toBeUndefined(); // the source record not pinned by the export

    await inst.open("L2");
    const { result } = await importBytes(x.bytes);
    const { recordId } = ok(result);
    expect(docs().characters[recordId]?.content).toEqual({ packs: [srd], sources: null }); // pinned
    expect(await rowsOf(recordId)).toEqual([]);
    expect(await (await db()).get("history_meta", recordId)).toBeUndefined();
    expect(useHistory.getState().meta[recordId]).toBeUndefined(); // made lazily on first need
  });
});

function useSettings() {
  return { packs: ["srd-5.2.1"], sources: null as string[] | null };
}

describe("generations of copies (§2.2): canonical external refs, names kept, nothing bound locally", () => {
  it("I1 → I2 (new play in a colliding local encounter) → I3 (new play) → back to I1", async () => {
    const src = await bigSource("G1");
    const x1 = await exportBytes(src.id);

    // I2: colliding ids, then new local play of the copy in I2's own encounter
    const i2 = await inst.open("G2");
    const ctx2 = await context();
    await addCharacter(await rogue(inst.fx.engine, 3), ctx2, inst.fx.engine, "c-wizard");
    await liveEncounter("e-src77", "I2's own e-src77");
    const copy2 = ok((await importBytes(x1.bytes)).result).recordId;
    const ally = await addCharacter(await rogue(inst.fx.engine, 3), ctx2, inst.fx.engine);
    const eid = await docs().createEncounter("Bridge fight");
    ok(
      await docs().encounterAction(eid, [
        { type: "add_character", character: copy2, id: "rogue", decisions: "ask" },
        { type: "add_character", character: ally, id: "ally", decisions: "auto" },
        { type: "add_monster", monster: "goblin-warrior" },
        { type: "set_initiative", id: "goblin-warrior", value: 20 },
        { type: "set_initiative", id: "rogue", value: 1 },
        { type: "set_initiative", id: "ally", value: 2 },
        { type: "start" },
      ]),
    );
    inst.fx.dice.push(19, 6);
    const stopped = await docs().encounterAction(eid, {
      type: "attack",
      id: "goblin-warrior",
      target: "rogue",
      attack: "Scimitar",
    });
    expect(ok(stopped).pending?.kind).toBe("uncanny_dodge"); // left pending in I2
    inst.fx.dice.push(11);
    ok(await docs().rollTest(copy2, { skill: "athletics" }));
    await flushNow();
    const x2 = await exportBytes(copy2);
    expect(x2.copy.payload.source.installation_id).toBe(i2);
    expect(x2.copy.payload.history.entries).toHaveLength(597);
    // the external encounter keeps the name inherited from I1; the live one its I2 name
    expect(x2.copy.payload.external.encounters).toEqual(
      [
        { encounter_id: eid, name: "Bridge fight" },
        { encounter_id: `ext:${src.installation}:e-src77`, name: "Cragmaw ambush" },
      ].sort((a, b) => (a.encounter_id < b.encounter_id ? -1 : 1)),
    );

    // I3: collisions again, import, new play
    const i3 = await inst.open("G3");
    const ctx3 = await context();
    await addCharacter(await rogue(inst.fx.engine, 3), ctx3, inst.fx.engine, "c-wizard");
    await liveEncounter(eid, "I3's encounter with I2's id");
    const copy3 = ok((await importBytes(x2.bytes)).result).recordId;
    const rows3 = await rowsOf(copy3);
    const pendingI2 = rows3.find(
      (e) => e.pending_decision && e.context.encounter_id === `ext:${i2}:${eid}`,
    );
    expect(pendingI2).toBeDefined(); // historical, its encounter not imported or resumed
    expect(Object.values(docs().encounters).find((e) => e.id === eid)?.name).toBe(
      "I3's encounter with I2's id",
    );
    inst.fx.dice.push(9);
    ok(await docs().rollTest(copy3, { skill: "perception" }));
    await flushNow();
    const x3 = await exportBytes(copy3);
    expect(x3.copy.payload.history.entries).toHaveLength(598);

    // back to I1, where c-wizard and e-src77 are live: nothing re-bound
    await inst.open("G1");
    const copy1 = ok((await importBytes(x3.bytes)).result).recordId;
    const rows1 = await rowsOf(copy1);
    expect(rows1).toHaveLength(598);
    const record1 = docs().characters[copy1] as Loose;
    const allIds = rows1.flatMap((e) => [
      ...e.participants.map((p) => p.record_id),
      e.context.encounter_id,
      e.links.follows,
      e.links.continues,
    ]);
    expect(allIds.some((x) => typeof x === "string" && /^ext:[^:]+:ext:/.test(x))).toBe(false);
    expect(rows1.some((e) => e.participants.some((p) => p.record_id === "c-wizard"))).toBe(false);
    expect(
      rows1.some((e) => e.context.encounter_id === "e-src77" || e.context.encounter_id === eid),
    ).toBe(false);
    const names = inheritedEncounterNames(record1.origin);
    expect(names.get(`ext:${src.installation}:e-src77`)).toBe("Cragmaw ambush");
    expect(names.get(`ext:${i2}:${eid}`)).toBe("Bridge fight");
    // the participant keeps the installation where it was live (I1), named as in its entries
    const wizardI1 = rows1
      .flatMap((e) => e.participants)
      .filter((p) => p.record_id === `ext:${src.installation}:c-wizard`);
    expect(wizardI1.length).toBeGreaterThan(0);
    expect(new Set(wizardI1.map((p) => p.name))).toEqual(new Set(["Syn Wizard"]));
    // Long Rests and days unchanged through three generations
    expect(await longRests(copy1)).toEqual(await longRests(src.id));
    expect(rows1.slice(0, 595).map((e) => [e.seq, e.status, e.day_id, e.kind])).toEqual(
      src.entries.map((e) => [e.seq, e.status, e.day_id, e.kind]),
    );
    expect(rows1[596]).toMatchObject({ kind: "test", seq: 597 });
    expect(rows1[597]).toMatchObject({ kind: "test", seq: 598 });
    expect(i3).not.toBe(i2);
  }, 180_000);
});

describe("commit: atomic, idempotent retry, explicit new copy, refusals write nothing", () => {
  it("a second import of the same file needs explicit consent; then a separate copy, no merged entries", async () => {
    const src = await bigSource("D1");
    const x = await exportBytes(src.id);
    await inst.open("D2");
    const first = ok((await importBytes(x.bytes)).result).recordId;
    const before = await dumpDb();
    const again = await importBytes(x.bytes);
    expect(again.plan.already_imported).toEqual([first]);
    expect(again.result).toMatchObject({ ok: false, code: "copy_already_imported" });
    expect(await dumpDb()).toBe(before);
    const second = ok(await commitLocalCopy(again.plan, { confirmNewCopy: true })).recordId;
    expect(second).not.toBe(first);
    const a = await rowsOf(first);
    const b = await rowsOf(second);
    expect(a).toHaveLength(595);
    expect(b).toHaveLength(595);
    expect(new Set([...a, ...b].map((e) => e.id)).size).toBe(1190);
    expect(new Set([...a, ...b].map((e) => e.operation_id)).size).toBe(
      2 * new Set(a.map((e) => e.operation_id)).size,
    );
  }, 60_000);

  it("publication fails after the transaction: saved, not shown; retry of the plan shows it, no second copy; the autosave never writes an empty journal over it", async () => {
    const src = await bigSource("P1");
    const x = await exportBytes(src.id);
    await inst.open("P2");
    const v = ok(await validateLocalCopy(x.bytes));
    const plan = await planLocalCopy(v.copy, v.bytes_sha256, "p.local-copy.json");
    localCopyFaults.publish = () => {
      throw new Error("injected publication failure");
    };
    const r = await commitLocalCopy(plan);
    expect(r).toMatchObject({ ok: "saved_unpublished" });
    const recordId = (r as { recordId: string }).recordId;
    expect(docs().characters[recordId]).toBeUndefined(); // not shown
    expect(await rowsOf(recordId)).toHaveLength(595); // but saved whole
    // other activity and a save: the copy is not touched (no delete, no empty head)
    await addCharacter(await rogue(inst.fx.engine, 3), null, inst.fx.engine);
    await flushNow();
    expect(await rowsOf(recordId)).toHaveLength(595);
    expect((await (await db()).get("history_meta", recordId))?.rev).toBe(1);
    localCopyFaults.publish = null;
    const retry = ok(await commitLocalCopy(plan));
    expect(retry.recordId).toBe(recordId);
    expect(retry.import_id).toBe(plan.import_id);
    expect(
      Object.values(docs().characters).filter(
        (c) => c.origin?.kind === "import" && c.origin.sha256 === v.copy.payload_sha256,
      ),
    ).toHaveLength(1);
    // retry again (already shown): still one copy
    ok(await commitLocalCopy(plan));
    const all = await (await db()).getAll("characters");
    expect(all.filter((c) => localCopyOf(c.origin)?.import_id === plan.import_id)).toHaveLength(1);
    await flushNow();
    expect(await rowsOf(recordId)).toHaveLength(595);

    // the other path: failure, then a reload shows it; the same plan's retry finds it
    const plan2 = await planLocalCopy(v.copy, v.bytes_sha256, "p.local-copy.json");
    localCopyFaults.publish = () => {
      throw new Error("injected");
    };
    const r2 = await commitLocalCopy(plan2, { confirmNewCopy: true });
    expect(r2).toMatchObject({ ok: "saved_unpublished" });
    localCopyFaults.publish = null;
    await inst.reload();
    const id2 = (r2 as { recordId: string }).recordId;
    expect(docs().characters[id2]).toBeDefined();
    expect(ok(await commitLocalCopy(plan2, { confirmNewCopy: true })).recordId).toBe(id2);
    expect(
      (await (await db()).getAll("characters")).filter((c) => c.origin?.kind === "import"),
    ).toHaveLength(2);
  }, 90_000);

  it("another version of the same pack here: both kept side by side, the copy pinned to its own", async () => {
    const src = await bigSource("W1");
    const x = await exportBytes(src.id);
    await inst.open("W2");
    const v2 = structuredClone(TEST_PACK) as Loose;
    v2["manifest.json"].manifest.version = "2.0.0";
    const ref2 = await packRefOf(v2);
    await (await db()).add("packs", {
      key: packKey(ref2),
      ref: ref2,
      files: v2,
      installed_at: 1,
      origin: { kind: "import", bytes_sha256: null },
    });
    const { plan, result } = await importBytes(x.bytes);
    expect(plan.packs.new.map((p) => `${p.id}@${p.version}`)).toEqual(["test-actions@1.0.0"]);
    expect(plan.packs.conflict).toEqual([]);
    const id = ok(result).recordId;
    const packs = (await (await db()).getAll("packs")).filter((p) => p.ref.id === "test-actions");
    expect(packs.map((p) => p.ref.version).sort()).toEqual(["1.0.0", "2.0.0"]);
    expect(docs().characters[id]?.content?.packs.map((p) => `${p.id}@${p.version}`)).toEqual([
      "srd-5.2.1@5.2.1",
      "test-actions@1.0.0",
    ]);
    // it plays on its own pinned version after a reload
    await inst.reload();
    inst.fx.dice.push(13);
    ok(await docs().rollTest(id, { skill: "stealth" }));
  }, 60_000);

  it("pack conflict, quota and abort: nothing written, the target untouched; Cancel writes nothing", async () => {
    const src = await bigSource("F1");
    const x = await exportBytes(src.id);
    await inst.open("F2");
    // Cancel: preview only
    const empty = await dumpDb();
    const v = ok(await validateLocalCopy(x.bytes));
    const plan = await planLocalCopy(v.copy, v.bytes_sha256, "f.local-copy.json");
    expect(plan.packs.new.map((p) => p.id)).toEqual(["test-actions"]);
    expect(await dumpDb()).toBe(empty);
    // quota on the 300th journal row: the whole transaction aborts
    const add = IDBObjectStore.prototype.add;
    let n = 0;
    const spy = vi.spyOn(IDBObjectStore.prototype, "add").mockImplementation(function (
      this: IDBObjectStore,
      ...args
    ) {
      if (this.name === "history" && ++n === 300)
        throw new DOMException("full", "QuotaExceededError");
      return add.apply(this, args as Parameters<typeof add>);
    });
    expect(await commitLocalCopy(plan)).toMatchObject({ ok: false, code: "storage_quota" });
    expect(await dumpDb()).toBe(empty);
    spy.mockImplementation(function (this: IDBObjectStore, ...args) {
      if (this.name === "history_meta") throw new DOMException("aborted", "AbortError");
      return add.apply(this, args as Parameters<typeof add>);
    });
    expect(await commitLocalCopy(plan)).toMatchObject({ ok: false, code: "storage_failed" });
    expect(await dumpDb()).toBe(empty);
    spy.mockRestore();
    expect(Object.keys(docs().characters)).toEqual([]);
    // the same pack version with other bytes here: the whole import refused
    const other = structuredClone(TEST_PACK) as Loose;
    other["manifest.json"].name = "test-actions (other bytes)";
    const ref = await packRefOf(other);
    await (await db()).add("packs", {
      key: packKey(ref),
      ref,
      files: other,
      installed_at: 1,
      origin: { kind: "import", bytes_sha256: null },
    });
    const before = await dumpDb();
    const plan2 = await planLocalCopy(v.copy, v.bytes_sha256, "f.local-copy.json");
    expect(plan2.packs.conflict.map((p) => p.id)).toEqual(["test-actions"]);
    expect(await commitLocalCopy(plan2)).toMatchObject({
      ok: false,
      code: "pack_identity_conflict",
    });
    expect(await dumpDb()).toBe(before);
  }, 90_000);
});

describe("session Undo/Redo of the whole import", () => {
  it("Undo → reload: gone with its journal and head (packs kept); Undo → Redo: the same copy again", async () => {
    const src = await bigSource("U1");
    const x = await exportBytes(src.id);
    await inst.open("U2");
    const empty = await dumpDb();
    const id = ok((await importBytes(x.bytes)).result).recordId;
    const imported = await dumpDb();
    ok(await undoLocalCopyImport());
    expect(docs().characters[id]).toBeUndefined();
    expect(useHistory.getState().meta[id]).toBeUndefined();
    expect(await rowsOf(id)).toEqual([]);
    expect(await (await db()).get("history_meta", id)).toBeUndefined();
    expect(
      JSON.parse(await dumpDb())
        .packs.map((p: Loose) => p.ref.id)
        .sort(),
    ).toEqual(["srd-5.2.1", "test-actions"]);
    await flushNow(); // the autosave doesn't resurrect or touch it
    await inst.reload();
    expect(docs().characters[id]).toBeUndefined();
    expect(await rowsOf(id)).toEqual([]);
    expect(useLocalCopySession.getState().last).toBeNull(); // the window ended with the reload
    expect((await redoLocalCopyImport()).ok).toBe(false);
    void empty;

    // Undo → Redo in one session
    const id2 = ok((await importBytes(x.bytes, "again.local-copy.json", true)).result).recordId;
    const rowsBefore = await rowsOf(id2);
    const recordBefore = docs().characters[id2];
    ok(await undoLocalCopyImport());
    expect(await rowsOf(id2)).toEqual([]);
    ok(await redoLocalCopyImport());
    expect(await rowsOf(id2)).toEqual(rowsBefore);
    expect(docs().characters[id2]).toEqual(recordBefore);
    expect(unsavedState(id2)).toEqual({ entries: 0, days: false });
    await inst.reload();
    expect(await rowsOf(id2)).toEqual(rowsBefore);
    expect(useHistory.getState().meta[id2]?.rev).toBe(1);
    void imported;
  }, 90_000);

  it("refused once the copy changed: a new action, or only a day; the source's Undo stack is not carried", async () => {
    const src = await bigSource("V1");
    expect(docs().history[src.id]).toBeUndefined();
    const x = await exportBytes(src.id);
    await inst.open("V2");
    const id = ok((await importBytes(x.bytes)).result).recordId;
    expect(docs().history[id]).toBeUndefined(); // no undo step for the import in the document stack
    ok(useHistory.getState().startNextDay(id, "Camp"));
    expect(await undoLocalCopyImport()).toMatchObject({ ok: false, code: "undo_import_changed" });
    expect(docs().characters[id]).toBeDefined();
    await inst.open("V3");
    const id3 = ok((await importBytes(x.bytes)).result).recordId;
    inst.fx.dice.push(10);
    ok(await docs().rollTest(id3, { skill: "stealth" }));
    expect(await undoLocalCopyImport()).toMatchObject({ ok: false, code: "undo_import_changed" });
    expect(await rowsOf(id3)).toHaveLength(596);
  }, 90_000);
});

describe("export refusals and a consistent snapshot", () => {
  it("unsaved (failed save), conflicted, missing dependency, over the size limit: refused, nothing written", async () => {
    const src = await bigSource("X1");
    // a failed save
    const put = IDBObjectStore.prototype.put;
    const spy = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (
      this: IDBObjectStore,
      ...args
    ) {
      if (this.name === "history_meta") throw new DOMException("full", "QuotaExceededError");
      return put.apply(this, args as Parameters<typeof put>);
    });
    ok(useHistory.getState().startNextDay(src.id, "Unsaved"));
    expect(await exportLocalCopy(src.id)).toMatchObject({ ok: false, code: "source_unsaved" });
    spy.mockRestore();
    await flushNow();
    expect(useHistory.getState().saveState.status).toBe("saved");
    ok(await exportLocalCopy(src.id));
    // another tab changed the record: conflict
    const database = await db();
    const row = await database.get("characters", src.id);
    await database.put("characters", { ...(row as Loose), rev: 99 });
    inst.fx.dice.push(5);
    ok(await docs().rollTest(src.id, { skill: "stealth" }));
    expect(await exportLocalCopy(src.id)).toMatchObject({ ok: false, code: "source_unsaved" });
    await inst.reload();
    ok(await exportLocalCopy(src.id));
    // a pack of the context missing from storage
    const ctx = docs().characters[src.id]?.content as Loose;
    await (await db()).delete("packs", packKey(ctx.packs[1]));
    expect(await exportLocalCopy(src.id)).toMatchObject({ ok: false, code: "dependency_missing" });
    await storeTestPack();
    // over the limit: refused with its size, no file
    const limits = LOCAL_COPY_LIMITS as { copyBytes: number };
    const saved = limits.copyBytes;
    limits.copyBytes = 100_000;
    try {
      expect(await exportLocalCopy(src.id)).toMatchObject({ ok: false, code: "limit_copy_bytes" });
    } finally {
      limits.copyBytes = saved;
    }
    expect(await exportLocalCopy("c-nobody")).toMatchObject({ ok: false, code: "source_missing" });
  }, 60_000);

  it("a change asked for during the export waits or is refused: the file is always one moment", async () => {
    const src = await bigSource("S1");
    for (let i = 0; i < 3; i++) {
      inst.fx.dice.push(7 + i);
      const exporting = exportLocalCopy(src.id);
      const acting = docs().rollTest(src.id, { skill: "stealth" });
      const day = useHistory.getState().startNextDay(src.id, `During ${i}`);
      const [r] = await Promise.all([exporting, acting]);
      expect(day.ok).toBe(true);
      if (r.ok) {
        const c = r.copy.payload;
        // one moment: the head's next seq matches the entries, the record rev what was saved with them
        expect(c.history.meta?.next_seq).toBe(c.history.entries.length + 1);
        expect(c.source.history_rev).toBe(c.history.meta?.rev);
        expect(c.history.entries.length).toBeGreaterThanOrEqual(595 + i);
      } else expect(r.code).toBe("source_unsaved");
      await flushNow();
    }
    const done = ok(await exportLocalCopy(src.id));
    expect(done.copy.payload.history.entries).toHaveLength(598);
    expect(done.copy.payload.history.meta?.days.at(-1)?.label).toBe("During 2");
  }, 60_000);
});

describe("F-008 unchanged", () => {
  it("the ordinary transfer export still carries no history", async () => {
    const src = await bigSource("T1");
    const env = await exportCharacter(docs().characters[src.id] as Loose, installationId());
    expect(Object.keys(env.content).sort()).toEqual(["build", "context", "state", "state_origin"]);
    expect(env.format).toBe("srd-table.transfer/1");
    expect(await contentSha(env.content)).toBe(env.sha256);
  });
});
