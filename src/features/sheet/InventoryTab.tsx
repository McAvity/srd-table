/**
 * Inventory: equip, attune, use (potions, charges), put away and take back (stored: still owned,
 * not carried), remove, add catalog items (a magic weapon or armor made from a base, an item of a
 * kind), coins; and the notice for starting equipment not taken yet (shown above the sheet's
 * tabs). Every change is a play action; the engine checks attunement limits, charges, bases and
 * what a stored item can't do (its weight, attacks and magic are the engine's too).
 */

import { useState } from "react";
import type { CURRENCIES, MagicItemDef, PlaySheet } from "srd-rules-engine";
import { Icon } from "@/components/Icon";
import { Button, cx, Dialog, Empty, Reasons, Section } from "@/components/ui";
import { constants } from "@/engine/constants";
import { formatList, formatNumber, t } from "@/i18n";
import { titleCase } from "@/lib/format";
import { useStartingEquipment, useTable } from "@/queries";
import { AddItemDialog } from "./AddItemDialog";
import { usePlay } from "./usePlay";

type Currency = (typeof CURRENCIES)[number];
const COINS: readonly Currency[] = ["pp", "gp", "ep", "sp", "cp"];

export function InventoryTab({ id, sheet }: { id: string; sheet: PlaySheet }) {
  const { act, reasons, busy } = usePlay(id);
  const { data: magic } = useTable<MagicItemDef>("magic_items", { character: id });
  const magicById = new Map((magic ?? []).map((m) => [m.id, m]));
  const [adding, setAdding] = useState(false);
  const [custom, setCustom] = useState(false);
  const { play } = sheet;

  return (
    <div className="space-y-4">
      <Section
        title={t("sheet.inventory")}
        actions={
          <span className="flex flex-wrap gap-1">
            <Button size="sm" icon="plus" onClick={() => setAdding(true)}>
              {t("sheet.addItem")}
            </Button>
            <Button size="sm" icon="edit" onClick={() => setCustom(true)}>
              {t("sheet.custom.add")}
            </Button>
          </span>
        }
      >
        <p className="mb-2 text-sm text-ink-muted">
          {t("sheet.weight", {
            weight: formatNumber(play.carried_weight),
            capacity: formatNumber(play.carrying_capacity),
          })}
          {/* kenli F-011 T06 (AC-20): carried items of unknown weight aren't 0 — the total says so. */}
          {play.carried_weight_unknown > 0 && (
            <span data-testid="weight-incomplete">
              {" "}
              {t("sheet.custom.weightIncomplete", { count: play.carried_weight_unknown })}
            </span>
          )}
          {" · "}
          {t("sheet.attunedCount", { count: play.attuned, max: constants().max_attuned })}
        </p>
        <Reasons reasons={reasons} className="mb-2" />
        {play.inventory.length === 0 ? (
          <Empty icon="bag">{t("sheet.noItems")}</Empty>
        ) : (
          <ul className="space-y-1.5">
            {play.inventory.map((item) => {
              // kenli F-011: a custom item has no catalog id (`item: null`), so no magic either.
              const def = item.item === null ? undefined : magicById.get(item.item);
              const isCustom = item.item === null;
              const stored = item.location === "stored";
              // A stored item can only be taken back, sold or removed (the engine refuses the rest).
              const usable = !stored && (item.charges !== null || def?.consumable === true);
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
                      {stored && (
                        <span className="text-[13px] font-bold text-ink-muted">
                          {t("sheet.stored")}
                        </span>
                      )}
                    </div>
                    <div className="text-[13px] text-ink-muted">
                      {titleCase(item.category)}
                      {def?.rarity && ` · ${titleCase(def.rarity)}`}
                      {item.weight !== null &&
                        ` · ${formatNumber(item.weight * item.qty)} lb${stored ? ` (${t("sheet.notCarried")})` : ""}`}
                      {isCustom &&
                        item.weight === null &&
                        ` · ${t("sheet.custom.weightUnknown")}${stored ? ` (${t("sheet.notCarried")})` : ""}`}
                      {item.charges !== null &&
                        ` · ${t("sheet.charges")} ${item.charges - item.charges_spent}/${item.charges}`}
                    </div>
                    {isCustom && item.custom?.description && (
                      <p
                        className="mt-0.5 text-[13px] whitespace-pre-wrap text-ink"
                        data-testid="custom-description"
                      >
                        {item.custom.description}
                      </p>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {/* A custom item can't be worn, attuned or sold (no catalog data, no gold). */}
                    {!stored && !isCustom && (
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
                    )}
                    <Button
                      size="sm"
                      icon="bag"
                      on={stored}
                      disabled={busy}
                      onClick={() => void act({ type: "store", id: item.id, stored: !stored })}
                    >
                      {stored ? t("sheet.takeBack") : t("sheet.putAway")}
                    </Button>
                    {item.requires_attunement && !stored && (
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
                    {!isCustom && (
                      <Button
                        size="sm"
                        icon="coin"
                        iconOnly
                        label={`${t("sheet.sell")}: ${item.name}`}
                        disabled={busy}
                        onClick={() => void act({ type: "sell", id: item.id, qty: 1 })}
                      />
                    )}
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
      {custom && <CustomItemDialog id={id} onClose={() => setCustom(false)} />}
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

/**
 * kenli F-011 T06 (AC-20): an item that isn't in the catalog — a name (required), a description,
 * a quantity and a weight that is known (pounds, 0 allowed) or unknown (not 0: it isn't counted and
 * the carried total says it's incomplete). One play action (`add_custom_item`): journaled, undone
 * like any other; no gold, no catalog effects. The engine checks the values too.
 */
function CustomItemDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const { act, reasons, busy } = usePlay(id);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [qty, setQty] = useState("1");
  const [known, setKnown] = useState(false);
  const [weight, setWeight] = useState("");
  const count = Number.parseInt(qty, 10);
  const pounds = Number(weight.replace(",", "."));
  const nameOk = name.trim().length >= 1 && name.trim().length <= 120;
  const qtyOk = /^[1-9]\d*$/.test(qty.trim());
  const weightOk = !known || (weight.trim() !== "" && Number.isFinite(pounds) && pounds >= 0);
  const ready = nameOk && qtyOk && weightOk && description.length <= 4000;
  async function onAdd() {
    const r = await act({
      type: "add_custom_item",
      name: name.trim(),
      description,
      weight_lb: known ? pounds : null,
      qty: count,
    });
    if (r) onClose();
  }
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t("sheet.custom.title")}
      footer={
        <>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button
            variant="primary"
            icon="plus"
            disabled={!ready || busy}
            onClick={() => void onAdd()}
          >
            {t("sheet.custom.confirm")}
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm" data-testid="custom-item-form">
        <Reasons reasons={reasons} />
        {/* kenli F-013 T03: no catalog data, so no assessment — said, not faked. */}
        <p className="text-[13px] text-ink-muted">{t("sheet.custom.noAssessment")}</p>
        <div className="flex flex-col gap-1">
          <label className="flex flex-col gap-1">
            <span>{t("sheet.custom.name")}</span>
            <input
              className="field"
              value={name}
              maxLength={120}
              required
              aria-invalid={!nameOk}
              aria-describedby="custom-name-hint"
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          {!nameOk && (
            <span id="custom-name-hint" className="text-[13px] text-ink-muted">
              {t("sheet.custom.nameRequired")}
            </span>
          )}
        </div>
        <label className="flex flex-col gap-1">
          <span>{t("sheet.custom.description")}</span>
          <textarea
            className="field min-h-20"
            value={description}
            maxLength={4000}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span>{t("sheet.custom.qty")}</span>
          <input
            className="field w-24"
            inputMode="numeric"
            value={qty}
            aria-invalid={!qtyOk}
            onChange={(e) => setQty(e.target.value.replace(/[^0-9]/g, ""))}
          />
        </label>
        <fieldset className="space-y-1">
          <legend>{t("sheet.custom.weight")}</legend>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="custom-weight"
              checked={!known}
              onChange={() => setKnown(false)}
            />
            {t("sheet.custom.weightUnknownOption")}
          </label>
          <label className="flex flex-wrap items-center gap-2">
            <input
              type="radio"
              name="custom-weight"
              checked={known}
              onChange={() => setKnown(true)}
            />
            {t("sheet.custom.weightKnownOption")}
            <input
              className="field w-24"
              inputMode="decimal"
              aria-label={t("sheet.custom.weightLb")}
              disabled={!known}
              value={weight}
              aria-invalid={known && !weightOk}
              onChange={(e) => setWeight(e.target.value.replace(/[^0-9.,]/g, ""))}
            />
            <span>lb</span>
          </label>
        </fieldset>
      </div>
    </Dialog>
  );
}
