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
 */

import type {
  CharacterBuild,
  CharacterState,
  Encounter,
  EncounterAction,
  Message,
  PlayAction,
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
} from "@/engine/facade";
import { t } from "@/i18n";
import { changedFields, droppedFields } from "@/lib/files";
import type { RecordMeta } from "@/persistence/db";
import { rollDice } from "./dice";
import { type PlayWay, useSettings } from "./settings";
import { useUi } from "./ui";

/** Refused because a cost of a roll by hand can't be paid (the roll can still be forced). */
export interface UnpaidRefusal extends Refusal {
  readonly unpaid: true;
}
export type RollOutcome = Outcome<EncounterChange> | UnpaidRefusal;

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
  readonly created: number;
  readonly updated: number;
}

type CharacterSnapshot = {
  readonly kind: "character";
  readonly build: CharacterBuild;
  readonly state: CharacterState;
};
type EncounterSnapshot = {
  readonly kind: "encounter";
  readonly encounter: Encounter;
  /** Party states as they were, restored with the encounter. */
  readonly states: Readonly<Record<string, CharacterState>>;
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
  playAction(id: string, action: PlayAction | readonly PlayAction[]): Promise<Outcome<PlayChange>>;
  /** Rolled by hand on the sheet: the dice shown in the tray, the costs spent on the state. */
  rollByHand(id: string, what: RollWhat): Promise<Outcome<SheetRoll>>;

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
   * Publish what an import committed (records written, the transaction done): replaced records
   * get the import's version, their previous documents go on their undo stack.
   */
  publishImport(publication: ImportPublication): void;
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
  function commitCharacter(id: string, build: CharacterBuild, state: CharacterState) {
    set((s) => {
      const record = s.characters[id];
      if (!record) return s;
      return {
        characters: { ...s.characters, [id]: touch(record, { build, state }) },
        revs: bump(s.revs, id),
        history: pushPast(s.history, id, {
          kind: "character",
          build: record.build,
          state: record.state,
        }),
      };
    });
  }

  const genOf = (id: string) => get().characters[id]?.gen ?? get().encounters[id]?.gen ?? 0;
  /**
   * A change of these records, in their queues; refused (`document_replaced`) when an import
   * replaced one of them after the change was asked for.
   */
  function guarded<T>(ids: readonly string[], fn: () => T | Promise<T>, onReplaced: () => T) {
    const gens = ids.map(genOf);
    return serialMany(ids, () =>
      ids.some((id, i) => genOf(id) !== gens[i]) ? onReplaced() : fn(),
    );
  }
  const quietly = () => {
    replaced();
  };

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
          commitCharacter(id, result.build, fitted.state);
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

    playAction(id, action) {
      return guarded(
        [id],
        async () => {
          const record = get().characters[id];
          if (!record) return missing();
          const result = await engine().applyPlayAction(
            record.build,
            record.state,
            action,
            record.content,
          );
          if (!result.ok) return result;
          commitCharacter(id, record.build, result.state);
          toastNotes(result.notes);
          return result;
        },
        replaced,
      );
    },

    rollByHand(id, what) {
      return guarded(
        [id],
        async () => {
          const record = get().characters[id];
          if (!record) return missing();
          const result = await engine().rollByHand(
            record.build,
            record.state,
            what,
            false,
            record.content,
          );
          if (!result.ok) return result;
          commitCharacter(id, record.build, result.state);
          const { roll } = result;
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
          return result;
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
      const ids = encounterIds(id, action);
      return guarded(
        ids,
        () =>
          applyToEncounter(id, action, (encounter, party, world) =>
            engine().applyEncounterAction(encounter, party, action, world),
          ),
        replaced,
      );
    },

    rollAndPay(id, roll, force = false) {
      return guarded(
        encounterIds(id, roll),
        () =>
          applyToEncounter(id, roll, async (encounter, party, world) => {
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
            return {
              ...paid,
              states: { ...rolled.states, ...paid.states },
              notes: [...rolled.notes, ...paid.notes],
              messages: [...rolled.messages, ...paid.messages],
              applied: 2,
              results: rolled.results,
            };
          }),
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
        [id, ...historyParty(get(), id, "back")],
        () => set((s) => travel(s, id, "back")),
        quietly,
      );
    },
    redo(id) {
      return guarded(
        [id, ...historyParty(get(), id, "forward")],
        () => set((s) => travel(s, id, "forward")),
        quietly,
      );
    },

    publishImport({ characters, encounters }) {
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
              build: before.build,
              state: before.state,
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
              encounter: before.encounter,
              states: {},
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
  return target?.kind === "encounter" ? Object.keys(target.states) : [];
}

function missing(): Refusal {
  return { ok: false, reasons: [t("errors.documentGone")] };
}

/** Step a document back or forward through its history (restoring party states with it). */
function travel(
  s: DocumentsState,
  id: string,
  direction: "back" | "forward",
): Partial<DocumentsState> {
  const h = s.history[id];
  if (!h) return {};
  const from = direction === "back" ? h.past : h.future;
  const target = from[from.length - 1];
  if (!target) return {};
  const rest = from.slice(0, -1);
  if (target.kind === "character") {
    const record = s.characters[id];
    if (!record) return {};
    const current: Snapshot = { kind: "character", build: record.build, state: record.state };
    return {
      characters: {
        ...s.characters,
        [id]: touch(record, { build: target.build, state: target.state }),
      },
      revs: bump(s.revs, id),
      history: { ...s.history, [id]: swap(h, direction, rest, current) },
    };
  }
  const record = s.encounters[id];
  if (!record) return {};
  const states: Record<string, CharacterState> = {};
  const characters = { ...s.characters };
  for (const [key, state] of Object.entries(target.states)) {
    const c = characters[key];
    if (!c) continue;
    states[key] = c.state;
    characters[key] = touch(c, { state });
  }
  const current: Snapshot = {
    kind: "encounter",
    encounter: record.encounter,
    states,
  };
  return {
    encounters: {
      ...s.encounters,
      [id]: touch(record, { encounter: target.encounter }),
    },
    characters,
    revs: bump(s.revs, id, ...Object.keys(target.states)),
    history: { ...s.history, [id]: swap(h, direction, rest, current) },
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
): Promise<RollOutcome> {
  const { getState: get, setState: set } = useDocuments;
  const record = get().encounters[id];
  if (!record) return missing();
  const characters = get().characters;
  const party = { ...partyOf(record.encounter, characters), ...joining(action, characters) };
  const result = await run(record.encounter, party, record.content);
  if (!result.ok) return result;
  const before: Record<string, CharacterState> = {};
  for (const [key, docs] of Object.entries(party)) before[key] = docs.state;
  set((s) => {
    const current = s.encounters[id];
    if (!current) return s;
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
        [id]: touch(current, { encounter: result.encounter, log }),
      },
      characters: nextCharacters,
      revs: bump(s.revs, id, ...Object.keys(result.states)),
      history: pushPast(s.history, id, {
        kind: "encounter",
        encounter: record.encounter,
        states: before,
      }),
    };
  });
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
