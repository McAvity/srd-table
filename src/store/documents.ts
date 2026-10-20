/**
 * The open documents: characters (`{ build, state }`) and encounters, exactly as the engine
 * returns them. The store has no reducers of its own: every write calls the engine through the
 * facade and commits the document it returns. A refused change leaves the document untouched and
 * returns the reasons to whoever asked.
 *
 * Each document has a revision counter (query keys use it) and an undo stack of previous
 * documents. Writes to one document are serialized, so fast clicks don't race on a stale copy.
 *
 * kenli F-008: a record also carries a lasting revision (`rev`, +1 on every change), a generation
 * (`gen`, +1 when an import replaces it) and its own content (`content`, else the campaign's).
 * Every change of a record goes through its queue, deletions, renames and undo included; an import
 * holds the queues of the records it replaces from the flush to the publication, so an action
 * made meanwhile runs after it and, aimed at the replaced version, is refused (never lost).
 * A change's set of records is taken again when its turn comes (an encounter's party may have
 * grown meanwhile), and the change waits for the ones it didn't hold yet. An undo step is the
 * whole record as it was (documents, content, origin): undoing an import restores the old
 * version, as a new revision and generation.
 *
 * kenli F-006: every accepted operation gets an id, written on its undo step (`op`), and its journal
 * entries are captured in the same synchronous block as its commit (`store/history.ts`); a refusal,
 * a stale result or a cancelled dialog records nothing. Undo/Redo change the entries' status.
 */

import type {
  AttackDice,
  CharacterBuild,
  CharacterState,
  D20TestRequest,
  D20TestResult,
  DamagePart,
  Encounter,
  EncounterAction,
  Message,
  PlayAction,
  RollCost,
  RolledDamage,
  RollWhat,
} from "srd-rules-engine";
import { create } from "zustand";
import { engine } from "@/engine/client";
import type {
  BuildChange,
  BuildEdit,
  ChangePreview,
  CharacterDocs,
  EncounterChange,
  Outcome,
  Party,
  PlayChange,
  Refusal,
  SheetRoll,
  TestOptions,
} from "@/engine/facade";
import { t } from "@/i18n";
import { canonicalJson } from "@/lib/canonical";
import { changedFields, droppedFields } from "@/lib/files";
import type { RecordMeta } from "@/persistence/db";
import { longRests } from "@/persistence/history";
import { rollDice } from "./dice";
import {
  componentOf,
  type EntryDraft,
  newOperationId,
  type OperationId,
  overwritesEncounter,
  type RestDie,
  stateDelta,
  useHistory,
} from "./history";
import { type DeclaredLucky, type LastRoll, openRoll, type RecordVersion, useRolls } from "./rolls";
import { type PlayWay, useSettings } from "./settings";
import { useUi } from "./ui";

/**
 * What a play action's journal entry needs beyond the action (kenli F-006): the Short Rest dialog's
 * dice as rolled (and rerolled), the DM's exception for a second Long Rest the same day.
 */
export interface PlayCapture {
  readonly rest_dice?: readonly RestDie[];
  readonly rest_override?: { readonly note?: string | null };
}

/** Refused because a cost of a roll by hand can't be paid (the roll can still be forced). */
export interface UnpaidRefusal extends Refusal {
  readonly unpaid: true;
}
export type RollOutcome = Outcome<EncounterChange> | UnpaidRefusal;

/** A die of the last roll for Heroic Inspiration (`rerollDie`'s target, by position in the roll). */
export type HeroicTarget =
  | { readonly kind: "d20"; readonly die: number; readonly attack?: number }
  | {
      readonly kind: "bonus_die";
      readonly group: number;
      readonly die: number;
      readonly attack?: number;
    }
  | {
      readonly kind: "damage";
      readonly part: number;
      readonly die: number;
      readonly attack?: number;
    }
  | { readonly kind: "feature_die"; readonly die: number }
  | { readonly kind: "death_save" };

export interface CharacterRecord extends RecordMeta {
  readonly id: string;
  readonly build: CharacterBuild;
  readonly state: CharacterState;
  readonly created: number;
  readonly updated: number;
}

/** One entry of an encounter's combat log: the engine's notes for one action. */
export interface LogEntry {
  readonly id: string;
  readonly at: number;
  readonly round: number;
  readonly tone: "notes" | "refusal" | "decision";
  readonly lines: readonly string[];
  /**
   * The engine's notes (or a decision's question) as codes and parameters (one per line), kept so the log can be translated
   * later (engine gap R13); `lines` is their English text.
   */
  readonly messages?: readonly Message[];
}

export interface EncounterRecord extends RecordMeta {
  readonly id: string;
  readonly name: string;
  readonly encounter: Encounter;
  readonly log: readonly LogEntry[];
  /** How each combatant plays its actions, when the GM set it (else the campaign's default). */
  readonly modes?: Readonly<Record<string, PlayWay>>;
  /**
   * kenli F-006 R03-01: while the encounter waits for a decision, the journal operation that stopped
   * it (`decide` continues it). Saved with the record, restored with its undo step, never inherited
   * by an imported generation.
   */
  readonly pending_op?: OperationId;
  readonly created: number;
  readonly updated: number;
}

/** What a record plays with and where it came from: restored with its documents. */
type Identity = Pick<RecordMeta, "content" | "origin">;
/** The operation a step undoes (kenli F-006): its journal entries change status with it. */
type Step = { readonly op?: OperationId | null };
type CharacterSnapshot = Identity &
  Step & {
    readonly kind: "character";
    readonly build: CharacterBuild;
    readonly state: CharacterState;
  };
type EncounterSnapshot = Identity &
  Step & {
    readonly kind: "encounter";
    readonly encounter: Encounter;
    /**
     * Party states as they were, restored with the encounter; each with its record's generation
     * then (a character an import replaced since keeps its own state).
     */
    readonly states: Readonly<Record<string, CharacterState>>;
    readonly gens?: Readonly<Record<string, number>>;
    /** The rest of the record, for a step an import made (its name, log and modes were replaced). */
    readonly record?: Pick<EncounterRecord, "name" | "log" | "modes">;
    /** The operation its pending decision continued then (kenli F-006 R03-01). */
    readonly pending_op?: OperationId | null;
  };
type Snapshot = CharacterSnapshot | EncounterSnapshot;

interface History {
  readonly past: readonly Snapshot[];
  readonly future: readonly Snapshot[];
}

const HISTORY_LIMIT = 50;
const LOG_LIMIT = 500;

/** What an import publishes once its transaction is done (kenli F-008 §7.3). */
export interface ImportPublication {
  readonly characters: readonly CharacterRecord[];
  readonly encounters: readonly EncounterRecord[];
}

export interface DocumentsState {
  hydrated: boolean;
  characters: Readonly<Record<string, CharacterRecord>>;
  encounters: Readonly<Record<string, EncounterRecord>>;
  /** Revision per document id, for query keys. */
  revs: Readonly<Record<string, number>>;
  history: Readonly<Record<string, History>>;

  hydrate(docs: { characters: CharacterRecord[]; encounters: EncounterRecord[] }): void;

  createCharacter(): Promise<string>;
  importCharacter(build: unknown, state?: unknown): Promise<Outcome<{ id: string }>>;
  duplicateCharacter(id: string): Promise<string | null>;
  deleteCharacter(id: string): Promise<void>;
  editBuild(id: string, edit: BuildEdit): Promise<Outcome<BuildChange>>;
  /** What an edit would remove and ask again (nothing is applied). */
  previewEdit(id: string, edit: BuildEdit): Promise<Outcome<ChangePreview>>;
  /** Gain a level: fixed Hit Points, or a Hit Die rolled by the engine. */
  levelUp(id: string, classId: string, hp: "fixed" | "roll"): Promise<Outcome<BuildChange>>;
  /** Change how a past level's Hit Points were gained. */
  setLevelHp(id: string, level: number, hp: "fixed" | "roll"): Promise<Outcome<BuildChange>>;
  /**
   * Play actions in one commit. With `at`, only on the record as it was then (its `rev` and
   * `gen`): changed since (another action, an import), refused with nothing applied.
   */
  playAction(
    id: string,
    action: PlayAction | readonly PlayAction[],
    at?: RecordVersion,
    capture?: PlayCapture,
  ): Promise<Outcome<PlayChange>>;
  /**
   * Rolled by hand on the sheet: the dice shown in the tray, the costs spent on the state. With
   * `lucky` (an attack, or a spell's attack rolls), a luck-style use spent for Advantage declared
   * before the roll: the engine rolls with it, and the use is paid with the roll's own costs in
   * one commit; refused (no use left, nothing to roll it on), nothing changes.
   */
  rollByHand(id: string, what: RollWhat, lucky?: DeclaredLucky): Promise<Outcome<SheetRoll>>;
  /**
   * An attack line's damage rolled freely (nothing spent): the character's last roll. `follows`: the
   * operation of the attack roll it follows (kept only while that roll is the open last roll).
   */
  rollDamage(
    id: string,
    parts: readonly DamagePart[],
    critical: boolean,
    label: string,
    follows?: OperationId,
  ): Promise<RolledDamage | null>;
  /**
   * A D20 Test from the sheet (`rollCheck`) with the GM's additions; with `lucky`, a luck-style
   * use spent for Advantage declared before the roll, in the same commit. The result is the
   * character's last roll (`useRolls`).
   */
  rollTest(
    id: string,
    request: D20TestRequest,
    options?: TestOptions,
    lucky?: DeclaredLucky,
  ): Promise<Outcome<{ test: D20TestResult }>>;
  /** A death saving throw: the engine's d20, applied; remembered so Heroic Inspiration can redo it. */
  deathSave(id: string): Promise<Outcome<PlayChange>>;
  /** Late Advantage on the last roll (a test, or attack `attack` of a roll by hand), spending `use`. */
  lateAdvantage(id: string, use: string, attack?: number): Promise<Outcome<PlayChange>>;
  /** Heroic Inspiration on one die of the last roll; a death save is made again from before it. */
  heroicReroll(id: string, target: HeroicTarget): Promise<Outcome<PlayChange>>;
  /** A Critical Hit the table decides for attack `attack` of the last roll by hand (nothing spent). */
  setCritical(id: string, attack: number, critical: boolean): Promise<Outcome<object>>;

  createEncounter(name: string): Promise<string>;
  importEncounter(json: unknown, name: string): Promise<Outcome<{ id: string }>>;
  renameEncounter(id: string, name: string): Promise<void>;
  deleteEncounter(id: string): Promise<void>;
  encounterAction(
    id: string,
    action: EncounterAction | readonly EncounterAction[],
  ): Promise<Outcome<EncounterChange>>;
  /**
   * An action rolled by hand: the engine's free `roll`, then a `spend` of its costs, committed as
   * one step (one undo). Refused, with nothing rolled, when a cost can't be paid (`unpaid`); with
   * `force`, rolled and paid as far as possible.
   */
  rollAndPay(
    id: string,
    roll: Extract<EncounterAction, { type: "roll" }>,
    force?: boolean,
  ): Promise<RollOutcome>;
  clearLog(id: string): Promise<void>;
  /** A combatant's way of playing its actions (`null`: the campaign's default). */
  setPlayMode(id: string, combatant: string, mode: PlayWay | null): Promise<void>;

  undo(id: string): Promise<void>;
  redo(id: string): Promise<void>;
  /**
   * kenli F-006 (F-T01-01): the warning to show before `undo(id)` when that sheet step would also
   * take back the effect of a later encounter action on this character (Undo itself unchanged).
   */
  undoWarning(id: string): string | null;

  /**
   * Publish what an import committed (records written, the transaction done): replaced records
   * get the import's version, their previous documents go on their undo stack.
   */
  publishImport(publication: ImportPublication, op?: OperationId): void;
}

export function newId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return `${prefix}-${Array.from(bytes, (b) => b.toString(36).padStart(2, "0"))
    .join("")
    .slice(0, 10)}`;
}

const docsOf = (record: CharacterRecord): CharacterDocs =>
  record.content
    ? { build: record.build, state: record.state, content: record.content }
    : { build: record.build, state: record.state };

/** The characters an encounter refers to, by key, as the engine wants them (with their content). */
export function partyOf(
  encounter: Encounter,
  characters: Readonly<Record<string, CharacterRecord>>,
): Party {
  const party: Record<string, CharacterDocs> = {};
  for (const key of characterKeysOf(encounter)) {
    const record = characters[key];
    if (record) party[key] = docsOf(record);
  }
  return party;
}

/**
 * Every character key an encounter refers to: its combatants' and a stopped `add_character`
 * (kenli F-008 §2.3: the engine replays it on `decide`).
 */
export function characterKeysOf(encounter: Encounter): string[] {
  const keys = encounter.combatants.flatMap((c) => (c.character === null ? [] : [c.character]));
  const p = encounter.pending?.action;
  if (p?.type === "add_character") keys.push(p.character);
  return [...new Set(keys)];
}

/** Characters an `add_character` action brings in: the engine needs their documents too. */
function joining(
  action: EncounterAction | readonly EncounterAction[],
  characters: Readonly<Record<string, CharacterRecord>>,
): Party {
  const party: Record<string, CharacterDocs> = {};
  for (const a of Array.isArray(action) ? action : [action]) {
    if (a.type !== "add_character") continue;
    const record = characters[a.character];
    if (record) party[a.character] = docsOf(record);
  }
  return party;
}

const tails = new Map<string, Promise<unknown>>();
const busy = new Map<string, number>();
/**
 * Run writes to these documents one after another (a document's queue). When none of them is
 * busy, `fn` starts at once (a synchronous change is applied synchronously); otherwise it waits
 * for every earlier write to them. Ids are taken in order, so two writers never wait on each other.
 */
function serialMany<T>(ids: readonly string[], fn: () => T | Promise<T>): Promise<T> {
  const keys = [...new Set(ids)].sort();
  const idle = keys.every((k) => !busy.get(k));
  for (const k of keys) busy.set(k, (busy.get(k) ?? 0) + 1);
  const done = () => {
    for (const k of keys) {
      const n = (busy.get(k) ?? 1) - 1;
      if (n > 0) busy.set(k, n);
      else busy.delete(k);
    }
  };
  let run: Promise<T>;
  if (idle) {
    let value: T | Promise<T>;
    try {
      value = fn();
    } catch (error) {
      done();
      return Promise.reject(error);
    }
    if (!(value instanceof Promise)) {
      // A synchronous change is done now: the documents are free for the next one at once.
      done();
      return Promise.resolve(value);
    }
    run = value;
  } else {
    run = Promise.all(keys.map((k) => tails.get(k) ?? Promise.resolve())).then(() => fn());
  }
  const settled = run.then(
    (v) => {
      done();
      return v;
    },
    (error: unknown) => {
      done();
      throw error;
    },
  );
  const tail = settled.catch(() => undefined);
  for (const k of keys) tails.set(k, tail);
  return settled;
}

/**
 * Hold these documents' queues while `fn` runs (an import's flush, transaction and publication):
 * changes asked for meanwhile run after it.
 */
export function lockDocuments<T>(ids: readonly string[], fn: () => Promise<T>): Promise<T> {
  return serialMany(ids, fn);
}

function bump(revs: Readonly<Record<string, number>>, ...ids: string[]): Record<string, number> {
  const next = { ...revs };
  for (const id of ids) next[id] = (next[id] ?? 0) + 1;
  return next;
}

/** A changed record: new documents, the lasting revision +1. */
function touch<R extends RecordMeta & { updated: number }>(record: R, patch: Partial<R>): R {
  return { ...record, ...patch, rev: (record.rev ?? 0) + 1, updated: Date.now() };
}

const identityOf = (record: RecordMeta): Identity => ({
  ...(record.content ? { content: record.content } : {}),
  ...(record.origin ? { origin: record.origin } : {}),
});

/**
 * A record with this identity (content, origin): a different one is a new generation, so changes
 * asked for the version it replaces are refused, as after an import.
 */
function withIdentity<R extends RecordMeta>(record: R, identity: Identity): R {
  const same =
    canonicalJson(identityOf(record) as Record<string, unknown>) ===
    canonicalJson(identityOf(identity) as Record<string, unknown>);
  const { content: _content, origin: _origin, ...rest } = record;
  return {
    ...(rest as R),
    ...identityOf(identity),
    ...(same ? {} : { gen: (record.gen ?? 0) + 1 }),
  };
}

function pushPast(history: Readonly<Record<string, History>>, id: string, snapshot: Snapshot) {
  const h = history[id] ?? { past: [], future: [] };
  return { ...history, [id]: { past: [...h.past, snapshot].slice(-HISTORY_LIMIT), future: [] } };
}

function toastNotes(notes: readonly string[]): void {
  if (notes.length) useUi.getState().toast(notes, "info");
}

/** An import refused before anything is written: the app's reason, then the engine's. */
function refused(reason: string, details: readonly { readonly message: string }[] = []): Refusal {
  return { ok: false, reasons: [reason, ...details.map((d) => d.message)] };
}

function replaced(): Refusal {
  const reason = t("errors.documentReplaced");
  useUi.getState().toast([reason], "error");
  return { ok: false, reasons: [reason] };
}

export const useDocuments = create<DocumentsState>()((set, get) => {
  /** Commit a character's new documents (from the engine), keeping the old ones for undo. */
  function commitCharacter(
    read: CharacterRecord,
    build: CharacterBuild,
    state: CharacterState,
    op: OperationId | null = null,
  ): boolean {
    const id = read.id;
    let stale = false;
    set((s) => {
      const record = s.characters[id];
      if (!record) return s;
      // The queue makes this impossible; checked anyway, so a stale result is never written.
      if ((record.rev ?? 0) !== (read.rev ?? 0) || (record.gen ?? 0) !== (read.gen ?? 0)) {
        stale = true;
        return s;
      }
      return {
        characters: { ...s.characters, [id]: touch(record, { build, state }) },
        revs: bump(s.revs, id),
        history: pushPast(s.history, id, {
          kind: "character",
          op,
          build: record.build,
          state: record.state,
          ...identityOf(record),
        }),
      };
    });
    return !stale;
  }

  /**
   * Capture one character's entry (kenli F-006): right after its accepted commit (or for a roll that
   * changed nothing), with the record as it is now.
   */
  function capture(
    id: string,
    draft: Omit<EntryDraft, "record_id" | "name" | "gen" | "delta"> & { before?: CharacterState },
  ) {
    const r = get().characters[id];
    if (!r) return;
    const { before, ...rest } = draft;
    useHistory.getState().capture([
      {
        ...rest,
        record_id: id,
        name: r.build.name ?? "",
        gen: r.gen ?? 0,
        ...(before ? { delta: stateDelta(before, r.state) } : {}),
      },
    ]);
  }

  const genOf = (id: string) => get().characters[id]?.gen ?? get().encounters[id]?.gen ?? 0;
  /**
   * A change of these records, in their queues; refused (`document_replaced`) when an import
   * replaced one of them after the change was asked for. `ids` is asked again when the change's
   * turn comes: records it didn't hold yet (a character who joined the encounter meanwhile, the
   * party of the undo step now on top) are queued for too, the held ones let go first (taken
   * again in order with the rest, so no two changes wait on each other).
   */
  function guarded<T>(
    ids: readonly string[] | (() => readonly string[]),
    fn: () => T | Promise<T>,
    onReplaced: () => T,
  ): Promise<T> {
    const idsOf = typeof ids === "function" ? ids : () => ids;
    const s = get();
    const gens = new Map<string, number>();
    for (const r of [...Object.values(s.characters), ...Object.values(s.encounters)])
      gens.set(r.id, r.gen ?? 0);
    const attempt = (held: readonly string[]): Promise<T> => {
      let wider: string[] | null = null;
      const run = serialMany(held, () => {
        const need = idsOf();
        const all = [...new Set([...held, ...need])];
        if (all.length > held.length) {
          wider = all;
          return undefined as T;
        }
        const replacedSince = need.some((id) => gens.has(id) && genOf(id) !== gens.get(id));
        return replacedSince ? onReplaced() : fn();
      });
      return run.then((value) => (wider ? attempt(wider) : value));
    };
    return attempt([...idsOf()]);
  }
  const quietly = () => {
    replaced();
  };
  /** Remember a character's last roll with its window: the record as it is now. */
  const remember = (
    id: string,
    roll: DistributiveOmit<LastRoll, "rev" | "gen" | "op" | "group">,
    op?: OperationId,
    group?: OperationId,
  ) => {
    const r = get().characters[id];
    if (r)
      useRolls.getState().remember(id, {
        ...roll,
        rev: r.rev ?? 0,
        gen: r.gen ?? 0,
        ...(op ? { op, group: group ?? op } : {}),
      } as LastRoll);
  };
  /** The record is still the version `read` (nothing committed, nothing replaced since). */
  const unchanged = (read: CharacterRecord) => {
    const now = get().characters[read.id];
    return !!now && (now.rev ?? 0) === (read.rev ?? 0) && (now.gen ?? 0) === (read.gen ?? 0);
  };
  /** The last roll if it can still be changed, else the refusal `reroll_window_closed`. */
  const windowOf = (id: string): { ok: true; roll: LastRoll } | Refusal => {
    const roll = openRoll(useRolls.getState().last[id], get().characters[id]);
    if (roll) return { ok: true, roll };
    const reason = t("errors.rerollWindowClosed");
    useUi.getState().toast([reason], "error");
    return { ok: false, reasons: [reason] };
  };
  /** A changed roll: shown again, and the last roll, in a window that starts after its cost. */
  const changed = (
    id: string,
    who: string,
    last: LastRoll,
    change: { attack?: number; damage?: boolean; die?: boolean; roll: unknown },
    spent = true,
    op?: OperationId,
  ) => {
    let next: DistributiveOmit<LastRoll, "rev" | "gen" | "op" | "group">;
    if (last.kind === "test") {
      next = { kind: "test", test: change.roll as D20TestResult };
      showTest(who, next.test);
    } else if (last.kind === "sheet") {
      const rolls = last.roll.rolls;
      const updated = change.die
        ? { ...rolls, die: change.roll as never }
        : change.damage
          ? { ...rolls, damage: change.roll as never }
          : {
              ...rolls,
              attacks: rolls.attacks.map((a, i) =>
                i === (change.attack ?? 0) ? (change.roll as AttackDice) : a,
              ),
            };
      const roll = { ...last.roll, rolls: updated };
      next = { kind: "sheet", what: last.what, roll };
      useUi.getState().showDice([
        {
          kind: "action",
          who,
          result: {
            manual: true,
            by: id,
            action: roll.action,
            name: roll.name,
            slot_level: roll.slot_level,
            rolls: roll.rolls,
            costs: roll.costs,
          },
        },
      ]);
    } else if (last.kind === "damage") {
      next = { kind: "damage", label: last.label, damage: change.roll as RolledDamage };
      useUi.getState().showDice([{ kind: "damage", who: last.label, damage: next.damage }]);
    } else return;
    const group = last.group ?? last.op;
    if (spent) remember(id, next, op, group);
    else {
      const r = useRolls.getState().last[id];
      if (r)
        useRolls.getState().remember(id, {
          ...next,
          rev: r.rev,
          gen: r.gen,
          ...(op ? { op, group: group ?? op } : {}),
        } as LastRoll);
    }
  };

  /** Undo/Redo one step, then the journal: its operation's entries on the restored records. */
  function step(id: string, direction: "back" | "forward") {
    let moved: Moved | null = null;
    set((s) => {
      const r = travel(s, id, direction);
      moved = r.moved;
      return r.patch;
    });
    const m = moved as Moved | null;
    if (m)
      useHistory.getState().setStatus(m.op, m.restored, direction === "back" ? "undone" : "done");
  }

  return {
    hydrated: false,
    characters: {},
    encounters: {},
    revs: {},
    history: {},

    hydrate({ characters, encounters }) {
      set({
        hydrated: true,
        characters: Object.fromEntries(characters.map((c) => [c.id, c])),
        encounters: Object.fromEntries(encounters.map((e) => [e.id, e])),
      });
    },

    async createCharacter() {
      const build = await engine().newBuild();
      const state = await engine().createState(build);
      const id = newId("c");
      const now = Date.now();
      set((s) => ({
        characters: {
          ...s.characters,
          [id]: { id, build, state, created: now, updated: now, rev: 1 },
        },
        revs: bump(s.revs, id),
      }));
      return id;
    },

    async importCharacter(rawBuild, rawState) {
      // Nothing is written unless the files arrive whole: no field dropped by the parse, the
      // build valid with the loaded packs (the engine's `pack_missing`, unknown ids…), the state
      // valid for it, and the state unchanged by `reconcileState` (spent HP, slots and uses, the
      // inventory are the table's: a reset isn't an import).
      const parsed = await engine().parseBuild(rawBuild);
      if (!parsed.ok) return parsed;
      const lostBuild = droppedFields(rawBuild, parsed.build);
      if (lostBuild.length)
        return refused(t("errors.importDropsFields", { fields: lostBuild.join(", ") }));
      const view = await engine().evaluate(parsed.build);
      const buildErrors = view.report.issues.filter((i) => i.severity === "error");
      if (buildErrors.length) return refused(t("errors.importInvalid"), buildErrors);
      let state: CharacterState;
      if (rawState === undefined) {
        state = await engine().createState(parsed.build);
      } else {
        const ps = await engine().parseState(rawState);
        if (!ps.ok) return ps;
        const lostState = droppedFields(rawState, ps.state);
        if (lostState.length)
          return refused(t("errors.importDropsFields", { fields: lostState.join(", ") }));
        state = ps.state;
        const stateErrors = (await engine().validateState(parsed.build, state)).filter(
          (i) => i.severity === "error",
        );
        if (stateErrors.length) return refused(t("errors.importInvalid"), stateErrors);
      }
      const fitted = await engine().reconcileState(parsed.build, state);
      const changed = changedFields(state, fitted.state);
      if (changed.length)
        return refused(
          t("errors.importWouldChange", { fields: changed.join(", ") }),
          fitted.notes.map((message) => ({ message })),
        );
      toastNotes(fitted.notes);
      const id = newId("c");
      const now = Date.now();
      set((s) => ({
        characters: {
          ...s.characters,
          [id]: {
            id,
            build: parsed.build,
            state: fitted.state,
            created: now,
            updated: now,
            rev: 1,
          },
        },
        revs: bump(s.revs, id),
      }));
      return { ok: true, id };
    },

    async duplicateCharacter(id) {
      const record = get().characters[id];
      if (!record) return null;
      const copy = newId("c");
      const now = Date.now();
      const name = record.build.name ? t("characters.copyName", { name: record.build.name }) : "";
      const renamed = name
        ? await engine().editBuild(record.build, { type: "name", name }, record.content)
        : null;
      const build = renamed?.ok ? renamed.build : record.build;
      // A copy keeps its content, not the import's identity: it says where it came from.
      const { origin: _origin, gen: _gen, ...rest } = record;
      set((s) => ({
        characters: {
          ...s.characters,
          [copy]: {
            ...rest,
            id: copy,
            build,
            created: now,
            updated: now,
            rev: 1,
            origin: { kind: "duplicate", of: id },
          },
        },
        revs: bump(s.revs, copy),
      }));
      return copy;
    },

    deleteCharacter(id) {
      return guarded(
        [id],
        () => {
          set((s) => {
            const { [id]: _gone, ...characters } = s.characters;
            const { [id]: _h, ...history } = s.history;
            return { characters, history, revs: bump(s.revs, id) };
          });
        },
        quietly,
      );
    },

    editBuild(id, edit) {
      return guarded(
        [id],
        async () => {
          const record = get().characters[id];
          if (!record) return missing();
          const result = await engine().editBuild(record.build, edit, record.content);
          if (!result.ok) return result;
          // The state follows the build: reconcile and show what it changed.
          const fitted = await engine().reconcileState(result.build, record.state, record.content);
          if (!commitCharacter(record, result.build, fitted.state)) return replaced();
          toastNotes([...result.notes, ...fitted.notes]);
          return result;
        },
        replaced,
      );
    },

    async previewEdit(id, edit) {
      const record = get().characters[id];
      if (!record) return missing();
      return engine().previewEdit(record.build, edit, record.content);
    },

    async levelUp(id, classId, hp) {
      const record = get().characters[id];
      if (!record) return missing();
      let roll: number | null = null;
      if (hp === "roll") {
        const view = await engine().evaluate(record.build, record.content);
        const option = view.level_up_options.find((o) => o.class_id === classId);
        if (!option) return { ok: false, reasons: [t("errors.notFound")] };
        if (option.unavailable)
          return { ok: false, reasons: [`${option.name}: ${option.unavailable}`] };
        const rolled = await rollDice(`1d${option.hit_die}`, record.build.name || option.name);
        if (!rolled.ok) return rolled;
        roll = rolled.roll.total;
      }
      return get().editBuild(id, { type: "level_up", class_id: classId, hp: roll });
    },

    async setLevelHp(id, level, hp) {
      const record = get().characters[id];
      if (!record) return missing();
      let roll: number | null = null;
      if (hp === "roll") {
        const view = await engine().evaluate(record.build, record.content);
        const entry = view.levels.find((l) => l.level === level);
        const option = view.level_up_options.find((o) => o.class_id === entry?.class_id);
        if (!option) return { ok: false, reasons: [t("errors.notFound")] };
        const rolled = await rollDice(`1d${option.hit_die}`, record.build.name || option.name);
        if (!rolled.ok) return rolled;
        roll = rolled.roll.total;
      }
      return get().editBuild(id, { type: "level_hp", level, hp: roll });
    },

    playAction(id, action, at, extra) {
      return guarded(
        [id],
        async () => {
          const record = get().characters[id];
          if (!record) return missing();
          if (at && ((record.rev ?? 0) !== at.rev || (record.gen ?? 0) !== at.gen))
            return changedSince();
          const actions = Array.isArray(action) ? action : [action as PlayAction];
          const rest = actions.some((a) => a.type === "long_rest")
            ? "long"
            : actions.some((a) => a.type === "short_rest")
              ? "short"
              : null;
          // kenli F-006 §6.3: a second Long Rest the same day only as the DM's explicit exception.
          if (rest === "long" && !extra?.rest_override) {
            const day = useHistory.getState().ensureMeta(id).current_day_id;
            if (((await longRests(id)).by_day[day] ?? 0) >= 1) return restOverrideRequired();
          }
          const result = await engine().applyPlayAction(
            record.build,
            record.state,
            action,
            record.content,
          );
          if (!result.ok) return result;
          const op = newOperationId();
          if (!commitCharacter(record, record.build, result.state, op)) return replaced();
          const heroic = actions.some((a) => a.type === "spend_inspiration");
          capture(id, {
            operation_id: op,
            kind: rest === "long" ? "long_rest" : rest === "short" ? "short_rest" : "play",
            source: rest ? "rest_dialog" : "sheet",
            request: actions,
            messages: [],
            costs: rest && heroic ? [{ type: "play", action: { type: "spend_inspiration" } }] : [],
            commit: true,
            before: record.state,
            ...(rest
              ? {
                  rest_kind: rest,
                  rest: {
                    dice: extra?.rest_dice ?? [],
                    override: extra?.rest_override
                      ? { by: "dm" as const, note: extra.rest_override.note?.trim() || null }
                      : null,
                  },
                }
              : {}),
          });
          if (rest) useRolls.getState().forget(id);
          toastNotes(result.notes);
          return result;
        },
        replaced,
      );
    },

    rollByHand(id, what, lucky) {
      return guarded(
        [id],
        async () => {
          const record = get().characters[id];
          if (!record) return missing();
          const f = engine();
          // Declared Advantage: one more reason for it in the GM's additions (the engine rolls).
          if (lucky && what.type !== "attack" && what.type !== "cast") return notApplicable();
          const asked: RollWhat =
            lucky && (what.type === "attack" || what.type === "cast")
              ? {
                  ...what,
                  dm: {
                    ...what.dm,
                    modes: [...(what.dm?.modes ?? []), { mode: "advantage", label: lucky.label }],
                  },
                }
              : what;
          const result = await f.rollByHand(
            record.build,
            record.state,
            asked,
            false,
            record.content,
          );
          if (!result.ok) return result;
          let state = result.state;
          if (lucky) {
            // A spell without an attack roll the engine rolls (a save, its effects by hand):
            // no d20 to give Advantage to, so the use isn't spent.
            if (result.roll.rolls.attacks.length === 0) return notApplicable();
            // The use with the roll's own costs, one commit; no use left: nothing at all.
            const paid = await f.applyPlayAction(
              record.build,
              state,
              { type: "use", key: lucky.use },
              record.content,
            );
            if (!paid.ok) return paid;
            state = paid.state;
          }
          const op = newOperationId();
          if (!commitCharacter(record, record.build, state, op)) return replaced();
          const { roll } = result;
          capture(id, {
            operation_id: op,
            kind: "sheet_roll",
            request: { what: asked, ...(lucky ? { lucky: lucky.use } : {}) },
            result: roll,
            messages: result.messages,
            costs: [...roll.costs, ...(lucky ? [costOfUse(lucky.use)] : [])],
            commit: true,
            before: record.state,
          });
          // The tray shows the dice as the encounter's by-hand card does; its notes say the same.
          useUi.getState().showDice([
            {
              kind: "action",
              who: record.build.name ?? "",
              result: {
                manual: true,
                by: id,
                action: roll.action,
                name: roll.name,
                slot_level: roll.slot_level,
                rolls: roll.rolls,
                costs: roll.costs,
              },
            },
          ]);
          remember(id, { kind: "sheet", what: asked, roll }, op);
          toastNotes(result.notes);
          return { ...result, state };
        },
        replaced,
      );
    },

    rollDamage(id, parts, critical, label, follows) {
      // In the record's queue, so it keeps its place among the character's rolls; a result for a
      // record changed meanwhile (an import replacing it) is dropped, never pinned to the new one.
      return guarded(
        [id],
        async () => {
          const record = get().characters[id];
          if (!record) return null;
          const damage = await engine().rollDamage(parts, critical);
          if (!unchanged(record)) {
            replaced();
            return null;
          }
          const who = `${record.build.name ?? ""} · ${label}`;
          // The attack roll it follows, if that is still the open last roll (its own group).
          const open = openRoll(useRolls.getState().last[id], record);
          const op = newOperationId();
          capture(id, {
            operation_id: op,
            kind: "damage",
            request: { parts, critical, label },
            result: damage,
            label,
            commit: false,
            follows: follows && open?.op === follows ? follows : null,
          });
          useUi.getState().showDice([{ kind: "damage", who, damage }]);
          // A later result of the character: the previous one can't be changed any more.
          remember(id, { kind: "damage", label: who, damage }, op);
          return damage;
        },
        () => {
          replaced();
          return null;
        },
      );
    },

    rollTest(id, request, options, lucky) {
      return guarded(
        [id],
        async () => {
          const record = get().characters[id];
          if (!record) return missing();
          const modes = lucky ? [{ mode: "advantage" as const, label: lucky.label }] : [];
          const test = await engine().rollCheck(
            record.build,
            record.state,
            request,
            record.content,
            {
              ...options,
              ...(modes.length ? { modes: [...(options?.modes ?? []), ...modes] } : {}),
            },
          );
          const op = newOperationId();
          if (lucky) {
            const paid = await engine().applyPlayAction(
              record.build,
              record.state,
              { type: "use", key: lucky.use },
              record.content,
            );
            if (!paid.ok) return paid;
            if (!commitCharacter(record, record.build, paid.state, op)) return replaced();
          } else if (!unchanged(record)) return replaced();
          // A roll that changes nothing is kept too (saved by the autosave all the same).
          capture(id, {
            operation_id: op,
            kind: "test",
            request: {
              request,
              ...(options ? { options } : {}),
              ...(lucky ? { lucky: lucky.use } : {}),
            },
            result: test,
            messages: test.reason_messages,
            costs: lucky ? [costOfUse(lucky.use)] : [],
            commit: !!lucky,
            before: record.state,
          });
          showTest(record.build.name ?? "", test);
          remember(id, { kind: "test", test }, op);
          return { ok: true as const, test };
        },
        replaced,
      );
    },

    deathSave(id) {
      return guarded(
        [id],
        async () => {
          const record = get().characters[id];
          if (!record) return missing();
          const die = await engine().roll("1d20");
          if (!die.ok) return die;
          const result = await engine().applyPlayAction(
            record.build,
            record.state,
            { type: "death_save", roll: die.roll.total },
            record.content,
          );
          if (!result.ok) return result;
          const op = newOperationId();
          if (!commitCharacter(record, record.build, result.state, op)) return replaced();
          capture(id, {
            operation_id: op,
            kind: "death_save",
            request: { type: "death_save", roll: die.roll.total },
            result: die.roll,
            commit: true,
            before: record.state,
          });
          useUi
            .getState()
            .showDice([{ kind: "roll", who: record.build.name ?? "", roll: die.roll }]);
          toastNotes(result.notes);
          remember(id, { kind: "death_save", die: die.roll, before: record.state }, op);
          return result;
        },
        replaced,
      );
    },

    lateAdvantage(id, use, attack = 0) {
      return guarded(
        [id],
        async () => {
          const record = get().characters[id];
          if (!record) return missing();
          const last = windowOf(id);
          if (!last.ok) return last;
          const roll =
            last.roll.kind === "test"
              ? last.roll.test
              : last.roll.kind === "sheet"
                ? last.roll.roll.rolls.attacks[attack]
                : undefined;
          if (!roll) return notApplicable();
          const result = await engine().lateAdvantage(
            record.build,
            record.state,
            roll,
            use,
            record.content,
          );
          if (!result.ok) return result;
          const op = newOperationId();
          if (!commitCharacter(record, record.build, result.state, op)) return replaced();
          capture(id, {
            operation_id: op,
            kind: "late_advantage",
            ...link(last.roll),
            component: componentOf(rootOf(last.roll), { kind: "d20", attack }),
            request: { use, ...(last.roll.kind === "sheet" ? { attack } : {}) },
            result: result.roll,
            costs: [costOfUse(use)],
            commit: true,
            before: record.state,
          });
          changed(id, record.build.name ?? "", last.roll, { attack, roll: result.roll }, true, op);
          return { ok: true as const, state: result.state, notes: [] };
        },
        replaced,
      );
    },

    heroicReroll(id, target) {
      return guarded(
        [id],
        async () => {
          const record = get().characters[id];
          if (!record) return missing();
          const last = windowOf(id);
          if (!last.ok) return last;
          const who = record.build.name ?? "";
          const f = engine();
          if (target.kind === "death_save") {
            if (last.roll.kind !== "death_save") return notApplicable();
            // The die again (Inspiration checked), then the same save on the state before it.
            const die = await f.heroicReroll(
              record.build,
              record.state,
              { kind: "single", roll: last.roll.die, die: 0 },
              record.content,
            );
            if (!die.ok) return die;
            const again = die.roll as typeof last.roll.die;
            const result = await f.applyPlayAction(
              record.build,
              last.roll.before,
              [{ type: "spend_inspiration" }, { type: "death_save", roll: again.total }],
              record.content,
            );
            if (!result.ok) return result;
            const op = newOperationId();
            if (!commitCharacter(record, record.build, result.state, op)) return replaced();
            // The first save's effect is replaced, not added: the delta is from before it (§3.4).
            capture(id, {
              operation_id: op,
              kind: "reroll",
              ...link(last.roll),
              request: target,
              result: again,
              costs: [INSPIRATION],
              commit: true,
              effect_mode: "replace",
              replaces_op: last.roll.op ?? null,
              before: last.roll.before,
            });
            useUi.getState().showDice([{ kind: "roll", who, roll: again }]);
            toastNotes(result.notes);
            remember(
              id,
              { kind: "death_save", die: again, before: last.roll.before },
              op,
              last.roll.group ?? last.roll.op,
            );
            return result;
          }
          const resolved = rerollTarget(last.roll, target);
          if (!resolved) return notApplicable();
          const result = await f.heroicReroll(
            record.build,
            record.state,
            resolved.target,
            record.content,
          );
          if (!result.ok) return result;
          const op = newOperationId();
          if (!commitCharacter(record, record.build, result.state, op)) return replaced();
          capture(id, {
            operation_id: op,
            kind: "reroll",
            ...link(last.roll),
            component: componentOf(rootOf(last.roll), target),
            request: target,
            result: result.roll,
            costs: [INSPIRATION],
            commit: true,
            before: record.state,
          });
          changed(id, who, last.roll, { ...resolved.at, roll: result.roll }, true, op);
          return { ok: true as const, state: result.state, notes: [] };
        },
        replaced,
      );
    },

    setCritical(id, attack, critical) {
      return guarded(
        [id],
        async () => {
          const record = get().characters[id];
          if (!record) return missing();
          const last = windowOf(id);
          if (!last.ok) return last;
          const roll =
            last.roll.kind === "sheet" ? last.roll.roll.rolls.attacks[attack] : undefined;
          if (!roll) return notApplicable();
          const result = await engine().setCritical(roll, critical);
          if (!result.ok) return result;
          // Nothing spent: the record (and so the window) doesn't change; no undo step of its own.
          const op = newOperationId();
          capture(id, {
            operation_id: op,
            kind: "set_critical",
            ...link(last.roll),
            component: componentOf("sheet", { kind: "d20", attack }),
            request: { attack, critical },
            result: result.roll,
            commit: false,
          });
          changed(id, record.build.name ?? "", last.roll, { attack, roll: result.roll }, false, op);
          return { ok: true as const };
        },
        replaced,
      );
    },

    async createEncounter(name) {
      const decisions = useSettings.getState().settings.monster_decisions;
      const encounter = await engine().newEncounter({ decisions });
      const id = newId("e");
      const now = Date.now();
      set((s) => ({
        encounters: {
          ...s.encounters,
          [id]: { id, name, encounter, log: [], created: now, updated: now, rev: 1 },
        },
        revs: bump(s.revs, id),
      }));
      return id;
    },

    async importEncounter(json, name) {
      const parsed = await engine().parseEncounter(json);
      if (!parsed.ok) return parsed;
      const id = newId("e");
      const now = Date.now();
      set((s) => ({
        encounters: {
          ...s.encounters,
          [id]: {
            id,
            name,
            encounter: parsed.encounter,
            log: [],
            created: now,
            updated: now,
            rev: 1,
          },
        },
        revs: bump(s.revs, id),
      }));
      return { ok: true, id };
    },

    renameEncounter(id, name) {
      return guarded(
        [id],
        () => {
          set((s) => {
            const record = s.encounters[id];
            if (!record) return s;
            return { encounters: { ...s.encounters, [id]: touch(record, { name }) } };
          });
        },
        quietly,
      );
    },

    deleteEncounter(id) {
      return guarded(
        [id],
        () => {
          set((s) => {
            const { [id]: _gone, ...encounters } = s.encounters;
            const { [id]: _h, ...history } = s.history;
            return { encounters, history, revs: bump(s.revs, id) };
          });
        },
        quietly,
      );
    },

    encounterAction(id, action) {
      return guarded(
        () => encounterIds(id, action),
        () =>
          applyToEncounter(id, action, (encounter, party, world) =>
            engine().applyEncounterAction(encounter, party, action, world),
          ),
        replaced,
      );
    },

    rollAndPay(id, roll, force = false) {
      let paidCosts: { costs: readonly RollCost[]; forced: boolean } | null = null;
      return guarded(
        () => encounterIds(id, roll),
        () =>
          applyToEncounter(
            id,
            roll,
            async (encounter, party, world) => {
              const rolled = await engine().applyEncounterAction(encounter, party, roll, world);
              if (!rolled.ok) return rolled;
              const costs = rolled.results.flatMap((r) => ("costs" in r ? r.costs : []));
              if (costs.length === 0) return rolled;
              const unpaid = costs.flatMap((c) => (c.payable || !c.reason ? [] : [c.reason]));
              if (unpaid.length > 0 && !force) {
                return {
                  ok: false as const,
                  reasons: unpaid.map((r) => r.text),
                  reason_messages: unpaid.map((r) => r.message),
                  unpaid: true as const,
                };
              }
              const paid = await engine().applyEncounterAction(
                rolled.encounter,
                withStates(party, rolled.states),
                { type: "spend", id: roll.id, costs, ...(force ? { force } : {}) },
                world,
              );
              if (!paid.ok) return paid;
              paidCosts = { costs, forced: force && unpaid.length > 0 };
              return {
                ...paid,
                states: { ...rolled.states, ...paid.states },
                notes: [...rolled.notes, ...paid.notes],
                messages: [...rolled.messages, ...paid.messages],
                applied: 2,
                results: rolled.results,
              };
            },
            () => paidCosts,
          ),
        replaced,
      );
    },

    clearLog(id) {
      return guarded(
        [id],
        () => {
          set((s) => {
            const record = s.encounters[id];
            if (!record) return s;
            return { encounters: { ...s.encounters, [id]: touch(record, { log: [] }) } };
          });
        },
        quietly,
      );
    },

    setPlayMode(id, combatant, mode) {
      return guarded(
        [id],
        () => {
          set((s) => {
            const record = s.encounters[id];
            if (!record) return s;
            const { [combatant]: _old, ...rest } = record.modes ?? {};
            const modes = mode ? { ...rest, [combatant]: mode } : rest;
            return { encounters: { ...s.encounters, [id]: touch(record, { modes }) } };
          });
        },
        quietly,
      );
    },

    undo(id) {
      return guarded(
        () => [id, ...historyParty(get(), id, "back")],
        () => step(id, "back"),
        quietly,
      );
    },
    redo(id) {
      return guarded(
        () => [id, ...historyParty(get(), id, "forward")],
        () => step(id, "forward"),
        quietly,
      );
    },
    undoWarning(id) {
      const top = get().history[id]?.past.at(-1);
      return top?.kind === "character" && overwritesEncounter(id, top.op)
        ? t("history.undoOverwritesEncounter")
        : null;
    },

    publishImport({ characters, encounters }, op) {
      set((s) => {
        const nextCharacters = { ...s.characters };
        const nextEncounters = { ...s.encounters };
        let history = s.history;
        const ids: string[] = [];
        for (const c of characters) {
          const before = s.characters[c.id];
          if (before) {
            history = pushPast(history, c.id, {
              kind: "character",
              op: op ?? null,
              build: before.build,
              state: before.state,
              ...identityOf(before),
            });
          }
          nextCharacters[c.id] = c;
          ids.push(c.id);
        }
        for (const e of encounters) {
          const before = s.encounters[e.id];
          if (before) {
            history = pushPast(history, e.id, {
              kind: "encounter",
              op: op ?? null,
              encounter: before.encounter,
              states: {},
              ...identityOf(before),
              record: recordOf(before),
              pending_op: before.pending_op ?? null,
            });
          }
          nextEncounters[e.id] = e;
          ids.push(e.id);
        }
        return {
          characters: nextCharacters,
          encounters: nextEncounters,
          history,
          revs: bump(s.revs, ...ids),
        };
      });
    },
  };
});

/** The records an encounter action changes: the encounter and every character of its party. */
function encounterIds(id: string, action: EncounterAction | readonly EncounterAction[]): string[] {
  const s = useDocuments.getState();
  const record = s.encounters[id];
  const keys = record ? characterKeysOf(record.encounter) : [];
  for (const a of Array.isArray(action) ? action : [action]) {
    if (a.type === "add_character") keys.push(a.character);
  }
  return [id, ...keys.filter((k) => s.characters[k])];
}

/** The characters an undo/redo step of an encounter restores. */
function historyParty(s: DocumentsState, id: string, direction: "back" | "forward"): string[] {
  const h = s.history[id];
  const from = direction === "back" ? h?.past : h?.future;
  const target = from?.[from.length - 1];
  return target?.kind === "encounter"
    ? Object.keys(target.states).filter((k) => s.characters[k])
    : [];
}

/** The record with this pending link (kenli F-006 R03-01), or none (`null`, `undefined`). */
function withPending(record: EncounterRecord, op: OperationId | null | undefined): EncounterRecord {
  const { pending_op: _old, ...rest } = record;
  return op ? { ...rest, pending_op: op } : rest;
}

const recordOf = (record: EncounterRecord): Pick<EncounterRecord, "name" | "log" | "modes"> => ({
  name: record.name,
  log: record.log,
  ...(record.modes ? { modes: record.modes } : {}),
});

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

function showTest(who: string, test: D20TestResult) {
  useUi.getState().showDice([{ kind: "test", who, test }]);
}

const INSPIRATION: RollCost = { type: "play", action: { type: "spend_inspiration" } };
const costOfUse = (key: string): RollCost => ({ type: "play", action: { type: "use", key } });

/** A change of the last roll: its parent (the roll as it is now) and its group (kenli F-006). */
function link(last: LastRoll): { parent_op: OperationId | null; group_id?: OperationId } {
  const group = last.group ?? last.op;
  return { parent_op: last.op ?? null, ...(group ? { group_id: group } : {}) };
}

function rootOf(last: LastRoll): "test" | "sheet" | "damage" | "death_save" {
  return last.kind;
}

/** Refused: a second Long Rest the same day needs the DM's exception (kenli F-006 §6.3). */
function restOverrideRequired(): Refusal {
  return { ok: false, reasons: [t("history.restOverrideRequired")] };
}

function notApplicable(): Refusal {
  const reason = t("errors.rollNotApplicable");
  useUi.getState().toast([reason], "error");
  return { ok: false, reasons: [reason] };
}

/** The engine's reroll target for a die of the last roll, and where its result goes back. */
function rerollTarget(
  last: LastRoll,
  target: Exclude<HeroicTarget, { kind: "death_save" }>,
): {
  target: import("srd-rules-engine").RerollTarget;
  at: { attack?: number; damage?: boolean; die?: boolean };
} | null {
  if (last.kind === "test") {
    if (target.kind === "d20")
      return { target: { kind: "d20", roll: last.test, die: target.die }, at: {} };
    if (target.kind === "bonus_die")
      return {
        target: { kind: "bonus_die", roll: last.test, group: target.group, die: target.die },
        at: {},
      };
    return null;
  }
  if (last.kind === "damage") {
    return target.kind === "damage" && target.attack === undefined
      ? {
          target: { kind: "damage", roll: last.damage, part: target.part, die: target.die },
          at: { damage: true },
        }
      : null;
  }
  if (last.kind !== "sheet") return null;
  const rolls = last.roll.rolls;
  if (target.kind === "feature_die") {
    return rolls.die
      ? { target: { kind: "single", roll: rolls.die, die: target.die }, at: { die: true } }
      : null;
  }
  if (target.kind === "damage" && target.attack === undefined) {
    return rolls.damage
      ? {
          target: { kind: "damage", roll: rolls.damage, part: target.part, die: target.die },
          at: { damage: true },
        }
      : null;
  }
  const attack = rolls.attacks[target.attack ?? 0];
  if (!attack) return null;
  const at = { attack: target.attack ?? 0 };
  if (target.kind === "d20") return { target: { kind: "d20", roll: attack, die: target.die }, at };
  if (target.kind === "bonus_die")
    return {
      target: { kind: "bonus_die", roll: attack, group: target.group, die: target.die },
      at,
    };
  return { target: { kind: "damage", roll: attack, part: target.part, die: target.die }, at };
}

/** Refused: the record changed since what was asked was prepared on it (`playAction`'s `at`). */
function changedSince(): Refusal {
  const reason = t("errors.recordChangedSince");
  useUi.getState().toast([reason], "error");
  return { ok: false, reasons: [reason] };
}

function missing(): Refusal {
  return { ok: false, reasons: [t("errors.documentGone")] };
}

/** Step a document back or forward through its history (restoring party states with it). */
/** What a step moved: its operation and the characters whose state it restored (kenli F-006). */
interface Moved {
  readonly op: OperationId | null;
  readonly restored: readonly string[];
}

function travel(
  s: DocumentsState,
  id: string,
  direction: "back" | "forward",
): { patch: Partial<DocumentsState>; moved: Moved | null } {
  const none = { patch: {}, moved: null };
  const h = s.history[id];
  if (!h) return none;
  const from = direction === "back" ? h.past : h.future;
  const target = from[from.length - 1];
  if (!target) return none;
  const rest = from.slice(0, -1);
  const op = target.op ?? null;
  if (target.kind === "character") {
    const record = s.characters[id];
    if (!record) return none;
    const current: Snapshot = {
      kind: "character",
      op,
      build: record.build,
      state: record.state,
      ...identityOf(record),
    };
    return {
      patch: {
        characters: {
          ...s.characters,
          [id]: touch(withIdentity(record, target), { build: target.build, state: target.state }),
        },
        revs: bump(s.revs, id),
        history: { ...s.history, [id]: swap(h, direction, rest, current) },
      },
      moved: { op, restored: [id] },
    };
  }
  const record = s.encounters[id];
  if (!record) return none;
  const states: Record<string, CharacterState> = {};
  const gens: Record<string, number> = {};
  const characters = { ...s.characters };
  for (const [key, state] of Object.entries(target.states)) {
    const c = characters[key];
    // Replaced by an import since the step: the new version keeps its own state.
    if (!c || (target.gens && (c.gen ?? 0) !== target.gens[key])) continue;
    states[key] = c.state;
    gens[key] = c.gen ?? 0;
    characters[key] = touch(c, { state });
  }
  const current: Snapshot = {
    kind: "encounter",
    op,
    encounter: record.encounter,
    states,
    gens,
    ...identityOf(record),
    ...(target.record ? { record: recordOf(record) } : {}),
    pending_op: record.pending_op ?? null,
  };
  return {
    patch: {
      encounters: {
        ...s.encounters,
        [id]: touch(withPending(withIdentity(record, target), target.pending_op), {
          encounter: target.encounter,
          ...(target.record ?? {}),
        }),
      },
      characters,
      revs: bump(s.revs, id, ...Object.keys(states)),
      history: { ...s.history, [id]: swap(h, direction, rest, current) },
    },
    moved: { op, restored: Object.keys(states) },
  };
}

function swap(
  h: History,
  direction: "back" | "forward",
  rest: readonly Snapshot[],
  current: Snapshot,
): History {
  return direction === "back"
    ? { past: rest, future: [...h.future, current] }
    : { past: [...h.past, current].slice(-HISTORY_LIMIT), future: rest };
}

export function canUndo(s: DocumentsState, id: string): boolean {
  return (s.history[id]?.past.length ?? 0) > 0;
}
export function canRedo(s: DocumentsState, id: string): boolean {
  return (s.history[id]?.future.length ?? 0) > 0;
}

/**
 * Apply `run` to an encounter and commit what it returns as one step: the encounter, the party's
 * states, the log, one undo entry, the dice in the tray (named after `action`'s actor).
 */
async function applyToEncounter(
  id: string,
  action: EncounterAction | readonly EncounterAction[],
  run: (
    encounter: Encounter,
    party: Party,
    world: EncounterRecord["content"],
  ) => Promise<RollOutcome>,
  paidOf: () => { costs: readonly RollCost[]; forced: boolean } | null = () => null,
): Promise<RollOutcome> {
  const { getState: get, setState: set } = useDocuments;
  const record = get().encounters[id];
  if (!record) return missing();
  const characters = get().characters;
  const party = { ...partyOf(record.encounter, characters), ...joining(action, characters) };
  const result = await run(record.encounter, party, record.content);
  if (!result.ok) return result;
  const before: Record<string, CharacterState> = {};
  const gens: Record<string, number> = {};
  for (const [key, docs] of Object.entries(party)) {
    before[key] = docs.state;
    gens[key] = characters[key]?.gen ?? 0;
  }
  let stale = false;
  const op = newOperationId();
  set((s) => {
    const current = s.encounters[id];
    if (!current) return s;
    // The queues make this impossible; checked anyway, so a result computed on documents that
    // changed meanwhile (another version of a party member) is never written.
    const changed =
      current.rev !== record.rev ||
      current.gen !== record.gen ||
      Object.keys(party).some(
        (key) =>
          s.characters[key]?.rev !== characters[key]?.rev ||
          s.characters[key]?.gen !== characters[key]?.gen,
      );
    if (changed) {
      stale = true;
      return s;
    }
    // The question the action stopped for is logged once, as its own (decision) entry.
    const question = result.pending?.question;
    const keep = result.notes.map((line) => line !== question);
    let log = appendLog(
      current,
      {
        tone: "notes",
        lines: result.notes.filter((_, i) => keep[i]),
        messages: result.messages.filter((_, i) => keep[i]),
      },
      result.encounter.round,
    );
    if (result.pending) {
      log = appendLog(
        { ...current, log },
        {
          tone: "decision",
          lines: [result.pending.question],
          ...(result.pending.question_message
            ? { messages: [result.pending.question_message] }
            : {}),
        },
        result.encounter.round,
      );
    }
    const nextCharacters = { ...s.characters };
    for (const [key, state] of Object.entries(result.states)) {
      const c = nextCharacters[key];
      if (c) nextCharacters[key] = touch(c, { state });
    }
    return {
      encounters: {
        ...s.encounters,
        [id]: touch(withPending(current, result.pending ? op : null), {
          encounter: result.encounter,
          log,
        }),
      },
      characters: nextCharacters,
      revs: bump(s.revs, id, ...Object.keys(result.states)),
      history: pushPast(s.history, id, {
        kind: "encounter",
        op,
        encounter: record.encounter,
        states: before,
        gens,
        ...identityOf(record),
        pending_op: record.pending_op ?? null,
      }),
    };
  });
  if (stale) return replaced();
  captureEncounter(id, op, record, action, result, before, paidOf());
  const who = (aid: string | undefined) =>
    result.encounter.combatants.find((c) => c.id === aid)?.name ?? "";
  const actions = Array.isArray(action) ? action : [action];
  useUi.getState().showDice(
    result.results.map((r, i) => {
      const a = actions[Math.min(i, actions.length - 1)] as EncounterAction;
      return { kind: "action" as const, who: who("id" in a ? a.id : undefined), result: r };
    }),
  );
  return result;
}

/**
 * kenli F-006 C15/C16: one operation's entries, one per character of the party it changed, one for
 * the character who acted when the action rolled or changed a state (bookkeeping such as Initiative
 * or a move that changes no character records nothing), and, when it stopped for a decision, one for
 * the character who decides (`decide` continues that operation). Each in its own journal and day.
 */
function captureEncounter(
  id: string,
  op: OperationId,
  record: EncounterRecord,
  action: EncounterAction | readonly EncounterAction[],
  result: Extract<RollOutcome, { ok: true }>,
  before: Readonly<Record<string, CharacterState>>,
  paid: { costs: readonly RollCost[]; forced: boolean } | null,
) {
  const characters = useDocuments.getState().characters;
  const actions = Array.isArray(action) ? action : [action];
  const first = actions[0] as EncounterAction | undefined;
  const decide = actions.some((a) => a.type === "decide");
  // Who acted: the action's combatant; for `decide`, the stopped action's.
  const actorId =
    first && "id" in first && typeof first.id === "string"
      ? first.id
      : decide
        ? (record.encounter.pending?.action as { id?: string } | undefined)?.id
        : undefined;
  const actorKey = record.encounter.combatants.find((c) => c.id === actorId)?.character ?? null;
  const changed = Object.keys(result.states).filter((k) => characters[k]);
  const acted =
    actorKey && characters[actorKey] && (result.results.length > 0 || changed.length > 0);
  // Stopped for a decision: the character who decides has it in its journal too (decide continues it).
  const deciderKey = result.pending
    ? (result.encounter.combatants.find((c) => c.id === result.pending?.combatant)?.character ??
      null)
    : null;
  const decider = deciderKey && characters[deciderKey] ? [deciderKey] : [];
  const who = [...new Set([...(acted && actorKey ? [actorKey] : []), ...changed, ...decider])];
  const history = useHistory.getState();
  // The stop this answer continues: the record's own link, only while it waited for a decision.
  const continues = decide && record.encounter.pending ? (record.pending_op ?? null) : null;
  if (!who.length) return;
  const participants = who.map((k) => ({ record_id: k, name: characters[k]?.build.name ?? "" }));
  // What the actor paid: a roll by hand's paid costs, else the engine's caster actions (a cast).
  const casterCosts = result.results.flatMap((r) =>
    "caster_actions" in r && Array.isArray(r.caster_actions)
      ? (r.caster_actions as PlayAction[]).map((a) => ({ type: "play" as const, action: a }))
      : [],
  );
  history.capture(
    who.map((k) => {
      const c = characters[k] as CharacterRecord;
      const isActor = k === actorKey;
      return {
        record_id: k,
        name: c.build.name ?? "",
        gen: c.gen ?? 0,
        operation_id: op,
        kind: "encounter" as const,
        role: isActor ? ("actor" as const) : ("affected" as const),
        source: "encounter" as const,
        encounter_id: id,
        round: result.encounter.round,
        participants,
        request: actions,
        result: result.results,
        messages: result.messages,
        costs: isActor ? (paid ? paid.costs : casterCosts) : [],
        delta: stateDelta(before[k] ?? c.state, c.state),
        commit: true,
        pending_decision: !!result.pending,
        continues,
        ...(isActor && paid?.forced ? { forced: true } : {}),
      };
    }),
  );
}

function appendLog(
  record: EncounterRecord,
  entry: Omit<LogEntry, "id" | "at" | "round">,
  round: number,
) {
  if (!entry.lines.length) return record.log;
  const full: LogEntry = { ...entry, id: newId("log"), at: Date.now(), round };
  return [...record.log, full].slice(-LOG_LIMIT);
}

/** The party with the states an earlier step changed (each reference kept whole). */
function withStates(party: Party, states: Readonly<Record<string, CharacterState>>): Party {
  const next: Record<string, CharacterDocs> = { ...party };
  for (const [key, state] of Object.entries(states)) {
    const docs = next[key];
    if (docs) next[key] = { ...docs, state };
  }
  return next;
}
