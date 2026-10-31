/**
 * kenli F-011 §7 cases (review03 R03-15): a verbatim copy of the dnd5 contract example
 * `docs/features/F-011-character-export/contracts/examples/release-data.json`
 * (sha256 2cc5f31e6e3fd60ed13c79e4bf4d441a9dcbdad0f2e500d58fb3aac11970c978), kept here so this
 * repo's tests need nothing outside it. The dnd5 workspace checks the copy against its contract
 * (tests/unit/f011-release-fixtures.test.ts).
 */
export const RELEASE_DATA_JSON = `{
  "format": "f011.contract-cases/1",
  "section": "changes.md §7 (release descriptor inputs.data and the update gate)",
  "source": "Table a2e1bae: src/offline/update.ts:54–60 (OWN_DATA), :603–609 (compatible), scripts/release.ts:113–119; deployed release r-7d182a935ec966b5",
  "release_A_own": {
    "db_version": 4,
    "history_schema": "kenli.history/1",
    "history_meta_schema": "kenli.history-meta/1",
    "transfer_formats": ["srd-table.transfer/1"],
    "local_copy_formats": ["srd-table.local-copy/1"]
  },
  "release_B_data": {
    "db_version": 4,
    "history_schema": "kenli.history/1",
    "history_meta_schema": "kenli.history-meta/1",
    "transfer_formats": ["srd-table.transfer/1"],
    "local_copy_formats": ["srd-table.local-copy/1", "srd-table.local-copy/2"],
    "history_entry_schemas": ["kenli.history/1", "kenli.history/2"],
    "state_versions": [1, 2, 3]
  },
  "cases": [
    { "id": "D01-A-accepts-B", "own": "release_A_own", "data": "release_B_data", "check": "a2e1bae", "expect": true },
    { "id": "D02-A-refuses-history-v2-string", "own": "release_A_own", "data": { "patch": "release_B_data", "set": { "history_schema": "kenli.history/2" } }, "check": "a2e1bae", "expect": false, "note": "the trap: update_incompatible, no Update now on the installed iPad app" },
    { "id": "D03-A-refuses-without-copy1", "own": "release_A_own", "data": { "patch": "release_B_data", "set": { "local_copy_formats": ["srd-table.local-copy/2"] } }, "check": "a2e1bae", "expect": false },
    { "id": "D04-A-refuses-db5", "own": "release_A_own", "data": { "patch": "release_B_data", "set": { "db_version": 5 } }, "check": "a2e1bae", "expect": false },
    { "id": "D05-B-accepts-B", "own": "release_B_data", "data": "release_B_data", "check": "f011", "expect": true },
    { "id": "D06-B-refuses-C-without-history-v2", "own": "release_B_data", "data": { "patch": "release_B_data", "set": { "history_entry_schemas": ["kenli.history/1"] } }, "check": "f011", "expect": false },
    { "id": "D07-B-refuses-C-without-v3", "own": "release_B_data", "data": { "patch": "release_B_data", "set": { "state_versions": [1, 2] } }, "check": "f011", "expect": false },
    { "id": "D08-B-refuses-A-as-candidate", "own": "release_B_data", "data": "release_A_own", "check": "f011", "expect": false, "note": "no downgrade offered once B's data may exist" }
  ]
}
`;
