/**
 * kenli F-011 T04: the full copy `/2` end to end on separate installations (fake IndexedDB each) —
 * the portrait carried with its exact bytes (PNG, JPEG, WebP) or none; refusals before any write
 * (portrait MIME/bytes/base64/limits/decode, no decoder); an old stored portrait a copy can't carry
 * refused with the data kept; portrait writes as record revisions (CAS across tabs, even for a Blob
 * of the same size and type), so an import's Undo never deletes a portrait changed since; Undo/Redo
 * restoring the exact Blob and its shown URL; quota and publication faults; a mixed `/1`+`/2`
 * journal whose refused follow-ups follow local rolls; an old persisted `/1` origin flattened.
 *
 * jsdom has no image decoder: `headerDecoder` (tests/helpers/images.ts) stands in for step 8 here;
 * without it the product refuses (`portrait_decoder_unavailable`, tested below). Real decoders: e2e.
 */

import "../helpers/node-blob";
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
import { contentSha } from "../../src/lib/canonical";
import { setImageDecoder, setImageShrinker, toBase64 } from "../../src/lib/image";
import { db } from "../../src/persistence/db";
import { flushNow } from "../../src/persistence/sync";
import { useDocuments } from "../../src/store/documents";
import { type HistoryEntry, sessionEntries } from "../../src/store/history";
import { usePortraits } from "../../src/store/portraits";
import { rogue } from "../fixtures/characters";
import { humanWizard, LUCK, testContext } from "../fixtures/player-actions";
import {
  bytesOfBlob,
  gif,
  headerDecoder,
  jpeg,
  orientedDecoder,
  png,
  spyDecoder,
  webp,
  withExif,
} from "../helpers/images";
import {
  addCharacter,
  bytesOf,
  dumpDb,
  Installations,
  type Loose,
  ok,
  rowsOf,
  storeTestPack,
} from "./helpers";

const docs = () => useDocuments.getState();
const portraits = () => usePortraits.getState();
const inst = new Installations();
beforeEach(() => {
  setImageDecoder(headerDecoder);
  setImageShrinker(null);
});
afterEach(() => {
  localCopyFaults.publish = null;
  setImageDecoder(null);
  setImageShrinker("browser");
  vi.restoreAllMocks();
});
afterAll(async () => {
  await inst.close();
});

const stored = async (id: string) => {
  const blob = await (await db()).get("portraits", id);
  return blob ? { type: blob.type, bytes: await bytesOfBlob(blob) } : null;
};
const row = async (id: string) => (await db()).get("characters", id);

/** A source character (pinned to the SRD + the test pack), with a portrait set through the app. */
async function source(name: string, image?: Uint8Array<ArrayBuffer>) {
  await inst.open(name);
  await storeTestPack();
  const ctx = await testContext(inst.fx.engine);
  const id = await addCharacter(await rogue(inst.fx.engine, 3), ctx, inst.fx.engine);
  if (image) ok(await portraits().set(id, new Blob([image])));
  await flushNow();
  return id;
}
async function exported(id: string) {
  const r = ok(await exportLocalCopy(id));
  return { ...r, bytes: await bytesOf(r.blob) };
}
async function importInto(name: string, bytes: Uint8Array) {
  await inst.open(name);
  const v = ok(await validateLocalCopy(bytes));
  const plan = await planLocalCopy(v.copy, v.bytes_sha256, "x.local-copy.json");
  return { v, plan, r: ok(await commitLocalCopy(plan)) };
}
/** Another tab writes the record's next revision and a portrait (a fresh connection, as a tab). */
async function otherTab(id: string, image: Uint8Array<ArrayBuffer> | null) {
  const database = await db();
  const tx = database.transaction(["characters", "portraits"], "readwrite");
  const r = (await tx.objectStore("characters").get(id)) as Loose;
  await tx.objectStore("characters").put({ ...r, rev: r.rev + 1, updated: r.updated + 1 });
  if (image) await tx.objectStore("portraits").put(new Blob([image], { type: "image/png" }), id);
  else await tx.objectStore("portraits").delete(id);
  await tx.done;
}
const mutate = async (bytes: Uint8Array, f: (c: Loose) => void) => {
  const c = JSON.parse(new TextDecoder().decode(bytes));
  f(c);
  c.payload_sha256 = await contentSha(c.payload);
  return new TextEncoder().encode(JSON.stringify(c));
};

describe("the portrait in a copy: exact bytes, or none", () => {
  it.each([
    ["PNG", "image/png", png(96, 64, 3)],
    ["JPEG", "image/jpeg", jpeg(400, 300, 9)],
    ["WebP", "image/webp", webp(512, 512)],
  ] as const)(
    "%s: set as a revision, exported as base64, imported as a new character with the same bytes",
    async (_n, mime, image) => {
      const id = await source(`P-${mime}`, image);
      expect((await row(id))?.rev).toBe(2); // the portrait was the record's next revision
      expect(await stored(id)).toEqual({ type: mime, bytes: image });
      const x = await exported(id);
      expect(x.copy.payload.character.portrait).toEqual({
        mime,
        bytes: image.length,
        base64: toBase64(image),
      });
      expect(x.copy.payload.source.producer).toBeNull();
      expect(x.copy.format).toBe("srd-table.local-copy/3");
      const { plan, r } = await importInto(`Q-${mime}`, x.bytes);
      expect(plan.summary.portrait).toEqual({ mime, bytes: image.length });
      expect(r.recordId).not.toBe(id);
      expect(await stored(r.recordId)).toEqual({ type: mime, bytes: image });
      expect(portraits().urls[r.recordId]).toEqual(expect.any(String));
      expect((await row(r.recordId))?.rev).toBe(1);
      await inst.reload();
      expect(await stored(r.recordId)).toEqual({ type: mime, bytes: image });
    },
    60_000,
  );

  it("no portrait: `null` in the copy, none stored for the new character", async () => {
    const id = await source("N1");
    const x = await exported(id);
    expect(x.copy.payload.character.portrait).toBeNull();
    const { plan, r } = await importInto("N2", x.bytes);
    expect(plan.summary.portrait).toBeNull();
    expect(await stored(r.recordId)).toBeNull();
  }, 60_000);
});

describe("an EXIF-oriented JPEG portrait (review03 R03-06)", () => {
  it.each([6, 8])(
    "orientation %i: set (decoded turned), exported and imported with the same bytes",
    async (o) => {
      setImageDecoder(orientedDecoder); // as Chromium and WebKit answer: the shown (turned) size
      const image = withExif(jpeg(96, 64, o), o);
      const id = await source(`X${o}`, image);
      expect(await stored(id)).toEqual({ type: "image/jpeg", bytes: image }); // ≤ 512: kept raw
      const x = await exported(id);
      expect(x.copy.payload.character.portrait).toEqual({
        mime: "image/jpeg",
        bytes: image.length,
        base64: toBase64(image),
      });
      const { r } = await importInto(`Y${o}`, x.bytes);
      expect(await stored(r.recordId)).toEqual({ type: "image/jpeg", bytes: image });
      // A decode turned without an EXIF reason is still refused.
      setImageDecoder(spyDecoder({ width: 64, height: 96 }).decode);
      const plain = await mutate(x.bytes, (c) => {
        const j = jpeg(96, 64);
        c.payload.character.portrait = { mime: "image/jpeg", bytes: j.length, base64: toBase64(j) };
      });
      expect(await validateLocalCopy(plain)).toMatchObject({
        ok: false,
        code: "portrait_decode_failed",
      });
    },
    60_000,
  );
});

describe("state v3 with custom items, exactly", () => {
  it("custom lines (and the state's version 3) survive export, import and a reload byte for byte; journaled", async () => {
    const id = await source("V1");
    ok(
      await docs().playAction(id, {
        type: "add_custom_item",
        name: "Sealed letter",
        description: "For the abbess.",
        weight_lb: 0.5,
      }),
    );
    await flushNow();
    const state = docs().characters[id]?.state as Loose;
    expect(state.version).toBe(3);
    expect(JSON.stringify(state)).toMatch(/Sealed letter/);
    const x = await exported(id);
    expect(x.copy.payload.character.state).toEqual(state);
    const { r } = await importInto("V2", x.bytes);
    expect(docs().characters[r.recordId]?.state).toEqual(state);
    expect(
      (await rowsOf(r.recordId)).some((e) => JSON.stringify(e.request).includes("add_custom_item")),
    ).toBe(true);
    await inst.reload();
    expect(JSON.stringify((await row(r.recordId))?.state)).toBe(JSON.stringify(state));
  }, 60_000);
});

describe("portrait refusals before any write", () => {
  it("MIME, SVG, bytes, base64, extra fields, limits and a decode that disagrees: refused with their code; nothing written", async () => {
    const id = await source("R1", png(10, 10));
    const x = await exported(id);
    await inst.open("R2");
    const before = await dumpDb();
    const P = (c: Loose) => c.payload.character.portrait;
    const svgText = btoa('<svg xmlns="http://www.w3.org/2000/svg"/>');
    const cases: [string, (c: Loose) => void][] = [
      ["portrait_unsupported", (c) => (P(c).mime = "image/gif")],
      ["portrait_unsupported", (c) => (P(c).mime = "image/svg+xml")],
      ["portrait_mime_mismatch", (c) => (P(c).mime = "image/jpeg")],
      [
        "portrait_unsupported",
        (c) => {
          P(c).base64 = svgText;
          P(c).bytes = atob(svgText).length;
        },
      ],
      ["portrait_invalid", (c) => (P(c).base64 = ` ${P(c).base64}`)],
      ["portrait_invalid", (c) => (P(c).base64 = `data:image/png;base64,${P(c).base64}`)],
      ["portrait_invalid", (c) => (P(c).bytes += 1)],
      ["portrait_invalid", (c) => (P(c).bytes = 0)],
      ["portrait_invalid", (c) => (P(c).width = 10)],
      ["portrait_invalid", (c) => (c.payload.character.portrait = "AAAA")],
      ["limit_portrait_bytes", (c) => (P(c).bytes = 5 * 1024 * 1024 + 1)],
      [
        "limit_portrait_pixels",
        (c) => {
          const bomb = png(20_000, 20_000);
          P(c).base64 = toBase64(bomb);
          P(c).bytes = bomb.length;
        },
      ],
      [
        "portrait_malformed",
        (c) => {
          const bad = png(10, 10);
          bad[20] = (bad[20] as number) ^ 1;
          P(c).base64 = toBase64(bad);
        },
      ],
    ];
    for (const [code, f] of cases) {
      const v = await validateLocalCopy(await mutate(x.bytes, f));
      expect(v.ok ? "accepted" : v.code, code).toBe(code);
    }
    // The full decode disagrees with the header (a damaged image body): refused.
    setImageDecoder(spyDecoder({ width: 9, height: 10 }).decode);
    expect(await validateLocalCopy(x.bytes)).toMatchObject({
      ok: false,
      code: "portrait_decode_failed",
    });
    // No decoder at all (jsdom's browser decoder): refused, never accepted from its header.
    setImageDecoder(null);
    expect(await validateLocalCopy(x.bytes)).toMatchObject({
      ok: false,
      code: "portrait_decoder_unavailable",
    });
    expect(await dumpDb()).toBe(before);
  }, 60_000);

  it("a plan checked with a decoder, committed without one: the commit refuses whole, nothing written", async () => {
    const id = await source("D1", png(32, 32));
    const x = await exported(id);
    await inst.open("D2");
    const before = await dumpDb();
    const v = ok(await validateLocalCopy(x.bytes));
    const plan = await planLocalCopy(v.copy, v.bytes_sha256, "d.local-copy.json");
    setImageDecoder(null);
    expect(await commitLocalCopy(plan)).toMatchObject({
      ok: false,
      code: "portrait_decoder_unavailable",
    });
    expect(await dumpDb()).toBe(before);
  }, 60_000);

  it("an old stored portrait a copy can't carry (GIF): the export refused with how to fix it; the Blob kept", async () => {
    const id = await source("G1");
    const old = gif();
    await (await db()).put("portraits", new Blob([old], { type: "image/gif" }), id);
    const before = await dumpDb();
    expect(await exportLocalCopy(id)).toMatchObject({
      ok: false,
      code: "portrait_unsupported_stored",
    });
    expect(await dumpDb()).toBe(before);
    expect(await stored(id)).toEqual({ type: "image/gif", bytes: old });
    // Choosing a PNG replaces it (a revision), then the export works.
    ok(await portraits().set(id, new Blob([png(20, 20)])));
    expect(ok(await exportLocalCopy(id)).copy.payload.character.portrait?.mime).toBe("image/png");
  }, 60_000);

  it("a new upload refused (SVG, GIF, bomb, no decoder): the old portrait and the record's revision kept", async () => {
    const image = png(40, 40);
    const id = await source("U1", image);
    const rev = (await row(id))?.rev;
    const spy = spyDecoder();
    setImageDecoder(spy.decode);
    for (const [bytes, code] of [
      [new TextEncoder().encode("<svg/>"), "portrait_unsupported"],
      [gif(), "portrait_unsupported"],
      [png(20_000, 20_000), "limit_portrait_pixels"],
    ] as const)
      expect(await portraits().set(id, new Blob([bytes]))).toMatchObject({ ok: false, code });
    expect(spy.calls).toHaveLength(0); // refused before any decoder saw them
    setImageDecoder(null);
    expect(await portraits().set(id, new Blob([png(8, 8)]))).toMatchObject({
      ok: false,
      code: "portrait_decoder_unavailable",
    });
    expect(await stored(id)).toEqual({ type: "image/png", bytes: image });
    expect((await row(id))?.rev).toBe(rev);
    expect(docs().characters[id]?.rev).toBe(rev);
  }, 60_000);
});

describe("portrait writes are revisions (§3.1): CAS across tabs", () => {
  it("another tab changed the portrait (same size, same type): this tab's change and removal refused; theirs kept", async () => {
    const a = png(10, 10, 1);
    const b = png(10, 10, 2);
    expect(b.length).toBe(a.length);
    const id = await source("C1", a);
    await otherTab(id, b);
    const theirs = await row(id);
    expect(await portraits().set(id, new Blob([png(10, 10, 3)]))).toMatchObject({
      ok: false,
      code: "portrait_record_changed",
    });
    expect(await portraits().remove(id)).toMatchObject({
      ok: false,
      code: "portrait_record_changed",
    });
    expect(await stored(id)).toEqual({ type: "image/png", bytes: b });
    expect(await row(id)).toEqual(theirs);
  }, 60_000);

  it("quota while writing the portrait: nothing changed (Blob, revision, shown URL)", async () => {
    const image = png(12, 12);
    const id = await source("C2", image);
    const url = portraits().urls[id];
    const rev = (await row(id))?.rev;
    const put = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (
      this: IDBObjectStore,
      ...args
    ) {
      if (this.name === "portraits") throw new DOMException("full", "QuotaExceededError");
      return put.apply(this, args as Parameters<typeof put>);
    });
    expect(await portraits().set(id, new Blob([png(14, 14)]))).toMatchObject({
      ok: false,
      code: "storage_quota",
    });
    vi.restoreAllMocks();
    expect(await stored(id)).toEqual({ type: "image/png", bytes: image });
    expect((await row(id))?.rev).toBe(rev);
    expect(docs().characters[id]?.rev).toBe(rev);
    expect(portraits().urls[id]).toBe(url);
  }, 60_000);
});

describe("import Undo/Redo with a portrait", () => {
  it("Undo removes the copy with its portrait and URL; Redo brings back the exact Blob and shows it", async () => {
    const image = jpeg(300, 200, 4);
    const x = await exported(await source("UR1", image));
    const { r } = await importInto("UR2", x.bytes);
    ok(await undoLocalCopyImport());
    expect(await stored(r.recordId)).toBeNull();
    expect(portraits().urls[r.recordId]).toBeUndefined();
    expect(docs().characters[r.recordId]).toBeUndefined();
    ok(await redoLocalCopyImport());
    expect(await stored(r.recordId)).toEqual({ type: "image/jpeg", bytes: image });
    expect(portraits().urls[r.recordId]).toEqual(expect.any(String));
    await inst.reload();
    expect(await stored(r.recordId)).toEqual({ type: "image/jpeg", bytes: image });
  }, 60_000);

  it("a portrait changed since — in another tab (same size and type) or here — makes Undo refuse; the portrait stays", async () => {
    const x = await exported(await source("UT1", png(10, 10, 5)));
    const { r } = await importInto("UT2", x.bytes);
    const b = png(10, 10, 6);
    await otherTab(r.recordId, b);
    expect(await undoLocalCopyImport()).toMatchObject({ ok: false, code: "undo_import_changed" });
    expect(await stored(r.recordId)).toEqual({ type: "image/png", bytes: b });
    expect(await row(r.recordId)).toBeDefined();
    // Here: a portrait set on the copy is its next revision; Undo refuses too.
    const again = await importInto("UT3", x.bytes);
    ok(await portraits().set(again.r.recordId, new Blob([png(11, 11)])));
    expect(await undoLocalCopyImport()).toMatchObject({ ok: false, code: "undo_import_changed" });
    expect((await stored(again.r.recordId))?.bytes).toEqual(png(11, 11));
  }, 60_000);
});

describe("commit faults with a portrait", () => {
  it("quota on the portrait: nothing written; publication failure: saved, not shown, retried once with its URL", async () => {
    const image = webp(64, 64, "VP8L");
    const x = await exported(await source("F1", image));
    await inst.open("F2");
    const before = await dumpDb();
    const v = ok(await validateLocalCopy(x.bytes));
    const plan = await planLocalCopy(v.copy, v.bytes_sha256, "f.local-copy.json");
    const add = IDBObjectStore.prototype.add;
    vi.spyOn(IDBObjectStore.prototype, "add").mockImplementation(function (
      this: IDBObjectStore,
      ...args
    ) {
      if (this.name === "portraits") throw new DOMException("full", "QuotaExceededError");
      return add.apply(this, args as Parameters<typeof add>);
    });
    expect(await commitLocalCopy(plan)).toMatchObject({ ok: false, code: "storage_quota" });
    vi.restoreAllMocks();
    expect(await dumpDb()).toBe(before);
    localCopyFaults.publish = () => {
      throw new Error("injected publication failure");
    };
    const r = await commitLocalCopy(plan);
    expect(r).toMatchObject({ ok: "saved_unpublished" });
    const recordId = (r as { recordId: string }).recordId;
    expect(await stored(recordId)).toEqual({ type: "image/webp", bytes: image });
    expect(portraits().urls[recordId]).toBeUndefined(); // not shown
    localCopyFaults.publish = null;
    expect(ok(await commitLocalCopy(plan)).recordId).toBe(recordId);
    expect(portraits().urls[recordId]).toEqual(expect.any(String));
    const all = await (await db()).getAll("characters");
    expect(all.filter((c) => localCopyOf(c.origin)?.import_id === plan.import_id)).toHaveLength(1);
  }, 60_000);
});

describe("a mixed /1 + /2 journal: refusals that follow local rolls", () => {
  it("late Advantage and Heroic refused after a roll: exported in kenli.history/2, imported with follows remapped and present; re-exported valid", async () => {
    await inst.open("M1");
    await storeTestPack();
    const ctx = await testContext(inst.fx.engine);
    const id = await addCharacter(await humanWizard(inst.fx.engine), ctx, inst.fx.engine);
    for (let i = 0; i < 10; i++)
      if (!(await docs().playAction(id, { type: "use", key: LUCK })).ok) break;
    inst.fx.dice.push(6);
    ok(await docs().rollTest(id, { skill: "arcana" }));
    expect(
      (await docs().lateAdvantage(id, LUCK, 0, { command: "late_advantage", label: "Lucky" })).ok,
    ).toBe(false);
    expect(
      (
        await docs().heroicReroll(
          id,
          { kind: "d20", die: 0 },
          { command: "heroic_reroll", label: "Reroll d20" },
        )
      ).ok,
    ).toBe(false);
    const refusedHere = sessionEntries(id).filter((e) => e.kind === "refused");
    expect(refusedHere).toHaveLength(2);
    await flushNow();
    const x = await exported(id);
    const h = x.copy.payload.history;
    expect(h.schema).toBe("kenli.history/2");
    expect(new Set(h.entries.map((e: HistoryEntry) => e.schema))).toEqual(
      new Set(["kenli.history/1", "kenli.history/2"]),
    );
    const ops = new Set(h.entries.map((e: HistoryEntry) => e.operation_id));
    for (const e of h.entries.filter((e: HistoryEntry) => e.kind === "refused"))
      expect(ops.has(e.links.follows as string)).toBe(true);
    const { plan, r } = await importInto("M2", x.bytes);
    expect(plan.summary.entries.refused).toBe(2);
    const rows = await rowsOf(r.recordId);
    const mine = new Set(rows.map((e) => e.operation_id));
    const refused = rows.filter((e) => e.kind === "refused");
    expect(refused.map((e) => e.refusal?.command)).toEqual(["late_advantage", "heroic_reroll"]);
    for (const e of refused) {
      expect(mine.has(e.links.follows as string)).toBe(true);
      expect(e.links.follows).not.toBe(refusedHere[0]?.links.follows); // a new local id
    }
    // The copy of the copy is valid (whole-journal check: follows inside the journal).
    await inst.reload();
    ok(await validateLocalCopy((await exported(r.recordId)).bytes));
  }, 90_000);

  it("a refused follow-up pointing outside the journal is refused whole (history_link_dangling)", async () => {
    await inst.open("M3");
    await storeTestPack();
    const ctx = await testContext(inst.fx.engine);
    const id = await addCharacter(await humanWizard(inst.fx.engine), ctx, inst.fx.engine);
    for (let i = 0; i < 10; i++)
      if (!(await docs().playAction(id, { type: "use", key: LUCK })).ok) break;
    inst.fx.dice.push(6);
    ok(await docs().rollTest(id, { skill: "arcana" }));
    await docs().lateAdvantage(id, LUCK, 0, { command: "late_advantage", label: "Lucky" });
    await flushNow();
    const x = await exported(id);
    const bad = await mutate(x.bytes, (c) => {
      const e = c.payload.history.entries.find((e: HistoryEntry) => e.kind === "refused");
      e.links.follows = "op-not-in-this-journal";
    });
    expect(await validateLocalCopy(bad, { engine: false })).toMatchObject({
      ok: false,
      code: "history_link_dangling",
    });
  }, 90_000);
});

describe("an old persisted origin (F-007 `/1` import) re-exported", () => {
  it("its nested source origin is flattened to null; the copy is valid and imports again", async () => {
    const x = await exported(await source("O1"));
    const { r } = await importInto("O2", x.bytes);
    // As an F-007 build stored it: format /1, the source's own origin nested inside.
    const rec = (await row(r.recordId)) as Loose;
    rec.origin.extensions.local_copy.format = "srd-table.local-copy/1";
    rec.origin.extensions.local_copy.source_origin = {
      kind: "import",
      id: "earlier",
      nested: true,
    };
    await (await db()).put("characters", rec);
    await inst.reload();
    const again = await exported(r.recordId);
    const lc = (again.copy.payload.character.origin as Loose).extensions.local_copy;
    expect(lc.format).toBe("srd-table.local-copy/1");
    expect(lc.source_origin).toBeNull();
    // A copy carrying a nested origin is refused (no growing chain).
    const nested = await mutate(again.bytes, (c) => {
      c.payload.character.origin.extensions.local_copy.source_origin = { kind: "import" };
    });
    expect(await validateLocalCopy(nested, { engine: false })).toMatchObject({
      ok: false,
      code: "origin_nested",
    });
    ok((await importInto("O3", again.bytes)).r);
  }, 90_000);
});
