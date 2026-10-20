/**
 * Reading a character's journal (kenli F-006 contract §5.2): saved rows from IndexedDB by index,
 * this session's versions over them. Nothing here writes: the autosave and the import do
 * (`sync.ts`, `import/commit.ts`). The panel reads a page at a time; no journal is loaded whole at
 * start, and nothing is ever cut to make room.
 */

import { type HistoryEntry, sessionEntries } from "@/store/history";
import { db } from "./db";

const MAX_SEQ = Number.MAX_SAFE_INTEGER;

function merged(saved: readonly HistoryEntry[], recordId: string): HistoryEntry[] {
  const all = new Map(saved.map((e) => [e.id, e]));
  for (const e of sessionEntries(recordId)) all.set(e.id, e);
  return [...all.values()].sort((a, b) => a.seq - b.seq);
}

/** Every entry of a character, in order (for tests and small journals; the panel pages). */
export async function journal(recordId: string): Promise<HistoryEntry[]> {
  const rows = await (await db()).getAllFromIndex(
    "history",
    "by_record_seq",
    IDBKeyRange.bound([recordId, 0], [recordId, MAX_SEQ]),
  );
  return merged(rows, recordId);
}

/**
 * A page of a character's journal, newest first: `limit` entries before `beforeSeq` (default: the
 * newest), optionally of one day. A cursor over the index: O(log n + limit).
 */
export async function page(
  recordId: string,
  {
    beforeSeq = MAX_SEQ,
    dayId,
    limit = 50,
  }: { beforeSeq?: number; dayId?: string; limit?: number } = {},
): Promise<HistoryEntry[]> {
  const database = await db();
  const tx = database.transaction("history");
  const rows: HistoryEntry[] = [];
  const index = dayId ? tx.store.index("by_record_day") : tx.store.index("by_record_seq");
  const range = dayId
    ? IDBKeyRange.bound([recordId, dayId, 0], [recordId, dayId, beforeSeq], false, true)
    : IDBKeyRange.bound([recordId, 0], [recordId, beforeSeq], false, true);
  for (
    let c = await index.openCursor(range, "prev");
    c && rows.length < limit;
    c = await c.continue()
  )
    rows.push(c.value);
  await tx.done;
  const mine = sessionEntries(recordId).filter(
    (e) => e.seq < beforeSeq && (!dayId || e.day_id === dayId),
  );
  return merged([...rows, ...mine], recordId)
    .filter((e) => e.seq < beforeSeq && (!dayId || e.day_id === dayId))
    .reverse()
    .slice(0, limit);
}

/**
 * Completed, not undone Long Rests of a character (contract §6.2): in all and per day, since its
 * journal began. From the sparse rest index, so it costs about one read per rest.
 */
export async function longRests(
  recordId: string,
): Promise<{ total: number; by_day: Record<string, number> }> {
  const rows = await (await db()).getAllFromIndex(
    "history",
    "by_record_rest",
    IDBKeyRange.bound([recordId, "long", 0], [recordId, "long", MAX_SEQ]),
  );
  const by_day: Record<string, number> = {};
  let total = 0;
  for (const e of merged(rows, recordId)) {
    if (e.rest_kind !== "long" || e.status !== "done") continue;
    total += 1;
    by_day[e.day_id] = (by_day[e.day_id] ?? 0) + 1;
  }
  return { total, by_day };
}

/** How many entries a character's journal has (the delete dialog says what goes with it). */
export async function entryCount(recordId: string): Promise<number> {
  const saved = await (await db()).getAllKeysFromIndex(
    "history",
    "by_record_seq",
    IDBKeyRange.bound([recordId, 0], [recordId, MAX_SEQ]),
  );
  const ids = new Set<string>(saved as string[]);
  for (const e of sessionEntries(recordId)) ids.add(e.id);
  return ids.size;
}
