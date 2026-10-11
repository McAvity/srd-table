/**
 * The engine facade: every rules operation the app uses, JSON in and JSON out, mirroring the
 * engine's functions and HTTP routes. One implementation runs in-process (tests, and inside the
 * worker); `client.ts` reaches it over Comlink. Keep signatures plain data so an HTTP
 * implementation (`createHandler` routes) stays a drop-in.
 *
 * This folder is the only importer of `srd-rules-engine` functions; types come from anywhere.
 */

import {
  ABILITIES,
  ABILITY_NAMES,
  type Ability,
  type AbilityMap,
  type AbilityMethod,
  type AbilityRoll,
  type ActionCheck,
  ALIGNMENT_NAMES,
  ALIGNMENTS,
  type Alignment,
  type AreaPreview,
  type AreaRequest,
  abilityModifier,
  BuildError,
  type ByHandRoll,
  builder,
  type Catalog,
  type CharacterBuild,
  type CharacterState,
  type CheckedCost,
  type ChoiceKind,
  type ClassLevel,
  type CombatantOptions,
  type CreationRules,
  checkAction,
  checkCosts,
  combatantFromCharacter,
  combatantOptions,
  computePlaySheet,
  createBuild,
  createEncounter,
  createState,
  currentCombatant,
  type D20TestRequest,
  type D20TestResult,
  DAMAGE_TYPES,
  type DamagePart,
  type DamageType,
  type Encounter,
  type EncounterAction,
  EncounterActionSchema,
  type EncounterContext,
  EncounterError,
  encounterCombatant,
  applyAction as engineApplyAction,
  applyEncounterAction as engineApplyEncounterAction,
  previewArea as enginePreviewArea,
  previewMove as enginePreviewMove,
  zoneSquares as engineZoneSquares,
  evaluate,
  gridDistance,
  type Issue,
  issuesForLevel,
  issuesForStep,
  lookup,
  MAX_ATTUNED,
  type Message,
  type MessageCode,
  type MovePreview,
  magicItemBases,
  type OptionView,
  type PackManifest,
  type Pending,
  type PlayAction,
  PlayError,
  type PlaySheet,
  POINT_KINDS,
  type PointBuyRules,
  type PointBuyStatus,
  type PointKind,
  parseBuild,
  parseEncounter,
  parseState,
  playBuild,
  pointBuyStatus,
  type Reachable,
  type Rng,
  type RolledDamage,
  type RollResult,
  type RollWhat,
  RuleError,
  reachableSquares,
  reconcileState,
  resolve,
  roll,
  rollAbilityScores,
  rollByHand,
  rollCheck,
  rollDamage,
  SKILL_ABILITY,
  SKILLS,
  type Skill,
  STEP_TITLES,
  STEPS,
  type Step,
  seededRng,
  skillName,
  startingEquipment,
  type TableName,
  unassignedValues,
  type ValidationReport,
  validateState,
} from "srd-rules-engine";
import { z } from "zod";
import type { EngineLanguage } from "@/i18n/engine";
import { ContentLoader, type ContentSettings, type FetchPackFile } from "./content";
import { engineLanguage, localize, renderAll } from "./messages";

// --- results ------------------------------------------------------------------------------

/** A refused setter or action: the document is unchanged; `reasons` are the engine's words. */
/** The build's starting equipment and gold (`startingEquipment`). */
export type StartingEquipment = ReturnType<typeof startingEquipment>;

export interface Refusal {
  readonly ok: false;
  readonly reasons: readonly string[];
  /** `reasons` as messages, when the engine gave them (rendered in the app's language). */
  readonly reason_messages?: readonly Message[];
}
export type Outcome<T> = ({ readonly ok: true } & T) | Refusal;

export type LevelUpOption = builder.LevelUpOption;
export type StatChange = builder.StatChange;
export type StateIssue = ReturnType<typeof validateState>[number];

// --- builder views --------------------------------------------------------------------------

/** One active choice, with every option and the reason it can't be picked. */
export interface ChoiceView {
  readonly key: string;
  readonly label: string;
  readonly kind: ChoiceKind;
  /** The character level the choice is made at (1: character creation). */
  readonly level: number;
  readonly step: Step;
  readonly step_title: string;
  /** How many picks (a replacement is answered `[old, new]`). */
  readonly count: number;
  readonly required: number;
  readonly replaces: { readonly family: string; readonly label: string } | null;
  /** For a replacement: the picks that can be replaced (`options` are the new ones). */
  readonly replace_old_options: readonly OptionView[] | null;
  readonly hint: string | null;
  readonly source: string;
  readonly fixed: readonly string[] | null;
  readonly selected: readonly string[];
  readonly options: readonly OptionView[];
  /** The same option can be picked more than once (Ability Score Improvement). */
  readonly repeats: boolean;
  /** Picks can be changed after a Short or Long Rest (in the play state: `set_choice`). */
  readonly rest_change: "short" | "long" | null;
}

export interface StepView {
  readonly step: Step;
  readonly title: string;
  readonly complete: boolean;
  readonly issues: readonly Issue[];
}

export interface LevelView {
  readonly level: number;
  readonly class_id: string;
  readonly class_level: number;
  readonly hp: number | null;
  readonly complete: boolean;
  readonly issues: readonly Issue[];
}

export interface AbilitiesView {
  readonly method: AbilityMethod | null;
  readonly standard_array: readonly number[];
  readonly rolled_pool: readonly number[];
  /** Standard array or rolled values not assigned to an ability yet, highest first. */
  readonly unassigned: readonly number[];
  readonly point_buy_rules: PointBuyRules;
  /** Budget and per-ability costs (point buy only). */
  readonly point_buy: PointBuyStatus | null;
  /** The abilities the background can raise. */
  readonly background_abilities: readonly string[];
  readonly max_score_at_creation: number;
}

/** Everything the builder shows for a build: `evaluate` shaped as JSON. */
export interface BuildView {
  readonly build: CharacterBuild;
  readonly report: ValidationReport;
  readonly sheet: ReturnType<typeof evaluate>["sheet"];
  readonly level: number;
  readonly levels: readonly LevelView[];
  readonly level_up_options: readonly LevelUpOption[];
  readonly choices: readonly ChoiceView[];
  readonly steps: readonly StepView[];
  /** The first step with something missing or illegal, if any. */
  readonly next_step: Step | null;
  readonly abilities: AbilitiesView;
}

/** A change to a build, as the builder's setters take it. */
export type BuildEdit =
  | { readonly type: "class"; readonly id: string }
  | { readonly type: "species"; readonly id: string }
  | { readonly type: "background"; readonly id: string }
  | {
      readonly type: "ability_method";
      readonly method: AbilityMethod;
      readonly pool?: readonly number[];
    }
  | { readonly type: "base_scores"; readonly scores: AbilityMap }
  | { readonly type: "background_bonus"; readonly bonus: AbilityMap }
  | { readonly type: "choice"; readonly key: string; readonly values: readonly string[] }
  | { readonly type: "name"; readonly name: string }
  | { readonly type: "alignment"; readonly alignment: Alignment }
  /** `hp`: the Hit Die roll, or `null` for the fixed value. */
  | { readonly type: "level_up"; readonly class_id: string; readonly hp: number | null }
  | { readonly type: "remove_level" }
  | { readonly type: "level_class"; readonly level: number; readonly class_id: string }
  | { readonly type: "level_hp"; readonly level: number; readonly hp: number | null };

export interface BuildChange {
  readonly build: CharacterBuild;
  readonly notes: readonly string[];
  /** The notes as codes and parameters, for translation (`messages[i].text === notes[i]`). */
  readonly messages: readonly Message[];
}

export interface ChangePreview extends BuildChange {
  readonly removed: readonly {
    readonly level: number;
    readonly key: string;
    readonly label: string;
    readonly values: readonly string[];
  }[];
  readonly pending: readonly { readonly level: number; readonly message: string }[];
}

// --- play and encounters ------------------------------------------------------------------

export interface PlayView {
  readonly sheet: PlaySheet;
  readonly issues: readonly StateIssue[];
}

export interface PlayChange {
  readonly state: CharacterState;
  readonly notes: readonly string[];
}

/** A roll by hand on the sheet: the dice, its costs checked, and the state with them spent. */
export interface SheetRoll extends PlayChange {
  readonly roll: Omit<ByHandRoll, "costs"> & { readonly costs: readonly CheckedCost[] };
  /** `notes` as messages (rendered in the app's language). */
  readonly messages: readonly Message[];
}

/** A character an encounter refers to, by its key. */
export interface CharacterDocs {
  readonly build: CharacterBuild;
  readonly state: CharacterState;
}
export type Party = Readonly<Record<string, CharacterDocs>>;

/** The rolls of an encounter action (`attack`, `cast`, `check`…), for showing the dice. */
export type ActionResult = ReturnType<typeof engineApplyEncounterAction>["result"];
/**
 * An action result with rolls in it, for the dice tray: one played by hand (`manual`) counts only
 * when the engine rolled its dice (`rolls`; `null` when the actor rolls at the table).
 */
export type RolledResult = NonNullable<ActionResult>;

export interface EncounterChange {
  readonly encounter: Encounter;
  /** Character states the actions changed, by character key. */
  readonly states: Readonly<Record<string, CharacterState>>;
  readonly notes: readonly string[];
  /** The notes as codes and parameters, for translation (`messages[i].text === notes[i]`). */
  readonly messages: readonly Message[];
  /** The decision the list stopped at (also `encounter.pending`). */
  readonly pending: Pending | null;
  /** Actions applied before the one that stopped for a decision. */
  readonly applied: number;
  /** Each applied action's rolls, in order (and the stopped one's, last, if any). */
  readonly results: readonly NonNullable<ActionResult>[];
}

/** A combatant as the Initiative order and the map show it. */
export interface CombatantView {
  readonly id: string;
  readonly name: string;
  readonly side: string;
  readonly monster: string | null;
  readonly character: string | null;
  readonly initiative: number | null;
  readonly hp: number;
  readonly max_hp: number;
  readonly temp_hp: number;
  /** At half its Hit Points or fewer (the engine's `bloodied`). */
  readonly bloodied: boolean;
  readonly armor_class: number;
  readonly conditions: readonly { readonly id: string; readonly name: string }[];
  readonly concentration: string | null;
  readonly defeated: boolean;
  readonly dying: boolean;
  readonly dead: boolean;
  readonly size: string | null;
  /** Squares on a side of its space (the engine's `space`: Large 2, Huge 3…); `position` is its top-left square. */
  readonly space: number;
  readonly position: { readonly x: number; readonly y: number } | null;
  readonly used: Encounter["combatants"][number]["used"];
  readonly inspiration: Encounter["combatants"][number]["inspiration"];
  readonly decisions: "ask" | "auto" | null;
  /** The engine couldn't build this combatant (a character that isn't loaded). */
  readonly error: string | null;
}

/** A zone (a lasting spell area) as the map draws it. */
export interface ZoneView {
  readonly id: string;
  readonly label: string;
  readonly by: string;
  /** Squares it covers now (`"x,y"`), from the engine's `zoneSquares`. */
  readonly squares: readonly string[];
  /** A wall between squares (Wall of Force): grid-line segments. */
  readonly segments: readonly { readonly from: GridXY; readonly to: GridXY }[];
  readonly difficult: boolean;
}

type GridXY = { readonly x: number; readonly y: number };

export interface EncounterView {
  readonly round: number;
  /** Whose turn it is (`null` before the fight starts). */
  readonly current: string | null;
  /** Combatants in Initiative order, then those without a place in it. */
  readonly combatants: readonly CombatantView[];
  readonly zones: readonly ZoneView[];
}

/**
 * The engine's fixed lists and names the UI iterates or shows (abilities, skills, damage types,
 * alignments, builder steps), fetched once at startup so the main thread imports no engine code.
 */
export interface EngineConstants {
  readonly abilities: readonly { readonly id: Ability; readonly name: string }[];
  readonly skills: readonly {
    readonly id: Skill;
    readonly name: string;
    readonly ability: Ability;
  }[];
  readonly damage_types: readonly DamageType[];
  readonly alignments: readonly { readonly id: Alignment; readonly name: string }[];
  readonly steps: readonly { readonly id: Step; readonly title: string }[];
  readonly max_attuned: number;
  /** The skills each check action accepts (Search, Study, Influence), from its schema. */
  readonly check_skills: Readonly<Record<string, readonly Skill[]>>;
  /** What a point of interest can be (its icon). */
  readonly point_kinds: readonly PointKind[];
}

// --- the facade ---------------------------------------------------------------------------

export interface EngineFacade {
  constants(): Promise<EngineConstants>;
  /** Packs and allowed sources; the catalog is rebuilt on the next operation. */
  configure(settings: ContentSettings): Promise<void>;
  /** The language engine texts are rendered in (`ENGINE_LANGUAGES`; English otherwise). */
  setLocale(locale: string): Promise<void>;
  /** Engine messages rendered in the current language (a stored combat log), list by list. */
  renderMessages(lists: readonly (readonly Message[])[]): Promise<string[][]>;
  /** Fix the dice (a dev setting, to replay a bug), or `null` for a random seed. */
  setSeed(seed: number | null): Promise<void>;

  // content
  entries(table: TableName): Promise<readonly unknown[]>;
  entry(table: TableName, id: string): Promise<unknown>;
  packs(): Promise<readonly PackManifest[]>;
  creation(): Promise<CreationRules>;
  /** Ability modifiers for scores (`abilityModifier`): a stat block shows them. */
  modifiers(scores: Readonly<Record<string, number>>): Promise<Record<string, number>>;

  // documents: validate and migrate whatever was loaded
  parseBuild(input: unknown): Promise<Outcome<{ build: CharacterBuild }>>;
  parseState(input: unknown): Promise<Outcome<{ state: CharacterState }>>;
  parseEncounter(input: unknown): Promise<Outcome<{ encounter: Encounter }>>;
  newBuild(): Promise<CharacterBuild>;
  newEncounter(options?: { decisions?: "ask" | "auto" }): Promise<Encounter>;

  // builder
  evaluate(build: CharacterBuild): Promise<BuildView>;
  /**
   * The builder's view of the build as played today (the state's "after a rest" picks overlaid,
   * the engine's `playBuild`): the options those choices offer today.
   */
  evaluatePlay(build: CharacterBuild, state: CharacterState): Promise<BuildView>;
  editBuild(build: CharacterBuild, edit: BuildEdit): Promise<Outcome<BuildChange>>;
  /** What an edit would remove and ask again, without applying it. */
  previewEdit(build: CharacterBuild, edit: BuildEdit): Promise<Outcome<ChangePreview>>;
  /**
   * The sheet numbers each option of a choice would change (`builder.previewOption`), by option
   * id; options that change nothing are left out.
   */
  optionPreviews(
    build: CharacterBuild,
    choiceKey: string,
  ): Promise<Readonly<Record<string, readonly StatChange[]>>>;
  rollAbilityScores(): Promise<readonly AbilityRoll[]>;

  // play
  createState(build: CharacterBuild): Promise<CharacterState>;
  /**
   * A character's D20 Test outside an encounter (a sheet's roll button): an ability check, a
   * saving throw or an attack roll, with the Advantage, Disadvantage and automatic failures its
   * conditions and features give (the engine's `rollCheck`, its dice).
   */
  rollCheck(
    build: CharacterBuild,
    state: CharacterState,
    request: D20TestRequest,
  ): Promise<D20TestResult>;
  /** The catalog items a magic item can be made from (`[]`: none, or no base). */
  magicItemBases(magicItemId: string): Promise<readonly string[]>;
  /** What `take_starting_equipment` adds: the build's starting equipment and gold. */
  startingEquipment(build: CharacterBuild): Promise<StartingEquipment>;
  playSheet(build: CharacterBuild, state: CharacterState): Promise<PlayView>;
  /** One action or a list, in order; all or nothing. */
  applyPlayAction(
    build: CharacterBuild,
    state: CharacterState,
    action: PlayAction | readonly PlayAction[],
  ): Promise<Outcome<PlayChange>>;
  reconcileState(build: CharacterBuild, state: CharacterState): Promise<PlayChange>;
  /**
   * Rolled by hand on the sheet (an attack, a spell, a feature's dice): the engine's free
   * `rollByHand`, its costs checked (`checkCosts`) and paid on the state with `applyAction`, as
   * `POST /v1/state/roll` then `/v1/state/apply`. Refused when a cost can't be paid (the app
   * tracks resources); with `force` rolled anyway, that cost unpaid.
   */
  rollByHand(
    build: CharacterBuild,
    state: CharacterState,
    what: RollWhat,
    force?: boolean,
  ): Promise<Outcome<SheetRoll>>;

  // encounters
  /** One action or a list, in order; all or nothing, stopping at a decision. */
  applyEncounterAction(
    encounter: Encounter,
    party: Party,
    action: EncounterAction | readonly EncounterAction[],
  ): Promise<Outcome<EncounterChange>>;
  encounterView(encounter: Encounter, party: Party): Promise<EncounterView>;
  combatantOptions(encounter: Encounter, party: Party, id: string): Promise<CombatantOptions>;
  checkAction(encounter: Encounter, party: Party, action: EncounterAction): Promise<ActionCheck>;
  /** What an area would cover if placed now: its squares and creatures (`previewArea`). */
  previewArea(encounter: Encounter, party: Party, request: AreaRequest): Promise<AreaPreview>;
  /** Squares a combatant can end a move on now, with their cost (`reachableSquares`). */
  reachable(encounter: Encounter, party: Party, id: string): Promise<Reachable>;
  /** What a move would do: its path, cost, zones and Opportunity Attacks (`previewMove`). */
  previewMove(
    encounter: Encounter,
    party: Party,
    move: { id: string; to: { x: number; y: number } },
  ): Promise<MovePreview>;
  /** Feet between two squares on the grid (`gridDistance`), for measuring. */
  distance(from: { x: number; y: number }, to: { x: number; y: number }): Promise<number>;
  /** Squares within `feet` of a combatant's space (`gridDistance`), to show reach and range. */
  squaresWithin(
    encounter: Encounter,
    party: Party,
    id: string,
    feet: number,
  ): Promise<readonly string[]>;

  // dice
  /** A free roll (`2d6+3`), with the worker's dice. */
  roll(expression: string): Promise<Outcome<{ roll: RollResult }>>;
  /** Roll an attack line's damage parts (`rollDamage`): a Critical Hit doubles the dice. */
  rollDamage(parts: readonly DamagePart[], critical: boolean): Promise<RolledDamage>;
}

// --- in-process implementation --------------------------------------------------------------

export interface FacadeOptions {
  readonly fetchFile: FetchPackFile;
  /** A fixed seed; default a random one (`crypto.getRandomValues`). */
  readonly seed?: number | null;
  /** Dice for tests (`scriptedRng`); overrides `seed`. */
  readonly rng?: Rng;
}

export function randomSeed(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0] ?? 1;
}

export function createInProcessFacade(options: FacadeOptions): EngineFacade {
  const content = new ContentLoader(options.fetchFile);
  let rng: Rng = options.rng ?? seededRng(options.seed ?? randomSeed());
  let language: EngineLanguage | null = null;

  const facade: EngineFacade = {
    constants: async () => ({
      abilities: ABILITIES.map((id) => ({
        id,
        name: language?.messages[`ability.${id}`] ?? ABILITY_NAMES[id],
      })),
      skills: SKILLS.map((id) => ({
        id,
        name: language?.messages[`skill.${id}`] ?? skillName(id),
        ability: SKILL_ABILITY[id],
      })),
      damage_types: DAMAGE_TYPES,
      alignments: ALIGNMENTS.map((id) => ({
        id,
        name: language?.messages[`alignment.${id}`] ?? ALIGNMENT_NAMES[id],
      })),
      steps: STEPS.map((id) => ({
        id,
        title: language?.messages[`step.${id}`] ?? STEP_TITLES[id],
      })),
      max_attuned: MAX_ATTUNED,
      check_skills: checkSkills(),
      point_kinds: POINT_KINDS,
    }),
    async configure(settings) {
      content.configure(settings);
    },
    async setLocale(locale) {
      language = engineLanguage(locale);
    },
    renderMessages: async (lists) => lists.map((list) => renderAll(list, language)),
    async setSeed(seed) {
      rng = seededRng(seed ?? randomSeed());
    },

    entries: async (table) => {
      const catalog = await content.catalog([table]);
      return Object.values(catalog[table] as Record<string, unknown>);
    },
    entry: async (table, id) => {
      const catalog = await content.catalog([table]);
      return lookup(catalog[table] as Record<string, unknown>, id) ?? null;
    },
    packs: () => content.run("builder", (catalog) => catalog.packs),
    creation: () => content.run("builder", (catalog) => catalog.creation),
    modifiers: async (scores) =>
      Object.fromEntries(Object.entries(scores).map(([k, v]) => [k, abilityModifier(v)])),

    parseBuild: async (input) => attempt(() => ({ build: parseBuild(input) })),
    parseState: async (input) => attempt(() => ({ state: parseState(input) })),
    parseEncounter: async (input) => attempt(() => ({ encounter: parseEncounter(input) })),
    newBuild: async () => createBuild(),
    newEncounter: async (opts) => createEncounter(opts),

    evaluate: (build) => content.run("builder", (catalog) => buildView(build, catalog)),
    evaluatePlay: (build, state) =>
      content.run("builder", (catalog) => buildView(playBuild(build, state, catalog), catalog)),
    editBuild: (build, edit) =>
      content.run("builder", (catalog) => attempt(() => applyEdit(build, catalog, edit))),
    previewEdit: (build, edit) =>
      content.run("builder", (catalog) =>
        attempt(() =>
          builder.previewChange(
            build,
            catalog,
            (b) => applyEdit(b, catalog, edit),
            edit.type === "choice" ? edit.key : undefined,
          ),
        ),
      ),
    optionPreviews: (build, choiceKey) =>
      content.run("builder", (catalog) => {
        const res = resolve(build, catalog);
        const choice = res.choices.find((c) => c.key === choiceKey);
        if (!choice) return {};
        return Object.fromEntries(
          res
            .options(choice)
            .map((o) => [o.id, builder.previewOption(build, catalog, choiceKey, o.id)] as const)
            .filter(([, changes]) => changes.length > 0),
        );
      }),
    rollAbilityScores: async () => rollAbilityScores(rng),

    createState: (build) => content.run("play", (catalog) => createState(build, catalog)),
    rollCheck: (build, state, request) =>
      content.run("play", (catalog) => rollCheck(build, state, catalog, request, { rng })),
    magicItemBases: (id) => content.run("play", (catalog) => magicItemBases(catalog, id)),
    startingEquipment: (build) =>
      content.run("play", (catalog) => startingEquipment(build, catalog)),
    playSheet: (build, state) =>
      content.run("play", (catalog) => ({
        sheet: computePlaySheet(build, state, catalog),
        issues: validateState(build, state, catalog),
      })),
    applyPlayAction: (build, state, action) =>
      content.run("play", (catalog) =>
        attempt(() => {
          let current = state;
          const notes: string[] = [];
          for (const a of listOf(action)) {
            const result = engineApplyAction(build, current, catalog, a, { rng });
            current = result.state;
            notes.push(...result.notes);
          }
          return { state: current, notes };
        }),
      ),
    reconcileState: (build, state) =>
      content.run("play", (catalog) => reconcileState(build, state, catalog)),
    rollByHand: (build, state, what, force = false) =>
      content.run("play", (catalog) =>
        attempt(() => {
          const character = { build, state };
          const combatant = combatantFromCharacter(build, state, catalog);
          const roll = rollByHand(combatant, what, { catalog, character, rng });
          const costs = checkCosts(roll.costs, { catalog, name: combatant.name, character });
          const unpaid = costs.flatMap((c) => (c.payable || !c.reason ? [] : [c.reason]));
          // The app tracks resources: a roll it can't pay for is refused, unless forced.
          if (unpaid.length > 0 && !force) {
            throw new PlayError(unpaid.map((r) => r.message));
          }
          const messages: Message[] = [...roll.messages];
          let current = state;
          for (const cost of costs) {
            if (cost.type !== "play" || !cost.payable) continue;
            const applied = engineApplyAction(build, current, catalog, cost.action, { rng });
            current = applied.state;
            messages.push(...applied.messages);
          }
          for (const r of unpaid) messages.push(r.message);
          return {
            roll: { ...roll, costs },
            state: current,
            messages,
            notes: messages.map((m) => m.text),
          };
        }),
      ),

    applyEncounterAction: (encounter, party, action) =>
      content.run("encounter", (catalog) =>
        attempt(() => {
          const characters: Record<string, CharacterDocs> = { ...party };
          let current = encounter;
          const states: Record<string, CharacterState> = {};
          const notes: string[] = [];
          const messages: Message[] = [];
          const results: NonNullable<ActionResult>[] = [];
          let applied = 0;
          for (const a of listOf(action)) {
            const result = engineApplyEncounterAction(current, a, { catalog, characters, rng });
            current = result.encounter;
            notes.push(...result.notes);
            messages.push(...result.messages);
            if (result.result) results.push(result.result);
            if (result.pending) {
              return {
                encounter: current,
                states,
                notes,
                messages,
                pending: result.pending,
                applied,
                results,
              };
            }
            applied += 1;
            for (const [key, state] of Object.entries(result.states)) {
              const docs = characters[key];
              if (!docs) continue;
              states[key] = state;
              characters[key] = { build: docs.build, state };
            }
          }
          return {
            encounter: current,
            states,
            notes,
            messages,
            pending: null,
            applied,
            results,
          };
        }),
      ),
    encounterView: (encounter, party) =>
      content.run("encounter", (catalog) => encounterView(encounter, party, catalog)),
    combatantOptions: (encounter, party, id) =>
      content.run("encounter", (catalog) =>
        combatantOptions(encounter, id, { catalog, characters: party }),
      ),
    checkAction: (encounter, party, action) =>
      content.run("encounter", (catalog) =>
        checkAction(encounter, action, { catalog, characters: party }),
      ),

    previewArea: (encounter, party, request) =>
      content.run("encounter", (catalog) =>
        enginePreviewArea(encounter, request, { catalog, characters: party }),
      ),
    reachable: (encounter, party, id) =>
      content.run("encounter", (catalog) =>
        reachableSquares(encounter, id, { catalog, characters: party }),
      ),
    previewMove: (encounter, party, move) =>
      content.run("encounter", (catalog) =>
        enginePreviewMove(encounter, move, { catalog, characters: party }),
      ),
    distance: async (from, to) => gridDistance(from, 1, to, 1),
    squaresWithin: (encounter, party, id, feet) =>
      content.run("encounter", (catalog) => {
        const c = encounter.combatants.find((x) => x.id === id);
        if (!c?.position) return [];
        const space = encounterCombatant(encounter, id, { catalog, characters: party }).space;
        const r = Math.ceil(feet / 5);
        const out: string[] = [];
        for (let x = c.position.x - r; x <= c.position.x + space - 1 + r; x++) {
          for (let y = c.position.y - r; y <= c.position.y + space - 1 + r; y++) {
            const d = gridDistance(c.position, space, { x, y }, 1);
            if (d > 0 && d <= feet) out.push(`${x},${y}`);
          }
        }
        return out;
      }),
    roll: async (expression) => attempt(() => ({ roll: roll(expression, rng) })),
    rollDamage: async (parts, critical) => rollDamage(parts, { critical, rng }),
  };
  return localized(facade, () => language);
}

/** Facade methods whose results are documents, content or plain data: returned as they are. */
const UNLOCALIZED = new Set<keyof EngineFacade>([
  "constants",
  "configure",
  "setLocale",
  "renderMessages",
  "setSeed",
  "entries",
  "entry",
  "packs",
  "creation",
  "modifiers",
  "newBuild",
  "newEncounter",
  "createState",
  "rollAbilityScores",
  "distance",
  "squaresWithin",
]);

/**
 * Every other method's result in the current language (`localize`); the builder's step titles too
 * (the facade's own fields, named from the catalog's `step.*` codes).
 */
function localized(facade: EngineFacade, current: () => EngineLanguage | null): EngineFacade {
  const out: Record<string, unknown> = {};
  for (const [name, fn] of Object.entries(facade) as [
    keyof EngineFacade,
    (...args: unknown[]) => Promise<unknown>,
  ][]) {
    out[name] = UNLOCALIZED.has(name)
      ? fn
      : async (...args: unknown[]) => {
          const result = await fn(...args);
          const language = current();
          return language ? stepTitles(localize(result, language), language) : result;
        };
  }
  return out as unknown as EngineFacade;
}

/** Step titles (`title`, `step_title` next to a `step`), from the catalog's `step.*` codes. */
function stepTitles<T>(value: T, language: EngineLanguage): T {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (typeof v !== "object" || v === null) return v;
    const o = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(o)) out[k] = k === "build" || k === "state" ? x : walk(x);
    const step =
      typeof o.step === "string" ? language.messages[`step.${o.step}` as MessageCode] : undefined;
    if (step && typeof o.title === "string") out.title = step;
    if (step && typeof o.step_title === "string") out.step_title = step;
    return out;
  };
  return walk(value) as T;
}

/** The `skill` enum of each encounter action that takes one, read from the engine's schema. */
function checkSkills(): Record<string, Skill[]> {
  const out: Record<string, Skill[]> = {};
  for (const option of EncounterActionSchema.options) {
    const shape = option.shape as Record<string, unknown>;
    const type = (shape.type as { value?: string } | undefined)?.value;
    let skill = shape.skill as { options?: unknown; unwrap?: () => unknown } | undefined;
    if (!type || !skill || type === "check" || type === "help") continue;
    if (!Array.isArray(skill.options) && skill.unwrap) skill = skill.unwrap() as typeof skill;
    if (Array.isArray(skill?.options)) out[type] = skill.options as Skill[];
  }
  return out;
}

/**
 * The squares a zone covers now (`"x,y"`): a wall spell's own list (and the wall's squares),
 * else the engine's `zoneSquares` (an Emanation follows its caster and leaves out its space;
 * nothing when the zone isn't on the grid).
 */
function zoneSquaresOf(
  encounter: Encounter,
  zone: Encounter["zones"][number],
  ctx: EncounterContext,
): string[] {
  if (zone.squares) return [...zone.squares, ...zone.wall_squares].map((p) => `${p.x},${p.y}`);
  return (engineZoneSquares(encounter, zone.id, ctx) ?? []).map((p) => `${p.x},${p.y}`);
}

function listOf<T>(value: T | readonly T[]): readonly T[] {
  return Array.isArray(value) ? (value as readonly T[]) : [value as T];
}

/** Run an engine call, turning its refusals into a `Refusal` (classes don't survive postMessage). */
function attempt<T extends object>(fn: () => T): Outcome<T> {
  try {
    return { ok: true, ...fn() };
  } catch (error) {
    const reasons = refusalReasons(error);
    if (!reasons) throw error;
    const messages = refusalMessages(error);
    return messages ? { ok: false, reasons, reason_messages: messages } : { ok: false, reasons };
  }
}

function refusalMessages(error: unknown): readonly Message[] | null {
  if (error instanceof BuildError || error instanceof PlayError || error instanceof EncounterError)
    return error.details;
  if (error instanceof RuleError) return [error.detail];
  return null;
}

function refusalReasons(error: unknown): readonly string[] | null {
  if (error instanceof BuildError) return error.messages;
  if (error instanceof PlayError || error instanceof EncounterError) return error.messages;
  if (error instanceof z.ZodError) return z.prettifyError(error).split("\n").filter(Boolean);
  // Bad dice expressions and unknown attack lines.
  if (error instanceof RangeError) return [error.message];
  return null;
}

function applyEdit(build: CharacterBuild, catalog: Catalog, edit: BuildEdit): BuildChange {
  switch (edit.type) {
    case "class":
      return builder.setClass(build, catalog, edit.id);
    case "species":
      return builder.setSpecies(build, catalog, edit.id);
    case "background":
      return builder.setBackground(build, catalog, edit.id);
    case "ability_method":
      return builder.setAbilityMethod(build, catalog, edit.method, edit.pool ?? []);
    case "base_scores":
      return builder.setBaseScores(build, catalog, edit.scores);
    case "background_bonus":
      return builder.setBackgroundBonus(build, catalog, edit.bonus);
    case "choice":
      return builder.setChoice(build, catalog, edit.key, edit.values);
    case "name":
      return builder.setName(build, catalog, edit.name);
    case "alignment":
      return builder.setAlignment(build, catalog, edit.alignment);
    case "level_up":
      return builder.levelUp(build, catalog, edit.class_id, edit.hp);
    case "remove_level":
      return builder.removeLastLevel(build, catalog);
    case "level_class":
      return builder.setLevelClass(build, catalog, edit.level, edit.class_id);
    case "level_hp":
      return builder.setLevelHp(build, catalog, edit.level, edit.hp);
  }
}

function buildView(build: CharacterBuild, catalog: Catalog): BuildView {
  const ev = evaluate(build, catalog);
  const res = ev.resolution;
  const choices: ChoiceView[] = res.choices.map((c) => ({
    key: c.key,
    label: c.label,
    kind: c.definition.kind,
    level: c.level,
    step: c.step,
    step_title: STEP_TITLES[c.step],
    count: c.replaces ? 2 : res.countOf(c),
    required: res.required(c),
    replaces: c.replaces ? { family: c.replaces.id, label: c.replaces.label } : null,
    replace_old_options: c.replaces ? res.replaceOld(c) : null,
    hint: c.definition.hint,
    source: c.source.name,
    fixed: c.fixed,
    selected: res.selected(c),
    options: res.options(c),
    repeats: c.definition.kind === "ability_increase",
    rest_change: c.definition.rest_change,
  }));
  const levels: LevelView[] = res.levels.map((l: ClassLevel) => {
    const issues = issuesForLevel(ev.report, l.level);
    return {
      ...l,
      issues,
      complete: issues.every((i) => i.severity === "note"),
    };
  });
  const steps: StepView[] = STEPS.map((step) => {
    const issues = issuesForStep(ev.report, step);
    return {
      step,
      title: STEP_TITLES[step],
      issues,
      complete: issues.every((i) => i.severity === "note"),
    };
  });
  const rules = catalog.creation.point_buy;
  const background = lookup(catalog.backgrounds, build.background_id);
  return {
    build,
    report: ev.report,
    sheet: ev.sheet,
    level: res.characterLevel,
    levels,
    level_up_options: builder.levelUpOptions(build, catalog),
    choices,
    steps,
    next_step: builder.nextIncompleteStep(ev),
    abilities: {
      method: build.ability_method,
      standard_array: catalog.creation.standard_array,
      rolled_pool: build.rolled_pool,
      unassigned:
        build.ability_method === "standard_array" || build.ability_method === "roll"
          ? unassignedValues(
              build.ability_method,
              build.base_scores,
              catalog.creation,
              build.rolled_pool,
            )
          : [],
      point_buy_rules: rules,
      point_buy:
        build.ability_method === "point_buy" ? pointBuyStatus(build.base_scores, rules) : null,
      background_abilities: background?.ability_scores ?? [],
      max_score_at_creation: catalog.creation.max_score_at_creation,
    },
  };
}

function encounterView(encounter: Encounter, party: Party, catalog: Catalog): EncounterView {
  const ctx = { catalog, characters: party };
  const conditionName = (id: string) => lookup(catalog.conditions, id)?.name ?? id;
  const ordered = [
    ...encounter.order,
    ...encounter.combatants.map((c) => c.id).filter((id) => !encounter.order.includes(id)),
  ];
  const combatants = ordered.flatMap((id): CombatantView[] => {
    const c = encounter.combatants.find((x) => x.id === id);
    if (!c) return [];
    const base = {
      id: c.id,
      name: c.name,
      side: c.side,
      monster: c.monster,
      character: c.character,
      initiative: c.initiative,
      defeated: c.defeated,
      position: c.position,
      used: c.used,
      inspiration: c.inspiration,
      decisions: c.decisions,
    };
    try {
      const view = encounterCombatant(encounter, c.id, ctx);
      const docs = c.character !== null ? party[c.character] : undefined;
      const play = docs ? computePlaySheet(docs.build, docs.state, catalog).play : null;
      return [
        {
          ...base,
          hp: view.hp,
          max_hp: view.max_hp,
          temp_hp: view.temp_hp,
          bloodied: view.bloodied,
          armor_class: view.armor_class,
          conditions: view.conditions.map((id) => ({ id, name: conditionName(id) })),
          concentration: play ? play.concentration : c.concentration,
          dying: play?.dying ?? false,
          dead: play?.dead ?? false,
          size: view.size,
          space: view.space,
          error: null,
        },
      ];
    } catch (error) {
      return [
        {
          ...base,
          hp: c.hp ?? 0,
          max_hp: 0,
          temp_hp: c.temp_hp,
          bloodied: false,
          armor_class: 0,
          conditions: c.conditions.map((id) => ({ id, name: conditionName(id) })),
          concentration: c.concentration,
          dying: false,
          dead: false,
          size: null,
          // The engine couldn't build its view: one square, so it still shows on the map.
          space: 1,
          error: error instanceof Error ? error.message : String(error),
        },
      ];
    }
  });
  const zones: ZoneView[] = encounter.zones.map((z) => ({
    id: z.id,
    label: z.label,
    by: z.by,
    squares: zoneSquaresOf(encounter, z, ctx),
    segments: z.segments,
    difficult: z.difficult,
  }));
  return {
    round: encounter.round,
    current: currentCombatant(encounter)?.id ?? null,
    combatants,
    zones,
  };
}
