# Versioned releases — the version contract

kenli F-014 T01. How a Table release gets a readable version, how that version enters the release
identity, and what the running app shows about itself. The offline release format itself
(`srd-table.release/1`, `srd-table.release-inputs/1`, the service worker, pointers) is described in
[offline.md](offline.md) and the dnd5 F-007 contract; this document only adds to it. §4–8 (kenli
F-014 T02) are the publication contract: the public publisher, the `pages-state` archive and its
recovery. The GitHub Actions workflow that runs it (T03) builds on them.

## 1. Version and tag

- A release version is `MAJOR.MINOR.PATCH` or `MAJOR.MINOR.PATCH-rc.N` (`0.2.0`, `0.2.0-rc.1`).
  Each number is decimal without leading zeros and a safe integer; `N >= 1`. No `+build` metadata,
  no other prerelease label (`-beta.1`, `-RC.1`, `-rc` are refused), no surrounding spaces.
- Its Git tag is the same text with a `v` in front: `v0.2.0-rc.1`. The build takes the version
  without the `v`.
- Order is SemVer's for this subset: numerically by MAJOR, MINOR, PATCH, then every release candidate
  before the final version, candidates by N (`0.2.0-rc.2 < 0.2.0-rc.10 < 0.2.0 < 0.2.1`,
  `0.9.0 < 0.10.0`).
- A new version must be greater than every version already reserved, including abandoned or
  observed ones (after `0.2.0`, neither `0.1.9` nor `0.2.0-rc.3` is accepted). The publisher
  enforces this; the release build only validates the text. A new feature raises MINOR, a fix
  PATCH, an incompatible change of a public contract MAJOR — also in `0.x`. Data migrations keep
  their own protocol; a version number never bypasses it.
- The version is not `package.json`'s `version` (which stays as it is) and no commit is made to
  bump it: it is an input of the build.

Code: `src/offline/version.ts` (`parseAppVersion`, `compareAppVersions`, `tagOfVersion`,
`versionOfTag`).

## 2. `inputs.app_version`

```
bun scripts/release.ts --base /srd-table/ --out <new dir> --app-version 0.2.0-rc.1
```

- `--app-version` adds `app_version` to the descriptor's `inputs` (format still
  `srd-table.release-inputs/1`, an additive optional field outside the strict `inputs.data`). The
  release id is the existing hash of the canonical inputs, so the same code, engine, base and
  toolchain built as two versions are two releases with two ids; equal inputs give the same id.
- An invalid version fails the build before anything is built. A version is refused on a dirty
  tree (`--allow-dirty` builds are never publishable and carry no version).
- A descriptor with `app_version` that isn't a supported version, or one on a `dirty` build, is
  invalid (`release_inputs: app_version`).
- **Legacy.** A descriptor without `app_version` — every release before F-014 — is still valid,
  and its id is unchanged (nothing else in the inputs changed). A client that predates F-014 hashes
  the whole `inputs` and ignores unknown input fields, so it accepts a versioned release as an
  update; the dnd5 publisher's validator does the same. Player data formats, the database version
  and the release protocol are unchanged.

## 3. Build metadata in the running app

- After the id is known, `scripts/release.ts` passes `{version, release_id, table_commit,
  engine_commit}` (plus `dirty: true` on a dirty build) to Vite as `F014_BUILD_INFO`, checked with
  `buildInfoProblems`; `vite.config.ts` embeds it as `__BUILD_INFO__` next to `__RELEASE_ID__` and
  refuses metadata of another release. The release build fails if the app's JS doesn't contain the
  id, both commits and the version.
- The metadata is part of the JS the page runs, so it is right offline and never disagrees with
  the code: nothing is fetched (no mutable `version.json`), Git is never read at run time, and no
  file contains its own hash.
- Outside a release (`npm run dev`, tests, a plain `vite build`) the metadata is the development
  build: `release_id` `r-dev`, no version, no commits. It is shown as "development build", never as
  a version number.
- The footer shows the version, or, for a release without one, its release id, linking to About.
  About shows version, release id and both commits, and the same facts as plain text (always on
  screen, selectable) with a Copy button. Copying uses the Clipboard API when it works; when it is
  missing or refused, About says to select the text by hand. The F-007 marker
  `data-testid="about-version"` ("Version r-…") is unchanged.

Code: `src/offline/build-info.ts`, `src/features/settings/AboutPage.tsx`,
`src/routes/AppShell.tsx`, `scripts/release.ts`, `vite.config.ts`. Tests:
`tests/offline/version.test.ts`, `tests/offline/release-version.test.ts` (with the verbatim
pre-F-014 descriptor `tests/offline/fixtures/legacy-release-0d64dc4.json`),
`tests/components/about-version.test.tsx`.

## 4. The public publisher (`scripts/publish/`)

A self-contained publisher in this repository: it needs no dnd5 checkout, private data or network
access other than the Table repository and the site. It is a port of the dnd5 local publisher
(`tools/migration/app/{lib,publish}.ts`; provenance and differences in
[`scripts/publish/PROVENANCE.md`](../scripts/publish/PROVENANCE.md)); the dnd5 publisher and its
private deployment keep working unchanged.

| File | Role |
|---|---|
| `lib.ts` | its own canonical JSON, release id, safe paths, descriptor checks (independent of the code that built the release), version order, the site allowlist |
| `site.ts` | one release + the SRD into a site directory: verify → content → immutable → descriptor → manifest → pointer → root → marker; byte manifest of the result |
| `witness.ts` | the witnesses (§6) and the HTTP live reader |
| `archive.ts` | the `pages-state` archive and its operations (§7) |
| `cli.ts` | the command line (§7.6) |
| `rehearse.ts` | a local A → B rehearsal: bare Git repository + fake Pages over HTTP |

Tests: `tests/publish/{site,archive,cli}.test.ts` (local bare Git, an explicit fake GitHub/Pages in
`tests/publish/helpers.ts`). Nothing here has been run against GitHub; T03/T05 do.

## 5. The site

### 5.1 Closed allowlist

A public site holds exactly: `index.html`, `release.json`, `release-current.json`,
`.srd-table-deploy.json`, `releases/index.json` (the mutable files); `assets/<name>`,
`sw-r-<16 hex>.js`, `releases/r-<16 hex>/{index.html,manifest.webmanifest,release.json}` (the
releases); `content/srd-5.2.1/<name>.json` (the SRD pack, the only content). Any other path — another
pack, `library/`, `f005/`, a dotfile, a stray file — a symlink, a hard link or a non-file is refused
(`site_foreign_file`, `site_symlink`). The release staging directory must be exactly what
`scripts/release.ts` wrote (`staging_invalid` for any extra, missing or changed byte), clean
(`release_dirty`), not a variant, and numbered with the version asked (`version_mismatch`). The SRD
directory is the engine's `dist/srd-5.2.1/`: flat JSON files, exactly `manifest.json` (naming the
pack) and the files its `tables` name — nothing else in the directory is published (`srd_unlisted`,
`srd_missing`, `srd_invalid`).

Only srd-table's own files reach the site: the release `scripts/release.ts` built from this
repository and the engine's SRD pack. No file of a parent workspace (dnd5), no private pack, character,
library or history, whatever its name; the publisher imports nothing outside `scripts/publish/`
and Node (a test checks both).

**Ownership (R03-04, D014-001).** An allowed path is not enough: every file of a site must have an
owner, or the site is refused before any write (`site_unowned`), at archive verification
(`archive_invalid`) and at export (`export_invalid`, nothing left behind). Owners are:

- the mutable files (root, both pointers, marker, `releases/index.json`);
- each release the manifest lists, through its own descriptor: the entry's record is
  `releases/<id>/release.json` with the recorded hash, the descriptor passes the publisher's checks
  under that id and the manifest's base, and the entry's files are exactly the descriptor's files —
  a file added to an entry's list ("forged membership") owns nothing;
- the SRD pack: `content/srd-5.2.1/manifest.json` and exactly the table files it names;
- while resuming an interrupted publication, only the files of that same verified release staging
  and SRD (a different release refuses the leftovers).

In the archive, every path of `site-manifest.json` must also be owned by a reserved version's record
(its release files, descriptor and SRD files, recorded by publish from the verified staging and SRD)
or be a mutable file, so an orphan added to `site/` together with a consistent site manifest and
state hash, or an SRD manifest rewritten to name a foreign file, is refused.

### 5.2 Nothing is overwritten or deleted

- Every release file and descriptor is immutable: an existing path with other bytes is
  `immutable_conflict`; a listed release with another descriptor `release_conflict`. Every release the
  manifest lists keeps its files byte-exact forever (`site_invalid` if not).
- SRD files are immutable by path: `content/srd-5.2.1/<file>` with other bytes than already kept is
  `content_conflict` — a changed SRD (also a new table, which changes the pack's `manifest.json`)
  needs a new content version, never an overwrite; that is outside this feature. The same pack again
  is kept as it is.
- Root HTML, pointers and marker change only by the existing protocol (dnd5 F-007 §4, F-002 T07):
  `release.json` (legacy) and `release-current.json`, the bridge (`--bridge`, once:
  `bridge_exists`), `bridge_required` for a newer database without a bridge, `release_downgrade` for an
  older database than the newest pointer's, and — new — `version_not_newer` for a numbered release
  not above the numbered release the site points at. Each write is temp + rename; an interrupted
  publication is finished by a rerun.
- The Pages artifact is the complete site exported from the archive (all earlier releases, the SRD,
  the marker), never a fresh `dist/`. Note for T03: `actions/upload-pages-artifact` at
  `7b1f4a764d45c48632c6b24a0339c27f5614fb0b` tars with `--exclude=.[^/]*` and has no
  `include-hidden-files` input, so the marker would be dropped. The workflow builds the tar itself
  from the exported site (checked against `site-manifest.json`, marker included) and uploads it with
  the official upload-artifact under the name/format deploy-pages expects, or uses an upload step
  whose hidden-file support is verified at its pinned SHA; it never assumes a flag. Whether Pages
  serves the dotfile is not relied on (the live checks never read it); it is kept in the archive.
- The size guard refuses a site above 900 MiB (`site_too_large`) before the checkpoint; old releases
  are never removed automatically.

## 6. Witnesses

Before any write (and before a retry or resolve) the archive is checked against independent
witnesses. They only refuse; files always come from the archive, never from the live site.

- **Rulesets** (`RulesetFacts`): `pages-state` deletion and non-fast-forward blocked; every release
  tag's update and deletion blocked — only by an active tag ruleset whose `ref_name.include` is
  exactly `refs/tags/v*` or `~ALL` with no `exclude` (R04-02: a ruleset protecting one sample tag,
  the current tag only, or `v*` minus some releases is not protection); no bypass for the workflow.
  Anything else: `ruleset_missing`. (The runner sees the effective rules its token can; the operator
  confirms the full configuration, R02-02.)
- **github-pages deployments** (`DeploymentFacts`, R04-01). GitHub keeps deployment statuses for a
  limited time (about 90 days) and a status's run URL is optional, so the facts are only ever
  positive evidence:
  - `everSucceeded`: a `success` is visible in the retained statuses — a lower bound; `false`
    proves nothing about the past.
  - `deployments`: how many github-pages deployment objects exist (any state).
  - `records`: per deployment its `created_at`, the run of this repository its statuses name
    (`null`: no URL, another repository's, or several runs), its own state (`success` if any
    retained status was; its latest in-progress or terminal-failure state; else `unknown` — only
    `inactive` left, no status, or a state not known here) and whether that run is the candidate's.
  - Rules: an archive that served nothing while a success is visible is `history_lost`; an archive
    that reserved **no** version while any deployment exists is `history_lost` (old statuses expire:
    a lost archive never passes as a first one); `initialize` refuses either. There is no
    "confirmed receipt but no visible success" refusal any more: a long-lived archive would be
    blocked for ever once old statuses expire. A served version is held to the live site instead
    (below), which also covers a version observed live under a failed status (R03-02).
  - The pending version's deployment state is judged from the records created since its checkpoint
    commit (10 minutes of margin): `success` if any candidate deployment succeeded; else its
    in-progress state; else **`unknown`** if a candidate deployment is unknown or any deployment of
    that period is not tied to a run of this repository (it could be the candidate's); else its
    terminal failure; else `none`. Records from before the checkpoint can't be the candidate's, so
    expired history never blocks resolving a new pending version.
  - Terminal evidence of a failed deployment is only `none`, `failure`, `error`, `cancelled`;
    `inactive` and `unknown` are not. When the API can't be read completely the witness fails (no
    facts), never a guess.
- **Live** (`httpLive`: `cache: "no-store"`, a unique query, `cache-control: no-cache`; 404 =
  absent, anything else = error): `index.html`, both pointers and `releases/index.json`. Once anything
  is served, an unreadable file is `live_unavailable`, a missing root or manifest `live_missing`.
  Every release the live manifest lists must be in the archive byte-exact (record and files), and the
  live bridge the archive's; otherwise `history_rollback` — this is what catches a `pages-state`
  reset to an older, consistent descendant of the anchor while a newer version is live. Before the
  first deployment the live paths must be absent (an expected 404, not a refusal).
- Live must be exactly the served version's root and pointers, its manifest listing it
  (`live_mismatch`), except where §7 says otherwise (a pending candidate).

## 7. The `pages-state` archive

### 7.1 Layout and identity

The branch `pages-state` of the Table repository holds only:

- `state.json` — `srd-table.pages-state/1`: `base`, `site_url` (both fixed by initialize:
  `config_changed`), `versions` (every reserved version: `status` `pending` | `deployed` | `abandoned` |
  `observed-unverified`, its record and hash, release id, later its checkpoint commit, receipt or
  resolution), `pending`, `served` (whose root/pointers/marker the site holds), `site_manifest_sha256`.
- `site-manifest.json` — `srd-table.site-manifest/1`: every file of `site/` with SHA-256 and size.
- `versions/<version>.json` — `srd-table.pages-version/1`, immutable: version, tag, Table and engine
  commits, base, release id, descriptor hash, the release files, the SRD files, the mutable files it
  set (pointers and marker as JSON, the root as its release HTML path), the complete candidate site
  manifest, and the `pages-state` commit it was built on.
- `site/` — the complete public site.

No dnd5 or private data, no source checkout, no `node_modules`. Every operation clones the branch
fresh and verifies it before anything else: the layout, each record's hash and identity, `site/`
against `site-manifest.json` byte for byte, the site rules (§5), and that the root/pointers/marker
are the pending or served version's (`archive_invalid`). The anchor `PAGES_STATE_ANCHOR` (a
non-secret repository variable, set by the operator) is the initialize commit: required
(`anchor_required`), a root commit with an empty state, and an ancestor of the branch head
(`history_foreign`). A missing branch is `history_missing`: it is never recreated by publish.

### 7.2 Operations and states

| Operation | Precondition | Effect (one commit at most) |
|---|---|---|
| `initialize` | branch absent (`already_initialized`), no deployment ever (`history_lost`), live absent (`live_present`), rulesets | the first empty state commit (the anchor); no build, no deploy |
| `publish` (stage) | a new version above **every** reserved one (`version_not_newer`; abandoned and observed ones included), tag `v<version>` resolving to the release's Table commit (`tag_mismatch`), the archive's base, no pending version (`pending_unresolved`), witnesses, live = served | the complete candidate site built on the archived site, checked, recorded as `versions/<v>.json`, `pending` — the **checkpoint**, pushed before any Pages transport; then the artifact is exported from it |
| `receipt` | `pending` = v, its deployment `success`, live = v (smoke passed) | `deployed` with `{run_id, state_commit, page_url, artifact_digest}`, `served` = v; site unchanged |
| `resolve` | `pending` = v | see §7.3 |
| `retry` | a reserved version | never a build: see §7.4 |
| `verify` | — | the checks and witnesses only |

A known version can never be staged again: identical inputs are `version_reserved` (use retry),
anything different (tag commit, base, release, SRD) `version_conflict`. Every number stays reserved
with its bytes, also after it was abandoned.

### 7.3 Resolve (R01-04, R02-01)

- The candidate's deployment queued, pending, waiting or in progress → `deployment_in_progress` (it
  may still succeed; resolve later).
- Live is the candidate (whatever the deployment says, a failed smoke or a failed first deployment
  included) → **observed-unverified**: `served` = v, its data direction stays (a later release can't
  lower the database), the deployment state and a summary of live are recorded; a higher version
  follows as a forward fix (§6: no confirmed success needed for that).
- No evidence either way (`unknown`, §6: a deployment of this period not tied to a run, only
  `inactive` or no status left) while live is the previous site → `deployment_unknown`, nothing
  written (R04-01): never abandoned without terminal evidence.
- The deployment never started or ended terminally (`none`, `failure`, `error`,
  `cancelled`) and live is exactly the previous served site → **abandoned**: only the root, pointers
  and marker go back to the served version's (or are removed before the first deployment); the
  candidate's record, immutable files and manifest entry stay.
- Anything else — live unreadable (`live_unavailable`) or mixed, or a successful deployment while
  live still shows the previous site — `live_ambiguous`: nothing written. A successful deployment is
  never abandoned. An unresolvable state needs a concrete operator decision.

### 7.4 Retry

- Pending: the archived candidate, `site/` checked against its record byte for byte, exported for the
  same Pages transport (`redeploy-pending`); live must be the previous site or already the candidate.
- The served, deployed version with nothing pending: verified, live checked (`already-deployed`; an
  identical redeploy of the exported site is possible).
- Anything older or settled: its release and SRD files are verified to be kept; no pointer moves
  (`historical-verified`).

A retry writes nothing to `pages-state`.

### 7.5 Failures

| Failure | State | Next |
|---|---|---|
| before the checkpoint (build, checks, commit, push) | archive and live unchanged, nothing reserved | publish again |
| push rejected: the branch moved | `state_conflict` (compare-and-swap on the head read, `--force-with-lease=refs/heads/pages-state:<parent>`) | rerun after the other publication |
| after the checkpoint, before the deployment | `pending`, live = previous | `retry` (redeploy-pending) or `resolve` (abandoned) |
| after the deployment, before the receipt | `pending`, live = candidate | `receipt`, or `resolve` (observed-unverified); never assume the deployment failed |
| a reset, deleted or replaced history; missing witnesses | refused (§6, §7.1) | operator |

The Actions concurrency group (T03) serializes publications; the compare-and-swap catches what it
doesn't (no FIFO guarantee).

### 7.6 Command line

```
tsx scripts/publish/cli.ts <initialize|verify|publish|retry|receipt|resolve> \
  --remote <repo> --work <new dir> --facts <facts.json> [--anchor <sha>] [--live-dir <dir>] …
```

`--facts` is a JSON file `{rulesets, deployments}` the caller fills (T03: from the GitHub API); the
live site is read over HTTP from the state's site URL, or from `--live-dir` in a local rehearsal.
`publish` and `retry` take `--site-out <new dir>` for the artifact. Exit 0 with a JSON result,
1 with `publish refused: <code>: <detail>`.

## 8. Not covered here

The first public publications, the repository settings (Pages `build_type=workflow`, the
`github-pages` environment limited to `main`, `PAGES_STATE_ANCHOR`, the rulesets) and the device
test are T05, after the authorized public operations. Until then nothing below has run on GitHub.

## 9. Workflows (kenli F-014 T03)

### 9.1 CI (`.github/workflows/ci.yml`)

`push` (main, `feature/**`) and `pull_request` only — never `pull_request_target` — with
`contents: read`, no secrets and no publication. A fresh checkout of this repository and of the
engine at the pin read from it (`pages-ci.ts pin`), then `scripts/ci/build.sh`: lockfile installs,
the engine build, `engine:verify`, content, lint, typecheck, Vitest and an unnumbered release build.

### 9.2 `pages-release.yml`

Only `workflow_dispatch` on `main` (every job also checks `github.ref == 'refs/heads/main'`), inputs
`mode` (`publish`, `retry`, `resolve`, `initialize`) and `tag`; `run-name: pages <mode> <tag>`
(the facts adapter finds the version's runs by it). Top-level `permissions: {}`, one concurrency
group `pages-release` with `cancel-in-progress: false` for every mode (GitHub keeps at most one
pending run and gives no FIFO order; the compare-and-swap on `pages-state` catches the rest).
Every action is pinned to a full commit SHA checked against its upstream tag; every checkout has
`persist-credentials: false`; inputs reach shell code only as environment variables.

| Job | Permissions | Runs | Does |
|---|---|---|---|
| `prepare` | `contents: read` | main's code | `pages-ci.ts resolve`: the mode; for all but initialize a tag `v<version>` of the T01 subset that exists, its full commit contained in main (`tag_not_on_main`), and the engine pin at that commit (`pin_missing`, `pin_invalid`) |
| `build` (publish) | `contents: read` | the tag's commit | the tag's commit and the engine at its pin, `build.sh` (fresh installs, all checks, the numbered release, both checkouts clean), the release and the engine's SRD as a run-local artifact (`candidate`, 1 day; never a durable source) |
| `state` | `contents: write`, `deployments: read`, `actions: read` | main's code | the facts (§9.3), then `state-op.sh`: initialize / publish (checkpoint, export) / retry (archived bytes) / resolve, and for a deployment the exact tar with its canary (§9.4) uploaded as `github-pages` |
| `deploy` | `pages: write`, `id-token: write`, environment `github-pages` | — | `actions/deploy-pages` |
| `receipt` | `contents: write`, `deployments: read`, `actions: read` | main's code | `receipt.sh` (§9.5) |

The write jobs never run a PR's or a tag's code: they check out `github.sha` (main) and read the
build's output only as data the publisher verifies byte by byte (and by ownership, §5.1). Git uses
the job token through an `http.extraheader` passed in the environment (masked), never in a URL or
file. Initialize only creates the empty first commit; the operator then sets `PAGES_STATE_ANCHOR`
(the runner has no token for repository variables).

### 9.3 Facts from GitHub (`scripts/publish/github.ts`)

Read-only REST calls with the job token; any failed read is no fact (the step fails). Response
shapes were taken from real read-only calls, not assumed (T03 ledger).

- Rulesets: `GET /repos/{o}/{r}/rules/branches/pages-state` (effective rules: `deletion`,
  `non_fast_forward`); active tag rulesets from `GET …/rulesets?includes_parents=true&targets=tag`
  and `GET …/rulesets/{id}` counted only when `conditions.ref_name.include` has exactly
  `refs/tags/v*` or `~ALL` and `exclude` is empty (`update`, `deletion`; §6, R04-02). The workflow may
  bypass when any ruleset used says `current_user_can_bypass` other than `never` (bypass actors are
  visible to admins only: the operator confirms them, R02-02).
- Deployments: every `github-pages` deployment and all its statuses (newest first; all pages read,
  more than the page limit is no fact) → `records` (§6). A record's run comes from the statuses'
  `log_url`/`target_url` `https://github.com/<this repo>/actions/runs/<run>/…`; a run of
  `pages-release.yml` titled `pages publish <tag>` or `pages retry <tag>`, or the current run, is
  the candidate's. The deployment SHA is never used (it is main's: 0.2.0-rc.1 and 0.2.0 from one
  commit share it). The archive judges the pending version from the records (§6); an untied, empty
  or `inactive`-only deployment is `unknown`, and `resolve` refuses it (`deployment_unknown`).

### 9.4 The artifact (`scripts/publish/artifact.ts`)

Not `upload-pages-artifact`: the site exported from the archive is packed into one deterministic
ustar `artifact.tar` (`./`, the needed directories, then the manifest's files sorted; mode 0644,
owner 0, mtime 0), so the hidden marker is in it and equal sites give equal bytes. It is read back by
our own reader (regular files and directories only: a link or any other type refuses) and must hold
exactly the site manifest — every file once with its hash, nothing else. The pre-upload canary then
plants synthetic parent-workspace and private files (unique per run) outside the checkout and
refuses the artifact if any of them, or any tracked source/config file of the checkout (not
`public/`, whose icons ship renamed), is in it by content (or, for the planted ones, by name), or
any entry has a path a site never has (`.git`, `.github`, `node_modules`, `src`, `scripts`,
`private`, `library`, sources, maps, configs). It is uploaded with `actions/upload-artifact` as
`github-pages` (1 day), which `deploy-pages` deploys.

### 9.5 Receipt

The receipt job downloads the deployed artifact, re-exports the pending version from `pages-state`
(`retry`: verified, never built), re-packs it and requires the same SHA-256 as the deployed tar and
an exact `verify-tar`; then the HTTP smoke fetches every served file of the site manifest past
caches and compares hashes (bounded rounds); then this run's github-pages deployment must report
success (bounded wait); only then `receipt`. A failed smoke leaves the version pending: `retry` or
`resolve` (§7.3) settles it from the real live site.

### 9.6 Dry run

`bun scripts/ci/dry-run.ts --table-repo … --table-commit … --engine-repo … --work <new dir>` runs
the same scripts on fresh clones in an empty directory (empty HOME and npm cache, no dnd5): resolve
(and its refusals), `build.sh`, `state-op.sh` for initialize, publish 0.2.0-rc.1, publish 0.2.0
with the runner lost after the checkpoint, retry (archived bytes, same tar), retry of a deployed and
an older version, resolve with nothing pending; `receipt.sh` against the tar served over local HTTP.
It stands in for GitHub only: `pages-state` is a local bare repository, Pages a local directory,
the facts are stated. It is not a run on GitHub.

## 10. Operator guide (kenli F-014 T04)

Two hostings, one app. **Public:** https://mcavity.github.io/srd-table/ — GitHub Pages from this
public repository: the app and the SRD only, built by GitHub Actions from public sources. **Private:**
the Tailscale site (`/dnd/`) of the dnd5 workspace — the same app plus the private library and packs,
published by dnd5's own publisher (`tools/migration/DEPLOY.md`), never by this repository. Nothing
private is ever in this repository, its CI or the public site (§5.1).

### 10.1 One-time setup (repository settings; an administrator)

1. Settings → Pages → Source: **GitHub Actions** (`build_type=workflow`).
2. Settings → Environments → `github-pages`: deployment branches **main only**; no secrets.
3. Actions → General → Workflow permissions: **read** (the jobs ask for more themselves, §9.2); no
   PAT anywhere.
4. Rulesets (active, no bypass for GitHub Actions or the workflow's app):
   - branch `pages-state`: block **deletion** and **non-fast-forward** updates;
   - tags: target `refs/tags/v*` exactly (or All tags), no exclusion: block **update** and
     **deletion** (creation stays allowed). Any other pattern is not recognised (§6).
5. Run **pages-release** with mode `initialize` (no tag). It creates the empty first commit of
   `pages-state` and prints the anchor SHA; set the repository variable **`PAGES_STATE_ANCHOR`** to
   it. `initialize` refuses when `pages-state` exists, when github-pages has any deployment, or when
   the site already serves something: it never recovers a lost archive.

### 10.2 A release

1. Merge to `main`; CI (read-only) must be green.
2. Choose the next version (§1: above every reserved one, abandoned ones included; `-rc.N` before
   the final), tag the commit on `main`: `git tag v0.2.0 <sha> && git push origin v0.2.0`.
3. Actions → pages-release → mode `publish`, tag `v0.2.0`. The run builds the tag fresh (the engine at
   the tag's pin), checkpoints the complete site in `pages-state` (`pending`), uploads the checked tar,
   deploys, smoke-tests every file by hash over HTTPS and writes the receipt (`deployed`).
4. On a device: Settings → App updates → Download → **Update now** (Later keeps the old version).

### 10.3 When something fails

| Seen | Meaning | Do |
|---|---|---|
| build/check failed | nothing written | fix forward, a new tag |
| `state_conflict` | another lifecycle moved `pages-state` | run again after it |
| deploy or smoke failed, version `pending` | the checkpoint has the exact bytes | `retry` the same tag (no build); if live shows the candidate, or it can't be deployed: `resolve` |
| `deployment_in_progress` | its deployment may still finish | wait, `resolve` again |
| `deployment_unknown` / `live_ambiguous` | no evidence either way | look at the Actions run and the site; `retry` or wait; never edit `pages-state` by hand |
| `history_lost`, `history_rollback`, `history_foreign`, `history_missing` | `pages-state` was reset, replaced or deleted | stop; restore the branch (its history is in every clone) — never `initialize` again |
| `ruleset_missing` | a protection is off or bypassable | restore §10.1 step 4 |
| `version_*`, `tag_*`, `pin_*` | the tag or number is not acceptable | a new, higher tag on main |
| `content_conflict` | the engine's SRD changed under the same `content/srd-5.2.1/` path | the engine needs a new content id/version; the publisher never overwrites published SRD bytes |
| `site_too_large` | the complete site would pass 900 MiB | no automatic removal of old releases: a separate retention decision |

Diagnosis: the receipt (`state.json` → `versions[v].receipt`: run, checkpoint commit, page URL,
artifact digest), `versions/<v>.json` (every file's SHA-256 of the checkpointed site) and the smoke's
list of served hashes. `git clone --single-branch --branch pages-state <repo>` gets the archive
alone; it grows with every release (all earlier files are kept).

### 10.4 Data and origins

- **Shared origin.** `mcavity.github.io` is also is-it-dark-yet's origin. A service worker's scope
  is `/srd-table/`, but IndexedDB, Cache Storage, localStorage and storage quota belong to the whole
  origin: another page of it can read them, and "clear website data" for `mcavity.github.io` clears
  the app's data too (keep a full copy). The app only touches its own database (`srd-table`) and its
  own caches (`srd-table:/srd-table/:<release>`); the T04 trial checks another app's database, cache
  and localStorage stay untouched through prepare, update and restarts.
- **Moving a character between hostings** (Tailscale `/dnd/` ↔ Pages): Characters → **Export
  character** (a full copy with state and history) on one, **Import character** with the file on
  the other. Different origins never share data; nothing has to be copied otherwise, and the private
  library is not needed on the public site. Importing by URL from the private Tailscale address on
  the public site may be blocked by the browser (CORS / private-network access); the file import
  always works.
- The version number is the product's (§1); data formats and the database version keep their own
  rules (dnd5 F-007 `offline.md`, F-002 `progression.md`): a higher number never permits a data
  downgrade, and a published version's files never change.

