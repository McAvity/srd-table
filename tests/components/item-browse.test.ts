// kenli F-013 T03: the dialog's presentation helpers over synthetic assessments: AND filters,
// unknown kept apart from neutral and proficient, a missing price never "within my coins".
import { describe, expect, it } from "vitest";
import type { AssessedItem } from "../../src/engine/facade";
import {
  type CatalogRow,
  matches,
  NO_FILTERS,
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
    expect(matches(magicRow, template, { ...NO_FILTERS, kind: "weapon", magic: true }, 0)).toBe(
      true,
    );
    expect(matches(magicRow, template, { ...NO_FILTERS, kind: "armor" }, 0)).toBe(false);
    expect(matches(row, assessed(), { ...NO_FILTERS, magic: true }, 0)).toBe(false);
    expect(matches(row, assessed(), { ...NO_FILTERS, proficient: true }, 0)).toBe(false);
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
});
