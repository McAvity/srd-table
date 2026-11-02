/**
 * kenli F-013 T03: how the Add item dialog sorts and labels catalog items. Pure presentation over
 * the engine's assessment (`assessItems`): the kind, proficiency, mastery, restrictions and price
 * all come from the engine; nothing here judges a rule.
 */

import type {
  ArmorDef,
  GearDef,
  ItemKind,
  ItemTable,
  MagicItemDef,
  ToolDef,
  WeaponDef,
} from "srd-rules-engine";
import type { IconName } from "@/components/Icon";
import type { AssessedItem } from "@/engine/facade";
import { type MessageKey, t } from "@/i18n";
import { titleCase } from "@/lib/format";

/** A catalog record the dialog lists, with its table's own data for the short parameters. */
export type CatalogRow =
  | { readonly table: "weapons"; readonly def: WeaponDef }
  | { readonly table: "armor"; readonly def: ArmorDef }
  | { readonly table: "tools"; readonly def: ToolDef }
  | { readonly table: "gear"; readonly def: GearDef }
  | { readonly table: "magic_items"; readonly def: MagicItemDef };

export const KINDS = ["all", "weapon", "armor", "shield", "tool", "gear"] as const;
export type KindFilter = (typeof KINDS)[number];

/**
 * kenli F-013 T06 (decision 07): a marker filter's three modes. `require`: only items with the
 * marker; `exclude`: only items without it; `ignore`: the marker doesn't matter (the default).
 */
export const MODES = ["ignore", "require", "exclude"] as const;
export type MarkerMode = (typeof MODES)[number];

export interface Filters {
  readonly kind: KindFilter;
  /** The Magic marker: a record of the magic items table. */
  readonly magic: MarkerMode;
  /** The proficiency marker: `suits` (proficient or trained, or a template with a fitting base). */
  readonly proficient: MarkerMode;
  readonly budget: boolean;
  readonly query: string;
}

export const NO_FILTERS: Filters = {
  kind: "all",
  magic: "ignore",
  proficient: "ignore",
  budget: false,
  query: "",
};

export const rowKey = (row: { table: ItemTable; def: { id: string } }) =>
  `${row.table}:${row.def.id}`;

/**
 * Whether a filter needs the engine's answer (a kind other than All, a proficiency mode other than
 * ignore — exclude too: no answer is no proof the marker is missing — or the budget).
 */
export function needsAssessment(f: Filters): boolean {
  return f.kind !== "all" || f.proficient !== "ignore" || f.budget;
}

/**
 * Whether a row passes every filter (AND). `a` is the engine's assessment; without it only the
 * filters that don't need it can pass (callers wait while `needsAssessment`).
 */
export function matches(
  row: CatalogRow,
  a: AssessedItem | undefined,
  f: Filters,
  purseCp: number | null,
): boolean {
  const q = f.query.trim().toLowerCase();
  if (q && !row.def.name.toLowerCase().includes(q)) return false;
  const magic = row.table === "magic_items";
  if (f.magic === "require" && !magic) return false;
  if (f.magic === "exclude" && magic) return false;
  if (!needsAssessment(f)) return true;
  if (!a) return false;
  if (f.kind !== "all" && a.kind !== f.kind) return false;
  // Exclude is the complement of the positive marker over a loaded answer: gear that needs no
  // proficiency and items that can't be assessed pass it, keeping their own labels.
  if (f.proficient === "require" && !suits(a)) return false;
  if (f.proficient === "exclude" && suits(a)) return false;
  // An unknown price is not free: it never passes.
  if (f.budget && (a.price_cp === null || purseCp === null || a.price_cp > purseCp)) return false;
  return true;
}

/** Proficient or trained, or (a magic item to make from a base) at least one base is. */
export function suits(a: AssessedItem): boolean {
  if (a.proficiency.status === "yes") return true;
  return a.proficiency.status === "choose_base" && (a.bases?.any_proficient ?? false);
}

export type Tone = "good" | "lacking" | "bad" | "neutral" | "unknown" | "choice";

/** The proficiency status as words, an icon and a tone (the colour is never the only sign). */
export function statusOf(a: AssessedItem): { label: string; icon: IconName; tone: Tone } {
  const worn = a.kind === "armor" || a.kind === "shield";
  switch (a.proficiency.status) {
    case "yes":
      return {
        label: t(worn ? "sheet.items.status.trained" : "sheet.items.status.proficient"),
        icon: "check",
        tone: "good",
      };
    case "no":
      return {
        label: t(worn ? "sheet.items.status.notTrained" : "sheet.items.status.notProficient"),
        icon: "warning",
        tone: worn ? "bad" : "lacking",
      };
    case "not_applicable":
      return { label: t("sheet.items.status.notApplicable"), icon: "minus", tone: "neutral" };
    case "choose_base":
      return {
        label: t(
          a.bases?.any_proficient
            ? "sheet.items.status.someBases"
            : "sheet.items.status.chooseBase",
        ),
        icon: "info",
        tone: "choice",
      };
    default:
      return { label: t("sheet.items.status.unknown"), icon: "info", tone: "unknown" };
  }
}

export const TONE_CLASS: Record<Tone, string> = {
  good: "border-green text-green",
  lacking: "border-orange text-orange",
  bad: "border-red text-red",
  neutral: "border-edge text-ink-muted",
  unknown: "border-dashed border-ink-muted text-ink-muted",
  choice: "border-blue text-blue",
};

/** The short parameters from the table's own data: damage, AC rule, kind of tool or rarity. */
export function brief(row: CatalogRow): string {
  switch (row.table) {
    case "weapons": {
      const w = row.def;
      const reach = t(w.kind === "melee" ? "sheet.items.melee" : "sheet.items.ranged");
      return `${w.damage} ${titleCase(w.damage_type)} · ${reach}`;
    }
    case "armor": {
      const a = row.def;
      if (a.category === "shield") return t("sheet.items.acBonus", { ac: a.base_ac });
      if (a.dex_cap === 0) return t("sheet.items.ac", { ac: a.base_ac });
      if (a.dex_cap === null) return t("sheet.items.acDex", { ac: a.base_ac });
      return t("sheet.items.acDexMax", { ac: a.base_ac, max: a.dex_cap });
    }
    case "tools":
      return titleCase(row.def.category);
    case "magic_items":
      return `${titleCase(row.def.rarity)} · ${titleCase(row.def.category)}`;
    default:
      return "";
  }
}

/** The engine's price, per bundle; `null` price stays "no listed price", never 0. */
export function priceLabel(a: AssessedItem): string {
  if (a.price_text === null) return t("sheet.items.noPrice");
  return a.bundle > 1
    ? t("sheet.items.priceBundle", { price: a.price_text, bundle: a.bundle })
    : a.price_text;
}

export const KIND_LABEL: Record<KindFilter | ItemKind, MessageKey> = {
  all: "sheet.items.kind.all",
  weapon: "sheet.items.kind.weapon",
  armor: "sheet.items.kind.armor",
  shield: "sheet.items.kind.shield",
  tool: "sheet.items.kind.tool",
  gear: "sheet.items.kind.gear",
};
