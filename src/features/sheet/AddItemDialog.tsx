/**
 * Add a catalog item (kenli F-013 T03): browse by kind (All, Weapons, Armor, Shields, Tools, Gear)
 * without typing a name, narrow with Magic / proficient / within my coins, and see how each item
 * suits the character now: proficiency or training, Weapon Mastery apart, every restriction of
 * using it and its listed price — all from the engine's assessment (one batch for the list, one
 * for the item picked with its base and kind). Buy and Add are the same play actions as before;
 * browsing changes nothing.
 */

import { type ReactNode, useEffect, useMemo, useState } from "react";
import type {
  ArmorDef,
  GearDef,
  ItemAssessmentRequest,
  MagicItemDef,
  ToolDef,
  WeaponDef,
} from "srd-rules-engine";
import { Icon } from "@/components/Icon";
import { SrdText } from "@/components/SrdText";
import { Button, cx, Dialog, Empty, Reasons, Spinner } from "@/components/ui";
import { VirtualList } from "@/components/VirtualList";
import type { AssessedItem } from "@/engine/facade";
import { t, tn } from "@/i18n";
import { useItemAssessments, useMagicItemBases, useTable } from "@/queries";
import {
  brief,
  type CatalogRow,
  type Filters,
  KIND_LABEL,
  KINDS,
  matches,
  NO_FILTERS,
  needsAssessment,
  priceLabel,
  rowKey,
  statusOf,
  TONE_CLASS,
} from "./itemBrowse";
import { usePlay } from "./usePlay";

export function AddItemDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const { act, reasons, busy } = usePlay(id);
  const weapons = useTable<WeaponDef>("weapons", { character: id });
  const armor = useTable<ArmorDef>("armor", { character: id });
  const gear = useTable<GearDef>("gear", { character: id });
  const tools = useTable<ToolDef>("tools", { character: id });
  const magic = useTable<MagicItemDef>("magic_items", { character: id });
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [picked, setPicked] = useState<CatalogRow | null>(null);
  const [base, setBase] = useState("");
  const [variant, setVariant] = useState("");
  const [qty, setQty] = useState("1");
  const set = (change: Partial<Filters>) => setFilters((f) => ({ ...f, ...change }));

  // kenli F-013 T04 (R03-03): the catalog is listed only when every table has loaded; a table
  // that fails is said (with Try again), never a seemingly complete list or an endless spinner.
  const tables = [weapons, armor, gear, tools, magic];
  const tablesFailed = tables.some((q) => q.isError);
  const loaded = tables.every((q) => q.data !== undefined);
  const rows = useMemo<CatalogRow[]>(
    () =>
      [
        ...(weapons.data ?? []).map((def) => ({ table: "weapons" as const, def })),
        ...(armor.data ?? []).map((def) => ({ table: "armor" as const, def })),
        ...(gear.data ?? []).map((def) => ({ table: "gear" as const, def })),
        ...(tools.data ?? []).map((def) => ({ table: "tools" as const, def })),
        ...(magic.data ?? []).map((def) => ({ table: "magic_items" as const, def })),
      ].sort((a, b) => a.def.name.localeCompare(b.def.name)),
    [weapons.data, armor.data, gear.data, tools.data, magic.data],
  );
  // One batch for the whole list: filtering and typing don't ask the engine again.
  const requests = useMemo<ItemAssessmentRequest[] | null>(
    () =>
      magic.data && weapons.data && armor.data && gear.data && tools.data
        ? rows.map((r) => ({ table: r.table, item: r.def.id }))
        : null,
    [rows, magic.data, weapons.data, armor.data, gear.data, tools.data],
  );
  const batch = useItemAssessments(id, requests);
  const byKey = useMemo(
    () => new Map((batch.data?.items ?? []).map((a) => [a.key, a])),
    [batch.data],
  );
  const purse = batch.data?.purse_cp ?? null;
  const waiting = needsAssessment(filters) && !batch.data;
  const assessFailed = batch.isError && needsAssessment(filters);
  const visible = waiting
    ? []
    : rows.filter((r) => matches(r, byKey.get(rowKey(r)), filters, purse));

  const magicDef = picked?.table === "magic_items" ? picked.def : undefined;
  // A magic item made from a mundane one: the items the engine says it can be made from.
  const basesQuery = useMagicItemBases(magicDef?.base ? magicDef.id : null, id);
  const baseIds = basesQuery.data;
  const template = picked ? byKey.get(rowKey(picked)) : undefined;
  const fitting = new Set(template?.bases?.proficient ?? []);
  const bases = useMemo(() => {
    if (!baseIds?.length) return null;
    const ids = new Set(baseIds);
    return [...(weapons.data ?? []), ...(armor.data ?? []), ...(gear.data ?? [])].filter((r) =>
      ids.has(r.id),
    );
  }, [baseIds, weapons.data, armor.data, gear.data]);
  // With "I'm proficient or trained" on, a template offers the bases that suit the character.
  const offered =
    bases && filters.proficient && template?.bases ? bases.filter((b) => fitting.has(b.id)) : bases;
  // kenli F-013 T04 (R03-02): the base shown is the one assessed and sent. A base the offered list
  // no longer has (the proficiency filter, a new answer for the character) isn't chosen any more.
  const chosenBase = base && offered?.some((b) => b.id === base) ? base : "";
  useEffect(() => {
    if (base && offered && !offered.some((b) => b.id === base)) setBase("");
  }, [base, offered]);
  // The item picked, with its base and kind: the definitive answer (never the previous base's).
  const detailRequest = useMemo<ItemAssessmentRequest[] | null>(
    () =>
      picked
        ? [
            {
              table: picked.table,
              item: picked.def.id,
              ...(chosenBase ? { base: chosenBase } : {}),
              ...(variant ? { variant } : {}),
            },
          ]
        : null,
    [picked, chosenBase, variant],
  );
  const detail = useItemAssessments(id, detailRequest);
  const assessed = detail.data?.items[0];
  /** Ask again for whatever failed: a table, the assessments, the bases. */
  const retry = () => {
    for (const q of [...tables, batch, basesQuery, detail]) if (q.isError) void q.refetch();
  };
  const count = Number.parseInt(qty, 10);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={t("sheet.addItem")} wide>
      <Reasons reasons={reasons} className="mb-2" />
      <div className="mb-2 space-y-2">
        <fieldset>
          <legend className="sr-only">{t("sheet.items.kind")}</legend>
          <div className="flex flex-wrap gap-1">
            {KINDS.map((k) => (
              <Button
                key={k}
                size="sm"
                on={filters.kind === k}
                aria-pressed={filters.kind === k}
                onClick={() => set({ kind: k })}
              >
                {t(KIND_LABEL[k])}
              </Button>
            ))}
          </div>
        </fieldset>
        <fieldset className="flex flex-wrap items-center gap-1">
          <legend className="float-left mr-1 text-[13px] text-ink-muted">
            {t("sheet.items.filters")}
          </legend>
          <Button
            size="sm"
            icon="sparkle"
            on={filters.magic}
            aria-pressed={filters.magic}
            onClick={() => set({ magic: !filters.magic })}
          >
            {t("sheet.items.filter.magic")}
          </Button>
          <Button
            size="sm"
            icon="check"
            on={filters.proficient}
            aria-pressed={filters.proficient}
            onClick={() => set({ proficient: !filters.proficient })}
          >
            {t("sheet.items.filter.proficient")}
          </Button>
          <Button
            size="sm"
            icon="coin"
            on={filters.budget}
            aria-pressed={filters.budget}
            onClick={() => set({ budget: !filters.budget })}
          >
            {t("sheet.items.filter.budget")}
          </Button>
          {/* No F-002 plan gives recommended items yet: the filter is off and says why. */}
          <Button
            size="sm"
            icon="star"
            disabled
            aria-pressed={false}
            aria-describedby="items-recommended-none"
          >
            {t("sheet.items.filter.recommended")}
          </Button>
          <span id="items-recommended-none" className="w-full text-[13px] text-ink-muted">
            {t("sheet.items.filter.recommendedNone")}
          </span>
        </fieldset>
        <label className="flex items-center gap-2">
          <Icon name="search" className="text-ink-muted" />
          <span className="sr-only">{t("sheet.itemSearch")}</span>
          <input
            className="field"
            type="search"
            placeholder={t("sheet.itemSearch")}
            value={filters.query}
            onChange={(e) => set({ query: e.target.value })}
          />
        </label>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <div>
          {tablesFailed ? (
            <Failure text={t("sheet.items.loadFailed")} onRetry={retry} />
          ) : !loaded ? (
            <div className="flex h-[22rem] items-center justify-center rounded border border-edge">
              <Spinner label={t("sheet.items.loading")} />
            </div>
          ) : assessFailed ? (
            <Failure text={t("sheet.items.error")} onRetry={retry} />
          ) : waiting ? (
            <div className="flex h-[22rem] items-center justify-center rounded border border-edge">
              <Spinner label={t("sheet.items.checking")} />
            </div>
          ) : visible.length === 0 ? (
            <div className="h-[22rem] rounded border border-edge">
              <Empty icon="search">{t("sheet.items.none")}</Empty>
            </div>
          ) : (
            <>
              {/* The whole catalog is here; only how each item suits the character is missing. */}
              {batch.isError && <Failure text={t("sheet.items.error")} onRetry={retry} />}
              <p className="mb-1 text-[13px] text-ink-muted" aria-live="polite">
                {tn("sheet.items.count", visible.length)}
              </p>
              <VirtualList
                // A new kind, filter or search starts at the top of its list.
                key={JSON.stringify(filters)}
                items={visible}
                estimate={56}
                className="h-[22rem] rounded border border-edge"
                label={t("sheet.addItem")}
                getKey={rowKey}
                render={(row) => (
                  <ItemRow
                    row={row}
                    assessment={byKey.get(rowKey(row))}
                    picked={picked !== null && rowKey(picked) === rowKey(row)}
                    onPick={() => {
                      setPicked(row);
                      setBase("");
                      setVariant("");
                    }}
                  />
                )}
              />
            </>
          )}
        </div>
        <div className="space-y-2">
          {picked ? (
            <>
              <h3 className="font-display text-xl text-ink">{picked.def.name}</h3>
              {basesQuery.isError && (
                <Failure text={t("sheet.items.basesFailed")} onRetry={retry} />
              )}
              {offered && (
                <label className="flex flex-col gap-1 text-sm">
                  {t("sheet.base")}
                  <select
                    className="field"
                    value={chosenBase}
                    onChange={(e) => setBase(e.target.value)}
                  >
                    <option value="">—</option>
                    {[...offered]
                      .sort((a, b) => a.name.localeCompare(b.name))
                      .map((b) => (
                        <option key={b.id} value={b.id}>
                          {fitting.has(b.id) ? t("sheet.items.baseFits", { name: b.name }) : b.name}
                        </option>
                      ))}
                  </select>
                  {offered !== bases && (
                    <span className="text-[13px] text-ink-muted">
                      {t("sheet.items.baseOnlyFitting")}
                    </span>
                  )}
                </label>
              )}
              {magicDef && magicDef.variants.length > 0 && (
                <label className="flex flex-col gap-1 text-sm">
                  {t("sheet.variant")}
                  <select
                    className="field"
                    value={variant}
                    onChange={(e) => setVariant(e.target.value)}
                  >
                    <option value="">—</option>
                    {magicDef.variants.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label className="flex items-center gap-2 text-sm">
                {t("sheet.amount")}
                <input
                  className="field w-20"
                  inputMode="numeric"
                  value={qty}
                  onChange={(e) => setQty(e.target.value.replace(/[^0-9]/g, ""))}
                />
              </label>
              <Button
                variant="primary"
                icon="plus"
                disabled={busy || !(count > 0)}
                onClick={async () => {
                  const ok = await act({
                    type: "add_item",
                    item: picked.def.id,
                    qty: count,
                    ...(chosenBase ? { base: chosenBase } : {}),
                    ...(variant ? { variant } : {}),
                  });
                  if (ok) onClose();
                }}
              >
                {t("common.add")}
              </Button>
              <Button
                icon="coin"
                disabled={busy || !(count > 0)}
                onClick={async () => {
                  const ok = await act({
                    type: "buy",
                    item: picked.def.id,
                    qty: count,
                    ...(chosenBase ? { base: chosenBase } : {}),
                    ...(variant ? { variant } : {}),
                  });
                  if (ok) onClose();
                }}
              >
                {t("sheet.buy")}
              </Button>
              <ItemDetails
                detail={assessed}
                loading={detail.isPending}
                failed={detail.isError}
                onRetry={retry}
              />
              {picked.def.description && (
                <SrdText
                  text={picked.def.description}
                  className="max-h-60 overflow-y-auto text-sm"
                />
              )}
            </>
          ) : (
            <Empty icon="bag">{t("compendium.pick")}</Empty>
          )}
        </div>
      </div>
    </Dialog>
  );
}

function ItemRow({
  row,
  assessment: a,
  picked,
  onPick,
}: {
  row: CatalogRow;
  assessment: AssessedItem | undefined;
  picked: boolean;
  onPick: () => void;
}) {
  const status = a ? statusOf(a) : null;
  // "No proficiency bonus" is the status itself; the chip counts penalties and requirements.
  const limits =
    a?.restrictions.filter((r) => r.effect === "penalty" || r.effect === "requirement") ?? [];
  const penalty = limits.some((r) => r.effect === "penalty");
  const params = brief(row);
  return (
    <button
      type="button"
      aria-pressed={picked}
      onClick={onPick}
      data-testid={`item-row-${rowKey(row)}`}
      className={cx(
        "flex w-full flex-col gap-0.5 border-b border-edge/60 px-2 py-2 text-left hover:bg-card-2",
        picked && "bg-hl text-hl-ink",
      )}
    >
      <span className="flex w-full flex-wrap items-baseline gap-x-2">
        <span className="flex-1 font-semibold">{row.def.name}</span>
        {a && <span className="text-[13px] tabular-nums">{priceLabel(a)}</span>}
      </span>
      {params && <span className="text-[13px] text-ink-muted">{params}</span>}
      <span className="flex flex-wrap gap-1 text-[13px]">
        {row.table === "magic_items" && (
          <Chip icon="sparkle" className="border-purple text-purple">
            {t("sheet.items.magic")}
          </Chip>
        )}
        {status && (
          <Chip icon={status.icon} className={TONE_CLASS[status.tone]}>
            {status.label}
          </Chip>
        )}
        {a?.mastery.status === "yes" && a.mastery.name && (
          <Chip icon="star" className="border-blue text-blue">
            {t("sheet.items.mastery", { name: a.mastery.name })}
          </Chip>
        )}
        {limits.length > 0 && (
          <Chip
            icon="warning"
            className={penalty ? "border-red text-red" : "border-purple text-purple"}
          >
            {tn("sheet.items.restrictions", limits.length)}
          </Chip>
        )}
      </span>
    </button>
  );
}

function Chip({
  icon,
  className,
  children,
}: {
  icon: Parameters<typeof Icon>[0]["name"];
  className: string;
  children: ReactNode;
}) {
  return (
    <span className={cx("inline-flex items-center gap-1 rounded border px-1.5", className)}>
      <Icon name={icon} size={14} />
      {children}
    </span>
  );
}

/** What failed, in plain words, and a way to ask again (kenli F-013 T04, R03-03). */
function Failure({ text, onRetry }: { text: string; onRetry: () => void }) {
  return (
    <div
      role="alert"
      className="mb-1 flex flex-wrap items-center gap-2 rounded border border-red/60 px-2 py-1.5 text-sm"
    >
      <Icon name="warning" size={16} className="flex-none text-red" />
      <span className="flex-1">{text}</span>
      <Button size="sm" onClick={onRetry}>
        {t("sheet.items.retry")}
      </Button>
    </div>
  );
}

/** Everything the engine says about the picked item, as text (no hover needed). */
function ItemDetails({
  detail: a,
  loading,
  failed,
  onRetry,
}: {
  detail: AssessedItem | undefined;
  loading: boolean;
  failed: boolean;
  onRetry: () => void;
}) {
  if (failed) return <Failure text={t("sheet.items.error")} onRetry={onRetry} />;
  if (loading || !a) return <Spinner label={t("sheet.items.checking")} />;
  const status = statusOf(a);
  return (
    <section
      aria-label={t("sheet.items.details")}
      data-testid="item-details"
      className="space-y-2 rounded border border-edge p-2 text-sm"
    >
      <p className="text-[13px] tabular-nums text-ink-muted">{priceLabel(a)}</p>
      <div>
        <h4 className="font-bold">{t("sheet.items.proficiency")}</h4>
        <p className="flex flex-wrap items-center gap-1">
          <Chip icon={status.icon} className={TONE_CLASS[status.tone]}>
            {status.label}
          </Chip>
          <span>{a.proficiency.reason.text}</span>
        </p>
      </div>
      {a.mastery.status !== "not_applicable" && (
        <div>
          <h4 className="font-bold">{t("sheet.items.masteryHeading")}</h4>
          <p>{a.mastery.reason.text}</p>
        </div>
      )}
      <div>
        <h4 className="font-bold">{t("sheet.items.restrictionsHeading")}</h4>
        {a.restrictions.length === 0 ? (
          <p className="text-ink-muted">{t("sheet.items.noRestrictions")}</p>
        ) : (
          <ul className="space-y-1">
            {a.restrictions.map((r) => (
              <li key={r.code} className="flex gap-1.5" data-code={r.code}>
                <Icon
                  name={r.effect === "note" ? "info" : "warning"}
                  size={16}
                  className={cx(
                    "mt-0.5 flex-none",
                    r.effect === "penalty" && "text-red",
                    r.effect === "no_proficiency_bonus" && "text-orange",
                    r.effect === "requirement" && "text-purple",
                    r.effect === "note" && "text-ink-muted",
                  )}
                />
                <span>
                  {r.message.text}
                  {r.evaluation === "manual" && (
                    <span className="text-ink-muted"> · {t("sheet.items.byHand")}</span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
      {a.issues.length > 0 && (
        <div>
          <h4 className="font-bold">{t("sheet.items.request")}</h4>
          <ul className="space-y-1">
            {a.issues.map((i) => (
              <li key={i.code} className="flex gap-1.5">
                <Icon name="info" size={16} className="mt-0.5 flex-none text-orange" />
                <span>{i.message.text}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
