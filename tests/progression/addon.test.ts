/**
 * kenli F-002 T03: the add-on bind checks (contract §6.3) on invented packs: an add-on that only
 * adds new options passes (future options aren't a change of the selected mechanics); patches,
 * `creation`, forbidden tables, outside `requires`, a filter that excludes it and any id an earlier
 * pack has — the SRD's, or one the record's `sources` filter hides — are refused before any
 * preview; a selected mechanic or the stored state that would change is refused with its paths.
 * Nothing is registered or written.
 */

import type { CharacterBuild, CharacterState } from "srd-rules-engine";
import { describe, expect, it } from "vitest";
import { nodeFacade } from "@/engine/node";
import type { ContentContext, PackFiles, PackRef } from "@/lib/canonical";
import { packRefOf } from "@/lib/canonical";
import { checkAddonFiles } from "@/progression/addon";
import { fighter } from "../fixtures/characters";
import { clone, type J } from "./plans";

const feat = (id: string, source: string, category = "general") => ({
  id,
  name: id,
  source,
  category,
  ...(category === "general" ? { prerequisite: { level: 4 } } : {}),
  grants: {},
});
const pack = (
  id: string,
  requires: string[],
  tables: Record<string, unknown[]>,
  extra: J = {},
): PackFiles => ({
  "manifest.json": {
    manifest: { id, version: "1.0.0", source: id, requires },
    tables: Object.fromEntries(
      Object.entries(tables).map(([t, rows]) => [t, { file: `${t}.json`, count: rows.length }]),
    ),
    ...extra,
  },
  ...Object.fromEntries(Object.entries(tables).map(([t, rows]) => [`${t}.json`, rows])),
});

const BASE = pack("test-base", ["srd-5.2.1"], {
  feats: [feat("test-visible", "test-base"), feat("test-hidden", "test-hidden")],
});
const ADDON = pack("test-addon", ["srd-5.2.1", "test-base"], {
  feats: [feat("test-new", "test-addon", "origin")],
});

async function setup() {
  const e = nodeFacade({ seed: 1 });
  const srd = await e.servedPack("srd-5.2.1");
  const base = await packRefOf(BASE);
  const addon = await packRefOf(ADDON);
  const record: ContentContext = { packs: [srd, base], sources: null };
  const plan: ContentContext = { packs: [srd, base, addon], sources: null };
  const build = await fighter(e, 3);
  const state = await e.createState(build);
  return { e, srd, base, addon, record, plan, build, state };
}
type S = Awaited<ReturnType<typeof setup>>;
const check = (
  s: S,
  over: Partial<{
    build: CharacterBuild;
    state: CharacterState;
    record: ContentContext;
    plan: ContentContext;
    packs: PackFiles[];
  }> = {},
) =>
  s.e.checkAddon({
    build: over.build ?? s.build,
    state: over.state ?? s.state,
    record: over.record ?? s.record,
    plan: over.plan ?? s.plan,
    packs: over.packs ?? [BASE, ADDON],
  });
async function variant(files: PackFiles, _s?: S): Promise<{ ref: PackRef; files: PackFiles }> {
  const ref = await packRefOf(files);
  return { ref, files };
}

describe("add-on bind checks (§6.3)", () => {
  it("an add-on of new options only: the selected mechanics and the stored state unchanged → ok", async () => {
    const s = await setup();
    const r = await check(s);
    expect(r).toEqual({ ok: true, extra: [s.addon] });
    // Nothing was registered by the check.
    expect(await s.e.localPackFiles(s.addon)).toEqual({ ok: false, code: "context_unavailable" });
  });

  it("an id the SRD has (spells/wish): addon_id_collision, every collision named", async () => {
    const s = await setup();
    const bad = await variant(
      pack("test-addon", ["srd-5.2.1", "test-base"], {
        spells: [{ id: "wish", name: "Wish", source: "test-addon" }],
        feats: [feat("test-visible", "test-addon")],
      }),
      s,
    );
    const r = await check(s, {
      plan: { ...s.plan, packs: [s.srd, s.base, bad.ref] },
      packs: [BASE, bad.files],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("addon_id_collision");
    expect(r.collisions).toEqual([
      { table: "spells", id: "wish", pack: "srd-5.2.1" },
      { table: "feats", id: "test-visible", pack: "test-base" },
    ]);
  });

  it("an id the record's sources filter hides still collides", async () => {
    const s = await setup();
    const sources = ["srd-5.2.1", "test-base", "test-addon"];
    // The hidden feat is really out of the record's catalog…
    const probe = nodeFacade({ seed: 1 });
    await probe.registerPacks([BASE]);
    const feats = (await probe.entries("feats", { packs: [s.srd, s.base], sources })) as {
      id: string;
    }[];
    expect(feats.some((f) => f.id === "test-hidden")).toBe(false);
    expect(feats.some((f) => f.id === "test-visible")).toBe(true);
    // …and an add-on redefining it is refused anyway.
    const bad = await variant(
      pack("test-addon", ["srd-5.2.1", "test-base"], {
        feats: [feat("test-hidden", "test-addon")],
      }),
      s,
    );
    const r = await check(s, {
      record: { packs: [s.srd, s.base], sources },
      plan: { packs: [s.srd, s.base, bad.ref], sources },
      packs: [BASE, bad.files],
    });
    expect(r.ok ? "ok" : r.code).toBe("addon_id_collision");
    if (!r.ok)
      expect(r.collisions).toEqual([{ table: "feats", id: "test-hidden", pack: "test-base" }]);
  });

  it.each([
    [
      "patches",
      { patches: [{ target: "feats/test-visible", op: "set", path: "name", value: "x" }] },
      "addon_patch",
    ],
    ["creation", { creation: { max_level: 20 } }, "addon_creation"],
  ])("%s → refused", async (_n, extra, codeWanted) => {
    const s = await setup();
    const bad = await variant(
      pack(
        "test-addon",
        ["srd-5.2.1", "test-base"],
        { feats: [feat("test-new", "test-addon", "origin")] },
        extra,
      ),
      s,
    );
    const r = await check(s, {
      plan: { ...s.plan, packs: [s.srd, s.base, bad.ref] },
      packs: [BASE, bad.files],
    });
    expect(r.ok ? "ok" : r.code).toBe(codeWanted);
  });

  it("a forbidden table, or requires outside the context → addon_forbidden_table", async () => {
    const s = await setup();
    for (const files of [
      pack("test-addon", ["srd-5.2.1"], {
        species: [{ id: "test-folk", name: "Folk", source: "test-addon" }],
      }),
      pack("test-addon", ["srd-5.2.1", "test-elsewhere"], {
        feats: [feat("test-new", "test-addon")],
      }),
    ]) {
      const bad = await variant(files, s);
      const r = await check(s, {
        plan: { ...s.plan, packs: [s.srd, s.base, bad.ref] },
        packs: [BASE, bad.files],
      });
      expect(r.ok ? "ok" : r.code).toBe("addon_forbidden_table");
    }
  });

  it("a record whose filter excludes the add-on → addon_source_filtered (never widened)", async () => {
    const s = await setup();
    const sources = ["srd-5.2.1", "test-base"];
    const r = await check(s, { record: { ...s.record, sources }, plan: { ...s.plan, sources } });
    expect(r.ok ? "ok" : r.code).toBe("addon_source_filtered");
  });

  it("contexts that aren't record + add-on: old ref changed, equal, sources mismatch", async () => {
    const s = await setup();
    const v2 = await variant(
      {
        ...BASE,
        "manifest.json": {
          ...(BASE["manifest.json"] as J),
          manifest: { ...(BASE["manifest.json"] as J).manifest, version: "2.0.0" },
        },
      },
      s,
    );
    const changed = await check(s, {
      plan: { packs: [s.srd, v2.ref, s.addon], sources: null },
      packs: [BASE, v2.files, ADDON],
    });
    expect(changed.ok ? "ok" : changed.code).toBe("bind_old_ref_changed");
    const same = await check(s, { plan: s.record });
    expect(same.ok ? "ok" : same.code).toBe("addon_not_addon");
    const widened = await check(s, {
      plan: { ...s.plan, sources: ["srd-5.2.1", "test-base", "test-addon"] },
    });
    expect(widened.ok ? "ok" : widened.code).toBe("context_sources_mismatch");
  });

  it("a selected mechanic the add-on would change → addon_sheet_changed, with paths", async () => {
    const s = await setup();
    // A record (by hand, not through setters) naming a feat only the add-on defines: its
    // evaluation differs with the add-on.
    const key = Object.keys(s.build.choices).find((k) => k.endsWith("#versatile")) as string;
    const build = clone(s.build) as J;
    build.choices[key] = ["test-new"];
    const r = await check(s, { build });
    expect(r.ok ? "ok" : r.code).toBe("addon_sheet_changed");
    if (!r.ok) expect(r.paths?.length).toBeGreaterThan(0);
  });

  it("a stored state that isn't the reconciled one → addon_sheet_changed", async () => {
    const s = await setup();
    const state = { ...(clone(s.state) as J), uses_spent: { "test:nothing": 1 } };
    const r = await check(s, { state });
    expect(r.ok ? "ok" : r.code).toBe("addon_sheet_changed");
  });

  it("checkAddonFiles reads raw files: a later pack never overrides silently", () => {
    const srdStub = { id: "srd-5.2.1", files: pack("srd-5.2.1", [], { feats: [] }) };
    expect(checkAddonFiles([srdStub, { id: "test-base", files: BASE }], ADDON)).toBeNull();
    expect(checkAddonFiles([{ id: "test-base", files: BASE }], ADDON)?.code).toBe(
      "addon_forbidden_table",
    );
    const dup = checkAddonFiles(
      [{ id: "test-base", files: BASE }],
      pack("test-addon", ["test-base"], { feats: [feat("test-hidden", "x")] }),
    );
    expect(dup?.code).toBe("addon_id_collision");
  });
});

describe("add-on check: exact pack identity (R05-02)", () => {
  it("an add-on or an old pack named under another version or id: pack_identity_mismatch, nothing registered", async () => {
    const s = await setup();
    const fake = { ...s.addon, version: "not-installed" };
    const r = await check(s, { plan: { ...s.plan, packs: [s.srd, s.base, fake] } });
    expect(r.ok ? "ok" : r.code).toBe("pack_identity_mismatch");
    const nullVersion = { ...s.base, version: null };
    const old = await check(s, {
      record: { ...s.record, packs: [s.srd, nullVersion] },
      plan: { ...s.plan, packs: [s.srd, nullVersion, s.addon] },
    });
    expect(old.ok ? "ok" : old.code).toBe("pack_identity_mismatch");
    const aliasSrd = { ...s.srd, id: "test-srd-alias" };
    const alias = await check(s, {
      record: { ...s.record, packs: [aliasSrd, s.base] },
      plan: { ...s.plan, packs: [aliasSrd, s.base, s.addon] },
    });
    expect(alias.ok).toBe(false);
    expect(await s.e.localPackFiles(fake)).toEqual({ ok: false, code: "context_unavailable" });
    // The exact refs still pass.
    expect((await check(s)).ok).toBe(true);
  });
});
