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

- **Rulesets** (`RulesetFacts`): `pages-state` deletion and non-fast-forward blocked, `v*` tag update
  and deletion blocked, no bypass for the workflow. Anything else: `ruleset_missing`. (T03 maps the
  effective rules the runner's token can see, R02-02; the operator confirms the full configuration.)
- **github-pages deployments** (`DeploymentFacts`): whether any deployment ever succeeded, and the
  state of the pending candidate's deployment. A deployed site with an archive that served nothing is
  `history_lost` (archive reset or replaced). A **confirmed** deployment in the archive (a receipt, or
  observed-unverified with a successful deployment) without any successful github-pages deployment is
  `witness_mismatch`. A version observed live under a failed or missing deployment status (R03-02:
  e.g. the first release served although its job or smoke failed) is backed by the live evidence
  recorded in its resolution instead; the live checks keep applying to it, so a higher forward fix
  can follow while a lost or rolled-back history is still refused.
- **Aggregating deployment statuses (for the T03 adapter; safety rules):**
  - `everSucceeded` is true when any github-pages deployment of this repository ever had a `success`
    status — also one later marked `inactive` (superseded) or older than the latest. A deployment
    becoming `inactive` never erases an earlier success.
  - `candidate` is about the deployments of the pending version's run/artifact only: `success` if
    any of them ever reported success (later `inactive` included); else in progress (`queued`,
    `pending`, `waiting`, `in_progress`) if any is not terminal; else `failure`/`error`/`cancelled`
    when all of them ended so; `none` only when the run never created one. Never report `failure`
    just because the latest status is `inactive`, and when the API can't be read, fail the
    witness (no facts) rather than guessing.
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
- The deployment never started or ended terminally (`none`, `failure`, `error`, `inactive`,
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

The workflow, its permissions, the tag-on-main check, rulesets and deployment facts from the GitHub
API, the real Pages upload and HTTP smoke (T03); the first public publications and the device test
(T05). The local rehearsal (`rehearse.ts`) uses a fake Pages host and stated facts.
