/**
 * kenli F-006 T03: how a journal entry reads in the History panel. Only stored, structured fields
 * are used (kinds, request and result fields, the engine's messages as they were kept); no engine
 * text is parsed and no rule is worked out again.
 *
 * kenli F-007 T03 R04-02: `request`, `result` and a rest die's roll are opaque historical JSON (a
 * local copy keeps them verbatim, any shape). They are read only through the guards below: a field
 * that isn't the expected scalar gives a neutral label, never an exception; the data stays as is.
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

/** A stored value as a label: a string as it is, a finite number as text, anything else none. */
export const label = (v: unknown): string | undefined =>
  typeof v === "string" ? v : typeof v === "number" && Number.isFinite(v) ? String(v) : undefined;
/** A field of an opaque stored value (`undefined` when it isn't an object with that own field). */
export const field = (v: unknown, key: string): unknown =>
  typeof v === "object" && v !== null && !Array.isArray(v) && Object.hasOwn(v, key)
    ? (v as Record<string, unknown>)[key]
    : undefined;
/** Any stored value as plain text (shown as text, never parsed). */
export function plain(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v) ?? "—";
  } catch {
    return "—";
  }
}

const humanize = (s: unknown) => (typeof s === "string" ? s.replace(/[_-]+/g, " ") : "");
const actionsOf = (q: unknown): unknown[] => (Array.isArray(q) ? q : [q]);

/** What an entry was, in a few words: its kind and its subject (a roll's label, an action's type). */
export function titleOf(
  e: HistoryEntry,
  encounterName?: (id: string) => string | undefined,
): string {
  const r = e.result;
  const q = e.request;
  switch (e.kind) {
    case "test":
      return t("history.kind.test", { what: label(field(r, "label")) ?? "" });
    case "sheet_roll":
      return t("history.kind.sheetRoll", { what: label(field(r, "name")) ?? "" });
    case "damage":
      return t("history.kind.damage", { what: label(field(q, "label")) ?? "" });
    case "death_save":
      return t("history.kind.deathSave");
    case "late_advantage":
      return t("history.kind.lateAdvantage");
    case "reroll":
      return field(q, "kind") === "death_save"
        ? t("history.kind.rerollDeathSave")
        : t("history.kind.reroll");
    case "set_critical":
      return field(q, "critical") === false
        ? t("history.kind.notCritical")
        : t("history.kind.critical");
    case "short_rest":
      return t("history.kind.shortRest");
    case "long_rest":
      return t("history.kind.longRest");
    case "import_boundary":
      return t("history.kind.import");
    case "encounter": {
      const name = e.context.encounter_id ? encounterName?.(e.context.encounter_id) : undefined;
      return t("history.kind.encounter", {
        what: actionsOf(q)
          .map((a) => humanize(field(a, "type")))
          .join(", "),
        where: name ?? t("history.encounterGone"),
      });
    }
    case "play":
      return t("history.kind.play", {
        what: actionsOf(q)
          .map((a) => humanize(field(a, "type")))
          .join(", "),
      });
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
  return `${c.path}: ${plain(c.before)} → ${plain(c.after)}`;
}
