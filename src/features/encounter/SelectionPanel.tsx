/**
 * The selected combatant: its numbers and conditions, effects on it, and the controls that apply
 * to it. Checks and saving throws roll through the encounter's `check` action (`skill`, `ability`
 * or `save`; nothing applied). GM only: set Initiative, the
 * decision mode, who rolls its dice, how its actions are played (automatic or by hand), effects by hand (damage,
 * healing, conditions, timed), end an effect, remove.
 */

import { Link } from "@tanstack/react-router";
import { useState } from "react";
import type { Ability, ConditionDef, Encounter, Skill } from "srd-rules-engine";
import { Icon } from "@/components/Icon";
import { Portrait } from "@/components/Portrait";
import { Button, HpBar, Reasons, Section } from "@/components/ui";
import { abilities, abilityName, damageTypes, skillName, skills } from "@/engine/constants";
import type { CombatantView } from "@/engine/facade";
import { t } from "@/i18n";
import { titleCase } from "@/lib/format";
import { useTable } from "@/queries";
import { useDocuments } from "@/store/documents";
import type { DiceMode, PlayWay } from "@/store/settings";
import { ConditionMedal } from "../sheet/HitPoints";

export function SelectionPanel({
  encounterId,
  mode,
  encounter,
  combatant,
  gm,
  canAct,
}: {
  encounterId: string;
  /** How the combatant plays its actions, if the GM set it (`null`: the campaign's default). */
  mode: PlayWay | null;
  encounter: Encounter;
  combatant: CombatantView | null;
  gm: boolean;
  canAct: boolean;
}) {
  const send = useDocuments((s) => s.encounterAction);
  const [reasons, setReasons] = useState<readonly string[] | null>(null);
  if (!combatant) {
    return (
      <Section title={t("table.selection")}>
        <p className="text-sm text-ink-muted">{t("table.noTurn")}</p>
      </Section>
    );
  }
  const c = combatant;
  const showHp = gm || c.character !== null;
  const act = async (action: Parameters<typeof send>[1]) => {
    const result = await send(encounterId, action);
    setReasons(result.ok ? null : result.reasons);
    return result.ok;
  };
  const effects = encounter.effects.filter((e) => e.target === c.id);

  return (
    <Section title={t("table.selection")}>
      <div className="mb-2 flex items-center gap-3">
        <Portrait id={c.character} name={c.name} size={48} round />
        <div className="min-w-0 flex-1">
          <div className="truncate font-display text-xl text-ink">{c.name}</div>
          <div className="text-sm text-ink-muted">
            {showHp &&
              `${t("summary.hp")} ${c.hp}/${c.max_hp}${c.temp_hp ? ` +${c.temp_hp}` : ""} · `}
            {t("summary.ac")} {c.armor_class}
            {c.size && ` · ${titleCase(c.size)}`}
            {c.position && ` · (${c.position.x}, ${c.position.y})`}
          </div>
          {showHp && (
            <HpBar
              hp={c.hp}
              max={c.max_hp}
              temp={c.temp_hp}
              bloodied={c.bloodied}
              className="mt-1"
            />
          )}
        </div>
        {c.character && (
          <Link
            to="/characters/$id/sheet"
            params={{ id: c.character }}
            search={{}}
            className="btn !px-2"
            aria-label={`${t("characters.sheet")}: ${c.name}`}
            title={t("characters.sheet")}
          >
            <Icon name="sheet" />
          </Link>
        )}
      </div>
      {(c.conditions.length > 0 || c.concentration) && (
        <ul className="mb-2 flex flex-wrap gap-1.5 text-sm">
          {c.concentration && (
            <li className="flex items-center gap-1 text-purple">
              <Icon name="concentration" size={16} />
              {c.concentration}
            </li>
          )}
          {c.conditions.map((cond) => (
            <li key={cond.id} className="flex items-center gap-1">
              <ConditionMedal />
              {cond.name}
            </li>
          ))}
        </ul>
      )}
      {effects.length > 0 && (
        <div className="mb-2">
          <h3 className="text-sm text-ink-muted">{t("table.effectsInPlay")}</h3>
          <ul className="space-y-1 text-sm">
            {effects.map((e) => (
              <li key={e.id} className="flex items-center gap-2">
                <span className="flex-1">
                  {titleCase(e.condition)} · {e.label}
                  {e.ends && (
                    <span className="text-ink-faint">
                      {" "}
                      ({e.ends.at} {e.ends.count})
                    </span>
                  )}
                </span>
                {gm && (
                  <Button
                    size="sm"
                    variant="ghost"
                    icon="x"
                    iconOnly
                    label={t("table.endEffect")}
                    onClick={() => void act({ type: "end_effect", effect: e.id })}
                  />
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      <Reasons reasons={reasons} className="mb-2" />
      {canAct && <CheckForm id={c.id} act={act} />}
      {gm && (
        <GmControls
          c={c}
          act={act}
          mode={mode}
          setMode={(m) => useDocuments.getState().setPlayMode(encounterId, c.id, m)}
        />
      )}
    </Section>
  );
}

type Act = (
  action: Parameters<ReturnType<typeof useDocuments.getState>["encounterAction"]>[1],
) => Promise<boolean>;

function CheckForm({ id, act }: { id: string; act: Act }) {
  const [what, setWhat] = useState("perception");
  const [dc, setDc] = useState("");
  const isAbility = (abilities() as readonly string[]).includes(what);
  const save = what.startsWith("save:") ? (what.slice(5) as Ability) : null;
  const n = Number.parseInt(dc, 10);
  return (
    <details className="mb-2 border-t border-edge pt-2">
      <summary className="cursor-pointer text-sm font-semibold">{t("table.check")}</summary>
      <div className="mt-2 flex flex-wrap items-end gap-2">
        <label className="flex flex-col text-[13px] text-ink-muted">
          {t("table.checkWhat")}
          <select className="field" value={what} onChange={(e) => setWhat(e.target.value)}>
            <optgroup label={t("table.checkSkill")}>
              {skills().map((s) => (
                <option key={s} value={s}>
                  {skillName(s)}
                </option>
              ))}
            </optgroup>
            <optgroup label={t("table.checkAbility")}>
              {abilities().map((a) => (
                <option key={a} value={a}>
                  {abilityName(a)}
                </option>
              ))}
            </optgroup>
            <optgroup label={t("table.checkSave")}>
              {abilities().map((a) => (
                <option key={a} value={`save:${a}`}>
                  {t("table.saveOf", { ability: abilityName(a) })}
                </option>
              ))}
            </optgroup>
          </select>
        </label>
        <label className="flex flex-col text-[13px] text-ink-muted">
          {t("table.dc")}
          <input
            className="field w-20"
            inputMode="numeric"
            value={dc}
            onChange={(e) => setDc(e.target.value.replace(/[^0-9]/g, ""))}
          />
        </label>
        <Button
          size="sm"
          icon="d20"
          onClick={() =>
            void act({
              type: "check",
              id,
              ...(save
                ? { save }
                : isAbility
                  ? { ability: what as Ability }
                  : { skill: what as Skill }),
              ...(Number.isInteger(n) ? { dc: n } : {}),
            })
          }
        >
          {t("dice.rollButton")}
        </Button>
      </div>
    </details>
  );
}

function GmControls({
  c,
  act,
  mode,
  setMode,
}: {
  c: CombatantView;
  act: Act;
  mode: PlayWay | null;
  setMode: (mode: PlayWay | null) => void;
}) {
  const { data: conditions } = useTable<ConditionDef>("conditions");
  const [initiative, setInitiative] = useState(c.initiative === null ? "" : String(c.initiative));
  const [amount, setAmount] = useState("");
  const [damageType, setDamageType] = useState("");
  const [condition, setCondition] = useState("");
  const [rounds, setRounds] = useState("");
  const n = Number.parseInt(amount, 10);
  const r = Number.parseInt(rounds, 10);
  const timing = Number.isInteger(r) && r > 0 ? { rounds: r } : {};

  return (
    <details className="border-t border-edge pt-2" open>
      <summary className="cursor-pointer text-sm font-semibold">{t("table.gmControls")}</summary>
      <div className="mt-2 space-y-3 text-sm">
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col text-[13px] text-ink-muted">
            {t("table.initiative")}
            <input
              className="field w-20"
              inputMode="numeric"
              value={initiative}
              onChange={(e) => setInitiative(e.target.value.replace(/[^0-9-]/g, ""))}
            />
          </label>
          <Button
            size="sm"
            disabled={!Number.isInteger(Number.parseInt(initiative, 10))}
            onClick={() =>
              void act({ type: "set_initiative", id: c.id, value: Number.parseInt(initiative, 10) })
            }
          >
            {t("table.setInitiative")}
          </Button>
          <label className="flex flex-col text-[13px] text-ink-muted">
            {t("table.decisionsMode")}
            <select
              className="field"
              value={c.decisions ?? ""}
              onChange={(e) =>
                void act({
                  type: "set_decisions",
                  id: c.id,
                  mode: e.target.value === "" ? null : (e.target.value as "ask" | "auto"),
                })
              }
            >
              <option value="">{t("table.decisionsDefault")}</option>
              <option value="ask">{t("table.decisionsAsk")}</option>
              <option value="auto">{t("table.decisionsAuto")}</option>
            </select>
          </label>
          <label className="flex flex-col text-[13px] text-ink-muted">
            {t("table.dice")}
            <select
              className="field"
              value={c.dice ?? ""}
              onChange={(e) =>
                void act({
                  type: "set_dice",
                  id: c.id,
                  mode: e.target.value === "" ? null : (e.target.value as DiceMode),
                })
              }
            >
              <option value="">{t("table.decisionsDefault")}</option>
              <option value="engine">{t("table.diceEngine")}</option>
              <option value="table">{t("table.diceTable")}</option>
            </select>
          </label>
          <label className="flex flex-col text-[13px] text-ink-muted" title={t("table.wayHint")}>
            {t("table.playWay")}
            <select
              className="field"
              value={mode ?? ""}
              onChange={(e) => setMode(e.target.value === "" ? null : (e.target.value as PlayWay))}
            >
              <option value="">{t("table.wayDefault")}</option>
              <option value="auto">{t("table.wayAuto")}</option>
              <option value="manual">{t("table.wayManual")}</option>
            </select>
          </label>
        </div>

        <fieldset className="space-y-1.5">
          <legend className="text-[13px] text-ink-muted">{t("table.effects")}</legend>
          <div className="flex flex-wrap gap-1.5">
            <input
              className="field w-20"
              inputMode="numeric"
              aria-label={t("sheet.amount")}
              placeholder={t("sheet.amount")}
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^0-9]/g, ""))}
            />
            <select
              className="field w-auto"
              aria-label={t("sheet.damageType")}
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
            <Button
              size="sm"
              variant="danger"
              disabled={!(n >= 0) || amount === ""}
              onClick={async () => {
                const ok = await act({
                  type: "effects",
                  id: c.id,
                  actions: [
                    {
                      type: "damage",
                      amount: n,
                      ...(damageType ? { damage_type: damageType } : {}),
                    },
                  ],
                });
                if (ok) setAmount("");
              }}
            >
              {t("table.effectDamage")}
            </Button>
            <Button
              size="sm"
              disabled={!(n >= 0) || amount === ""}
              onClick={async () => {
                if (
                  await act({ type: "effects", id: c.id, actions: [{ type: "heal", amount: n }] })
                )
                  setAmount("");
              }}
            >
              {t("table.effectHeal")}
            </Button>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <select
              className="field w-auto"
              aria-label={t("sheet.addCondition")}
              value={condition}
              onChange={(e) => setCondition(e.target.value)}
            >
              <option value="">{t("sheet.addCondition")}</option>
              {[...(conditions ?? [])]
                .filter((x) => x.id !== "exhaustion")
                .sort((a, b) => a.name.localeCompare(b.name))
                .map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
            </select>
            <input
              className="field w-28"
              inputMode="numeric"
              aria-label={t("table.effectRounds")}
              placeholder={t("table.effectRounds")}
              value={rounds}
              onChange={(e) => setRounds(e.target.value.replace(/[^0-9]/g, ""))}
            />
            <Button
              size="sm"
              disabled={!condition}
              onClick={() =>
                void act({
                  type: "effects",
                  id: c.id,
                  actions: [{ type: "add_condition", condition }],
                  ...timing,
                })
              }
            >
              {t("table.effectCondition")}
            </Button>
            <Button
              size="sm"
              disabled={!condition}
              onClick={() =>
                void act({
                  type: "effects",
                  id: c.id,
                  actions: [{ type: "remove_condition", condition }],
                })
              }
            >
              {t("table.effectRemoveCondition")}
            </Button>
          </div>
        </fieldset>

        <Button
          size="sm"
          variant="danger"
          icon="trash"
          onClick={() => void act({ type: "remove", id: c.id })}
        >
          {t("table.remove")}
        </Button>
      </div>
    </details>
  );
}
