/**
 * Inventory: equip, attune, use (potions, charges), remove, add catalog items (a magic weapon or
 * armor made from a base, an item of a kind), coins; and the notice for starting equipment not
 * taken yet (shown above the sheet's tabs). Every change is a play action; the engine checks
 * attunement limits, charges and bases.
 */

import { useMemo, useState } from "react";
import type { CURRENCIES, MagicItemDef, PlaySheet, TableName } from "srd-rules-engine";
import { Icon } from "@/components/Icon";
import { SrdText } from "@/components/SrdText";
import { Button, cx, Dialog, Empty, Reasons, Section } from "@/components/ui";
import { VirtualList } from "@/components/VirtualList";
import { constants } from "@/engine/constants";
import { formatList, formatNumber, t } from "@/i18n";
import { titleCase } from "@/lib/format";
import { useMagicItemBases, useStartingEquipment, useTable } from "@/queries";
import { usePlay } from "./usePlay";

type Currency = (typeof CURRENCIES)[number];
const COINS: readonly Currency[] = ["pp", "gp", "ep", "sp", "cp"];

export function InventoryTab({ id, sheet }: { id: string; sheet: PlaySheet }) {
  const { act, reasons, busy } = usePlay(id);
  const { data: magic } = useTable<MagicItemDef>("magic_items", { character: id });
  const magicById = new Map((magic ?? []).map((m) => [m.id, m]));
  const [adding, setAdding] = useState(false);
  const { play } = sheet;

  return (
    <div className="space-y-4">
      <Section
        title={t("sheet.inventory")}
        actions={
          <Button size="sm" icon="plus" onClick={() => setAdding(true)}>
            {t("sheet.addItem")}
          </Button>
        }
      >
        <p className="mb-2 text-sm text-ink-muted">
          {t("sheet.weight", {
            weight: formatNumber(play.carried_weight),
            capacity: formatNumber(play.carrying_capacity),
          })}
          {" · "}
          {t("sheet.attunedCount", { count: play.attuned, max: constants().max_attuned })}
        </p>
        <Reasons reasons={reasons} className="mb-2" />
        {play.inventory.length === 0 ? (
          <Empty icon="bag">{t("sheet.noItems")}</Empty>
        ) : (
          <ul className="space-y-1.5">
            {play.inventory.map((item) => {
              const def = magicById.get(item.item);
              const usable = item.charges !== null || def?.consumable === true;
              return (
                <li
                  key={item.id}
                  className={cx(
                    "flex flex-wrap items-center gap-2 rounded border px-2 py-1.5",
                    item.active ? "border-ink" : "border-edge",
                  )}
                >
                  <div className="min-w-[10rem] flex-1">
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <span className="font-semibold">
                        {item.name}
                        {item.qty > 1 && <span className="text-ink-muted"> ×{item.qty}</span>}
                      </span>
                      {item.equipped && (
                        <span className="text-[13px] font-bold text-ink">
                          {t("sheet.equipped")}
                        </span>
                      )}
                      {item.attuned && (
                        <span className="text-[13px] text-purple">{t("sheet.attuned")}</span>
                      )}
                    </div>
                    <div className="text-[13px] text-ink-muted">
                      {titleCase(item.category)}
                      {def?.rarity && ` · ${titleCase(def.rarity)}`}
                      {item.weight !== null && ` · ${formatNumber(item.weight * item.qty)} lb`}
                      {item.charges !== null &&
                        ` · ${t("sheet.charges")} ${item.charges - item.charges_spent}/${item.charges}`}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    <Button
                      size="sm"
                      icon="shield"
                      on={item.equipped}
                      disabled={busy}
                      onClick={() =>
                        void act({ type: "equip", id: item.id, equipped: !item.equipped })
                      }
                    >
                      {item.equipped ? t("sheet.unequip") : t("sheet.equip")}
                    </Button>
                    {item.requires_attunement && (
                      <Button
                        size="sm"
                        icon="sparkle"
                        on={item.attuned}
                        disabled={busy}
                        onClick={() =>
                          void act({ type: "attune", id: item.id, attuned: !item.attuned })
                        }
                      >
                        {item.attuned ? t("sheet.unattune") : t("sheet.attune")}
                      </Button>
                    )}
                    {usable && (
                      <Button
                        size="sm"
                        icon="potion"
                        disabled={busy}
                        onClick={() => void act({ type: "use_item", id: item.id })}
                      >
                        {t("sheet.useItem")}
                      </Button>
                    )}
                    {item.charges !== null && item.charges_spent > 0 && (
                      <Button
                        size="sm"
                        icon="plus"
                        iconOnly
                        label={t("common.restoreOne", { what: t("sheet.charges") })}
                        disabled={busy}
                        onClick={() =>
                          void act({
                            type: "set_charges",
                            id: item.id,
                            spent: item.charges_spent - 1,
                          })
                        }
                      />
                    )}
                    <Button
                      size="sm"
                      icon="coin"
                      iconOnly
                      label={`${t("sheet.sell")}: ${item.name}`}
                      disabled={busy}
                      onClick={() => void act({ type: "sell", id: item.id, qty: 1 })}
                    />
                    <Button
                      size="sm"
                      variant="danger"
                      icon="trash"
                      iconOnly
                      label={`${t("common.remove")}: ${item.name}`}
                      disabled={busy}
                      onClick={() => void act({ type: "remove_item", id: item.id, qty: 1 })}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Section>
      <Coins id={id} sheet={sheet} />
      {adding && <AddItemDialog id={id} onClose={() => setAdding(false)} />}
    </div>
  );
}

function Coins({ id, sheet }: { id: string; sheet: PlaySheet }) {
  const { act, reasons, busy } = usePlay(id);
  const [amount, setAmount] = useState("");
  const [coin, setCoin] = useState<Currency>("gp");
  const n = Number.parseInt(amount, 10);
  const change = async (sign: 1 | -1) => {
    if (await act({ type: "adjust_currency", changes: { [coin]: sign * n } })) setAmount("");
  };
  return (
    <Section title={t("sheet.coins")}>
      <dl className="mb-3 grid grid-cols-5 gap-2 text-center">
        {COINS.map((c) => (
          <div key={c} className="rounded border border-edge bg-card-2 py-1">
            <dt className="text-[13px] text-ink-muted uppercase">{c}</dt>
            <dd className="font-display text-xl font-bold tabular-nums">
              {sheet.play.currency[c]}
            </dd>
          </div>
        ))}
      </dl>
      <Reasons reasons={reasons} className="mb-2" />
      <div className="flex flex-wrap gap-2">
        <input
          className="field w-24"
          inputMode="numeric"
          aria-label={t("sheet.amount")}
          placeholder={t("sheet.amount")}
          value={amount}
          onChange={(e) => setAmount(e.target.value.replace(/[^0-9]/g, ""))}
        />
        <select
          className="field w-20"
          aria-label={t("sheet.coins")}
          value={coin}
          onChange={(e) => setCoin(e.target.value as Currency)}
        >
          {COINS.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <Button size="sm" icon="plus" disabled={!(n > 0) || busy} onClick={() => void change(1)}>
          {t("common.add")}
        </Button>
        <Button size="sm" icon="minus" disabled={!(n > 0) || busy} onClick={() => void change(-1)}>
          {t("sheet.currencyChange")}
        </Button>
      </div>
    </Section>
  );
}

interface Pickable {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly table: TableName;
  /** The catalog's price (`15 gp`), when the item has one. */
  readonly cost?: string | null;
}

const ITEM_TABLES = ["weapons", "armor", "gear", "tools", "magic_items"] as const;

function AddItemDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const { act, reasons, busy } = usePlay(id);
  const weapons = useTable<Pickable>("weapons", { character: id });
  const armor = useTable<Pickable>("armor", { character: id });
  const gear = useTable<Pickable>("gear", { character: id });
  const tools = useTable<Pickable>("tools", { character: id });
  const magic = useTable<MagicItemDef>("magic_items", { character: id });
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<Pickable | null>(null);
  const [base, setBase] = useState("");
  const [variant, setVariant] = useState("");
  const [qty, setQty] = useState("1");

  const all = useMemo(() => {
    const tables = [weapons.data, armor.data, gear.data, tools.data, magic.data];
    return tables.flatMap((rows, i) =>
      (rows ?? []).map((r) => ({
        id: r.id,
        name: r.name,
        description: r.description,
        table: ITEM_TABLES[i] as TableName,
        cost: "cost" in r ? (r.cost as string | null | undefined) : null,
      })),
    );
  }, [weapons.data, armor.data, gear.data, tools.data, magic.data]);
  const q = query.trim().toLowerCase();
  const visible = (q ? all.filter((i) => i.name.toLowerCase().includes(q)) : all).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  const magicDef =
    picked?.table === "magic_items" ? magic.data?.find((m) => m.id === picked.id) : undefined;
  // A magic item made from a mundane one: the items the engine says it can be made from.
  const baseIds = useMagicItemBases(magicDef?.base ? magicDef.id : null, id).data;
  const bases = useMemo(() => {
    if (!baseIds?.length) return null;
    const ids = new Set(baseIds);
    return [...(weapons.data ?? []), ...(armor.data ?? []), ...(gear.data ?? [])].filter((r) =>
      ids.has(r.id),
    );
  }, [baseIds, weapons.data, armor.data, gear.data]);
  const count = Number.parseInt(qty, 10);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={t("sheet.addItem")} wide>
      <Reasons reasons={reasons} className="mb-2" />
      <label className="mb-2 flex items-center gap-2">
        <Icon name="search" className="text-ink-muted" />
        <span className="sr-only">{t("sheet.itemSearch")}</span>
        <input
          className="field"
          type="search"
          placeholder={t("sheet.itemSearch")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      <div className="grid gap-3 md:grid-cols-2">
        <VirtualList
          items={visible}
          estimate={40}
          className="h-[22rem] rounded border border-edge"
          label={t("sheet.addItem")}
          getKey={(i) => `${i.table}:${i.id}`}
          render={(i) => (
            <button
              type="button"
              onClick={() => {
                setPicked(i);
                setBase("");
                setVariant("");
              }}
              className={cx(
                "flex w-full items-baseline gap-2 border-b border-edge/60 px-2 py-2 text-left hover:bg-card-2",
                picked?.id === i.id && picked.table === i.table && "bg-hl text-hl-ink",
              )}
            >
              <span className="flex-1">{i.name}</span>
              <span className="text-[13px] text-ink-faint">
                {t(`compendium.table.${i.table}` as const)}
              </span>
            </button>
          )}
        />
        <div className="space-y-2">
          {picked ? (
            <>
              <h3 className="font-display text-xl text-ink">{picked.name}</h3>
              {bases && (
                <label className="flex flex-col gap-1 text-sm">
                  {t("sheet.base")}
                  <select className="field" value={base} onChange={(e) => setBase(e.target.value)}>
                    <option value="">—</option>
                    {[...bases]
                      .sort((a, b) => a.name.localeCompare(b.name))
                      .map((b) => (
                        <option key={b.id} value={b.id}>
                          {b.name}
                        </option>
                      ))}
                  </select>
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
                    item: picked.id,
                    qty: count,
                    ...(base ? { base } : {}),
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
                    item: picked.id,
                    qty: count,
                    ...(base ? { base } : {}),
                    ...(variant ? { variant } : {}),
                  });
                  if (ok) onClose();
                }}
              >
                {t("sheet.buy")}
              </Button>
              {picked.cost && (
                <p className="text-sm text-ink-muted">{t("sheet.price", { price: picked.cost })}</p>
              )}
              {picked.description && (
                <SrdText text={picked.description} className="max-h-60 overflow-y-auto text-sm" />
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

/**
 * The build's starting equipment, not in the inventory yet (a character created before its
 * equipment was picked): what it holds, and a button to take it.
 */
export function StartingEquipment({ id }: { id: string }) {
  const { act, reasons, busy } = usePlay(id);
  const kit = useStartingEquipment(id, true).data;
  if (!kit || (kit.items.length === 0 && kit.gp === 0)) return null;
  const names = kit.items.map((i) => (i.qty > 1 ? `${i.name} (${formatNumber(i.qty)})` : i.name));
  if (kit.gp > 0) names.push(t("sheet.gold", { gp: formatNumber(kit.gp) }));
  return (
    <section
      aria-label={t("sheet.startingEquipment")}
      className="panel flex flex-wrap items-center gap-x-3 gap-y-2 border-l-4 border-l-orange p-3"
    >
      <Icon name="bag" size={18} className="flex-none text-orange" />
      <div className="min-w-0 flex-1">
        <p className="font-bold">{t("sheet.startingEquipmentMissing")}</p>
        <p className="text-sm text-ink-muted">{formatList(names)}</p>
      </div>
      <Button
        variant="primary"
        icon="plus"
        disabled={busy}
        onClick={() => void act({ type: "take_starting_equipment" })}
      >
        {t("sheet.takeStartingEquipment")}
      </Button>
      <Reasons reasons={reasons} className="w-full" />
    </section>
  );
}
