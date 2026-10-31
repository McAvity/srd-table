/**
 * kenli F-002 T03: the add-on checks on pack files (contract §6.3, items 1, 2 and 5), before any
 * preview or commit. The engine's loader overwrites an entity of an earlier pack with a later one
 * of the same id without a word (`createCatalog`), and filters by `sources`: these checks read the
 * raw split files instead, so an id that an earlier pack has — even one the record's filter hides —
 * can never be replaced. The definition and sheet equivalence (items 3–4) need the engine: the
 * worker's `checkAddon`. Pure; nothing is registered or written.
 */

import type { PackFiles } from "@/lib/canonical";

export type AddonCode =
  | "addon_patch"
  | "addon_creation"
  | "addon_forbidden_table"
  | "addon_id_collision"
  | "addon_source_filtered"
  | "addon_manifest_invalid";

export interface AddonProblem {
  readonly code: AddonCode;
  readonly detail: string;
  /** `addon_id_collision`: every colliding id, by table, with the earlier pack that has it. */
  readonly collisions?: readonly {
    readonly table: string;
    readonly id: string;
    readonly pack: string;
  }[];
}

/** Tables an add-on may never carry: they would change what a character is (§6.3.2). */
export const ADDON_FORBIDDEN_TABLES = ["classes", "subclasses", "species", "backgrounds"] as const;

interface Manifest {
  readonly id: string;
  readonly source: string | null;
  readonly requires: readonly string[];
  readonly tables: ReadonlyMap<string, string>;
  readonly patches: readonly unknown[];
  readonly creation: boolean;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function manifestOf(files: PackFiles, what: string): Manifest | AddonProblem {
  const raw = Object.hasOwn(files, "manifest.json") ? files["manifest.json"] : undefined;
  if (
    !isObj(raw) ||
    !isObj(raw.manifest) ||
    typeof raw.manifest.id !== "string" ||
    !isObj(raw.tables)
  )
    return { code: "addon_manifest_invalid", detail: `${what}: manifest.json` };
  const tables = new Map<string, string>();
  for (const [name, t] of Object.entries(raw.tables)) {
    if (!isObj(t) || typeof t.file !== "string")
      return { code: "addon_manifest_invalid", detail: `${what}: tables.${name}` };
    tables.set(name, t.file);
  }
  const requires = Array.isArray(raw.manifest.requires) ? raw.manifest.requires.map(String) : [];
  return {
    id: raw.manifest.id,
    source: typeof raw.manifest.source === "string" ? raw.manifest.source : null,
    requires,
    tables,
    patches: Array.isArray(raw.patches)
      ? raw.patches
      : raw.patches === undefined
        ? []
        : [raw.patches],
    creation: Object.hasOwn(raw, "creation") && raw.creation !== undefined,
  };
}

/** The ids of a table's entities in a pack's raw files (every entity, whatever `sources` says). */
function idsOf(files: PackFiles, file: string): string[] {
  const rows = Object.hasOwn(files, file) ? files[file] : undefined;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((r) => (isObj(r) && typeof r.id === "string" ? [r.id] : []));
}

/**
 * The add-on's own files against every earlier pack's (§6.3.1–2): no patches, no `creation`, no
 * forbidden table, `requires` only packs already in the context, and no id any earlier pack has
 * in the same table (all collisions listed). `null`: none of these problems.
 */
export function checkAddonFiles(
  previous: readonly { readonly id: string; readonly files: PackFiles }[],
  addon: PackFiles,
): AddonProblem | null {
  const m = manifestOf(addon, "add-on");
  if ("code" in m) return m;
  if (m.patches.length)
    return { code: "addon_patch", detail: `${m.id}: ${m.patches.length} patches` };
  if (m.creation) return { code: "addon_creation", detail: `${m.id}: creation` };
  for (const t of ADDON_FORBIDDEN_TABLES)
    if (m.tables.has(t)) return { code: "addon_forbidden_table", detail: `${m.id}: ${t}` };
  const earlier = new Set(previous.map((p) => p.id));
  for (const r of m.requires)
    if (!earlier.has(r))
      return { code: "addon_forbidden_table", detail: `${m.id} requires ${r}, not in the context` };
  const collisions: { table: string; id: string; pack: string }[] = [];
  for (const [table, file] of m.tables) {
    const mine = new Set(idsOf(addon, file));
    for (const p of previous) {
      const pm = manifestOf(p.files, p.id);
      if ("code" in pm) return pm;
      const theirs = pm.tables.get(table);
      if (!theirs) continue;
      for (const id of idsOf(p.files, theirs))
        if (mine.has(id)) collisions.push({ table, id, pack: p.id });
    }
  }
  if (collisions.length)
    return {
      code: "addon_id_collision",
      detail: collisions.map((c) => `${c.table}/${c.id} (${c.pack})`).join(", "),
      collisions,
    };
  return null;
}

/**
 * §6.3.5: a record whose `sources` filter excludes the add-on's `manifest.source` can't take it;
 * the filter is never widened to let it in.
 */
export function checkAddonSources(
  recordSources: readonly string[] | null,
  addon: PackFiles,
): AddonProblem | null {
  if (recordSources === null) return null;
  const m = manifestOf(addon, "add-on");
  if ("code" in m) return m;
  const source = m.source ?? m.id;
  return recordSources.includes(source)
    ? null
    : {
        code: "addon_source_filtered",
        detail: `the record's sources ${JSON.stringify(recordSources)} exclude ${source}; the filter isn't widened`,
      };
}
