/**
 * The character's last roll, while it can still be changed (`useRolls`, closed by any change of
 * the character): Heroic Inspiration on one of its dice, Advantage given late with a luck-style
 * use, a Critical Hit the table decides, a feature for a failed check or attack (Peerless Skill:
 * `after_failed_roll`). Each is one engine call and one commit (or none): the roll's own cost (a
 * slot, a use) is never paid again. The numbers and the outcome come back from the engine.
 */

import { useId, useState } from "react";
import type { AttackDice, PlaySheet, RolledDamage } from "srd-rules-engine";

type CastOptionLine = PlaySheet["cast_options"][number];

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
  const afterFailed = useDocuments((s) => s.afterFailedRoll);
  const empower = useDocuments((s) => s.empoweredSpell);
  if (!last) return null;
  // kenli F-002 T12 B2b: Empowered Spell on a spell's damage (the sheet's typed cast option).
  const empowered = sheet.cast_options.find((o) => o.effect === "empowered");
  const inspired = sheet.play.heroic_inspiration;
  // kenli F-011 §5.3: a luck-style use with none left, or a reroll without Heroic Inspiration, is
  // still the player's attempt: the engine refuses it and the refusal is journaled (it follows the
  // roll). The reason is said next to it; nothing is spent or rolled.
  const lucky = sheet.play.uses.filter((u) => u.spend_for?.includes("d20_advantage"));
  const reroll = (target: HeroicTarget, what: string) =>
    run(() => heroic(id, target, { command: "heroic_reroll", label: what }));
  const luckyLabel = (u: (typeof lucky)[number]) =>
    `${t("followups.lateAdvantage", { use: u.name })}${u.spent >= u.max ? ` · ${t("common.left", { left: 0, total: u.max })}` : ""}`;
  // kenli F-002 T12 (review14 R14-01): the sheet's actions for a failed check or attack roll.
  const afterLines = (kind: "check" | "attack") =>
    sheet.actions.filter((a) => a.after_failed_roll?.kinds.includes(kind) && a.uses && a.roll_die);
  const afterFailedFor = (kind: "check" | "attack", knownDc: number | null, attack?: number) =>
    afterLines(kind).map((a) => (
      <AfterFailedRoll
        key={a.key}
        name={a.name}
        die={a.roll_die ?? ""}
        needsDc={knownDc === null}
        busy={busy}
        onUse={(dc) =>
          run(() =>
            afterFailed(id, a.key, a.uses ?? "", attack, dc, {
              command: "late_advantage",
              label: a.name,
            }),
          )
        }
      />
    ));
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
        disabled={busy}
        aria-label={t("followups.reroll", { what, value: v })}
        onClick={() => void reroll(target(die), t("followups.reroll", { what, value: v }))}
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
            onClick={() =>
              void run(() =>
                lateAdvantage(id, u.key, attack, { command: "late_advantage", label: u.name }),
              )
            }
          >
            {luckyLabel(u)}
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
      {afterFailedFor("attack", null, attack)}
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
                onClick={() =>
                  void run(() =>
                    lateAdvantage(id, u.key, undefined, {
                      command: "late_advantage",
                      label: u.name,
                    }),
                  )
                }
              >
                {luckyLabel(u)}
              </Button>
            ))}
          </div>
          {(last.test.kind === "check" || last.test.kind === "attack") &&
            last.test.success !== true &&
            afterFailedFor(last.test.kind, last.test.dc)}
        </div>
      )}
      {last.kind === "sheet" && last.what.type === "cast" && empowered && (
        <EmpoweredSpell
          option={empowered}
          use={sheet.play.uses.find((u) => u.key === empowered.uses)?.name ?? empowered.uses}
          damages={
            last.roll.rolls.attacks.length
              ? last.roll.rolls.attacks.map((a) => a.damage ?? null)
              : [last.roll.rolls.damage ?? null]
          }
          busy={busy}
          onUse={(roll, dice) =>
            run(() => empower(id, roll, dice, { command: "late_advantage", label: empowered.name }))
          }
        />
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
            disabled={busy}
            onClick={() => void reroll({ kind: "death_save" }, t("followups.rerollDeathSave"))}
          >
            {t("followups.rerollDeathSave")}
          </Button>
        </div>
      )}
    </Section>
  );
}

/**
 * One `after_failed_roll` feature on the last roll: its button, and the DC or AC the table
 * declares when the roll has none (a roll by hand, a check without a DC). The engine refuses it on
 * a roll that didn't fail and says whether the die turned it into a success.
 */
function AfterFailedRoll({
  name,
  die,
  needsDc,
  busy,
  onUse,
}: {
  name: string;
  die: string;
  needsDc: boolean;
  busy: boolean;
  onUse: (dc: number | undefined) => unknown;
}) {
  const [text, setText] = useState("");
  const inputId = useId();
  const n = Number(text);
  const dc = text.trim() && Number.isInteger(n) ? n : undefined;
  return (
    <div className="flex flex-wrap items-center gap-1" data-testid="after-failed-roll">
      {needsDc && (
        <>
          <label htmlFor={inputId} className="text-[13px] text-ink-muted">
            {t("followups.declaredDc")}
          </label>
          <input
            id={inputId}
            className="input w-16"
            type="number"
            min={1}
            value={text}
            onChange={(ev) => setText(ev.currentTarget.value)}
            data-testid="after-failed-roll-dc"
          />
        </>
      )}
      <Button size="sm" disabled={busy} onClick={() => void onUse(needsDc ? dc : undefined)}>
        {t("followups.afterFailedRoll", { name, die })}
      </Button>
    </div>
  );
}

/**
 * kenli F-002 T12 B2b: Empowered Spell on the last spell rolled by hand — tick up to its dice of
 * one damage roll and reroll them (the engine checks the count, the dice and the Sorcery Point; the
 * new rolls are kept). Not using it is just leaving it: nothing is spent.
 */
function EmpoweredSpell({
  option,
  use,
  damages,
  busy,
  onUse,
}: {
  option: CastOptionLine;
  use: string;
  damages: readonly (RolledDamage | null)[];
  busy: boolean;
  onUse: (roll: number, dice: { part: number; die: number }[]) => unknown;
}) {
  const [picked, setPicked] = useState<{ roll: number; part: number; die: number }[]>([]);
  const used = damages.find((d) => d?.rerolled?.source === option.key)?.rerolled;
  const max = option.reroll_dice ?? 1;
  if (!damages.some((d) => d?.parts.some((p) => p.dice))) return null;
  const roll = picked[0]?.roll ?? null;
  const toggle = (r: number, part: number, die: number, on: boolean) =>
    setPicked((now) => {
      // One damage roll at a time: ticking a die of another roll starts again there.
      const same = now.filter((x) => x.roll === r);
      return on
        ? [...same, { roll: r, part, die }]
        : same.filter((x) => !(x.part === part && x.die === die));
    });
  return (
    <div
      className="mb-2 space-y-1 rounded border border-edge px-2 py-1.5"
      data-testid="empowered-spell"
    >
      <div className="font-semibold">
        {t("followups.empowered", { name: option.name, max, cost: option.cost, use })}
      </div>
      {used ? (
        <p className="text-sm" data-testid="empowered-used">
          {t("followups.empoweredUsed", {
            name: used.label,
            dice: used.dice.map((d) => `${d.from} → ${d.to}`).join(", "),
          })}
        </p>
      ) : (
        <>
          {damages.map((d, r) =>
            d ? (
              <div key={`roll-${r}`} className="flex flex-wrap items-center gap-2">
                {damages.length > 1 && (
                  <span className="text-[13px] text-ink-muted">
                    {t("followups.empoweredRoll", { n: r + 1, total: d.total })}
                  </span>
                )}
                {d.parts.flatMap((p, part) =>
                  p.dice
                    ? p.rolls.map((v, die) => {
                        const on = picked.some(
                          (x) => x.roll === r && x.part === part && x.die === die,
                        );
                        return (
                          <label
                            key={`d-${r}-${part}-${die}`}
                            className="flex items-center gap-1 text-sm"
                            data-testid="empowered-die"
                          >
                            <input
                              type="checkbox"
                              checked={on}
                              disabled={busy}
                              onChange={(e) => toggle(r, part, die, e.target.checked)}
                            />
                            {t("followups.empoweredDie", {
                              value: v,
                              dice: p.dice ?? "",
                              type: p.type,
                            })}
                          </label>
                        );
                      })
                    : [],
                )}
              </div>
            ) : null,
          )}
          <Button
            size="sm"
            variant="primary"
            disabled={busy || roll === null}
            onClick={() =>
              roll !== null &&
              void onUse(
                roll,
                picked.map(({ part, die }) => ({ part, die })),
              )
            }
          >
            {t("followups.empoweredDo", { count: picked.length, cost: option.cost, use })}
          </Button>
        </>
      )}
    </div>
  );
}
