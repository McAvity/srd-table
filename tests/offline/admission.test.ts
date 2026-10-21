/**
 * kenli F-007 T05: the admission gate and the "everything saved" condition (contract offline.md
 * §7.3) on the real store, autosave, in-process engine and fake IndexedDB (unit level; the
 * multi-window protocol runs in a real browser: scripts/f007-update-probe.mjs). With the gate
 * closed every listed mutation is refused with update_in_progress — nothing runs, nothing is
 * written, no history entry; an operation admitted before the close runs to its end and is
 * waited for; the saved check finds every unsaved, failed or conflicting state and every open
 * blocker; after opening, play goes on.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { commitPlan } from "@/import";
import {
  commitLocalCopy,
  redoLocalCopyImport,
  undoLocalCopyImport,
} from "@/import/localCopy/commit";
import { exportLocalCopy } from "@/import/localCopy/export";
import { admission, resetAdmission, UPDATE_IN_PROGRESS } from "@/offline/admission";
import { blockers, savedReasons } from "@/offline/gates";
import { prepareOffline } from "@/offline/readiness";
import { db } from "@/persistence/db";
import { flushNow } from "@/persistence/sync";
import { DOCUMENT_MUTATIONS, useDocuments } from "@/store/documents";
import { useHistory } from "@/store/history";
import { usePortraits } from "@/store/portraits";
import { useRolls } from "@/store/rolls";
import { useSettings } from "@/store/settings";
import { rogue } from "../fixtures/characters";
import { addCharacter, dumpDb, Installations, type Loose, ok } from "../localCopy/helpers";

const inst = new Installations();
const docs = () =>
  useDocuments.getState() as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
beforeEach(() => resetAdmission());
afterEach(() => resetAdmission());
afterAll(() => inst.close());

/** The documents part of the §7.3 inventory, as the contract lists it. */
const CONTRACT_DOCUMENT_MUTATIONS = [
  "createCharacter",
  "importCharacter",
  "duplicateCharacter",
  "deleteCharacter",
  "editBuild",
  "levelUp",
  "setLevelHp",
  "playAction",
  "rollByHand",
  "rollDamage",
  "rollTest",
  "deathSave",
  "lateAdvantage",
  "heroicReroll",
  "setCritical",
  "createEncounter",
  "importEncounter",
  "renameEncounter",
  "deleteEncounter",
  "encounterAction",
  "rollAndPay",
  "clearLog",
  "setPlayMode",
  "undo",
  "redo",
];

describe("the closed gate refuses every mutation entry point, writing nothing", () => {
  it("the document inventory is the contract's (publishImport is publication, not an entry point)", () => {
    expect([...DOCUMENT_MUTATIONS].sort()).toEqual([...CONTRACT_DOCUMENT_MUTATIONS].sort());
  });

  it("documents, days, settings, portraits, imports, the local copy and preparation: refused, nothing written", async () => {
    await inst.open("G1");
    const id = await addCharacter(await rogue(inst.fx.engine, 3), null, inst.fx.engine);
    const eid = await useDocuments.getState().createEncounter("Bridge");
    await flushNow();
    const before = await dumpDb();
    const store = JSON.stringify([
      useDocuments.getState().characters,
      useDocuments.getState().encounters,
    ]);
    const history = JSON.stringify(useHistory.getState().entries);
    admission.close("owner", "u-test");
    const results: Record<string, unknown> = {};
    for (const name of DOCUMENT_MUTATIONS) {
      const args =
        name.includes("Encounter") ||
        ["encounterAction", "clearLog", "setPlayMode", "rollAndPay"].includes(name)
          ? [eid]
          : [id];
      try {
        results[name] = await docs()[name]?.(...args, {}, {}, {});
      } catch (error) {
        results[name] = { threw: String(error) };
      }
    }
    for (const [name, r] of Object.entries(results)) {
      const v = r as Loose;
      const refused =
        v === undefined ||
        v === null ||
        (v.ok === false && v.code === UPDATE_IN_PROGRESS) ||
        (typeof v.threw === "string" && /update is in progress/.test(v.threw));
      expect(refused, name).toBe(true);
    }
    expect(useHistory.getState().startNextDay(id, "x")).toEqual({
      ok: false,
      code: "update.inProgress",
    });
    const meta = useHistory.getState().meta[id];
    expect(useHistory.getState().renameDay(id, meta?.current_day_id ?? "d-x", "y")).toMatchObject({
      ok: false,
    });
    const theme = useSettings.getState().settings.theme;
    useSettings.getState().update({ theme: theme === "felt" ? "mat" : "felt" });
    await useSettings.getState().setContent(["srd-5.2.1"], ["srd"]);
    expect(useSettings.getState().settings.theme).toBe(theme);
    expect(useSettings.getState().settings.sources).toBeNull();
    await usePortraits.getState().set(id, new Blob(["x"]));
    expect(await commitPlan({} as never, {} as never)).toMatchObject({
      ok: false,
      problems: [{ code: UPDATE_IN_PROGRESS }],
    });
    expect(await exportLocalCopy(id)).toMatchObject({ ok: false, code: UPDATE_IN_PROGRESS });
    expect(await commitLocalCopy({} as never)).toMatchObject({
      ok: false,
      code: UPDATE_IN_PROGRESS,
    });
    expect(await undoLocalCopyImport()).toMatchObject({ ok: false, code: UPDATE_IN_PROGRESS });
    expect(await redoLocalCopyImport()).toMatchObject({ ok: false, code: UPDATE_IN_PROGRESS });
    expect((await prepareOffline({ kind: "character", id })).items[0]?.detail).toBe(
      UPDATE_IN_PROGRESS,
    );
    await flushNow();
    expect(await dumpDb()).toBe(before);
    expect(await (await db()).count("portraits")).toBe(0);
    expect(
      JSON.stringify([useDocuments.getState().characters, useDocuments.getState().encounters]),
    ).toBe(store);
    expect(JSON.stringify(useHistory.getState().entries)).toBe(history);

    // opened again (the same request): play goes on, once
    expect(admission.open("u-other")).toBe(false); // a late thaw of another request opens nothing
    expect(admission.open("u-test")).toBe(true);
    inst.fx.dice.push(11);
    ok((await useDocuments.getState().rollTest(id, { skill: "stealth" })) as Loose);
    await flushNow();
    const rows = await (await db()).getAllFromIndex(
      "history",
      "by_record_seq",
      IDBKeyRange.bound([id, 0], [id, 1e9]),
    );
    expect(rows).toHaveLength(1);
  }, 60_000);
});

describe("drain and the saved condition", () => {
  it("an operation admitted before the close runs to its end and is waited for; one asked after is refused", async () => {
    await inst.open("D1");
    const id = await addCharacter(await rogue(inst.fx.engine, 3), null, inst.fx.engine);
    inst.fx.dice.push(12);
    const running = useDocuments.getState().rollTest(id, { skill: "stealth" });
    expect(admission.inFlight()).toBe(1);
    admission.close("owner", "u-1");
    const refused = await useDocuments.getState().rollTest(id, { skill: "stealth" });
    expect(refused).toMatchObject({ ok: false, code: UPDATE_IN_PROGRESS });
    expect(await savedReasons()).toEqual([]); // drained, flushed, saved
    expect(((await running) as Loose).ok).toBe(true);
    const rows = await (await db()).getAllFromIndex(
      "history",
      "by_record_seq",
      IDBKeyRange.bound([id, 0], [id, 1e9]),
    );
    expect(rows).toHaveLength(1); // the admitted roll, saved; the refused one never ran
  }, 60_000);

  it("finds a failed save, a conflict and what isn't saved (day, document, settings); a flush alone isn't proof", async () => {
    await inst.open("D2");
    const id = await addCharacter(await rogue(inst.fx.engine, 3), null, inst.fx.engine);
    expect(await savedReasons()).toEqual([]);
    useHistory.getState().setSaveState({ status: "failed", reason: "labeled: a failed save" });
    // a failed save stays failed for this check only when the flush itself doesn't save again
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = (() => {
      throw new DOMException("full", "QuotaExceededError");
    }) as typeof put;
    try {
      ok(useHistory.getState().startNextDay(id, "Camp"));
      const r = await savedReasons();
      expect(r.map((x) => x.code)).toContain("save_failed");
    } finally {
      IDBObjectStore.prototype.put = put;
    }
    await flushNow();
    expect(await savedReasons()).toEqual([]);
    // another tab wrote the record: conflict
    const database = await db();
    await database.put("characters", {
      ...((await database.get("characters", id)) as Loose),
      rev: 77,
    });
    inst.fx.dice.push(9);
    ok((await useDocuments.getState().rollTest(id, { skill: "stealth" })) as Loose);
    expect((await savedReasons()).map((x) => x.code)).toContain("save_conflict");
  }, 60_000);

  it("blockers: open holds (import, rest, build preview, preparation), a pending decision, an open roll window", async () => {
    await inst.open("B1");
    useRolls.setState({ last: {} }); // the session's roll windows of earlier tests
    const id = await addCharacter(await rogue(inst.fx.engine, 3), null, inst.fx.engine);
    expect(blockers()).toEqual([]);
    const release = admission.hold("rest_preview_open");
    const release2 = admission.hold("import_open");
    expect(
      blockers()
        .map((b) => b.code)
        .sort(),
    ).toEqual(["import_open", "rest_preview_open"]);
    release();
    release2();
    inst.fx.dice.push(13);
    ok((await useDocuments.getState().rollTest(id, { skill: "stealth" })) as Loose);
    expect(blockers().map((b) => b.code)).toEqual(["reroll_window_open"]);
    useRolls.getState().forget(id);
    expect(blockers()).toEqual([]);
  }, 60_000);
});
