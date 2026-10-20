/**
 * kenli F-006 T03: how a journal entry reads in the History panel. Only stored, structured fields
 * are used (kinds, request and result fields, the engine's messages as they were kept); no engine
 * text is parsed and no rule is worked out again.
 */

import type { Message, RollCost } from "srd-rules-engine";
import { t } from "@/i18n";
import type { HistoryDay, HistoryEntry, OutcomeValue } from "@/store/history";

// biome-ignore lint/suspicious/noExplicitAny: stored engine results of several shapes, read by field.
type Loose = any;

/** The day's name: its label, else "Day n". */
export function dayName(day: HistoryDay | undefined): string {
  if (!day) return t("history.dayUnknownName");
  return day.label ?? t("history.dayN", { n: day.n });
}

const humanize = (s: string) => s.replace(/[_-]+/g, " ");

/** What an entry was, in a few words: its kind and its subject (a roll's label, an action's type). */
export function titleOf(
  e: HistoryEntry,
  encounterName?: (id: string) => string | undefined,
): string {
  const r = e.result as Loose;
  const q = e.request as Loose;
  switch (e.kind) {
    case "test":
      return t("history.kind.test", { what: r?.label ?? "" });
    case "sheet_roll":
      return t("history.kind.sheetRoll", { what: r?.name ?? "" });
    case "damage":
      return t("history.kind.damage", { what: q?.label ?? "" });
    case "death_save":
      return t("history.kind.deathSave");
    case "late_advantage":
      return t("history.kind.lateAdvantage");
    case "reroll":
      return q?.kind === "death_save"
        ? t("history.kind.rerollDeathSave")
        : t("history.kind.reroll");
    case "set_critical":
      return q?.critical === false ? t("history.kind.notCritical") : t("history.kind.critical");
    case "short_rest":
      return t("history.kind.shortRest");
    case "long_rest":
      return t("history.kind.longRest");
    case "import_boundary":
      return t("history.kind.import");
    case "encounter": {
      const actions = (Array.isArray(q) ? q : [q]) as { type?: string }[];
      const name = e.context.encounter_id ? encounterName?.(e.context.encounter_id) : undefined;
      return t("history.kind.encounter", {
        what: actions.map((a) => humanize(a?.type ?? "")).join(", "),
        where: name ?? t("history.encounterGone"),
      });
    }
    case "play": {
      const actions = (Array.isArray(q) ? q : [q]) as { type?: string }[];
      return t("history.kind.play", {
        what: actions.map((a) => humanize(a?.type ?? "")).join(", "),
      });
    }
    default:
      return e.kind;
  }
}

/** A cost as the table says it: a slot, a use (by the sheet's name when known), Inspiration… */
export function costText(cost: RollCost, nameOfUse: (key: string) => string | undefined): string {
  if (cost.type === "daily") return t("history.cost.daily", { name: cost.name });
  if (cost.type === "recharge") return t("history.cost.recharge", { name: cost.name });
  const a = cost.action as Loose;
  switch (a?.type) {
    case "spend_slot":
      return t("history.cost.slot", { level: a.level });
    case "spend_pact_slot":
      return t("history.cost.pactSlot");
    case "spend_inspiration":
      return t("history.cost.inspiration");
    case "use":
      return t("history.cost.use", {
        name: nameOfUse(a.key) ?? humanize(String(a.key).split(":").pop() ?? ""),
      });
    case "use_feature":
      return t("history.cost.use", {
        name: nameOfUse(a.key) ?? humanize(String(a.key).split(":").pop() ?? ""),
      });
    default:
      return humanize(String(a?.type ?? cost.type));
  }
}

/** An outcome value: total, the d20 as rolled → as it counts when they differ, critical, damage. */
export function outcomeText(o: OutcomeValue): string {
  const parts: string[] = [];
  if (o.raw !== null && o.effective !== null && o.raw !== o.effective)
    parts.push(t("history.rawEffective", { raw: o.raw, effective: o.effective }));
  else if (o.effective !== null) parts.push(t("history.die", { value: o.effective }));
  // A roll's total; free damage's total is its damage (said once).
  if (o.total !== null && o.total !== o.damage_total)
    parts.push(t("history.total", { total: o.total }));
  if (o.success !== null) parts.push(o.success ? t("history.success") : t("history.failure"));
  if (o.critical) parts.push(t("history.criticalHit"));
  if (o.damage_total !== null) parts.push(t("history.damageTotal", { total: o.damage_total }));
  return `${o.label ? `${o.label}: ` : ""}${parts.join(" · ")}`;
}

/** The engine's notes kept with an entry, as they were said (rendered, never parsed). */
export const messagesOf = (e: HistoryEntry): string[] =>
  (e.messages as readonly Message[]).map((m) => m.text).filter(Boolean);

/** A state change line: `hp.current: 13 → 4`. */
export function changeText(c: { path: string; before: unknown; after: unknown }): string {
  const v = (x: unknown) =>
    x === null || x === undefined ? "—" : typeof x === "object" ? JSON.stringify(x) : String(x);
  return `${c.path}: ${v(c.before)} → ${v(c.after)}`;
}
