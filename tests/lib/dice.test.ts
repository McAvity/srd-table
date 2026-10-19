import type { AppliedFloor, D20Roll } from "srd-rules-engine";
import { describe, expect, it } from "vitest";
import { d20Faces } from "../../src/lib/dice";

// A d20 roll's dice as the tray shows them: raw → what it counts as, with the engine's label; the
// kept die from the engine's `kept` (not by value). Nothing here knows a rule.

const roll = (rolls: number[], kept: number, d20: number): D20Roll => ({
  rolls,
  kept,
  d20,
  natural: rolls[kept] ?? 0,
  mode: rolls.length > 1 ? "advantage" : "normal",
});
const floor = (label: string, from: number, to: number): AppliedFloor => ({ label, from, to });

describe("d20Faces", () => {
  it("an unchanged die reads as rolled", () => {
    expect(d20Faces(roll([12], 0, 12), [])).toEqual([
      { raw: 12, effective: 12, label: null, kept: true },
    ]);
  });

  it("a die the engine raised: raw → effective with its label (any label: a pack's, Reliable Talent)", () => {
    expect(d20Faces(roll([1], 0, 10), [floor("Silver Tongue", 1, 10)])).toEqual([
      { raw: 1, effective: 10, label: "Silver Tongue", kept: true },
    ]);
    expect(d20Faces(roll([3], 0, 10), [floor("Reliable Talent", 3, 10)])[0]?.label).toBe(
      "Reliable Talent",
    );
    expect(d20Faces(roll([2], 0, 12), [floor("Synthetic Floor", 2, 12)])[0]).toMatchObject({
      raw: 2,
      effective: 12,
      label: "Synthetic Floor",
    });
  });

  it("two dice: each raised die mapped in the order rolled; the kept one is the engine's index", () => {
    // Advantage, both below the floor: both raised, the first kept (the engine's pick).
    expect(
      d20Faces(roll([3, 1], 0, 10), [floor("Silver Tongue", 3, 10), floor("Silver Tongue", 1, 10)]),
    ).toEqual([
      { raw: 3, effective: 10, label: "Silver Tongue", kept: true },
      { raw: 1, effective: 10, label: "Silver Tongue", kept: false },
    ]);
    // One raised, discarded; the kept one unchanged.
    expect(d20Faces(roll([15, 4], 0, 15), [floor("Silver Tongue", 4, 10)])).toEqual([
      { raw: 15, effective: 15, label: null, kept: true },
      { raw: 4, effective: 10, label: "Silver Tongue", kept: false },
    ]);
    // The same value twice: each die takes its own entry.
    expect(
      d20Faces(roll([4, 4], 1, 10), [
        floor("Silver Tongue", 4, 10),
        floor("Silver Tongue", 4, 10),
      ]).map((f) => [f.effective, f.kept]),
    ).toEqual([
      [10, false],
      [10, true],
    ]);
  });

  it("two equal dice without a floor: only the engine's kept index is kept (not every die of that value)", () => {
    expect(d20Faces(roll([12, 12], 1, 12), []).map((f) => f.kept)).toEqual([false, true]);
  });

  it("a result without the engine's list (an encounter check): the kept die's natural → d20, no label", () => {
    expect(d20Faces(roll([2, 17], 0, 10))).toEqual([
      { raw: 2, effective: 10, label: null, kept: true },
      { raw: 17, effective: 17, label: null, kept: false },
    ]);
    expect(d20Faces(roll([9], 0, 9))).toEqual([{ raw: 9, effective: 9, label: null, kept: true }]);
  });
});
