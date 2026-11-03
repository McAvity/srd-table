# Versioned releases — the version contract

kenli F-014 T01. How a Table release gets a readable version, how that version enters the release
identity, and what the running app shows about itself. The offline release format itself
(`srd-table.release/1`, `srd-table.release-inputs/1`, the service worker, pointers) is described in
[offline.md](offline.md) and the dnd5 F-007 contract; this document only adds to it. Publishing to
GitHub Pages (archive, workflow) builds on this contract and is described separately.

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
