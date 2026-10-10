# Architecture

How the app is built and why. The rules are the engine's ([`srd-rules-engine`](../../srd-rules-engine));
what the UI needs from it and doesn't get is in [ENGINE-GAPS.md](ENGINE-GAPS.md). The plan and the
conventions are in [CLAUDE.md](../CLAUDE.md).

## Layers

```
routes (TanStack Router) → features/* (screens) → components/* (shared UI)
            │ reads                                   │ writes
            ▼                                         ▼
     queries/ (TanStack Query)                 store/ (Zustand: documents, settings, ui)
            │                                         │
            └──────────────► engine/client.ts ◄───────┘
                                   │ Comlink
                          engine/worker.ts → engine/facade.ts → srd-rules-engine
```

- `src/engine/` is the only place that imports engine **functions**. Elsewhere the app imports
  engine **types** and a few **constants** that are data (`ABILITIES`, `ABILITY_NAMES`, `SKILLS`,
  `skillName`, `DAMAGE_TYPES`, `STEPS`, `ALIGNMENTS`, `MAX_ATTUNED`): lists to iterate and names to
  show, never rules.
- Components never call the facade: reads are query hooks (`src/queries`), writes are store
  actions (`src/store`), which call the facade and commit what it returns.

## The facade (`src/engine/facade.ts`)

One interface, `EngineFacade`, JSON in and JSON out; `createInProcessFacade` implements it over
the engine. The worker exposes it with Comlink; tests use it directly (`src/engine/node.ts` loads
the split SRD from the engine package on disk). An HTTP implementation over the engine's
`createHandler` routes would be a drop-in.

- **Results.** A refused setter or action comes back as `{ ok: false, reasons }` (the engine's
  `BuildError` / `PlayError` / `EncounterError` messages, a Zod error prettified, or a
  `RangeError`'s message): exceptions don't survive `postMessage` with their class.
- **Views.** `evaluate` returns a `Resolution` (a class with methods), so the facade shapes it as
  `BuildView`, as the engine's `/v1/builds/evaluate` route does, plus each step's issues and
  completeness, each level's, the ability-score status (`pointBuyStatus`) and each choice's
  `rest_change`. `encounterView` turns each combatant into a `CombatantView` (HP, AC, conditions,
  Concentration, dying) with `encounterCombatant` and the play sheet, and each zone into squares.
- **Edits.** Builder setters are one `editBuild(build, edit)` with a `BuildEdit` union, so
  `previewEdit` can run any edit through `previewChange`.
- **Lists of actions.** `applyPlayAction` and `applyEncounterAction` take one action or a list,
  all or nothing; an encounter list stops at a decision (`pending`, `applied`), like the HTTP route.
  Each encounter action's rolls (`result`) are returned for the dice display.

### Content by table (`src/engine/content.ts`)

`scripts/copy-content.ts` copies the engine's split SRD to `public/content/srd-5.2.1/`; the
worker fetches files with `loadPack` and caches them (each file is fetched once). Operations run
in a **tier** of table sets: the builder starts with `CORE_TABLES`, then adds `spells`, then
everything; play starts with spells and magic items; encounters load every table. When an
operation reads a table that isn't loaded, the engine throws `ContentError`, and the loader runs
it again with the tier's next set. The Compendium loads exactly the table it shows. No engine
message is parsed for this.

Packs after the SRD are served from `content/<id>/` in the same split format (the engine's
`splitPack`); `content/private/` is git-ignored, and non-SRD packs never ship in a public build.

## Documents and the store (`src/store/documents.ts`)

- A character record is `{ id, build, state, created, updated }`; an encounter record is
  `{ id, name, encounter, log, created, updated }`. `build`, `state` and `encounter` are exactly
  the engine's documents. The record id is the character's key in encounters.
- Every write is `serial` per document (a promise queue), so fast clicks never apply an action to
  a stale copy.
- After a build changes, the store runs `reconcileState` and stores both, showing the setter's and
  the reconcile's notes as toasts.
- An encounter action is sent with its **party**: the characters its combatants refer to, plus
  those an `add_character` brings in. Character states it changed come back in `states` and are
  written to their records.
- **Undo/redo**: a stack of previous documents per document id. An encounter's snapshot also
  keeps its party's states, so undoing an attack restores the target's HP.
- **Revisions**: a counter per document id, bumped on every commit; query keys use it (plus the
  revisions of an encounter's characters, and the content settings).
- **The combat log** (notes per action, decisions asked) is kept with the encounter record: it's
  history, not derived data. It's capped at 500 entries.

## Persistence (`src/persistence/`)

IndexedDB through `idb`, one database with four stores: `characters`, `encounters`, `settings`
(the campaign settings document) and `portraits`.

- `loadAll` reads every record and passes each document through the engine's `parseBuild` /
  `parseState` / `parseEncounter` (validation and migration), then writes the migrated result
  back. A record that doesn't parse stays in the database untouched and is reported in a toast.
- `startAutosave` subscribes to the stores and writes changed or deleted records (debounced
  300 ms, flushed on `pagehide`).
- **Portraits** are an exception to "documents are the only persistent state": images players
  upload (the SRD has no art), scaled down to 512 px and kept as blobs by character id. They're
  never part of a document or an export.

## Screens

- **Characters**: list, create, import (a build `.json`, optionally with its `.state.json`, the
  CLI's names), export, duplicate, delete.
- **Builder**: the engine's steps with free navigation and each step's issues; every option the
  engine lists, greyed with its reason; the live summary with explanations. Every edit goes
  through `previewEdit`; when it would remove other picks (or, for a past level, ask new
  questions) the player confirms first. Levels: level up (fixed or a Hit Die rolled by the
  engine), remove the last level, a past level's class (with preview), Hit Points and choices,
  replacements `[old, new]`. Background bonuses are one pattern, so they're picked together and
  applied with one setter call.
- **Sheet**: `computePlaySheet` with explanations; HP, death saves, conditions, Exhaustion,
  Concentration, Heroic Inspiration; rests (Hit Point Dice rolled by the engine); attacks, features
  used in turns, toggles, limited uses, Hit Dice; spellcasting and slots; inventory (equip,
  attune, use, charges, add from the catalog, buy and sell at SRD prices), coins; features and traits; today's picks for
  choices changed after a rest.
- **Encounter**: the Initiative rail, the map, the quick bar of `combatantOptions` grouped by cost
  (Action, Bonus Action, Reaction, Free, Legendary, ★ favourites), the composer, decisions, GM
  controls, the selection panel, the combat log.
- **Compendium**: three columns, search in the loaded table, stat blocks and SRD tables.
- **Settings**: packs and sources, decision modes for new combatants, theme, a dev dice seed.
- **About**: the SRD's CC-BY-4.0 attribution (also in the footer of every screen).

### The encounter screen

- The **view switch** (GM or a player) is per browser. The GM acts for anyone; a player acts for
  their own character only (reactions too, on others' turns) and doesn't see monsters' HP numbers.
  Shared sessions (one authority applying actions) are a later milestone.
- **Options are tiles**: one per entry of `combatantOptions`, never hidden; an unavailable one is
  greyed, still focusable, with the engine's reason in a tooltip and in `aria-describedby`. The
  engine's `odds` (chance to hit or that the save fails, average damage) are shown with each.
- **The composer** starts from the option's ready-to-send action and fills only what the player
  picks: targets (from `TargetSpec`, also by clicking tokens), slot level or Pact slot, an area's
  point or direction (aimed on the map; the engine's `previewArea` shows its squares and the
  creatures in it with their cover), a wall spell's ends, a skill and DC for Search, Study and
  Influence, a trigger and readied action for Ready, Advantage or
  Disadvantage, riders and two-handed damage (from the character's attack line), cover, a damage
  type the spell offers, creatures a zone spares. `checkAction` dry-runs the result and shows the
  engine's reason before sending. It's a panel, not a modal, so the map stays usable.
- **Decisions** (`encounter.pending`) open a dialog for whoever controls that combatant, with the
  question (it shows the roll) and the engine's recommendation pre-selected, never applied on its
  own. Settings default both characters and monsters to `ask`; `auto` is opt-in per combatant
  (`set_decisions`) or per encounter.
- **The map** is SVG: a 5-foot grid, the encounter map's walls, Difficult Terrain and blocked
  squares (GM tools send `add_wall`, `remove_wall`, `set_terrain`), zones, tokens, reach or range
  of the option being composed (`gridDistance`), an aimed area, wall spells' segments, measuring
  and pings. With the Move tool, the engine's `reachableSquares` are lit and hovering a square
  draws `previewMove`'s path with its cost, zones and Opportunity Attacks. Clicks become `place`
  and `move` with `to`; the engine decides. Everything on the map is also reachable without
  it (target lists, the selection panel).
- **Exploring** is the encounter outside a fight (`round: 0`, before Start and after End): the
  quick bar gives way to the exploration bar (`ExplorationPanel`). Moves have no limit; the Move
  tool's hint is `previewMove`'s `turns` ("65 ft: 3 turns at its Speed") and no reachable
  squares are lit. The acting character can Search; the GM sets the travel `pace` and
  `notice_stops` (who stops when someone notices a point: a GM setting, both readings being
  table styles) with `set_exploration`, and answers a halt by revealing the point or `resume`.
- **Points of interest** are the encounter's `points`: the GM's Points tool opens
  `PointDialog` on a square (`add_point`; `update_point` to edit), markers show the kind's
  icon (hidden ones dashed and only to the GM, an orange ring once a character noticed one),
  and `PointPanel` shows the open point (its text to everyone once revealed; notes, DC, who
  noticed it, reveal/hide and remove to the GM). Noticing is the engine's (Passive Perception
  with the pace, line of sight, Search); the UI never reveals a point by itself.

## Dice

The UI never rolls. Encounter results carry their rolls; free rolls (`roll`), damage rolls
(`rollDamage`), ability score pools (`rollAbilityScores`) and Hit Dice for a level-up go through
the facade, which uses the worker's one `Rng` (seeded from `crypto.getRandomValues`, or the dev
seed). The **dice tray** (`components/DiceTray.tsx`) shows each result as text for seven seconds:
it's the stub for 3D dice, which can replace `DiceCard` and animate the same numbers after the
fact (dice-box-threejs accepts predetermined results).

## Manual play

Redesigned 2026-10-10 by the app's owner (the first design, with an outcome step and dice
entered at the table, was built and then dropped). The UI still implements no rule: rolls,
resources and every state change go through the engine.

**Two ways to play an action.** The quick bar has a Play switch (Automatic / By hand) that
starts on the acting combatant's way and lasts until the turn changes; tiles are sent that way.
The composer sends the switch's way with its main button and offers the other way next to it.
Actions the engine doesn't take by hand (Dash, a check, zones) are sent as they are.

- **Automatic**: the engine rolls and resolves, as always.
- **Manual** (semi-automatic, like a virtual tabletop's roller): the player declares what they
  use and the engine rolls it (attack rolls, damage, healing; a save effect's DC is shown)
  with **no target and no outcome**. Resources are spent (spell slots, feature and item uses, a
  monster's 1/Day and Recharge, Concentration started); the **action economy isn't** (Action,
  Bonus Action, Reaction, attacks per turn), so an attack can be rolled as often as the table
  likes. Nothing else changes (engine R21). A by-hand tile is sent at once; the composer opens
  only for what the engine still reads by hand (a slot level, Advantage, riders, strike effects,
  a damage type) or to show a refusal. The options' availability is still the automatic way's,
  so by-hand tiles aren't greyed out until the engine judges them by hand (R22).

**Applying what happened.** Whoever is affected applies it with the usual controls: the GM for
anyone (the selection panel's damage, healing and conditions: the encounter's `effects`, so
Resistance, Concentration saves and HP limits stay the engine's), a player for their own
character (the same controls in the selection panel, and anything on the sheet: HP, conditions,
equipment, inventory, slots). There's no outcome queue.

**The default way, per combatant.** Campaign settings give a default for characters and one for
monsters (like the decision modes); the GM changes it per combatant in the encounter (selection
panel; the record's `modes`). Each action can still be played the other way.

**GM override.** A refused option shows "Do it anyway" in the GM's view only: the engine applies
the action despite the refusal and the log marks it as an override. Players never see it. A
GM's click on an unavailable tile opens the composer; the button shows only when the engine's
dry run with `force` passes (the app never decides which refusals can be forced).

**Dropped.** Dice rolled at the table (R16: every roll waiting for entered numbers) and the GM's
"Waiting for an outcome" list: the owner found them useless once players apply their own results.

## Look and language

- **Look**: "Mat and Marker" (2026-10-07), replacing the first night-blue-and-gold look: the
  layout and UX stay those of the aprutium-tavolo VTT, the style comes from a real game table.
  Mat (light: the wet-erase battle mat, index cards) and Felt (dark: card-table felt) themes, and
  `system` follows the device (the CSS falls back on `prefers-color-scheme`; older settings'
  `parchment`/`night` read as `mat`/`felt`). Gold had become every accent at once (titles,
  names, the turn, chosen buttons, proficiency) and the diamond every marker, so neither said
  anything; now each marker colour has one meaning (red foes and damage, blue allies and the main
  action, green healing, purple magic, orange to-do) and the highlighter marks only the turn and
  what's chosen. Colors are CSS variables mapped to Tailwind tokens (`bg-card`, `text-ink`…) in
  `src/styles.css`; components use the tokens, never raw colors. Shared pieces: `.btn` (primary,
  normal, danger; disabled stays readable), `.section-title`, `.tick` (slots and uses),
  `.bubble` (proficiency), `.pip` (an action's cost), `.hl` (the highlighter).
- **Fonts**: one family, Atkinson Hyperlegible Next (400–800), self-hosted through `@fontsource`:
  designed for legibility, it keeps 1/l/I and 0/O/8 apart for numbers read across the table.
  Cormorant's thin strokes were the weakest part of the HP display. Text never goes below 13 px.
- **Icons**: line drawings in `components/Icon.tsx` (24×24, stroke 1.8), never font glyphs.
- **Language**: the app's words are in `src/i18n/en.ts` (`t`, `tn` with `Intl.PluralRules`,
  `Intl.NumberFormat`, `Intl.ListFormat`), in English and Italian (`it.ts`); another language is
  one more catalog, listed in `LOCALES`. The language is a setting (`settings.locale`); a change
  remounts the tree under a `key`, since `t()` isn't reactive. Distances and weights stay in the
  engine's units (feet, pounds). The SRD's license notice stays in English.
- **Engine texts in the app's language**: the worker renders them (`src/engine/messages.ts`):
  `localize` swaps every text that has a message twin (`notes`/`messages`,
  `reasons`/`reason_messages`, `unavailable`/`unavailable_message`, an issue's `message`/`detail`…)
  in every facade result except documents; `renderMessages` renders stored ones (the log, a
  pending question). Catalogs: `src/i18n/engine/<locale>.ts` (every `MessageCode`, typechecked)
  registered in `ENGINE_LANGUAGES`. Content (spell, feature, condition names) stays English.
  **Adding a language:** `src/i18n/<locale>.ts` (app words, typed `Messages`), an entry in
  `LOCALES`, `src/i18n/engine/<locale>.ts` + `ENGINE_LANGUAGES`; the tests check every template
  parses and keeps every parameter. Plural forms follow the language pack's `locale`
  (`Intl.PluralRules`); list joiners, step titles, alignments and stat labels are catalog codes
  too (`list.*`, `step.*`, `alignment.*`, `stat.*`). Engine strings
  stay as the engine gives them; their `messages` (codes and parameters) are what a
  translation will render (R13 in ENGINE-GAPS.md).

## Dependencies

The runtime list of CLAUDE.md, plus these, each for a reason:

| Package | Why |
|---|---|
| `@tanstack/react-virtual` | Long lists are virtualized (spells, monsters, items, the Compendium); same family as Router and Query, no styles. |
| `@fontsource/atkinson-hyperlegible-next` | Self-hosted font (offline use, no third-party requests). Only CSS and font files. |
| `zod` (direct) | The engine's own Zod (deduplicated by Vite): the worker uses `z.prettifyError` to turn a document that doesn't parse into readable reasons. |

Radix UI comes as the single `radix-ui` package.

## Routing

Code-based TanStack Router routes (`src/routes/router.tsx`), fully typed, with validated search
params (`?step=`, `?level=`, `?tab=`, `?table=&id=&q=`). Hash history, so the static build works on
any host without rewrite rules.

## Testing

- Unit and component tests (vitest, jsdom, fake-indexeddb) install the in-process facade over the
  real SRD (`setEngine(nodeFacade({ seed }))`), so outcomes are fixed. They test the wiring: the
  action sent, the document stored, reasons and notes shown.
- `tests/fixtures/characters.ts` builds complete characters through the facade (the engine's own
  setters, first available options).
- Playwright (`tests/e2e/`) runs the production build: the builder end to end, level-ups, play,
  an encounter with an `ask` decision, and a reload restoring everything from IndexedDB.
