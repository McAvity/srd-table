# Bundle → private pack Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Load a `kenli.bundle/1` bundle's own content (custom species, backgrounds, feats, spells, subclasses) in the app as a private pack, so a character from the bundle imports with no unknown entities.

**Architecture:** The bundle's `pack` field already has the engine's `ContentPack` shape: `createCatalog([srdPack, { name: pack.manifest.id, ...pack }])` builds, and the Kenli7 build evaluates with no errors against it (checked 2026-10-18 on the engine fork's `main`, `d76c349`). So there is no content conversion: a script splits the pack with the engine's `splitPack` into `content/private/packs/<id>/`, `copy-content.ts` copies private packs into `public/content/` only when asked (`PRIVATE_PACKS=1`), and the user adds the pack id in Settings > Content packs (the loader already fetches `content/<id>/`). The character script records the pack in `build.packs`.

**Tech Stack:** Node 24 scripts run with `tsx`, `srd-rules-engine` (`splitPack`, `createCatalog`, `parseBuild`, `parseState`, `evaluate`; `srdPack` from `srd-rules-engine/srd`, allowed in scripts and tests, never in `src/`), vitest.

**Spec:** this conversation's request (2026-10-18): "a script that turns the bundle into a package the table can import, then plan extracting the bundle's custom content". The first half is done (`scripts/bundle-to-character.ts`); this plan is the second half.

## Global Constraints

- No app (`src/`) code changes are needed: packs, load order and `content/<id>/` fetching exist (`src/engine/content.ts`, `src/store/settings.ts`, Settings page). If one turns out to be needed, stop and ask.
- No engine code changes (`CLAUDE.md`, "The one rule"); an engine need goes to `../srd-rules-engine/docs/REQUESTS.md` as `R<n>`.
- Private content never enters git (`content/private/` is git-ignored) or a public build: `public/content/<private id>/` exists only when `PRIVATE_PACKS=1` was set for the last content copy.
- Tests use a synthetic bundle built in the test from SRD entities with new ids; the real bundle (`/home/marcin/workspace/dnd5/private/kenli7-r1/bundle.json`) is never copied into the repo.
- Bundle fields other than `format`, `bundle_id`, `pack` and `fixtures` (`text`, `provenance`, `casting_sources`, `mapping_report`, `tables`, …) are ignored; say so in the module's doc comment.

## Review Focus

1. A later plain `npm run build` after a `PRIVATE_PACKS=1` one: the private pack folder must be removed from `public/content/`, not shipped. (Task 3 test.)
2. A bundle whose pack doesn't load with the SRD (a bad entity, a `requires` the SRD doesn't meet): the script prints the engine's message and exits 1, writes nothing. (Task 1 test.)
3. A fixture build with errors even with the pack: listed by the pack script, exit code 1 (the pack is still written, the user may need it to fix the build in the builder). (Task 1 test.)
4. Re-running the pack script after the bundle dropped a table: stale `<table>.json` files in the output folder are removed. (Task 2, same approach as `copy-content.ts`.)
5. Importing the character with the pack not enabled in Settings: the engine's own "pack missing" validation message shows (from `build.packs`), no app change. (Task 4 manual check.)

---

### Task 1: Bundle module

**Files:**
- Create: `scripts/bundle.ts`
- Test: `tests/scripts/bundle.test.ts`

**Interfaces:**
- Produces:
  - `class BundleError extends Error`
  - `interface Bundle { format: string; bundle_id: string; pack: Record<string, unknown> & { manifest: { id: string } }; fixtures: Record<string, { build: unknown; default_initial_state?: unknown; states?: Record<string, unknown> }> }`
  - `parseBundle(raw: unknown): Bundle` — throws `BundleError` when `format` doesn't start with `kenli.bundle/`, or `pack.manifest.id` / `fixtures` are missing.
  - `bundlePack(bundle: Bundle): ContentPack` — `{ name: manifest.id, ...bundle.pack }`.
  - `bundleCatalog(bundle: Bundle): Catalog` — `createCatalog([srdPack, bundlePack(bundle)], {})`; throws `BundleError` wrapping the engine's message.
  - `bundleCharacter(bundle: Bundle, opts: { fixture?: string; state?: string }): { slug: string; build: CharacterBuild; state: CharacterState | null; stateIds: string[] }` — `parseBuild`/`parseState` as today in `bundle-to-character.ts`; `build.packs` = existing packs ∪ `[manifest.id]`; unknown fixture/state → `BundleError` listing the ids.
  - `fixtureErrors(bundle: Bundle): { fixture: string; errors: string[] }[]` — `evaluate` each fixture build against `bundleCatalog`, issues with `severity === "error"`.

- [ ] **Step 1: Write the failing tests** — a helper `makeBundle(overrides?)` builds a bundle whose pack holds one feat copied from the SRD with id `test-feat` and `source` left out, manifest `{ id: "test-pack", requires: ["srd-5.2.1"] }`, and fixture `r1` = a complete level 1 build from `tests/fixtures/characters.ts`, unchanged (it must evaluate clean with the pack layered on). Tests:
  - `parseBundle rejects another format` → throws `BundleError`.
  - `bundleCatalog loads the pack over the SRD` → `lookup(catalog, "feats", "test-feat")` is defined.
  - `bundleCatalog reports a bad pack` → an entity with a missing required field → `BundleError`.
  - `bundleCharacter records the pack` → `build.packs` contains `"test-pack"` once, also when the input already had it.
  - `bundleCharacter rejects an unknown state` → message contains the fixture's state ids.
  - `fixtureErrors is empty for a clean fixture`; `fixtureErrors lists an unknown species` (fixture with `species_id: "nope"`).
- [ ] **Step 2: Run** `npx vitest run tests/scripts/bundle.test.ts` — expected FAIL (module missing).
- [ ] **Step 3: Implement `scripts/bundle.ts`** with the interfaces above (move the parsing code out of `scripts/bundle-to-character.ts`).
- [ ] **Step 4: Run** the test file — expected PASS; `npm run typecheck`, `npx biome check scripts tests/scripts` clean.
- [ ] **Step 5: Commit** `scripts/bundle.ts`, `tests/scripts/bundle.test.ts`: "Scripts: a bundle's pack and characters, checked against the SRD".

### Task 2: Pack script and character script on the module

**Files:**
- Create: `scripts/bundle-to-pack.ts`
- Modify: `scripts/bundle-to-character.ts` (use `bundleCharacter`, report `fixtureErrors`-style errors against `bundleCatalog` instead of the SRD alone), `package.json` (`"bundle:pack": "tsx scripts/bundle-to-pack.ts"`)

**Interfaces:**
- Consumes: Task 1's `parseBundle`, `bundlePack`, `bundleCatalog`, `bundleCharacter`, `fixtureErrors`.

- [ ] **Step 1: Implement `bundle-to-pack.ts`**: `npm run bundle:pack -- <bundle.json> [--out dir]`; default out `content/private/packs/<manifest.id>/`. Order: `parseBundle` → `bundleCatalog` (on `BundleError`: print, exit 1, write nothing) → write `splitPack(bundlePack(bundle))` files, removing other `*.json` in the folder → print `fixtureErrors`, exit 1 if any → print the next steps: `PRIVATE_PACKS=1 npm run content` and "add `<id>` under Settings > Content packs, after srd-5.2.1".
- [ ] **Step 2: Rework `bundle-to-character.ts`** on the module; the error list is now against SRD + pack, and its heading says so.
- [ ] **Step 3: Verify on the real bundle**: `npm run bundle:pack -- /home/marcin/workspace/dnd5/private/kenli7-r1/bundle.json` → writes `content/private/packs/kenli-pack/{manifest,species,backgrounds,feats,spells,subclasses}.json`, no fixture errors, exit 0. `npm run bundle:character -- <same> --state FX-R1-RESTED` → `kenli7.json` has `"packs": ["kenli-pack"]`, 0 errors listed.
- [ ] **Step 4: Commit** the two scripts and `package.json`: "Scripts: a bundle's pack as a private split pack".

### Task 3: Private packs in the content copy

**Files:**
- Modify: `scripts/copy-content.ts`, `package.json`
- Create: `scripts/private-packs.ts`
- Test: `tests/scripts/private-packs.test.ts`

**Interfaces:**
- Produces: `syncPrivatePacks(source: string, target: string, enabled: boolean): string[]` in `scripts/private-packs.ts` — for each folder in `source` (`content/private/packs/`) with a `manifest.json`: when `enabled`, mirror its `*.json` into `target/<folder>/` (removing stale files); when not, `rmSync(target/<folder>, { recursive: true, force: true })`. Returns the ids copied. A missing `source` folder is no packs.

- [ ] **Step 1: Write the failing tests** (temp dirs under `os.tmpdir()`): `copies packs when enabled`; `removes a copied pack when disabled` (Review Focus 1); `leaves srd-5.2.1 alone` (a `target/srd-5.2.1/` folder survives both modes); `no source folder copies nothing`.
- [ ] **Step 2: Run** `npx vitest run tests/scripts/private-packs.test.ts` — expected FAIL.
- [ ] **Step 3: Implement** `syncPrivatePacks`; call it at the end of `copy-content.ts` with `enabled = process.env.PRIVATE_PACKS === "1"`, logging `Copied private packs: <ids>` or nothing.
- [ ] **Step 4: Add** `"build:tailnet": "PRIVATE_PACKS=1 npm run build -- --base /srd-table/"` and `"dev:private": "PRIVATE_PACKS=1 npm run dev"` to `package.json` (the `pre*` hooks run `content` with the variable inherited).
- [ ] **Step 5: Run** the tests — PASS; `npm run check` green.
- [ ] **Step 6: Commit**: "Content: private packs copied only when asked (PRIVATE_PACKS=1)".

### Task 4: Docs and the end-to-end check

**Files:**
- Modify: `docs/ARCHITECTURE.md` (the content/packs section, around line 59: bundles, `bundle:pack`, `PRIVATE_PACKS`, `build:tailnet`), `CLAUDE.md` ("More packs" bullet and the Commands block: the three new scripts, one line each)

- [ ] **Step 1: Update the docs** as listed.
- [ ] **Step 2: Manual check** on `npm run build:tailnet` (served at https://ubuntu.taila82800.ts.net/srd-table/): Settings > Content packs = `srd-5.2.1` + `kenli-pack`; import `kenli7.json` + `kenli7.state.json`; the builder shows Custom Lineage, Custom Background, College of Eloquence, Fey Touched, Mind Sliver and Absorb Elements with no error, only the alignment pending. With `kenli-pack` removed from Settings, the engine's "pack missing" message shows (Review Focus 5).
- [ ] **Step 3: Check** `npm run build` (no variable) leaves no `dist/content/kenli-pack/`.
- [ ] **Step 4: Commit** the docs: "Docs: private packs from bundles".
