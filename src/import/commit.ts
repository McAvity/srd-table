/**
 * The import commit (kenli F-008 contract §7.3): the records an import replaces or uses are locked
 * (their document queues) from the autosave flush to the publication; one IndexedDB transaction
 * checks their revisions (compare-and-set, in the database and in the store), adds the packs
 * (never overwriting one, never a second set of bytes for one pack version) and writes every
 * record; only after it's done is anything shown.
 * Any failure — quota, an abort, a record changed since the preview — writes nothing.
 *
 * kenli F-006 §7.2: a replaced character keeps its journal, days and counters. The transaction also
 * compares each replaced character's journal head (as the autosave does: `history_changed` when
 * another tab changed it) and writes one `import_boundary` entry per replaced character, under one
 * operation id that its undo step carries; no imported action is made up. New characters start
 * with an empty journal.
 */

import type { CharacterState } from "srd-rules-engine";
import { engine } from "@/engine/client";
import { type ContentContext, packRefOf } from "@/lib/canonical";
import { db, packKey, type StoredPack } from "@/persistence/db";
import { flushNow, markCommitted, savedHead, writeQueue } from "@/persistence/sync";
import {
  type CharacterRecord,
  type EncounterRecord,
  lockDocuments,
  newId,
  useDocuments,
} from "@/store/documents";
import {
  type HistoryEntry,
  type HistoryMeta,
  newMeta,
  newOperationId,
  useHistory,
} from "@/store/history";
import {
  blockers,
  type Decisions,
  defaultChoice,
  originOf,
  type Plan,
  type Problem,
  type Records,
} from "./plan";
import { ImportError, remapEncounter } from "./transfer";

export type CommitOutcome =
  | {
      readonly ok: true;
      readonly characters: readonly string[];
      readonly encounters: readonly string[];
      readonly packs: number;
    }
  | { readonly ok: false; readonly problems: readonly Problem[] };

const records = (): Records => {
  const s = useDocuments.getState();
  return { characters: s.characters, encounters: s.encounters };
};

export async function commitPlan(plan: Plan, decisions: Decisions): Promise<CommitOutcome> {
  const blocked = blockers(plan, decisions, records());
  if (blocked.length) return { ok: false, problems: blocked };
  const now = Date.now();
  const s = useDocuments.getState();

  // What to write: packs, characters (new, replaced), the encounter; what to check (CAS).
  const packs: StoredPack[] = [];
  for (const p of plan.packs) {
    const ref = await packRefOf(p.envelope.content.files as never);
    packs.push({
      key: packKey(ref),
      ref,
      files: p.envelope.content.files as never,
      installed_at: now,
      origin: {
        kind: "import",
        ...("url" in p.source ? { url: p.source.url } : { file: p.source.file }),
        bytes_sha256: p.bytes_sha256,
      },
    });
  }
  const cas = new Map<string, number>();
  const expect = (id: string) => cas.set(id, plan.revs[id] ?? -1);
  const characters: CharacterRecord[] = [];
  const map: Record<string, string> = {};
  for (const c of plan.characters) {
    const choice = decisions.characters[c.key] ?? defaultChoice(c);
    if (!choice || choice.kind === "skip") continue;
    if (choice.kind === "use") {
      expect(choice.target);
      if (c.partyKey) map[c.partyKey] = choice.target;
      continue;
    }
    if (!c.build) return fail("build_invalid", c.title);
    let state = c.state;
    let stateOrigin = c.stateOrigin;
    if (c.buildOnly) {
      // Q-03: only after the explicit choice (checked by `blockers`), only for a new character.
      state = await engine().createState(c.build, c.content ?? undefined);
      stateOrigin = "initialized-on-import";
    }
    if (!state) return fail("state_invalid", c.title);
    const content: ContentContext | undefined = c.content ?? undefined;
    if (choice.kind === "new") {
      const id = newId("c");
      characters.push({
        id,
        build: c.build,
        state: state as CharacterState,
        created: now,
        updated: now,
        rev: 1,
        gen: 0,
        ...(content ? { content } : {}),
        origin: originOf(c, stateOrigin),
      });
      if (c.partyKey) map[c.partyKey] = id;
    } else {
      const target = s.characters[choice.target];
      if (!target) return fail("target_missing", choice.target);
      expect(target.id);
      const { content: _old, ...rest } = target;
      characters.push({
        ...rest,
        build: c.build,
        state: state as CharacterState,
        updated: now,
        rev: (plan.revs[target.id] ?? 0) + 1,
        gen: (target.gen ?? 0) + 1,
        ...(content ? { content } : {}),
        origin: originOf(c, stateOrigin),
      });
      if (c.partyKey) map[c.partyKey] = target.id;
    }
  }
  const encounters: EncounterRecord[] = [];
  if (plan.encounter?.encounter) {
    const e = plan.encounter;
    if (plan.raw)
      for (const key of e.partyKeys) {
        const choice = decisions.characters[`raw-key:${key}`];
        if (choice?.kind === "use") {
          map[key] = choice.target;
          expect(choice.target);
        }
      }
    let remapped: EncounterRecord["encounter"];
    try {
      remapped = remapEncounter(e.encounter as EncounterRecord["encounter"], map);
    } catch (error) {
      return fail(error instanceof ImportError ? error.code : "party_unmapped_key", String(error));
    }
    const choice = decisions.encounter ?? { kind: "new" };
    const world = e.world ?? undefined;
    if (choice.kind === "new") {
      encounters.push({
        id: newId("e"),
        name: e.title,
        encounter: remapped,
        log: [],
        created: now,
        updated: now,
        rev: 1,
        gen: 0,
        ...(world ? { content: world } : {}),
        origin: originOf(e),
      });
    } else {
      const target = s.encounters[choice.target];
      if (!target) return fail("target_missing", choice.target);
      expect(target.id);
      const { content: _old, ...rest } = target;
      encounters.push({
        ...rest,
        name: e.title,
        encounter: remapped,
        log: [],
        updated: now,
        rev: (plan.revs[target.id] ?? 0) + 1,
        gen: (target.gen ?? 0) + 1,
        ...(world ? { content: world } : {}),
        origin: originOf(e),
      });
    }
  }

  // Replaced characters: their journal gets the import's boundary (one operation for all of them).
  const op = newOperationId();
  const replacedCharacters = characters.filter((c) => s.characters[c.id]);
  const locked = [...cas.keys()];
  const boundaries: HistoryEntry[] = [];
  const heads: HistoryMeta[] = [];
  try {
    await lockDocuments(locked, async () => {
      await flushNow();
      await writeQueue(async () => {
        const database = await db();
        const tx = database.transaction(
          ["packs", "characters", "encounters", "history", "history_meta"],
          "readwrite",
        );
        try {
          const store = useDocuments.getState();
          for (const [id, rev] of cas) {
            const kind = store.characters[id] ? "characters" : "encounters";
            const current = await tx.objectStore(kind).get(id);
            const inStore = store.characters[id] ?? store.encounters[id];
            if (!current || (current.rev ?? 0) !== rev || !inStore || (inStore.rev ?? 0) !== rev)
              throw new ImportError("target_changed", id);
          }
          // One version of a pack is one set of bytes (§9.5), checked here, in the transaction
          // that writes it: another import may have installed other bytes since the preview.
          const packStore = tx.objectStore("packs");
          for (const p of packs) {
            const prefix = `${p.ref.id}@${p.ref.version ?? ""}#`;
            const keys = await packStore.getAllKeys(IDBKeyRange.bound(prefix, `${prefix}\uffff`));
            const others = [
              ...keys,
              ...packs.map((q) => q.key).filter((k) => k.startsWith(prefix)),
            ];
            if (others.some((k) => k !== p.key))
              throw new ImportError("pack_identity_conflict", `${p.ref.id}@${p.ref.version ?? ""}`);
            if (!keys.includes(p.key)) await packStore.add(p);
          }
          for (const c of characters) await tx.objectStore("characters").put(c);
          for (const e of encounters) await tx.objectStore("encounters").put(e);
          const history = tx.objectStore("history");
          const metaStore = tx.objectStore("history_meta");
          for (const c of replacedCharacters) {
            const head = await metaStore.get(c.id);
            const mine = savedHead(c.id);
            if (mine.conflicted || (head?.rev ?? null) !== mine.rev)
              throw new ImportError("history_changed", c.id);
            const m = head ?? newMeta(c.id, now);
            const entry = boundary(c, store.characters[c.id], m, op, now);
            const next: HistoryMeta = { ...m, rev: m.rev + 1, next_seq: m.next_seq + 1 };
            await history.put(entry);
            await metaStore.put(next);
            boundaries.push(entry);
            heads.push(next);
          }
          await tx.done;
        } catch (error) {
          try {
            tx.abort();
          } catch {
            // already finished
          }
          await tx.done.catch(() => undefined);
          throw error;
        }
      });
      // Done: the packs for the worker (by hash), then the store and the autosave baseline.
      if (packs.length) await engine().registerPacks(packs.map((p) => p.files));
      useDocuments.getState().publishImport({ characters, encounters }, op);
      useHistory.getState().published(boundaries, heads);
      markCommitted({ characters, encounters, entries: boundaries, meta: heads });
    });
  } catch (error) {
    if (error instanceof ImportError) return fail(error.code, error.detail);
    const name = (error as { name?: string } | null)?.name;
    if (name === "QuotaExceededError") return fail("storage_quota", String(error));
    return fail("storage_failed", error instanceof Error ? error.message : String(error));
  }
  return {
    ok: true,
    characters: characters.map((c) => c.id),
    encounters: encounters.map((e) => e.id),
    packs: packs.length,
  };
}

/** A replaced character's boundary entry: where its imported version begins (no action invented). */
function boundary(
  c: CharacterRecord,
  before: CharacterRecord | undefined,
  m: HistoryMeta,
  op: string,
  now: number,
): HistoryEntry {
  return {
    schema: "kenli.history/1",
    id: newId("h"),
    record_id: c.id,
    seq: m.next_seq,
    gen: c.gen ?? 0,
    operation_id: op,
    group_id: op,
    parent_op: null,
    component: "",
    at: now,
    day_id: m.current_day_id,
    kind: "import_boundary",
    role: "actor",
    context: { source: "import", encounter_id: null, round: null, combat_id: null, turn_id: null },
    participants: [{ record_id: c.id, name: c.build.name ?? "" }],
    name: c.build.name ?? "",
    request: { mode: "replace" },
    result: null,
    messages: [],
    outcome: [],
    costs: [],
    effect: { mode: "none", replaces_op: null, state_delta: [] },
    commit: true,
    status: "done",
    undone_with: null,
    pending_decision: false,
    links: { follows: null, continues: null },
    import: {
      mode: "replace",
      gen_before: before?.gen ?? 0,
      gen_after: c.gen ?? 0,
      origin: c.origin ?? null,
    },
  };
}

function fail(code: string, detail = ""): CommitOutcome {
  return { ok: false, problems: [{ code, detail }] };
}
