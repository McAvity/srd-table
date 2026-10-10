/**
 * Attacks (the sheet's attack lines, damage ready to roll), features used in turns, features to
 * switch on (Rage), limited uses and Hit Point Dice. Outside an encounter, rolls are free rolls of
 * the engine's dice; an encounter resolves attacks against a target. A feature that heals can also
 * be used by hand (`manual`: the uses are spent, the healing is left to the player), first when
 * the campaign plays characters by hand.
 */

import { useState } from "react";
import type { PlaySheet } from "srd-rules-engine";
import { Icon } from "@/components/Icon";
import { Button, Empty, Gems, Reasons, Section } from "@/components/ui";
import { signed, t } from "@/i18n";
import { rollDamage, rollTest } from "@/store/dice";
import { useDocuments } from "@/store/documents";
import { useSettings } from "@/store/settings";
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
  const name = useDocuments((s) => s.characters[id]?.build.name ?? "");
  if (!sheet.attacks.length) return null;
  return (
    <Section title={t("sheet.attacks")}>
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
                      iconOnly
                      label={`${a.name}: ${t("dice.attack")}`}
                      onClick={() => void rollTest(id, { attack: a.name })}
                    />
                    <Button
                      size="sm"
                      icon="flame"
                      iconOnly
                      label={`${a.name}: ${t("sheet.damageCol")}`}
                      onClick={() => void rollDamage(a.damage_parts, false, `${name} · ${a.name}`)}
                    />
                    <Button
                      size="sm"
                      icon="bolt"
                      iconOnly
                      label={`${a.name}: ${t("dice.critical")}`}
                      onClick={() => void rollDamage(a.damage_parts, true, `${name} · ${a.name}`)}
                    />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

function FeatureActions({ id, sheet }: { id: string; sheet: PlaySheet }) {
  const { act, reasons, busy } = usePlay(id);
  const [amounts, setAmounts] = useState<Record<string, string>>({});
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
              {(a.heal && byHandFirst ? [true, false] : a.heal ? [false, true] : [false]).map(
                (manual, i) => (
                  <Button
                    key={manual ? "manual" : "auto"}
                    size="sm"
                    variant={i === 0 ? "normal" : "ghost"}
                    icon={manual ? "check" : "bolt"}
                    title={manual ? t("sheet.useByHandHint") : undefined}
                    disabled={busy}
                    onClick={() =>
                      void act({
                        type: "use_feature",
                        key: a.key,
                        ...(a.pool && Number.isInteger(amount) && amount > 0 ? { amount } : {}),
                        ...(manual ? { manual: true } : {}),
                      })
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
