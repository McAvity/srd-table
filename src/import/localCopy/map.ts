/**
 * kenli F-007 T03: a validated local copy as a NEW character of this installation (contract
 * local-copy.md §6.1). Pure and structural: a new record id, new entry and operation ids (one
 * injective map for the whole copy), external references canonical (`ext:<installation>:<id>`,
 * never nested, never bound to a record or encounter here), days, seq and everything else verbatim.
 * Every lookup by an id from the file goes through a `Map` (§6.1a: `constructor` is a valid op id).
 */

import type { CharacterBuild, CharacterState } from "srd-rules-engine";
import type { CharacterRecord } from "@/store/documents";
import type { HistoryEntry, HistoryMeta } from "@/store/history";
import {
  type External,
  ext,
  LOCAL_COPY_FORMAT,
  type LocalCopy,
  type LocalCopyOrigin,
} from "./format";

export interface MappedCopy {
  readonly import_id: string;
  readonly record: CharacterRecord;
  readonly meta: HistoryMeta | null;
  readonly entries: readonly HistoryEntry[];
  readonly ids: {
    readonly record: readonly [string, string];
    readonly entries: ReadonlyMap<string, string>;
    readonly ops: ReadonlyMap<string, string>;
  };
}

export interface MapOptions {
  readonly bytesSha: string;
  readonly fileName: string;
  readonly importId: string;
  readonly newId: (prefix: string) => string;
  readonly now: number;
}

/** The file's external block in canonical form as seen from here (kept in the new record's origin). */
export function canonicalExternal(copy: LocalCopy): External {
  const inst = copy.payload.source.installation_id;
  const x = copy.payload.external;
  return {
    participants: x.participants.map((p) => ({ record_id: ext(inst, p.record_id), name: p.name })),
    encounters: x.encounters.map((e) => ({
      encounter_id: ext(inst, e.encounter_id),
      name: e.name,
    })),
    operations: x.operations.map((o) => ext(inst, o)),
  };
}

export function mapLocalCopy(copy: LocalCopy, o: MapOptions): MappedCopy {
  const p = copy.payload;
  const inst = p.source.installation_id;
  const src = p.source.record_id;
  const rid = o.newId("c");
  const ops = new Map<string, string>();
  const used = new Set<string>();
  const fresh = (prefix: string) => {
    // Random ids; a repeat within one copy would break injectivity, so draw again.
    for (;;) {
      const id = o.newId(prefix);
      if (!used.has(id)) {
        used.add(id);
        return id;
      }
    }
  };
  for (const e of p.history.entries)
    if (!ops.has(e.operation_id)) ops.set(e.operation_id, fresh("op"));
  const entryIds = new Map<string, string>();
  const inside = (v: string | null): string | null => {
    if (v === null) return null;
    const m = ops.get(v);
    if (m === undefined) throw new Error(`unmapped in-journal operation ${v}`);
    return m;
  };
  const link = (v: string | null): string | null =>
    v === null ? null : (ops.get(v) ?? ext(inst, v));
  const entries = p.history.entries.map((e): HistoryEntry => {
    const id = fresh("h");
    entryIds.set(e.id, id);
    const copyOf = structuredClone(e);
    return {
      ...copyOf,
      id,
      record_id: rid,
      operation_id: inside(e.operation_id) as string,
      group_id: inside(e.group_id) as string,
      parent_op: inside(e.parent_op),
      undone_with: inside(e.undone_with),
      effect: { ...copyOf.effect, replaces_op: inside(e.effect.replaces_op) },
      links: { follows: link(e.links.follows), continues: link(e.links.continues) },
      participants: e.participants.map((x) => ({
        record_id: x.record_id === src ? rid : ext(inst, x.record_id),
        name: x.name,
      })),
      context: {
        ...copyOf.context,
        encounter_id: e.context.encounter_id === null ? null : ext(inst, e.context.encounter_id),
      },
    };
  });
  const meta: HistoryMeta | null = p.history.meta
    ? { ...structuredClone(p.history.meta), record_id: rid, rev: 1 }
    : null;
  const localCopy: LocalCopyOrigin = {
    format: LOCAL_COPY_FORMAT,
    import_id: o.importId,
    history_rev: p.source.history_rev,
    entry_count: p.history.entry_count,
    source_origin: structuredClone(p.character.origin),
    external: canonicalExternal(copy),
  };
  const record: CharacterRecord = {
    id: rid,
    build: structuredClone(p.character.build) as unknown as CharacterBuild,
    state: structuredClone(p.character.state) as unknown as CharacterState,
    created: o.now,
    updated: o.now,
    rev: 1,
    gen: p.source.record_gen,
    content: structuredClone(p.character.context),
    origin: {
      kind: "import",
      id: `table/${inst}/${src}`,
      revision: { seq: p.source.record_rev },
      sha256: copy.payload_sha256,
      bytes_sha256: o.bytesSha,
      source: { file: o.fileName },
      imported_at: o.now,
      state_origin: "exported",
      extensions: { local_copy: localCopy },
    },
  };
  return {
    import_id: o.importId,
    record,
    meta,
    entries,
    ids: { record: [src, rid], entries: entryIds, ops },
  };
}
