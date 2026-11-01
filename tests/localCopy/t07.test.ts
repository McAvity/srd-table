/**
 * kenli F-002 T07 (dnd5 contracts/progression.md §9): the full copy `/3`, on the real store,
 * autosave, worker-equivalent engine and fake IndexedDB, two installations (profiles).
 *
 *  - A character following a plan, played (damage, a use, a custom item), a level gained from the
 *    plan (a `kenli.history/3` entry), a portrait: exported as `/3` and imported into a clean
 *    profile — the plan, state, journal, portrait and exact packs kept; its next planned level is
 *    previewed and confirmed there; a duplicate follows the same plan; a reload keeps it; one Undo
 *    removes the import, Redo brings it back.
 *  - An F-011 `/2` copy still imports (no plan; its origin says `/2`); its next export is `/3`.
 *  - Refused before anything is written (the database byte-identical): `/1`, `/4`, `/3` without
 *    `progression`, `/2` with it, an unsupported or tampered plan, a wrong prefix or level, a plan
 *    pack that isn't the character's, a full storage at the commit; and an export of a character
 *    changed outside its plan.
 * Synthetic/SRD plans only (tests/progression fixtures).
 */

import "../helpers/node-blob";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  commitLocalCopy,
  localCopyFaults,
  redoLocalCopyImport,
  undoLocalCopyImport,
} from "../../src/import/localCopy/commit";
import { exportLocalCopy } from "../../src/import/localCopy/export";
import { localCopyOf, validateLocalCopy } from "../../src/import/localCopy/format";
import { planLocalCopy } from "../../src/import/localCopy/plan";
import { canonicalJson, contentSha } from "../../src/lib/canonical";
import { setImageDecoder, setImageShrinker } from "../../src/lib/image";
import { db, packKey } from "../../src/persistence/db";
import { flushNow } from "../../src/persistence/sync";
import {
  confirmStep,
  previewAdvance,
  type StepPreview,
  startFromPlan,
} from "../../src/progression/advance";
import { useDocuments } from "../../src/store/documents";
import { usePortraits } from "../../src/store/portraits";
import { rogue } from "../fixtures/characters";
import { testContext } from "../fixtures/player-actions";
import { installTestEngine } from "../helpers/app";
import { bytesOfBlob, headerDecoder, png } from "../helpers/images";
import { FIXTURE_DIR } from "../progression/generate-fixtures";
import {
  addCharacter,
  bytesOf,
  dumpDb,
  FIX,
  Installations,
  type Loose,
  ok,
  rowsOf,
  storeTestPack,
} from "./helpers";

installTestEngine(5);
const docs = () => useDocuments.getState();
const inst = new Installations();
const read = (name: string): Loose => JSON.parse(readFileSync(join(FIXTURE_DIR, name), "utf8"));
const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
const dec = (b: Uint8Array): Loose => JSON.parse(new TextDecoder().decode(b));
beforeEach(() => {
  setImageDecoder(headerDecoder);
  setImageShrinker(null);
});
afterEach(() => {
  localCopyFaults.publish = null;
  vi.restoreAllMocks();
  setImageDecoder(null);
  setImageShrinker("browser");
});
afterAll(() => inst.close());

function must<T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> {
  if (r.ok !== true) throw new Error(JSON.stringify(r).slice(0, 1500));
  return r as Extract<T, { ok: true }>;
}

/** A character started from the pool plan at 3, played, advanced to 4 by the plan, with a portrait. */
async function plannedPlayed(name: string): Promise<string> {
  await inst.open(name);
  const { id } = must(await startFromPlan(read("pool-feat-1-6.plan.json"), 3)) as { id: string };
  for (const a of [
    { type: "damage", amount: 5 },
    { type: "add_custom_item", name: "Lucky stone", description: "grey", weight_lb: null },
  ] as Loose[])
    must(await docs().playAction(id, a));
  must(await confirmStep(must(await previewAdvance(id)) as StepPreview));
  ok(await usePortraits.getState().set(id, new Blob([png(8, 8)])));
  await flushNow();
  return id;
}
async function exported(id: string) {
  const r = ok(await exportLocalCopy(id));
  return { ...r, bytes: await bytesOf(r.blob) };
}
async function importBytes(bytes: Uint8Array) {
  const v = await validateLocalCopy(bytes);
  if (!v.ok) return v;
  const plan = await planLocalCopy(v.copy, v.bytes_sha256, "x.local-copy.json");
  return commitLocalCopy(plan);
}
/** Recompute the payload hash after an edit (else the copy is just `hash_mismatch`). */
async function rehashed(copy: Loose): Promise<Uint8Array> {
  copy.payload_sha256 = await contentSha(copy.payload);
  return enc(copy);
}

describe("a planned, played character: /3 → a clean profile", () => {
  it("keeps the plan, state, journal (its /3 entry), portrait and packs; next works there; duplicate, reload, Undo", async () => {
    const src = await plannedPlayed("T07-src");
    const source = docs().characters[src] as Loose;
    expect(source.progression.applied_level).toBe(4);
    const sourceRows = await rowsOf(src);
    expect(sourceRows.some((e) => e.schema === "kenli.history/3" && e.kind === "level_up")).toBe(
      true,
    );
    const x = await exported(src);
    expect(x.copy.format).toBe("srd-table.local-copy/3");
    expect(canonicalJson(x.copy.payload.character.progression)).toBe(
      canonicalJson(source.progression),
    );

    await inst.open("T07-dest");
    const r = ok(await importBytes(x.bytes)) as Loose;
    const id = r.recordId as string;
    const got = docs().characters[id] as Loose;
    expect(got).toBeTruthy();
    expect(canonicalJson(got.progression)).toBe(canonicalJson(source.progression));
    expect(canonicalJson(got.build)).toBe(canonicalJson(source.build));
    expect(canonicalJson(got.state)).toBe(canonicalJson(source.state));
    expect(canonicalJson(got.content)).toBe(canonicalJson(source.content));
    expect(localCopyOf(got.origin)?.format).toBe("srd-table.local-copy/3");
    // The journal: every entry, the planned level among them (ids remapped, the record its own).
    const rows = await rowsOf(id);
    expect(rows.length).toBe(sourceRows.length);
    const up = rows.find((e) => e.kind === "level_up");
    expect(up?.schema).toBe("kenli.history/3");
    expect(up?.record_id).toBe(id);
    expect(canonicalJson(up?.level_up)).toBe(
      canonicalJson(sourceRows.find((e) => e.kind === "level_up")?.level_up),
    );
    // The portrait, byte for byte; every pack of the plan stored here.
    const blob = await (await db()).get("portraits", id);
    expect(blob && (await bytesOfBlob(blob))).toEqual(png(8, 8));
    for (const ref of got.progression.plan.plan.packs)
      expect(await (await db()).get("packs", packKey(ref))).toBeTruthy();

    // The next planned level, here: previewed and confirmed (no fetch, no replay of the past).
    const p = must(await previewAdvance(id)) as StepPreview;
    expect([p.from_level, p.to_level]).toEqual([4, 5]);
    expect(p.before.hp_current).toBe(source.state.hp.current);
    must(await confirmStep(p));
    expect((docs().characters[id] as Loose).progression.applied_level).toBe(5);

    // A duplicate follows the same plan, at its level.
    const dup = (await docs().duplicateCharacter(id)) as string;
    expect(canonicalJson((docs().characters[dup] as Loose).progression)).toBe(
      canonicalJson((docs().characters[id] as Loose).progression),
    );
    await flushNow();
    // A reload keeps both.
    await inst.reload();
    expect((docs().characters[id] as Loose).progression.applied_level).toBe(5);
    expect((docs().characters[dup] as Loose).progression.applied_level).toBe(5);
  }, 120_000);

  it("one Undo removes the imported character (plan included), Redo brings it back", async () => {
    const src = await plannedPlayed("T07-undo-src");
    const x = await exported(src);
    await inst.open("T07-undo-dest");
    const empty = await dumpDb();
    const r = ok(await importBytes(x.bytes)) as Loose;
    const id = r.recordId as string;
    expect(docs().characters[id]).toBeTruthy();
    ok(await undoLocalCopyImport());
    expect(docs().characters[id]).toBeUndefined();
    expect(await (await db()).get("characters", id)).toBeUndefined();
    void empty;
    ok(await redoLocalCopyImport());
    expect((docs().characters[id] as Loose).progression.applied_level).toBe(4);
  }, 120_000);
});

describe("F-011's /2 still imports", () => {
  it("a /2 copy: no plan, origin /2; exported again it is /3 with progression null", async () => {
    // An ordinary character's copy, as F-011 wrote it: `/2`, the same payload without the field.
    await inst.open("T07-v2-src");
    await storeTestPack();
    const ctx = await testContext(inst.fx.engine);
    const plain = await addCharacter(await rogue(inst.fx.engine, 3), ctx, inst.fx.engine);
    await flushNow();
    const three = dec((await exported(plain)).bytes);
    expect(three.payload.character.progression).toBeNull();
    delete three.payload.character.progression;
    three.format = "srd-table.local-copy/2";
    const copy2 = dec(await rehashed(three));
    await inst.open("T07-v2");
    const r = ok(await importBytes(enc(copy2))) as Loose;
    const id = r.recordId as string;
    const got = docs().characters[id] as Loose;
    expect(got.progression ?? null).toBeNull();
    expect(localCopyOf(got.origin)?.format).toBe("srd-table.local-copy/2");
    await flushNow();
    const again = await exported(id);
    expect(again.copy.format).toBe("srd-table.local-copy/3");
    expect(again.copy.payload.character.progression).toBeNull();
    // The origin keeps saying /2 (where it really came from).
    expect(localCopyOf(again.copy.payload.character.origin)?.format).toBe("srd-table.local-copy/2");
  }, 120_000);
});

describe("refused before any write (the database byte-identical)", () => {
  it("formats, an unsupported or tampered plan, a wrong prefix/level, a foreign plan pack, a full storage", async () => {
    const src = await plannedPlayed("T07-neg-src");
    const x = await exported(src);
    const base = () => dec(x.bytes);
    await inst.open("T07-neg-dest");
    const before = await dumpDb();
    const cases: [string, () => Promise<Uint8Array>, string][] = [
      [
        "/1",
        async () => readFileSync(join(FIX, "long-pinned.local-copy.fixture")),
        "format_unsupported",
      ],
      ["/4", async () => enc({ ...base(), format: "srd-table.local-copy/4" }), "format_newer"],
      [
        "/3 without progression",
        async () => {
          const c = base();
          delete c.payload.character.progression;
          return rehashed(c);
        },
        "character_invalid",
      ],
      [
        "/2 with progression",
        async () => rehashed({ ...base(), format: "srd-table.local-copy/2" }),
        "envelope_unknown_field",
      ],
      [
        "an unsupported progression schema",
        async () => {
          const c = base();
          c.payload.character.progression.schema = "srd-table.progression/2";
          return rehashed(c);
        },
        "progression_unsupported",
      ],
      [
        "a tampered plan (its hash no longer its own)",
        async () => {
          const c = base();
          c.payload.character.progression.plan.plan.title = "changed";
          return rehashed(c);
        },
        "progression_unsupported",
      ],
      [
        "a wrong prefix hash",
        async () => {
          const c = base();
          c.payload.character.progression.prefix_sha256 = "0".repeat(64);
          return rehashed(c);
        },
        "progression_prefix_mismatch",
      ],
      [
        "a wrong applied level",
        async () => {
          const c = base();
          c.payload.character.progression.applied_level = 3;
          return rehashed(c);
        },
        "progression_prefix_mismatch",
      ],
      [
        "a plan pack that isn't the character's",
        async () => {
          const c = base();
          const plan = c.payload.character.progression.plan;
          plan.plan.packs[1] = { ...plan.plan.packs[1], sha256: "f".repeat(64) };
          plan.plan_sha256 = await contentSha(plan.plan);
          return rehashed(c);
        },
        "progression_pack_missing",
      ],
    ];
    for (const [what, make, code] of cases) {
      const r = await importBytes(await make());
      expect(r.ok ? "accepted" : (r as Loose).code, what).toBe(code);
      expect(await dumpDb(), what).toBe(before);
    }
    // A full storage while the commit writes its record: the whole import is refused, nothing
    // left behind (one transaction).
    // (The packs are added first in the same transaction: they must not stay either.)
    const add = IDBObjectStore.prototype.add;
    const spy = vi.spyOn(IDBObjectStore.prototype, "add").mockImplementation(function (
      this: IDBObjectStore,
      ...args
    ) {
      if (this.name === "characters") throw new DOMException("full", "QuotaExceededError");
      return add.apply(this, args as Parameters<typeof add>);
    });
    const v = ok(await validateLocalCopy(x.bytes));
    const plan = await planLocalCopy(v.copy, v.bytes_sha256, "x.local-copy.json");
    expect(await commitLocalCopy(plan)).toMatchObject({ ok: false, code: "storage_quota" });
    spy.mockRestore();
    expect(await dumpDb()).toBe(before);
  }, 180_000);

  it("an export of a character changed outside its plan is refused (no file that can't come back)", async () => {
    const src = await plannedPlayed("T07-diverged");
    const key = Object.keys((docs().characters[src] as Loose).build.choices).find(
      (k) => k === "class:fighter#skills",
    ) as string;
    must(await docs().editBuild(src, { type: "choice", key, values: ["history", "insight"] }));
    await flushNow();
    expect(await exportLocalCopy(src)).toMatchObject({
      ok: false,
      code: "progression_prefix_mismatch",
    });
  }, 120_000);
});
