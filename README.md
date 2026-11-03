# SRD Table

A browser app for 5th-edition play on the **SRD 5.2.1** rules: a character builder, a character
sheet for the table, and an encounter tracker with a grid map. Every rule comes from
[`srd-rules-engine`](../srd-rules-engine); the app shows the engine's documents and results and
turns clicks into the engine's JSON actions.

- **Characters**: create, import and export (the same JSON files as the `srd-rules` CLI),
  duplicate, portraits.
- **Builder**: the engine's ten steps with free navigation, every option with the reason it can't
  be picked, a live summary where every number explains itself; level-ups (fixed or rolled Hit
  Points), each level's choices and replacements, and editing the past with a preview of what
  changes.
- **Sheet**: HP, death saves, rests with Hit Point Dice, slots, limited uses, Rage-like toggles,
  conditions and Exhaustion, Concentration, inventory with attunement and charges, buying and selling at SRD prices, coins, today's
  prepared picks.
- **Table** (encounters): Initiative, turns, what the acting combatant can do as tiles (greyed with
  the engine's reason when it can't), targets, slot levels, areas aimed on the map, decisions after
  a roll asked to whoever controls the creature, GM tools (monsters, Initiative, effects by hand,
  walls and terrain), a combat log, a GM or player view.
- **Compendium**: every SRD table, searchable, with stat blocks.

Everything stays in the browser (IndexedDB); nothing is sent anywhere.

## Run it

Needs Node 24 and the engine repo next to this one (`../srd-rules-engine`). The app builds
against a worktree of the engine's `main` (`../srd-rules-engine-main`), so work on the engine's
branches doesn't reach it:

```bash
git -C ../srd-rules-engine worktree add --detach ../srd-rules-engine-main main
npm install
npm run engine:update   # the engine's main: install, build, copy the content
npm run dev          # copy the SRD content, start Vite on http://localhost:5173
```

| Command | |
|---|---|
| `npm run dev` | Copy content, start Vite |
| `npm test` | Unit and component tests (vitest, the real SRD, seeded dice) |
| `npm run e2e` | Playwright flows on the production build (`npx playwright install chromium` once) |
| `npm run check` | Lint + typecheck + tests (CI) |
| `npm run build` | Static build in `dist/` (any static host: hash routes) |
| `npm run engine:update` | Move `../srd-rules-engine-main` to the engine's latest `main`, build it, copy the content |

After the engine's `main` moves, `npm run engine:update`; the app uses the worktree's `dist/`.

## Releases and hosting

The public app is at **https://mcavity.github.io/srd-table/**, published by GitHub Actions
(`.github/workflows/pages-release.yml`) from a version tag on `main`: `vMAJOR.MINOR.PATCH` or
`vMAJOR.MINOR.PATCH-rc.N`. Each release is immutable, earlier ones stay on the site, and an installed
app updates only when asked (Settings → App updates). The footer and About show the running version
and its commits. The contract and the operator's guide — setup, publishing, retry/resolve, what each
refusal means, shared-origin data — are in [docs/deployment.md](docs/deployment.md). Read-only CI
(`.github/workflows/ci.yml`) builds and tests every push and pull request.

## How it's built

Vite + React 19 + TypeScript; the engine runs in a Web Worker behind a JSON facade (Comlink);
TanStack Router and Query, Zustand, Radix UI, Tailwind CSS v4, idb. See
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design and [CLAUDE.md](CLAUDE.md) for the
rules of the codebase. What the UI still needs from the engine is in
[docs/ENGINE-GAPS.md](docs/ENGINE-GAPS.md).

The UI text is English and kept in `src/i18n/` so it can be translated; engine messages are
shown as the engine writes them.

## License and attribution

This work includes material taken from the System Reference Document 5.2.1 ("SRD 5.2.1") by
Wizards of the Coast LLC, available at https://www.dndbeyond.com/srd. The SRD 5.2.1 is licensed
under the Creative Commons Attribution 4.0 International License, available at
https://creativecommons.org/licenses/by/4.0/legalcode.

This project is not affiliated with, endorsed, sponsored, or approved by Wizards of the Coast.
