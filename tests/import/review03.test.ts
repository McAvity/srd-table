/**
 * Review 03 of kenli F-008 T03, on the in-process engine and fake IndexedDB: undo and redo of an
 * import restore the whole record (R03-02), a change takes its set of records again when its turn
 * comes (R03-03), one pack version is one set of bytes, checked in the commit's transaction
 * (R03-04), the served SRD kept in storage as `bundled` (R03-05), and a stopped autosave that
 * never writes again.
 */

import { openDB } from "idb";
import type { EncounterAction } from "srd-rules-engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { engine, setEngine } from "../../src/engine/client";
import { createInProcessFacade, type EngineFacade } from "../../src/engine/facade";
import {
  type CharacterChoice,
  commitPlan,
  type Decisions,
  type Plan,
  previewImport,
  type Source,
} from "../../src/import";
import { campaignContext, exportCharacter } from "../../src/import/export";
import { packRefOf } from "../../src/lib/canonical";
import { closeDb, DB_NAME, db, packKey } from "../../src/persistence/db";
import {
  flushNow,
  installationId,
  loadAll,
  persistBundled,
  startAutosave,
} from "../../src/persistence/sync";
import { lockDocuments, useDocuments } from "../../src/store/documents";
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
let stop: (() => void) | null = null;

beforeEach(async () => {
  await resetStores();
  engineWithDice();
  await loadAll();
  stop = startAutosave();
});
afterEach(() => {
  stop?.();
  stop = null;
  setEngine(engineWithDice().engine);
});

async function preview(source: Source) {
  const p = await previewImport(source, {
    signal: new AbortController().signal,
    fetch: libraryFetch(),
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
const replaceWith = async (title: string, url: string, target: string) => {
  const p = await preview({ url });
  return commitPlan(p, choose(p, { [title]: { kind: "replace", target, confirmed: true } }));
};
const replacedText = "replaced by an import";
const gate = () => {
  let open!: () => void;
  const closed = new Promise<void>((r) => {
    open = r;
  });
  return { closed, open };
};
const tick = () => new Promise((r) => setTimeout(r, 100));

async function reload(facade: EngineFacade = engineWithDice().engine) {
  stop?.();
  await closeDb();
  useDocuments.setState({ hydrated: false, characters: {}, encounters: {}, revs: {}, history: {} });
  setEngine(facade);
  await loadAll();
  stop = startAutosave();
}

/** A put or add into one store fails as a full disk does. */
function failWrites(store: string): () => void {
  const proto = IDBObjectStore.prototype;
  const { put, add } = proto;
  proto.put = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore["put"]>) {
    if (this.name === store) throw new DOMException("quota", "QuotaExceededError");
    return put.apply(this, args);
  };
  proto.add = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore["add"]>) {
    if (this.name === store) throw new DOMException("quota", "QuotaExceededError");
    return add.apply(this, args);
  };
  return () => {
    proto.put = put;
    proto.add = add;
  };
}

describe("R03-02: undo and redo restore the whole record", () => {
  it("a legacy character replaced by a pinned one: back and forth, a new revision and generation each time", async () => {
    const id = await docs().createCharacter();
    const legacy = docs().characters[id];
    if (!legacy) throw new Error("no character");
    expect(legacy.content).toBeUndefined();
    expect((await replaceWith("Sable", snapshot("sable"), id)).ok).toBe(true);
    const pinned = docs().characters[id];
    if (!pinned) throw new Error("no character");
    expect(pinned.content).toEqual(refs.context_v2);
    expect(pinned.gen).toBe(1);

    await docs().undo(id);
    const back = docs().characters[id];
    if (!back) throw new Error("no character");
    expect(back.build).toEqual(legacy.build);
    expect(back.state).toEqual(legacy.state);
    expect("content" in back).toBe(false);
    expect("origin" in back).toBe(false);
    expect(back.gen).toBe(2);
    expect(back.rev).toBe((pinned.rev ?? 0) + 1);
    // Exported now, it's the campaign's character again (no import to derive from).
    const exported = await exportCharacter(back, installationId());
    expect(exported.content.context).toEqual(await campaignContext());
    expect(exported.extensions).toEqual({});

    await docs().redo(id);
    const again = docs().characters[id];
    if (!again) throw new Error("no character");
    expect(again.build).toEqual(pinned.build);
    expect(again.content).toEqual(refs.context_v2);
    expect(again.origin).toEqual(pinned.origin);
    expect(again.gen).toBe(3);
    expect(again.rev).toBe((back.rev ?? 0) + 1);

    await docs().undo(id);
    await flushNow();
    const saved = docs().characters[id];
    await reload();
    expect(docs().characters[id]).toEqual(saved);
    expect(docs().characters[id]?.content).toBeUndefined();
  });

  it("play steps on both sides of a replacement keep their own version", async () => {
    await commitPlan(await preview({ url: snapshot("wren") }), { characters: {} });
    const id = byName("Wren")?.id as string;
    const wren = docs().characters[id];
    await docs().playAction(id, { type: "damage", amount: 1 });
    expect((await replaceWith("Sable", snapshot("sable"), id)).ok).toBe(true);
    await docs().playAction(id, { type: "damage", amount: 2 });
    expect(docs().characters[id]?.state.hp.current).toBe(6);

    await docs().undo(id); // Sable's damage
    expect(docs().characters[id]?.state.hp.current).toBeNull();
    expect(docs().characters[id]?.content).toEqual(refs.context_v2);
    expect(docs().characters[id]?.gen).toBe(1);
    await docs().undo(id); // the replacement
    expect(docs().characters[id]?.build.name).toBe("Wren");
    expect(docs().characters[id]?.state.hp.current).toBe(4);
    expect(docs().characters[id]?.content).toEqual(refs.context_v1);
    expect(docs().characters[id]?.origin).toEqual(wren?.origin);
    expect(docs().characters[id]?.gen).toBe(2);
    await docs().undo(id); // Wren's damage
    expect(docs().characters[id]?.state.hp.current).toBe(5);
    expect(docs().characters[id]?.gen).toBe(2);
    const sheet = await engine().playSheet(
      docs().characters[id]?.build as never,
      docs().characters[id]?.state as never,
      docs().characters[id]?.content,
    );
    expect(sheet.sheet.resistances).toEqual(["fire"]);
    await docs().redo(id);
    await docs().redo(id);
    expect(docs().characters[id]?.build.name).toBe("Sable");
    expect(docs().characters[id]?.content).toEqual(refs.context_v2);
    expect(docs().characters[id]?.gen).toBe(3);
  });

  it("a change asked for before an undo changed the version is refused, not applied to the other one", async () => {
    await commitPlan(await preview({ url: snapshot("wren") }), { characters: {} });
    const id = byName("Wren")?.id as string;
    expect((await replaceWith("Sable", snapshot("sable"), id)).ok).toBe(true);
    const held = gate();
    const holding = lockDocuments([id], () => held.closed);
    const undo = docs().undo(id);
    const damage = docs().playAction(id, { type: "damage", amount: 1 });
    held.open();
    await holding;
    await undo;
    const r = await damage;
    expect(r.ok).toBe(false);
    expect(r.ok ? [] : r.reasons.join(" ")).toContain(replacedText);
    expect(docs().characters[id]?.build.name).toBe("Wren");
    expect(docs().characters[id]?.state.hp.current).toBe(5);
  });

  it("an encounter replaced by an import comes back whole (name, log, content, origin), and goes forward again", async () => {
    const eid = await docs().createEncounter("Old table");
    const old = docs().encounters[eid];
    if (!old) throw new Error("no encounter");
    const p = await preview({ url: `${LIB}d/encounter/mixed-duel.json` });
    expect(
      (
        await commitPlan(p, {
          characters: {},
          encounter: { kind: "replace", target: eid, confirmed: true },
        })
      ).ok,
    ).toBe(true);
    const imported = docs().encounters[eid];
    if (!imported) throw new Error("no encounter");
    expect(imported.content).toEqual(refs.context_v1);
    expect(imported.name).not.toBe("Old table");
    await docs().undo(eid);
    const back = docs().encounters[eid];
    if (!back) throw new Error("no encounter");
    expect(back.name).toBe("Old table");
    expect(back.encounter).toEqual(old.encounter);
    expect(back.log).toEqual(old.log);
    expect("content" in back).toBe(false);
    expect("origin" in back).toBe(false);
    expect(back.gen).toBe(2);
    expect(back.rev).toBe((imported.rev ?? 0) + 1);
    await docs().redo(eid);
    const again = docs().encounters[eid];
    expect(again?.name).toBe(imported.name);
    expect(again?.encounter).toEqual(imported.encounter);
    expect(again?.content).toEqual(refs.context_v1);
    expect(again?.origin).toEqual(imported.origin);
    expect(again?.gen).toBe(3);
  });

  it("undoing an encounter step leaves a party member an import replaced since as it is", async () => {
    await commitPlan(await preview({ url: snapshot("wren") }), { characters: {} });
    const id = byName("Wren")?.id as string;
    const eid = await docs().createEncounter("Step");
    expect(
      (await docs().encounterAction(eid, { type: "add_character", character: id, id: "wren" })).ok,
    ).toBe(true);
    expect(
      (
        await docs().encounterAction(eid, {
          type: "effects",
          id: "wren",
          actions: [{ type: "damage", amount: 1 }],
        })
      ).ok,
    ).toBe(true);
    expect(docs().characters[id]?.state.hp.current).toBe(4);
    expect((await replaceWith("Sable", snapshot("sable"), id)).ok).toBe(true);
    await docs().undo(eid);
    // The encounter goes back; Sable keeps her own state (not the old Wren's HP 5).
    expect(docs().characters[id]?.build.name).toBe("Sable");
    expect(docs().characters[id]?.state.hp.current).toBeNull();
    await docs().redo(eid);
    expect(docs().characters[id]?.state.hp.current).toBeNull();
  });
});

describe("R03-03: a change's records are taken again when its turn comes", () => {
  /** The engine with its first two encounter calls held until released (later ones run). */
  function heldEngine() {
    const base = engine();
    const gates = [gate(), gate()];
    const started = [gate(), gate()];
    let calls = 0;
    setEngine({
      ...base,
      applyEncounterAction: async (...args: Parameters<typeof base.applyEncounterAction>) => {
        const n = calls++;
        const result = await base.applyEncounterAction(...args);
        started[n]?.open();
        await gates[n]?.closed;
        return result;
      },
    });
    return { gates, started };
  }

  async function setup() {
    await commitPlan(await preview({ url: snapshot("wren") }), { characters: {} });
    const id = byName("Wren")?.id as string;
    const eid = await docs().createEncounter("Race");
    await flushNow();
    return { id, eid, plan: await preview({ url: snapshot("sable") }) };
  }
  const damage: EncounterAction = {
    type: "effects",
    id: "wren",
    actions: [{ type: "damage", amount: 1 }],
  };

  it("an action already running for a character who just joined: the import waits for it and is refused, the action stays", async () => {
    const { id, eid, plan } = await setup();
    const { gates, started } = heldEngine();
    const join = docs().encounterAction(eid, { type: "add_character", character: id, id: "wren" });
    const hit = docs().encounterAction(eid, damage); // asked for before Wren was in the party
    gates[0]?.open();
    expect((await join).ok).toBe(true);
    await started[1]?.closed;
    const committing = commitPlan(
      plan,
      choose(plan, { Sable: { kind: "replace", target: id, confirmed: true } }),
    );
    await tick();
    // Still the old Wren: the import waits for the action holding her.
    expect(docs().characters[id]?.build.name).toBe("Wren");
    gates[1]?.open();
    expect((await hit).ok).toBe(true);
    expect(codes(await committing)).toEqual(["target_changed"]);
    expect(docs().characters[id]?.build.name).toBe("Wren");
    expect(docs().characters[id]?.state.hp.current).toBe(4);
    expect(docs().characters[id]?.content).toEqual(refs.context_v1);
    await flushNow();
    const stored = await (await db()).get("characters", id);
    expect((stored?.state as { hp: { current: number } } | undefined)?.hp.current).toBe(4);
  });

  it("an action waiting while the character joins, an import queued too: the import first, the action refused", async () => {
    const { id, eid, plan } = await setup();
    const { gates } = heldEngine();
    const join = docs().encounterAction(eid, { type: "add_character", character: id, id: "wren" });
    const hit = docs().encounterAction(eid, damage);
    const committing = commitPlan(
      plan,
      choose(plan, { Sable: { kind: "replace", target: id, confirmed: true } }),
    );
    await tick(); // the import waits for Wren's queue (the join holds it)
    gates[0]?.open();
    expect((await join).ok).toBe(true);
    expect((await committing).ok).toBe(true);
    const r = await hit;
    expect(r.ok).toBe(false);
    expect(r.ok ? [] : r.reasons.join(" ")).toContain(replacedText);
    expect(docs().characters[id]?.build.name).toBe("Sable");
    expect(docs().characters[id]?.state.hp.current).toBeNull();
    await flushNow();
    const stored = await (await db()).get("characters", id);
    expect(
      (stored?.state as { hp: { current: number | null } } | undefined)?.hp.current,
    ).toBeNull();
  });

  it("the same, the import failing (full disk): the action then applies to the joined character", async () => {
    const { id, eid, plan } = await setup();
    const { gates } = heldEngine();
    const join = docs().encounterAction(eid, { type: "add_character", character: id, id: "wren" });
    const hit = docs().encounterAction(eid, damage);
    const restore = failWrites("characters");
    const committing = commitPlan(
      plan,
      choose(plan, { Sable: { kind: "replace", target: id, confirmed: true } }),
    );
    await tick();
    gates[0]?.open();
    expect((await join).ok).toBe(true);
    expect(codes(await committing)).toEqual(["storage_quota"]);
    restore();
    gates[1]?.open();
    expect((await hit).ok).toBe(true);
    expect(docs().characters[id]?.build.name).toBe("Wren");
    expect(docs().characters[id]?.state.hp.current).toBe(4);
  });

  it("a queued undo takes the party of the step on top when it runs: refused after an import replaced it meanwhile", async () => {
    const { id, eid, plan } = await setup();
    const { gates } = heldEngine();
    const join = docs().encounterAction(eid, { type: "add_character", character: id, id: "wren" });
    const undo = docs().undo(eid); // nothing to undo yet: the join's step (with Wren) comes on top
    const committing = commitPlan(
      plan,
      choose(plan, { Sable: { kind: "replace", target: id, confirmed: true } }),
    );
    await tick();
    gates[0]?.open();
    expect((await join).ok).toBe(true);
    expect((await committing).ok).toBe(true);
    await undo;
    // Refused: the join stays, Sable untouched.
    expect(docs().encounters[eid]?.encounter.combatants.map((c) => c.character)).toEqual([id]);
    expect(docs().characters[id]?.build.name).toBe("Sable");
    expect(docs().characters[id]?.state.hp.current).toBeNull();
    expect(useUi.getState().toasts.some((t) => t.lines.join(" ").includes(replacedText))).toBe(
      true,
    );
  });

  it("the same, the import failing: the queued undo then takes the join back", async () => {
    const { id, eid, plan } = await setup();
    const { gates } = heldEngine();
    const join = docs().encounterAction(eid, { type: "add_character", character: id, id: "wren" });
    const undo = docs().undo(eid);
    const restore = failWrites("characters");
    const committing = commitPlan(
      plan,
      choose(plan, { Sable: { kind: "replace", target: id, confirmed: true } }),
    );
    await tick();
    gates[0]?.open();
    expect((await join).ok).toBe(true);
    expect(codes(await committing)).toEqual(["storage_quota"]);
    restore();
    await undo;
    expect(docs().encounters[eid]?.encounter.combatants).toEqual([]);
    expect(docs().characters[id]?.build.name).toBe("Wren");
    expect(docs().characters[id]?.state.hp.current).toBe(5);
  });

  it("an undo asked for first runs first: the import after it finds the record changed", async () => {
    const { id, eid, plan } = await setup();
    await docs().encounterAction(eid, { type: "add_character", character: id, id: "wren" });
    await docs().encounterAction(eid, damage);
    const held = gate();
    const holding = lockDocuments([eid], () => held.closed);
    const undo = docs().undo(eid); // its step has Wren: it holds her from now on
    const committing = commitPlan(
      plan,
      choose(plan, { Sable: { kind: "replace", target: id, confirmed: true } }),
    );
    await tick();
    expect(docs().characters[id]?.build.name).toBe("Wren");
    held.open();
    await holding;
    await undo;
    expect(codes(await committing)).toEqual(["target_changed"]);
    expect(docs().characters[id]?.state.hp.current).toBe(5);
  });
  it("a character who left the encounter is not held: an import of her runs while the encounter is busy", async () => {
    const { id, eid, plan } = await setup();
    await docs().encounterAction(eid, { type: "add_character", character: id, id: "wren" });
    expect((await docs().encounterAction(eid, { type: "remove", id: "wren" })).ok).toBe(true);
    const held = gate();
    const holding = lockDocuments([eid], () => held.closed);
    const later = docs().encounterAction(eid, { type: "next_turn" });
    const r = await commitPlan(
      plan,
      choose(plan, { Sable: { kind: "replace", target: id, confirmed: true } }),
    );
    expect(r.ok).toBe(true);
    held.open();
    await holding;
    await later;
    expect(docs().characters[id]?.build.name).toBe("Sable");
  });
});

describe("R03-04: one version of a pack is one set of bytes, checked in the commit", () => {
  it("two previews of other bytes under one version: the second commit is refused whole", async () => {
    const p1 = await preview({ files: [fileOf("packs/synthetic-a-1.0.0.transfer.json")] });
    const p2 = await preview({
      files: [fileOf("negative/pack-same-version-other-bytes.transfer.json")],
    });
    const same = await preview({ files: [fileOf("packs/synthetic-a-1.0.0.transfer.json")] });
    expect((await commitPlan(p1, { characters: {} })).ok).toBe(true);
    expect(codes(await commitPlan(p2, { characters: {} }))).toEqual(["pack_identity_conflict"]);
    expect((await commitPlan(same, { characters: {} })).ok).toBe(true); // the same bytes: nothing new
    const keys = (await (await db()).getAll("packs")).map((p) => p.key);
    expect(keys).toEqual([packKey(refs["synthetic-a@1.0.0"])]);
  });

  it("other bytes installed by another connection after the preview: nothing of the graph is written", async () => {
    const plan = await preview({ url: snapshot("wren") });
    const other = (
      fixtureJson("negative/pack-same-version-other-bytes.transfer.json") as {
        content: { files: Record<string, unknown> };
      }
    ).content.files;
    const ref = await packRefOf(other);
    expect(ref.id).toBe("synthetic-a");
    expect(ref.version).toBe("1.0.0");
    const second = await openDB(DB_NAME);
    await second.add("packs", {
      key: packKey(ref),
      ref,
      files: other,
      installed_at: 1,
      origin: { kind: "import", file: "other-tab" },
    });
    second.close();
    expect(codes(await commitPlan(plan, { characters: {} }))).toEqual(["pack_identity_conflict"]);
    const database = await db();
    expect((await database.getAll("packs")).map((p) => p.ref.sha256)).toEqual([ref.sha256]);
    expect(await database.getAll("characters")).toEqual([]);
    expect(Object.keys(docs().characters)).toHaveLength(0);
  });
});

describe("R03-05: the served SRD kept in storage", () => {
  it("is stored whole, verified, as bundled, once", async () => {
    expect(await persistBundled()).toBe("added");
    const stored = await (await db()).get("packs", packKey(refs.srd));
    if (!stored) throw new Error("not stored");
    expect(stored.ref).toEqual(refs.srd);
    expect(stored.origin).toEqual({ kind: "bundled" });
    expect(await packRefOf(stored.files)).toEqual(refs.srd);
    const manifest = stored.files["manifest.json"] as { tables: Record<string, { file: string }> };
    const tables = Object.values(manifest.tables).map((t) => t.file);
    expect(tables.length).toBeGreaterThan(10);
    expect(Object.keys(stored.files).sort()).toEqual(["manifest.json", ...tables].sort());
    expect(await persistBundled()).toBe("present");
    expect((await (await db()).getAll("packs")).map((p) => p.key)).toEqual([packKey(refs.srd)]);
  });

  it("a full disk is said, nothing is stored, the app goes on", async () => {
    const restore = failWrites("packs");
    expect(await persistBundled()).toBe("failed");
    restore();
    expect(await (await db()).getAll("packs")).toEqual([]);
    const toast = useUi.getState().toasts.at(-1);
    expect(toast?.tone).toBe("error");
    expect(toast?.lines.join(" ")).toContain("storage is full");
    const id = await docs().createCharacter();
    expect((await docs().playAction(id, { type: "damage", amount: 1 })).ok).toBe(true);
  });

  it("read from storage by a new worker with the host gone: pinned and campaign documents, an import", async () => {
    await persistBundled();
    await commitPlan(await preview({ url: snapshot("sable") }), { characters: {} });
    const legacy = await docs().createCharacter();
    await flushNow();
    let fetches = 0;
    await reload(
      createInProcessFacade({
        seed: 1,
        fetchFile: async () => {
          fetches++;
          throw new Error("host down");
        },
      }),
    );
    const sable = byName("Sable");
    if (!sable) throw new Error("not reloaded");
    const view = await engine().playSheet(sable.build, sable.state, sable.content);
    expect(view.sheet.resistances).toEqual([]);
    expect((await engine().entries("monsters", sable.content)).length).toBeGreaterThan(100);
    const campaign = docs().characters[legacy];
    if (!campaign) throw new Error("not reloaded");
    expect((await engine().evaluate(campaign.build)).build).toEqual(campaign.build);
    expect(await engine().servedPack("srd-5.2.1")).toEqual(refs.srd);
    const wren = await preview({ url: snapshot("wren") });
    expect(wren.present.map((p) => p.ref)).toContainEqual(refs.srd);
    expect((await commitPlan(wren, { characters: {} })).ok).toBe(true);
    expect(fetches).toBeGreaterThan(0); // tried, refused, served from storage
  });
});

describe("autosave", () => {
  it("a save forced while one waits takes its place: nothing is written after the autosave stopped", async () => {
    const eid = await docs().createEncounter("Before"); // a save waits (debounced)
    await flushNow(); // forced now
    stop?.();
    stop = null;
    await docs().renameEncounter(eid, "After"); // not saved: autosave stopped
    expect(docs().encounters[eid]?.name).toBe("After");
    await new Promise((r) => setTimeout(r, 400)); // past the debounce
    expect((await (await db()).get("encounters", eid))?.name).toBe("Before");
  });
});

describe("review 03 reproductions (the reviewer's assertions, unchanged)", () => {
  it("REVIEW undo restores content as well as state", async () => {
    await commitPlan(await preview({ url: snapshot("wren") }), { characters: {} });
    const id = byName("Wren")?.id as string;
    const old = docs().characters[id];
    if (!old) throw new Error("not imported");
    const p = await preview({ url: snapshot("sable") });
    expect(
      (await commitPlan(p, choose(p, { Sable: { kind: "replace", target: id, confirmed: true } })))
        .ok,
    ).toBe(true);
    await docs().undo(id);
    expect(docs().characters[id]?.build).toEqual(old.build);
    expect(docs().characters[id]?.content).toEqual(old.content);
  });

  it("REVIEW competing previews cannot install conflicting pack identities", async () => {
    const p1 = await preview({ files: [fileOf("packs/synthetic-a-1.0.0.transfer.json")] });
    const p2 = await preview({
      files: [fileOf("negative/pack-same-version-other-bytes.transfer.json")],
    });
    expect((await commitPlan(p1, { characters: {} })).ok).toBe(true);
    const second = await commitPlan(p2, { characters: {} });
    expect(codes(second)).toContain("pack_identity_conflict");
  });
});
