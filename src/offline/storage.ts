/**
 * kenli F-007 T04: the browser's persistent-storage protection (contract offline.md §5.4–§5.5),
 * asked for at preparation and shown on its own: `granted` lowers the chance of eviction but is no
 * backup; `denied` or `unsupported` doesn't make a prepared character any less ready.
 */

import type { db } from "@/persistence/db";

export const STORAGE_KEY = "offline.storage.v1";
export type Persisted = "granted" | "denied" | "unsupported" | "unknown";
export interface StorageState {
  readonly schema: "srd-table.storage/1";
  readonly persisted: Persisted;
  readonly asked_at: number;
}

let current: StorageState | null = null;

export const storageState = (): StorageState | null => current;

function parse(raw: unknown): StorageState | null {
  const o = raw as StorageState | null;
  return typeof o === "object" &&
    o !== null &&
    o.schema === "srd-table.storage/1" &&
    ["granted", "denied", "unsupported", "unknown"].includes(o.persisted) &&
    Number.isSafeInteger(o.asked_at)
    ? o
    : null;
}

export async function loadStorageState(
  database: Awaited<ReturnType<typeof db>>,
): Promise<StorageState | null> {
  current = parse(await database.get("settings", STORAGE_KEY));
  return current;
}

/** Ask the browser to keep this origin's storage (when it can); the answer, as it is. */
export async function askPersistence(
  storage: Pick<StorageManager, "persist" | "persisted"> | undefined = typeof navigator !==
  "undefined"
    ? navigator.storage
    : undefined,
): Promise<Persisted> {
  if (!storage || typeof storage.persist !== "function") return "unsupported";
  try {
    if (typeof storage.persisted === "function" && (await storage.persisted())) return "granted";
    return (await storage.persist()) ? "granted" : "denied";
  } catch {
    return "unknown";
  }
}

/** Remember the answer (this session, and the caller saves it under `offline.storage.v1`). */
export function setStorageState(persisted: Persisted, now = Date.now()): StorageState {
  current = { schema: "srd-table.storage/1", persisted, asked_at: now };
  return current;
}
