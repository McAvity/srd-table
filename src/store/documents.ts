/**
 * The open documents: characters (`{ build, state }`) and encounters, exactly as the engine
 * returns them. The store has no reducers of its own: every write calls the engine through the
 * facade and commits the document it returns. A refused change leaves the document untouched and
 * returns the reasons to whoever asked.
 *
 * Each document has a revision counter (query keys use it) and an undo stack of previous
 * documents. Writes to one document are serialized, so fast clicks don't race on a stale copy.
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
import { rollDice } from "./dice";
import { type PlayWay, useSettings } from "./settings";
import { useUi } from "./ui";

/** Refused because a cost of a roll by hand can't be paid (the roll can still be forced). */
export interface UnpaidRefusal extends Refusal {
  readonly unpaid: true;
}
export type RollOutcome = Outcome<EncounterChange> | UnpaidRefusal;

export interface CharacterRecord {
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

export interface EncounterRecord {
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
  deleteCharacter(id: string): void;
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
  renameEncounter(id: string, name: string): void;
  deleteEncounter(id: string): void;
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
  clearLog(id: string): void;
  /** A combatant's way of playing its actions (`null`: the campaign's default). */
  setPlayMode(id: string, combatant: string, mode: PlayWay | null): void;

  undo(id: string): void;
  redo(id: string): void;
}

export function newId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return `${prefix}-${Array.from(bytes, (b) => b.toString(36).padStart(2, "0"))
    .join("")
    .slice(0, 10)}`;
}

/** The characters an encounter refers to, by key, as the engine wants them. */
export function partyOf(
  encounter: Encounter,
  characters: Readonly<Record<string, CharacterRecord>>,
): Party {
  const party: Record<string, { build: CharacterBuild; state: CharacterState }> = {};
  for (const c of encounter.combatants) {
    if (c.character === null) continue;
    const record = characters[c.character];
    if (record) party[c.character] = { build: record.build, state: record.state };
  }
  return party;
}

/** Characters an `add_character` action brings in: the engine needs their documents too. */
function joining(
  action: EncounterAction | readonly EncounterAction[],
  characters: Readonly<Record<string, CharacterRecord>>,
): Party {
  const party: Record<string, { build: CharacterBuild; state: CharacterState }> = {};
  for (const a of Array.isArray(action) ? action : [action]) {
    if (a.type !== "add_character") continue;
    const record = characters[a.character];
    if (record) party[a.character] = { build: record.build, state: record.state };
  }
  return party;
}

const queues = new Map<string, Promise<unknown>>();
/** Run writes to one document one after another. */
function serial<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const previous = queues.get(id) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  queues.set(
    id,
    next.catch(() => undefined),
  );
  return next;
}

function bump(revs: Readonly<Record<string, number>>, ...ids: string[]): Record<string, number> {
  const next = { ...revs };
  for (const id of ids) next[id] = (next[id] ?? 0) + 1;
  return next;
}

function pushPast(history: Readonly<Record<string, History>>, id: string, snapshot: Snapshot) {
  const h = history[id] ?? { past: [], future: [] };
  return { ...history, [id]: { past: [...h.past, snapshot].slice(-HISTORY_LIMIT), future: [] } };
}

function toastNotes(notes: readonly string[]): void {
  if (notes.length) useUi.getState().toast(notes, "info");
}

export const useDocuments = create<DocumentsState>()((set, get) => {
  /** Commit a character's new documents (from the engine), keeping the old ones for undo. */
  function commitCharacter(id: string, build: CharacterBuild, state: CharacterState) {
    set((s) => {
      const record = s.characters[id];
      if (!record) return s;
      return {
        characters: { ...s.characters, [id]: { ...record, build, state, updated: Date.now() } },
        revs: bump(s.revs, id),
        history: pushPast(s.history, id, {
          kind: "character",
          build: record.build,
          state: record.state,
        }),
      };
    });
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
        characters: { ...s.characters, [id]: { id, build, state, created: now, updated: now } },
        revs: bump(s.revs, id),
      }));
      return id;
    },

    async importCharacter(rawBuild, rawState) {
      const parsed = await engine().parseBuild(rawBuild);
      if (!parsed.ok) return parsed;
      let state: CharacterState;
      if (rawState === undefined) {
        state = await engine().createState(parsed.build);
      } else {
        const ps = await engine().parseState(rawState);
        if (!ps.ok) return ps;
        state = ps.state;
      }
      const fitted = await engine().reconcileState(parsed.build, state);
      toastNotes(fitted.notes);
      const id = newId("c");
      const now = Date.now();
      set((s) => ({
        characters: {
          ...s.characters,
          [id]: { id, build: parsed.build, state: fitted.state, created: now, updated: now },
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
      const renamed = name ? await engine().editBuild(record.build, { type: "name", name }) : null;
      const build = renamed?.ok ? renamed.build : record.build;
      set((s) => ({
        characters: {
          ...s.characters,
          [copy]: { ...record, id: copy, build, created: now, updated: now },
        },
        revs: bump(s.revs, copy),
      }));
      return copy;
    },

    deleteCharacter(id) {
      set((s) => {
        const { [id]: _gone, ...characters } = s.characters;
        const { [id]: _h, ...history } = s.history;
        return { characters, history, revs: bump(s.revs, id) };
      });
    },

    editBuild(id, edit) {
      return serial(id, async () => {
        const record = get().characters[id];
        if (!record) return missing();
        const result = await engine().editBuild(record.build, edit);
        if (!result.ok) return result;
        // The state follows the build: reconcile and show what it changed.
        const fitted = await engine().reconcileState(result.build, record.state);
        commitCharacter(id, result.build, fitted.state);
        toastNotes([...result.notes, ...fitted.notes]);
        return result;
      });
    },

    async previewEdit(id, edit) {
      const record = get().characters[id];
      if (!record) return missing();
      return engine().previewEdit(record.build, edit);
    },

    async levelUp(id, classId, hp) {
      const record = get().characters[id];
      if (!record) return missing();
      let roll: number | null = null;
      if (hp === "roll") {
        const view = await engine().evaluate(record.build);
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
        const view = await engine().evaluate(record.build);
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
      return serial(id, async () => {
        const record = get().characters[id];
        if (!record) return missing();
        const result = await engine().applyPlayAction(record.build, record.state, action);
        if (!result.ok) return result;
        commitCharacter(id, record.build, result.state);
        toastNotes(result.notes);
        return result;
      });
    },

    rollByHand(id, what) {
      return serial(id, async () => {
        const record = get().characters[id];
        if (!record) return missing();
        const result = await engine().rollByHand(record.build, record.state, what);
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
      });
    },

    async createEncounter(name) {
      const decisions = useSettings.getState().settings.monster_decisions;
      const encounter = await engine().newEncounter({ decisions });
      const id = newId("e");
      const now = Date.now();
      set((s) => ({
        encounters: {
          ...s.encounters,
          [id]: { id, name, encounter, log: [], created: now, updated: now },
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
          [id]: { id, name, encounter: parsed.encounter, log: [], created: now, updated: now },
        },
        revs: bump(s.revs, id),
      }));
      return { ok: true, id };
    },

    renameEncounter(id, name) {
      set((s) => {
        const record = s.encounters[id];
        if (!record) return s;
        return { encounters: { ...s.encounters, [id]: { ...record, name, updated: Date.now() } } };
      });
    },

    deleteEncounter(id) {
      set((s) => {
        const { [id]: _gone, ...encounters } = s.encounters;
        const { [id]: _h, ...history } = s.history;
        return { encounters, history, revs: bump(s.revs, id) };
      });
    },

    encounterAction(id, action) {
      return serial(id, () =>
        applyToEncounter(id, action, (encounter, party) =>
          engine().applyEncounterAction(encounter, party, action),
        ),
      );
    },

    rollAndPay(id, roll, force = false) {
      return serial(id, () =>
        applyToEncounter(id, roll, async (encounter, party) => {
          const rolled = await engine().applyEncounterAction(encounter, party, roll);
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
      );
    },

    clearLog(id) {
      set((s) => {
        const record = s.encounters[id];
        if (!record) return s;
        return { encounters: { ...s.encounters, [id]: { ...record, log: [] } } };
      });
    },

    setPlayMode(id, combatant, mode) {
      set((s) => {
        const record = s.encounters[id];
        if (!record) return s;
        const { [combatant]: _old, ...rest } = record.modes ?? {};
        const modes = mode ? { ...rest, [combatant]: mode } : rest;
        return {
          encounters: { ...s.encounters, [id]: { ...record, modes, updated: Date.now() } },
        };
      });
    },

    undo(id) {
      set((s) => travel(s, id, "back"));
    },
    redo(id) {
      set((s) => travel(s, id, "forward"));
    },
  };
});

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
        [id]: { ...record, build: target.build, state: target.state, updated: Date.now() },
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
    characters[key] = { ...c, state, updated: Date.now() };
  }
  const current: Snapshot = {
    kind: "encounter",
    encounter: record.encounter,
    states,
  };
  return {
    encounters: {
      ...s.encounters,
      [id]: {
        ...record,
        encounter: target.encounter,
        updated: Date.now(),
      },
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
  run: (encounter: Encounter, party: Party) => Promise<RollOutcome>,
): Promise<RollOutcome> {
  const { getState: get, setState: set } = useDocuments;
  const record = get().encounters[id];
  if (!record) return missing();
  const characters = get().characters;
  const party = { ...partyOf(record.encounter, characters), ...joining(action, characters) };
  const result = await run(record.encounter, party);
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
      if (c) nextCharacters[key] = { ...c, state, updated: Date.now() };
    }
    return {
      encounters: {
        ...s.encounters,
        [id]: {
          ...current,
          encounter: result.encounter,
          log,
          updated: Date.now(),
        },
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

/** The party with the states an earlier step changed. */
function withStates(party: Party, states: Readonly<Record<string, CharacterState>>): Party {
  const next: Record<string, CharacterDocs> = { ...party };
  for (const [key, state] of Object.entries(states)) {
    const docs = next[key];
    if (docs) next[key] = { ...docs, state };
  }
  return next;
}
