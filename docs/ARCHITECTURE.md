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

**A served pack is read whole once per session** (`SessionPacks`: the manifest and every table it
lists), so a table never opened before, or a catalog rebuilt later, needs no network: the app keeps
playing when the host goes away (not a restart offline: nothing is precached). The SRD read this way
is also kept in IndexedDB (`packs`, `origin: bundled`, see Persistence); a worker started while the
host can't serve it uses that copy (for pinned documents and the campaign's catalog alike).

**Content per document (kenli F-008).** A record can be pinned to exact packs (`content`: a
`ContentContext`, each pack by id, version and SHA-256 of its split files). `ContentRegistry` keeps
the campaign's loader (Settings, for records without `content`) and one loader per exact context
(least recently used ones let go, eight at most, never one in use), so two versions of a pack never
meet in one catalog. Imported packs are registered with the worker by their files and verified
hash (`registerPacks`); the SRD the app serves is used for a context when its hash is the one the
context names (`servedPack`). An unknown pack is refused (`context_unavailable`), never replaced by
the campaign's. Every catalog-dependent facade method takes an optional `content` (a document's);
encounter methods take the encounter's (`world`) and each character's own (`CharacterDocs.content`),
and the engine judges each combatant with its catalog (`CharacterRef.catalog`, engine `68da318`);
a character without `content` plays on the campaign's packs. The facade carries the whole reference
between the actions of a list (`{ ...ref, state }`).

On screen, every catalog lookup (`useTable`, `useEntry`, `useNames`, `useMagicItemBases`) is made in
its document's content: a sheet's and a builder's in their character's (`CharacterScope`, and the
sheet's tabs name their character explicitly), an encounter's in its world (`ContentScope`), the
action composer and the effects form in the acting combatant's character, else the world
(`CombatantScope`). Only the Compendium and Settings stay on the campaign's. Query keys carry the
context, so two versions of one spell id never share a cached entry.

## Documents and the store (`src/store/documents.ts`)

- A character record is `{ id, build, state, created, updated }`; an encounter record is
  `{ id, name, encounter, log, created, updated }`. `build`, `state` and `encounter` are exactly
  the engine's documents. The record id is the character's key in encounters. Next to them (never
  inside): `rev` (+1 on every lasting change), `gen` (+1 when an import replaces the record),
  `content` (its packs, else the campaign's) and `origin` (where an import came from).
- Every write goes through its document's queue (`serialMany`), deletions, renames, undo and redo
  included; an encounter action takes the queues of the encounter and its party. Fast clicks never
  apply an action to a stale copy. An action asked for while an import holds a record's queue runs
  after it; aimed at a replaced version (another `gen`), it's refused with a message, never lost.
  A change's set of records is asked again when its turn comes (a character who joined the
  encounter meanwhile, the party of the undo step now on top): it lets go and queues again for the
  whole set, in order, so no two changes wait on each other; the generations it checks are those
  of every record when it was asked for. The write itself checks once more that what it read is
  what the store still has (never true with the queues; a stale result is never written).
- After a build changes, the store runs `reconcileState` and stores both, showing the setter's and
  the reconcile's notes as toasts.
- An encounter action is sent with its **party**: the characters its combatants refer to, plus
  those an `add_character` brings in. Character states it changed come back in `states` and are
  written to their records.
- **Undo/redo**: a stack of previous documents per document id. An encounter's snapshot also
  keeps its party's states, so undoing an attack restores the target's HP. A step is the whole
  record as it was: documents, `content` and `origin` (for an imported encounter also its name,
  log and modes), so undoing an import brings the old version back whole, a legacy record without
  a pin included. Every step is a new revision; one that changes `content` or `origin` is a new
  generation too (changes asked for the version it leaves are refused). A party member an import
  replaced after an encounter step keeps its own state when that step is undone.
- **Revisions**: a counter per document id, bumped on every commit; query keys use it (plus the
  revisions of an encounter's characters, and the content settings).
- **The combat log** (notes per action, decisions asked) is kept with the encounter record: it's
  history, not derived data. It's capped at 500 entries.

## Persistence (`src/persistence/`)

IndexedDB through `idb`, one database with five stores: `characters`, `encounters`, `settings`
(the campaign settings document), `portraits` and `packs` (version 2).

- `loadAll` reads every record and passes each document through the engine's `parseBuild` /
  `parseState` / `parseEncounter` (validation and migration), then writes the migrated result
  back. A record that doesn't parse stays in the database untouched and is reported in a toast.
- `startAutosave` subscribes to the stores and writes changed or deleted records (debounced
  300 ms, flushed on `pagehide`). Every write goes through one queue (`writeQueue`, imports too)
  and is a compare-and-set: the database must still hold the revision this tab last wrote or read.
  A record changed in another tab is never overwritten: it's no longer saved here, and a toast
  asks to reload. The saved baseline moves only once the transaction is done (a failed save is
  tried again). `loadAll` writes back a migrated document only when the parse changed it, with the
  same check.
- **Version 2** adds `packs` (imported packs, keyed `id@version#sha256`, written with `add` only,
  never changed). The upgrade only creates the store: no record is rewritten or given a pin; one
  without `content` plays on the campaign's packs as before. Another tab holding version 1 open
  blocks the upgrade (a toast asks to close it); an old tab asked to let go closes its connection.
  An installation id (`settings` key `installation`) names this Table in its exports.
- **The served SRD** is kept in `packs` as `origin: bundled` (`persistBundled`, after the start):
  the files the worker read and hashed, added once and never overwritten, its own transaction
  (never an import's). A full storage shows a toast and the app goes on with the copy in memory.
  `loadAll` registers it with the worker as the fallback for the served pack. Settings lists it
  among the packs on this device ("served with the app").

## Import by URL or files (`src/import/`, kenli F-008)

One path for a URL and for files (`features/import/ImportDialog.tsx`), the format of the kenli
F-008 contract (`srd-table.transfer/1`: the engine's documents unchanged in a small envelope with
exact content identities; `srd-table.library-pointer/1` for a library's stable URLs).

1. **Fetch** (`fetch.ts`): HTTPS only (HTTP on loopback), no credentials, no redirects, `no-store`;
   20 MiB a file and 100 MiB in all counted as bytes arrive (whatever `Content-Length` says), 64
   files, 8 levels, 30 s a file and 120 s in all, one Stop for everything. Dependencies only on the
   root's origin; the library's are content-addressed (`href` + `bytes_sha256`).
2. **Resolve** (`resolve.ts`): every dependency to its exact bytes, each once; satisfied by a pack
   served or installed (same hash; same id and version with other bytes is a conflict), a record
   this installation exported (`table/<installation>/<record>`, exactly that record), a chosen file
   with that identity hash (never by name), or its `href`. A cycle, a missing piece, a changed
   snapshot or a limit stops the whole import (Q-01). Raw files (no envelope) are classified as the
   one engine document that keeps every field.
3. **Preview** (`plan.ts`): every character checked by the engine on its own content as
   `importCharacter` did (nothing dropped, the build valid, the state valid and unchanged by
   `reconcileState`); what's already here (identical, changed here, older, unknown order — from the
   source id and revision, never the clock); what blocks. Nothing is written; packs are registered
   with the worker in memory for the checks only.
4. **Decisions**: a new copy by default; a replacement only of a record picked by hand, with what
   changes shown and the current one offered as a download; a party member as a new copy or an
   existing character picked by hand; a build without a state only as a new character after
   ticking its initialization (`createState`, `state_origin: initialized-on-import`) (Q-03); raw
   files only after choosing their content, and every encounter key mapped by hand.
5. **Commit** (`commit.ts`): the queues of the records it replaces or uses are held from the
   autosave flush to the publication; one transaction checks their revisions in the database and
   in the store, adds the packs (refused whole, `pack_identity_conflict`, when that id and version
   is already stored with other bytes, whichever preview or tab put them there; the same bytes are
   reused), writes the records; only then are they shown and the autosave baseline moved. Quota, an
   abort or a changed record writes nothing.

**Export** (`export.ts`): a character, an encounter (with each party member as its own file) as
transfers with this installation's identity and the exact refs of their content (the campaign's
packs resolved to their hashes); an imported record keeps the import as `extensions.derived_from`.
Exporting a campaign record and importing it back as a replacement is how a record without
`content` gets pinned (an explicit action, never a migration).
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

## Player actions on the sheet (kenli F-005)

The engine computes, the sheet picks and shows; every change is one engine call and one commit
through the document queue (`guarded`, `commitCharacter` with `rev`/`gen`), on the record's own
content (`record.content`).

- **Payments.** A spell's play-sheet line lists its slots, free casts (`free`) and `ritual`; the
  Spells tab offers them and sends `RollWhat.cast.payment`. A feature with `slot_payment` gets a
  slot picker (`use_feature.payment`: Font of Inspiration always, a slot instead of a spent use);
  `blocked` (armor without training) disables the roll with the engine's reason.
- **The GM's additions** (`RollOptions`, `src/store/rolls.ts` `useRollAdditions`): a mode, a
  modifier, a bonus die and damage additions for the character's next rolls, sent as
  `rollCheck` options or `RollWhat.attack/cast.dm`; a luck-style use (`spend_for`) can be declared
  for the next D20 Test, attack or spell attack by hand: one more Advantage reason the engine rolls
  with (`modes`, `dm.modes`), and the use paid in the same commit as the roll's own costs; refused
  (no use left, no d20 the engine rolls) with nothing changed, cleared only once spent.
- **The last roll** (`useRolls`, `RollFollowUps`): kept per character with the record's `rev`/`gen`
  after its cost was paid; any later change (or an import replacing the record) closes it
  (`errors.rerollWindowClosed`), and a reload too (memory only); so does any later result of the
  character: a free Damage or Critical roll (itself the last roll then) or a Hit Die in the rest
  dialog. Free rolls and tests without a cost run in the record's queue like changes (in the order
  asked); one answered for a record changed meanwhile (an import replacing it) is dropped
  (`errors.documentReplaced`), never pinned to the new version. Heroic Inspiration rerolls one die
  (`heroicReroll`: d20, bonus die, damage die, a feature's die), late Advantage spends a use
  (`lateAdvantage`), the table sets a Critical Hit (`setCritical`, nothing spent): never through
  `rollByHand` again, so a roll's slot or use is paid once. A death save is the engine's d20 then
  `death_save` with that roll; Heroic Inspiration makes it again from the state before it (one
  commit; Undo goes back to the first result).
- **Short Rest** spends Hit Point Dice one at a time: each die is the engine's roll, the dialog
  shows the engine's preview (`applyPlayAction`, not committed), Heroic Inspiration can reroll the
  last die; Confirm is one `short_rest` with every die, so what it gives back comes once; Cancel
  saves nothing. The dialog's steps run one after another, each applied whole and only in the
  opening it was asked in (closing drops the answers to come); the rest is made on the record's
  `rev`/`gen` when it began: changed meanwhile, it starts again, and Confirm (`playAction`'s `at`)
  is refused for the old one. Nothing is confirmed while a step is pending.
- Grapple and Shove are on the sheet (`rollByHand` `unarmed`); the engine's notes (what the save
  decides, a ritual's extra time, a feature's effect left to the table) are shown as toasts.
- **Dice as they count** (kenli F-005 roll display): the tray shows a d20 the engine changed as
  rolled, then what it counts as and why, `1 → 10 (Silver Tongue) +7 = 17`, from the engine's own
  list of raised dice (`D20TestResult.floors`, `{label, from, to}`; `src/lib/dice.ts` only maps them
  onto the dice in order); a result without that list still shows its kept die's `natural → d20`.
  The kept die is the engine's `kept` index (with Advantage or Disadvantage the other one is struck
  through), unchanged dice read as rolled. Nothing about a rule is known in the UI.
- **Stored items** (kenli F-005 DEC-01): the Inventory tab's Put away / Take back is the engine's
  `store` action (one commit, Undo like any other). The engine keeps a stored item off the weight,
  the attack lines and the magic, refuses putting away a worn item and equipping, attuning or using
  a stored one; the tab only hides the buttons a stored item can't use. A state with a stored item
  is the engine's document version 2: the app stores, exports (F-008 envelopes, unchanged) and
  imports it as it is, never dropping `location`; an older app refuses it with the engine's
  "saved by a newer srd-rules-engine" instead of reading the item as carried.

## Session history (kenli F-006)

Each character has a journal of what was played (contract `kenli.history/1` in the dnd5 repo,
`docs/features/F-006-session-history/contracts/history.md`). It is a record, not event sourcing:
the documents stay the only game state, nothing is replayed from the journal, Redo never rolls.

- `src/store/history.ts`: entries and heads. An entry is captured by the store method that accepted
  the operation, in the same synchronous block as its commit (`commitCharacter`, `applyToEncounter`),
  never for a refusal, a stale result or a cancelled dialog. Rolls that change nothing (a check, free
  damage, a Critical Hit) are captured too, with `commit: false`. The engine's result is kept
  verbatim; `outcome` copies its fields (raw `roll.natural`, effective `roll.d20`, totals); `costs` is
  only what that operation paid. A change of a roll (late Advantage, Heroic Inspiration, a Critical
  Hit) names the `component` of its root's result it replaces (`rolls.attacks[i]`, or the whole
  result), and `projection(entries, group)` puts the done changes on the root: the current result.
- Undo steps carry the operation id (`Snapshot.op`); Undo/Redo set the status of that operation's
  entries on the records the step restored (a later no-commit change of the same component goes
  with it). The stack stays in memory; statuses persist. `undoWarning` says when a sheet Undo would
  also take back a later encounter effect (the existing whole-state Undo is unchanged).
- Encounter operations write one entry per character they changed, one for the acting character
  when it rolled or changed a state, and one for the character who must decide when it stopped;
  `decide` continues that operation. Each character's entry is in its own journal and day.
- Days are per character in its head (`HistoryMeta`): labels by hand, stable ids, no Undo, no
  change of the record's `rev` (the reroll window stays open). Long Rest counters come from done
  `long_rest` entries; a second one the same day needs the DM's exception (`playAction`'s
  `capture.rest_override`), else the store refuses it.
- IndexedDB v3 adds `history` (unique `[record_id, seq]`, by day, by rest, by operation) and
  `history_meta`; the upgrade creates them empty and a head is made when first needed. Heads are
  read at start, entries on demand (`src/persistence/history.ts`: pages, counters, counts).
- The autosave writes a character as one unit: its document row (CAS on `rev`) and its journal
  (CAS on the head's own `rev`, +1 on every journal write). Either mismatch writes nothing of that
  character and marks it conflicted (`document` or `history`) until a reload; a failed transaction
  is aborted whole and the next save writes the same rows. The import compares replaced characters'
  heads in its transaction (`history_changed`) and writes one `import_boundary` entry each, under the
  operation its undo step carries. Copies and new characters start empty; a deletion removes the
  journal in the same transaction. Transfers carry no history.

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
  with **no target and no outcome**. The engine's `roll` is free; the app then pays its costs
  with `spend` (spell slots, feature and item uses, a monster's 1/Day and Recharge,
  Concentration started), the two as one undo step (`rollAndPay`), and refuses a roll it can't
  pay for (the GM can force it); the **action economy isn't** spent (Action,
  Bonus Action, Reaction, attacks per turn), so an attack can be rolled as often as the table
  likes. Nothing else changes. A by-hand tile is sent at once as the encounter's `roll` action;
  the composer opens only for what the engine still reads by hand (a slot level, Advantage,
  riders, strike effects, a damage type) or to show a refusal. **Which refusals count by hand is
  the app's policy**: the engine lists every reason with a category (R22), and by hand the app
  ignores `economy`, `turn`, `target` and `movement` (`byHandReasons` in `manual.ts`). The sheet
  rolls by hand too (attacks, spells, features with dice: the engine's `rollByHand`, its costs
  checked with `checkCosts` and paid on the state).

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
