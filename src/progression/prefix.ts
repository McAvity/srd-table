/**
 * kenli F-002 T03: the mechanical projection of a build and its prefix hash (contract §4.1), the
 * field-by-field difference a refused bind shows (§4.2), the exact content-context comparison of
 * a bind or an advance (§6.1: pack refs as an exact prefix, `sources` as `contextKey` compares
 * them) and the append-only `build.packs` change of an add-on (§6.2). Pure: no engine, no worker.
 */

import type { CharacterBuild } from "srd-rules-engine";
import { type ContentContext, canonicalJson, contentSha, type PackRef } from "@/lib/canonical";

/** The only build fields that aren't mechanical choices (§4.1). Everything else counts. */
export const NON_MECHANICAL = ["name", "alignment", "version", "packs"] as const;

/** `build` without its name, alignment, document version and declared packs. */
export function mech(build: CharacterBuild): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(build))
    if (!(NON_MECHANICAL as readonly string[]).includes(k) && v !== undefined) out[k] = v;
  return out;
}

/** `prefix_sha256`: the SHA-256 of the canonical JSON of `mech(build)`. */
export const prefixSha256 = (build: CharacterBuild): Promise<string> => contentSha(mech(build));

/** One difference between a record's build and a plan's checkpoint (`bind_prefix_mismatch`). */
export interface FieldDifference {
  /** `class_id`, `choices[<key>]`, `levels[3]`, `levels.length`… */
  readonly path: string;
  readonly record: unknown;
  readonly plan: unknown;
}

const same = (a: unknown, b: unknown) => canonicalJson(a ?? null) === canonicalJson(b ?? null);

/** Every mechanical difference, choices by key and levels by index (historical HP included). */
export function mechDifferences(record: CharacterBuild, plan: CharacterBuild): FieldDifference[] {
  const a = mech(record);
  const b = mech(plan);
  const out: FieldDifference[] = [];
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  for (const k of keys) {
    if (k === "choices") {
      const ca = (a.choices ?? {}) as Record<string, unknown>;
      const cb = (b.choices ?? {}) as Record<string, unknown>;
      for (const key of [...new Set([...Object.keys(ca), ...Object.keys(cb)])].sort()) {
        const ra = Object.hasOwn(ca, key) ? ca[key] : undefined;
        const rb = Object.hasOwn(cb, key) ? cb[key] : undefined;
        if (!same(ra, rb))
          out.push({ path: `choices[${key}]`, record: ra ?? null, plan: rb ?? null });
      }
    } else if (k === "levels") {
      const la = (a.levels ?? []) as unknown[];
      const lb = (b.levels ?? []) as unknown[];
      if (la.length !== lb.length)
        out.push({ path: "levels.length", record: la.length, plan: lb.length });
      for (let i = 0; i < Math.min(la.length, lb.length); i++)
        if (!same(la[i], lb[i])) out.push({ path: `levels[${i}]`, record: la[i], plan: lb[i] });
    } else if (!same(a[k], b[k])) out.push({ path: k, record: a[k] ?? null, plan: b[k] ?? null });
  }
  return out;
}

// ───────────────────────── content context (§6.1) ─────────────────────────

const sameRef = (a: PackRef, b: PackRef) =>
  a.id === b.id && a.version === b.version && a.sha256 === b.sha256;

/** `sources` as `contextKey` compares them: a sorted set; `null` (no filter) differs from any list. */
export const sourcesKey = (s: readonly string[] | null): string | null =>
  s === null ? null : canonicalJson([...new Set(s)].sort());

export type SourcesDifference = "null_to_list" | "list_to_null" | "list_changed";

/** How a record's effective `sources` differ from the plan's, or `null` when equal. */
export function sourcesDifference(
  record: readonly string[] | null,
  plan: readonly string[] | null,
): SourcesDifference | null {
  if (sourcesKey(record) === sourcesKey(plan)) return null;
  if (record === null) return "null_to_list";
  if (plan === null) return "list_to_null";
  return "list_changed";
}

export type ContextComparison =
  | { readonly ok: true; readonly kind: "equal" }
  /** The plan's refs continue the record's: the extra ones must pass the add-on checks (§6.3). */
  | { readonly ok: true; readonly kind: "addon"; readonly extra: readonly PackRef[] }
  | {
      readonly ok: false;
      readonly code: "bind_old_ref_changed" | "bind_context_mismatch" | "context_sources_mismatch";
      readonly detail: string;
      readonly sources?: SourcesDifference;
      readonly index?: number;
    };

/**
 * A record's effective context against a plan's (§6.1): the record's packs an exact prefix of the
 * plan's (id, version, hash, order), and `sources` equal as `contextKey` compares them. Nothing is
 * widened, narrowed or changed here.
 */
export function compareContext(record: ContentContext, plan: ContentContext): ContextComparison {
  for (const [i, r] of record.packs.entries()) {
    const p = plan.packs[i];
    if (!p)
      return {
        ok: false,
        code: "bind_context_mismatch",
        detail: `record pack ${r.id} at ${i} isn't in the plan`,
        index: i,
      };
    if (sameRef(r, p)) continue;
    if (r.id === p.id)
      return {
        ok: false,
        code: "bind_old_ref_changed",
        detail: `${r.id}: record ${r.version ?? ""}#${r.sha256} ≠ plan ${p.version ?? ""}#${p.sha256}`,
        index: i,
      };
    return {
      ok: false,
      code: "bind_context_mismatch",
      detail: `pack ${i}: record ${r.id} ≠ plan ${p.id}`,
      index: i,
    };
  }
  const sources = sourcesDifference(record.sources, plan.sources);
  if (sources)
    return {
      ok: false,
      code: "context_sources_mismatch",
      detail: `${sources}: record ${JSON.stringify(record.sources)} ≠ plan ${JSON.stringify(plan.sources)}`,
      sources,
    };
  const extra = plan.packs.slice(record.packs.length);
  return extra.length ? { ok: true, kind: "addon", extra } : { ok: true, kind: "equal" };
}

// ───────────────────────── build.packs, append only (§6.2) ─────────────────────────

/** Whether `next` is `previous` with ids added at its end only (nothing removed or reordered). */
export function isAppendOnly(
  previous: readonly string[] | undefined,
  next: readonly string[] | undefined,
): boolean {
  const a = previous ?? [];
  const b = next ?? [];
  return b.length >= a.length && a.every((id, i) => b[i] === id);
}

export type AppendResult =
  | { readonly ok: true; readonly build: CharacterBuild; readonly appended: boolean }
  | { readonly ok: false; readonly code: "bind_build_packs_not_append"; readonly detail: string };

/**
 * `build.packs` with `id` added at the end (§6.2 `appendBuildPack`), the result read again by the
 * engine's `parseBuild` (passed in: the facade's, or the engine's own in Node). Already the last
 * one: unchanged. Anywhere else already: refused (an append never reorders).
 */
export async function appendBuildPack(
  build: CharacterBuild,
  id: string,
  parse: (
    input: unknown,
  ) => Promise<{ ok: true; build: CharacterBuild } | { ok: false; reasons: readonly string[] }>,
): Promise<AppendResult> {
  const packs = build.packs ?? [];
  if (packs.at(-1) === id) return { ok: true, build, appended: false };
  if (packs.includes(id))
    return {
      ok: false,
      code: "bind_build_packs_not_append",
      detail: `${id} is already at ${packs.indexOf(id)}`,
    };
  const next = { ...build, packs: [...packs, id] };
  const parsed = await parse(next);
  if (!parsed.ok)
    return { ok: false, code: "bind_build_packs_not_append", detail: parsed.reasons.join("; ") };
  if (!isAppendOnly(build.packs, parsed.build.packs))
    return { ok: false, code: "bind_build_packs_not_append", detail: "parse changed the order" };
  return { ok: true, build: parsed.build, appended: true };
}
