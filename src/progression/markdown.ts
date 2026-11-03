/**
 * kenli F-002 T06: the whole progression plan as Markdown (dnd5 contracts/progression.md §11), for
 * the player and the DM. Pure: one canonical plan and its compiled checkpoints in (names, labels
 * and sources resolved by the worker in the plan's own context), one UTF-8 text out — independent
 * of the level a character is played at, of its state and of its journal. Every text from the plan
 * or the catalog is escaped (no raw HTML, no Markdown injection). Nothing here writes.
 */

import type { GuideQuote, PlanCheckpoint, ReadableOp, StatChange } from "@/engine/plans";
import { type MessageKey, type Params, t as translate } from "@/i18n";
import type { GuideNote, PlanFile, PlanGuide } from "./codec";

/** Markdown-significant characters (§11), backslash-escaped; line breaks folded to spaces. */
export function escapeMarkdown(text: string): string {
  return text
    .replace(/\r\n?|\n/g, " ")
    .replace(/[\\`*_[\]<>#|~!]/g, (c) => `\\${c}`)
    .replace(/^(\s*)([-+])(\s)/, "$1\\$2$3")
    .replace(/^(\s*)(\d+)\.(\s)/, "$1$2\\.$3");
}
const e = escapeMarkdown;
/** Keys built from data (an origin, a stat): all listed in the catalogs. */
const t = (key: string, params?: Params) => translate(key as MessageKey, params);

const ABILITY_ORDER = ["str", "dex", "con", "int", "wis", "cha"] as const;
const scoresLine = (raw: string | undefined) => {
  let v: Record<string, number> = {};
  try {
    v = JSON.parse(raw ?? "{}");
  } catch {
    v = {};
  }
  return ABILITY_ORDER.filter((a) => a in v)
    .map((a) => `${a.toUpperCase()} ${v[a]}`)
    .join(", ");
};

function originText(op: ReadableOp): string {
  const o =
    op.origin === "source" || op.origin === "adaptation" || op.origin === "author"
      ? op.origin
      : "author";
  return t(`markdown.origin.${o}`);
}

function choiceLine(op: ReadableOp): string {
  const label = e(op.label ?? op.key ?? "");
  const from = op.source ? ` ${t("markdown.from", { source: e(op.source) })}` : "";
  const names = op.names ?? op.values ?? [];
  const isReplace = op.key?.includes("#replace:") && names.length === 2;
  const value = isReplace
    ? t("markdown.replaced", { old: e(names[0] ?? ""), new: e(names[1] ?? "") })
    : names.map(e).join(", ");
  const pool = op.rule === "S-pool" ? ` ${t("markdown.poolNote")}` : "";
  const why = op.why ? `\n  - ${t("markdown.why", { why: e(op.why) })}` : "";
  return `- **${label}**${from}: ${value}${pool} — ${originText(op)}${why}`;
}

function changeLines(changes: readonly StatChange[]): { stats: string[]; automatic: string[] } {
  const stats: string[] = [];
  const automatic: string[] = [];
  for (const c of changes) {
    if (
      c.field === "traits" ||
      c.field === "features" ||
      c.field === "spells" ||
      c.field === "feats" ||
      c.field === "skills" ||
      c.field === "expertise" ||
      c.field === "languages" ||
      c.field === "tools"
    ) {
      // Traits come with the level itself (automatic grants); feats, feature options and spells on
      // the sheet follow the level's choices, so they are listed with the changes.
      const into = c.field === "traits" ? automatic : stats;
      const added = (c.after as string[]) ?? [];
      const removed = (c.before as string[]) ?? [];
      if (added.length)
        into.push(`- ${t(`markdown.gained.${c.field}`)}: ${added.map(e).join(", ")}`);
      if (removed.length)
        into.push(`- ${t(`markdown.lost.${c.field}`)}: ${removed.map(e).join(", ")}`);
      continue;
    }
    if (c.field === "level") continue;
    const show = (v: unknown) => (Array.isArray(v) ? `[${v.join(", ")}]` : String(v ?? "—"));
    stats.push(
      `- ${e(t(`markdown.stat.${c.field.startsWith("scores.") ? "score" : c.field}`, { ability: c.field.slice(7).toUpperCase() }))}: ${show(c.before)} → ${show(c.after)}`,
    );
  }
  return { stats, automatic };
}

/** Class names by id, from the plan's own ops (the start's class, each level-up's class). */
function classNames(checkpoints: readonly PlanCheckpoint[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const cp of checkpoints)
    for (const o of cp.ops) {
      if (o.op === "class" && o.value) names.set(o.value, o.value_name ?? o.value);
      if (o.op === "level_up" && o.class_id) names.set(o.class_id, o.class_name ?? o.class_id);
    }
  return names;
}
const classesLine = (cp: PlanCheckpoint, names: Map<string, string>) =>
  cp.stats.classes.map((c) => `${e(names.get(c.class_id) ?? c.class_id)} ${c.level}`).join(" / ");

const noteOrigin = (n: { readonly origin: string }) =>
  t(`markdown.origin.${n.origin === "source" || n.origin === "adaptation" ? n.origin : "author"}`);
const noteLine = (n: GuideNote) => `${e(n.text)} — ${noteOrigin(n)}`;

/**
 * kenli F-002 T13 (`/2`): the guide's equipment — each kit with the catalog's price per bundle
 * (`quotes`, from the plan's own catalog; a price in a text is never used), what is worn, why;
 * the later purchases by priority and the alternatives (recommendations: not owned, not free).
 */
function guideEquipment(guide: PlanGuide, quotes: ReadonlyMap<string, GuideQuote>): string[] {
  const out: string[] = [
    `## ${t("markdown.guide.equipment")}`,
    "",
    t("markdown.guide.kitNote"),
    "",
  ];
  const name = (id: string) => e(quotes.get(id)?.name ?? id);
  for (const k of guide.kits) {
    out.push(`### ${t("markdown.guide.kit", { level: k.from_level, title: e(k.title) })}`, "");
    if (k.why) out.push(`${e(k.why)} — ${noteOrigin(k)}`, "");
    for (const it of k.items) {
      const q = quotes.get(it.item);
      const price = q?.price_text
        ? q.bundle > 1
          ? t("markdown.guide.priceBundle", { price: e(q.price_text), bundle: q.bundle })
          : t("markdown.guide.price", { price: e(q.price_text) })
        : t("markdown.guide.unpriced");
      const worn = it.equip ? ` — ${t("markdown.guide.worn")}` : "";
      const why = it.why ? `\n  - ${e(it.why)}` : "";
      out.push(`- **${name(it.item)}** × ${it.units} — ${price}${worn} — ${noteOrigin(it)}${why}`);
    }
    out.push("");
  }
  if (guide.purchases.length) {
    out.push(`### ${t("markdown.guide.purchases")}`, "", t("markdown.guide.purchasesNote"), "");
    for (const p of [...guide.purchases].sort((a, b) => a.priority - b.priority)) {
      const price = quotes.get(p.item)?.price_text;
      out.push(
        `${p.priority}. **${name(p.item)}**${price ? ` (${e(price)})` : ` (${t("markdown.guide.unpriced")})`} — ${noteLine(p)}`,
      );
    }
    out.push("");
  }
  if (guide.alternatives.length) {
    out.push(`### ${t("markdown.guide.alternatives")}`, "");
    for (const a of guide.alternatives)
      out.push(
        `- ${t("markdown.guide.instead", { item: name(a.item), of: name(a.instead_of) })}: ${noteLine(a)}`,
      );
    out.push("");
  }
  out.push(`## ${t("markdown.guide.play")}`, "", noteLine(guide.play.base), "");
  if (guide.controls.length) {
    out.push(`### ${t("markdown.guide.controls")}`, "");
    for (const c of guide.controls) out.push(`- ${noteLine(c)}`);
    out.push("");
  }
  return out;
}

/**
 * The plan as Markdown. `checkpoints` are `compilePlan`'s for this very plan (levels 1…N). The
 * text is the same whatever level a character following the plan is at. kenli F-002 T13: a
 * guided plan (`/2`) adds its equipment and play guide (`quotes`: `compilePlan`'s `guide_items`)
 * and, at each level, its note — or that the last one still holds.
 */
export function planMarkdown(
  file: Omit<PlanFile, "packs">,
  checkpoints: readonly PlanCheckpoint[],
  quotes: readonly GuideQuote[] = [],
): string {
  const guide = file.plan.guide;
  const priced = new Map(quotes.map((q) => [q.item, q]));
  const plan = file.plan;
  const N = 1 + plan.levels.length;
  const out: string[] = [];
  out.push(`# ${e(plan.title)}`, "");
  out.push(
    t("markdown.header", { id: e(plan.id), revision: plan.revision, from: 1, to: N }),
    `${t("markdown.hash")}: \`${file.plan_sha256}\``,
    "",
  );
  if (N < 20) out.push(`> ${t("markdown.partial", { level: N })}`, "");
  out.push(`## ${t("markdown.authorship")}`, "");
  out.push(`- ${t("markdown.origin.source")}: ${e(plan.authorship.source)}`);
  out.push(`- ${t("markdown.origin.adaptation")}: ${e(plan.authorship.adaptation)}`);
  out.push(`- ${t("markdown.origin.author")}: ${e(plan.authorship.author)}`, "");
  out.push(`## ${t("markdown.content")}`, "");
  for (const p of plan.packs)
    out.push(`- ${e(p.id)} ${e(p.version ?? "")} (\`${p.sha256.slice(0, 12)}\`)`);
  out.push(
    `- ${t("markdown.sources")}: ${plan.sources === null ? t("markdown.sourcesAll") : plan.sources.map(e).join(", ")}`,
    "",
  );
  // Starting assumptions: level 1.
  const start = checkpoints[0];
  out.push(`## ${t("markdown.start")}`, "");
  const startOps = start?.ops ?? [];
  const one = (op: string) => startOps.find((o) => o.op === op);
  for (const [op, key] of [
    ["class", "markdown.class"],
    ["species", "markdown.species"],
    ["background", "markdown.background"],
  ] as const) {
    const o = one(op);
    if (o) out.push(`- ${t(key)}: ${e(o.value_name ?? o.value ?? "")} — ${originText(o)}`);
  }
  const method = one("ability_method");
  if (method)
    out.push(
      `- ${t("markdown.abilityMethod")}: ${e(t(`markdown.method.${method.value ?? "standard_array"}`))}`,
    );
  const scores = one("base_scores");
  if (scores) out.push(`- ${t("markdown.baseScores")}: ${scoresLine(scores.value)}`);
  const bonus = one("background_bonus");
  if (bonus) out.push(`- ${t("markdown.bonus")}: ${scoresLine(bonus.value)}`);
  const name = one("name");
  if (name) out.push(`- ${t("markdown.name")}: ${e(name.value ?? "")}`);
  const alignment = one("alignment");
  if (alignment) out.push(`- ${t("markdown.alignment")}: ${e(alignment.value ?? "")}`);
  const rolled = plan.levels.some((l) => l.ops[0]?.op === "level_up" && l.ops[0].hp !== null);
  out.push(
    `- ${t("markdown.hpMethod")}: ${rolled ? t("markdown.hpMixed") : t("markdown.hpFixed")}`,
  );
  out.push(
    `- ${t("markdown.equipment")}: ${t(plan.start.equipment === "starting" ? "markdown.equipmentStarting" : "markdown.equipmentNone")}`,
  );
  if (start)
    out.push(`- ${t("markdown.hpAt", { level: 1, hp: String(start.stats.max_hp ?? "—") })}`);
  out.push("");
  if (guide) out.push(...guideEquipment(guide, priced));
  const names = classNames(checkpoints);
  let lastNote: number | null = null;
  const lastList = new Map<string, { values: readonly string[]; names: readonly string[] }>();
  for (const cp of checkpoints) {
    const head =
      cp.level === 1
        ? t("markdown.levelOne", { classes: classesLine(cp, names) })
        : t("markdown.level", {
            level: cp.level,
            class: e(cp.ops[0]?.class_name ?? cp.class_id),
            classLevel: cp.class_level,
            classes: classesLine(cp, names),
          });
    out.push(`## ${head}`, "");
    if (cp.level > 1) {
      const up = cp.ops[0];
      out.push(
        `- ${t("markdown.hp")}: ${up?.hp === null || up?.hp === undefined ? t("markdown.hpFixedShort") : t("markdown.hpRolled", { hp: up.hp })}; ${t("markdown.hpMax", { hp: String(cp.stats.max_hp ?? "—") })}`,
      );
      if (up?.why) out.push(`  - ${t("markdown.why", { why: e(up.why) })}`);
    }
    const choices = cp.ops.filter((o) => o.op === "choice");
    if (cp.level > 1) out.push("");
    out.push(`### ${t("markdown.choices")}`, "");
    if (choices.length)
      for (const c of choices) {
        out.push(choiceLine(c));
        // kenli F-002 T12 (D031): a whole list given again (prepared spells, known forms): what it
        // drops and adds against the same choice's previous list, at the level it happens.
        const key = c.key ?? "";
        const before = key ? lastList.get(key) : undefined;
        const now = { values: c.values ?? [], names: c.names ?? c.values ?? [] };
        if (key) lastList.set(key, now);
        if (before && c.rule === "S-pool") {
          const name = (l: { values: readonly string[]; names: readonly string[] }, v: string) =>
            l.names[l.values.indexOf(v)] ?? v;
          const out1 = before.values
            .filter((v) => !now.values.includes(v))
            .map((v) => e(name(before, v)));
          const in1 = now.values
            .filter((v) => !before.values.includes(v))
            .map((v) => e(name(now, v)));
          if (out1.length)
            out.push(
              `  - ${t("markdown.listChange", { removed: out1.join(", "), added: in1.join(", ") || "—" })}`,
            );
        }
      }
    else out.push(`- ${t("markdown.noChoices")}`);
    const { stats, automatic } = changeLines(cp.changes);
    if (cp.level === 1) {
      // What level 1 gives without a pick (the class's and background's fixed skills, Common…):
      // what is on the sheet and not named by any of the level's choices.
      const picked = new Set(choices.flatMap((c) => c.names ?? c.values ?? []));
      const fixed = (list: readonly string[]) => list.filter((x) => !picked.has(x));
      const line = (key: string, list: readonly string[]) =>
        list.length ? [`- ${t(key)}: ${list.map(e).join(", ")}`] : [];
      out.push("", `### ${t("markdown.automatic")}`, "");
      out.push(`- ${t("markdown.gained.traits")}: ${cp.stats.traits.map(e).join(", ") || "—"}`);
      out.push(...line("markdown.gained.skills", fixed(cp.stats.skills)));
      out.push(...line("markdown.gained.expertise", fixed(cp.stats.expertise)));
      out.push(...line("markdown.gained.languages", fixed(cp.stats.languages)));
      out.push(...line("markdown.gained.tools", fixed(cp.stats.tools ?? [])));
      out.push("", `### ${t("markdown.sheetAtStart")}`, "");
      out.push(...line("markdown.gained.feats", cp.stats.feats));
      out.push(...line("markdown.gained.spells", cp.stats.spells));
      out.push(...line("markdown.gained.skills", cp.stats.skills));
      out.push(...line("markdown.gained.expertise", cp.stats.expertise));
      out.push(...line("markdown.gained.languages", cp.stats.languages));
      out.push(...line("markdown.gained.tools", cp.stats.tools ?? []));
    } else {
      if (automatic.length) out.push("", `### ${t("markdown.automatic")}`, "", ...automatic);
      if (stats.length) out.push("", `### ${t("markdown.changes")}`, "", ...stats);
    }
    if (guide) {
      // kenli F-002 T13: how to play from this level, or that the last note still holds.
      out.push("", `### ${t("markdown.guide.howToPlay")}`, "");
      const kit = guide.kits.find((k) => k.from_level === cp.level && cp.level > 1);
      if (kit) out.push(`- ${t("markdown.guide.kitFrom", { title: e(kit.title) })}`);
      const n = guide.play.levels.find((l) => l.level === cp.level);
      if (n) {
        out.push(`- ${noteLine(n)}`);
        lastNote = cp.level;
      } else if (cp.level === 1) out.push(`- ${t("markdown.guide.base")}`);
      else
        out.push(
          `- ${lastNote === null ? t("markdown.guide.inheritBase") : t("markdown.guide.inherit", { level: lastNote })}`,
        );
    }
    out.push("");
  }
  out.push(`## ${t("markdown.omissions")}`, "");
  out.push(`- ${N < 20 ? t("markdown.partial", { level: N }) : t("markdown.complete")}`);
  out.push(`- ${t("markdown.tableCalls")}`);
  out.push("", `## ${t("markdown.dmNote")}`, "", t("markdown.dmText"), "");
  return out.join("\n");
}

/** The download's file name: the plan id, `.md`. */
export const markdownFileName = (file: Omit<PlanFile, "packs">) =>
  `${file.plan.id.replace(/[^a-z0-9._-]/g, "-")}.md`;
