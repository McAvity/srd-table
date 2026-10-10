/**
 * Local persistence in IndexedDB. Stored values are the engine's documents wrapped in a small
 * record (id, timestamps; a name and the combat log for encounters), plus the campaign settings
 * and portraits. Derived data (sheets, options, evaluations) is never stored.
 */

import { type DBSchema, type IDBPDatabase, openDB } from "idb";

export interface StoredCharacter {
  readonly id: string;
  readonly build: unknown;
  readonly state: unknown;
  readonly created: number;
  readonly updated: number;
}

export interface StoredEncounter {
  readonly id: string;
  readonly name: string;
  readonly encounter: unknown;
  readonly log: unknown;
  readonly declared?: unknown;
  readonly modes?: unknown;
  readonly created: number;
  readonly updated: number;
}

interface Schema extends DBSchema {
  characters: { key: string; value: StoredCharacter };
  encounters: { key: string; value: StoredEncounter };
  settings: { key: string; value: unknown };
  /** A character's portrait, uploaded by the player (the SRD has no art): app-only data. */
  portraits: { key: string; value: Blob };
}

export const DB_NAME = "srd-table";
const DB_VERSION = 1;

let connection: Promise<IDBPDatabase<Schema>> | null = null;

export function db(): Promise<IDBPDatabase<Schema>> {
  connection ??= openDB<Schema>(DB_NAME, DB_VERSION, {
    upgrade(database) {
      database.createObjectStore("characters", { keyPath: "id" });
      database.createObjectStore("encounters", { keyPath: "id" });
      database.createObjectStore("settings");
      database.createObjectStore("portraits");
    },
  });
  return connection;
}

/** Forget the open connection (tests delete the database between runs). */
export async function closeDb(): Promise<void> {
  if (!connection) return;
  (await connection).close();
  connection = null;
}
