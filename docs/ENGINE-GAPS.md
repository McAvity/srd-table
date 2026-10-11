# Engine gaps

What the app is waiting for from [`srd-rules-engine`](../../srd-rules-engine), kept for this
repo's own work: what the app does meanwhile, where that fallback lives, and what to change once
the engine delivers.

**How engine work happens.** This repo's sessions never change engine code. A need is written
as a requirement in the engine's `docs/REQUESTS.md` (git-ignored there, read by the engine's own
Claude Code session), with an id `R<n>`; it's tracked here under the same id. When a request is
`done`: `npm run engine:update` (the engine's `main` into `../srd-rules-engine-main`, the
worktree the app builds against: `npm ci`, `dist/`, content), wire the app, delete the fallback named here, move the entry to "Done" below.

**How a delivery is noticed.** The engine session appends an entry to its `docs/RESPONSES.md`
(commit, CHANGELOG entry, final API names, differences), puts `Request: R<n>` in the commit's
trailer, and may send this session a `SendMessage` nudge. Check at the start of a session and
before engine-dependent work: `docs/RESPONSES.md` and `git -C ../srd-rules-engine log --grep
"^Request:"`. A `needs info` entry is answered under the request in `REQUESTS.md`.

The app never works around a gap with rules of its own.

## Waiting

| Id | What the app is missing | Engine status |
|---|---|---|
| — | Nothing waiting | — |

### Notes: manual play

- **Design.** `docs/ARCHITECTURE.md` > "Manual play" (redesigned 2026-10-10; R21–R23 in Done).
- **On the sheet.** "Roll" for attacks and spells, and "By hand" next to "Use" for a feature with
  dice (healing or a save; first when the campaign plays characters by hand): the facade's
  `rollByHand`: rolled free, its costs checked and paid (`CombatTab.tsx`, `SpellsTab.tsx`).
- **Rolling and paying.** The engine's `roll` spends nothing; the app tracks resources, so it
  pays with `spend` right after (`rollAndPay` in `store/documents.ts`). A table that doesn't track
  resources by hand would only skip that step (a setting, if it's ever wanted).
- **Dropped from the app.** Table dice (R16's `RollDialog`, the Dice selects and settings) and
  "Waiting for an outcome" (R15/R19's `DeclaredPanel`); the Done rows below are their history.

## Done

| Id | What | Engine | App |
|---|---|---|---|
| R1 | Starting equipment taken after the state exists | `aef3cf1` (main) | sheet notice + `take_starting_equipment` (`InventoryTab.tsx` `StartingEquipment`) |
| R2 | Exploration and points of interest | `3b81071` (main) | `ExplorationPanel.tsx`, `PointPanel.tsx`, the map's Points tool and markers, the Move hint's turns |
| R3 | Bloodied | `d07df13` (main) | `HpBar` `bloodied` (red), "Bloodied" label on the rail and the sheet |
| R4 | Creature space | `c8569e7` (main) | tokens drawn at their real size (`CombatantView.space` from the engine), reach and range from the whole space; the size letter is gone |
| R5 | Zone squares | `c8569e7` (main) | `zoneSquaresOf` in the facade calls the engine's `zoneSquares` (an Emanation leaves out its caster's space, as the engine's saves do) |
| R6 | Cunning / Brutal Strike | `b22a78e` (main) | "Strike effects" in the composer from `OptionEntry.strikes` (unavailable ones disabled with the engine's reason, not hidden), merged into the attack |
| R7 | Rest-change options as played | `7ec7459` (main) | facade `evaluatePlay` (`evaluate(playBuild(…))`) for the sheet's "Today's picks" (`RestChoices.tsx`) |
| R8 | Magic item bases | `bcc01bd` (main) | "Add an item" offers only `magicItemBases` (facade `magicItemBases`, `useMagicItemBases`) |
| R14 | Positions required (a GM setting) | `9c89a34` (main) | "Off the map" select in the GM's combat controls (`CombatPanel.tsx`: warn only / refuse what needs a distance, `set_positions`); the off-map notice says the engine refuses under `required` (`OffMapNotice.tsx`); refusals and disabled options come from the engine (`off_map`) |
| R13 | Message codes for translation | `5602229` … `3c23939` (main) | every engine text rendered in the app's language in the worker (`src/engine/messages.ts` `localize`, catalog `src/i18n/engine/it.ts`); the combat log and decision questions from stored `messages` (`useRenderedMessages`) |
| R10 | Combatant ids in results | `0d8c00f` (main) | target names in the dice tray (spell, save effect and follow-up targets) are links: a click selects the combatant (rail and map) and pings its square (`DiceTray.tsx` `TargetName`, `useUi.focus`, `EncounterPage.tsx`) |
| R11 | Option previews | `2144460` (main) | each builder option shows what it would change ("AC 16 → 17", `ChoiceCard.tsx` `PreviewLine`, facade `optionPreviews`, `useOptionPreviews`), Ability Score Improvement rows too; not on the sheet's "Today's picks" (the saved build isn't the build as played) |
| R12 | `unassignedValues` | `5dbf55e` (main) | the ability selects offer only the engine's unassigned values plus the ability's own (`AbilitiesView.unassigned`); the swap convenience is gone |
| R15 | Declared actions (manual play) | `98c6df0` (main) | the quick bar's Play switch (Automatic / By hand, starting on the combatant's way: `features/encounter/manual.ts` `wayOf`) sends `manual: true` (`playedAs`); the composer offers the other way as its second button; the GM's "Waiting for an outcome" (`DeclaredPanel.tsx`, the record's `declared`, kept in undo snapshots) applies damage or healing to the picked targets with `effects`, then Done; per-combatant way in `SelectionPanel.tsx` (the record's `modes`), campaign defaults `character_play` / `monster_play` in Settings; declared results skip the dice tray |
| R16 | Dice rolled at the table | `dccdd51` (main) | `RollDialog.tsx` for `pending.kind: "roll"` (one box per die, `enter_roll`, the engine's refusals shown), to the roll's controller, others see the wait; "Dice" (engine / at the table) per combatant in `SelectionPanel.tsx` and for the encounter in `CombatPanel.tsx` (`set_dice`); campaign defaults `character_dice` / `monster_dice`, sent as `dice` on `add_character` / `add_monster`; the question an action stops for is logged once (as the decision entry) |
| R17 | GM override | `23a3143` (main) | in the GM's view an unavailable option opens the composer (`OptionButton` `onUnavailable`), which dry-runs the action with `force` and, when the engine can override, offers "Do it anyway" (danger) sending `force: true`; the engine's `override.applied` note is in the log; players never see it |
| R18 | Messages for any language | `d9394d7` (main) | `EngineLanguage` is `{ locale, messages }` and `renderMessage` gets the locale (Italian plurals by `Intl.PluralRules`); the Italian templates use `list, or` / `list, and` with the catalog's `list.*` joiners; step titles, alignments and stat labels are catalog codes (`step.*`, `alignment.*`, `stat.*`: the app's own name tables are gone); a sheet roll's label is rendered from `label_message` |
| R19 | Roll20-style rolls by hand, saves on demand | `801bf1a` (main) | a declared action with the engine's dice shows its rolls in the dice tray (`DiceTray.tsx` `Declared`: each attack roll against its target's AC with "would hit / miss" as information, damage, healing, the save to make; target names passed by the store); "Waiting for an outcome" lists the attack rolls (a click picks that target and its damage), starts the amount on the rolled damage or healing and the damage type on its first part; the selection panel's roll form has saving throws (`check` with `save`) for any combatant; check results that are `D20TestResult` show as tests |
| R21 | Manual play as a dice roller; table dice removed | `8160423` (main) | a by-hand tile is sent at once with `manual: true` and no target (`playedAs` drops `target`, `targets`, `area`, `cover`); the composer opens only for a slot level, riders, Versatile or strike effects (`needsComposerByHand`), or when the engine refuses it; in the composer, by hand hides targets, areas, cover and odds ("Automatic" switches it back to the targeting form); the tray's by-hand card shows each attack roll with its Critical Hit / natural 1, no AC or "would hit"; the Italian `manual.*` templates follow the new English ones and R16's codes are gone; the tray's `names` plumbing removed |
| R22 | Refusal reasons by category; a by-hand roller, paid apart | `d58fc40`, revised `0ec4fd5` (main) | by hand a `rollable` option is sent as the free `{ type: "roll", id, what }` (`manual.ts` `rollOf`, `playedAs`), then its `costs` paid with `spend` when every one is payable, as one undo step (the store's `rollAndPay`); a cost that can't be paid refuses it (`unpaid`), and the GM's "Do it anyway" sends `spend` with `force`; the quick bar and the composer (strike effects too) grey out by-hand options only on reasons outside `economy`, `turn`, `target`, `movement` (`byHandReasons`: the app's policy; resources still count); option reasons translated in the worker (`message` → `text`); on the sheet, "Roll" for attacks and spells and "By hand" for features with dice (healing or a save) call the facade's `rollByHand` (the engine's free `rollByHand`, `checkCosts`, then each `play` cost applied), shown in the dice tray |
| R23 | A spell's slots on the play sheet | `cda2ae1` (main) | the sheet's "Roll" for a spell offers the engine's `slots` (`SpellsTab.tsx` `RollSpell`): spent ones disabled with their reason, the first one left picked; with none left, Roll disabled and the reason shown; the Pact slot sent as `slot_level` + `pact` |
| R20 | Engine cleanup | `eeacec9` (main) | nothing to change: the app imported none of the removed exports (typecheck clean after the bump) |
| R9 | Rolls outside an encounter | `51d904d` (main) | sheet roll buttons (checks, saves, attack rolls) call `rollCheck` (facade, `rollTest` in `store/dice.ts`); the tray shows mode, reasons, outcome |
