/**
 * The character's last roll, while it can still be changed (`useRolls`, closed by any change of
 * the character): Heroic Inspiration on one of its dice, Advantage given late with a luck-style
 * use, a Critical Hit the table decides. Each is one engine call and one commit (or none): the
 * roll's own cost (a slot, a use) is never paid again. The numbers come back from the engine.
 */

import type { AttackDice, PlaySheet, RolledDamage } from "srd-rules-engine";
import { Button, Section } from "@/components/ui";
import { t } from "@/i18n";
import { type HeroicTarget, useDocuments } from "@/store/documents";
import { openRoll, useRolls } from "@/store/rolls";
import { usePlayResult } from "./usePlay";

export function RollFollowUps({ id, sheet }: { id: string; sheet: PlaySheet }) {
  const record = useDocuments((s) => s.characters[id]);
  const last = openRoll(
    useRolls((s) => s.last[id]),
    record,
  );
  const { run, reasons, busy } = usePlayResult();
  const heroic = useDocuments((s) => s.heroicReroll);
  const lateAdvantage = useDocuments((s) => s.lateAdvantage);
  const setCritical = useDocuments((s) => s.setCritical);
  if (!last) return null;
  const inspired = sheet.play.heroic_inspiration;
  const lucky = sheet.play.uses.filter(
    (u) => u.spend_for?.includes("d20_advantage") && u.spent < u.max,
  );
  const reroll = (target: HeroicTarget) => run(() => heroic(id, target));
  const dieButtons = (
    values: readonly number[],
    target: (die: number) => HeroicTarget,
    what: string,
  ) =>
    values.map((v, die) => (
      <Button
        key={`${what}-${die}`}
        size="sm"
        variant="ghost"
        disabled={busy || !inspired}
        aria-label={t("followups.reroll", { what, value: v })}
        onClick={() => void reroll(target(die))}
      >
        {v}
      </Button>
    ));
  const damageButtons = (
    damage: RolledDamage | null,
    target: (part: number, die: number) => HeroicTarget,
  ) =>
    damage?.parts.flatMap((p, part) =>
      p.dice
        ? dieButtons(
            p.rolls,
            (die) => target(part, die),
            `${t("followups.damage")} ${p.dice} ${p.type}`,
          )
        : [],
    ) ?? [];
  const attackRow = (a: AttackDice, attack: number) => (
    <li key={attack} className="space-y-1 rounded border border-edge px-2 py-1.5">
      <div className="font-semibold">
        {a.attack}: {a.total}
        {a.critical_hit ? ` · ${t("dice.critical")}` : ""}
      </div>
      <div className="flex flex-wrap items-center gap-1">
        <span className="text-[13px] text-ink-muted">{t("followups.heroic")}:</span>
        {dieButtons(a.roll.rolls, (die) => ({ kind: "d20", die, attack }), "d20")}
        {a.bonus_dice.flatMap((g, group) =>
          dieButtons(g.rolls, (die) => ({ kind: "bonus_die", group, die, attack }), g.label),
        )}
        {damageButtons(a.damage, (part, die) => ({ kind: "damage", part, die, attack }))}
      </div>
      <div className="flex flex-wrap gap-1">
        {lucky.map((u) => (
          <Button
            key={u.key}
            size="sm"
            disabled={busy}
            onClick={() => void run(() => lateAdvantage(id, u.key, attack))}
          >
            {t("followups.lateAdvantage", { use: u.name })}
          </Button>
        ))}
        <Button
          size="sm"
          disabled={busy || !a.damage}
          on={a.critical_hit}
          onClick={() => void run(() => setCritical(id, attack, !a.critical_hit))}
        >
          {a.critical_hit ? t("followups.notCritical") : t("followups.critical")}
        </Button>
      </div>
    </li>
  );
  return (
    <Section title={t("followups.title")}>
      {!inspired && (
        <p className="mb-1 text-[13px] text-ink-muted">{t("followups.noInspiration")}</p>
      )}
      {reasons && (
        <ul className="mb-1 text-sm text-red">
          {reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}
      {last.kind === "test" && (
        <div className="space-y-1">
          <div className="font-semibold">
            {last.test.label}: {last.test.total}
          </div>
          <div className="flex flex-wrap items-center gap-1">
            <span className="text-[13px] text-ink-muted">{t("followups.heroic")}:</span>
            {dieButtons(last.test.roll.rolls, (die) => ({ kind: "d20", die }), "d20")}
            {last.test.bonus_dice.flatMap((g, group) =>
              dieButtons(g.rolls, (die) => ({ kind: "bonus_die", group, die }), g.label),
            )}
          </div>
          <div className="flex flex-wrap gap-1">
            {lucky.map((u) => (
              <Button
                key={u.key}
                size="sm"
                disabled={busy}
                onClick={() => void run(() => lateAdvantage(id, u.key))}
              >
                {t("followups.lateAdvantage", { use: u.name })}
              </Button>
            ))}
          </div>
        </div>
      )}
      {last.kind === "sheet" && (
        <ul className="space-y-1.5">
          <li className="font-semibold">{last.roll.name}</li>
          {last.roll.rolls.attacks.map(attackRow)}
          {last.roll.rolls.damage && (
            <li className="flex flex-wrap items-center gap-1">
              <span className="text-[13px] text-ink-muted">{t("followups.heroic")}:</span>
              {damageButtons(last.roll.rolls.damage, (part, die) => ({
                kind: "damage",
                part,
                die,
              }))}
            </li>
          )}
          {last.roll.rolls.die && (
            <li className="flex flex-wrap items-center gap-1">
              <span className="text-[13px] text-ink-muted">{t("followups.heroic")}:</span>
              {dieButtons(
                last.roll.rolls.die.rolls,
                (die) => ({ kind: "feature_die", die }),
                last.roll.rolls.die.dice_expression,
              )}
            </li>
          )}
        </ul>
      )}
      {last.kind === "damage" && (
        <div className="space-y-1">
          <div className="font-semibold">
            {last.label}: {last.damage.total}
          </div>
          <div className="flex flex-wrap items-center gap-1">
            <span className="text-[13px] text-ink-muted">{t("followups.heroic")}:</span>
            {damageButtons(last.damage, (part, die) => ({ kind: "damage", part, die }))}
          </div>
        </div>
      )}
      {last.kind === "death_save" && (
        <div className="flex flex-wrap items-center gap-2">
          <span>{t("followups.deathSave", { value: last.die.total })}</span>
          <Button
            size="sm"
            disabled={busy || !inspired}
            onClick={() => void reroll({ kind: "death_save" })}
          >
            {t("followups.rerollDeathSave")}
          </Button>
        </div>
      )}
    </Section>
  );
}
