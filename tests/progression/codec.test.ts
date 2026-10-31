/**
 * kenli F-002 T03: the pure plan codec (contract §2) at its boundaries — exact limits accepted, one
 * over refused with the contract's code — and a field-by-field mutation sweep over a real fixture:
 * every unknown field, missing field and bad value is refused, never stripped. No engine here.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { contentSha } from "@/lib/canonical";
import { PLAN_LIMITS, parsePlanFile } from "@/progression/codec";
import { FIXTURE_DIR } from "./generate-fixtures";
import { clone, type J } from "./plans";

const fixture = (name: string): J => JSON.parse(readFileSync(join(FIXTURE_DIR, name), "utf8"));
const base = () => fixture("fighter-1-6.plan.json");
/** The file with its hash recomputed (so only the change itself is judged). */
const rehash = async (f: J) => ({ ...f, plan_sha256: await contentSha(f.plan) });
const code = async (f: unknown) => {
  const r = await parsePlanFile(f);
  return r.ok ? "ok" : r.problem.code;
};
const choice = (key: string, values: string[]) => ({ op: "choice", key, values, origin: "author" });

describe("plan codec: the document", () => {
  it("reads a real fixture whole: range, hash, no envelopes", async () => {
    const r = await parsePlanFile(base());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.range).toEqual({ from: 1, to: 6 });
    expect(r.plan_sha256).toBe(base().plan_sha256);
    expect(r.envelopes.size).toBe(0);
  });

  it("bytes, text and parsed JSON are the same document", async () => {
    const text = JSON.stringify(base());
    for (const input of [text, new TextEncoder().encode(text), JSON.parse(text)])
      expect(await code(input)).toBe("ok");
    expect(await code(new Uint8Array([0xff, 0xfe]))).toBe("plan_field_invalid");
    expect(await code("{not json")).toBe("plan_field_invalid");
  });

  it("format: a newer version and another family are refused, never read as /1", async () => {
    expect(await code({ ...base(), format: "srd-table.progression-plan/2" })).toBe(
      "plan_format_newer",
    );
    expect(await code({ ...base(), format: "srd-table.progression-plan/0" })).toBe(
      "plan_format_unknown",
    );
    expect(await code({ ...base(), format: "srd-table.local-copy/2" })).toBe("plan_format_unknown");
    const { format: _f, ...noFormat } = base();
    expect(await code(noFormat)).toBe("plan_missing_field");
  });

  it("hash: the canonical JSON's; envelopes don't count", async () => {
    const f = base();
    expect(await code({ ...f, plan_sha256: "f".repeat(64) })).toBe("plan_hash_mismatch");
    expect(await code({ ...f, plan_sha256: "F".repeat(64) })).toBe("plan_field_invalid");
    // Key order and whitespace don't change the canonical hash.
    const reverseKeys = (v: J): J =>
      Array.isArray(v)
        ? v.map(reverseKeys)
        : v && typeof v === "object"
          ? Object.fromEntries(
              Object.entries(v)
                .reverse()
                .map(([k, x]) => [k, reverseKeys(x)]),
            )
          : v;
    const reordered = reverseKeys(f.plan);
    expect(Object.keys(reordered)[0]).toBe("levels");
    expect(await code({ ...f, plan: reordered })).toBe("ok");
    const changed = clone(f);
    changed.plan.title = "Another";
    expect(await code(changed)).toBe("plan_hash_mismatch");
  });

  it("refs: the SRD first, no duplicate id, exact hex hashes", async () => {
    const f = base();
    const dup = clone(f);
    dup.plan.packs.push(dup.plan.packs[0]);
    expect(await code(await rehash(dup))).toBe("plan_field_invalid");
    const notFirst = clone(f);
    notFirst.plan.packs = [
      { id: "test-x", version: null, sha256: "a".repeat(64) },
      ...notFirst.plan.packs,
    ];
    expect(await code(await rehash(notFirst))).toBe("plan_pack_order");
    const badSha = clone(f);
    badSha.plan.packs[0].sha256 = "xyz";
    expect(await code(await rehash(badSha))).toBe("plan_field_invalid");
    const empty = clone(f);
    empty.plan.packs = [];
    expect(await code(await rehash(empty))).toBe("plan_field_invalid");
  });

  it("sources: null or a list of strings", async () => {
    const f = clone(base());
    f.plan.sources = ["srd-5.2.1"];
    expect(await code(await rehash(f))).toBe("ok");
    f.plan.sources = "srd-5.2.1";
    expect(await code(await rehash(f))).toBe("plan_field_invalid");
    f.plan.sources = [1];
    expect(await code(await rehash(f))).toBe("plan_field_invalid");
  });
});

describe("plan codec: limits (exactly at the limit accepted, one over refused)", () => {
  it("file bytes: 20 MiB", async () => {
    const text = JSON.stringify(base());
    const pad = PLAN_LIMITS.fileBytes - new TextEncoder().encode(text).byteLength;
    // Whitespace after the JSON keeps it the same document.
    expect(await code(text + " ".repeat(pad))).toBe("ok");
    expect(await code(text + " ".repeat(pad + 1))).toBe("plan_limit_bytes");
  });

  it("canonical plan bytes: 2 MiB", async () => {
    const f = clone(base());
    const values = Array.from({ length: 64 }, (_, i) => `v${i}-${"x".repeat(120)}`);
    const big = Array.from({ length: 128 }, () => choice("class:fighter#skills", values));
    f.plan.levels = Array.from({ length: 3 }, (_, i) => ({
      level: i + 2,
      ops: [{ op: "level_up", class_id: "fighter", hp: null, origin: "author" }, ...big.slice(1)],
    }));
    expect(await code(await rehash(f))).toBe("plan_limit_plan_bytes");
  });

  it("levels: 19 steps (level 20)", async () => {
    const f = clone(base());
    const step = (level: number) => ({
      level,
      ops: [{ op: "level_up", class_id: "fighter", hp: null, origin: "author" }],
    });
    f.plan.levels = Array.from({ length: 19 }, (_, i) => step(i + 2));
    expect(await code(await rehash(f))).toBe("ok");
    f.plan.levels.push(step(21));
    expect(await code(await rehash(f))).toBe("plan_limit_levels");
  });

  it("ops: 128 per step, 2048 in all", async () => {
    const f = clone(base());
    const up = { op: "level_up", class_id: "fighter", hp: null, origin: "author" };
    const many = (n: number) => [
      up,
      ...Array.from({ length: n - 1 }, () => choice("class:fighter#skills", ["athletics"])),
    ];
    f.plan.levels = [{ level: 2, ops: many(128) }];
    expect(await code(await rehash(f))).toBe("ok");
    f.plan.levels = [{ level: 2, ops: many(129) }];
    expect(await code(await rehash(f))).toBe("plan_limit_step_ops");
    f.plan.start.ops = f.plan.start.ops.slice(0, 1);
    f.plan.levels = Array.from({ length: 16 }, (_, i) => ({ level: i + 2, ops: many(128) }));
    // 1 + 16 × 128 = 2049
    expect(await code(await rehash(f))).toBe("plan_limit_ops");
    f.plan.levels[15].ops.pop();
    expect(await code(await rehash(f))).toBe("ok");
    f.plan.start.ops = Array.from({ length: 129 }, () => f.plan.start.ops[0]);
    f.plan.levels = [];
    expect(await code(await rehash(f))).toBe("plan_limit_step_ops");
  });

  it("packs: 64 refs", async () => {
    const f = clone(base());
    const extra = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        id: `test-p${i}`,
        version: null,
        sha256: "a".repeat(64),
      }));
    f.plan.packs = [f.plan.packs[0], ...extra(63)];
    expect(await code(await rehash(f))).toBe("ok");
    f.plan.packs = [f.plan.packs[0], ...extra(64)];
    expect(await code(await rehash(f))).toBe("plan_limit_packs");
  });

  it("JSON depth: 64 (checked before any field)", async () => {
    const nest = (d: number): J => (d === 0 ? 1 : [nest(d - 1)]);
    // The top object is depth 1: 63 more levels of arrays inside an extra field.
    expect(await code({ ...base(), deep: nest(63) })).toBe("plan_unknown_field");
    expect(await code({ ...base(), deep: nest(64) })).toBe("plan_limit_depth");
  });

  it("texts: title 200, why 1000, authorship 2000 code points; keys 200; values 64 × 128", async () => {
    const f = clone(base());
    f.plan.title = "ą".repeat(200);
    expect(await code(await rehash(f))).toBe("ok");
    f.plan.title = "ą".repeat(201);
    expect(await code(await rehash(f))).toBe("plan_limit_text");
    const g = clone(base());
    g.plan.levels[0].ops[0].why = "x".repeat(1001);
    expect(await code(await rehash(g))).toBe("plan_limit_text");
    const h = clone(base());
    h.plan.authorship.author = "x".repeat(2001);
    expect(await code(await rehash(h))).toBe("plan_limit_text");
    const k = clone(base());
    k.plan.levels[0].ops.push(choice(`class:fighter#${"k".repeat(187)}`, ["a"]));
    expect(k.plan.levels[0].ops.at(-1).key.length).toBe(201);
    expect(await code(await rehash(k))).toBe("plan_field_invalid");
    const v = clone(base());
    v.plan.levels[0].ops.push(
      choice(
        "class:fighter#skills",
        Array.from({ length: 65 }, (_, i) => `v${i}`),
      ),
    );
    expect(await code(await rehash(v))).toBe("plan_field_invalid");
    v.plan.levels[0].ops.at(-1).values = ["a".repeat(129)];
    expect(await code(await rehash(v))).toBe("plan_field_invalid");
  });
});

describe("plan codec: ops", () => {
  it("keys: opaque engine keys with : # @ + = are data; other characters refused", async () => {
    for (const key of [
      "feat:magic-initiate@background:custom-background#feat#spell_list",
      "class:cleric#divine_order=thaumaturge#cantrip",
      "class:bard:3#replace:bard:bard-prepared",
      "subclass:circle-of-the-land:3#land=arid+10#x",
    ]) {
      const f = clone(base());
      f.plan.levels[0].ops.push(choice(key, key.includes("#replace:") ? ["a", "b"] : ["a"]));
      expect(await code(await rehash(f)), key).toBe("ok");
    }
    for (const key of [
      "Class:fighter#skills",
      "class:fighter",
      "class fighter#x",
      "class:<x>#y",
      "../etc#x",
      "#x",
    ]) {
      const f = clone(base());
      f.plan.levels[0].ops.push(choice(key, ["a"]));
      expect(await code(await rehash(f)), key).toBe("plan_field_invalid");
    }
  });

  it("a step: exactly one level_up, first; HP null or a whole number ≥ 1", async () => {
    const f = clone(base());
    f.plan.levels[1].ops.reverse();
    expect(await code(await rehash(f))).toBe("plan_level_up_position");
    const g = clone(base());
    g.plan.levels[0].ops.push({ op: "level_up", class_id: "fighter", hp: null, origin: "author" });
    expect(await code(await rehash(g))).toBe("plan_level_up_position");
    const e = clone(base());
    e.plan.levels[0].ops = [];
    expect(await code(await rehash(e))).toBe("plan_level_up_position");
    for (const hp of [0, -1, 1.5, "6", true]) {
      const h = clone(base());
      h.plan.levels[0].ops[0].hp = hp;
      expect(await code(await rehash(h)), String(hp)).toBe("plan_hp_invalid");
    }
    const ok = clone(base());
    ok.plan.levels[0].ops[0].hp = 7;
    expect(await code(await rehash(ok))).toBe("ok");
  });

  it("forbidden ops, start ops in a step, level_up in start; unknown op names", async () => {
    for (const op of [
      { op: "remove_level", origin: "author" },
      { op: "level_class", level: 2, class_id: "rogue", origin: "author" },
      { op: "level_hp", level: 2, hp: null, origin: "author" },
      { op: "class", id: "rogue", origin: "author" },
      { op: "name", name: "x", origin: "author" },
    ]) {
      const f = clone(base());
      f.plan.levels[1].ops.push(op);
      expect(await code(await rehash(f)), op.op).toBe("plan_op_forbidden");
    }
    const s = clone(base());
    s.plan.start.ops.push({ op: "level_up", class_id: "fighter", hp: null, origin: "author" });
    expect(await code(await rehash(s))).toBe("plan_op_forbidden");
    const u = clone(base());
    u.plan.levels[1].ops.push({ op: "eval", origin: "author" });
    expect(await code(await rehash(u))).toBe("plan_field_invalid");
  });

  it("levels continuous from 2; a replacement is two different ids", async () => {
    const f = clone(base());
    f.plan.levels[1].level = 4;
    expect(await code(await rehash(f))).toBe("plan_level_gap");
    for (const values of [["a"], ["a", "a"], ["a", "b", "c"], []]) {
      const g = clone(base());
      g.plan.levels[0].ops.push(choice("class:bard:2#replace:bard:bard-prepared", values));
      expect(await code(await rehash(g)), JSON.stringify(values)).toBe("plan_replace_arity");
    }
  });
});

/** Every object of the plan (path → object), for the mutation sweep. */
function objects(v: J, path = "plan"): [string, J][] {
  if (!v || typeof v !== "object") return [];
  const own: [string, J][] = Array.isArray(v) ? [] : [[path, v]];
  return [
    ...own,
    ...Object.entries(v).flatMap(([k, x]) =>
      objects(x, Array.isArray(v) ? `${path}[${k}]` : `${path}.${k}`),
    ),
  ];
}
const at = (root: J, path: string): J =>
  path
    .replace(/^plan/, "")
    .split(/\.|\[|\]/)
    .filter(Boolean)
    .reduce((o, k) => o[k], root);

describe("plan codec: mutation sweep over a real fixture", () => {
  const OPTIONAL = new Set(["why", "pool"]);
  /** Objects whose keys are data (ability maps), not fields. */
  const MAPS = /\.(scores|bonus)$/;

  it("every object: an added field refused (`plan_unknown_field`), every required field missing refused", async () => {
    const f = base();
    let unknown = 0;
    let missing = 0;
    for (const [path, obj] of objects(f.plan)) {
      const added = clone(f);
      at(added.plan, path).extra_field = 1;
      const got = await code(await rehash(added));
      expect(got, path).toBe("plan_unknown_field");
      unknown++;
      if (MAPS.test(path)) continue;
      for (const k of Object.keys(obj)) {
        if (OPTIONAL.has(k)) continue;
        const removed = clone(f);
        delete at(removed.plan, path)[k];
        const r = await code(await rehash(removed));
        expect(r, `${path}.${k}`).not.toBe("ok");
        missing++;
      }
    }
    expect(unknown).toBeGreaterThan(40);
    expect(missing).toBeGreaterThan(100);
  });

  it("every scalar: a value of the wrong type refused", async () => {
    const f = base();
    let n = 0;
    for (const [path, obj] of objects(f.plan)) {
      for (const [k, v] of Object.entries(obj)) {
        if (v === null || typeof v === "object") continue;
        const bad = clone(f);
        at(bad.plan, path)[k] = typeof v === "number" ? "1" : 1;
        expect(await code(await rehash(bad)), `${path}.${k}`).not.toBe("ok");
        n++;
      }
    }
    expect(n).toBeGreaterThan(100);
  });
});
