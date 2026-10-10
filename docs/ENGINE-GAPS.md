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
| R18 | Messages ready for any language (plurals, list joiners, roll labels, step/alignment codes) | open |

### R18. Messages ready for any language

- **Meanwhile.** Engine texts are rendered in Italian in the worker (`src/engine/messages.ts`,
  catalog `src/i18n/engine/it.ts`). Plurals use the engine's one/other rule (right for Italian,
  not for Polish-like languages); where English says `{x, list, or}` / `and`, the Italian
  templates use the comma list. Roll labels in the dice results ("Perception check") stay
  English. Step titles, alignments and option-preview stat labels are named by the app per id
  (`EngineLanguage.steps` / `alignments` / `stats`).
- **When done.** Pass the locale to `renderMessage` (`renderAll`, `localize`); use `list, or` /
  `list, and` in the Italian templates again; render `label_message` in the dice results; drop
  `steps` / `alignments` / `stats` from `EngineLanguage` and the `names()` pass in the facade.

### R15–R17. Manual play

- **Design.** `docs/ARCHITECTURE.md` > "Manual play" (decided 2026-10-10).
- **R15 is in** (see Done): the Play switch, "Waiting for an outcome", the defaults.
- **Not by hand yet.** The sheet's `use_feature` takes `manual` too (spends the uses, skips the
  self-heal), not wired: on the sheet the player applies a feature's healing themself anyway.
  A spell played by hand leaves no zone, wall or mark (Hunter's Mark, Hex) in the engine: the
  GM tracks it (a follow-up request if a table needs it).
- **R16 is in** (see Done): the dice are a combatant's setting, not a way on the Play switch.
- **R17 is in** (see Done). Manual play needs nothing more from the engine; the open follow-up
  is a spell played by hand leaving no zone or mark (above).

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
| R9 | Rolls outside an encounter | `51d904d` (main) | sheet roll buttons (checks, saves, attack rolls) call `rollCheck` (facade, `rollTest` in `store/dice.ts`); the tray shows mode, reasons, outcome |
