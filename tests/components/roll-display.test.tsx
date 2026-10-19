import { cleanup, render, screen, within } from "@testing-library/react";
import type { CharacterBuild, CharacterState, D20TestResult } from "srd-rules-engine";
import { beforeEach, describe, expect, it } from "vitest";
import { DiceTray } from "../../src/components/DiceTray";
import type { ContentContext } from "../../src/lib/canonical";
import { useUi } from "../../src/store/ui";
import { rogue } from "../fixtures/characters";
import { bard, testContext } from "../fixtures/player-actions";
import { engineWithDice } from "../helpers/transfer";

// The dice tray on real engine results (scripted dice): a die the engine changed reads raw → what it
// counts as (the engine's label), then the bonus and the total; unchanged dice as rolled; the die not
// kept struck through. kenli F-005 roll display (execution/roll-display/contract.md).

const { engine, dice } = engineWithDice();
let build: CharacterBuild;
let state: CharacterState;
let content: ContentContext;

beforeEach(async () => {
  cleanup();
  useUi.setState({ dice: [] });
  dice.length = 0;
  if (!build) {
    content = await testContext(engine);
    build = await bard(engine);
    state = await engine.createState(build, content);
  }
});

async function test(
  request: Parameters<typeof engine.rollCheck>[2],
  rolls: number[],
  mode?: "advantage" | "disadvantage",
) {
  dice.push(...rolls);
  return engine.rollCheck(build, state, request, content, {
    ...(mode ? { mode_override: { mode, reason: "GM" } } : {}),
  });
}
function show(t: D20TestResult) {
  cleanup();
  useUi.setState({ dice: [] });
  useUi.getState().showDice([{ kind: "test", who: "Syn Bard", test: t }]);
  render(<DiceTray />);
  const card = screen.getByRole("region", { name: /dice|Dice/ });
  const faces = within(card).getAllByTestId("die");
  return { card, faces, text: card.textContent ?? "" };
}
const visible = (el: HTMLElement) =>
  Array.from(el.childNodes)
    .filter((n) => !(n instanceof HTMLElement && n.classList.contains("sr-only")))
    .map((n) => n.textContent)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

describe("raw → effective dice in the tray", () => {
  it("a die below the pack's floor: `1 → 10 (Test Tongue)`, the bonus, the total", async () => {
    const r = await test({ skill: "persuasion" }, [1]);
    expect(r.floors).toEqual([{ label: "Test Tongue", from: 1, to: 10 }]);
    const { faces, text } = show(r);
    expect(faces).toHaveLength(1);
    expect(visible(faces[0] as HTMLElement)).toBe("1 → 10 (Test Tongue)");
    expect(text).toContain(`+${r.bonus}`);
    expect(text).toContain(`= ${10 + r.bonus}`);
    expect(r.total).toBe(10 + r.bonus);
    expect(text).toContain("rolled 1, counts as 10"); // for screen readers
  });

  it("an unchanged die (above the floor, or no floor) reads as rolled; zero (Int save) and negative (Str save) bonuses as the engine has them", async () => {
    const high = await test({ skill: "persuasion" }, [15]);
    expect(visible(show(high).faces[0] as HTMLElement)).toBe("15");
    // An Intelligence save: no proficiency, no Jack of All Trades (checks only), Int 10.
    const zero = await test({ save: "int" }, [1]);
    expect(zero.bonus).toBe(0);
    const z = show(zero);
    expect(visible(z.faces[0] as HTMLElement)).toBe("1");
    expect(z.text).not.toMatch(/[+−]0/);
    expect(z.text).toContain("= 1");
    // A Strength save: Str 8, no proficiency.
    const negative = await test({ save: "str" }, [1]);
    expect(negative.bonus).toBeLessThan(0);
    const n = show(negative);
    expect(visible(n.faces[0] as HTMLElement)).toBe("1");
    expect(n.text).toContain(`−${-negative.bonus}`);
    expect(n.text).toContain(`= ${1 + negative.bonus}`);
  });

  it("Advantage: both dice raised, the engine's kept die plain, the other struck through", async () => {
    const r = await test({ skill: "persuasion" }, [3, 1], "advantage");
    const { faces } = show(r);
    expect(faces.map((f) => visible(f))).toEqual(["3 → 10 (Test Tongue)", "1 → 10 (Test Tongue)"]);
    const struck = faces.map((f) => f.className.includes("line-through"));
    expect(struck.filter(Boolean)).toHaveLength(1);
    expect(struck[r.roll.kept]).toBe(false);
  });

  it("Disadvantage: the kept low die raised, the high one unchanged and struck through", async () => {
    const r = await test({ skill: "persuasion" }, [4, 15], "disadvantage");
    const { faces, text } = show(r);
    expect(r.roll.kept).toBe(0);
    expect(faces.map((f) => visible(f))).toEqual(["4 → 10 (Test Tongue)", "15"]);
    expect(faces[1]?.className).toContain("line-through");
    expect(text).toContain(`= ${10 + r.bonus}`);
  });

  it("Heroic Inspiration's reroll makes the floor active: 15 rerolled to 2 reads `2 → 10 (Test Tongue)`", async () => {
    const first = await test({ skill: "persuasion" }, [15]);
    expect(first.floors).toEqual([]);
    const inspired = await engine.applyPlayAction(
      build,
      state,
      { type: "set_inspiration", value: true },
      content,
    );
    if (!inspired.ok) throw new Error("no inspiration");
    dice.push(2);
    const again = await engine.heroicReroll(
      build,
      inspired.state,
      { kind: "d20", roll: first, die: 0 },
      content,
    );
    if (!again.ok) throw new Error(again.reasons.join("; "));
    const rerolled = again.roll as D20TestResult;
    expect(rerolled.floors).toEqual([{ label: "Test Tongue", from: 2, to: 10 }]);
    expect(visible(show(rerolled).faces[0] as HTMLElement)).toBe("2 → 10 (Test Tongue)");
  });

  it("the GM's modifiers and bonus dice stay listed with a raised die", async () => {
    dice.push(1, 3);
    const r = await engine.rollCheck(build, state, { skill: "persuasion" }, content, {
      modifiers: [{ value: -2, label: "GM" }],
      bonus_dice: [{ dice: "1d4", label: "Bless" }],
    });
    const { faces, text } = show(r);
    expect(visible(faces[0] as HTMLElement)).toBe("1 → 10 (Test Tongue)");
    expect(text).toContain("GM");
    expect(text).toContain("Bless");
    expect(text).toContain(`= ${r.total}`);
  });

  it("Reliable Talent (the SRD's own floor) reads with its name", async () => {
    const pip = await rogue(engine, 7);
    const pipState = await engine.createState(pip);
    const sheet = (await engine.playSheet(pip, pipState)).sheet;
    const skill = sheet.skills.find((s) => s.proficient_from !== null)?.skill;
    if (!skill) throw new Error("no proficient skill");
    dice.push(3);
    const r = await engine.rollCheck(pip, pipState, { skill });
    expect(r.floors).toEqual([{ label: "Reliable Talent", from: 3, to: 10 }]);
    expect(visible(show(r).faces[0] as HTMLElement)).toBe("3 → 10 (Reliable Talent)");
  });
});
