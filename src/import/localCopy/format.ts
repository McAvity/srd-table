/**
 * kenli F-007 T03: the local copy of a character with its state and whole journal
 * (`srd-table.local-copy/1`, dnd5 docs/features/F-007-offline-packs/contracts/local-copy.md). A
 * format of its own, not an extension of `srd-table.transfer/1` (F-008 stays without history).
 *
 * The validator (contract §4) reads the whole file and returns a refusal with the contract's code,
 * never throws: every structural field is typed, unknown fields anywhere outside the opaque
 * historical values are refused (nothing is dropped silently), ids from the file are data, never
 * property names (§6.1a: `Map`/`Set` and own-key reads only), and the engine checks the build and
 * the state against the copy's own packs (step 8). Nothing here writes.
 */

import { engine } from "@/engine/client";
import {
  type ContentContext,
  canonicalJson,
  contentSha,
  type PackRef,
  sha256Hex,
} from "@/lib/canonical";
import { changedFields } from "@/lib/files";
import type { RecordOrigin } from "@/persistence/db";
import type { HistoryEntry, HistoryMeta } from "@/store/history";
import { checkCharacter } from "../plan";
import type { Envelope } from "../transfer";

export const LOCAL_COPY_FORMAT = "srd-table.local-copy/1";
export const LOCAL_COPY_LIMITS = {
  /** The whole file, UTF-8 bytes (export and import). */
  copyBytes: 20 * 2 ** 20,
  jsonDepth: 64,
  /** Packs in the character's context. */
  packs: 64,
  /** Levels of `manifest.requires` below a pack. */
  dependencyDepth: 8,
  dayLabel: 40,
  overrideNote: 200,
} as const;

export type Refused = { readonly ok: false; readonly code: string; readonly detail: string };

/** A controlled refusal inside the validator (turned into `Refused`, never escapes). */
export class Refusal extends Error {
  override name = "Refusal";
  constructor(
    readonly code: string,
    readonly detail = "",
  ) {
    super(detail ? `${code}: ${detail}` : code);
  }
}
export const refuse = (code: string, detail = ""): never => {
  throw new Refusal(code, detail);
};
/** Any error as a refusal; anything but a `Refusal` is `validator_error` (a bug, still nothing written). */
export function asRefused(error: unknown): Refused {
  if (error instanceof Refusal) return { ok: false, code: error.code, detail: error.detail };
  return {
    ok: false,
    code: "validator_error",
    detail: error instanceof Error ? error.message : String(error),
  };
}

// ───────────────────────── identifiers (local and canonical external, §2.1, §2.2) ─────────────────────────

const INSTALLATION = /^i[0-9a-f]{16}$/;
const LOCAL = "[A-Za-z0-9][A-Za-z0-9._-]{0,63}";
const HEX64 = /^[0-9a-f]{64}$/;
const re = (s: string) => new RegExp(`^${s}$`);
export const ID = {
  local: re(LOCAL),
  record: re("c-[A-Za-z0-9._-]{1,62}"),
  encounter: re("e-[A-Za-z0-9._-]{1,62}"),
  day: re("d-[A-Za-z0-9._-]{1,62}"),
  ext: re(`ext:i[0-9a-f]{16}:${LOCAL}`),
  extRecord: re("ext:i[0-9a-f]{16}:c-[A-Za-z0-9._-]{1,62}"),
  extEncounter: re("ext:i[0-9a-f]{16}:e-[A-Za-z0-9._-]{1,62}"),
} as const;

/**
 * The canonical external form of an id seen in installation `inst` (§2.2): an id that already is
 * external keeps its form (it names the installation where the thing was live), never nested.
 */
export const ext = (inst: string, id: string): string =>
  ID.ext.test(id) ? id : `ext:${inst}:${id}`;
export const isExternal = (id: string | null | undefined): boolean =>
  typeof id === "string" && ID.ext.test(id);

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Maximum nesting depth of a JSON value, iteratively (a hostile file can't overflow the stack). */
export function jsonDepth(root: unknown, stopAt = Number.POSITIVE_INFINITY): number {
  let max = 0;
  const stack: [unknown, number][] = [[root, 0]];
  while (stack.length) {
    const [v, d] = stack.pop() as [unknown, number];
    if (v && typeof v === "object") {
      const nd = d + 1;
      if (nd > max) max = nd;
      if (max > stopAt) return max;
      for (const c of Array.isArray(v) ? v : Object.values(v)) stack.push([c, nd]);
    }
  }
  return max;
}

// ───────────────────────── the format's types ─────────────────────────

export interface External {
  readonly participants: readonly { readonly record_id: string; readonly name: string }[];
  readonly encounters: readonly { readonly encounter_id: string; readonly name: string | null }[];
  readonly operations: readonly string[];
}

export interface CopySource {
  readonly installation_id: string;
  readonly record_id: string;
  readonly record_rev: number;
  readonly record_gen: number;
  readonly history_rev: number;
  readonly exported_at: number;
  readonly release_id: string | null;
  readonly legacy_context: {
    readonly settings_fingerprint: string;
    readonly packs: readonly string[];
    readonly sources: readonly string[] | null;
  } | null;
}

export interface CopyHistory {
  readonly schema: "kenli.history/1";
  readonly entry_count: number;
  readonly meta: HistoryMeta | null;
  readonly entries: readonly HistoryEntry[];
}

export interface Payload {
  readonly source: CopySource;
  readonly character: {
    readonly name: string;
    readonly build: Record<string, unknown>;
    readonly state: Record<string, unknown>;
    readonly state_origin: { readonly kind: "exported" };
    readonly context: ContentContext;
    readonly origin: RecordOrigin | null;
  };
  readonly history: CopyHistory;
  readonly external: External;
  readonly packs: readonly Envelope[];
}

export interface LocalCopy {
  readonly format: typeof LOCAL_COPY_FORMAT;
  readonly payload_sha256: string;
  readonly payload: Payload;
}

/** What the new record keeps in `origin.extensions.local_copy` (§6.1). */
export interface LocalCopyOrigin {
  readonly format: typeof LOCAL_COPY_FORMAT;
  readonly import_id: string;
  readonly history_rev: number;
  readonly entry_count: number;
  readonly source_origin: RecordOrigin | null;
  readonly external: External;
}

/** The local-copy part of a record's origin, when it is one (else `null`). */
export function localCopyOf(origin: unknown): LocalCopyOrigin | null {
  if (!isObj(origin) || origin.kind !== "import" || !isObj(origin.extensions)) return null;
  const lc = Object.hasOwn(origin.extensions, "local_copy") ? origin.extensions.local_copy : null;
  return isObj(lc) && lc.format === LOCAL_COPY_FORMAT ? (lc as unknown as LocalCopyOrigin) : null;
}

/** Names of the external encounters a record inherited from the copy it came from (canonical keys). */
export function inheritedEncounterNames(origin: unknown): Map<string, string | null> {
  const lc = localCopyOf(origin);
  const out = new Map<string, string | null>();
  for (const e of lc?.external?.encounters ?? [])
    if (typeof e?.encounter_id === "string")
      out.set(e.encounter_id, typeof e.name === "string" ? e.name : null);
  return out;
}

// ───────────────────────── a small typed validator (every failure is a Refusal) ─────────────────────────

type V = (v: unknown, at: string) => void;
const T = {
  str:
    (code: string, pattern?: RegExp, max = 10_000): V =>
    (v, at) => {
      if (typeof v !== "string" || v.length > max || (pattern && !pattern.test(v)))
        refuse(code, `${at}: string${pattern ? ` ${pattern}` : ""}`);
    },
  int:
    (code: string, min = 0, max = Number.MAX_SAFE_INTEGER): V =>
    (v, at) => {
      if (!Number.isSafeInteger(v) || (v as number) < min || (v as number) > max)
        refuse(code, `${at}: integer ≥ ${min}`);
    },
  num:
    (code: string): V =>
    (v, at) => {
      if (typeof v !== "number" || !Number.isFinite(v)) refuse(code, `${at}: number`);
    },
  bool:
    (code: string): V =>
    (v, at) => {
      if (typeof v !== "boolean") refuse(code, `${at}: boolean`);
    },
  lit:
    (code: string, ...values: readonly unknown[]): V =>
    (v, at) => {
      if (!values.includes(v)) refuse(code, `${at}: one of ${JSON.stringify(values)}`);
    },
  nul:
    (inner: V): V =>
    (v, at) => {
      if (v !== null) inner(v, at);
    },
  /** Opaque historical JSON (already parsed and depth-limited): kept verbatim. */
  any: (): V => () => {},
  objAny:
    (code: string): V =>
    (v, at) => {
      if (!isObj(v)) refuse(code, `${at}: object`);
    },
  arr:
    (code: string, item: V, min = 0): V =>
    (v, at) => {
      if (!Array.isArray(v) || v.length < min)
        refuse(code, `${at}: array${min ? ` ≥ ${min}` : ""}`);
      (v as unknown[]).forEach((x, i) => {
        item(x, `${at}[${i}]`);
      });
    },
  /** Exact keys, checked as own keys (an extra `constructor` or `__proto__` is unknown). */
  obj:
    (
      code: string,
      shape: Readonly<Record<string, V>>,
      optional: Readonly<Record<string, V>> = {},
      unknownCode = code === "history_invalid" ? "history_unknown_field" : code,
    ): V =>
    (v, at) => {
      if (!isObj(v)) refuse(code, `${at}: object`);
      const o = v as Record<string, unknown>;
      for (const k of Object.keys(shape))
        if (!Object.hasOwn(o, k)) refuse(code, `${at}.${k} missing`);
      for (const k of Object.keys(o))
        if (!Object.hasOwn(shape, k) && !Object.hasOwn(optional, k))
          refuse(unknownCode, `${at}.${k}`);
      for (const [k, f] of Object.entries(shape)) f(o[k], `${at}.${k}`);
      for (const [k, f] of Object.entries(optional)) if (Object.hasOwn(o, k)) f(o[k], `${at}.${k}`);
    },
};

const H = "history_invalid";
/** Engine `Message`: params are strings, numbers, booleans, Messages or arrays of them. */
const messageParam: V = (v, at) => {
  if (typeof v === "string" || typeof v === "boolean") return;
  if (typeof v === "number" && Number.isFinite(v)) return;
  if (Array.isArray(v)) {
    v.forEach((x, i) => {
      messageParam(x, `${at}[${i}]`);
    });
    return;
  }
  message(v, at);
};
const message: V = (v, at) => {
  T.obj(H, { code: T.str(H, undefined, 200), params: T.objAny(H), text: T.str(H) })(v, at);
  for (const [k, p] of Object.entries((v as { params: Record<string, unknown> }).params))
    messageParam(p, `${at}.params.${k}`);
};
/** Engine `RollCost` as F-006 records it; the inner play action is opaque but for what the panel reads. */
const checkedCostFields = {
  payable: T.bool(H),
  reason: T.nul(
    T.obj(H, {
      code: T.str(H, undefined, 200),
      category: T.str(H, undefined, 200),
      text: T.str(H),
      message,
    }),
  ),
};
const cost: V = (v, at) => {
  if (!isObj(v)) refuse(H, `${at}: object`);
  const c = v as Record<string, unknown>;
  if (c.type === "play") {
    T.obj(H, { type: T.any(), action: T.objAny(H) }, checkedCostFields)(c, at);
    const a = c.action as Record<string, unknown>;
    T.str(H, re("[a-z_]{1,40}"))(a.type, `${at}.action.type`);
    if (a.type === "spend_slot" || Object.hasOwn(a, "level"))
      T.int(H, 0, 9)(a.level, `${at}.action.level`);
    if (a.type === "use" || a.type === "use_feature" || Object.hasOwn(a, "key"))
      T.str(H, undefined, 200)(a.key, `${at}.action.key`);
  } else if (c.type === "daily")
    T.obj(
      H,
      { type: T.any(), key: T.str(H), per_day: T.int(H, 1), name: T.str(H) },
      checkedCostFields,
    )(c, at);
  else if (c.type === "recharge")
    T.obj(H, { type: T.any(), name: T.str(H) }, checkedCostFields)(c, at);
  else refuse(H, `${at}.type: play | daily | recharge`);
};
const nnum = T.nul(T.num(H));
const nbool = T.nul(T.bool(H));
const outcome = T.obj(H, {
  label: T.str(H),
  raw: nnum,
  effective: nnum,
  total: nnum,
  success: nbool,
  critical: nbool,
  damage_total: nnum,
});
const localOp = T.str(H, ID.local);
const linkOpOf =
  (code: string): V =>
  (v, at) => {
    if (v === null) return;
    if (typeof v !== "string" || !(ID.local.test(v) || ID.ext.test(v)))
      refuse(code, `${at}: local or ext:<installation>:<op>`);
  };
const linkOp = linkOpOf(H);
const KINDS: readonly string[] = [
  "test",
  "sheet_roll",
  "damage",
  "death_save",
  "late_advantage",
  "reroll",
  "set_critical",
  "play",
  "short_rest",
  "long_rest",
  "encounter",
  "import_boundary",
];
const recordRef: V = (v, at) => {
  if (typeof v !== "string" || !(ID.record.test(v) || ID.extRecord.test(v)))
    refuse(H, `${at}: c-… or ext:<installation>:c-…`);
};
const encounterRef =
  (code: string): V =>
  (v, at) => {
    if (v !== null && (typeof v !== "string" || !(ID.encounter.test(v) || ID.extEncounter.test(v))))
      refuse(code, `${at}: e-… | ext:<installation>:e-… | null`);
  };
const entryShape: V = T.obj(
  H,
  {
    schema: T.any(),
    id: T.str(H, ID.local),
    record_id: T.str(H, ID.record),
    seq: T.int(H, 1),
    gen: T.int(H, 0),
    operation_id: localOp,
    group_id: localOp,
    parent_op: T.nul(localOp),
    component: T.str(H, undefined, 200),
    at: T.int(H, 0),
    day_id: T.str(H, ID.day),
    kind: T.any(),
    role: T.lit(H, "actor", "affected"),
    context: T.obj(H, {
      source: T.lit(H, "sheet", "rest_dialog", "encounter", "import"),
      encounter_id: encounterRef(H),
      round: T.nul(T.int(H, 0)),
      combat_id: T.lit(H, null),
      turn_id: T.lit(H, null),
    }),
    participants: T.arr(H, T.obj(H, { record_id: recordRef, name: T.str(H, undefined, 200) }), 1),
    name: T.str(H, undefined, 200),
    request: T.any(),
    result: T.any(),
    messages: T.arr(H, message),
    outcome: T.arr(H, outcome),
    costs: T.arr(H, cost),
    effect: T.obj(H, {
      mode: T.lit(H, "none", "apply", "replace"),
      replaces_op: T.nul(localOp),
      state_delta: T.arr(
        H,
        T.obj(H, { path: T.str(H, re(".{1,200}")), before: T.any(), after: T.any() }),
      ),
    }),
    commit: T.bool(H),
    status: T.any(),
    undone_with: T.nul(localOp),
    pending_decision: T.bool(H),
    links: T.obj(H, { follows: linkOp, continues: linkOp }),
  },
  {
    rest_kind: T.lit(H, "short", "long"),
    rest: T.obj(H, {
      dice: T.arr(
        H,
        T.obj(H, { die: T.int(H, 1, 100), roll: T.objAny(H), rerolled_from: T.nul(T.objAny(H)) }),
      ),
      override: T.nul(
        T.obj(H, {
          by: T.lit(H, "dm"),
          note: T.nul(T.str(H, undefined, LOCAL_COPY_LIMITS.overrideNote)),
        }),
      ),
    }),
    import: T.obj(H, {
      mode: T.lit(H, "replace"),
      gen_before: T.int(H, 0),
      gen_after: T.int(H, 0),
      origin: T.nul(T.objAny(H)),
    }),
    forced: T.lit(H, true),
  },
);

/** One stored `kenli.history/1` entry, every structural field typed (throws a `Refusal`). */
export function checkEntry(e: unknown, at = "entry"): void {
  if (!isObj(e)) refuse(H, `${at}: object`);
  const x = e as Record<string, unknown>;
  if (x.schema !== "kenli.history/1") refuse("history_schema", `${at}.schema`);
  if (typeof x.kind !== "string" || !KINDS.includes(x.kind)) refuse("history_kind", `${at}.kind`);
  if (x.status !== "done" && x.status !== "undone") refuse("history_status", `${at}.status`);
  entryShape(e, at);
  const rest = x.kind === "short_rest" || x.kind === "long_rest";
  if (
    rest !== Object.hasOwn(x, "rest_kind") ||
    (rest && x.rest_kind !== (x.kind === "long_rest" ? "long" : "short"))
  )
    refuse("history_rest_kind", at);
  if (Object.hasOwn(x, "import") !== (x.kind === "import_boundary"))
    refuse(H, `${at}.import only on import_boundary`);
  if (x.undone_with !== null && x.status !== "undone")
    refuse("history_status", `${at}: undone_with on a done entry`);
  const ps = x.participants as { record_id: string }[];
  if (new Set(ps.map((p) => p.record_id)).size !== ps.length)
    refuse(H, `${at}.participants: duplicate record`);
  if (!ps.some((p) => p.record_id === x.record_id))
    refuse(H, `${at}.participants: without its own record`);
}

// ───────────────────────── the parts of a file ─────────────────────────

function checkSource(v: unknown): void {
  const S = "source_invalid";
  T.obj(S, {
    installation_id: T.str(S, INSTALLATION),
    record_id: T.str(S, ID.record),
    record_rev: T.int(S, 1),
    record_gen: T.int(S, 0),
    history_rev: T.int(S, 0),
    exported_at: T.int(S, 0),
    release_id: T.nul(T.str(S, re("r-[0-9a-f]{16}"))),
    legacy_context: T.nul(
      T.obj(S, {
        settings_fingerprint: T.str(S, HEX64),
        packs: T.arr(S, T.str(S, undefined, 200), 1),
        sources: T.nul(T.arr(S, T.str(S, undefined, 200))),
      }),
    ),
  })(v, "payload.source");
}

function checkCharacterShape(v: unknown): ContentContext {
  const C = "character_invalid";
  T.obj(C, {
    name: T.str(C, undefined, 200),
    build: T.objAny(C),
    state: T.objAny(C),
    state_origin: T.obj(C, { kind: T.lit(C, "exported") }),
    context: T.any(),
    origin: T.nul(
      T.obj(
        C,
        { kind: T.lit(C, "import", "duplicate") },
        {
          id: T.any(),
          revision: T.any(),
          sha256: T.any(),
          bytes_sha256: T.any(),
          source: T.any(),
          imported_at: T.any(),
          state_origin: T.any(),
          extensions: T.any(),
          of: T.any(),
        },
      ),
    ),
  })(v, "payload.character");
  const X = "context_invalid";
  const ctx = (v as { context: unknown }).context;
  T.obj(X, {
    packs: T.arr(
      X,
      T.obj(X, {
        id: T.str(X, undefined, 200),
        version: T.nul(T.str(X, undefined, 200)),
        sha256: T.str(X, HEX64),
      }),
      1,
    ),
    sources: T.nul(T.arr(X, T.str(X, undefined, 200))),
  })(ctx, "payload.character.context");
  const c = ctx as ContentContext;
  if (c.packs.length > LOCAL_COPY_LIMITS.packs) refuse("limit_packs", String(c.packs.length));
  const ids = new Set<string>();
  for (const p of c.packs) {
    if (ids.has(p.id)) refuse("context_duplicate_pack", p.id);
    ids.add(p.id);
  }
  return c;
}

const P = "pack_invalid";
const depRef = T.obj(P, {
  kind: T.lit(P, "pack"),
  id: T.str(P, undefined, 200),
  version: T.nul(T.str(P, undefined, 200)),
  sha256: T.str(P, HEX64),
  href: T.lit(P, null),
  bytes_sha256: T.lit(P, null),
});
const packEnvelopeShape = T.obj(P, {
  format: T.lit(P, "srd-table.transfer/1"),
  kind: T.lit(P, "pack"),
  id: T.str(P, undefined, 200),
  revision: T.lit(P, null),
  title: T.str(P, undefined, 400),
  sha256: T.str(P, HEX64),
  content: T.obj(P, { files: T.objAny(P) }),
  requires: T.arr(P, depRef),
  provenance: T.objAny(P),
  extensions: T.objAny(P),
});
const manifestShape = T.obj(
  P,
  {
    manifest: T.obj(
      P,
      { id: T.str(P), version: T.nul(T.str(P)), requires: T.arr(P, T.str(P)) },
      { name: T.any(), ruleset: T.any(), source: T.any(), description: T.any() },
    ),
    tables: T.objAny(P),
  },
  { name: T.any(), creation: T.any(), patches: T.any() },
);

async function checkPacks(v: unknown, ctx: ContentContext): Promise<void> {
  T.arr(P, packEnvelopeShape)(v, "payload.packs");
  const envs = v as Envelope[];
  const byId = new Map<string, { env: Envelope; ref: PackRef; requires: readonly string[] }>();
  for (const env of envs) {
    const files = (env.content as { files: Record<string, unknown> }).files;
    const manifest = Object.hasOwn(files, "manifest.json") ? files["manifest.json"] : undefined;
    manifestShape(manifest, `pack ${env.id} manifest.json`);
    const m = manifest as {
      manifest: { id: string; version: string | null; requires: string[] };
      tables: Record<string, unknown>;
    };
    for (const [name, t] of Object.entries(m.tables)) {
      T.obj(
        P,
        { file: T.str(P, re("[a-z0-9_.-]{1,80}\\.json")) },
        { count: T.int(P, 0) },
      )(t, `pack ${env.id} tables.${name}`);
      if (!Object.hasOwn(files, (t as { file: string }).file))
        refuse(P, `${env.id} misses ${(t as { file: string }).file}`);
    }
    if (m.manifest.id !== env.id) refuse(P, `id ${env.id}`);
    const ref: PackRef = {
      id: m.manifest.id,
      version: m.manifest.version,
      sha256: await contentSha({ files }),
    };
    if (ref.sha256 !== env.sha256) refuse("pack_hash_mismatch", ref.id);
    if (byId.has(ref.id)) refuse("context_duplicate_pack", ref.id);
    byId.set(ref.id, { env, ref, requires: m.manifest.requires });
  }
  for (const [i, r] of ctx.packs.entries()) {
    const found = byId.get(r.id) ?? refuse("pack_missing", `${r.id}@${r.version ?? ""}`);
    if (found.ref.sha256 !== r.sha256 || found.ref.version !== r.version)
      refuse("pack_hash_mismatch", r.id);
    if (envs[i]?.id !== r.id) refuse("pack_order", r.id);
  }
  if (envs.length !== ctx.packs.length)
    refuse("pack_unreferenced", `${envs.length} packs for ${ctx.packs.length} context refs`);
  const pos = new Map(ctx.packs.map((p, i) => [p.id, i]));
  const depth = new Map<string, number>();
  for (const r of ctx.packs) {
    const { env, requires } = byId.get(r.id) as { env: Envelope; requires: readonly string[] };
    let d = 0;
    for (const dep of requires) {
      const at = pos.get(dep);
      if (at === undefined || at >= (pos.get(r.id) as number))
        refuse("context_order", `${r.id} requires ${dep}`);
      d = Math.max(d, (depth.get(dep) ?? 0) + 1);
      const want = ctx.packs[at as number];
      if (!env.requires.some((x) => x.id === dep && x.sha256 === want?.sha256))
        refuse(P, `${r.id} requires ${dep} with another hash`);
    }
    if (env.requires.length !== requires.length) refuse(P, `${r.id} requires`);
    if (d > LOCAL_COPY_LIMITS.dependencyDepth) refuse("limit_depth", r.id);
    depth.set(r.id, d);
  }
}

function checkHistory(v: unknown, recordId: string): void {
  T.obj(
    "envelope_missing_field",
    { schema: T.any(), entry_count: T.any(), meta: T.any(), entries: T.any() },
    {},
    "envelope_unknown_field",
  )(v, "payload.history");
  const h = v as Record<string, unknown>;
  if (h.schema !== "kenli.history/1") refuse("history_schema", String(h.schema));
  T.int("history_count", 0)(h.entry_count, "history.entry_count");
  T.arr(H, T.any())(h.entries, "history.entries");
  const entries = h.entries as unknown[];
  if (h.meta === null) {
    // Never had a journal (F-006 makes the head lazily): explicitly empty, nothing invented.
    if (entries.length !== 0 || h.entry_count !== 0)
      refuse("history_head", "entries without a head");
    return;
  }
  if (!isObj(h.meta)) refuse(H, "meta: object | null");
  if ((h.meta as Record<string, unknown>).schema !== "kenli.history-meta/1")
    refuse("history_schema", "meta.schema");
  const D = "history_days_invalid";
  T.obj(H, {
    schema: T.any(),
    record_id: T.any(),
    rev: T.int(H, 0),
    next_seq: T.int(H, 1),
    current_day_id: T.str(H, ID.day),
    days: T.arr(
      D,
      T.obj(
        D,
        {
          id: T.str(D, ID.day),
          n: T.int(D, 1),
          label: T.nul(T.str(D, undefined, LOCAL_COPY_LIMITS.dayLabel)),
          started_at: T.int(D, 0),
        },
        {},
        "history_unknown_field",
      ),
      1,
    ),
  })(h.meta, "meta");
  const meta = h.meta as unknown as HistoryMeta;
  if (meta.record_id !== recordId) refuse("history_record_mismatch", "meta");
  const dayIds = new Set<string>();
  for (const [i, d] of meta.days.entries()) {
    if (dayIds.has(d.id) || d.n !== i + 1) refuse(D, d.id);
    if (
      d.label !== null &&
      (d.label.length === 0 || /[\r\n]/.test(d.label) || d.label !== d.label.trim())
    )
      refuse(D, `label of ${d.id}`);
    dayIds.add(d.id);
  }
  if (!dayIds.has(meta.current_day_id)) refuse("history_day_unknown", "current_day_id");
  if (h.entry_count !== entries.length)
    refuse("history_count", `${String(h.entry_count)} ≠ ${entries.length}`);
  if (meta.next_seq !== entries.length + 1)
    refuse("history_head", `next_seq ${meta.next_seq} for ${entries.length} entries`);
  const ids = new Set<string>();
  const ops = new Set<string>();
  for (const [i, raw] of entries.entries()) {
    if (isObj(raw) && raw.record_id !== recordId)
      refuse("history_record_mismatch", `entries[${i}]`);
    checkEntry(raw, `entries[${i}]`);
    const e = raw as HistoryEntry;
    if (e.seq !== i + 1) refuse("history_seq", `entries[${i}].seq = ${e.seq}`);
    if (ids.has(e.id)) refuse("history_duplicate_id", e.id);
    ids.add(e.id);
    if (!dayIds.has(e.day_id)) refuse("history_day_unknown", `entries[${i}].day_id`);
    ops.add(e.operation_id);
  }
  // Links that stay inside this journal (F-006 I3, I8, I9): group root, parent, undo cause, replaced op.
  for (const [i, e] of (entries as HistoryEntry[]).entries()) {
    for (const k of ["group_id", "parent_op", "undone_with"] as const) {
      const op = e[k];
      if (op !== null && !ops.has(op)) refuse("history_link_dangling", `entries[${i}].${k}`);
    }
    if (e.effect.replaces_op !== null && !ops.has(e.effect.replaces_op))
      refuse("history_link_dangling", `entries[${i}].effect.replaces_op`);
  }
}

/** What a journal references outside its character (§2): participants, encounters, operations. */
export function externalOf(
  history: Pick<CopyHistory, "entries">,
  recordId: string,
): {
  participants: { record_id: string; name: string }[];
  encounters: { encounter_id: string; name: string | null }[];
  operations: string[];
} {
  const ops = new Set(history.entries.map((e) => e.operation_id));
  const participants = new Map<string, string>();
  const encounters = new Set<string>();
  const operations = new Set<string>();
  for (const e of history.entries) {
    // The name of the entry with the highest seq (entries are in seq order).
    for (const p of e.participants)
      if (p.record_id !== recordId) participants.set(p.record_id, p.name);
    if (e.context.encounter_id !== null) encounters.add(e.context.encounter_id);
    for (const op of [e.links.follows, e.links.continues])
      if (op !== null && !ops.has(op)) operations.add(op);
  }
  const byKey =
    <X>(f: (x: X) => string) =>
    (a: X, b: X) =>
      f(a) < f(b) ? -1 : f(a) > f(b) ? 1 : 0;
  return {
    participants: [...participants]
      .map(([record_id, name]) => ({ record_id, name }))
      .sort(byKey((x) => x.record_id)),
    encounters: [...encounters].sort().map((encounter_id) => ({ encounter_id, name: null })),
    operations: [...operations].sort(),
  };
}

function checkExternal(v: unknown, history: CopyHistory, recordId: string): void {
  const X = "external_invalid";
  T.obj(X, {
    participants: T.arr(X, T.obj(X, { record_id: recordRef, name: T.str(X, undefined, 200) })),
    encounters: T.arr(
      X,
      T.obj(X, {
        encounter_id: (x, at) => (x === null ? refuse(X, at) : encounterRef(X)(x, at)),
        name: T.nul(T.str(X, undefined, 200)),
      }),
    ),
    operations: T.arr(X, (x, at) => linkOpOf(X)(x === null ? 0 : x, at)),
  })(v, "payload.external");
  const x = v as External;
  const want = externalOf(history, recordId);
  const strip = (e: External) =>
    JSON.stringify({
      p: e.participants.map((p) => [p.record_id, p.name]),
      e: e.encounters.map((y) => y.encounter_id),
      o: e.operations,
    });
  if (strip(x) !== strip(want))
    refuse("external_mismatch", "external refs ≠ the entries' references");
}

// ───────────────────────── the whole file ─────────────────────────

/** Steps 2–7 of §4 on a parsed value (no engine): the structure, hashes, journal and external refs. */
export async function checkStructure(parsed: unknown): Promise<LocalCopy> {
  if (jsonDepth(parsed, LOCAL_COPY_LIMITS.jsonDepth) > LOCAL_COPY_LIMITS.jsonDepth)
    refuse("limit_json_depth", `> ${LOCAL_COPY_LIMITS.jsonDepth}`);
  if (!isObj(parsed)) refuse("format_unknown", "top level is not an object");
  const top = parsed as Record<string, unknown>;
  const f = Object.hasOwn(top, "format") ? top.format : undefined;
  if (f !== LOCAL_COPY_FORMAT) {
    if (typeof f !== "string") refuse("format_unknown", "no format");
    const s = f as string;
    if (s === "srd-table.transfer/1") refuse("format_transfer_not_local_copy", s);
    const m = /^srd-table\.local-copy\/([1-9][0-9]{0,5})$/.exec(s);
    if (m && Number(m[1]) > 1) refuse("format_newer", s);
    if (s.startsWith("srd-table.local-copy/")) refuse("format_unsupported", s);
    refuse("format_unknown", s);
  }
  T.obj(
    "envelope_missing_field",
    { format: T.any(), payload_sha256: T.any(), payload: T.any() },
    {},
    "envelope_unknown_field",
  )(top, "$");
  if (typeof top.payload_sha256 !== "string" || !HEX64.test(top.payload_sha256))
    refuse("envelope_sha256");
  if ((await contentSha(top.payload)) !== top.payload_sha256)
    refuse("hash_mismatch", "payload_sha256");
  T.obj(
    "envelope_missing_field",
    { source: T.any(), character: T.any(), history: T.any(), external: T.any(), packs: T.any() },
    {},
    "envelope_unknown_field",
  )(top.payload, "payload");
  const p = top.payload as Record<string, unknown>;
  checkSource(p.source);
  const ctx = checkCharacterShape(p.character);
  await checkPacks(p.packs, ctx);
  const recordId = (p.source as CopySource).record_id;
  checkHistory(p.history, recordId);
  checkExternal(p.external, p.history as CopyHistory, recordId);
  const head = (p.history as CopyHistory).meta;
  if ((p.source as CopySource).history_rev !== (head?.rev ?? 0))
    refuse("source_invalid", "history_rev ≠ the exported head");
  return parsed as unknown as LocalCopy;
}

/** Step 8: the engine reads the build and the state with the copy's own packs; nothing changes. */
export async function checkWithEngine(copy: LocalCopy): Promise<void> {
  const c = copy.payload.character;
  // The copy's packs for this session's catalogs (memory, by hash; nothing stored, no campaign change).
  await engine().registerPacks(
    copy.payload.packs.map((env) => (env.content as { files: Record<string, unknown> }).files),
  );
  const checked = await checkCharacter(c.build, c.state, c.context);
  const first = checked.problems[0];
  if (first) refuse(first.code, first.detail);
  if (!checked.build || !checked.state) refuse("state_invalid", "the engine read nothing");
  // R04-03: a copy is stored verbatim, so the engine must read it exactly as it is — no value
  // changed, no default added, no version normalized (else the next load would silently change
  // it). Stricter than F-008's import, which keeps the parsed documents.
  const changed = (raw: unknown, parsed: unknown) =>
    canonicalJson(raw) === canonicalJson(parsed)
      ? null
      : changedFields(raw as object, parsed as object).join(", ") || "normalized";
  const build = changed(c.build, checked.build);
  if (build) refuse("build_invalid", `the engine would read the build differently: ${build}`);
  const state = changed(c.state, checked.state);
  if (state) refuse("state_would_change", `the engine would read the state differently: ${state}`);
}

/**
 * The whole file (contract §4), first refusal wins: bytes, format, structure, journal, external
 * refs, then the engine. `bytes_sha256` is the file's own hash (the new record's `origin`).
 */
export async function validateLocalCopy(
  bytes: Uint8Array,
  options: { readonly engine?: boolean } = {},
): Promise<
  { readonly ok: true; readonly copy: LocalCopy; readonly bytes_sha256: string } | Refused
> {
  try {
    if (bytes.byteLength > LOCAL_COPY_LIMITS.copyBytes)
      refuse("limit_copy_bytes", `${bytes.byteLength} > ${LOCAL_COPY_LIMITS.copyBytes}`);
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return refuse("not_utf8");
    }
    if (text.trimStart().startsWith("<")) refuse("content_html");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return refuse("not_json");
    }
    const copy = await checkStructure(parsed);
    if (options.engine !== false) await checkWithEngine(copy);
    return { ok: true, copy, bytes_sha256: await sha256Hex(bytes) };
  } catch (error) {
    return asRefused(error);
  }
}
