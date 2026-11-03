# Provenance of `scripts/publish/`

kenli F-014 T02. Ported from the dnd5 workspace's local Table publisher (a private repository; the
files are not needed to run or test this one):

| dnd5 file | Last commit | Git blob | SHA-256 |
|---|---|---|---|
| `tools/migration/app/lib.ts` | `e995ba05e5de6b6f866c6fa88b98bf0b8c111e50` | `dfc7ceb9d146c12e287e72f4dcbf8d7f1ec38915` | `a246c6f085cecd6f27063cdd1b4c0be5bb34104e18b9501e72f8918081605de6` |
| `tools/migration/app/publish.ts` | `e995ba05e5de6b6f866c6fa88b98bf0b8c111e50` | `8bf35150f3bf4ea92d4339a67e31c330ffb1a8b1` | `46b179606653cdf33a487b263883f325d1b4dc777fecb8fe06bab657c062b1c8` |
| `tools/migration/app/inventory.ts` | `e27c1fcf1f44c09ecb369b57c0905f20bd656634` | `c92d91f5b077273f4c605959b8a1408297a071c7` | `25796e77198369e4b664530c3bb1fd3e03d9d50a4a290d1e9fbfaaa32a737279` |
| `tools/migration/app/pointers.test.ts` (test cases) | dnd5 at `bb1c96c11623bf50033a8fe66d59f5ee2920d661` | | |

Kept: the canonical JSON and release id, safe paths, the independent descriptor checks, the step
order and temp + rename writes, immutability, the closed graph, retained files byte-exact, the two
pointers and the bridge (`pointerPlan`), `release_downgrade`, the reader's view (`siteProblems`, was
`deployProblems`), interruption at every write.

Changed or added:

- `inventory.ts` (the first transition from an F006 deployment) is **not** ported: a public site never
  had one. `kind` is always `release`.
- `content/`, `library/`, `f005/` were other publishers' areas skipped by the dnd5 publisher. Here the
  site has a closed allowlist and carries exactly one content pack, the SRD (`content/srd-5.2.1/`),
  immutable by path.
- The `inputs.app_version` check (T01) and `version_not_newer` against the site's newest pointer.
- The marker is `srd-table.pages-publish/1` with the version.
- The full byte manifest of a site, hard-link refusal, the size guard, and everything in
  `archive.ts`, `witness.ts`, `cli.ts` (the archive and its recovery, new in F-014).
