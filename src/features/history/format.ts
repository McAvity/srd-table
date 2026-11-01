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
import { signed, t } from "@/i18n";
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
    // kenli F-002 T05: a planned level gained, or a plan bound (no level gained, no roll, no rest).
    case "level_up": {
      const l = e.level_up;
      if (!l) return t("history.kind.levelUp", { level: "?", class: "", classLevel: "" });
      return l.mode === "bind"
        ? t("history.kind.planBound", { level: l.to_level })
        : t("history.kind.levelUp", {
            level: l.to_level,
            class: humanize(l.class_id).replace(/\b\w/g, (c) => c.toUpperCase()),
            classLevel: l.class_level,
          });
    }
    case "refused":
      return t("history.kind.refused", { what: e.refusal?.label ?? "" });
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

/** A stored state value as the table says it (`hp.current: null` is "at its maximum"). */
function valueText(path: string, v: unknown): string {
  if (path === "hp.current" && v === null) return t("history.max");
  if (Array.isArray(v)) return v.length ? v.map(plain).join(", ") : "—";
  return plain(v);
}
/** A stored state path as the table says it; an unknown one as it is. */
function pathText(path: string, nameOfUse: (key: string) => string | undefined): string {
  if (path === "hp.current") return t("history.path.hp");
  if (path === "hp.temp") return t("history.path.temp");
  if (path === "spell_slots_spent") return t("history.path.slots");
  if (path === "pact_slots_spent") return t("history.path.pact");
  if (path === "conditions") return t("history.path.conditions");
  if (path === "exhaustion") return t("history.path.exhaustion");
  const use = /^uses_spent\.(.+)$/.exec(path);
  if (use?.[1])
    return t("history.path.uses", {
      name: nameOfUse(use[1]) ?? humanize(use[1].split(":").pop() ?? use[1]),
    });
  return path;
}

/**
 * kenli F-011 (AC-09, review03 R03-04): what an entry changed, said without opening its details —
 * the applied change as stored (`state_delta`), never worked out again from the roll (rolled damage
 * is the outcome; the HP change is this). At most `max` changes, then "…".
 */
export function appliedText(
  e: HistoryEntry,
  nameOfUse: (key: string) => string | undefined = () => undefined,
  max = 3,
): string | null {
  const d = e.effect.state_delta;
  if (!d.length) return null;
  const shown = d
    .slice(0, max)
    .map(
      (c) =>
        `${pathText(c.path, nameOfUse)}: ${valueText(c.path, c.before)} → ${valueText(c.path, c.after)}`,
    )
    .join(", ");
  return t("history.applied", { changes: d.length > max ? `${shown}, …` : shown });
}

/**
 * review03 R03-04: what a sheet action asked for, from its stored request (a damage of 3, a
 * healing, a use…), said as "Requested: …": the declared command, not its effect (that's
 * `appliedText`) nor a roll. `null` for a request it can't read (an old or foreign shape): nothing
 * is guessed.
 */
export function requestText(
  e: HistoryEntry,
  nameOfUse: (key: string) => string | undefined,
): string | null {
  if (e.kind !== "play") return null;
  const name = (key: unknown) =>
    typeof key === "string" ? (nameOfUse(key) ?? humanize(key.split(":").pop() ?? key)) : "";
  const one = (a: unknown): string | null => {
    const n = (k: string) => {
      const v = field(a, k);
      return typeof v === "number" && Number.isFinite(v) ? v : null;
    };
    switch (field(a, "type")) {
      case "damage": {
        const parts = field(a, "instances");
        const list = Array.isArray(parts)
          ? parts.map((p) => ({ amount: label(field(p, "amount")), type: label(field(p, "type")) }))
          : [{ amount: label(field(a, "amount")), type: label(field(a, "damage_type")) }];
        if (list.some((p) => p.amount === undefined)) return null;
        return list
          .map((p) =>
            p.type
              ? t("history.req.damageTyped", { amount: p.amount as string, type: p.type })
              : t("history.req.damage", { amount: p.amount as string }),
          )
          .join(", ");
      }
      case "heal":
        return n("amount") === null
          ? null
          : t("history.req.heal", { amount: n("amount") as number });
      case "set_hp":
        return n("current") === null
          ? null
          : t("history.req.setHp", { current: n("current") as number });
      case "set_temp_hp":
        return n("amount") === null
          ? null
          : t("history.req.tempHp", { amount: n("amount") as number });
      case "use":
      case "use_feature":
        return t("history.req.use", { name: name(field(a, "key")) });
      case "restore_use":
        return t("history.req.restoreUse", { name: name(field(a, "key")) });
      case "spend_slot":
        return n("level") === null ? null : t("history.req.slot", { level: n("level") as number });
      case "restore_slot":
        return n("level") === null
          ? null
          : t("history.req.restoreSlot", { level: n("level") as number });
      case "add_condition":
        return t("history.req.addCondition", { condition: humanize(field(a, "condition")) });
      case "remove_condition":
        return t("history.req.removeCondition", { condition: humanize(field(a, "condition")) });
      default:
        return typeof field(a, "type") === "string"
          ? t("history.req.other", { what: humanize(field(a, "type")) })
          : null;
    }
  };
  const lines = actionsOf(e.request).map(one);
  // review03 R03-04 (resume): labelled as the request — a healing capped at the maximum, damage
  // taken by temporary HP or a resistance, a temporary HP that doesn't replace a higher one make
  // the effect differ; what happened is `appliedText`, never this.
  return lines.every((l) => l !== null) && lines.length
    ? t("history.requested", { what: lines.join("; ") })
    : null;
}

const numbers = (v: unknown): number[] | null =>
  Array.isArray(v) && v.every((x) => typeof x === "number" && Number.isFinite(x)) ? v : null;
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** One d20 roll as stored (`D20TestResult` or an attack's dice): dice, bonus, total, modifiers. */
function d20Lines(x: unknown, fallback: string): string[] {
  const roll = field(x, "roll");
  const rolls = numbers(field(roll, "rolls"));
  const total = num(field(x, "total"));
  if (!rolls || total === null) return [];
  const name = label(field(x, "label")) ?? label(field(x, "attack")) ?? fallback;
  const mode = field(roll, "mode");
  const shown =
    mode === "advantage" || mode === "disadvantage"
      ? t("history.dice.mode", {
          label: name,
          mode: t(mode === "advantage" ? "dice.advantage" : "dice.disadvantage"),
        })
      : name;
  const bonus = num(field(x, "bonus"));
  const out = [
    bonus
      ? t("history.dice.line", {
          label: shown,
          rolls: rolls.join(", "),
          bonus: signed(bonus),
          total,
        })
      : t("history.dice.lineNoBonus", { label: shown, rolls: rolls.join(", "), total }),
  ];
  const mods = field(x, "modifiers");
  if (Array.isArray(mods))
    for (const m of mods) {
      const v = num(field(m, "value"));
      const l = label(field(m, "label"));
      if (v !== null && l) out.push(t("history.dice.modifier", { label: l, value: signed(v) }));
    }
  const extra = field(x, "bonus_dice");
  if (Array.isArray(extra))
    for (const d of extra) {
      const r = numbers(field(d, "rolls"));
      const tt = num(field(d, "total"));
      const l = label(field(d, "label"));
      const dice = label(field(d, "dice"));
      if (r && tt !== null && l && dice)
        out.push(
          t("history.dice.bonusDie", { label: l, dice, rolls: r.join(", "), total: signed(tt) }),
        );
    }
  return out;
}

/** Rolled damage as stored (`RolledDamage`): each part's dice, bonus and total. */
function damageLines(x: unknown): string[] {
  const parts = field(x, "parts");
  if (!Array.isArray(parts)) return [];
  const out: string[] = [];
  for (const p of parts) {
    const rolls = numbers(field(p, "rolls"));
    const total = num(field(p, "total"));
    if (!rolls || total === null) continue;
    const name = `${label(field(p, "dice")) ?? ""} ${label(field(p, "type")) ?? ""}`.trim();
    const bonus = num(field(p, "bonus"));
    out.push(
      bonus
        ? t("history.dice.line", {
            label: name,
            rolls: rolls.join(", "),
            bonus: signed(bonus),
            total,
          })
        : t("history.dice.lineNoBonus", { label: name, rolls: rolls.join(", "), total }),
    );
  }
  const total = num(field(x, "total"));
  if (parts.length > 1 && total !== null) out.push(t("history.dice.damageTotal", { total }));
  return out;
}

/**
 * review03 R03-04: a roll's dice as the dice tray showed them — every die (both with Advantage),
 * the bonus, the total, the GM's modifiers and bonus dice, rolled damage per part — read from the
 * stored result only. A shape it can't read gives no line (old or foreign data stays as it is).
 */
export function diceLines(kind: string, result: unknown): string[] {
  try {
    switch (kind) {
      case "test":
      case "late_advantage":
      case "reroll":
      case "set_critical":
        if (field(field(result, "roll"), "rolls") !== undefined)
          return [...d20Lines(result, "d20"), ...damageLines(field(result, "damage"))];
        if (field(result, "parts") !== undefined) return damageLines(result);
        return numbers(field(result, "rolls")) && num(field(result, "total")) !== null
          ? [
              t("history.dice.lineNoBonus", {
                label: "d20",
                rolls: (numbers(field(result, "rolls")) as number[]).join(", "),
                total: num(field(result, "total")) as number,
              }),
            ]
          : [];
      case "sheet_roll": {
        const rolls = field(result, "rolls");
        const attacks = field(rolls, "attacks");
        const out: string[] = [];
        if (Array.isArray(attacks))
          for (const a of attacks)
            out.push(...d20Lines(a, "d20"), ...damageLines(field(a, "damage")));
        out.push(...damageLines(field(rolls, "damage")));
        const die = field(rolls, "die");
        const r = numbers(field(die, "rolls"));
        const tt = num(field(die, "total"));
        if (r && tt !== null)
          out.push(
            t("history.dice.lineNoBonus", {
              label: label(field(result, "name")) ?? "",
              rolls: r.join(", "),
              total: tt,
            }),
          );
        return out;
      }
      case "damage":
        return damageLines(result);
      case "death_save": {
        const r = numbers(field(result, "rolls"));
        const tt = num(field(result, "total"));
        return r && tt !== null
          ? [t("history.dice.lineNoBonus", { label: "d20", rolls: r.join(", "), total: tt })]
          : [];
      }
      default:
        return [];
    }
  } catch {
    return [];
  }
}

/** A state change line: `hp.current: 13 → 4`. */
export function changeText(c: { path: string; before: unknown; after: unknown }): string {
  return `${c.path}: ${plain(c.before)} → ${plain(c.after)}`;
}
