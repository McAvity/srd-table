/**
 * The importer end to end on the in-process engine and fake IndexedDB (kenli F-008): preview and
 * commit of a whole graph (Q-01), two versions of a pack side by side, also in one encounter
 * (Q-02), a build without a state only as a confirmed new character (Q-03), duplicates and
 * replacements with compare-and-set, the F-004 refusals, rollback on a storage error, actions
 * racing an import, the IndexedDB upgrade and a local export imported back.
 */

import { openDB } from "idb";
import type { CharacterState, Encounter } from "srd-rules-engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type CharacterChoice,
  commitPlan,
  type Decisions,
  type Plan,
  previewImport,
  type Source,
} from "../../src/import";
import { exportCharacter, exportEncounter, exportInstalledPack } from "../../src/import/export";
import { closeDb, DB_NAME, db } from "../../src/persistence/db";
import { flushNow, installationId, loadAll, startAutosave } from "../../src/persistence/sync";
import { useDocuments } from "../../src/store/documents";
import { useUi } from "../../src/store/ui";
import { resetStores } from "../helpers/app";
import {
  engineWithDice,
  fileOf,
  fixtureJson,
  LIB,
  libraryFetch,
  refs,
  snapshot,
} from "../helpers/transfer";

const docs = () => useDocuments.getState();
let dice: number[] = [];
let stop: (() => void) | null = null;

beforeEach(async () => {
  await resetStores();
  dice = engineWithDice().dice;
  await loadAll();
  stop = startAutosave();
});
afterEach(() => {
  stop?.();
  stop = null;
});

async function preview(
  source: Source,
  over: Parameters<typeof previewImport>[1] extends infer O ? Partial<O> : never = {},
) {
  const p = await previewImport(source, {
    signal: new AbortController().signal,
    fetch: libraryFetch(),
    ...over,
  });
  if (!p.ok) throw new Error(`${p.problem.code}: ${p.problem.detail}`);
  return p.plan;
}
const keyOf = (plan: Plan, title: string) =>
  plan.characters.find((c) => c.title === title)?.key as string;
const choose = (
  plan: Plan,
  entries: Record<string, CharacterChoice>,
  rest: Partial<Decisions> = {},
): Decisions => ({
  characters: Object.fromEntries(
    Object.entries(entries).map(([title, c]) => [keyOf(plan, title), c]),
  ),
  ...rest,
});
const byName = (name: string) =>
  Object.values(docs().characters).find((c) => c.build.name === name);
const codes = (r: Awaited<ReturnType<typeof commitPlan>>) =>
  r.ok ? [] : r.problems.map((p) => p.code);

/** Reload: a new engine (a new worker), the store emptied, everything read back from IndexedDB. */
async function reload() {
  stop?.();
  await closeDb();
  useDocuments.setState({ hydrated: false, characters: {}, encounters: {}, revs: {}, history: {} });
  dice = engineWithDice().dice;
  await loadAll();
  stop = startAutosave();
}

describe("Q-01: an encounter and everything it needs, after one confirmation", () => {
  it("previews the whole graph, writes it in one go, remaps the party, keeps the spent state", async () => {
    const plan = await preview({ url: `${LIB}d/encounter/mixed-duel.json` });
    expect(plan.packs.map((p) => `${p.ref.id}@${p.ref.version}`).sort()).toEqual([
      "synthetic-a@1.0.0",
      "synthetic-a@2.0.0",
    ]);
    expect(plan.characters.map((c) => c.title).sort()).toEqual(["Sable", "Wren"]);
    expect([...(plan.encounter?.partyKeys ?? [])].sort()).toEqual(["sable", "wren"]);
    expect(Object.keys(docs().characters)).toHaveLength(0); // nothing written by the preview
    const result = await commitPlan(plan, { characters: {} });
    expect(result).toMatchObject({ ok: true, packs: 2 });
    const wren = byName("Wren");
    const sable = byName("Sable");
    expect(wren?.content?.packs.map((p) => p.version)).toEqual(["5.2.1", "1.0.0"]);
    expect(sable?.content?.packs.map((p) => p.version)).toEqual(["5.2.1", "2.0.0"]);
    expect(wren?.state.hp.current).toBe(5); // F-004: the state arrives whole
    expect(wren?.state.spell_slots_spent).toEqual([1]);
    expect(wren?.origin).toMatchObject({
      kind: "import",
      id: "synthetic/wren",
      revision: { seq: 2 },
    });
    const enc = Object.values(docs().encounters)[0];
    expect(enc?.content).toEqual(refs.context_v1);
    expect(
      enc?.encounter.combatants
        .map((c) => c.character)
        .filter(Boolean)
        .sort(),
    ).toEqual([sable?.id, wren?.id].sort());
    await flushNow();
    const database = await db();
    expect((await database.getAll("packs")).map((p) => p.key).sort()).toHaveLength(2);
    expect((await database.get("characters", wren?.id as string))?.content).toEqual(wren?.content);
  });

  it("the same graph from files, matched by hash: party missing → refused, nothing written", async () => {
    const p = await previewImport(
      { files: [fileOf("encounters/mixed-duel.transfer.json")] },
      { signal: new AbortController().signal },
    );
    expect(p.ok ? "ok" : p.problem.code).toBe("dependency_missing");
    const files = [
      "encounters/mixed-duel.transfer.json",
      "characters/wren.r2.transfer.json",
      "characters/sable.r1.transfer.json",
      "packs/synthetic-a-1.0.0.transfer.json",
      "packs/synthetic-a-2.0.0.transfer.json",
    ].map(fileOf);
    const plan = await preview({ files });
    expect((await commitPlan(plan, { characters: {} })).ok).toBe(true);
    expect(byName("Wren")?.origin).toMatchObject({ source: { file: "wren.r2.transfer.json" } });
  });

  it("a stopped add_character is remapped too", async () => {
    const files = [
      "encounters/pending-join.transfer.json",
      "characters/wren.r2.transfer.json",
      "characters/sable.r1.transfer.json",
      "packs/synthetic-a-1.0.0.transfer.json",
      "packs/synthetic-a-2.0.0.transfer.json",
    ].map(fileOf);
    const result = await commitPlan(await preview({ files }), { characters: {} });
    expect(result.ok).toBe(true);
    const enc = Object.values(docs().encounters)[0]?.encounter as Encounter;
    expect(enc.pending?.action).toMatchObject({
      type: "add_character",
      character: byName("Sable")?.id,
    });
  });
});

describe("Q-02: versions side by side, each document on its own", () => {
  it("both versions stay installed; per-document views differ, also in parallel", async () => {
    await commitPlan(await preview({ url: `${LIB}d/encounter/mixed-duel.json` }), {
      characters: {},
    });
    const wren = byName("Wren");
    const sable = byName("Sable");
    if (!wren || !sable) throw new Error("not imported");
    const { engine } = { engine: (await import("../../src/engine/client")).engine() };
    const views = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        i % 2
          ? engine.playSheet(wren.build, wren.state, wren.content)
          : engine.playSheet(sable.build, sable.state, sable.content),
      ),
    );
    for (const [i, v] of views.entries())
      expect(v.sheet.resistances).toEqual(i % 2 ? ["fire"] : []);
    // The campaign's catalog (SRD only) knows neither: unpinned views are unaffected.
    expect(
      (await engine.evaluate(wren.build)).report.issues.some((x) => x.severity === "error"),
    ).toBe(true);
  });

  it("a mixed encounter after reload: each character judged by its version (cross and self target)", async () => {
    await commitPlan(await preview({ url: `${LIB}d/encounter/mixed-duel.json` }), {
      characters: {},
    });
    await flushNow();
    await reload();
    const id = Object.keys(docs().encounters)[0] as string;
    const ids = Object.fromEntries(
      Object.values(docs().characters).map((c) => [c.build.name, c.id]),
    );
    const run = async (
      action: Parameters<ReturnType<typeof docs>["encounterAction"]>[1],
      ...rolls: number[]
    ) => {
      dice.push(...rolls);
      const r = await docs().encounterAction(id, action);
      if (!r.ok) throw new Error(r.reasons.join("; "));
      return r;
    };
    await run([
      { type: "set_initiative", id: "wren", value: 20 },
      { type: "set_initiative", id: "sable", value: 15 },
      { type: "set_initiative", id: "synthetic-dummy", value: 1 },
      { type: "start" },
    ]);
    await run(
      { type: "cast", id: "wren", spell: "synthetic-spark", targets: ["synthetic-dummy"] },
      15,
      3,
    );
    expect(
      docs().encounters[id]?.encounter.combatants.find((c) => c.id === "synthetic-dummy")?.hp,
    ).toBe(27);
    await run({ type: "next_turn" });
    await run(
      { type: "cast", id: "sable", spell: "synthetic-spark", targets: ["wren"], slot_level: 1 },
      15,
      3,
      3,
    );
    expect(docs().characters[ids.Wren as string]?.state.hp.current).toBe(2);
    expect(docs().characters[ids.Sable as string]?.state.spell_slots_spent).toEqual([1]);
    for (let i = 0; i < 3; i++) await run({ type: "next_turn" });
    await run(
      { type: "cast", id: "sable", spell: "synthetic-spark", targets: ["sable"], slot_level: 1 },
      15,
      3,
      3,
    );
    expect(docs().characters[ids.Sable as string]?.state.hp.current).toBe(2);
    expect(docs().characters[ids.Sable as string]?.state.spell_slots_spent).toEqual([2]);
  });

  it("same id and version with other bytes is a conflict; a new version installs next to the old", async () => {
    await commitPlan(await preview({ url: snapshot("wren") }), { characters: {} });
    const p = await previewImport(
      { files: [fileOf("negative/pack-same-version-other-bytes.transfer.json")] },
      { signal: new AbortController().signal },
    );
    expect(p.ok ? "ok" : p.problem.code).toBe("pack_identity_conflict");
    const r = await commitPlan(
      await preview({ files: [fileOf("packs/synthetic-a-2.0.0.transfer.json")] }),
      { characters: {} },
    );
    expect(r).toMatchObject({ ok: true, packs: 1 });
    expect((await (await db()).getAll("packs")).map((x) => x.ref.version).sort()).toEqual([
      "1.0.0",
      "2.0.0",
    ]);
    expect(byName("Wren")?.content?.packs[1]?.version).toBe("1.0.0"); // unchanged by the new version
  });
});

describe("Q-03 and F-004: what's imported arrives whole, or not at all", () => {
  it("a build without a state: only a new character, only after ticking its initialization", async () => {
    const plan = await preview({ url: `${LIB}s/${await buildOnlyBytes()}.json` }).catch(() => null);
    const filePlan =
      plan ??
      (await preview({
        files: [
          "characters/wren-build-only.transfer.json",
          "packs/synthetic-a-1.0.0.transfer.json",
        ].map(fileOf),
      }));
    const key = keyOf(filePlan, "Wren");
    expect(codes(await commitPlan(filePlan, { characters: {} }))).toContain("decision_required");
    expect(codes(await commitPlan(filePlan, { characters: { [key]: { kind: "new" } } }))).toContain(
      "initialize_required",
    );
    await commitPlan(await preview({ url: snapshot("sable") }), { characters: {} });
    const sable = byName("Sable")?.id as string;
    expect(
      codes(
        await commitPlan(filePlan, { characters: { [key]: { kind: "replace", target: sable } } }),
      ),
    ).toContain("build_only_replace");
    expect(Object.keys(docs().characters)).toHaveLength(1);
    const r = await commitPlan(filePlan, {
      characters: { [key]: { kind: "new", initialize: true } },
    });
    expect(r.ok).toBe(true);
    const wren = byName("Wren");
    expect(wren?.state.hp.current).toBeNull(); // a fresh state: full HP
    expect(wren?.state.spell_slots_spent).toEqual([]);
    expect(wren?.origin).toMatchObject({ state_origin: "initialized-on-import" });
  });

  it("refuses dropped fields, a state the content would change, and raw files on the wrong content", async () => {
    const dropped = await preview({
      files: [
        "negative/build-dropped-field.transfer.json",
        "packs/synthetic-a-1.0.0.transfer.json",
      ].map(fileOf),
    });
    expect(dropped.characters[0]?.problems.map((p) => p.code)).toContain("fields_dropped");
    expect((await commitPlan(dropped, { characters: {} })).ok).toBe(false);
    const raw = [
      {
        name: "wren.json",
        bytes: bytesOf(fixtureJson("characters/wren.r2.transfer.json").content.build),
      },
      {
        name: "wren.state.json",
        bytes: bytesOf(fixtureJson("characters/wren.r2.transfer.json").content.state),
      },
    ];
    const unchosen = await preview({ files: raw });
    expect(codes(await commitPlan(unchosen, { characters: {} }))).toContain(
      "context_choice_required",
    );
    const onCampaign = await preview({ files: raw }, { rawContent: "campaign" });
    expect(onCampaign.characters[0]?.problems.map((p) => p.code)).toContain("build_invalid"); // SRD alone lacks the spell
    await commitPlan(await preview({ files: [fileOf("packs/synthetic-a-1.0.0.transfer.json")] }), {
      characters: {},
    });
    const pinned = await preview({ files: raw }, { rawContent: refs.context_v1 });
    expect(pinned.characters[0]?.problems).toEqual([]);
    expect((await commitPlan(pinned, { characters: {} })).ok).toBe(true);
    expect(byName("Wren")?.state.hp.current).toBe(5);
    expect(Object.keys(docs().characters)).toHaveLength(1);
  });
});

describe("duplicates, replacements, compare-and-set", () => {
  it("an identical re-import is recognised; after play it's 'changed here'; an older one is older", async () => {
    await commitPlan(await preview({ url: snapshot("wren") }), { characters: {} });
    const again = await preview({ url: snapshot("wren") });
    expect(again.characters[0]?.candidates[0]?.relation).toBe("unchanged");
    expect((await commitPlan(again, { characters: {} })).ok).toBe(true); // default: nothing
    expect(Object.keys(docs().characters)).toHaveLength(1);
    const id = byName("Wren")?.id as string;
    await docs().playAction(id, { type: "damage", amount: 1 });
    expect((await preview({ url: snapshot("wren") })).characters[0]?.candidates[0]?.relation).toBe(
      "changed-locally",
    );
    const older = await preview({
      files: ["characters/wren.r1.transfer.json", "packs/synthetic-a-1.0.0.transfer.json"].map(
        fileOf,
      ),
    });
    expect(older.characters[0]?.candidates[0]?.relation).toBe("older");
  });

  it("replace: only the record picked, checked against its revision; undo brings the old one back", async () => {
    await commitPlan(await preview({ url: snapshot("wren") }), { characters: {} });
    const id = byName("Wren")?.id as string;
    await docs().playAction(id, { type: "damage", amount: 1 });
    const plan = await preview({ url: snapshot("wren") });
    expect(
      codes(await commitPlan(plan, choose(plan, { Wren: { kind: "replace", target: id } }))),
    ).toContain("replace_confirm_required");
    const replace = choose(plan, { Wren: { kind: "replace", target: id, confirmed: true } });
    await docs().playAction(id, { type: "damage", amount: 1 }); // a newer action after the preview
    expect(codes(await commitPlan(plan, replace))).toEqual(["target_changed"]);
    expect(docs().characters[id]?.state.hp.current).toBe(3);
    const fresh = await preview({ url: snapshot("wren") });
    const r = await commitPlan(
      fresh,
      choose(fresh, { Wren: { kind: "replace", target: id, confirmed: true } }),
    );
    expect(r.ok).toBe(true);
    expect(docs().characters[id]?.state.hp.current).toBe(5);
    expect(docs().characters[id]?.gen).toBe(1);
    await docs().undo(id);
    expect(docs().characters[id]?.state.hp.current).not.toBe(5);
  });
});

describe("the commit: all or nothing, and actions racing it", () => {
  it("a storage error (quota) writes nothing: no pack, no character, no encounter, nothing shown", async () => {
    const restore = failPuts("characters");
    const r = await commitPlan(await preview({ url: `${LIB}d/encounter/mixed-duel.json` }), {
      characters: {},
    });
    restore();
    expect(codes(r)).toEqual(["storage_quota"]);
    const database = await db();
    expect(await database.getAll("packs")).toEqual([]);
    expect(await database.getAll("characters")).toEqual([]);
    expect(await database.getAll("encounters")).toEqual([]);
    expect(Object.keys(docs().characters)).toHaveLength(0);
  });

  it("an action asked for during a replacement runs after it and is refused, not lost; after a failed one it applies", async () => {
    await commitPlan(await preview({ url: snapshot("wren") }), { characters: {} });
    const id = byName("Wren")?.id as string;
    await docs().playAction(id, { type: "damage", amount: 2 });
    const plan = await preview({ url: snapshot("wren") });
    const decisions = choose(plan, { Wren: { kind: "replace", target: id, confirmed: true } });
    const committing = commitPlan(plan, decisions);
    const action = docs().playAction(id, { type: "damage", amount: 1 });
    expect((await committing).ok).toBe(true);
    const refused = await action;
    expect(refused.ok).toBe(false);
    expect(docs().characters[id]?.state.hp.current).toBe(5); // the import, not lost under the action
    expect(useUi.getState().toasts.at(-1)?.lines.join(" ")).toMatch(/replaced by an import/);
    // A failed commit releases the record unchanged: the waiting action applies.
    const again = await preview({ url: snapshot("wren") });
    const restore = failPuts("characters");
    const failing = commitPlan(
      again,
      choose(again, { Wren: { kind: "replace", target: id, confirmed: true } }),
    );
    const applied = docs().playAction(id, { type: "damage", amount: 1 });
    expect(codes(await failing)).toEqual(["storage_quota"]);
    restore();
    expect((await applied).ok).toBe(true);
    expect(docs().characters[id]?.state.hp.current).toBe(4);
  });

  it("a delete asked for during a replacement is refused too; a duplicate says where it came from", async () => {
    await commitPlan(await preview({ url: snapshot("wren") }), { characters: {} });
    const id = byName("Wren")?.id as string;
    await docs().playAction(id, { type: "damage", amount: 2 });
    const plan = await preview({ url: snapshot("wren") });
    const committing = commitPlan(
      plan,
      choose(plan, { Wren: { kind: "replace", target: id, confirmed: true } }),
    );
    const removal = docs().deleteCharacter(id);
    expect((await committing).ok).toBe(true);
    await removal;
    expect(docs().characters[id]?.state.hp.current).toBe(5);
    const copy = await docs().duplicateCharacter(id);
    expect(docs().characters[copy as string]).toMatchObject({
      origin: { kind: "duplicate", of: id },
      rev: 1,
    });
    expect(docs().characters[copy as string]?.content).toEqual(docs().characters[id]?.content);
  });

  it("autosave never overwrites a change made in another tab (compare-and-set)", async () => {
    const cid = await docs().createCharacter();
    await flushNow();
    const database = await db();
    const theirs = { ...(await database.get("characters", cid)), rev: 9, updated: 1 } as never;
    await database.put("characters", theirs); // another tab saved a newer revision
    await docs().playAction(cid, { type: "damage", amount: 1 });
    await flushNow();
    expect((await database.get("characters", cid))?.rev).toBe(9);
    expect(useUi.getState().toasts.at(-1)?.lines.join(" ")).toMatch(/another tab/);
  });
});

describe("storage upgrade and local export", () => {
  it("v1 → v3 adds the pack store and the (empty) journal stores, and rewrites nothing", async () => {
    stop?.();
    await closeDb();
    await new Promise<void>((r) => {
      const req = indexedDB.deleteDatabase(DB_NAME);
      req.onsuccess = () => r();
      req.onerror = () => r();
    });
    const old = await openDB(DB_NAME, 1, {
      upgrade(d) {
        d.createObjectStore("characters", { keyPath: "id" });
        d.createObjectStore("encounters", { keyPath: "id" });
        d.createObjectStore("settings");
        d.createObjectStore("portraits");
      },
    });
    const record = {
      id: "c-old",
      build: fixtureJson("characters/wren.r2.transfer.json").content.build,
      state: { version: 1 },
      created: 1,
      updated: 2,
    };
    await old.put("characters", record);
    old.close();
    useDocuments.setState({
      hydrated: false,
      characters: {},
      encounters: {},
      revs: {},
      history: {},
    });
    await loadAll();
    const database = await db();
    expect(database.version).toBe(3); // kenli F-006 added the journal stores (v3)
    expect([...database.objectStoreNames]).toContain("packs");
    expect(await database.getAll("history")).toEqual([]);
    expect(await database.getAll("history_meta")).toEqual([]);
    expect(docs().characters["c-old"]?.content).toBeUndefined(); // no invented pin
    const stored = await database.get("characters", "c-old");
    expect(stored?.content).toBeUndefined();
    expect(stored?.build).toEqual(record.build);
  });

  it("an installed pack exports as the same transfer identity, its SRD by exact ref", async () => {
    await commitPlan(await preview({ url: snapshot("wren") }), { characters: {} });
    const key = (await (await db()).getAllKeys("packs"))[0] as string;
    const env = await exportInstalledPack(key, installationId());
    if (!env || "ambiguous" in env) throw new Error("no export");
    expect(env.sha256).toBe(refs["synthetic-a@1.0.0"].sha256);
    expect(env.requires.map((r) => r.sha256)).toEqual([refs.srd.sha256]);
    const back = await preview({ files: [{ name: "a1.json", bytes: bytesOf(env) }] });
    expect(back.packs).toHaveLength(1); // installing it again is the same content (not a conflict)
  });

  it("a local export comes back to the same records; after play it asks; a later change is caught", async () => {
    await commitPlan(await preview({ url: `${LIB}d/encounter/mixed-duel.json` }), {
      characters: {},
    });
    const enc = Object.values(docs().encounters)[0];
    if (!enc) throw new Error("no encounter");
    const { encounter } = await exportEncounter(enc, docs().characters, installationId());
    const file = { name: "duel.transfer.json", bytes: bytesOf(encounter) };
    const same = await preview({ files: [file] });
    expect(same.characters.every((c) => c.local && !c.local.changed)).toBe(true);
    expect((await commitPlan(same, { characters: {} })).ok).toBe(true);
    expect(Object.keys(docs().characters)).toHaveLength(2); // no copies: the same records
    const wren = byName("Wren")?.id as string;
    await docs().playAction(wren, { type: "damage", amount: 1 });
    const changed = await preview({ files: [file] });
    expect(codes(await commitPlan(changed, { characters: {} }))).toContain(
      "dependency_changed_locally",
    );
    const wrenKey = changed.characters.find((c) => c.local?.recordId === wren)?.key as string;
    const use = { characters: { [wrenKey]: { kind: "use" as const, target: wren } } };
    await docs().playAction(wren, { type: "heal", amount: 1 });
    expect(codes(await commitPlan(changed, use))).toEqual(["target_changed"]);
    const fresh = await preview({ files: [file] });
    expect((await commitPlan(fresh, use)).ok).toBe(true);
    // Another installation has none of these records: the party must come as files.
    const exported = await exportCharacter(docs().characters[wren] as never, "other-installation");
    expect(exported.id.startsWith("table/other-installation/")).toBe(true);
  });
});

function bytesOf(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

async function buildOnlyBytes(): Promise<string> {
  return "none"; // the build-only fixture isn't in the library: it's imported from files
}

/** Make `put` on one store fail with QuotaExceededError (fake IndexedDB), until restored. */
function failPuts(store: string): () => void {
  const proto = IDBObjectStore.prototype;
  const original = proto.put;
  proto.put = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore["put"]>) {
    if (this.name === store) throw new DOMException("quota", "QuotaExceededError");
    return original.apply(this, args);
  };
  return () => {
    proto.put = original;
  };
}

void ({} as CharacterState);
