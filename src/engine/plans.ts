/**
 * kenli F-002 T03: the facade's progression-plan operations, in the worker (or `nodeFacade`):
 * `compilePlan` (one call: codec, exact context, the whole setter batch, checkpoints) and
 * `checkAddon` (the add-on bind checks of contract §6.3 that need the engine). Catalogs are built
 * here from the context's exact files — registered or served packs, or the plan's own verified
 * envelopes, which are used for the call only and never registered. Results are memoised by
 * `(plan_sha256, contextKey)`; nothing is stored or written.
 */

import {
  type Catalog,
  type CharacterBuild,
  type CharacterState,
  ContentError,
  computePlaySheet,
  createCatalog,
  evaluate,
  loadPack,
  lookup,
  reconcileState,
  TABLE_NAMES,
} from "srd-rules-engine";
import {
  type ContentContext,
  canonicalJson,
  contextKey,
  type PackFiles,
  type PackRef,
  packRefOf,
} from "@/lib/canonical";
import { type AddonProblem, checkAddonFiles, checkAddonSources } from "@/progression/addon";
import {
  checkPackOrder,
  type PlanProblem,
  PlanRefusal,
  parsePlanFile,
  refLabel,
} from "@/progression/codec";
import { compareContext } from "@/progression/prefix";
import type { ContentRegistry } from "./content";
import { compileParsedPlan, type PlanCompileResult } from "./progression";

export type { PlanCheckpoint, PlanCompileResult, ReadableOp, StatChange } from "./progression";

/** The add-on bind checks a record needs before its preview (§6.3). */
export interface AddonCheckRequest {
  readonly build: CharacterBuild;
  readonly state: CharacterState;
  /** The record's effective context now (its own, or the campaign's it would pin). */
  readonly record: ContentContext;
  /** The plan's context: the record's refs, then the add-on's. */
  readonly plan: ContentContext;
  /** Files of packs not registered here (a plan's envelopes): used for this check only. */
  readonly packs?: readonly PackFiles[];
}

export type AddonCheckResult =
  | { readonly ok: true; readonly extra: readonly PackRef[] }
  | {
      readonly ok: false;
      readonly code:
        | AddonProblem["code"]
        | "addon_definition_changed"
        | "addon_sheet_changed"
        | "addon_not_addon"
        | "bind_old_ref_changed"
        | "bind_context_mismatch"
        | "context_sources_mismatch"
        | "pack_identity_mismatch"
        | "plan_pack_missing";
      readonly detail: string;
      /** The first differing paths (`addon_definition_changed`, `addon_sheet_changed`). */
      readonly paths?: readonly string[];
      readonly collisions?: AddonProblem["collisions"];
    };

/** The first `max` paths where two JSON values differ. */
export function differingPaths(a: unknown, b: unknown, max = 12, path = "$"): string[] {
  const out: string[] = [];
  const walk = (x: unknown, y: unknown, p: string) => {
    if (out.length >= max) return;
    if (canonicalJson(x ?? null) === canonicalJson(y ?? null)) return;
    if (
      x &&
      y &&
      typeof x === "object" &&
      typeof y === "object" &&
      Array.isArray(x) === Array.isArray(y)
    ) {
      const keys = Array.isArray(x)
        ? [...Array(Math.max(x.length, (y as unknown[]).length)).keys()].map(String)
        : [...new Set([...Object.keys(x), ...Object.keys(y as object)])].sort();
      for (const k of keys)
        walk(
          (x as Record<string, unknown>)[k],
          (y as Record<string, unknown>)[k],
          Array.isArray(x) ? `${p}[${k}]` : `${p}.${k}`,
        );
      return;
    }
    out.push(p);
  };
  walk(a, b, path);
  return out;
}

const MAX_MEMO = 8;

export function planMethods(content: ContentRegistry) {
  const memo = new Map<string, PlanCompileResult>();

  /** The exact ref the files really are (`packRefOf`), once per files object. */
  const identities = new WeakMap<object, Promise<PackRef>>();
  const actualRef = (files: PackFiles): Promise<PackRef> => {
    let ref = identities.get(files);
    if (!ref) {
      ref = packRefOf(files);
      identities.set(files, ref);
    }
    return ref;
  };

  /**
   * A context's files for an exact ref (§2.3): the call's own envelopes by hash first, else the
   * ones registered or served here — and then, whatever their source, the ref they really are
   * (`packRefOf`: manifest id and version, hash of the files) must be the requested one in all
   * three fields. A hash alone never vouches for an id or a version; nothing is corrected.
   */
  async function exactFiles(
    ref: PackRef,
    extra: ReadonlyMap<string, PackFiles>,
  ): Promise<
    | { readonly ok: true; readonly files: PackFiles }
    | { readonly ok: false; readonly missing: true }
    | { readonly ok: false; readonly missing: false; readonly actual: PackRef }
  > {
    const files = extra.get(ref.sha256) ?? (await content.localFiles(ref));
    if (!files) return { ok: false, missing: true };
    const actual = await actualRef(files);
    if (actual.id !== ref.id || actual.version !== ref.version || actual.sha256 !== ref.sha256)
      return { ok: false, missing: false, actual };
    return { ok: true, files };
  }
  const identityDetail = (ref: PackRef, actual: PackRef) =>
    `requested ${refLabel(ref)}, the files are ${refLabel(actual)}`;

  async function catalogOf(ctx: ContentContext, files: readonly PackFiles[]): Promise<Catalog> {
    const packs = await Promise.all(
      files.map((f) =>
        loadPack(
          async (file) => {
            if (!Object.hasOwn(f, file)) throw new ContentError(`missing file ${file}`);
            return f[file];
          },
          { tables: TABLE_NAMES },
        ),
      ),
    );
    return createCatalog(packs, {
      tables: TABLE_NAMES,
      ...(ctx.sources ? { sources: [...ctx.sources] } : {}),
    });
  }

  async function compilePlan(input: unknown): Promise<PlanCompileResult> {
    const parsed = await parsePlanFile(input);
    if (!parsed.ok)
      return { ok: false, plan_sha256: null, problem: parsed.problem, checkpoints: [] };
    const plan = parsed.file.plan;
    const ctx: ContentContext = { packs: plan.packs, sources: plan.sources };
    const key = `${parsed.plan_sha256}\n${contextKey(ctx)}`;
    const refused = (problem: PlanProblem): PlanCompileResult => ({
      ok: false,
      plan_sha256: parsed.plan_sha256,
      problem,
      checkpoints: [],
    });
    const extra = new Map<string, PackFiles>(
      [...parsed.envelopes].map(([sha, env]) => [sha, (env.content as { files: PackFiles }).files]),
    );
    const files: PackFiles[] = [];
    const requires = new Map<string, readonly string[]>();
    for (const ref of plan.packs) {
      const found = await exactFiles(ref, extra);
      if (!found.ok)
        return refused(
          found.missing
            ? { code: "plan_pack_missing", detail: refLabel(ref) }
            : { code: "plan_pack_identity", detail: identityDetail(ref, found.actual) },
        );
      const f = found.files;
      const m = (f["manifest.json"] as { manifest?: { requires?: unknown } } | undefined)?.manifest;
      requires.set(ref.id, Array.isArray(m?.requires) ? m.requires.map(String) : []);
      files.push(f);
    }
    // An envelope's `requires` must name the plan's exact refs of the packs it needs.
    for (const env of parsed.envelopes.values())
      for (const r of env.requires) {
        const want = plan.packs.find((p) => p.id === r.id);
        if (!want || want.sha256 !== r.sha256)
          return refused({
            code: "plan_pack_invalid",
            detail: `${env.id} requires ${r.id}#${r.sha256}`,
          });
      }
    try {
      checkPackOrder(plan.packs, requires);
    } catch (error) {
      if (error instanceof PlanRefusal) return refused(error.problem);
      throw error;
    }
    // The memo only after the exact files are found and the envelopes checked: a plan seen
    // before still needs its packs here.
    const hit = memo.get(key);
    if (hit) return hit;
    let catalog: Catalog;
    try {
      catalog = await catalogOf(ctx, files);
    } catch (error) {
      return refused({
        code: "plan_pack_invalid",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
    const result = await compileParsedPlan(parsed, catalog, ctx, contextKey(ctx));
    memo.set(key, result);
    if (memo.size > MAX_MEMO) memo.delete(memo.keys().next().value as string);
    return result;
  }

  async function checkAddon(req: AddonCheckRequest): Promise<AddonCheckResult> {
    const cmp = compareContext(req.record, req.plan);
    if (!cmp.ok) return { ok: false, code: cmp.code, detail: cmp.detail };
    if (cmp.kind !== "addon")
      return { ok: false, code: "addon_not_addon", detail: "the plan adds no pack" };
    const extra = new Map<string, PackFiles>();
    for (const f of req.packs ?? []) {
      const ref = await packRefOf(f);
      extra.set(ref.sha256, f);
    }
    const previous: { id: string; files: PackFiles }[] = [];
    const oldFiles: PackFiles[] = [];
    for (const ref of req.record.packs) {
      const found = await exactFiles(ref, extra);
      if (!found.ok)
        return found.missing
          ? { ok: false, code: "plan_pack_missing", detail: refLabel(ref) }
          : {
              ok: false,
              code: "pack_identity_mismatch",
              detail: identityDetail(ref, found.actual),
            };
      const f = found.files;
      previous.push({ id: ref.id, files: f });
      oldFiles.push(f);
    }
    const newFiles = [...oldFiles];
    for (const ref of cmp.extra) {
      const found = await exactFiles(ref, extra);
      if (!found.ok)
        return found.missing
          ? { ok: false, code: "plan_pack_missing", detail: refLabel(ref) }
          : {
              ok: false,
              code: "pack_identity_mismatch",
              detail: identityDetail(ref, found.actual),
            };
      const f = found.files;
      const own = checkAddonSources(req.record.sources, f) ?? checkAddonFiles(previous, f);
      if (own) return { ok: false, ...own };
      previous.push({ id: ref.id, files: f });
      newFiles.push(f);
    }
    const before = await catalogOf(req.record, oldFiles);
    const after = await catalogOf(req.plan, newFiles);
    // §6.3.3: every old entity's definition unchanged.
    const changed: string[] = [];
    for (const table of TABLE_NAMES) {
      const old = before[table] as Record<string, unknown>;
      for (const id of Object.keys(old)) {
        const was = lookup(old, id);
        const now = lookup(after[table] as Record<string, unknown>, id);
        if (canonicalJson(was ?? null) !== canonicalJson(now ?? null))
          changed.push(`${table}/${id}`);
        if (changed.length >= 12) break;
      }
    }
    if (canonicalJson(before.creation) !== canonicalJson(after.creation)) changed.push("creation");
    if (changed.length)
      return {
        ok: false,
        code: "addon_definition_changed",
        detail: changed.join(", "),
        paths: changed,
      };
    // §6.3.4: the build's evaluation and sheet, the play sheet and reconciliation unchanged, and the
    // stored state already the reconciled one.
    const view = (cat: Catalog) => {
      const ev = evaluate(req.build, cat);
      const play = computePlaySheet(req.build, req.state, cat);
      const rec = reconcileState(req.build, req.state, cat);
      return { report: ev.report, sheet: ev.sheet, play, reconciled: rec.state };
    };
    const a = view(before);
    const b = view(after);
    const paths = differingPaths(a, b);
    if (paths.length)
      return {
        ok: false,
        code: "addon_sheet_changed",
        detail: paths.slice(0, 5).join(", "),
        paths,
      };
    const stateDiff = differingPaths(req.state, b.reconciled, 12, "$.state");
    if (stateDiff.length)
      return {
        ok: false,
        code: "addon_sheet_changed",
        detail: `the stored state isn't the reconciled one: ${stateDiff.slice(0, 5).join(", ")}`,
        paths: stateDiff,
      };
    return { ok: true, extra: cmp.extra };
  }

  return { compilePlan, checkAddon };
}
