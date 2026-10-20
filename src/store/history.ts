/**
 * kenli F-006: each character's journal of what was played (contract `kenli.history/1`,
 * dnd5 docs/features/F-006-session-history/contracts/history.md). A journal is a record of
 * accepted operations, not event sourcing: the engine's documents stay the only game state,
 * nothing is replayed or recomputed from it, Redo never rolls again.
 *
 * An entry is captured right after its operation is accepted (in the same synchronous block as the
 * commit, never for a refusal), with the engine's result verbatim, what this operation paid, a plain
 * difference of the state and a status Undo/Redo change (the Undo stack stays in memory). A change
 * of a roll (Lucky, Heroic Inspiration, a Critical Hit) names the component of its root's result it
 * replaces; the current result of a group is the root projected with the done changes.
 *
 * In memory: every character's head (`HistoryMeta`: days, next seq, version) and this session's
 * entries. Saved rows are read from IndexedDB on demand (`persistence/history.ts`); the autosave
 * writes entries and heads with the documents (`persistence/sync.ts`).
 */

import type { Message, RollCost, RollResult } from "srd-rules-engine";
import { create } from "zustand";
import type { RecordOrigin } from "@/persistence/db";

export type OperationId = string;

export type EntryKind =
  | "test"
  | "sheet_roll"
  | "damage"
  | "death_save"
  | "late_advantage"
  | "reroll"
  | "set_critical"
  | "play"
  | "short_rest"
  | "long_rest"
  | "encounter"
  | "import_boundary";

/** Kinds whose `result` is a roll (the current result of a group is made of them). */
export const RESULT_KINDS: ReadonlySet<EntryKind> = new Set([
  "test",
  "sheet_roll",
  "damage",
  "death_save",
  "late_advantage",
  "reroll",
  "set_critical",
]);

export interface OutcomeValue {
  readonly label: string;
  readonly raw: number | null;
  readonly effective: number | null;
  readonly total: number | null;
  readonly success: boolean | null;
  readonly critical: boolean | null;
  readonly damage_total: number | null;
}

export interface StateChange {
  readonly path: string;
  readonly before: unknown;
  readonly after: unknown;
}

export interface RestDie {
  readonly die: number;
  readonly roll: RollResult;
  readonly rerolled_from: RollResult | null;
}

export interface HistoryEntry {
  readonly schema: "kenli.history/1";
  readonly id: string;
  readonly record_id: string;
  readonly seq: number;
  readonly gen: number;
  readonly operation_id: OperationId;
  readonly group_id: OperationId;
  readonly parent_op: OperationId | null;
  readonly component: string;
  readonly at: number;
  readonly day_id: string;
  readonly kind: EntryKind;
  readonly role: "actor" | "affected";
  readonly context: {
    readonly source: "sheet" | "rest_dialog" | "encounter" | "import";
    readonly encounter_id: string | null;
    readonly round: number | null;
    readonly combat_id: null;
    readonly turn_id: null;
  };
  readonly participants: readonly { readonly record_id: string; readonly name: string }[];
  readonly name: string;
  readonly request: unknown;
  readonly result: unknown;
  readonly messages: readonly Message[];
  readonly outcome: readonly OutcomeValue[];
  readonly costs: readonly RollCost[];
  readonly effect: {
    readonly mode: "none" | "apply" | "replace";
    readonly replaces_op: OperationId | null;
    readonly state_delta: readonly StateChange[];
  };
  readonly commit: boolean;
  readonly status: "done" | "undone";
  readonly undone_with: OperationId | null;
  readonly pending_decision: boolean;
  readonly links: { readonly follows: OperationId | null; readonly continues: OperationId | null };
  readonly rest_kind?: "short" | "long";
  readonly rest?: {
    readonly dice: readonly RestDie[];
    readonly override: { readonly by: "dm"; readonly note: string | null } | null;
  };
  readonly import?: {
    readonly mode: "replace";
    readonly gen_before: number;
    readonly gen_after: number;
    readonly origin: RecordOrigin | null;
  };
  readonly forced?: true;
}

export interface HistoryDay {
  readonly id: string;
  readonly n: number;
  readonly label: string | null;
  readonly started_at: number;
}

export interface HistoryMeta {
  readonly schema: "kenli.history-meta/1";
  readonly record_id: string;
  /** The journal's head: +1 on every saved change of this journal (never the document's `rev`). */
  readonly rev: number;
  readonly next_seq: number;
  readonly current_day_id: string;
  readonly days: readonly HistoryDay[];
}

/** What a capture site knows; the store adds the id, seq, day, time and status. */
export interface EntryDraft {
  readonly record_id: string;
  readonly name: string;
  readonly gen: number;
  readonly operation_id: OperationId;
  readonly group_id?: OperationId;
  readonly parent_op?: OperationId | null;
  readonly component?: string;
  readonly kind: EntryKind;
  readonly role?: "actor" | "affected";
  readonly source?: HistoryEntry["context"]["source"];
  readonly encounter_id?: string | null;
  readonly round?: number | null;
  readonly participants?: HistoryEntry["participants"];
  readonly request?: unknown;
  readonly result?: unknown;
  readonly messages?: readonly Message[];
  readonly costs?: readonly RollCost[];
  readonly effect_mode?: "apply" | "replace";
  readonly replaces_op?: OperationId | null;
  readonly delta?: readonly StateChange[];
  readonly commit: boolean;
  readonly pending_decision?: boolean;
  readonly follows?: OperationId | null;
  readonly continues?: OperationId | null;
  readonly rest_kind?: "short" | "long";
  readonly rest?: HistoryEntry["rest"];
  readonly import?: HistoryEntry["import"];
  readonly forced?: boolean;
  /** A label for outcomes that need one (free damage). */
  readonly label?: string;
}

export type SaveState =
  | { readonly status: "saved" }
  | { readonly status: "failed"; readonly reason: string }
  | { readonly status: "conflict"; readonly records: readonly string[] };

export type ConflictKind = "document" | "history";

/** Refused day or journal changes (the app's reasons, never applied). */
export type DayOutcome = { readonly ok: true } | { readonly ok: false; readonly code: DayRefusal };
export type DayRefusal = "history.dayLabelInvalid" | "history.dayUnknown";

function randomId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return `${prefix}-${Array.from(bytes, (b) => b.toString(36).padStart(2, "0"))
    .join("")
    .slice(0, 10)}`;
}
export const newOperationId = () => randomId("op");

export function newMeta(recordId: string, now = Date.now()): HistoryMeta {
  const day = randomId("d");
  return {
    schema: "kenli.history-meta/1",
    record_id: recordId,
    rev: 0,
    next_seq: 1,
    current_day_id: day,
    days: [{ id: day, n: 1, label: null, started_at: now }],
  };
}

/** A day's label: trimmed, one line, at most 40 characters; empty is none. `false`: refused. */
export function dayLabel(label: string | null | undefined): string | null | false {
  if (label == null) return null;
  const t = label.trim();
  if (/[\r\n]/.test(t) || t.length > 40) return false;
  return t === "" ? null : t;
}

// ───────────────────────────── pure parts of the contract ─────────────────────────────

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const sameJson = (a: unknown, b: unknown) =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * A plain difference of two states (contract §2.3): object leaves, arrays of `{id}` items by id,
 * other arrays whole; the document format's top-level `version` left out. Not a rule.
 */
export function stateDelta(before: unknown, after: unknown, prefix = ""): StateChange[] {
  const out: StateChange[] = [];
  const keyed = (a: unknown) =>
    Array.isArray(a) && a.length > 0 && a.every((x) => isObject(x) && "id" in x);
  if (isObject(before) || isObject(after)) {
    const b = isObject(before) ? before : {};
    const a = isObject(after) ? after : {};
    for (const k of [...new Set([...Object.keys(b), ...Object.keys(a)])].sort()) {
      if (!prefix && k === "version") continue;
      out.push(...stateDelta(b[k], a[k], prefix ? `${prefix}.${k}` : k));
    }
    return out;
  }
  if (
    (keyed(before) || keyed(after)) &&
    (Array.isArray(before) || before === undefined) &&
    (Array.isArray(after) || after === undefined)
  ) {
    const all = [...((before as unknown[]) ?? []), ...((after as unknown[]) ?? [])] as {
      id: unknown;
    }[];
    for (const id of [...new Set(all.map((x) => x.id))]) {
      const b = ((before as { id: unknown }[]) ?? []).find((x) => x.id === id);
      const a = ((after as { id: unknown }[]) ?? []).find((x) => x.id === id);
      out.push(...stateDelta(b, a, `${prefix}[id=${String(id)}]`));
    }
    return out;
  }
  if (!sameJson(before, after))
    out.push({ path: prefix, before: before ?? null, after: after ?? null });
  return out;
}

// biome-ignore lint/suspicious/noExplicitAny: engine results of several shapes, read field by field.
type Loose = any;

/** `outcome` (contract §2.2): copies of the result's fields, nothing computed. */
export function outcomeOf(
  kind: EntryKind,
  result: unknown,
  extra: { label?: string; dice?: readonly RestDie[] } = {},
): OutcomeValue[] {
  const r = result as Loose;
  const d20 = (label: string, x: Loose): OutcomeValue => ({
    label,
    raw: x.roll.natural,
    effective: x.roll.d20,
    total: x.total,
    success: x.success ?? null,
    critical: x.critical ?? x.critical_hit ?? null,
    damage_total: x.damage ? x.damage.total : null,
  });
  const damage = (label: string, x: Loose): OutcomeValue => ({
    label,
    raw: null,
    effective: null,
    total: x.total,
    success: null,
    critical: x.critical,
    damage_total: x.total,
  });
  const single = (label: string, x: Loose, raw: Loose = x): OutcomeValue => ({
    label,
    raw: raw.rolls[0] ?? null,
    effective: x.rolls[0] ?? null,
    total: x.total,
    success: null,
    critical: null,
    damage_total: null,
  });
  switch (kind) {
    case "test":
      return [d20(r.label, r)];
    case "late_advantage":
    case "reroll":
    case "set_critical":
      if (r?.roll?.d20 !== undefined) return [d20(r.label ?? r.attack, r)];
      if (r?.parts) return [damage(extra.label ?? "damage", r)];
      return r ? [single("d20", r)] : [];
    case "sheet_roll": {
      const rolls = r.rolls;
      return [
        ...rolls.attacks.map((a: Loose) => d20(a.attack, a)),
        ...(rolls.damage ? [damage(r.name, rolls.damage)] : []),
        ...(rolls.die ? [single(r.name, rolls.die)] : []),
      ];
    }
    case "damage":
      return [damage(extra.label ?? "damage", r)];
    case "death_save":
      return [single("d20", r)];
    case "short_rest":
      return (extra.dice ?? []).map((d) =>
        single(`Hit Die d${d.die}`, d.roll, d.rerolled_from ?? d.roll),
      );
    default:
      return [];
  }
}

/** The component of a sheet roll's result a change replaces (Table's `rerollTarget`/`changed`). */
export function componentOf(
  root: "test" | "sheet" | "damage" | "death_save",
  target: { readonly kind: string; readonly attack?: number },
): string {
  if (root !== "sheet") return "";
  if (target.kind === "feature_die") return "rolls.die";
  if (target.kind === "damage" && target.attack === undefined) return "rolls.damage";
  return `rolls.attacks[${target.attack ?? 0}]`;
}

/** Two components overlap when one contains the other (`""` contains everything). */
export function overlaps(a: string, b: string): boolean {
  return a === b || a === "" || b === "" || a.startsWith(`${b}.`) || b.startsWith(`${a}.`);
}

const tokens = (path: string) =>
  path.split(/\.|\[(\d+)\]/).filter((t): t is string => t !== undefined && t !== "");

export function getPath(value: unknown, path: string): unknown {
  return tokens(path).reduce<unknown>(
    (o, k) => (o == null ? undefined : (o as Record<string, unknown>)[k]),
    value,
  );
}

function setPath(value: unknown, path: string, part: unknown): unknown {
  const t = tokens(path);
  if (!t.length) return structuredClone(part);
  const out = structuredClone(value) as Record<string, unknown>;
  let o = out;
  for (const k of t.slice(0, -1)) o = o[k] as Record<string, unknown>;
  o[t[t.length - 1] as string] = structuredClone(part);
  return out;
}

/**
 * The current result of a group (contract §2.2): the root's verbatim result, each done change of
 * the group put in place of its component in `seq` order. `null` when the root was undone.
 */
export function projection(entries: readonly HistoryEntry[], group: OperationId): unknown {
  const g = entries.filter((e) => e.group_id === group).sort((a, b) => a.seq - b.seq);
  const root = g.find((e) => e.operation_id === group);
  if (root?.status !== "done") return null;
  let current = structuredClone(root.result);
  for (const e of g) {
    if (e === root || e.status !== "done" || !RESULT_KINDS.has(e.kind)) continue;
    current = setPath(current, e.component, e.result);
  }
  return current;
}

// ───────────────────────────── the store ─────────────────────────────

interface HistoryState {
  /** This session's entries (and saved ones whose status changed in it), by id. */
  entries: Readonly<Record<string, HistoryEntry>>;
  /** Every character's head, by record id (read at start, created lazily). */
  meta: Readonly<Record<string, HistoryMeta>>;
  /** Records this tab can't save any more until a reload, and why. */
  conflicts: Readonly<Record<string, ConflictKind>>;
  saveState: SaveState;

  hydrate(meta: readonly HistoryMeta[]): void;
  capture(drafts: readonly EntryDraft[]): HistoryEntry[];
  setStatus(
    op: OperationId | null | undefined,
    records: readonly string[],
    status: "done" | "undone",
  ): void;
  ensureMeta(recordId: string): HistoryMeta;
  startNextDay(recordId: string, label?: string | null): DayOutcome;
  setCurrentDay(recordId: string, dayId: string): DayOutcome;
  renameDay(recordId: string, dayId: string, label: string | null): DayOutcome;
  /** An autosave or import transaction is done: these versions are saved (heads with their new rev). */
  saved(written: {
    readonly entries: readonly HistoryEntry[];
    readonly meta: readonly { readonly read: HistoryMeta; readonly written: HistoryMeta }[];
    readonly dropped: readonly string[];
  }): void;
  /** Saved by an import's transaction: its boundary entries and heads join the store. */
  published(entries: readonly HistoryEntry[], meta: readonly HistoryMeta[]): void;
  setConflicts(conflicts: Readonly<Record<string, ConflictKind>>): void;
  setSaveState(state: SaveState): void;
}

const EMPTY = { entries: {}, meta: {}, conflicts: {} };

export const useHistory = create<HistoryState>()((set, get) => {
  function metaOf(recordId: string, now: number): HistoryMeta {
    return get().meta[recordId] ?? newMeta(recordId, now);
  }
  return {
    ...EMPTY,
    saveState: { status: "saved" },

    hydrate(meta) {
      set({
        ...EMPTY,
        meta: Object.fromEntries(meta.map((m) => [m.record_id, m])),
        saveState: { status: "saved" },
      });
    },

    capture(drafts) {
      if (!drafts.length) return [];
      const now = Date.now();
      const out: HistoryEntry[] = [];
      set((s) => {
        const meta = { ...s.meta };
        const entries = { ...s.entries };
        for (const d of drafts) {
          const m = meta[d.record_id] ?? newMeta(d.record_id, now);
          const entry: HistoryEntry = {
            schema: "kenli.history/1",
            id: randomId("h"),
            record_id: d.record_id,
            seq: m.next_seq,
            gen: d.gen,
            operation_id: d.operation_id,
            group_id: d.group_id ?? d.operation_id,
            parent_op: d.parent_op ?? null,
            component: d.component ?? "",
            at: now,
            day_id: m.current_day_id,
            kind: d.kind,
            role: d.role ?? "actor",
            context: {
              source: d.source ?? "sheet",
              encounter_id: d.encounter_id ?? null,
              round: d.round ?? null,
              combat_id: null,
              turn_id: null,
            },
            participants: d.participants ?? [{ record_id: d.record_id, name: d.name }],
            name: d.name,
            request: d.request ?? null,
            result: d.result ?? null,
            messages: d.messages ?? [],
            outcome: outcomeOf(d.kind, d.result ?? null, {
              ...(d.label !== undefined ? { label: d.label } : {}),
              ...(d.rest ? { dice: d.rest.dice } : {}),
            }),
            costs: d.costs ?? [],
            effect: {
              mode: d.effect_mode ?? (d.delta?.length ? "apply" : "none"),
              replaces_op: d.replaces_op ?? null,
              state_delta: d.delta ?? [],
            },
            commit: d.commit,
            status: "done",
            undone_with: null,
            pending_decision: d.pending_decision ?? false,
            links: { follows: d.follows ?? null, continues: d.continues ?? null },
            ...(d.rest_kind ? { rest_kind: d.rest_kind } : {}),
            ...(d.rest ? { rest: d.rest } : {}),
            ...(d.import ? { import: d.import } : {}),
            ...(d.forced ? { forced: true as const } : {}),
          };
          meta[d.record_id] = { ...m, next_seq: m.next_seq + 1 };
          entries[entry.id] = entry;
          out.push(entry);
        }
        return { meta, entries };
      });
      return out;
    },

    setStatus(op, records, status) {
      if (!op || !records.length) return;
      set((s) => {
        const entries = { ...s.entries };
        const all = Object.values(entries);
        for (const e of all) {
          if (e.operation_id !== op || !records.includes(e.record_id)) continue;
          entries[e.id] = { ...e, status };
          for (const f of all) {
            if (f.record_id !== e.record_id || f.group_id !== e.group_id || f === e) continue;
            const g = entries[f.id] as HistoryEntry;
            if (
              status === "undone" &&
              g.seq > e.seq &&
              !g.commit &&
              g.status === "done" &&
              overlaps(g.component, e.component)
            )
              entries[f.id] = { ...g, status: "undone", undone_with: op };
            if (status === "done" && g.undone_with === op)
              entries[f.id] = { ...g, status: "done", undone_with: null };
          }
        }
        return { entries };
      });
    },

    ensureMeta(recordId) {
      const existing = get().meta[recordId];
      if (existing) return existing;
      const m = newMeta(recordId);
      set((s) => (s.meta[recordId] ? s : { meta: { ...s.meta, [recordId]: m } }));
      return get().meta[recordId] as HistoryMeta;
    },

    startNextDay(recordId, label) {
      const l = dayLabel(label);
      if (l === false) return { ok: false, code: "history.dayLabelInvalid" };
      const now = Date.now();
      set((s) => {
        const m = s.meta[recordId] ?? metaOf(recordId, now);
        const day: HistoryDay = {
          id: randomId("d"),
          n: m.days.length + 1,
          label: l,
          started_at: now,
        };
        return {
          meta: { ...s.meta, [recordId]: { ...m, days: [...m.days, day], current_day_id: day.id } },
        };
      });
      return { ok: true };
    },

    setCurrentDay(recordId, dayId) {
      const m = get().meta[recordId];
      if (!m?.days.some((d) => d.id === dayId)) return { ok: false, code: "history.dayUnknown" };
      if (m.current_day_id !== dayId)
        set((s) => ({ meta: { ...s.meta, [recordId]: { ...m, current_day_id: dayId } } }));
      return { ok: true };
    },

    renameDay(recordId, dayId, label) {
      const l = dayLabel(label);
      if (l === false) return { ok: false, code: "history.dayLabelInvalid" };
      const m = get().meta[recordId];
      if (!m?.days.some((d) => d.id === dayId)) return { ok: false, code: "history.dayUnknown" };
      set((s) => ({
        meta: {
          ...s.meta,
          [recordId]: { ...m, days: m.days.map((d) => (d.id === dayId ? { ...d, label: l } : d)) },
        },
      }));
      return { ok: true };
    },

    saved({ meta: heads, dropped }) {
      if (!heads.length && !dropped.length) return;
      set((s) => {
        const meta = { ...s.meta };
        const entries = { ...s.entries };
        for (const { read, written } of heads) {
          const now = meta[written.record_id];
          // Unchanged since the save read it: the saved version. Changed meanwhile: its changes on the
          // saved head (still pending, written next time against this rev).
          meta[written.record_id] = !now || now === read ? written : { ...now, rev: written.rev };
        }
        for (const rid of dropped) {
          delete meta[rid];
          for (const [id, e] of Object.entries(entries))
            if (e.record_id === rid) delete entries[id];
        }
        return { meta, entries };
      });
    },

    published(entries, heads) {
      set((s) => {
        const meta = { ...s.meta };
        for (const head of heads) {
          const now = meta[head.record_id];
          // A day changed while the import ran stays, on the import's head (saved next time).
          const same =
            !now ||
            (now.current_day_id === head.current_day_id &&
              JSON.stringify(now.days) === JSON.stringify(head.days));
          meta[head.record_id] = same
            ? head
            : { ...now, rev: head.rev, next_seq: Math.max(now.next_seq, head.next_seq) };
        }
        return {
          entries: { ...s.entries, ...Object.fromEntries(entries.map((e) => [e.id, e])) },
          meta,
        };
      });
    },

    setConflicts(conflicts) {
      set({ conflicts });
    },
    setSaveState(saveState) {
      set({ saveState });
    },
  };
});

/** This session's entries of a record, in journal order. */
export function sessionEntries(recordId: string): HistoryEntry[] {
  return Object.values(useHistory.getState().entries)
    .filter((e) => e.record_id === recordId)
    .sort((a, b) => a.seq - b.seq);
}

/**
 * F-T01-01 (the existing Undo kept as it is): a sheet Undo restores the whole state, so it also drops
 * the effect of a later encounter operation on this character. The warning to show before it.
 */
export function overwritesEncounter(recordId: string, op: OperationId | null | undefined): boolean {
  if (!op) return false;
  const v = sessionEntries(recordId);
  const undone = v.find((e) => e.operation_id === op);
  if (!undone) return false;
  return v.some((e) => e.kind === "encounter" && e.status === "done" && e.seq > undone.seq);
}
