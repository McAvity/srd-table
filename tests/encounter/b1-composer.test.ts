import type { OptionEntry, PlaySheet } from "srd-rules-engine";
import { describe, expect, it } from "vitest";
import { needsComposer } from "../../src/features/encounter/ActionComposer";

// kenli F-002 T12 B1: a feature paid with a spell slot (Wild Resurgence) or taking a Wild Shape
// form opens the composer (the engine refuses it without its payment or form); others don't.
const entry = (feature: string) =>
  ({
    action: { type: "feature", id: "me", feature },
    targets: null,
    slot_levels: [],
    pact_slot: null,
  }) as unknown as OptionEntry;
const sheet = {
  actions: [
    { key: "druid:wild-resurgence", slot_payment: "required" },
    {
      key: "druid:wild-shape-form",
      shape: { choice: "wild_shape_forms", class_id: "druid", forms: [] },
    },
    { key: "druid:other" },
  ],
} as unknown as PlaySheet;

describe("needsComposer for features (kenli F-002 T12 B1)", () => {
  it("a slot payment or a form: composed; a plain feature: sent directly", () => {
    expect(needsComposer(entry("druid:wild-resurgence"), sheet)).toBe(true);
    expect(needsComposer(entry("druid:wild-shape-form"), sheet)).toBe(true);
    expect(needsComposer(entry("druid:other"), sheet)).toBe(false);
    expect(needsComposer(entry("druid:wild-resurgence"))).toBe(false);
  });
});
