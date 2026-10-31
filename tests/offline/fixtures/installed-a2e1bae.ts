/**
 * kenli F-011 §7 (review03 R03-15): the update gate of the installed release A, as a fixture.
 * Release r-7d182a935ec966b5 (deployed) was built from Table
 * a2e1baedd3328500a6cc1e60312158119e3f922d; the two blocks below are verbatim lines 54–60 and
 * 603–609 of its src/offline/update.ts (git blob 1f0f366a625ee5368ef9b095f40da8c354a9f6d0, file
 * sha256 9b72ff8e2392113a0338d952fd19d87a0924bf2a6b624b294df60d6c4cf57db7). Only this comment,
 * the type import and the last export are added. The dnd5 workspace checks the blocks against that commit
 * (tests/unit/f011-release-fixtures.test.ts), so this repo's tests need no history.
 */
import type { ReleaseDescriptor } from "../../../src/offline/descriptor";

export const OWN_DATA = {
  db_version: 4,
  history_schema: "kenli.history/1",
  history_meta_schema: "kenli.history-meta/1",
  transfer_formats: ["srd-table.transfer/1"],
  local_copy_formats: ["srd-table.local-copy/1"],
} as const;

const compatible = (data: ReleaseDescriptor["inputs"]["data"] | undefined): boolean =>
  !!data &&
  data.db_version === OWN_DATA.db_version &&
  data.history_schema === OWN_DATA.history_schema &&
  data.history_meta_schema === OWN_DATA.history_meta_schema &&
  OWN_DATA.transfer_formats.every((f) => data.transfer_formats.includes(f)) &&
  OWN_DATA.local_copy_formats.every((f) => data.local_copy_formats.includes(f));

export { compatible };
