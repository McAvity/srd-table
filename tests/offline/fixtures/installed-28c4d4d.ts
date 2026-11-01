/**
 * kenli F-002 T07 (dnd5 contracts/progression.md §10): the update gate of the installed F-011
 * release (r-bccac419bfb8a6ba, Table 28c4d4d67c2e78246a9b27b14177f5c3722012aa), as a fixture —
 * the release that was "this release" in D05–D08. The blocks below are verbatim lines 59–69 and
 * 617–630 of that commit's src/offline/update.ts (git blob 6be5fded444021b9f799b7cd3050e5692f7674be,
 * file sha256 e740afb9655fec3cf1bedcab19a234b7855659b4c90c74f46ca8a735528278b1); `export` was
 * dropped from the gate and re-added below. Only this comment, the type import and the last export
 * are added, so this repo's tests need no history.
 */
import type { ReleaseDescriptor } from "../../../src/offline/descriptor";

export const OWN_DATA = {
  db_version: 4,
  history_schema: "kenli.history/1",
  history_meta_schema: "kenli.history-meta/1",
  transfer_formats: ["srd-table.transfer/1"],
  local_copy_formats: ["srd-table.local-copy/1", "srd-table.local-copy/2"],
  history_entry_schemas: ["kenli.history/1", "kenli.history/2"],
  state_versions: [1, 2, 3],
} as const;
/** A release before F-011 declares neither list: what its data was. */
const PRE_F011 = { history_entry_schemas: ["kenli.history/1"], state_versions: [1, 2] } as const;

const compatible = (data: ReleaseDescriptor["inputs"]["data"] | undefined): boolean =>
  !!data &&
  data.db_version === OWN_DATA.db_version &&
  data.history_schema === OWN_DATA.history_schema &&
  data.history_meta_schema === OWN_DATA.history_meta_schema &&
  OWN_DATA.transfer_formats.every((f) => data.transfer_formats.includes(f)) &&
  OWN_DATA.local_copy_formats.every((f) => data.local_copy_formats.includes(f)) &&
  OWN_DATA.history_entry_schemas.every((f) =>
    (data.history_entry_schemas ?? PRE_F011.history_entry_schemas).includes(f),
  ) &&
  OWN_DATA.state_versions.every((v) =>
    (data.state_versions ?? PRE_F011.state_versions).includes(v),
  );

export { compatible };
