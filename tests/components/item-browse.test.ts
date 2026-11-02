// kenli F-013 T03: the dialog's presentation helpers over synthetic assessments: AND filters,
// unknown kept apart from neutral and proficient, a missing price never "within my coins".
import { describe, expect, it } from "vitest";
import type { AssessedItem } from "../../src/engine/facade";
import {
  type CatalogRow,
  type Filters,
  type MarkerMode,
  matches,
  NO_FILTERS,
  needsAssessment,
  priceLabel,
  statusOf,
  suits,
} from "../../src/features/sheet/itemBrowse";

const message = (text: string) => ({ code: "text", params: { text }, text });

function assessed(over: Partial<AssessedItem> = {}): AssessedItem {
  return {
    key: "gear:rope",
    table: "gear",
    item: "rope",
    base: null,
    variant: null,
    found: true,
    name: "Rope",
    kind: "gear",
    magic: false,
    magic_category: null,
    proficiency: { status: "not_applicable", reason: message("none"), via: null, bonus: null },
    mastery: { status: "not_applicable", property: null, name: null, reason: message("none") },
    restrictions: [],
    issues: [],
    bases: null,
    variants: [],
    requires_attunement: false,
    price_cp: 100,
    bundle: 1,
    price_text: "1 GP",
    ...over,
  };
}

const row = { table: "gear", def: { id: "rope", name: "Rope" } } as unknown as CatalogRow;
const magicRow = {
  table: "magic_items",
  def: { id: "weapon-1", name: "Weapon, +1" },
} as unknown as CatalogRow;

describe("item browsing helpers", () => {
  it("statuses: unknown, neutral, choose-base and proficient are different words", () => {
    const labels = (["yes", "no", "not_applicable", "unknown", "choose_base"] as const).map(
      (status) =>
        statusOf(
          assessed({
            kind: "weapon",
            proficiency: { status, reason: message(""), via: null, bonus: null },
          }),
        ).label,
    );
    expect(new Set(labels).size).toBe(5);
    expect(labels).toEqual([
      "Proficient",
      "Not proficient",
      "No proficiency needed",
      "Can't tell",
      "Depends on what it's made from",
    ]);
    const shield = statusOf(
      assessed({
        kind: "shield",
        proficiency: { status: "no", reason: message(""), via: null, bonus: null },
      }),
    );
    expect(shield).toMatchObject({ label: "Not trained", tone: "bad" });
  });

  it("filters combine with AND; a template suits when one base does", () => {
    const template = assessed({
      key: "magic_items:weapon-1",
      kind: "weapon",
      magic: true,
      price_cp: null,
      price_text: null,
      proficiency: { status: "choose_base", reason: message(""), via: null, bonus: null },
      bases: { allowed: [], proficient: ["dagger"], any_proficient: true },
    });
    expect(suits(template)).toBe(true);
    expect(
      matches(magicRow, template, { ...NO_FILTERS, kind: "weapon", magic: "require" }, 0),
    ).toBe(true);
    expect(matches(magicRow, template, { ...NO_FILTERS, kind: "armor" }, 0)).toBe(false);
    expect(matches(row, assessed(), { ...NO_FILTERS, magic: "require" }, 0)).toBe(false);
    expect(matches(row, assessed(), { ...NO_FILTERS, proficient: "require" }, 0)).toBe(false);
    // Without the engine's answer, a filter that needs it never passes.
    expect(matches(row, undefined, { ...NO_FILTERS, kind: "gear" }, 0)).toBe(false);
    expect(matches(row, undefined, NO_FILTERS, null)).toBe(true);
  });

  it("budget: at or under the coins passes; a missing price never does and isn't shown as 0", () => {
    const lute = assessed({ price_cp: 3500, price_text: "35 GP" });
    const budget = { ...NO_FILTERS, budget: true };
    expect(matches(row, lute, budget, 3500)).toBe(true);
    expect(matches(row, lute, budget, 3400)).toBe(false);
    const unpriced = assessed({ price_cp: null, price_text: null });
    expect(matches(row, unpriced, budget, 1_000_000)).toBe(false);
    expect(matches(row, unpriced, NO_FILTERS, 0)).toBe(true);
    expect(priceLabel(unpriced)).toBe("No listed price");
    expect(priceLabel(assessed({ bundle: 20 }))).toBe("1 GP for 20");
  });

  // kenli F-013 T06 (decision 07): Magic and Proficiency each required, excluded or ignored.
  describe("three-mode markers", () => {
    const yes = { status: "yes", reason: message(""), via: "simple", bonus: 2 } as const;
    const st = (status: "no" | "not_applicable" | "unknown" | "choose_base") =>
      ({ status, reason: message(""), via: null, bonus: null }) as const;
    const item = (
      id: string,
      name: string,
      table: CatalogRow["table"],
      over: Partial<AssessedItem>,
    ) => ({
      row: { table, def: { id, name } } as unknown as CatalogRow,
      a: assessed({
        key: `${table}:${id}`,
        table,
        item: id,
        name,
        magic: table === "magic_items",
        ...over,
      }),
    });
    // A: proficient weapon, B: unproficient weapon, C: neutral gear, D: magic shield trained,
    // E: neutral magic ring, F: magic weapon that can't be assessed, G: template with a fitting
    // base, H: template with none.
    const ITEMS = {
      A: item("dagger", "Dagger", "weapons", { kind: "weapon", proficiency: yes, price_cp: 200 }),
      B: item("longsword", "Longsword", "weapons", {
        kind: "weapon",
        proficiency: st("no"),
        price_cp: 1500,
      }),
      C: item("rope", "Rope", "gear", {
        kind: "gear",
        proficiency: st("not_applicable"),
        price_cp: 100,
      }),
      D: item("shield-1", "Shield, +1", "magic_items", {
        kind: "shield",
        proficiency: yes,
        price_cp: null,
      }),
      E: item("ring", "Ring of Swimming", "magic_items", {
        kind: "gear",
        proficiency: st("not_applicable"),
        price_cp: null,
      }),
      F: item("odd", "Odd Sword", "magic_items", {
        kind: "weapon",
        proficiency: st("unknown"),
        price_cp: null,
      }),
      G: item("weapon-1", "Weapon, +1", "magic_items", {
        kind: "weapon",
        proficiency: st("choose_base"),
        bases: { allowed: [], proficient: ["dagger"], any_proficient: true },
        price_cp: null,
      }),
      H: item("oathbow", "Oathbow", "magic_items", {
        kind: "weapon",
        proficiency: st("choose_base"),
        bases: { allowed: [], proficient: [], any_proficient: false },
        price_cp: null,
      }),
    };
    const pass = (f: Partial<Filters>, purse: number | null = 0) =>
      Object.entries(ITEMS)
        .filter(([, x]) => matches(x.row, x.a, { ...NO_FILTERS, ...f }, purse))
        .map(([k]) => k)
        .join("");
    // Written out by hand: magic = D–H; the proficiency marker = A, D, G.
    const EXPECTED: Record<MarkerMode, Record<MarkerMode, string>> = {
      ignore: { ignore: "ABCDEFGH", require: "ADG", exclude: "BCEFH" },
      require: { ignore: "DEFGH", require: "DG", exclude: "EFH" },
      exclude: { ignore: "ABC", require: "A", exclude: "BC" },
    };

    it("all nine combinations; the default ignores both", () => {
      expect(NO_FILTERS).toMatchObject({ magic: "ignore", proficient: "ignore" });
      for (const magic of ["ignore", "require", "exclude"] as const)
        for (const proficient of ["ignore", "require", "exclude"] as const)
          expect({ magic, proficient, pass: pass({ magic, proficient }) }).toEqual({
            magic,
            proficient,
            pass: EXPECTED[magic][proficient],
          });
    });

    it("AND with kind, name and budget", () => {
      expect(pass({ magic: "require", proficient: "exclude", kind: "weapon" })).toBe("FH");
      expect(pass({ magic: "exclude", kind: "weapon", budget: true }, 1000)).toBe("A");
      expect(pass({ magic: "exclude", kind: "weapon", budget: true }, 1500)).toBe("AB");
      expect(pass({ proficient: "exclude", query: "sword" })).toBe("BF");
      expect(pass({ magic: "exclude", proficient: "exclude", budget: true }, 1000)).toBe("C");
    });

    it("excluding proficiency keeps neutral and unknown items with their own labels", () => {
      expect(statusOf(ITEMS.C.a).label).toBe("No proficiency needed");
      expect(statusOf(ITEMS.F.a).label).toBe("Can't tell");
      expect(statusOf(ITEMS.B.a).label).toBe("Not proficient");
    });

    it("no answer is no proof: both proficiency modes need it; Magic alone doesn't", () => {
      for (const proficient of ["require", "exclude"] as const) {
        expect(needsAssessment({ ...NO_FILTERS, proficient })).toBe(true);
        expect(matches(ITEMS.C.row, undefined, { ...NO_FILTERS, proficient }, 0)).toBe(false);
      }
      for (const magic of ["require", "exclude"] as const)
        expect(needsAssessment({ ...NO_FILTERS, magic })).toBe(false);
      expect(matches(ITEMS.E.row, undefined, { ...NO_FILTERS, magic: "require" }, null)).toBe(true);
      expect(matches(ITEMS.C.row, undefined, { ...NO_FILTERS, magic: "exclude" }, null)).toBe(true);
    });
  });
});
