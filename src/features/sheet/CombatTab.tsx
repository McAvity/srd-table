/**
 * Attacks (the sheet's attack lines, damage ready to roll), features used in turns, features to
 * switch on (Rage), limited uses and Hit Point Dice. Outside an encounter, rolls are free rolls of
 * the engine's dice; an encounter resolves attacks against a target. "Roll" rolls an attack by hand
 * (`rollByHand`: the attack roll and its damage, a Critical Hit's dice doubled). A feature that
 * heals or forces a save can also be rolled by hand (its dice rolled, its uses spent, nothing
 * applied), first when the campaign plays characters by hand.
 *
 * kenli F-002 T08 (review04 C11): a feature with its own die (a maneuver: Bait and Switch,
 * Precision Attack…) is used only by rolling it — its die rolled and shown, its cost paid once —
 * never by a "use" that spends the die and rolls nothing. An attack can be rolled with the riders
 * the engine lists for it (Lunging Attack's die in the damage, a maneuver's cost once).
 */

import { useState } from "react";
import type { FeatDef, PlaySheet, RollWhat } from "srd-rules-engine";
import { Icon } from "@/components/Icon";
import { SrdText } from "@/components/SrdText";
import { Button, Empty, Gems, Reasons, Section } from "@/components/ui";
import { signed, t } from "@/i18n";
import { useTable } from "@/queries";
import { useDocuments } from "@/store/documents";
import { attackDm, declaredLucky, openRoll, useRollAdditions, useRolls } from "@/store/rolls";
import { useSettings } from "@/store/settings";
import { RollButton, useRoller } from "./OverviewTab";
import { luckySelectId } from "./RollOptions";
import { usePlay } from "./usePlay";

export function CombatTab({ id, sheet }: { id: string; sheet: PlaySheet }) {
  const roll = useRoller(id, sheet);
  return (
    <div className="space-y-4">
      {/* kenli F-011 T06 (AC-11): Initiative is rolled from Combat only — the same request as
          before (a roll of this character, nothing else); it starts no encounter. */}
      <Section title={t("summary.initiative")}>
        <p className="flex items-center gap-2" data-testid="combat-initiative">
          <span className="font-semibold">{t("summary.initiative")}</span>
          <RollButton
            label={t("summary.initiative")}
            bonus={sheet.initiative.total}
            request={{ initiative: true }}
            onRoll={roll}
          />
        </p>
      </Section>
      <Attacks id={id} sheet={sheet} />
      <div className="grid gap-4 @min-[1180px]:grid-cols-2">
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
  /** The open roll of this attack line, whose follow-up this damage is (kenli F-006 C04). */
  const follows = (name: string) => {
    const last = openRoll(useRolls.getState().last[id], useDocuments.getState().characters[id]);
    const same =
      last?.kind === "test"
        ? last.test.attack === name
        : last?.kind === "sheet"
          ? last.roll.name === name
          : false;
    return same ? last?.op : undefined;
  };
  const { roll, reasons, busy } = usePlay(id);
  const additions = useRollAdditions((s) => s.by[id]);
  /**
   * Riders picked per attack line (its engine ids), sent with its roll. Scoped to this character
   * (the sheet isn't remounted when another one opens) and read through the riders the line
   * offers now (kenli F-002 T08: a pick kept from another character, or one the line no longer
   * offers after an Undo, was sent and refused a legal attack).
   */
  const [pickedBy, setPickedBy] = useState<{
    id: string;
    lines: Record<string, readonly string[]>;
  }>({ id, lines: {} });
  const lines = pickedBy.id === id ? pickedBy.lines : {};
  const pickedFor = (a: (typeof sheet.attacks)[number]) =>
    (lines[a.name] ?? []).filter((r) => a.riders.some((x) => x.id === r));
  const setPicked = (next: Record<string, readonly string[]>) => setPickedBy({ id, lines: next });
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
                    <fieldset
                      className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[13px] font-normal"
                      data-testid={`attack-riders-${a.name}`}
                    >
                      <legend className="sr-only">
                        {t("sheet.ridersPick", { attack: a.name })}
                      </legend>
                      {a.riders.map((r) => (
                        <label key={r.id} className="inline-flex items-center gap-1">
                          <input
                            type="checkbox"
                            checked={pickedFor(a).includes(r.id)}
                            onChange={(e) =>
                              setPicked({
                                ...lines,
                                [a.name]: e.target.checked
                                  ? [...pickedFor(a), r.id]
                                  : pickedFor(a).filter((x) => x !== r.id),
                              })
                            }
                          />
                          {r.name}
                        </label>
                      ))}
                    </fieldset>
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
                          {
                            type: "attack",
                            attack: a.name,
                            ...(pickedFor(a).length
                              ? { riders: pickedFor(a).map((rider) => ({ rider })) }
                              : {}),
                            ...attackDm(additions),
                          } as RollWhat,
                          declaredLucky(additions, sheet),
                          { command: "sheet_attack", label: a.name },
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
                      onClick={() =>
                        void rollDamage(id, a.damage_parts, false, a.name, follows(a.name))
                      }
                    />
                    <Button
                      size="sm"
                      icon="bolt"
                      iconOnly
                      label={`${a.name}: ${t("dice.critical")}`}
                      onClick={() =>
                        void rollDamage(id, a.damage_parts, true, a.name, follows(a.name))
                      }
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
            onClick={() =>
              void roll({ type: "unarmed", option }, undefined, {
                command: "sheet_attack",
                label: t(option === "grapple" ? "sheet.grapple" : "sheet.shove"),
              })
            }
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
          // C11: its own die and nothing else to apply — only rolled (die shown, cost once).
          const dieOnly = Boolean(a.roll_die) && a.heal === null && a.save === null;
          return (
            <li
              key={a.key}
              className="flex flex-wrap items-center gap-2 rounded border border-edge px-2 py-1.5"
            >
              <span className="flex-1">
                <span className="font-semibold">{a.name}</span>
                <span className="block text-[13px] text-ink-muted">
                  {t(`table.cost.${a.economy}`)}
                </span>
                {/* kenli F-011 T06 (AC-12): the use pool it spends, as the same crossed squares as
                    in Limited Uses (one pool, read here, never a second counter). */}
                {use && use.max <= 12 && (
                  <span className="mt-0.5 block" data-testid={`action-pool-${a.key}`}>
                    <Gems total={use.max} spent={use.spent} label={use.name} />
                  </span>
                )}
                {use && use.max > 12 && (
                  <span className="block text-[13px] text-ink-muted tabular-nums">
                    {use.name}: {t("common.left", { left: use.max - use.spent, total: use.max })}
                  </span>
                )}
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
              {(dieOnly
                ? [true]
                : rollable && byHandFirst
                  ? [true, false]
                  : rollable
                    ? [false, true]
                    : [false]
              ).map((manual, i) => (
                <Button
                  key={manual ? "manual" : "auto"}
                  size="sm"
                  variant={i === 0 ? "normal" : "ghost"}
                  icon={manual ? "check" : "bolt"}
                  title={manual ? t("sheet.useByHandHint") : undefined}
                  disabled={busy}
                  onClick={() =>
                    void (manual
                      ? roll({ type: "feature", feature: a.key, ...paid }, undefined, {
                          command: "sheet_use_feature",
                          label: a.name,
                        })
                      : act({ type: "use_feature", key: a.key, ...paid }, undefined, undefined, {
                          command: "sheet_use_feature",
                          label: a.name,
                        }))
                  }
                >
                  {dieOnly
                    ? t("sheet.useAndRoll", { die: a.roll_die ?? "" })
                    : manual
                      ? t("table.wayManual")
                      : t("sheet.useFeature")}
                </Button>
              ))}
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
              onClick={() =>
                void (tg.active
                  ? act({ type: "deactivate", key: tg.key })
                  : act({ type: "activate", key: tg.key }, undefined, undefined, {
                      command: "sheet_activate",
                      label: tg.name,
                    }))
              }
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
  const [info, setInfo] = useState<string | null>(null);
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
              <UseInfoButton
                use={u}
                open={info === u.key}
                onToggle={() => setInfo(info === u.key ? null : u.key)}
              />
            </div>
            {info === u.key && <UseInfo id={id} sheet={sheet} use={u} />}
            {u.max <= 12 ? (
              <Gems
                total={u.max}
                spent={u.spent}
                label={u.name}
                onSpend={() =>
                  void act({ type: "use", key: u.key }, undefined, undefined, {
                    command: "sheet_use",
                    label: u.name,
                  })
                }
                onRestore={() => void act({ type: "restore_use", key: u.key })}
                spendWhenEmpty
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
                    onClick={() =>
                      void act({ type: "use", key: u.key }, undefined, undefined, {
                        command: "sheet_use",
                        label: u.name,
                      })
                    }
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

type PlayUse = PlaySheet["play"]["uses"][number];
const norm = (s: string) => s.trim().toLowerCase();
const infoId = (key: string) => `use-info-${key.replace(/[^a-zA-Z0-9_-]/g, "-")}`;

function UseInfoButton({
  use,
  open,
  onToggle,
}: {
  use: PlayUse;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className="btn !min-h-0 !px-1.5 !py-0.5"
      aria-expanded={open}
      aria-controls={infoId(use.key)}
      aria-label={t("sheet.useInfo.button", { use: use.name })}
      title={t("sheet.useInfo.button", { use: use.name })}
      onClick={onToggle}
    >
      <Icon name="info" size={16} />
    </button>
  );
}

/**
 * kenli F-011 T06 (AC-14): what a limited use is, read only — nothing is spent. Its text is the
 * character's own feature or trait of that name (its source shown); without one, that is said,
 * never made up. Then when it comes back (the engine's recharge), and for a luck-style use how the
 * existing roll options take it: chosen for the next roll (focus goes there; nothing is picked or
 * spent here), or on the last roll from its follow-ups.
 */
export function UseInfo({ id, sheet, use }: { id: string; sheet: PlaySheet; use: PlayUse }) {
  const trait = sheet.traits.find((x) => norm(x.name) === norm(use.name));
  // A feat's use (`feat:<id>@…`, Magic Initiate's free cast): that feat's text in this character's
  // own content (its packs), when no trait of the use's name says it.
  const featId = trait ? null : (/^feat:([^@:]+)/.exec(use.key)?.[1] ?? null);
  const { data: feats } = useTable<FeatDef>("feats", { character: id });
  const feat = featId ? feats?.find((f) => f.id === featId) : undefined;
  const text = trait?.text ?? (feat?.description || null);
  const from = trait?.source ?? feat?.name ?? null;
  const line = sheet.limited_uses.find((l) => l.key === use.key);
  const regain = line?.short_rest_regain ?? null;
  const advantage = use.spend_for?.includes("d20_advantage") ?? false;
  const disadvantage = use.spend_for?.includes("impose_disadvantage") ?? false;
  return (
    <div
      id={infoId(use.key)}
      className="mt-1 space-y-1 rounded border border-edge bg-card-2 p-2 text-sm"
      data-testid="use-info"
    >
      {text ? (
        <>
          <SrdText text={text} />
          {from && (
            <p className="text-[13px] text-ink-muted">
              {t("sheet.useInfo.source", { source: from })}
            </p>
          )}
        </>
      ) : (
        <p className="text-ink-muted italic">{t("sheet.useInfo.noText")}</p>
      )}
      <p>
        {t("sheet.useInfo.uses", { total: use.max })} {t(`sheet.useInfo.recharge.${use.recharge}`)}
        {regain !== null && regain > 0
          ? ` ${t("sheet.useInfo.shortRegain", { count: regain })}`
          : ""}
      </p>
      {advantage && (
        <div className="space-y-1">
          <p>{t("sheet.useInfo.luckyHow")}</p>
          <Button
            size="sm"
            icon="d20"
            onClick={() => {
              const select = document.getElementById(luckySelectId(id));
              select?.scrollIntoView({ block: "center" });
              select?.focus();
            }}
          >
            {t("sheet.useInfo.luckyGo")}
          </Button>
        </div>
      )}
      {disadvantage && <p>{t("sheet.useInfo.disadvantageHow")}</p>}
    </div>
  );
}
