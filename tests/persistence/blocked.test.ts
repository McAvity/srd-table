/**
 * kenli F-011 T08 correction: another tab holding the older database keeps the upgrade waiting.
 * `dbWaitsForOtherTabs()` says so from the "blocked" event until the open succeeds (the start's
 * loading screen then keeps asking to close the other tabs instead of "an update is installing").
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
  it("waits from the block until the old tab lets go", async () => {
    const old = await holdOld();
    const told: string[] = [];
    const stop = onDbBlocked((why) => told.push(why));
    const opening = db();
    await expect.poll(dbWaitsForOtherTabs).toBe(true);
    expect(told).toEqual(["blocked"]);
    old.close();
    const opened = await opening;
    expect(opened.version).toBe(5);
    expect(dbWaitsForOtherTabs()).toBe(false);
    stop();
  });

  it("without another tab nothing is waiting", async () => {
    await db();
    expect(dbWaitsForOtherTabs()).toBe(false);
  });
});
