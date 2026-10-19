/**
 * Attacks (the sheet's attack lines, damage ready to roll), features used in turns, features to
 * switch on (Rage), limited uses and Hit Point Dice. Outside an encounter, rolls are free rolls of
 * the engine's dice; an encounter resolves attacks against a target. "Roll" rolls an attack by hand
 * (`rollByHand`: the attack roll and its damage, a Critical Hit's dice doubled). A feature that
 * heals or forces a save can also be rolled by hand (its dice rolled, its uses spent, nothing
 * applied), first when the campaign plays characters by hand.
 */

import { useState } from "react";
import type { PlaySheet, RollWhat } from "srd-rules-engine";
import { Icon } from "@/components/Icon";
import { Button, Empty, Gems, Reasons, Section } from "@/components/ui";
import { signed, t } from "@/i18n";
import { useDocuments } from "@/store/documents";
import { attackDm, declaredLucky, useRollAdditions } from "@/store/rolls";
import { useSettings } from "@/store/settings";
import { useRoller } from "./OverviewTab";
import { usePlay } from "./usePlay";

export function CombatTab({ id, sheet }: { id: string; sheet: PlaySheet }) {
  return (
    <div className="space-y-4">
      <Attacks id={id} sheet={sheet} />
      <div className="grid gap-4 xl:grid-cols-2">
        <FeatureActions id={id} sheet={sheet} />
        <Toggles id={id} sheet={sheet} />
        <Uses id={id} sheet={sheet} />
        <Section title={t("sheet.hitDice")}>
          <ul className="space-y-1.5">
            {sheet.play.hit_dice.map((d) => (
              <li key={d.die} className="flex items-center gap-3">
                <span className="w-10 font-semibold">d{d.die}</span>
                <Gems total={d.total} spent={d.spent} label={`d${d.die}`} />
              </li>
            ))}
          </ul>
        </Section>
      </div>
    </div>
  );
}

function Attacks({ id, sheet }: { id: string; sheet: PlaySheet }) {
  const rollDamage = useDocuments((s) => s.rollDamage);
  const { roll, reasons, busy } = usePlay(id);
  const additions = useRollAdditions((s) => s.by[id]);
  const test = useRoller(id, sheet);
  if (!sheet.attacks.length) return null;
  return (
    <Section title={t("sheet.attacks")}>
      <Reasons reasons={reasons} className="mb-2" />
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="text-[13px] font-bold text-ink-muted">
              <th className="py-1 pr-2 font-normal">{t("sheet.attacks")}</th>
              <th className="py-1 pr-2 font-normal">{t("sheet.attackBonus")}</th>
              <th className="py-1 pr-2 font-normal">{t("sheet.damageCol")}</th>
              <th className="py-1 font-normal" />
            </tr>
          </thead>
          <tbody>
            {sheet.attacks.map((a) => (
              <tr key={a.name} className="border-t border-edge align-top">
                <th scope="row" className="py-2 pr-2">
                  <span className="font-semibold">{a.name}</span>
                  <span className="block text-[13px] font-normal text-ink-muted">
                    {[
                      a.kind === "melee" && a.reach ? `${a.reach} ft` : null,
                      ...a.properties,
                      a.mastery,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                  {a.notes.map((n) => (
                    <span key={n} className="block text-[13px] font-normal text-ink-faint">
                      {n}
                    </span>
                  ))}
                  {a.riders.length > 0 && (
                    <span className="block text-[13px] font-normal text-ink-muted">
                      {t("sheet.riders", { riders: a.riders.map((r) => r.name).join(", ") })}
                    </span>
                  )}
                </th>
                <td className="py-2 pr-2 font-semibold tabular-nums">{signed(a.attack_bonus)}</td>
                <td className="py-2 pr-2">
                  {a.damage} {a.damage_type}
                </td>
                <td className="py-2">
                  <div className="flex justify-end gap-1">
                    <Button
                      size="sm"
                      icon="d20"
                      title={t("sheet.rollAttackHint")}
                      disabled={busy}
                      onClick={() =>
                        void roll(
                          { type: "attack", attack: a.name, ...attackDm(additions) } as RollWhat,
                          declaredLucky(additions, sheet),
                        )
                      }
                    >
                      {t("sheet.rollByHand")}
                    </Button>
                    <Button
                      size="sm"
                      icon="d20"
                      iconOnly
                      label={`${a.name}: ${t("dice.attack")}`}
                      onClick={() => test({ attack: a.name })}
                    />
                    <Button
                      size="sm"
                      icon="flame"
                      iconOnly
                      label={`${a.name}: ${t("sheet.damageCol")}`}
                      onClick={() => void rollDamage(id, a.damage_parts, false, a.name)}
                    />
                    <Button
                      size="sm"
                      icon="bolt"
                      iconOnly
                      label={`${a.name}: ${t("dice.critical")}`}
                      onClick={() => void rollDamage(id, a.damage_parts, true, a.name)}
                    />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
        <span className="text-ink-muted">{t("sheet.unarmedOptions")}</span>
        {(["grapple", "shove"] as const).map((option) => (
          <Button
            key={option}
            size="sm"
            icon="d20"
            disabled={busy}
            onClick={() => void roll({ type: "unarmed", option })}
          >
            {t(option === "grapple" ? "sheet.grapple" : "sheet.shove")}
          </Button>
        ))}
      </div>
    </Section>
  );
}

function FeatureActions({ id, sheet }: { id: string; sheet: PlaySheet }) {
  const { act, roll, reasons, busy } = usePlay(id);
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  // A spell slot paying for a feature (`slot_payment`): its level, or "" for its use.
  const [slots, setSlots] = useState<Record<string, string>>({});
  const levels = sheet.play.spell_slots.filter((s) => s.total > 0);
  const byHandFirst = useSettings((s) => s.settings.character_play === "manual");
  if (!sheet.actions.length) return null;
  const uses = new Map(sheet.play.uses.map((u) => [u.key, u]));
  return (
    <Section title={t("sheet.actions")}>
      <Reasons reasons={reasons} className="mb-2" />
      <ul className="space-y-1.5">
        {sheet.actions.map((a) => {
          const use = a.uses ? uses.get(a.uses) : undefined;
          const amount = Number.parseInt(amounts[a.key] ?? "", 10);
          const amountSet = a.pool && Number.isInteger(amount) && amount > 0 ? { amount } : {};
          const picked =
            slots[a.key] ??
            (a.slot_payment === "required"
              ? String(levels.find((l) => l.spent < l.total)?.level ?? "")
              : "");
          const payment = picked
            ? { payment: { type: "slot" as const, level: Number(picked) } }
            : {};
          const paid = { ...amountSet, ...payment };
          // Dice to roll by hand: its healing, or the damage and DC of the save it forces.
          const rollable = a.heal !== null || a.save !== null || Boolean(a.roll_die);
          return (
            <li
              key={a.key}
              className="flex flex-wrap items-center gap-2 rounded border border-edge px-2 py-1.5"
            >
              <span className="flex-1">
                <span className="font-semibold">{a.name}</span>
                <span className="block text-[13px] text-ink-muted">
                  {t(`table.cost.${a.economy}`)}
                  {use && ` · ${t("common.left", { left: use.max - use.spent, total: use.max })}`}
                </span>
              </span>
              {a.slot_payment && (
                <select
                  className="field w-auto py-1 text-sm"
                  aria-label={t("sheet.payWithSlot", { feature: a.name })}
                  value={picked}
                  onChange={(e) => setSlots({ ...slots, [a.key]: e.target.value })}
                >
                  {a.slot_payment === "instead" && (
                    <option value="">{t("sheet.payWithUse")}</option>
                  )}
                  {levels.map((l) => (
                    <option key={l.level} value={String(l.level)} disabled={l.spent >= l.total}>
                      {t("sheet.slotLevel", { level: l.level })} ·{" "}
                      {t("common.left", { left: l.total - l.spent, total: l.total })}
                    </option>
                  ))}
                </select>
              )}
              {a.roll_die && <span className="text-[13px] text-ink-muted">{a.roll_die}</span>}
              {a.pool && (
                <input
                  className="field w-20"
                  inputMode="numeric"
                  aria-label={`${a.name}: ${t("sheet.amount")}`}
                  placeholder={t("sheet.amount")}
                  value={amounts[a.key] ?? ""}
                  onChange={(e) =>
                    setAmounts({ ...amounts, [a.key]: e.target.value.replace(/[^0-9]/g, "") })
                  }
                />
              )}
              {(rollable && byHandFirst ? [true, false] : rollable ? [false, true] : [false]).map(
                (manual, i) => (
                  <Button
                    key={manual ? "manual" : "auto"}
                    size="sm"
                    variant={i === 0 ? "normal" : "ghost"}
                    icon={manual ? "check" : "bolt"}
                    title={manual ? t("sheet.useByHandHint") : undefined}
                    disabled={busy}
                    onClick={() =>
                      void (manual
                        ? roll({ type: "feature", feature: a.key, ...paid })
                        : act({ type: "use_feature", key: a.key, ...paid }))
                    }
                  >
                    {manual ? t("table.wayManual") : t("sheet.useFeature")}
                  </Button>
                ),
              )}
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

function Toggles({ id, sheet }: { id: string; sheet: PlaySheet }) {
  const { act, reasons, busy } = usePlay(id);
  if (!sheet.toggles.length) return null;
  return (
    <Section title={t("sheet.toggles")}>
      <Reasons reasons={reasons} className="mb-2" />
      <ul className="space-y-1.5">
        {sheet.toggles.map((tg) => (
          <li
            key={tg.key}
            className="flex items-center gap-2 rounded border border-edge px-2 py-1.5"
          >
            <span className="flex-1">
              <span className="font-semibold">{tg.name}</span>
              {tg.blocked && (
                <span className="block text-[13px] text-ink-muted italic">{tg.blocked}</span>
              )}
            </span>
            <Button
              size="sm"
              icon={tg.active ? "check" : "flame"}
              on={tg.active}
              aria-pressed={tg.active}
              disabled={busy}
              onClick={() => void act({ type: tg.active ? "deactivate" : "activate", key: tg.key })}
            >
              {tg.active ? t("sheet.on") : t("sheet.off")}
            </Button>
          </li>
        ))}
      </ul>
    </Section>
  );
}

function Uses({ id, sheet }: { id: string; sheet: PlaySheet }) {
  const { act, reasons } = usePlay(id);
  if (!sheet.play.uses.length) return null;
  return (
    <Section title={t("sheet.uses")}>
      <Reasons reasons={reasons} className="mb-2" />
      <ul className="space-y-2">
        {sheet.play.uses.map((u) => (
          <li key={u.key}>
            <div className="flex items-baseline gap-2">
              <span className="font-semibold">{u.name}</span>
              <span className="text-[13px] text-ink-muted">
                {t(`sheet.recharge.${u.recharge}`)}
              </span>
            </div>
            {u.max <= 12 ? (
              <Gems
                total={u.max}
                spent={u.spent}
                label={u.name}
                onSpend={() => void act({ type: "use", key: u.key })}
                onRestore={() => void act({ type: "restore_use", key: u.key })}
              />
            ) : (
              <div className="flex items-center gap-2">
                <Icon name="heart" size={16} className="text-ink-muted" />
                <span className="tabular-nums">
                  {t("common.left", { left: u.max - u.spent, total: u.max })}
                </span>
                <span className="ml-auto flex gap-1">
                  <Button
                    size="sm"
                    icon="minus"
                    iconOnly
                    label={t("common.spendOne", { what: u.name })}
                    onClick={() => void act({ type: "use", key: u.key })}
                  />
                  <Button
                    size="sm"
                    icon="plus"
                    iconOnly
                    label={t("common.restoreOne", { what: u.name })}
                    onClick={() => void act({ type: "restore_use", key: u.key })}
                  />
                </span>
              </div>
            )}
          </li>
        ))}
      </ul>
      {sheet.play.uses.length === 0 && <Empty>{t("common.none")}</Empty>}
    </Section>
  );
}
