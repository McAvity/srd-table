/**
 * kenli F-002 T04: planned start, bind and advance of a character (dnd5 contracts/progression.md
 * §4–8). The production API T05's screens call; no UI here.
 *
 * - `previewAdvance` / `previewBind` stage the next version on copies — the build from the plan's
 *   checkpoint (compiled in the worker, `compilePlan` with its exact id/version/hash guard), the
 *   state reconciled and required to stay canonically the same (§8) — and return what changes
 *   with a token over the snapshot (`rev`, `gen`, the effective context and, for a record on the
 *   campaign's packs, the settings fingerprint, the plan hash, the applied level, the journal
 *   head) and the staged result. Nothing is written; refusals say why (busy with an open roll or
 *   a pending decision, a conflict, a divergence, a prefix or context mismatch, a state loss).
 * - `confirmStep` takes the documents' queues (`lockDocuments`: the character and every encounter
 *   it is in), stages again and requires the same token (`preview_stale` otherwise), flushes the
 *   autosave, then writes ONE transaction — the character (compare-and-set on `rev`), its
 *   `level_up` journal entry (`kenli.history/3`) and head (compare-and-set on the head's `rev`),
 *   and for a bind the add-on's packs — the pattern of `import/commit.ts`. Only after `tx.done`,
 *   in one synchronous block: the store (one undo step), the journal and the autosave baseline
 *   (`markCommitted`), so the autosave neither writes it again nor reports a false conflict. A
 *   failed transaction publishes nothing.
 * - `startFromPlan` makes a NEW character at a chosen checkpoint (new id, fresh state, the plan's
 *   exact context, its packs) in one transaction; `detachProgression` drops only the plan
 *   association (one undo step), never the documents, content or journal.
 *
 * A bound or advanced character keeps its id, name, alignment, declared packs, origin, portrait,
 * journal, days, encounter links and its whole play state: no `createState`, no rest, no new day,
 * no revival at 0 HP.
 */

import type { CharacterBuild, CharacterState } from "srd-rules-engine";
import { engine } from "@/engine/client";
import type { PlayView } from "@/engine/facade";
import type { PlanCheckpoint, PlanCompileResult, ReadableOp } from "@/engine/plans";
import { campaignContext } from "@/import/export";
import {
  type ContentContext,
  contentSha,
  contextKey,
  type PackFiles,
  type PackRef,
} from "@/lib/canonical";
import { admission, UPDATE_IN_PROGRESS } from "@/offline/admission";
import { settingsFingerprint } from "@/offline/campaign";
import { db, packKey, type StoredPack } from "@/persistence/db";
import { flushNow, markCommitted, savedHead, writeQueue } from "@/persistence/sync";
import {
  type CharacterRecord,
  characterKeysOf,
  lockDocuments,
  newId,
  stageCharacter,
  useDocuments,
} from "@/store/documents";
import {
  type HistoryEntry,
  type HistoryMeta,
  type LevelUpRecord,
  newMeta,
  newOperationId,
  type OperationId,
  useHistory,
} from "@/store/history";
import { openRoll, useRolls } from "@/store/rolls";
import { useSettings } from "@/store/settings";
import { parsePlanFile } from "./codec";
import {
  appendBuildPack,
  compareContext,
  type FieldDifference,
  mechDifferences,
  prefixSha256,
} from "./prefix";
import {
  PROGRESSION_SCHEMA,
  type ProgressionMeta,
  planWithoutPacks,
  readProgression,
  type StateDifference,
  stateDifferences,
} from "./record";
import { nextStep } from "./steps";

// ───────────────────────── results ─────────────────────────

/** Why a planned action was refused: nothing changed (a stable code for T05, then details). */
export interface ProgressionRefusal {
  readonly ok: false;
  readonly code: string;
  readonly detail: string;
  /** `advance_busy`: what to finish first — the open roll (`useRolls.forget`) or a decision. */
  readonly busy?:
    | { readonly kind: "roll"; readonly record_id: string }
    | { readonly kind: "decision"; readonly encounters: readonly string[] };
  /** `bind_prefix_mismatch` / `advance_diverged`: record vs plan, field by field. */
  readonly differences?: readonly FieldDifference[];
  /** A state the step would change (§8): every path, classified. */
  readonly state?: readonly StateDifference[];
}
const no = (
  code: string,
  detail = "",
  extra: Partial<ProgressionRefusal> = {},
): ProgressionRefusal => ({
  ok: false,
  code,
  detail,
  ...extra,
});

/** The played state's numbers before and after (the record's own inventory: bought armor counts). */
export interface PlayedStats {
  readonly level: number;
  readonly hp_max: number;
  readonly hp_current: number;
  readonly hp_temp: number;
  readonly armor_class: number;
  readonly proficiency_bonus: number;
  readonly hit_dice: readonly {
    readonly die: number;
    readonly total: number;
    readonly spent: number;
  }[];
  readonly spell_slots: readonly {
    readonly level: number;
    readonly total: number;
    readonly spent: number;
  }[];
  readonly uses: readonly {
    readonly key: string;
    readonly name: string;
    readonly max: number;
    readonly spent: number;
  }[];
  readonly actions: readonly string[];
}

export interface StepPreview {
  readonly ok: true;
  readonly kind: "advance" | "bind";
  readonly record_id: string;
  /** sha256(canonical(snapshot + staged result)): confirm requires the same. */
  readonly token: string;
  readonly from_level: number;
  readonly to_level: number;
  readonly class_id: string;
  readonly class_level: number;
  /** The step's choices as the engine names them (a bind: none). */
  readonly choices: readonly ReadableOp[];
  readonly before: PlayedStats;
  readonly after: PlayedStats;
  readonly new_actions: readonly string[];
  readonly warnings: readonly { readonly code: string; readonly detail: string }[];
  readonly packs_added: readonly PackRef[];
  /** The record's content after the step (a bind pins the plan's exact context). */
  readonly context: ContentContext;
  /** The record version the step would write (rev + 1; gen + 1 when the content changes). */
  readonly staged: CharacterRecord;
  /** A bind's plan file, as given (with its envelopes), for the confirm. */
  readonly plan_file?: unknown;
}

export type Confirmed = {
  readonly ok: true;
  readonly record: CharacterRecord;
  readonly op: OperationId;
};

// ───────────────────────── staging ─────────────────────────

interface Staged {
  readonly ok: true;
  readonly read: CharacterRecord;
  readonly preview: StepPreview;
  readonly entry: LevelUpRecord;
  /** Pack rows the bind adds (not stored here yet). */
  readonly packs: readonly StoredPack[];
}

const levelOf = (b: CharacterBuild) => (b.class_id ? 1 + b.levels.length : 0);

/** The encounters a character is in (their queues are held by a confirm). */
function encountersWith(id: string): string[] {
  return Object.values(useDocuments.getState().encounters)
    .filter((e) => characterKeysOf(e.encounter).includes(id))
    .map((e) => e.id);
}

/** A step can't start while the character has something open (§7.2.1). */
function busyOf(record: CharacterRecord): ProgressionRefusal | null {
  if (openRoll(useRolls.getState().last[record.id], record))
    return no("advance_busy", "the last roll can still be changed", {
      busy: { kind: "roll", record_id: record.id },
    });
  const pending = Object.values(useDocuments.getState().encounters)
    .filter((e) => e.encounter.pending && characterKeysOf(e.encounter).includes(record.id))
    .map((e) => e.id);
  if (pending.length)
    return no("advance_busy", "an encounter waits for a decision", {
      busy: { kind: "decision", encounters: pending },
    });
  if (savedHead(record.id).conflicted)
    return no(
      "advance_unsaved_conflict",
      "this character was changed in another tab: reload first",
    );
  return null;
}

/** The record's effective context (§6.1): its own, else the campaign's, with the settings' fingerprint. */
async function effectiveContext(
  record: CharacterRecord,
): Promise<{ ctx: ContentContext; fingerprint: string | null }> {
  if (record.content) return { ctx: record.content, fingerprint: null };
  const { packs, sources } = useSettings.getState().settings;
  return { ctx: await campaignContext(), fingerprint: await settingsFingerprint(packs, sources) };
}

function playedStats(view: PlayView): PlayedStats {
  const s = view.sheet;
  return {
    level: s.level,
    hp_max: s.play.hp.max,
    hp_current: s.play.hp.current,
    hp_temp: s.play.hp.temp,
    armor_class: s.armor_class.total,
    proficiency_bonus: s.proficiency_bonus,
    hit_dice: s.play.hit_dice.map((h) => ({ die: h.die, total: h.total, spent: h.spent })),
    spell_slots: s.play.spell_slots.map((x) => ({
      level: x.level,
      total: x.total,
      spent: x.spent,
    })),
    uses: s.play.uses.map((u) => ({ key: u.key, name: u.name, max: u.max, spent: u.spent })),
    actions: s.actions.map((a) => a.name),
  };
}

function warningsOf(state: CharacterState): { code: string; detail: string }[] {
  return state.hp.current === 0
    ? [
        {
          code: "zero_hp_no_revive",
          detail: "at 0 HP: the step changes the maximum, not the current HP (no revival)",
        },
      ]
    : [];
}

/** The plan's checkpoint as the record's next build: its own name, alignment and declared packs kept. */
async function asRecordBuild(
  record: CharacterRecord,
  checkpoint: CharacterBuild,
  packs?: readonly string[],
) {
  const { packs: _p, ...mechanical } = checkpoint;
  const declared = packs ?? record.build.packs;
  const parsed = await engine().parseBuild({
    ...mechanical,
    name: record.build.name,
    alignment: record.build.alignment,
    ...(declared ? { packs: [...declared] } : {}),
  });
  return parsed.ok ? parsed.build : null;
}

/** §8: the state reconciled with the new build, required unchanged. */
async function keptState(build: CharacterBuild, record: CharacterRecord, ctx: ContentContext) {
  const fitted = await engine().reconcileState(build, record.state, ctx);
  const lost = stateDifferences(record.state, fitted.state);
  return lost.length
    ? no(lost[0]?.code ?? "state_changed", lost.map((d) => d.path).join(", "), { state: lost })
    : null;
}

/** A pack served with the app under exactly this ref (id, version and hash), without a stored copy. */
async function servedExactly(ref: PackRef): Promise<boolean> {
  const served = await engine()
    .servedPack(ref.id)
    .catch(() => null);
  return (
    !!served &&
    served.id === ref.id &&
    served.version === ref.version &&
    served.sha256 === ref.sha256
  );
}

/** The new packs for the worker, before any durable write: a failure is a refusal, nothing written. */
async function registerBefore(rows: readonly StoredPack[]): Promise<ProgressionRefusal | null> {
  if (!rows.length) return null;
  try {
    await engine().registerPacks(rows.map((r) => r.files));
    return null;
  } catch (error) {
    return no("pack_register_failed", error instanceof Error ? error.message : String(error));
  }
}

const tokenOf = async (snapshot: unknown, result: unknown) => contentSha({ snapshot, result });

function compileRefusal(r: Extract<PlanCompileResult, { ok: false }>): ProgressionRefusal {
  return no(r.problem.code, r.problem.detail);
}

async function stageAdvance(id: string): Promise<Staged | ProgressionRefusal> {
  const record = useDocuments.getState().characters[id];
  if (!record) return no("missing", id);
  const read = await readProgression(record.progression);
  if (!read.ok) return no(read.code, read.detail);
  const prog = read.progression;
  if (!prog) return no("progression_none", "this character follows no plan");
  const busy = busyOf(record);
  if (busy) return busy;
  const { ctx, fingerprint } = await effectiveContext(record);
  const planCtx: ContentContext = { packs: prog.plan.plan.packs, sources: prog.plan.plan.sources };
  const cmp = compareContext(ctx, planCtx);
  if (!cmp.ok) return no(cmp.code, cmp.detail);
  if (cmp.kind !== "equal")
    return no("advance_context_mismatch", "the record's content isn't the plan's");
  const compiled = await engine().compilePlan(prog.plan);
  if (!compiled.ok) return compileRefusal(compiled);
  const L = levelOf(record.build);
  if (L !== prog.applied_level)
    return no("advance_diverged", `level ${L}, the plan says ${prog.applied_level}`);
  const at = compiled.checkpoints[L - 1] as PlanCheckpoint;
  const differences = mechDifferences(record.build, at.build);
  if (differences.length || (await prefixSha256(record.build)) !== prog.prefix_sha256)
    return no("advance_diverged", "the build was changed outside the plan", { differences });
  const next = nextStep(compiled, L);
  if (next.kind === "done") return no("advance_done", `the plan ends at level ${L}`);
  if (next.kind === "refused") return no(next.code, next.detail);
  const build = await asRecordBuild(record, next.to.build);
  if (!build || mechDifferences(build, next.to.build).length)
    return no("advance_build_invalid", "the checkpoint");
  const lost = await keptState(build, record, ctx);
  if (lost) return lost;
  const progression: ProgressionMeta = {
    ...prog,
    applied_level: next.to.level,
    prefix_sha256: next.to.prefix_sha256,
  };
  const before = playedStats(await engine().playSheet(record.build, record.state, ctx));
  const after = playedStats(await engine().playSheet(build, record.state, ctx));
  const staged = stageCharacter(record, { build, state: record.state, progression });
  const snapshot = {
    kind: "advance",
    record_id: id,
    rev: record.rev ?? 0,
    gen: record.gen ?? 0,
    context_key: contextKey(ctx),
    fingerprint,
    plan_sha256: prog.plan.plan_sha256,
    applied_level: prog.applied_level,
    history_rev: savedHead(id).rev,
  };
  const entry: LevelUpRecord = {
    mode: "advance",
    from_level: L,
    to_level: next.to.level,
    class_id: next.to.class_id,
    class_level: next.to.class_level,
    plan_sha256: prog.plan.plan_sha256,
    step_choices: next.to.ops.flatMap((o) =>
      o.op === "choice" && o.key && o.values
        ? [
            {
              key: o.key,
              values: [...o.values],
              ...(o.key.includes("#replace:") && o.values[0] ? { replaced: o.values[0] } : {}),
            },
          ]
        : [],
    ),
    packs_added: [],
  };
  return {
    ok: true,
    read: record,
    entry,
    packs: [],
    preview: {
      ok: true,
      kind: "advance",
      record_id: id,
      token: await tokenOf(snapshot, { build, state: record.state, progression, entry }),
      from_level: L,
      to_level: next.to.level,
      class_id: next.to.class_id,
      class_level: next.to.class_level,
      choices: next.to.ops,
      before,
      after,
      new_actions: after.actions.filter((a) => !before.actions.includes(a)),
      warnings: warningsOf(record.state),
      packs_added: [],
      context: ctx,
      staged,
    },
  };
}

async function stageBind(id: string, file: unknown): Promise<Staged | ProgressionRefusal> {
  const record = useDocuments.getState().characters[id];
  if (!record) return no("missing", id);
  const current = await readProgression(record.progression);
  if (!current.ok) return no(current.code, current.detail);
  if (current.progression) return no("progression_bound", "this character already follows a plan");
  const busy = busyOf(record);
  if (busy) return busy;
  const parsed = await parsePlanFile(file);
  if (!parsed.ok) return no(parsed.problem.code, parsed.problem.detail);
  const planFile = parsed.file;
  const { ctx, fingerprint } = await effectiveContext(record);
  const planCtx: ContentContext = { packs: planFile.plan.packs, sources: planFile.plan.sources };
  const cmp = compareContext(ctx, planCtx);
  if (!cmp.ok) return no(cmp.code, cmp.detail);
  // The plan compiled with its exact refs (envelopes for this call only, the identity guard).
  const compiled = await engine().compilePlan(file);
  if (!compiled.ok) return compileRefusal(compiled);
  const L = levelOf(record.build);
  if (L < 1 || L > compiled.range.to)
    return no("bind_level_beyond_plan", `level ${L}, the plan has 1–${compiled.range.to}`);
  const at = compiled.checkpoints[L - 1] as PlanCheckpoint;
  const differences = mechDifferences(record.build, at.build);
  if (differences.length)
    return no("bind_prefix_mismatch", `${differences.length} differences`, { differences });
  const envelopeFiles = new Map<string, PackFiles>(
    [...parsed.envelopes].map(([sha, env]) => [sha, (env.content as { files: PackFiles }).files]),
  );
  let build = record.build;
  if (cmp.kind === "addon") {
    // §6.3: every add-on check before any preview (raw collisions incl. filtered ids, definitions,
    // the build's evaluation and sheet, the play sheet and the reconciled state).
    const check = await engine().checkAddon({
      build: record.build,
      state: record.state,
      record: ctx,
      plan: planCtx,
      packs: [...envelopeFiles.values()],
    });
    if (!check.ok) return no(check.code, check.detail);
    let next = record.build;
    for (const ref of cmp.extra) {
      const appended = await appendBuildPack(next, ref.id, (v) => engine().parseBuild(v));
      if (!appended.ok) return no(appended.code, appended.detail);
      next = appended.build;
    }
    build = next;
  }
  // Packs the record's new content needs that the database doesn't hold yet: from the envelopes.
  const database = await db();
  const rows: StoredPack[] = [];
  for (const ref of planCtx.packs) {
    if (await database.getKey("packs", packKey(ref))) continue;
    const files = envelopeFiles.get(ref.sha256);
    if (!files) {
      // Served with the app under exactly this ref (the SRD): available without a stored copy,
      // whatever kind of bind this is (R06-02). Anything else missing is refused.
      if (await servedExactly(ref)) continue;
      return no("plan_pack_missing", `${ref.id}@${ref.version ?? ""}#${ref.sha256}`);
    }
    rows.push({
      key: packKey(ref),
      ref,
      files,
      installed_at: 0,
      origin: { kind: "import", bytes_sha256: null },
    });
  }
  // The verified exact refs for this session's worker (as an import's preview does): the state
  // and sheets are then read in the plan's very context. Nothing is written. This is the only
  // registration of a bind — before its transaction (staged again under the confirm's lock), so a
  // failing worker leaves nothing behind (R06-01).
  const registered = await registerBefore(rows);
  if (registered) return registered;
  const lost = await keptState(build, record, planCtx);
  if (lost) return lost;
  const progression: ProgressionMeta = {
    schema: PROGRESSION_SCHEMA,
    plan: planWithoutPacks(planFile),
    applied_level: L,
    prefix_sha256: at.prefix_sha256,
    bound_at: Date.now(),
  };
  const before = playedStats(await engine().playSheet(record.build, record.state, ctx));
  const after = playedStats(await engine().playSheet(build, record.state, planCtx));
  const staged = stageCharacter(record, {
    build,
    state: record.state,
    progression,
    content: planCtx,
  });
  const snapshot = {
    kind: "bind",
    record_id: id,
    rev: record.rev ?? 0,
    gen: record.gen ?? 0,
    context_key: contextKey(ctx),
    fingerprint,
    plan_sha256: parsed.plan_sha256,
    applied_level: L,
    history_rev: savedHead(id).rev,
  };
  const entry: LevelUpRecord = {
    mode: "bind",
    from_level: L,
    to_level: L,
    class_id: at.class_id,
    class_level: at.class_level,
    plan_sha256: parsed.plan_sha256,
    step_choices: [],
    packs_added:
      cmp.kind === "addon"
        ? cmp.extra.map((r) => ({ id: r.id, version: r.version, sha256: r.sha256 }))
        : [],
  };
  const { bound_at: _b, ...stable } = progression;
  return {
    ok: true,
    read: record,
    entry,
    packs: rows,
    preview: {
      ok: true,
      kind: "bind",
      record_id: id,
      token: await tokenOf(snapshot, {
        build,
        state: record.state,
        progression: stable,
        content: planCtx,
        entry,
        packs: rows.map((r) => r.key),
      }),
      from_level: L,
      to_level: L,
      class_id: at.class_id,
      class_level: at.class_level,
      choices: [],
      before,
      after,
      new_actions: after.actions.filter((a) => !before.actions.includes(a)),
      warnings: warningsOf(record.state),
      packs_added: entry.packs_added,
      context: planCtx,
      staged,
      plan_file: file,
    },
  };
}

// ───────────────────────── entry points ─────────────────────────

const updating = (): ProgressionRefusal => no(UPDATE_IN_PROGRESS, "an update is being installed");

/** What the next planned level of this character would change (nothing is written). */
export function previewAdvance(id: string): Promise<StepPreview | ProgressionRefusal> {
  return admission.guard(
    "progression.previewAdvance",
    async () => {
      await flushNow();
      const s = await stageAdvance(id);
      return s.ok === false ? s : s.preview;
    },
    updating,
  );
}

/** What binding this plan to the character would do (nothing is written). */
export function previewBind(id: string, file: unknown): Promise<StepPreview | ProgressionRefusal> {
  return admission.guard(
    "progression.previewBind",
    async () => {
      await flushNow();
      const s = await stageBind(id, file);
      return s.ok === false ? s : s.preview;
    },
    updating,
  );
}

/** Test hooks: a failure injected into the confirm's transaction (quota, abort). */
export const confirmHooks: { beforeDone?: (tx: IDBTransaction) => void | Promise<void> } = {};

/** Confirm a preview: one transaction, then one publication; `preview_stale` if anything moved. */
export function confirmStep(preview: StepPreview): Promise<Confirmed | ProgressionRefusal> {
  return admission.guard("progression.confirmStep", () => confirmNow(preview), updating);
}

async function confirmNow(preview: StepPreview): Promise<Confirmed | ProgressionRefusal> {
  const id = preview.record_id;
  if (!useDocuments.getState().characters[id]) return no("missing", id);
  return lockDocuments([id, ...encountersWith(id)], async () => {
    const staged =
      preview.kind === "advance" ? await stageAdvance(id) : await stageBind(id, preview.plan_file);
    if (staged.ok === false) return staged;
    if (staged.preview.token !== preview.token)
      return no(
        "preview_stale",
        "the character, its journal, its content or the plan changed: preview again",
      );
    await flushNow();
    const head = savedHead(id);
    if (head.conflicted) return no("advance_unsaved_conflict", "changed in another tab");
    const read = staged.read;
    if (useDocuments.getState().characters[id] !== read)
      return no("preview_stale", "changed while saving");
    const record = staged.preview.staged;
    const op = newOperationId();
    const now = Date.now();
    let entry: HistoryEntry | null = null;
    let next: HistoryMeta | null = null;
    const packs = staged.packs.map((p) => ({ ...p, installed_at: now }));
    try {
      await writeQueue(async () => {
        const database = await db();
        const tx = database.transaction(
          ["packs", "characters", "history", "history_meta"],
          "readwrite",
        );
        try {
          const row = await tx.objectStore("characters").get(id);
          if (!row || (row.rev ?? 0) !== (read.rev ?? 0)) throw new Refused("target_changed", id);
          const meta = await tx.objectStore("history_meta").get(id);
          if ((meta?.rev ?? null) !== head.rev) throw new Refused("history_changed", id);
          const packStore = tx.objectStore("packs");
          for (const p of packs) {
            const prefix = `${p.ref.id}@${p.ref.version ?? ""}#`;
            const keys = await packStore.getAllKeys(IDBKeyRange.bound(prefix, `${prefix}￿`));
            if (keys.some((k) => k !== p.key))
              throw new Refused("pack_identity_conflict", `${p.ref.id}@${p.ref.version ?? ""}`);
            if (!keys.includes(p.key)) await packStore.add(p);
          }
          await tx.objectStore("characters").put(record as never);
          const m = meta ?? useHistory.getState().meta[id] ?? newMeta(id, now);
          entry = levelUpEntry(record, m, op, now, staged.entry);
          next = { ...m, rev: m.rev + 1, next_seq: m.next_seq + 1 };
          await tx.objectStore("history").put(entry);
          await tx.objectStore("history_meta").put(next);
          await confirmHooks.beforeDone?.(tx as unknown as IDBTransaction);
          await tx.done;
        } catch (error) {
          try {
            tx.abort();
          } catch {
            // already finished
          }
          await tx.done.catch(() => undefined);
          throw error;
        }
      });
    } catch (error) {
      if (error instanceof Refused) return no(error.code, error.detail);
      const name = (error as { name?: string } | null)?.name;
      if (name === "QuotaExceededError") return no("storage_quota", String(error));
      return no("storage_failed", error instanceof Error ? error.message : String(error));
    }
    // Durable: from here on nothing can fail — no worker call, no await (the packs were registered
    // while staging, before the transaction; R06-01). In one synchronous block: the store (one
    // undo step), the journal and the autosave's baseline.
    const e = entry as unknown as HistoryEntry;
    const h = next as unknown as HistoryMeta;
    if (!useDocuments.getState().publishProgression(read, record, op))
      return no("target_changed", "the store changed under the lock");
    useHistory.getState().published([e], [h]);
    markCommitted({ characters: [record], encounters: [], entries: [e], meta: [h] });
    return { ok: true, record, op };
  });
}

class Refused extends Error {
  constructor(
    readonly code: string,
    readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
  }
}

/** The step's journal entry (§7.5): no roll, cost or outcome; the state unchanged. */
function levelUpEntry(
  record: CharacterRecord,
  m: HistoryMeta,
  op: OperationId,
  now: number,
  level: LevelUpRecord,
): HistoryEntry {
  const name = record.build.name ?? "";
  return {
    schema: "kenli.history/3",
    id: newId("h"),
    record_id: record.id,
    seq: m.next_seq,
    gen: record.gen ?? 0,
    operation_id: op,
    group_id: op,
    parent_op: null,
    component: "",
    at: now,
    day_id: m.current_day_id,
    kind: "level_up",
    role: "actor",
    context: { source: "sheet", encounter_id: null, round: null, combat_id: null, turn_id: null },
    participants: [{ record_id: record.id, name }],
    name,
    request: { mode: level.mode, plan_sha256: level.plan_sha256, to_level: level.to_level },
    result: null,
    messages: [],
    outcome: [],
    costs: [],
    effect: { mode: "none", replaces_op: null, state_delta: [] },
    commit: true,
    status: "done",
    undone_with: null,
    pending_decision: false,
    links: { follows: null, continues: null },
    level_up: level,
  };
}

/**
 * A NEW character at a checkpoint of a plan (§5): new id, a fresh state (the starting equipment
 * when the plan says so), the plan's exact context and association, its missing packs — one
 * transaction, then published (no undo step: like a created character). Never overwrites one.
 */
export function startFromPlan(
  file: unknown,
  level: number,
): Promise<{ readonly ok: true; readonly id: string } | ProgressionRefusal> {
  return admission.guard("progression.startFromPlan", () => startNow(file, level), updating);
}

async function startNow(
  file: unknown,
  level: number,
): Promise<{ readonly ok: true; readonly id: string } | ProgressionRefusal> {
  const parsed = await parsePlanFile(file);
  if (!parsed.ok) return no(parsed.problem.code, parsed.problem.detail);
  const compiled = await engine().compilePlan(file);
  if (!compiled.ok) return compileRefusal(compiled);
  if (!Number.isInteger(level) || level < 1 || level > compiled.range.to)
    return no("start_level_out_of_range", `${level} outside 1–${compiled.range.to}`);
  const at = compiled.checkpoints[level - 1] as PlanCheckpoint;
  const ctx: ContentContext = { packs: parsed.file.plan.packs, sources: parsed.file.plan.sources };
  const envelopeFiles = new Map<string, PackFiles>(
    [...parsed.envelopes].map(([sha, env]) => [sha, (env.content as { files: PackFiles }).files]),
  );
  const database = await db();
  const rows: StoredPack[] = [];
  for (const ref of ctx.packs) {
    if (await database.getKey("packs", packKey(ref))) continue;
    const files = envelopeFiles.get(ref.sha256);
    if (!files) {
      if (await servedExactly(ref)) continue;
      return no("plan_pack_missing", `${ref.id}@${ref.version ?? ""}#${ref.sha256}`);
    }
    rows.push({
      key: packKey(ref),
      ref,
      files,
      installed_at: 0,
      origin: { kind: "import", bytes_sha256: null },
    });
  }
  const registered = await registerBefore(rows);
  if (registered) return registered;
  const build = at.build;
  const fresh =
    parsed.file.plan.start.equipment === "starting"
      ? await engine().createState(build, ctx)
      : await (async () => {
          const p = await engine().parseState({});
          return p.ok ? p.state : null;
        })();
  if (!fresh) return no("start_state_invalid", "");
  const now = Date.now();
  const id = newId("c");
  const record: CharacterRecord = {
    id,
    build,
    state: fresh,
    created: now,
    updated: now,
    rev: 1,
    gen: 0,
    content: ctx,
    progression: {
      schema: PROGRESSION_SCHEMA,
      plan: planWithoutPacks(parsed.file),
      applied_level: level,
      prefix_sha256: at.prefix_sha256,
      bound_at: now,
    },
  };
  const packs = rows.map((p) => ({ ...p, installed_at: now }));
  try {
    await writeQueue(async () => {
      const tx = database.transaction(["packs", "characters"], "readwrite");
      try {
        const packStore = tx.objectStore("packs");
        for (const p of packs) {
          const prefix = `${p.ref.id}@${p.ref.version ?? ""}#`;
          const keys = await packStore.getAllKeys(IDBKeyRange.bound(prefix, `${prefix}￿`));
          if (keys.some((k) => k !== p.key))
            throw new Refused("pack_identity_conflict", `${p.ref.id}@${p.ref.version ?? ""}`);
          if (!keys.includes(p.key)) await packStore.add(p);
        }
        await tx.objectStore("characters").add(record as never);
        await confirmHooks.beforeDone?.(tx as unknown as IDBTransaction);
        await tx.done;
      } catch (error) {
        try {
          tx.abort();
        } catch {
          // already finished
        }
        await tx.done.catch(() => undefined);
        throw error;
      }
    });
  } catch (error) {
    if (error instanceof Refused) return no(error.code, error.detail);
    const name = (error as { name?: string } | null)?.name;
    if (name === "QuotaExceededError") return no("storage_quota", String(error));
    return no("storage_failed", error instanceof Error ? error.message : String(error));
  }
  useDocuments.getState().publishLocalCopy(record);
  markCommitted({ characters: [record], encounters: [] });
  return { ok: true, id };
}

/**
 * Drop the plan association only (§4.3 fallback): build, state, content and journal untouched;
 * one undo step restores it. The autosave saves it as any change.
 */
export function detachProgression(id: string): Promise<{ readonly ok: true } | ProgressionRefusal> {
  return admission.guard(
    "progression.detach",
    () =>
      lockDocuments([id], async () => {
        const read = useDocuments.getState().characters[id];
        if (!read) return no("missing", id);
        if (read.progression === undefined || read.progression === null)
          return no("progression_none", "");
        const record = stageCharacter(read, {
          build: read.build,
          state: read.state,
          progression: null,
        });
        return useDocuments.getState().publishProgression(read, record, null)
          ? { ok: true as const }
          : no("target_changed", id);
      }),
    updating,
  );
}
