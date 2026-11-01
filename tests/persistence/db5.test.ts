/**
 * kenli F-002 T07 (dnd5 contracts/progression.md §10): IndexedDB 5.
 *  - An F-011 database (version 4, its exact stores and indexes, rows without `progression`) opens
 *    at 5 with nothing created, removed or rewritten: every store, index and row identical.
 *  - A tab of the older release still open on 4 is asked to let go (`versionchange`); once 5 is
 *    there, its reopen at 4 fails (`VersionError`) and its old connection can't write: zero rows
 *    written by it.
 *  - This release as the older tab (a later 6 arrives): it lets go, says so (`blocking`, the
 *    reload request), and can't reopen or write.
 */

import { afterEach, describe, expect, it } from "vitest";
import { closeDb, DB_NAME, DB_VERSION, db, onDbBlocked } from "../../src/persistence/db";

afterEach(async () => {
  await closeDb();
  await new Promise<void>((resolve) => {
    const del = indexedDB.deleteDatabase(DB_NAME);
    del.onsuccess = del.onerror = del.onblocked = () => resolve();
  });
});

const req = <T>(r: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

/** The F-011 release's database (Table 28c4d4d src/persistence/db.ts, version 4), its upgrade. */
function openF011(onVersionChange?: (d: IDBDatabase) => void): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, 4);
    r.onupgradeneeded = (ev) => {
      const d = r.result;
      const t = r.transaction as IDBTransaction;
      if (ev.oldVersion < 1) {
        d.createObjectStore("characters", { keyPath: "id" });
        d.createObjectStore("encounters", { keyPath: "id" });
        d.createObjectStore("settings");
        d.createObjectStore("portraits");
      }
      if (ev.oldVersion < 2) d.createObjectStore("packs", { keyPath: "key" });
      if (ev.oldVersion < 3) {
        const h = d.createObjectStore("history", { keyPath: "id" });
        h.createIndex("by_record_seq", ["record_id", "seq"], { unique: true });
        h.createIndex("by_record_day", ["record_id", "day_id", "seq"]);
        h.createIndex("by_record_rest", ["record_id", "rest_kind", "seq"]);
        h.createIndex("by_operation", "operation_id");
        d.createObjectStore("history_meta", { keyPath: "record_id" });
      }
      if (ev.oldVersion < 4)
        t.objectStore("history").createIndex("by_group", ["record_id", "group_id", "seq"]);
    };
    r.onsuccess = () => {
      const d = r.result;
      d.onversionchange = () => (onVersionChange ? onVersionChange(d) : d.close());
      resolve(d);
    };
    r.onerror = (ev) => {
      ev.preventDefault(); // handled here (the caller sees the rejection)
      reject(r.error);
    };
  });
}

const ROWS = {
  characters: [
    { id: "c-a", build: { version: 4, name: "A" }, state: { version: 3 }, created: 1, updated: 2 },
    { id: "c-b", build: { version: 4 }, state: { version: 3 }, created: 3, updated: 4, rev: 7 },
  ],
  history: [
    {
      id: "h-1",
      record_id: "c-a",
      seq: 1,
      day_id: "d-1",
      operation_id: "o-1",
      group_id: "o-1",
      schema: "kenli.history/1",
    },
  ],
  history_meta: [{ record_id: "c-a", rev: 1, next_seq: 2 }],
};

/** Every store: its key path, indexes (name, key path, unique) and rows. */
async function snapshot(d: IDBDatabase) {
  const out: Record<string, unknown> = {};
  for (const name of [...d.objectStoreNames].sort()) {
    const s = d.transaction(name, "readonly").objectStore(name);
    out[name] = {
      keyPath: s.keyPath,
      indexes: [...s.indexNames].sort().map((i) => {
        const x = s.index(i);
        return [i, x.keyPath, x.unique];
      }),
      rows: await req(s.getAll()),
      keys: await req(s.getAllKeys()),
    };
  }
  return out;
}

async function seedF011(): Promise<unknown> {
  const old = await openF011();
  const t = old.transaction(["characters", "history", "history_meta", "settings"], "readwrite");
  for (const c of ROWS.characters) t.objectStore("characters").put(c);
  for (const e of ROWS.history) t.objectStore("history").put(e);
  for (const m of ROWS.history_meta) t.objectStore("history_meta").put(m);
  t.objectStore("settings").put({ packs: [], sources: null }, "campaign");
  await new Promise((r) => {
    t.oncomplete = r;
  });
  const before = await snapshot(old);
  old.close();
  return before;
}

describe("IndexedDB 5 on an F-011 database", () => {
  it("opens at 5: no store, index or row created, removed or rewritten; records without progression", async () => {
    const before = await seedF011();
    const d = await db();
    expect(DB_VERSION).toBe(5);
    expect(d.version).toBe(5);
    const raw = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open(DB_NAME);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    expect(await snapshot(raw)).toEqual(before);
    raw.close();
    const rows = await d.getAll("characters");
    expect(rows.every((r) => !Object.hasOwn(r, "progression"))).toBe(true);
  });

  it("an older tab open on 4: asked to let go; after 5 it can't reopen at 4 nor write", async () => {
    await seedF011();
    let told = false;
    const oldTab = await openF011((d) => {
      told = true;
      d.close(); // what F-011's db.ts does on `blocking`
    });
    const d = await db();
    expect(told).toBe(true);
    expect(d.version).toBe(5);
    const reader = await new Promise<IDBDatabase>((resolve) => {
      const r = indexedDB.open(DB_NAME);
      r.onsuccess = () => resolve(r.result);
    });
    const before = await snapshot(reader);
    reader.close();
    // Its old connection is closed: no transaction can start.
    expect(() => oldTab.transaction("characters", "readwrite")).toThrow();
    // The older release started again (or reloaded) opens at 4: VersionError, no write.
    await expect(openF011()).rejects.toMatchObject({ name: "VersionError" });
    const after = await new Promise<IDBDatabase>((resolve) => {
      const r = indexedDB.open(DB_NAME);
      r.onsuccess = () => resolve(r.result);
    });
    expect(await snapshot(after)).toEqual(before);
    after.close();
  });

  it("this release as the older tab: a later version arrives — it lets go, says so, can't reopen", async () => {
    const d = await db();
    const told: string[] = [];
    const stop = onDbBlocked((why) => told.push(why));
    const newer = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open(DB_NAME, DB_VERSION + 1);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    expect(told).toEqual(["blocking"]);
    expect(() => d.transaction("characters", "readwrite")).toThrow();
    newer.close();
    // Its next open at DB_VERSION (what `db()` asks for) fails: nothing it could write with.
    // (A raw open with its error handled; idb leaves fake-indexeddb's error event unhandled.)
    await expect(
      new Promise((resolve, reject) => {
        const r = indexedDB.open(DB_NAME, DB_VERSION);
        r.onsuccess = () => resolve(r.result);
        r.onerror = (ev) => {
          ev.preventDefault();
          reject(r.error);
        };
      }),
    ).rejects.toMatchObject({ name: "VersionError" });
    stop();
    await closeDb().catch(() => undefined);
  });
});
