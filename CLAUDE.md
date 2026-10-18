# SRD Table — Claude Guide

A browser app for 5th-edition play (SRD 5.2.1 rules): a character builder, a character sheet
for the table, and an encounter tracker with a grid map. **Every rule comes from the engine**
([`srd-rules-engine`](../srd-rules-engine), a separate repo); this app shows the engine's
documents and results and turns clicks into the engine's JSON actions.

Private repo. Milestones 1–5 are built (see "Milestones"); design decisions are in
`docs/ARCHITECTURE.md`, what the UI still needs from the engine in `docs/ENGINE-GAPS.md`.

## The one rule

**The UI never implements a rule.** It doesn't compute a modifier, check that an action is
legal, decide whose turn it is, roll a die, or rephrase a refusal. If the UI needs something the
engine doesn't give, the fix belongs in the engine (a new field, option or function), not in a
component; don't work around it with UI logic.

**This repo's sessions never change engine code.** Write the need as a requirement (what to
implement, acceptance criteria, SRD references) in the engine's `docs/REQUESTS.md` (git-ignored
there via `.git/info/exclude`) with an id `R<n>`; the engine's own Claude Code session implements
it. Track the same id in `docs/ENGINE-GAPS.md`, in the app's terms: what the app does meanwhile,
where the fallback lives, what to change once it lands. Reading the engine is fine. The engine
session answers in its `docs/RESPONSES.md` (and a `Request: R<n>` commit trailer, maybe a
`SendMessage` nudge): read it at the start of a session and before engine-dependent work (the
protocol is in `../CLAUDE.md`).

Corollaries:

- Legality comes from the engine: builder options carry `unavailable` (the reason), level-ups
  carry `unavailable`, combat options carry `available` + `reason` (`combatantOptions`), and
  anything else is asked with `checkAction` (a dry run). Disable a control and show the reason
  verbatim; never hide an option the engine lists.
- Numbers come with their explanation (`explainStat`, `contributions`): show them on hover/tap
  (`AC 17 = 16 Chain Mail + 1 Defense`). Notes returned by setters and actions (`notes`) are
  shown to the user (toasts for setters, the combat log for encounters).
- Engine strings are displayed, never parsed. If the UI needs to branch on something, it
  needs a structured field from the engine (an engine gap).
- **Never automate a choice the rules give a player or the GM.** Decisions after a roll
  (Bardic Inspiration, Legendary Resistance, Uncanny Dodge, forced zone saves) use the
  encounter's `decisions: "ask"` for player-controlled combatants: the action stops with
  `encounter.pending`, the UI shows the roll and the question, and answers with
  `{ type: "decide", use }`. The engine's `recommended` answer may be pre-selected, never applied
  silently. `auto` is opt-in per combatant (a setting), as the engine allows.

## Stack

- **Vite + React 19 + TypeScript** (strict, `noUncheckedIndexedAccess`, ESM), a static SPA: no
  SSR (no SEO, all data is local), deployable to any static host.
- **Biome** (lint + format, same settings as the engine), **vitest** + Testing Library for unit
  and component tests, **Playwright** for end-to-end flows.
- **TanStack Router** (typed routes and search params), **TanStack Query** for engine results
  (async, cached by document, cancellable), **Zustand** for the open documents and UI state.
- **Comlink** to run the engine in a Web Worker.
- **Tailwind CSS v4** + **Radix UI** primitives (dialogs, popovers, tooltips, menus: accessible
  by default) for the components.
- **idb** (IndexedDB) for local persistence.
- Map: **SVG** rendered by React first (hit-testing, accessibility and styling for free at
  typical encounter sizes); move to a canvas renderer (PixiJS) only if profiling demands it.
- Zod (the engine's own schemas) for every document read from storage, files or the network.

Keep runtime dependencies to this list; adding one needs a reason recorded in
`docs/ARCHITECTURE.md` (already there: `@tanstack/react-virtual`, `@fontsource/*`, `zod` direct).

## Architecture

```
┌──────────── main thread ─────────────┐        ┌────────── engine worker ──────────┐
│ routes / components (React)          │        │ catalog (packs layered, frozen)   │
│   ↑ derived views (TanStack Query)   │ Comlink│ rng (one instance, seeded)        │
│   ↑ documents (Zustand store)        │◄──────►│ engine facade: evaluate, setters, │
│   ↓ persistence (IndexedDB)          │  JSON  │ applyAction, applyEncounterAction,│
└──────────────────────────────────────┘        │ combatantOptions, checkAction…    │
                                                └───────────────────────────────────┘
```

### Documents are the state

The engine has three saved documents, plain JSON with a `version`: a **build**
(`CharacterBuild`: the player's choices only), a **play state** (`CharacterState`: what's spent
or chosen at the table) and an **encounter** (`Encounter`: monsters inside, characters by key).
They are the app's only persistent state.

- Store documents exactly as the engine returns them; **never store derived data** (sheets,
  options, evaluations). Derived views are recomputed from documents + catalog.
- Every load (IndexedDB, imported file, URL) goes through `parseBuild` / `parseState` /
  `parseEncounter`, which validate and migrate older versions. Persist the migrated result.
- Documents change only through the engine: builder setters (`builder.setChoice`, `levelUp`,
  `setLevelClass`…; they return `{ build, notes }` or throw `BuildError`), `applyAction`
  (`PlayError`) and `applyEncounterAction` (`EncounterError`). The store holds the result; it
  has no reducers of its own.
- Undo/redo is a stack of previous documents per open document (they're immutable and small).
- A character is `{ build, state }`; an encounter refers to characters by key, and the
  character states it changes come back in `states`, which the store writes back.
- File export/import is the documents' JSON, so the CLI (`srd-rules play --load`) and the app
  can open each other's files.

### The engine runs in a worker

`src/engine/` is the only place that imports `srd-rules-engine`'s functions (types may be
imported anywhere). It exposes an async **facade** whose methods mirror the engine's operations
and HTTP routes (`evaluate`, `setChoice`, `levelUp`, `previewChange`, `applyPlayAction`,
`applyEncounterAction`, `combatantOptions`, `checkAction`…). Documents cross the boundary as
structured clones; the catalog never leaves the worker.

- Why a worker: catalog creation parses packs with Zod, `evaluate` resolves a whole build and
  `combatantOptions` dry-runs every option; none of it should block input or the map.
- The facade has one implementation over Comlink and an in-process one for tests. A third one
  over the HTTP API (`createHandler` routes) is possible later for a server-authoritative mode;
  keep facade signatures JSON-in/JSON-out so that stays a drop-in.
- Errors: the facade turns `BuildError` / `PlayError` / `EncounterError` into a typed
  `{ ok: false, reasons: string[] }` result (exceptions don't survive `postMessage` with their
  class); components render the reasons.
- Derived views are TanStack Query queries keyed by the document's identity (a revision counter
  in the store, not a deep hash). Compute `combatantOptions` only for the combatant on screen.

### Content: packs loaded by table

The engine publishes the SRD split by table (`srd-rules-engine/srd-5.2.1/manifest.json` +
`<table>.json`), read with `loadPack(fetchJson, { tables })` and layered with
`createCatalog(packs, { tables, sources })`. The main entry has no bundled data; never import
`srd-rules-engine/srd` (the whole SRD as one module) in browser code.

- A build step (`scripts/copy-content.ts`, run by `predev`/`prebuild`) copies the split SRD
  from `node_modules/srd-rules-engine/dist/srd-5.2.1/` to `public/content/srd-5.2.1/`; the
  worker fetches it (HTTP-cached; a service worker can precache it for offline use later).
- Load tables by need: `CORE_TABLES` for the builder, plus `spells` for a caster, `magic_items`
  for play, `monsters` for encounters. A table left out throws `ContentError` on any read, so a
  missing table is a loud bug, not a silent `undefined`. The worker rebuilds the catalog with
  more tables when a screen needs them.
- **More packs.** Homebrew and private packs are layered after the SRD in the order the
  campaign says. A pack is compiled to the same split JSON (the engine's `splitPack`) by a
  script, never by copying SRD entities. Packs that aren't SRD stay out of this repo's git
  (`content/private/` is git-ignored) and out of any public deployment.
- **Campaign settings** (allowed `sources`, packs, decision modes) are their own small
  document in IndexedDB. A build records the packs it needs (`build.packs`); opening one with a
  pack missing shows the engine's validation error, and importing one is refused before anything
  is written (as is a state the import would change: `importCharacter`, ENGINE-GAPS "Import
  safety").
- Look up catalog entities with `lookup(table, id)`, as in the engine.

### Dice

The UI never rolls. The worker holds one `Rng`, seeded from `crypto.getRandomValues` at startup
(a dev setting fixes the seed, so a bug can be replayed). Results carry their rolls
(`rolls`, `result`, damage `parts`): a dice animation, if any, shows those numbers after the
fact. A "roll" button calls the engine through the facade (the encounter's `check` action, or
`roll(expression, rng)` for a free roll), never `Math.random()`.

## Look and layout

The layout and UX follow the aprutium-tavolo VTT; the look is **Mat and Marker**, taken from the
things on a real game table. The light theme, **Mat**, is the wet-erase battle mat with index
cards on it; the dark one, **Felt**, is a card table's green felt for a dim room; the default
follows the device. Each marker colour has one meaning everywhere (rail, map, log): **red** foes,
damage and harmful areas; **blue** allies, the main action, the selection; **green** healing and
what's still there; **purple** magic (zones, Concentration, rituals); **orange** what still needs
doing (missing picks, pending decisions, warnings). The **highlighter** (`.hl`, `bg-hl`) marks
only whose turn it is and what's chosen (the active tab, a lit button); don't spend it on
anything else.

- Buttons (`.btn`, `Button`) by weight: `primary` (blue fill: the one action that moves things
  on), `normal` (outlined card), `danger` (red line), `ghost` (quiet). Disabled stays readable
  (dashed outline, never faded) and an engine reason is shown next to it, not only on hover.
- Shapes from the paper sheet and the table: slots and uses are tick boxes (`.tick`, ticked
  through when spent), proficiency is a bubble (`.bubble`: empty, filled, ringed for Expertise),
  an action's cost is a pip (`.pip`: ● Action, ○ Bonus Action, ▲ Reaction, ◆ others),
  conditions are rings, an Initiative entry is an index card with a stripe in its side's colour.
  Sides are coloured by `alliedSides` (`features/encounter/tableUi.ts`): the party's sides blue.
- Type: one family, Atkinson Hyperlegible Next (self-hosted), drawn to tell 1/l/I and 0/O/8
  apart; names, headings and numbers in bold, sentence case, no small caps or tracked capitals;
  text never below 13 px. Icons are line drawings (`components/Icon.tsx`), never font glyphs.
- Colors are CSS variables in `src/styles.css` mapped to Tailwind tokens (`bg-card`, `text-ink`,
  `border-edge`, `stroke-grid`, `text-red`…); components use the tokens, never raw colors (the
  map's SVG too: `fill-…`/`stroke-…` classes).
- The encounter screen is the "table": the Initiative rail on the left, the map with its tool
  strip in the middle and the quick bar of options (tiles grouped by cost: Action, Bonus Action,
  Reaction, Free, Legendary, ★ favourites) below it, the GM's combat controls, the selection and
  the combat log on the right. Below 1024 px it stacks.
- Dice: the UI shows the engine's rolls in the dice tray (`components/DiceTray.tsx`) for a few
  seconds; 3D dice (dice-box-threejs, predetermined results) can replace it later.

### Language

The app's own words live in `src/i18n/en.ts` and are read with `t()` / `tn()` (never write UI text
in a component), in English and Italian (`it.ts`, typed `Messages`, so a missing key fails the
typecheck; the Italian terms are the Italian 5th-edition books'); another language is one more
catalog. Settings > Language picks it; a change remounts the app (`App.tsx`). Engine texts are
rendered from their `messages` (codes and parameters) in the app's language, in the worker
(`src/engine/messages.ts`, catalogs in `src/i18n/engine/`); stored documents keep the English.

## Screens

- **Top bar** — Table and Characters open a document, not their list: a player's own sheet
  and the most recent table their character is in; for the GM, the table and the character
  opened last (remembered per viewer in the browser, `routes/paneTargets.ts`); the list when
  there's nothing to open. Opening the app (`/`) goes to that table, else that character, else
  the characters list. Each document page links back to its list (`BackLink`).
- **Characters** — list, create, import (files or a URL, with everything they need, previewed
  first: `src/import/`, docs/ARCHITECTURE.md "Import by URL or files") and export (JSON, or a
  transfer with its content's identity), duplicate.
- **Builder** — the engine's step order (Class, Species, Background, Ability Scores, Equipment,
  Features, Spells, Skills & Tools, Languages, Name & Alignment), free navigation between steps,
  each step's missing picks from `issuesForStep`, options with their `unavailable` reason
  greyed out. A live summary (HP, AC, Initiative, Speed, Passive Perception) from the sheet.
  Level-up from `levelUpOptions` (fixed or rolled HP), the level's choices from
  `choicesForLevel`, optional replacements (`#replace:` choices). Editing the past: pick a level,
  change its class, HP or any choice; always show `previewChange` (what's removed and asked
  again) before applying.
- **Sheet / play** — `computePlaySheet` with explanations on every number; play actions as
  controls (damage and healing, rests with Hit Dice, slots, limited uses, toggles like Rage,
  conditions and Exhaustion, Concentration, inventory, attunement, coins, today's prepared
  spells). `reconcileState` after the build changes, with its notes shown.
- **Encounter** — Initiative order with HP, AC, conditions and Concentration; whose turn it is
  and what it has spent; the current combatant's `combatantOptions` as grouped buttons (attacks,
  spells with slot levels, features, standard actions, legendary actions, zones), each disabled
  with its reason; target picking from the option's `TargetSpec`; a combat log of `notes`;
  pending decisions as a modal that shows the roll. GM controls (add monsters, set Initiative,
  effects by hand, `set_decisions`) are separate from a player's controls.
- **Map** (in the encounter) — 5-foot grid, tokens sized by creature size, `place`/`move`
  (the path drawn square by square from `previewMove`), reach and range
  highlighted from the option's targets, area templates aimed with `{ point }` / `{ toward }`,
  zones drawn from `encounter.zones`, walls and Difficult Terrain from `encounter.map` (GM tools:
  `add_wall`, `remove_wall`, `set_terrain`); cover comes from the engine's map, or the GM's input
  per attack.
- **Exploration** (the encounter outside a fight) — characters move freely, the map shows how
  many turns a move takes (`previewMove`'s `turns`), Search; the GM's travel pace and "who stops
  when someone notices something" (`set_exploration`), halts answered by reveal or `resume`.
  Points of interest (`encounter.points`): the GM places and edits them (Points tool), players
  see only revealed ones; noticing is the engine's.
- **Compendium** — browse catalog tables (spells, monsters, items, feats) with the SRD text.
- **Settings** — campaign sources and packs, decision modes, theme, dev seed.

## Project layout

```
src/
  engine/        # the only importer of engine functions: worker.ts (Comlink expose),
                 #   facade.ts (types + in-process impl), client.ts (Comlink wrap), content.ts
  store/         # Zustand stores: documents (characters, encounters, campaign), undo stacks
  persistence/   # IndexedDB (idb): load → parse* → store; save on change (debounced)
  queries/       # TanStack Query hooks over the facade (useEvaluation, useSheet, useOptions…)
  routes/        # TanStack Router route tree: characters, builder, sheet, encounter, compendium
  features/      # screen-specific components: builder/, sheet/, encounter/, map/, compendium/
  components/    # shared UI (Radix-based): Explain (a number + its contributions), Reasons,
                 #   OptionButton, DiceTray, Toasts, SrdText, VirtualList, Icon, Portrait, ui.tsx
  i18n/          # the app's words (en.ts) and t()/tn()
  lib/           # small pure helpers (formatting and files only; no rules)
scripts/         # copy-content.ts (split SRD → public/); compile-pack.ts (YAML pack → split JSON) to come
public/content/  # GENERATED split packs (git-ignored)
content/private/ # private packs' sources (git-ignored)
tests/           # vitest unit/component tests (helpers/, fixtures/); e2e/ for Playwright
docs/            # ARCHITECTURE.md (decisions), ENGINE-GAPS.md (what the UI needs from the engine)
```

## Engine dependency

- While developing: `"srd-rules-engine": "file:../srd-rules-engine-main"`, a symlink to a
  `git worktree` of the engine detached at its `main` (the engine session works in
  `../srd-rules-engine`, on its own branches, and never touches it). The app consumes its
  **built** `dist/` through the package `exports`. The commit is pinned: `ENGINE_COMMIT` in
  `scripts/engine-pin.ts`. `npm run engine:update` moves the worktree to it, runs `npm ci`,
  builds `dist/`, verifies and copies the content; `npm run engine:verify` checks the worktree is
  that commit, clean and built, and prints a hash of `dist/` (record it with a build). Moving to a
  newer engine is a change of `ENGINE_COMMIT`, never `main`. Later: a GitHub tag or npm version.
- Vite: allow that folder (`server.fs.allow`) and `resolve.dedupe: ["zod"]`, so the app and the
  engine share one Zod.
- Needs an engine with the options API (`combatantOptions`, `checkAction`) and the content
  split (`srd-rules-engine/srd` entry, per-table assets, `loadPack`, `createCatalog`'s
  `tables`).
- The engine is 0.x: its API can change between minors, saved documents are always migrated.
  Read its CHANGELOG when bumping; type errors after a bump are the checklist.
- Use the engine's types (`CharacterBuild`, `CombatantOptions`, `EncounterAction`, …) instead
  of redeclaring them. Its JSON Schemas (`srd-rules-engine/schemas/*`) are for non-TS tools.
- Engine docs to read before touching an area: `../srd-rules-engine/README.md` (usage),
  `docs/ARCHITECTURE.md` (documents, actions, encounters, options, interpretations).

## Conventions

- Documents and engine payloads are snake_case (the engine's wire format); app code is
  camelCase. Don't rename engine fields in the store.
- Components never call the facade directly: they use query hooks (reads) and store actions
  (writes, which call the facade and commit the returned document).
- A refused action leaves the document untouched and shows the reasons where the user acted.
- Long lists (spells, monsters, items) are virtualized; search is client-side over the loaded
  table.
- Accessibility: keyboard-reachable controls, visible focus, a disabled option's reason
  available to screen readers (not only as a hover tooltip), map actions also reachable without
  the map (target lists).
- Responsive: the sheet and the player's encounter controls work on a phone; the GM's encounter
  view and the map target a laptop or tablet.
- SRD text shown in the app keeps the CC-BY-4.0 attribution (an About page, as in the engine's
  README). Content that isn't SRD never ships in a public build.

## Tests

- Unit and component tests run against the in-process facade with the real SRD (loaded by
  table from the engine package) and `seededRng` / `scriptedRng`, so outcomes are fixed.
- Test that the UI wires the engine correctly (the right action sent, the returned document
  stored, reasons and notes shown), not the rules themselves: those are the engine's tests.
- Playwright: create a level 1 character through every builder step; level up to 3 with a
  subclass; take damage and rest in play; run a short encounter with an `ask` decision; reload
  and find everything restored from IndexedDB.

## Milestones

1. **Scaffold** — Vite app, Biome, vitest, Playwright, the engine worker + facade, content copy
   and table loading, IndexedDB persistence with `parse*`, import/export.
2. **Builder** — every step, level-ups, replacements, editing the past with previews.
3. **Sheet and play** — the play sheet with explanations, every play action.
4. **Encounter tracker** — Initiative, turns, options as buttons, targets, decisions, combat
   log, GM controls; no map.
5. **Map** — positions, movement, reach/range, areas and zones; walls, terrain and cover when
   the engine's map model lands.
6. **Later** — offline (service worker precache), shared sessions (one authority applies
   actions — the GM's client or a server running the engine's `createHandler` — and others
   receive documents), private packs managed in the app.
   - **Manual play** (redesigned 2026-10-10, see "Manual play" in `docs/ARCHITECTURE.md`):
     each action played automatically, or by hand as a dice roller (the engine rolls what's
     declared, no target, no outcome; resources spent, not the action economy); a default per
     combatant; whoever is affected applies the result (the GM for anyone, a player for their own
     character); the GM can override a refusal ("Do it anyway", R17). Built (R21–R23),
     on the sheet too.

## Commands

```bash
npm run dev          # copy content, start Vite
npm test             # vitest
npm run e2e          # Playwright
npm run check        # lint + typecheck + tests (CI)
npm run build        # static build in dist/
npm run content      # copy the engine's split SRD to public/content/ (run by dev/build/e2e)
```

- `src/engine/` is also the only place that imports engine **values**: lists and names (abilities,
  skills, damage types, alignments, steps) come from the facade's `constants()`, loaded at startup
  (`src/engine/constants.ts`), so no engine code runs on the main thread.
- A Zustand selector must return a stable value (never a fresh `[]`/`{}` fallback): Zustand 5
  re-renders forever otherwise.
- Tests: `installTestEngine(seed)` and `renderApp(path)` in `tests/helpers/app.tsx`; complete
  characters from `tests/fixtures/characters.ts`.
