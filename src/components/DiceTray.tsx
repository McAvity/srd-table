/**
 * Dice results on screen for a few seconds: the numbers the engine already rolled (the UI never
 * rolls). A stub for 3D dice: a renderer that animates `DiceShown` items can replace
 * `DiceCard` without touching anything else.
 */

import { type ReactNode, useEffect } from "react";
import type {
  AttackResult,
  CheckResult,
  D20Roll,
  D20TestResult,
  DeclaredResult,
  RolledDamage,
  RollResult,
  SaveResult,
} from "srd-rules-engine";
import { abilityName } from "@/engine/constants";
import type { RolledResult } from "@/engine/facade";
import { signed, t } from "@/i18n";
import { type DiceShown, useUi } from "@/store/ui";
import { Icon } from "./Icon";
import { Button, cx } from "./ui";

const SHOW_MS = 7000;

export function DiceTray() {
  const dice = useUi((s) => s.dice);
  return (
    <section
      aria-label={t("dice.tray")}
      aria-live="polite"
      className="pointer-events-none fixed right-4 bottom-4 z-40 flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2"
    >
      {dice.map((d) => (
        <DiceCard key={d.id} item={d} />
      ))}
    </section>
  );
}

function DiceCard({ item }: { item: DiceShown }) {
  const dismiss = useUi((s) => s.dismissDice);
  useEffect(() => {
    const timer = setTimeout(() => dismiss(item.id), SHOW_MS);
    return () => clearTimeout(timer);
  }, [dismiss, item.id]);
  return (
    <div className="panel rise-in pointer-events-auto border-edge-strong p-3 shadow-panel">
      <div className="mb-1 flex items-center gap-2">
        <Icon name="d20" size={18} className="text-ink-muted" />
        <span className="flex-1 font-display text-lg text-ink">{item.who || t("dice.roll")}</span>
        <Button
          variant="ghost"
          icon="x"
          iconOnly
          label={t("common.close")}
          onClick={() => dismiss(item.id)}
        />
      </div>
      {item.kind === "roll" ? (
        <FreeRoll roll={item.roll} />
      ) : item.kind === "test" ? (
        <Test test={item.test} />
      ) : item.kind === "damage" ? (
        <Damage damage={item.damage} />
      ) : (
        <ActionRolls result={item.result} />
      )}
    </div>
  );
}

/** A sheet's D20 Test: the engine's label, mode and reasons, and the outcome when it has one. */
function Test({ test }: { test: D20TestResult }) {
  const outcome = test.automatic_failure
    ? t("dice.autoFail", { condition: test.automatic_failure })
    : test.critical
      ? t("dice.critical")
      : test.success === null
        ? undefined
        : test.kind === "attack"
          ? t(test.success ? "dice.hit" : "dice.miss")
          : t(test.success ? "dice.success" : "dice.failure");
  const tone =
    test.automatic_failure || test.critical_miss || test.success === false
      ? "bad"
      : test.critical || test.success
        ? "good"
        : null;
  return (
    <>
      <D20
        label={test.label}
        roll={test.roll}
        bonus={test.bonus}
        total={test.total}
        {...(outcome ? { outcome } : {})}
        tone={tone}
      />
      {test.reasons.length > 0 && (
        <ul className="mt-1 text-[13px] text-ink-muted">
          {test.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}
    </>
  );
}

function FreeRoll({ roll }: { roll: RollResult }) {
  return (
    <Line
      label={roll.dice_expression}
      dice={roll.rolls}
      modifier={roll.modifier}
      total={roll.total}
    />
  );
}

/** One roll: `Attack  [17, 4]  +5  = 22`. */
function Line({
  label,
  dice,
  kept,
  modifier,
  total,
  outcome,
  tone,
}: {
  label: ReactNode;
  dice: readonly number[];
  kept?: number;
  modifier?: number;
  total: number;
  outcome?: string;
  tone?: "good" | "bad" | null;
}) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm">
      <span className="min-w-0 flex-1 text-ink-muted">{label}</span>
      <span className="flex gap-1">
        {dice.map((d, i) => (
          <span
            key={i}
            className={cx(
              "inline-flex h-6 min-w-6 items-center justify-center rounded border px-1 tabular-nums",
              kept !== undefined && dice.length > 1 && d !== kept
                ? "border-edge text-ink-faint line-through"
                : "border-ink bg-card text-ink",
            )}
          >
            {d}
          </span>
        ))}
      </span>
      {modifier !== undefined && modifier !== 0 && (
        <span className="tabular-nums text-ink-muted">{signed(modifier)}</span>
      )}
      <span className="font-display text-2xl leading-none font-bold tabular-nums text-ink">
        = {total}
      </span>
      {outcome && (
        <span
          className={cx(
            "w-full text-right font-semibold",
            tone === "good" && "text-green",
            tone === "bad" && "text-red",
          )}
        >
          {outcome}
        </span>
      )}
    </div>
  );
}

function D20({
  label,
  roll,
  bonus,
  total,
  outcome,
  tone,
}: {
  label: ReactNode;
  roll: D20Roll;
  bonus: number;
  total: number;
  outcome?: string;
  tone?: "good" | "bad" | null;
}) {
  const mode =
    roll.mode === "normal"
      ? ""
      : ` (${t(roll.mode === "advantage" ? "dice.advantage" : "dice.disadvantage")})`;
  return (
    <Line
      label={
        <>
          {label}
          {mode}
        </>
      }
      dice={roll.rolls}
      kept={roll.d20}
      modifier={bonus}
      total={total}
      {...(outcome ? { outcome } : {})}
      tone={tone ?? null}
    />
  );
}

function Damage({ damage }: { damage: RolledDamage }) {
  return (
    <>
      {damage.parts.map((p, i) => (
        <Line
          key={i}
          label={`${p.dice ?? ""} ${p.type}`.trim()}
          dice={p.rolls}
          modifier={p.bonus}
          total={p.total}
        />
      ))}
      {damage.parts.length > 1 && (
        <div className="text-right text-sm">{t("dice.damageTotal", { total: damage.total })}</div>
      )}
    </>
  );
}

function SaveLine({ save, label }: { save: SaveResult; label: ReactNode }) {
  const outcome = save.automatic_failure
    ? t("dice.autoFail", { condition: save.automatic_failure })
    : save.legendary_resistance
      ? t("dice.legendaryResistance")
      : save.success
        ? t("dice.success")
        : t("dice.failure");
  return (
    <D20
      label={
        <>
          {label} · {t("dice.vsDc", { dc: save.dc })}
        </>
      }
      roll={save.roll}
      bonus={save.bonus}
      total={save.total}
      outcome={outcome}
      tone={save.success ? "good" : "bad"}
    />
  );
}

export function ActionRolls({ result }: { result: RolledResult }) {
  if ("manual" in result) return <Declared result={result} />;
  if ("target_ac" in result) return <Attack result={result} />;
  if ("spell" in result) {
    return (
      <div className="space-y-1">
        <div className="text-sm font-semibold">{result.spell}</div>
        {result.targets.map((target, i) => (
          <div key={i}>
            {target.attack && (
              <D20
                label={
                  <>
                    <TargetName target={target} /> · {t("dice.attack")}
                  </>
                }
                roll={target.attack.roll}
                bonus={result.attack_bonus ?? 0}
                total={target.attack.total}
                outcome={
                  target.attack.critical_hit
                    ? t("dice.critical")
                    : target.attack.hit
                      ? t("dice.hit")
                      : t("dice.miss")
                }
                tone={target.attack.hit ? "good" : "bad"}
              />
            )}
            {target.save && <SaveLine save={target.save} label={<TargetName target={target} />} />}
          </div>
        ))}
        {result.damage && <Damage damage={result.damage} />}
        {result.follow_up?.targets.map((target, i) =>
          target.save ? (
            <SaveLine key={`f${i}`} save={target.save} label={<TargetName target={target} />} />
          ) : null,
        )}
        {result.follow_up?.damage && <Damage damage={result.follow_up.damage} />}
      </div>
    );
  }
  if ("action" in result && "targets" in result) {
    return (
      <div className="space-y-1">
        <div className="text-sm font-semibold">{result.action}</div>
        {result.targets.map((target, i) =>
          target.save ? (
            <SaveLine key={i} save={target.save} label={<TargetName target={target} />} />
          ) : null,
        )}
        {result.damage && <Damage damage={result.damage} />}
      </div>
    );
  }
  if ("kind" in result) return <Test test={result} />;
  if ("skill" in result) return <Check result={result} />;
  return <SaveLine save={result} label={result.name} />;
}

/**
 * An action played by hand: what the engine rolled, with no target and nothing applied. The
 * table rules on hits and saves; whoever is affected applies the result.
 */
function Declared({ result }: { result: DeclaredResult }) {
  const { rolls } = result;
  return (
    <div className="space-y-1">
      <div className="text-sm font-semibold">
        {result.name} · {t("table.wayManual")}
      </div>
      {rolls.attacks.map((a, i) => (
        <div key={i} className="space-y-1">
          <D20
            label={a.attack}
            roll={a.roll}
            bonus={a.bonus}
            total={a.total}
            {...(a.critical_hit
              ? { outcome: t("dice.critical"), tone: "good" as const }
              : a.critical_miss
                ? { outcome: t("dice.naturalOne"), tone: "bad" as const }
                : {})}
          />
          {a.reasons.length > 0 && (
            <ul className="text-[13px] text-ink-muted">
              {a.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          )}
          {a.damage && <Damage damage={a.damage} />}
        </div>
      ))}
      {rolls.damage && <Damage damage={rolls.damage} />}
      {rolls.healing !== null && (
        <div className="text-sm">
          {t("dice.healingRolled")}: <span className="font-bold text-green">{rolls.healing}</span>
        </div>
      )}
      {rolls.save && (
        <div className="text-sm">
          {rolls.save.ability
            ? t("dice.saveToMake", { ability: abilityName(rolls.save.ability), dc: rolls.save.dc })
            : t("dice.saveStrOrDex", { dc: rolls.save.dc })}
        </div>
      )}
    </div>
  );
}

/**
 * A creature a result names: with its combatant id (in an encounter), a link that selects it on
 * the rail and the map.
 */
function TargetName({ target }: { target: { readonly id: string | null; readonly name: string } }) {
  const focus = useUi((s) => s.focusCombatant);
  if (target.id === null) return <>{target.name}</>;
  const id = target.id;
  return (
    <button
      type="button"
      className="font-semibold text-ink underline decoration-edge-strong underline-offset-2 hover:decoration-blue"
      onClick={() => focus(id)}
    >
      {target.name}
    </button>
  );
}

function Attack({ result }: { result: AttackResult }) {
  const outcome = result.critical_hit
    ? t("dice.critical")
    : result.hit
      ? t("dice.hit")
      : t("dice.miss");
  return (
    <div className="space-y-1">
      <div className="text-sm font-semibold">
        {result.attack} → {result.target}
      </div>
      <D20
        label={t("dice.vsAc", { ac: result.target_ac })}
        roll={result.roll}
        bonus={result.attack_bonus}
        total={result.total}
        outcome={outcome}
        tone={result.hit ? "good" : "bad"}
      />
      {result.damage && <Damage damage={result.damage} />}
    </div>
  );
}

function Check({ result }: { result: CheckResult }) {
  const outcome =
    result.success === null ? undefined : result.success ? t("dice.success") : t("dice.failure");
  return (
    <D20
      label={`${result.skill ?? result.ability}${result.dc !== null ? ` · ${t("dice.vsDc", { dc: result.dc })}` : ""}`}
      roll={result.roll}
      bonus={result.bonus}
      total={result.total}
      {...(outcome ? { outcome } : {})}
      tone={result.success === null ? null : result.success ? "good" : "bad"}
    />
  );
}
