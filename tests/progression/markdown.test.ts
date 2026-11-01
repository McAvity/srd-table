/**
 * kenli F-002 T06: the plan's Markdown — escaped (no raw HTML, no injected Markdown), UTF-8 with
 * Polish letters, the whole plan whatever level a character is at, partial plans said so,
 * replacements as old → new, reasons kept, choices apart from automatic grants. SRD/invented plans.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { nodeFacade } from "@/engine/node";
import { contentSha } from "@/lib/canonical";
import { escapeMarkdown, markdownFileName, planMarkdown } from "@/progression/markdown";
import { FIXTURE_DIR } from "./generate-fixtures";
import { clone, type J } from "./plans";

const read = (name: string): J => JSON.parse(readFileSync(join(FIXTURE_DIR, name), "utf8"));
async function md(file: J) {
  const r = await nodeFacade({ seed: 1 }).compilePlan(file);
  if (!r.ok) throw new Error(r.problem.detail);
  return { text: planMarkdown(file, r.checkpoints), compiled: r };
}
const section = (text: string, level: number) => {
  const start = text.indexOf(`## Level ${level} `);
  const end = text.indexOf("\n## ", start + 4);
  return text.slice(start, end < 0 ? undefined : end);
};

describe("Markdown escaping", () => {
  it("escapes Markdown and HTML characters, keeps Polish letters, folds line breaks", () => {
    expect(escapeMarkdown("a*b_c`d[e]f<g>h#i|j\\k")).toBe(
      "a\\*b\\_c\\`d\\[e\\]f\\<g\\>h\\#i\\|j\\\\k",
    );
    expect(escapeMarkdown("<script>alert(1)</script>")).toBe("\\<script\\>alert(1)\\</script\\>");
    expect(escapeMarkdown("- not a list")).toBe("\\- not a list");
    expect(escapeMarkdown("1. not a list")).toBe("1\\. not a list");
    expect(escapeMarkdown("zażółć\ngęślą")).toBe("zażółć gęślą");
  });
});

describe("the plan's Markdown", () => {
  it("a whole plan 1–20: every level, its class, HP method and choices; Polish title and the reason escaped", async () => {
    const file = read("fighter-1-20.plan.json");
    const { text, compiled } = await md(file);
    expect(text.startsWith("# Wojownik 1–20 — „próba” \\*pełna\\*\n")).toBe(true);
    for (let l = 2; l <= 20; l++)
      expect(text).toContain(`## Level ${l} — Fighter ${l} (Fighter ${l})`);
    expect(text).toContain("The plan covers levels 1–20.");
    expect(text).not.toContain("later levels are not planned");
    expect(text).toContain(
      "Why: Champion: prosty \\<b\\>wybór\\</b\\> \\# bez \\| ryzyka \\*naprawdę\\*",
    );
    expect(text).not.toMatch(/<b>|<\/b>/);
    // Every choice of every checkpoint is in its level's section, by name.
    for (const cp of compiled.checkpoints)
      for (const op of cp.ops.filter((o) => o.op === "choice"))
        for (const name of op.names ?? [])
          expect(section(text, cp.level), `L${cp.level} ${name}`).toContain(escapeMarkdown(name));
    // A level without choices says so; the starting assumptions are there.
    expect(section(text, 2)).toContain("No choices at this level.");
    for (const line of [
      "- Class: Fighter",
      "- Species: Human",
      "- Background: Soldier",
      "- Ability scores: standard array",
      "- Base scores: STR 15, DEX 14, CON 13, INT 8, WIS 10, CHA 12",
      "- Background bonuses: STR 2, CON 1",
      "- Hit Points: fixed value at every level",
      "- Equipment: the class and background starting equipment",
    ])
      expect(text).toContain(line);
    expect(markdownFileName(file)).toBe("test-fighter-20.md");
    expect(new TextDecoder("utf-8", { fatal: true }).decode(new TextEncoder().encode(text))).toBe(
      text,
    );
  });

  it("a partial plan says where it ends", async () => {
    const { text } = await md(read("fighter-partial-1-3.plan.json"));
    expect(text).toContain("> The plan ends at level 3; later levels are not planned.");
    expect(text).not.toContain("## Level 4");
  });

  it("a replacement is old → new; traits are automatic, chosen spells are changes", async () => {
    const { text } = await md(read("sorcerer-bard-replace-1-3.plan.json"));
    const l3 = section(text, 3);
    expect(l3).toContain(
      "**Replace one: Bard prepared spells** (from Bard): Command replaced by Dissonant Whispers",
    );
    const auto = l3.slice(l3.indexOf("### Gained automatically"), l3.indexOf("### Changes"));
    expect(auto).toContain("Features: Expertise, Jack of All Trades");
    expect(auto).not.toContain("Dissonant Whispers");
    expect(l3.slice(l3.indexOf("### Changes"))).toContain("Spells: Dissonant Whispers");
  });

  it("kenli F-002 T12 (D030): a fixed background tool at level 1, under Gained automatically and on the sheet", async () => {
    const { text, compiled } = await md(read("wizard-1-5.plan.json"));
    const tools = compiled.checkpoints[0]?.stats.tools ?? [];
    expect(tools.length).toBeGreaterThan(0);
    const l1 = section(text, 1);
    const auto = l1.slice(l1.indexOf("### Gained automatically"), l1.indexOf("### On the sheet"));
    expect(auto).toContain(`Tool proficiencies: ${tools.join(", ")}`);
    expect(l1.slice(l1.indexOf("### On the sheet"))).toContain("Tool proficiencies:");
  });

  it("kenli F-002 T12 (D031): a whole list given again says what it drops and adds, at that level only", async () => {
    const file = read("wizard-1-5.plan.json");
    const r = await nodeFacade({ seed: 1 }).compilePlan(file);
    if (!r.ok) throw new Error(r.problem.detail);
    const pool = (values: string[], names: string[]) => ({
      op: "choice" as const,
      key: "class:test#pool",
      label: "Test pool",
      values,
      names,
      rule: "S-pool",
      origin: "author",
    });
    const cps = r.checkpoints.map((cp) =>
      cp.level === 2
        ? { ...cp, ops: [...cp.ops, pool(["a", "b"], ["Alpha", "Beta"])] }
        : cp.level === 3
          ? { ...cp, ops: [...cp.ops, pool(["a", "c"], ["Alpha", "Gamma"])] }
          : cp.level === 4
            ? { ...cp, ops: [...cp.ops, pool(["a", "c"], ["Alpha", "Gamma"])] }
            : cp,
    );
    const text = planMarkdown(file, cps as never);
    expect(section(text, 2)).not.toContain("Replaced against the previous level");
    expect(section(text, 3)).toContain("Replaced against the previous level: Beta out, Gamma in");
    expect(section(text, 4)).not.toContain("Replaced against the previous level");
  });

  it("depends on the plan only: the same text twice; another plan revision changes it", async () => {
    const file = read("wizard-1-5.plan.json");
    const a = await md(file);
    const b = await md(clone(file));
    expect(a.text).toBe(b.text);
    const other = clone(file);
    other.plan.revision = 2;
    other.plan_sha256 = await contentSha(other.plan);
    expect((await md(other)).text).not.toBe(a.text);
  });
});
