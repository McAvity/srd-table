/**
 * kenli F-007 T03: the local-copy validator (contract local-copy.md §4, §6.1a, §9) on the frozen
 * contract examples (copied byte-for-byte into `fixtures/`: a 595-entry pinned journal and an empty
 * legacy one, synthetic packs) — the 115 invalid cases of `cases.json` with their exact codes, the
 * byte-level limits, a type-confusion sweep over every structural position of representative
 * entries, hostile blocks, own-key field checks and prototype-like ids. Steps 1–7 only here (the
 * examples' packs are synthetic); the engine step runs in `local-copy.test.ts` with real packs.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  externalOf,
  LOCAL_COPY_FORMAT,
  LOCAL_COPY_LIMITS,
  validateLocalCopy,
} from "../../src/import/localCopy/format";
import { mapLocalCopy } from "../../src/import/localCopy/map";
import { contentSha } from "../../src/lib/canonical";

const FIX = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const read = (name: string) => readFileSync(join(FIX, name), "utf8");
const LONG = read("long-pinned.local-copy.fixture");
const EMPTY = read("empty-legacy.local-copy.fixture");
const long = () => JSON.parse(LONG) as Mutable;
const empty = () => JSON.parse(EMPTY) as Mutable;
// biome-ignore lint/suspicious/noExplicitAny: test mutations reach anywhere in the file.
type Mutable = any;

const enc = (v: unknown) => new TextEncoder().encode(typeof v === "string" ? v : JSON.stringify(v));
const check = (v: unknown) => validateLocalCopy(enc(v), { engine: false });
async function rehash(c: Mutable): Promise<Mutable> {
  c.payload_sha256 = await contentSha(c.payload);
  return c;
}

describe("valid examples", () => {
  it("the long pinned copy (595 entries) and the empty legacy one are valid; bytes hashed", async () => {
    const a = await validateLocalCopy(enc(LONG), { engine: false });
    expect(a.ok).toBe(true);
    if (a.ok) {
      expect(a.copy.payload.history.entries).toHaveLength(595);
      expect(a.bytes_sha256).toBe(
        "676712ef6fbbe3b31100106cb83e7015655f11f664352d7f219ffc406ff66b8f",
      );
    }
    const b = await validateLocalCopy(enc(EMPTY), { engine: false });
    expect(b.ok).toBe(true);
    if (b.ok) expect(b.copy.payload.history.meta).toBeNull();
    expect(LOCAL_COPY_FORMAT).toBe("srd-table.local-copy/1");
    expect(LOCAL_COPY_LIMITS).toMatchObject({
      copyBytes: 20 * 1024 * 1024,
      jsonDepth: 64,
      packs: 64,
      dependencyDepth: 8,
    });
  });
});

// ───────────────────────── the 115 invalid cases of the contract ─────────────────────────

interface PathCase {
  id: string;
  base: "long" | "empty";
  mutate?: string;
  path?: string;
  op?: "set" | "delete";
  value?: unknown;
  entry?: number | { kind?: string; has?: string };
  expect: string;
}
const cases = (JSON.parse(read("cases.fixture")) as { cases: PathCase[] }).cases;
const splitPath = (p: string) =>
  p === "" ? [] : p.split(/(?<!\\)\./).map((k) => k.replaceAll("\\.", "."));
function getAt(root: unknown, path: string[]): unknown {
  let v = root;
  for (const k of path)
    v = v === null || typeof v !== "object" ? undefined : (v as Record<string, unknown>)[k];
  return v;
}
async function applyPathCase(copy: Mutable, cs: PathCase): Promise<Mutable> {
  const entries = copy.payload.history.entries as Mutable[];
  let holder: Mutable = copy;
  let key: string | number | null = null;
  if (cs.entry !== undefined) {
    const sel = cs.entry;
    const idx =
      typeof sel === "number"
        ? sel
        : entries.findIndex(
            (e) =>
              (!sel.kind || e.kind === sel.kind) &&
              (!sel.has || (getAt(e, splitPath(sel.has)) ?? null) !== null),
          );
    if (idx < 0) throw new Error(`case ${cs.id}: no entry matches`);
    holder = entries;
    key = idx;
  }
  const rel = splitPath(cs.path as string);
  if (rel.length) {
    if (key !== null) {
      holder = holder[key];
      key = null;
    }
    for (const k of rel.slice(0, -1)) holder = holder[k];
    key = rel.at(-1) as string;
  }
  if (key === null) throw new Error(`case ${cs.id}: empty root path`);
  if (cs.op === "delete") delete holder[key];
  else holder[key] = structuredClone(cs.value ?? null);
  if (cs.path !== "format") await rehash(copy);
  return copy;
}

const otherPack = async () => {
  const files = {
    "manifest.json": {
      manifest: { id: "syn-other", version: "1.0.0", requires: [] },
      tables: {},
    },
  };
  return {
    format: "srd-table.transfer/1",
    kind: "pack",
    id: "syn-other",
    revision: null,
    title: "syn-other 1.0.0",
    sha256: await contentSha({ files }),
    content: { files },
    requires: [],
    provenance: {},
    extensions: {},
  };
};

const MUTATIONS: Record<string, (c: Mutable) => Promise<Mutable> | Mutable> = {
  payload_tampered: (c) => {
    c.payload.history.entries[10].status = "undone";
    return c;
  },
  format_newer: (c) => ({ ...c, format: "srd-table.local-copy/2" }),
  format_transfer: (c) => ({ ...c, format: "srd-table.transfer/1" }),
  unknown_top_field: (c) => ({ ...c, extra: 1 }),
  unknown_entry_field: (c) => {
    c.payload.history.entries[0].future_field = 1;
    return rehash(c);
  },
  entry_schema_foreign: (c) => {
    c.payload.history.entries[0].schema = "kenli.history/2";
    return rehash(c);
  },
  meta_schema_foreign: (c) => {
    c.payload.history.meta.schema = "kenli.history-meta/2";
    return rehash(c);
  },
  seq_gap: (c) => {
    c.payload.history.entries.splice(100, 1);
    c.payload.history.entry_count -= 1;
    c.payload.history.meta.next_seq -= 1;
    return rehash(c);
  },
  truncated_tail: (c) => {
    c.payload.history.entries.pop();
    c.payload.history.entry_count -= 1;
    return rehash(c);
  },
  duplicate_entry_id: (c) => {
    c.payload.history.entries[5].id = c.payload.history.entries[4].id;
    return rehash(c);
  },
  count_mismatch: (c) => {
    c.payload.history.entry_count += 1;
    return rehash(c);
  },
  day_unknown: (c) => {
    c.payload.history.entries[7].day_id = "d-nowhere";
    return rehash(c);
  },
  group_dangling: (c) => {
    c.payload.history.entries.find((x: Mutable) => x.parent_op !== null).group_id = "op-missing";
    return rehash(c);
  },
  undone_with_dangling: (c) => {
    c.payload.history.entries.find((x: Mutable) => x.undone_with !== null).undone_with =
      "op-missing";
    return rehash(c);
  },
  rest_kind_on_test: (c) => {
    c.payload.history.entries[0].rest_kind = "long";
    return rehash(c);
  },
  kind_unknown: (c) => {
    c.payload.history.entries[0].kind = "teleport";
    return rehash(c);
  },
  record_mismatch: (c) => {
    c.payload.history.entries[3].record_id = "c-other";
    return rehash(c);
  },
  external_unlisted: (c) => {
    c.payload.external.participants.pop();
    return rehash(c);
  },
  pack_hash_mismatch: (c) => {
    const files = c.payload.packs[1].content.files;
    files["spells.json"][0] = { ...files["spells.json"][0], name: "Tampered" };
    return rehash(c);
  },
  pack_missing: (c) => {
    c.payload.packs.pop();
    return rehash(c);
  },
  pack_unreferenced: async (c) => {
    c.payload.packs.push(await otherPack());
    return rehash(c);
  },
  head_missing_with_entries: (c) => {
    c.payload.history.meta = null;
    return rehash(c);
  },
  context_duplicate_pack: (c) => {
    c.payload.character.context.packs.push(structuredClone(c.payload.character.context.packs[1]));
    return rehash(c);
  },
  context_order: (c) => {
    c.payload.character.context.packs.reverse();
    c.payload.packs.reverse();
    return rehash(c);
  },
  history_rev_mismatch: (c) => {
    c.payload.source.history_rev += 1;
    return rehash(c);
  },
  state_missing: (c) => {
    c.payload.character.state = null;
    return rehash(c);
  },
};

describe("the contract's 115 invalid cases: refused with exactly their code, never validator_error", () => {
  it.each(cases.map((c) => [c.id, c] as const))("%s", async (_id, cs) => {
    const base = cs.base === "long" ? long() : empty();
    const mutated =
      cs.path !== undefined
        ? await applyPathCase(base, cs)
        : await (MUTATIONS[cs.mutate as string] as (c: Mutable) => Promise<Mutable>)(base);
    const v = await check(mutated);
    expect(v.ok ? "accepted" : v.code).toBe(cs.expect);
  });
});

describe("bytes and limits (§4 step 1, §9)", () => {
  it("over 20 MiB refused before decoding; just under accepted; depth 80, bad UTF-8, HTML, null and scalars refused", async () => {
    const big = new Uint8Array(LOCAL_COPY_LIMITS.copyBytes + 1).fill(0x20);
    expect(await validateLocalCopy(big, { engine: false })).toMatchObject({
      ok: false,
      code: "limit_copy_bytes",
    });
    const near = long();
    const pad = LOCAL_COPY_LIMITS.copyBytes - enc(near).byteLength - 64;
    near.payload.history.entries[0].result = "x".repeat(pad);
    await rehash(near);
    const nearBytes = enc(near);
    expect(nearBytes.byteLength).toBeLessThanOrEqual(LOCAL_COPY_LIMITS.copyBytes);
    expect((await validateLocalCopy(nearBytes, { engine: false })).ok).toBe(true);
    let deep: unknown = 0;
    for (let i = 0; i < 80; i++) deep = [deep];
    const d = long();
    d.payload.history.entries[0].result = deep;
    await rehash(d);
    expect(await check(d)).toMatchObject({ code: "limit_json_depth" });
    expect(
      await validateLocalCopy(new Uint8Array([0xff, 0xfe, 0x00]), { engine: false }),
    ).toMatchObject({ code: "not_utf8" });
    expect(await check("<!doctype html><p>login</p>")).toMatchObject({ code: "content_html" });
    expect(await check("{ not json")).toMatchObject({ code: "not_json" });
    for (const v of ["null", "0", '"x"', "[]", "true"])
      expect(await check(v)).toMatchObject({ code: "format_unknown" });
    for (const f of [
      "srd-table.local-copy/0",
      "srd-table.local-copy/01",
      "srd-table.local-copy/1.0",
    ])
      expect(await check({ ...long(), format: f })).toMatchObject({ code: "format_unsupported" });
    expect(await check({ ...long(), format: 1 })).toMatchObject({ code: "format_unknown" });
  });

  it("more than 64 packs refused (limit_packs); a dependency chain deeper than 8 refused (limit_depth)", async () => {
    const many = empty();
    const ref = many.payload.character.context.packs[0];
    many.payload.character.context.packs = Array.from({ length: 65 }, (_, i) => ({
      ...ref,
      id: `p${i}`,
    }));
    await rehash(many);
    expect(await check(many)).toMatchObject({ code: "limit_packs" });

    const chain: Mutable[] = [];
    const refs: Mutable[] = [];
    let prev: Mutable = null;
    for (let i = 0; i <= 9; i++) {
      const files = {
        "manifest.json": {
          manifest: { id: `syn-d${i}`, version: "1.0.0", requires: prev ? [prev.id] : [] },
          tables: {},
        },
      };
      const r = { id: `syn-d${i}`, version: "1.0.0", sha256: await contentSha({ files }) };
      chain.push({
        format: "srd-table.transfer/1",
        kind: "pack",
        id: r.id,
        revision: null,
        title: r.id,
        sha256: r.sha256,
        content: { files },
        requires: prev
          ? [
              {
                kind: "pack",
                id: prev.id,
                version: prev.version,
                sha256: prev.sha256,
                href: null,
                bytes_sha256: null,
              },
            ]
          : [],
        provenance: {},
        extensions: {},
      });
      refs.push(r);
      prev = r;
    }
    const dc = empty();
    dc.payload.character.context = { packs: refs, sources: null };
    dc.payload.packs = chain;
    await rehash(dc);
    expect(await check(dc)).toMatchObject({ code: "limit_depth" });
    // 9 levels (depth 8) are within the limit
    const ok8 = empty();
    ok8.payload.character.context = { packs: refs.slice(0, 9), sources: null };
    ok8.payload.packs = chain.slice(0, 9);
    await rehash(ok8);
    expect((await check(ok8)).ok).toBe(true);
  });
});

// ───────────────────────── R02-02: wrong types anywhere structural, hostile blocks ─────────────────────────

const OPAQUE = [
  /^request(\.|$)/,
  /^result(\.|$)/,
  /^effect\.state_delta\.\d+\.(before|after)(\.|$)/,
  /^rest\.dice\.\d+\.(roll|rerolled_from)(\.|$)/,
  /^import\.origin(\.|$)/,
  /^costs\.\d+\.action\.(?!type$|level$|key$)/,
];
const NULL_OK = [
  /^parent_op$/,
  /^undone_with$/,
  /^links\.(follows|continues)$/,
  /^context\.(encounter_id|round|combat_id|turn_id)$/,
  /^effect\.replaces_op$/,
  /^outcome\.\d+\.(raw|effective|total|success|critical|damage_total)$/,
  /^rest\.override(\.note)?$/,
];
const OBJECT_OK = [/^rest\.override$/];
function leafPaths(v: unknown, prefix: string[] = []): string[][] {
  const out: string[][] = [prefix];
  if (v && typeof v === "object")
    for (const [k, x] of Object.entries(v)) out.push(...leafPaths(x, [...prefix, k]));
  return out;
}
async function prefixCopy(k: number): Promise<Mutable> {
  const src = long();
  const c = long();
  c.payload.history.entries = c.payload.history.entries.slice(0, k);
  c.payload.history.entry_count = k;
  c.payload.history.meta.next_seq = k + 1;
  const names = new Map(
    src.payload.external.encounters.map((e: Mutable) => [e.encounter_id, e.name]),
  );
  c.payload.external = externalOf(c.payload.history, c.payload.source.record_id);
  for (const e of c.payload.external.encounters) e.name = names.get(e.encounter_id) ?? null;
  return rehash(c);
}

describe("R02-02: typed fields everywhere, never an exception", () => {
  it("a wrong type at every structural position of representative entries is refused (no validator_error)", async () => {
    const base = await prefixCopy(240);
    expect((await check(base)).ok).toBe(true);
    const es = base.payload.history.entries as Mutable[];
    const preds: ((e: Mutable) => unknown)[] = [
      (e) => e.kind === "import_boundary",
      (e) => e.rest?.dice?.length,
      (e) => e.rest?.override,
      (e) => e.costs.length,
      (e) => e.messages.length,
      (e) => e.effect.state_delta.length,
      (e) => e.participants.length > 1,
      (e) => e.links.follows,
      (e) => e.links.continues,
      (e) => e.undone_with,
      (e) => e.kind === "reroll" && e.effect.replaces_op,
      (e) => e.kind === "set_critical",
      (e) => e.kind === "sheet_roll",
      (e) => e.kind === "death_save",
      (e) => e.kind === "test",
    ];
    const pick = new Set<number>();
    for (const p of preds) {
      const i = es.findIndex(p);
      if (i >= 0) pick.add(i);
    }
    let tried = 0;
    const accepted: string[] = [];
    const internal: string[] = [];
    for (const i of pick)
      for (const path of leafPaths(es[i])) {
        const key = path.join(".");
        if (path.length === 0 || OPAQUE.some((r) => r.test(key))) continue;
        const original = getAt(es[i], path);
        const repl: unknown[] = [];
        if (original === null) {
          if (!OBJECT_OK.some((r) => r.test(key))) repl.push({ unexpected: true });
          repl.push([null]);
        } else if (typeof original === "object") {
          repl.push("x", 7);
          if (!NULL_OK.some((r) => r.test(key))) repl.push(null);
        } else {
          repl.push({ unexpected: true }, [original]);
          if (!NULL_OK.some((r) => r.test(key))) repl.push(null);
        }
        for (const value of repl) {
          tried++;
          const c = structuredClone(base);
          let holder = c.payload.history.entries[i];
          for (const k of path.slice(0, -1)) holder = holder[k];
          holder[path.at(-1) as string] = value;
          await rehash(c);
          const v = await check(c);
          if (v.ok) accepted.push(`${key} := ${JSON.stringify(value)}`);
          else if (v.code === "validator_error") internal.push(`${key}: ${v.detail}`);
        }
      }
    expect(tried).toBeGreaterThan(600);
    expect(internal).toEqual([]);
    expect(accepted).toEqual([]);
  }, 120_000);

  it("hostile values in every top-level block are refused, never thrown", async () => {
    const base = await prefixCopy(40);
    const hostile: unknown[] = [
      null,
      0,
      "",
      [],
      {},
      [null],
      { toString: 1 },
      JSON.parse('{"__proto__":{"x":1}}'),
      Number.MAX_SAFE_INTEGER + 2,
    ];
    for (const k of ["source", "character", "history", "external", "packs"])
      for (const h of hostile) {
        const c = structuredClone(base);
        c.payload[k] = structuredClone(h);
        await rehash(c);
        const v = await check(c);
        expect(v.ok, `${k} := ${JSON.stringify(h)}`).toBe(false);
        if (!v.ok) expect(v.code, `${k} := ${JSON.stringify(h)}`).not.toBe("validator_error");
      }
  });

  it("extra fields named constructor, toString or __proto__ are unknown fields, not prototype members", async () => {
    for (const name of ["constructor", "toString", "valueOf", "__proto__"]) {
      const text = LONG.replace(
        '"schema":"kenli.history/1"',
        `"schema":"kenli.history/1","${name}":1`,
      );
      const c = JSON.parse(text);
      await rehash(c);
      expect(await check(c), name).toMatchObject({ code: "history_unknown_field" });
    }
    const top = JSON.parse(`{"__proto__":{"x":1},${LONG.trim().slice(1)}`);
    expect(Object.hasOwn(top, "__proto__")).toBe(true);
    expect(await check(top)).toMatchObject({ code: "envelope_unknown_field" });
  });
});

// ───────────────────────── R02-04: prototype-like ids are valid ids, mapped as data ─────────────────────────

describe("R02-04: ids like constructor/toString/valueOf/123 are data", () => {
  it("valid, mapped injectively with Maps, every field kept, re-exported copy valid", async () => {
    const c = long();
    const es = c.payload.history.entries as Mutable[];
    const pickOp = (pred: (e: Mutable) => boolean) => es.find(pred)?.operation_id as string;
    const targets: [string, string][] = [
      [pickOp((e) => e.seq === 1), "constructor"],
      [
        pickOp((e) =>
          es.some(
            (x) =>
              x.parent_op === e.operation_id && x.kind === "late_advantage" && x.status === "done",
          ),
        ),
        "toString",
      ],
      [pickOp((e) => es.some((x) => x.undone_with === e.operation_id)), "valueOf"],
      [pickOp((e) => es.some((x) => x.effect.replaces_op === e.operation_id)), "hasOwnProperty"],
      [pickOp((e) => e.pending_decision), "isPrototypeOf"],
      [pickOp((e) => e.kind === "short_rest"), "123"],
    ];
    expect(targets.every(([from]) => typeof from === "string")).toBe(true);
    const map = new Map(targets);
    const ren = (v: string | null) => (v !== null && map.has(v) ? (map.get(v) as string) : v);
    for (const e of es) {
      for (const k of ["operation_id", "group_id", "parent_op", "undone_with"]) e[k] = ren(e[k]);
      e.effect.replaces_op = ren(e.effect.replaces_op);
      e.links.follows = ren(e.links.follows);
      e.links.continues = ren(e.links.continues);
    }
    for (const [i, id] of ["constructor", "toString", "valueOf"].entries()) es[i + 1].id = id;
    for (const e of es)
      if (e.links.continues === "op-other-journal-1") e.links.continues = "propertyIsEnumerable";
    c.payload.external = externalOf(c.payload.history, c.payload.source.record_id);
    for (const x of c.payload.external.encounters) x.name = "Cragmaw ambush";
    await rehash(c);
    const before = JSON.stringify(c);
    const v = await check(c);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    let n = 0;
    const m = mapLocalCopy(v.copy, {
      bytesSha: "0".repeat(64),
      fileName: "x.local-copy.json",
      importId: "lc-test",
      newId: (p) => `${p}-${(n++).toString(36).padStart(6, "0")}`,
      now: 1,
    });
    expect(JSON.stringify(v.copy)).toBe(before); // the file's copy is untouched
    const PROTO = ["constructor", "toString", "valueOf", "hasOwnProperty", "isPrototypeOf", "123"];
    const opFields = (e: Mutable) => [
      e.operation_id,
      e.group_id,
      e.parent_op,
      e.undone_with,
      e.effect.replaces_op,
    ];
    expect(
      m.entries.every((e) => opFields(e).every((x) => x === null || typeof x === "string")),
    ).toBe(true);
    expect(m.entries.some((e) => opFields(e).some((x) => PROTO.includes(x)))).toBe(false);
    expect(m.ids.ops.size).toBe(new Set(es.map((e) => e.operation_id)).size);
    expect(new Set(m.ids.ops.values()).size).toBe(m.ids.ops.size);
    expect(new Set(m.entries.map((e) => e.id)).size).toBe(m.entries.length);
    expect(
      m.entries.find((e) => e.links.continues?.endsWith(":propertyIsEnumerable"))?.links.continues,
    ).toBe(`ext:${c.payload.source.installation_id}:propertyIsEnumerable`);
    const roundTrip = JSON.parse(JSON.stringify(m.entries));
    expect(roundTrip).toEqual(m.entries);
  });
});
