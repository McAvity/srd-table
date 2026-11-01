/**
 * kenli F-002 T13a: the guided plan (`srd-table.progression-plan/2`) next to the unchanged `/1`,
 * and a new character's start with the plan's starting kit — synthetic, on the Table's own SRD
 * fixture plan (no private content): the codec (strict, bounded, hashed), the same checkpoints and
 * prefixes as `/1`, the kit staged in memory and written with the character in its one
 * transaction or not at all, the plain start when it's unticked, a played character's advance
 * that never buys or equips, the plan and its guide kept exactly through reload, Undo, a local
 * copy and offline readiness, and an unsupported plan kept as stored.
 */

import "../helpers/node-blob";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { commitLocalCopy } from "@/import/localCopy/commit";
import { exportLocalCopy } from "@/import/localCopy/export";
import { validateLocalCopy } from "@/import/localCopy/format";
import { planLocalCopy } from "@/import/localCopy/plan";
import { canonicalJson, contentSha } from "@/lib/canonical";
import { db } from "@/persistence/db";
import { flushNow } from "@/persistence/sync";
import {
  type Confirmed,
  confirmHooks,
  confirmStep,
  type ProgressionRefusal,
  previewAdvance,
  previewStart,
  type StepPreview,
  startFromPlan,
} from "@/progression/advance";
import { PLAN_FORMAT, PLAN_FORMAT_GUIDED, parsePlanFile } from "@/progression/codec";
import { readProgression } from "@/progression/record";
import { useDocuments } from "@/store/documents";
import { bytesOf, dumpDb, Installations, type Loose, ok } from "../localCopy/helpers";
import { FIXTURE_DIR } from "./generate-fixtures";

const read = (name: string): Loose => JSON.parse(readFileSync(join(FIXTURE_DIR, name), "utf8"));
const FIGHTER = () => read("fighter-1-6.plan.json");
const docs = () => useDocuments.getState();
const rec = (id: string) => docs().characters[id] as Loose;
const inst = new Installations();
const code = (r: { ok: boolean; code?: string }) => (r.ok ? "ok" : r.code);
const coins = (s: Loose) =>
  s.currency.cp +
  s.currency.sp * 10 +
  s.currency.ep * 50 +
  s.currency.gp * 100 +
  s.currency.pp * 1000;
function must<T extends { ok: boolean }>(r: T | ProgressionRefusal): T {
  if (r.ok !== true) throw new Error(JSON.stringify(r).slice(0, 1500));
  return r as T;
}

/** The SRD Fighter fixture (option A gear: Chain Mail, 8 Javelins…; 18 GP) as a guided `/2`. */
const KIT = [
  {
    item: "chain-mail",
    units: 1,
    equip: true,
    origin: "source",
    why: "granted by the class: not bought again",
  },
  { item: "whip", units: 1, equip: false, origin: "author" },
  {
    item: "arrow",
    units: 30,
    equip: false,
    origin: "author",
    why: "30 wanted, 20 granted: one more bundle of 20 (40 received)",
  },
];
const GUIDE = (kit: Loose[] = KIT) => ({
  kits: [{ from_level: 1, title: "Test kit", items: kit, origin: "author" }],
  play: {
    base: {
      text: "Attack; Second Wind as a Bonus Action.\nShort Rest regains it.",
      origin: "author",
    },
    levels: [{ level: 2, text: "Action Surge.", origin: "source" }],
  },
  purchases: [{ item: "plate-armor", priority: 1, text: "Later, with the DM.", origin: "author" }],
  alternatives: [
    { item: "scale-mail", instead_of: "chain-mail", text: "Cheaper.", origin: "author" },
  ],
  controls: [{ text: "Feature buttons on the sheet.", origin: "author" }],
});
async function guided(edit: (plan: Loose) => void = () => undefined, format = PLAN_FORMAT_GUIDED) {
  const f = FIGHTER();
  f.format = format;
  f.plan.guide = structuredClone(GUIDE());
  edit(f.plan);
  f.plan_sha256 = await contentSha(f.plan);
  return f;
}

beforeEach(async () => {
  await inst.open(`T13-${Math.random().toString(36).slice(2)}`);
});
afterEach(() => {
  confirmHooks.beforeDone = undefined;
});
afterAll(() => inst.close());

describe("the codec: /2 next to the unchanged strict /1", () => {
  it("/1 as before; /2 needs its guide; a guide in /1 is unknown; /3 is newer", async () => {
    expect((await parsePlanFile(FIGHTER())).ok).toBe(true);
    expect(FIGHTER().format).toBe(PLAN_FORMAT);
    const p = (f: Loose) => parsePlanFile(f).then((r) => (r.ok ? "ok" : r.problem.code));
    expect(await p(await guided())).toBe("ok");
    expect(await p(await guided(() => undefined, PLAN_FORMAT))).toBe("plan_unknown_field");
    expect(await p(await guided((pl) => delete pl.guide))).toBe("plan_missing_field");
    expect(await p(await guided(() => undefined, "srd-table.progression-plan/3"))).toBe(
      "plan_format_newer",
    );
  });

  it("the guide is hashed; bounded and strict: count, length, control characters, a price, the levels", async () => {
    const p = (f: Loose) => parsePlanFile(f).then((r) => (r.ok ? "ok" : r.problem.code));
    const f = await guided();
    f.plan.guide.play.base.text = "changed";
    expect(await p(f)).toBe("plan_hash_mismatch");
    expect(await p(await guided((pl) => (pl.guide.kits[0].items[1].units = 0)))).toBe(
      "plan_field_invalid",
    );
    expect(await p(await guided((pl) => (pl.guide.kits[0].items[1].units = 1001)))).toBe(
      "plan_field_invalid",
    );
    expect(await p(await guided((pl) => (pl.guide.kits[0].items[1].units = -2)))).toBe(
      "plan_field_invalid",
    );
    expect(await p(await guided((pl) => (pl.guide.kits[0].items[1].price = "1 CP")))).toBe(
      "plan_unknown_field",
    );
    expect(await p(await guided((pl) => (pl.guide.play.base.text = "x".repeat(4001))))).toBe(
      "plan_limit_text",
    );
    expect(await p(await guided((pl) => (pl.guide.play.base.text = "a\u0007b")))).toBe(
      "plan_field_invalid",
    );
    expect(await p(await guided((pl) => (pl.guide.kits[0].from_level = 2)))).toBe(
      "plan_field_invalid",
    );
    expect(await p(await guided((pl) => (pl.guide.play.levels[0].level = 7)))).toBe(
      "plan_field_invalid",
    );
    expect(await p(await guided((pl) => pl.guide.kits[0].items.push({ ...KIT[1] })))).toBe(
      "plan_field_invalid",
    );
    expect(await p(await guided((pl) => (pl.guide.kits[0].items[0].origin = "dm")))).toBe(
      "plan_field_invalid",
    );
    expect(
      await p(
        await guided(
          (pl) =>
            (pl.guide.kits = Array.from({ length: 9 }, (_, i) => ({
              ...pl.guide.kits[0],
              from_level: i + 1,
            }))),
        ),
      ),
    ).toBe("plan_field_invalid");
  });

  it("the same checkpoints and prefixes as /1; another plan hash; the catalog checks the guide's items", async () => {
    const one = await inst.fx.engine.compilePlan(FIGHTER());
    const two = await inst.fx.engine.compilePlan(await guided());
    if (!one.ok || !two.ok) throw new Error("compile");
    expect(two.plan_sha256).not.toBe(one.plan_sha256);
    expect(two.checkpoints.map((c) => c.prefix_sha256)).toEqual(
      one.checkpoints.map((c) => c.prefix_sha256),
    );
    expect(canonicalJson(two.checkpoints.map((c) => c.build))).toBe(
      canonicalJson(one.checkpoints.map((c) => c.build)),
    );
    expect(two.guide_items?.find((q) => q.item === "arrow")).toMatchObject({ cp: 100, bundle: 20 });
    expect(one.guide_items).toBeUndefined();
    const c = async (f: Loose) => {
      const r = await inst.fx.engine.compilePlan(f);
      return r.ok ? "ok" : r.problem.code;
    };
    expect(await c(await guided((pl) => (pl.guide.kits[0].items[1].item = "no-such-thing")))).toBe(
      "plan_guide_item",
    );
    // A kit is bought, never granted: an item without a price can't be in it (a purchase can).
    expect(await c(await guided((pl) => (pl.guide.kits[0].items[1].item = "bag-of-holding")))).toBe(
      "plan_guide_item",
    );
    expect(await c(await guided((pl) => (pl.guide.purchases[0].item = "bag-of-holding")))).toBe(
      "ok",
    );
  });
});

describe("a new character with the kit: staged in memory, written in the one start transaction", () => {
  it("preview: owned grants not bought, whole bundles, catalog cost, coins once; the start writes exactly that", async () => {
    const file = await guided();
    const plain = must(await previewStart(file, 1, false)) as Loose;
    const p = must(await previewStart(file, 1, true)) as Loose;
    expect(
      p.kit.lines.map((l: Loose) => [l.item, l.owned, l.bundles, l.received, l.cost_cp]),
    ).toEqual([
      ["chain-mail", 1, 0, 0, 0],
      ["whip", 0, 1, 1, 200],
      ["arrow", 20, 1, 20, 100],
    ]);
    expect(p.kit.before_cp).toBe(coins(plain.state));
    expect(p.kit.spent_cp).toBe(300);
    expect(p.kit.after_cp).toBe(coins(plain.state) - 300);
    const before = await dumpDb();
    // Nothing written by a preview.
    expect(await dumpDb()).toBe(before);
    const r = must(
      await startFromPlan(file, 1, {
        kit: true,
        expect: { spent_cp: 300, after_cp: p.kit.after_cp },
      }),
    ) as Loose;
    const c = rec(r.id);
    expect(coins(c.state)).toBe(p.kit.after_cp);
    expect(c.state.inventory.find((i: Loose) => i.item === "arrow")?.qty).toBe(40);
    expect(c.state.inventory.find((i: Loose) => i.item === "chain-mail")?.equipped).toBe(true);
    // The plan kept with its guide, exactly; no new field on the association.
    expect(canonicalJson(c.progression.plan.plan.guide)).toBe(canonicalJson(file.plan.guide));
    expect(c.progression.plan.plan_sha256).toBe(file.plan_sha256);
    expect(Object.keys(c.progression).sort()).toEqual([
      "applied_level",
      "bound_at",
      "plan",
      "prefix_sha256",
      "schema",
    ]);
    await flushNow();
    await inst.reload();
    expect(coins(rec(r.id).state)).toBe(p.kit.after_cp);
    expect((await readProgression(rec(r.id).progression)).ok).toBe(true);
  });

  it("unticked: the plain start, the same state as /1's; a /1 plan has no kit", async () => {
    const a = must(await startFromPlan(await guided(), 1)) as Loose;
    const b = must(await startFromPlan(FIGHTER(), 1)) as Loose;
    const strip = (s: Loose) =>
      canonicalJson({ ...s, inventory: s.inventory.map(({ id: _id, ...x }: Loose) => x) });
    expect(strip(rec(a.id).state)).toBe(strip(rec(b.id).state));
    expect(code(await startFromPlan(FIGHTER(), 1, { kit: true }))).toBe("start_kit_none");
  });

  it("refused with nothing written: not enough coins, a changed preview, an aborted transaction, a second click", async () => {
    const before = await dumpDb();
    const count = () => Object.keys(docs().characters).length;
    const n = count();
    const poor = await guided(
      (pl) =>
        (pl.guide.kits[0].items = [
          { item: "plate-armor", units: 1, equip: true, origin: "author" },
        ]),
    );
    const p = await previewStart(poor, 1, true);
    expect(code(p)).toBe("start_kit_refused");
    expect(code(await startFromPlan(poor, 1, { kit: true }))).toBe("start_kit_refused");
    const file = await guided();
    expect(
      code(await startFromPlan(file, 1, { kit: true, expect: { spent_cp: 1, after_cp: 1 } })),
    ).toBe("start_kit_changed");
    confirmHooks.beforeDone = async () => {
      throw new Error("injected");
    };
    expect(code(await startFromPlan(file, 1, { kit: true }))).toBe("storage_failed");
    confirmHooks.beforeDone = undefined;
    expect(await dumpDb()).toBe(before);
    expect(count()).toBe(n);
    const [x, y] = await Promise.all([
      startFromPlan(file, 1, { kit: true }),
      startFromPlan(file, 1, { kit: true }),
    ]);
    expect([code(x), code(y)].sort()).toEqual(["ok", "start_busy"]);
    expect(count()).toBe(n + 1);
  });

  it("higher levels: the same coins, no extra wealth", async () => {
    const file = await guided();
    const one = must(await previewStart(file, 1, true)) as Loose;
    const six = must(await previewStart(file, 6, true)) as Loose;
    expect(six.kit.before_cp).toBe(one.kit.before_cp);
    expect(six.kit.after_cp).toBe(one.kit.after_cp);
  });
});

describe("a played character never buys or equips: advance, Undo, copy, readiness, old readers", () => {
  it("advance 2 → 3 on the guided plan keeps coins, items and what's worn; Undo; a local copy keeps the guide exactly", async () => {
    const file = await guided();
    const { id } = must(await startFromPlan(file, 2, { kit: true })) as Loose;
    const sword = rec(id).state.inventory.find((i: Loose) => i.item === "whip");
    must(await docs().playAction(id, { type: "equip", id: sword.id, equipped: true } as Loose));
    must(await docs().playAction(id, { type: "adjust_currency", changes: { gp: -1 } } as Loose));
    await flushNow();
    const before = rec(id).state;
    const p = must(await previewAdvance(id)) as StepPreview;
    must(await confirmStep(p)) as Confirmed;
    const after = rec(id).state;
    expect(canonicalJson(after.currency)).toBe(canonicalJson(before.currency));
    expect(canonicalJson(after.inventory)).toBe(canonicalJson(before.inventory));
    expect(rec(id).progression.applied_level).toBe(3);
    expect(canonicalJson(rec(id).progression.plan.plan.guide)).toBe(canonicalJson(file.plan.guide));
    await docs().undo(id);
    expect(rec(id).progression.applied_level).toBe(2);
    expect(canonicalJson(rec(id).state.inventory)).toBe(canonicalJson(before.inventory));
    await docs().redo(id);
    await flushNow();
    const source = rec(id);
    const x = ok(await exportLocalCopy(id));
    const bytes = await bytesOf(x.blob);
    expect(canonicalJson(x.copy.payload.character.progression)).toBe(
      canonicalJson(source.progression),
    );
    await inst.open(`T13-dest-${Math.random().toString(36).slice(2)}`);
    const v = await validateLocalCopy(bytes);
    if (!v.ok) throw new Error(JSON.stringify(v));
    const r = ok(
      await commitLocalCopy(await planLocalCopy(v.copy, v.bytes_sha256, "x.local-copy.json")),
    ) as Loose;
    expect(canonicalJson(rec(r.recordId).progression)).toBe(canonicalJson(source.progression));
    expect(rec(r.recordId).progression.plan.plan_sha256).toBe(file.plan_sha256);
  }, 120_000);

  it("a stored plan this app doesn't read (/3) is kept exactly through a save and a reload; planned actions refuse it", async () => {
    const { id } = must(await startFromPlan(FIGHTER(), 2)) as Loose;
    await flushNow();
    const row = (await (await db()).get("characters", id)) as Loose;
    const newer = {
      ...row.progression,
      plan: {
        ...row.progression.plan,
        format: "srd-table.progression-plan/3",
        plan: { ...row.progression.plan.plan, future: { x: 1 } },
      },
    };
    await (await db()).put("characters", { ...row, progression: newer });
    await inst.reload();
    expect(code(await previewAdvance(id))).toBe("progression_unsupported");
    must(await docs().playAction(id, { type: "damage", amount: 1 } as Loose));
    await flushNow();
    expect(canonicalJson(((await (await db()).get("characters", id)) as Loose).progression)).toBe(
      canonicalJson(newer),
    );
    await inst.reload();
    expect(canonicalJson(rec(id).progression)).toBe(canonicalJson(newer));
  });
});
