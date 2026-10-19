/**
 * Hit points and what's on the character right now: damage, healing and Temporary HP, death
 * saves, conditions and Exhaustion, Concentration, Heroic Inspiration; and the rests.
 */

import { useState } from "react";
import type { ConditionDef, PlayAction, PlaySheet, RollResult } from "srd-rules-engine";
import { Explain } from "@/components/Explain";
import { Icon } from "@/components/Icon";
import { Button, cx, Dialog, Gems, HpBar, Reasons, Section } from "@/components/ui";
import { engine } from "@/engine/client";
import { damageTypes } from "@/engine/constants";
import { t } from "@/i18n";
import { titleCase } from "@/lib/format";
import { useTable } from "@/queries";
import { useDocuments } from "@/store/documents";
import { useUi } from "@/store/ui";
import { usePlay, usePlayResult } from "./usePlay";

export function HitPointsPanel({ id, sheet }: { id: string; sheet: PlaySheet }) {
  const { act, reasons: actReasons, busy: acting } = usePlay(id);
  // A death save is rolled by the engine and remembered, so Heroic Inspiration can redo it.
  const { run, reasons: saveReasons, busy: saving } = usePlayResult();
  const deathSave = useDocuments((s) => s.deathSave);
  const reasons = actReasons ?? saveReasons;
  const busy = acting || saving;
  const { play } = sheet;
  const [amount, setAmount] = useState("");
  const [damageType, setDamageType] = useState("");
  const n = Number.parseInt(amount, 10);
  const valid = Number.isInteger(n) && n >= 0;

  return (
    <>
      <Section title={t("sheet.hitPoints")}>
        <div className="flex items-baseline gap-2">
          <span className="font-display text-4xl font-bold tabular-nums">{play.hp.current}</span>
          <span className="text-ink-muted">/</span>
          {sheet.max_hp ? (
            <span className="font-display text-2xl">
              <ExplainMax sheet={sheet} />
            </span>
          ) : (
            <span>{play.hp.max}</span>
          )}
          {play.hp.temp > 0 && (
            <span className="ml-auto rounded bg-blue/20 px-2 text-blue">
              +{play.hp.temp} {t("sheet.temp")}
            </span>
          )}
        </div>
        <HpBar
          hp={play.hp.current}
          max={play.hp.max}
          temp={play.hp.temp}
          bloodied={play.hp.bloodied}
          className="mt-1 mb-3"
        />
        {play.hp.bloodied && !play.dying && !play.dead && (
          <p className="mb-2 font-semibold text-red">{t("table.bloodied")}</p>
        )}
        {(play.dying || play.stable || play.dead) && (
          <p className={cx("mb-2 font-semibold", play.dead ? "text-red" : "text-orange")}>
            {play.dead ? t("sheet.dead") : play.stable ? t("sheet.stable") : t("sheet.dying")}
          </p>
        )}
        <Reasons reasons={reasons} className="mb-2" />
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
          }}
        >
          <div className="flex gap-2">
            <label className="flex-1">
              <span className="sr-only">{t("sheet.amount")}</span>
              <input
                className="field"
                inputMode="numeric"
                placeholder={t("sheet.amount")}
                value={amount}
                onChange={(e) => setAmount(e.target.value.replace(/[^0-9]/g, ""))}
              />
            </label>
            <label className="flex-1">
              <span className="sr-only">{t("sheet.damageType")}</span>
              <select
                className="field"
                value={damageType}
                onChange={(e) => setDamageType(e.target.value)}
              >
                <option value="">{t("sheet.untyped")}</option>
                {damageTypes().map((d) => (
                  <option key={d} value={d}>
                    {titleCase(d)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="grid grid-cols-3 gap-1.5">
            <Button
              size="sm"
              variant="danger"
              icon="swords"
              disabled={!valid || busy}
              onClick={async () => {
                const ok = await act({
                  type: "damage",
                  amount: n,
                  ...(damageType ? { damage_type: damageType } : {}),
                });
                if (ok) setAmount("");
              }}
            >
              {t("sheet.damage")}
            </Button>
            <Button
              size="sm"
              icon="heart"
              disabled={!valid || busy}
              onClick={async () => {
                if (await act({ type: "heal", amount: n })) setAmount("");
              }}
            >
              {t("sheet.heal")}
            </Button>
            <Button
              size="sm"
              icon="shield"
              disabled={!valid || busy}
              onClick={async () => {
                if (await act({ type: "set_temp_hp", amount: n })) setAmount("");
              }}
            >
              {t("sheet.temp")}
            </Button>
          </div>
        </form>
        {(play.dying || play.death_saves.successes > 0 || play.death_saves.failures > 0) && (
          <div className="mt-3 space-y-1.5 border-t border-edge pt-3">
            <h3 className="font-semibold">{t("sheet.deathSaves")}</h3>
            <div className="flex items-center gap-2 text-sm">
              <span className="w-20 text-ink-muted">{t("sheet.successes")}</span>
              <Gems total={3} spent={3 - play.death_saves.successes} label={t("sheet.successes")} />
            </div>
            <div className="flex items-center gap-2 text-sm">
              <span className="w-20 text-ink-muted">{t("sheet.failures")}</span>
              <Gems total={3} spent={3 - play.death_saves.failures} label={t("sheet.failures")} />
            </div>
            <div className="flex gap-1.5">
              <Button
                size="sm"
                icon="d20"
                disabled={busy}
                onClick={() => void run(() => deathSave(id))}
              >
                {t("sheet.rollDeathSave")}
              </Button>
              <Button size="sm" disabled={busy} onClick={() => void act({ type: "stabilize" })}>
                {t("sheet.stabilize")}
              </Button>
            </div>
          </div>
        )}
      </Section>
      <ConditionsPanel id={id} sheet={sheet} />
    </>
  );
}

function ExplainMax({ sheet }: { sheet: PlaySheet }) {
  if (!sheet.max_hp) return <>{sheet.play.hp.max}</>;
  return <Explain label={t("summary.hp")} total={sheet.max_hp.total} parts={sheet.max_hp.parts} />;
}

function ConditionsPanel({ id, sheet }: { id: string; sheet: PlaySheet }) {
  const { act, reasons, busy } = usePlay(id);
  const { data: conditions } = useTable<ConditionDef>("conditions", { character: id });
  const { play } = sheet;
  const active = new Set(play.conditions.map((c) => c.id));
  return (
    <Section title={t("sheet.conditions")}>
      <Reasons reasons={reasons} className="mb-2" />
      {play.conditions.length > 0 && (
        <ul className="mb-2 flex flex-wrap gap-1.5">
          {play.conditions.map((c) => (
            <li key={c.id}>
              <span
                className={cx("btn btn-sm", c.implied && "opacity-70")}
                title={c.description.split("\n")[0]}
              >
                <ConditionMedal />
                {c.name}
                {!c.implied && (
                  <button
                    type="button"
                    className="ml-1 text-ink-muted hover:text-red"
                    aria-label={`${t("common.remove")}: ${c.name}`}
                    disabled={busy}
                    onClick={() => void act({ type: "remove_condition", condition: c.id })}
                  >
                    <Icon name="x" size={14} />
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      <label className="flex items-center gap-2">
        <span className="sr-only">{t("sheet.addCondition")}</span>
        <select
          className="field"
          value=""
          disabled={busy}
          onChange={(e) => {
            if (e.target.value) void act({ type: "add_condition", condition: e.target.value });
          }}
        >
          <option value="">{t("sheet.addCondition")}</option>
          {(conditions ?? [])
            .filter((c) => c.id !== "exhaustion" && !active.has(c.id))
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
        </select>
      </label>
      <div className="mt-3 grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2 text-sm">
        <span className="text-ink-muted">{t("sheet.exhaustion")}</span>
        <select
          className="field max-w-[6rem]"
          aria-label={t("sheet.exhaustion")}
          value={play.exhaustion}
          disabled={busy}
          onChange={(e) => void act({ type: "set_exhaustion", level: Number(e.target.value) })}
        >
          {[0, 1, 2, 3, 4, 5, 6].map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>
        <span className="text-ink-muted">{t("sheet.concentration")}</span>
        <span className="flex items-center gap-2">
          {play.concentration ? (
            <>
              <Icon name="concentration" size={16} className="text-purple" />
              <span className="flex-1">{play.concentration}</span>
              <Button
                size="sm"
                icon="x"
                iconOnly
                label={t("sheet.endConcentration")}
                disabled={busy}
                onClick={() => void act({ type: "set_concentration", spell: null })}
              />
            </>
          ) : (
            <span className="text-ink-faint">{t("sheet.concentrationNone")}</span>
          )}
        </span>
        <span className="text-ink-muted">{t("sheet.inspiration")}</span>
        <span>
          <Button
            size="sm"
            icon="star"
            on={play.heroic_inspiration}
            aria-pressed={play.heroic_inspiration}
            disabled={busy}
            onClick={() => void act({ type: "set_inspiration", value: !play.heroic_inspiration })}
          >
            {play.heroic_inspiration ? t("sheet.on") : t("sheet.off")}
          </Button>
        </span>
      </div>
    </Section>
  );
}

/** A condition as a round medallion (red when it hinders); the name is next to it or in a label. */
/**
 * A condition as a ring, like the coloured rings slipped onto a miniature: alone next to the
 * condition's name, or as a chip with the name (`label`) where space is short.
 */
export function ConditionMedal({ label }: { label?: string }) {
  const ring = (
    <span
      className="inline-block h-3 w-3 flex-none rounded-full border-[2.5px] border-red"
      aria-hidden="true"
    />
  );
  if (!label) return ring;
  return (
    <span className="inline-flex items-center gap-1 rounded-full border-[1.5px] border-red py-px pr-2 pl-1 text-[13px] leading-tight">
      {ring}
      {label}
    </span>
  );
}

/**
 * Short and Long Rests. A Short Rest spends Hit Point Dice one at a time: each is the engine's
 * roll (shown in the tray), the dialog shows the engine's preview of the rest so far (nothing
 * saved), and the player decides on the next die after seeing it; Heroic Inspiration can reroll
 * the last die before confirming. Confirm is one `short_rest` with every die rolled, so what a
 * Short Rest gives back comes once; Cancel saves nothing (contract actions.md §7.1).
 */
export function RestButtons({ id, sheet }: { id: string; sheet: PlaySheet }) {
  const { act, reasons, busy, clear } = usePlay(id);
  const record = useDocuments((s) => s.characters[id]);
  const [open, setOpen] = useState<"short" | "long" | null>(null);
  const [rolled, setRolled] = useState<readonly { die: number; roll: RollResult }[]>([]);
  const [heroic, setHeroic] = useState(false);
  const [preview, setPreview] = useState<{ hp: number; max: number } | null>(null);
  const [problem, setProblem] = useState<readonly string[] | null>(null);
  const close = () => {
    setOpen(null);
    setRolled([]);
    setHeroic(false);
    setPreview(null);
    setProblem(null);
    clear();
  };
  const actions = (
    dice: readonly { die: number; roll: RollResult }[],
    spent: boolean,
  ): PlayAction[] => [
    ...(spent ? [{ type: "spend_inspiration" as const }] : []),
    { type: "short_rest", hit_dice: dice.map((d) => ({ die: d.die, roll: d.roll.total })) },
  ];
  async function show(dice: readonly { die: number; roll: RollResult }[], spent: boolean) {
    if (!record) return;
    const f = engine();
    const after = await f.applyPlayAction(
      record.build,
      record.state,
      actions(dice, spent),
      record.content,
    );
    if (!after.ok) {
      setProblem(after.reasons);
      setPreview(null);
      return;
    }
    setProblem(null);
    const view = await f.playSheet(record.build, after.state, record.content);
    setPreview({ hp: view.sheet.play.hp.current, max: view.sheet.play.hp.max });
  }
  async function rollDie(die: number) {
    const r = await engine().roll(`1d${die}`);
    if (!r.ok) return setProblem(r.reasons);
    useUi.getState().showDice([{ kind: "roll", who: record?.build.name ?? "", roll: r.roll }]);
    const next = [...rolled, { die, roll: r.roll }];
    setRolled(next);
    await show(next, heroic);
  }
  async function rerollLast() {
    const last = rolled.at(-1);
    if (!record || !last) return;
    const r = await engine().heroicReroll(
      record.build,
      record.state,
      { kind: "single", roll: last.roll, die: 0 },
      record.content,
    );
    if (!r.ok) return setProblem(r.reasons);
    const again = r.roll as RollResult;
    useUi.getState().showDice([{ kind: "roll", who: record.build.name ?? "", roll: again }]);
    const next = [...rolled.slice(0, -1), { die: last.die, roll: again }];
    setRolled(next);
    setHeroic(true);
    await show(next, true);
  }
  const spentOf = (die: number) => rolled.filter((d) => d.die === die).length;
  return (
    <>
      <Button size="sm" icon="hourglass" onClick={() => setOpen("short")}>
        {t("sheet.shortRest")}
      </Button>
      <Button size="sm" icon="moon" onClick={() => setOpen("long")}>
        {t("sheet.longRest")}
      </Button>
      <Dialog
        open={open !== null}
        onOpenChange={(o) => {
          if (!o) close();
        }}
        title={open === "long" ? t("sheet.longRest") : t("sheet.shortRest")}
        footer={
          <>
            <Button onClick={close}>{t("common.cancel")}</Button>
            <Button
              variant="primary"
              icon={open === "long" ? "moon" : "hourglass"}
              disabled={busy || (open === "short" && problem !== null)}
              onClick={async () => {
                const ok =
                  open === "long"
                    ? await act({ type: "long_rest" })
                    : await act(actions(rolled, heroic));
                if (ok) close();
              }}
            >
              {t("common.confirm")}
            </Button>
          </>
        }
      >
        <Reasons reasons={reasons ?? problem} className="mb-2" />
        {open === "short" && (
          <div className="space-y-2">
            <p className="text-sm text-ink-muted">{t("sheet.shortRestSequential")}</p>
            {sheet.play.hit_dice.map((d) => {
              const left = d.total - d.spent - spentOf(d.die);
              return (
                <div key={d.die} className="flex items-center gap-3">
                  <span className="w-12 font-semibold">d{d.die}</span>
                  <span className="text-sm text-ink-muted">
                    {t("common.left", { left, total: d.total })}
                  </span>
                  <Button
                    size="sm"
                    icon="d20"
                    className="ml-auto"
                    disabled={busy || left <= 0}
                    onClick={() => void rollDie(d.die)}
                  >
                    {t("sheet.spendHitDie", { die: d.die })}
                  </Button>
                </div>
              );
            })}
            {rolled.length > 0 && (
              <p className="text-sm" data-testid="rest-dice">
                {t("sheet.hitDiceRolled", {
                  dice: rolled.map((d) => `d${d.die}: ${d.roll.total}`).join(", "),
                })}
              </p>
            )}
            {preview && (
              <p className="text-sm font-semibold" data-testid="rest-preview">
                {t("sheet.restPreview", { hp: preview.hp, max: preview.max })}
              </p>
            )}
            {rolled.length > 0 && sheet.play.heroic_inspiration && !heroic && (
              <Button size="sm" disabled={busy} onClick={() => void rerollLast()}>
                {t("sheet.heroicLastHitDie")}
              </Button>
            )}
          </div>
        )}
      </Dialog>
    </>
  );
}
