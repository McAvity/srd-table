/**
 * kenli F-011 T08 correction: another tab holding the older database keeps the upgrade waiting.
 * The start may open the database before its loading screen listens: a listener added while the
 * open is blocked is told at once, and `dbWaitsForOtherTabs()` says so until the open succeeds
 * (the loading screen then asks to close the other tabs instead of "an update is installing").
 */

import { afterEach, describe, expect, it } from "vitest";
import { closeDb, DB_NAME, db, dbWaitsForOtherTabs, onDbBlocked } from "../../src/persistence/db";

afterEach(async () => {
  await closeDb();
  await new Promise<void>((resolve) => {
    const del = indexedDB.deleteDatabase(DB_NAME);
    del.onsuccess = del.onerror = del.onblocked = () => resolve();
  });
});

/** An "old tab": the database at version 2, held open. */
const holdOld = () =>
  new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = () => {
      const d = req.result;
      d.createObjectStore("characters", { keyPath: "id" });
      d.createObjectStore("encounters", { keyPath: "id" });
      d.createObjectStore("settings");
      d.createObjectStore("portraits");
      d.createObjectStore("packs", { keyPath: "key" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

describe("an upgrade blocked by another tab", () => {
  it("tells a listener added after the block, and waits until the old tab lets go", async () => {
    const old = await holdOld();
    const opening = db();
    await expect.poll(dbWaitsForOtherTabs).toBe(true);
    const told: string[] = [];
    const stop = onDbBlocked((why) => told.push(why));
    expect(told).toEqual(["blocked"]);
    old.close();
    const opened = await opening;
    expect(opened.version).toBe(4);
    expect(dbWaitsForOtherTabs()).toBe(false);
    // Once open, a new listener isn't told of a block that's over.
    const later: string[] = [];
    onDbBlocked((why) => later.push(why))();
    expect(later).toEqual([]);
    stop();
  });

  it("without another tab nothing is waiting", async () => {
    await db();
    expect(dbWaitsForOtherTabs()).toBe(false);
  });
});
