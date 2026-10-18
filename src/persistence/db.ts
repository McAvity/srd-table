/**
 * Local persistence in IndexedDB. Stored values are the engine's documents wrapped in a small
 * record (id, timestamps, revision; a name and the combat log for encounters), plus the campaign
 * settings, portraits and imported content packs. Derived data (sheets, options, evaluations) is
 * never stored.
 *
 * Version 2 (kenli F-008) adds the `packs` store: imported packs, immutable, keyed by id, version
 * and hash. The upgrade only creates it: no record is rewritten, none gets a content pin it didn't
 * have (a record without `content` plays on the campaign's packs, as before).
 */

import { type DBSchema, type IDBPDatabase, openDB } from "idb";
import type { ContentContext, PackFiles, PackRef } from "@/lib/canonical";

/** Where a record came from, when it was imported (or duplicated from an imported one). */
export type RecordOrigin =
  | {
      readonly kind: "import";
      /** The transfer's source id and revision (`null`: unknown, a file without metadata). */
      readonly id: string | null;
      readonly revision: { readonly seq: number; readonly label?: string } | null;
      /** Identity of the imported document (`null` for a file without an envelope). */
      readonly sha256: string | null;
      readonly bytes_sha256: string | null;
      readonly source: { readonly url: string } | { readonly file: string };
      readonly imported_at: number;
      /** How the play state came to be: exported, synthetic, initialized on import (build only). */
      readonly state_origin?: string;
      readonly extensions?: Readonly<Record<string, unknown>>;
    }
  | { readonly kind: "duplicate"; readonly of: string };

/** What every document record carries next to its documents (never inside them). */
export interface RecordMeta {
  /** +1 on every lasting change; the import checks it (compare-and-set). Missing: 0. */
  readonly rev?: number;
  /** +1 when an import replaces the record: an action meant for the old one is refused. */
  readonly gen?: number;
  /** The exact packs it plays with; missing: the campaign's (Settings), as before. */
  readonly content?: ContentContext;
  readonly origin?: RecordOrigin;
}

export interface StoredCharacter extends RecordMeta {
  readonly id: string;
  readonly build: unknown;
  readonly state: unknown;
  readonly created: number;
  readonly updated: number;
}

export interface StoredEncounter extends RecordMeta {
  readonly id: string;
  readonly name: string;
  readonly encounter: unknown;
  readonly log: unknown;
  readonly modes?: unknown;
  readonly created: number;
  readonly updated: number;
}

/** An imported pack: its split files, never changed once written. */
export interface StoredPack {
  readonly key: string;
  readonly ref: PackRef;
  readonly files: PackFiles;
  readonly installed_at: number;
  readonly origin:
    | {
        readonly kind: "import";
        readonly url?: string;
        readonly file?: string;
        readonly bytes_sha256: string | null;
      }
    | { readonly kind: "bundled" };
}

interface Schema extends DBSchema {
  characters: { key: string; value: StoredCharacter };
  encounters: { key: string; value: StoredEncounter };
  settings: { key: string; value: unknown };
  /** A character's portrait, uploaded by the player (the SRD has no art): app-only data. */
  portraits: { key: string; value: Blob };
  packs: { key: string; value: StoredPack };
}

export const DB_NAME = "srd-table";
export const DB_VERSION = 2;

export const packKey = (ref: PackRef) => `${ref.id}@${ref.version ?? ""}#${ref.sha256}`;

let connection: Promise<IDBPDatabase<Schema>> | null = null;
const blockedListeners = new Set<(why: "blocked" | "blocking") => void>();

/** Told when another tab holds an older version open, or wants a newer one (reload). */
export function onDbBlocked(listener: (why: "blocked" | "blocking") => void): () => void {
  blockedListeners.add(listener);
  return () => blockedListeners.delete(listener);
}

export function db(): Promise<IDBPDatabase<Schema>> {
  connection ??= openDB<Schema>(DB_NAME, DB_VERSION, {
    upgrade(database, oldVersion) {
      if (oldVersion < 1) {
        database.createObjectStore("characters", { keyPath: "id" });
        database.createObjectStore("encounters", { keyPath: "id" });
        database.createObjectStore("settings");
        database.createObjectStore("portraits");
      }
      if (oldVersion < 2) database.createObjectStore("packs", { keyPath: "key" });
    },
    blocked() {
      for (const l of blockedListeners) l("blocked");
    },
    blocking() {
      // A newer version wants the database: let it go, this tab must be reloaded.
      void connection?.then((c) => c.close());
      connection = null;
      for (const l of blockedListeners) l("blocking");
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

/** A random installation id (kenli F-008 §7.1): not game data, not a user id. */
export function newInstallationId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return `i${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}
