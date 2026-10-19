/**
 * Abilities, saving throws, skills and proficiencies. A roll button is a free roll of the engine's
 * dice (`1d20` + the sheet's bonus); in an encounter, checks use the encounter's `check` action.
 */

import type { D20TestRequest, PlaySheet } from "srd-rules-engine";
import { Icon } from "@/components/Icon";
import { Section } from "@/components/ui";
import { abilities, abilityName, skillName } from "@/engine/constants";
import { signed, t } from "@/i18n";
import { titleCase } from "@/lib/format";
import { useNames } from "@/queries";
import { useDocuments } from "@/store/documents";
import { testOptions, useRollAdditions } from "@/store/rolls";

/**
 * The engine rolls the check, save or attack for this character (`rollCheck`), with the GM's
 * additions set on the sheet; a declared luck-style use is spent with it, then cleared.
 */
export function useRoller(id: string, sheet: PlaySheet) {
  const rollTest = useDocuments((s) => s.rollTest);
  return (request: D20TestRequest) => {
    const { by, set } = useRollAdditions.getState();
    const additions = by[id];
    const use = additions?.lucky
      ? sheet.play.uses.find((u) => u.key === additions.lucky)
      : undefined;
    void rollTest(
      id,
      request,
      testOptions(additions),
      use ? { use: use.key, label: use.name } : undefined,
    ).then((r) => {
      if (r.ok && use && additions) set(id, { ...additions, lucky: undefined });
    });
  };
}

function RollButton({
  label,
  bonus,
  request,
  onRoll,
}: {
  label: string;
  bonus: number;
  request: D20TestRequest;
  onRoll: (request: D20TestRequest) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onRoll(request)}
      className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-semibold tabular-nums hover:bg-card-3 hover:text-ink"
      aria-label={`${label} ${signed(bonus)}: ${t("dice.rollButton")}`}
    >
      {signed(bonus)}
      <Icon name="d20" size={14} className="text-ink-muted" />
    </button>
  );
}

export function OverviewTab({ id, sheet }: { id: string; sheet: PlaySheet }) {
  const roll = useRoller(id, sheet);
  const toolName = useNames("tools", { character: id });
  const languageName = useNames("languages", { character: id });
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Section title={t("sheet.abilities")}>
        <p className="mb-1 flex items-center gap-2">
          <span className="font-semibold">{t("summary.initiative")}</span>
          <RollButton
            label={t("summary.initiative")}
            bonus={sheet.initiative.total}
            request={{ initiative: true }}
            onRoll={roll}
          />
        </p>
        <table className="w-full text-left">
          <thead>
            <tr className="text-[13px] font-bold text-ink-muted">
              <th className="py-1 font-normal">{t("sheet.abilities")}</th>
              <th className="py-1 text-center font-normal">{t("builder.final")}</th>
              <th className="py-1 font-normal">{t("sheet.abilities")}</th>
              <th className="py-1 font-normal">{t("sheet.saves")}</th>
            </tr>
          </thead>
          <tbody>
            {abilities().map((a) => {
              const save = sheet.saving_throws[a];
              return (
                <tr key={a} className="border-t border-edge">
                  <th scope="row" className="py-1 font-semibold">
                    {abilityName(a)}
                  </th>
                  <td className="py-1 text-center font-display text-xl font-bold">
                    {sheet.scores[a]}
                  </td>
                  <td className="py-1">
                    <RollButton
                      label={abilityName(a)}
                      bonus={sheet.ability_checks[a]}
                      request={{ ability: a }}
                      onRoll={roll}
                    />
                  </td>
                  <td className="py-1">
                    <span className="flex items-center gap-1">
                      <span
                        className="bubble"
                        data-level={save.proficient ? "proficient" : undefined}
                        aria-hidden="true"
                      />
                      <RollButton
                        label={`${abilityName(a)} ${t("sheet.saves")}`}
                        bonus={save.modifier}
                        request={{ save: a }}
                        onRoll={roll}
                      />
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {sheet.advantages.length > 0 && (
          <div className="mt-3 text-sm">
            <span className="text-ink-muted">{t("sheet.advantages")}: </span>
            {sheet.advantages.map((a) => `${a.target} (${a.source})`).join(", ")}
          </div>
        )}
      </Section>

      <Section title={t("sheet.skills")}>
        <ul className="grid gap-x-4 sm:grid-cols-2">
          {sheet.skills.map((s) => (
            <li key={s.skill} className="flex items-center gap-2 border-b border-edge/60 py-0.5">
              <span
                className="bubble"
                data-level={
                  s.expertise ? "expertise" : s.proficient_from ? "proficient" : undefined
                }
                title={s.proficient_from ?? undefined}
                aria-hidden="true"
              />
              <span className="flex-1">
                {skillName(s.skill)}{" "}
                <span className="text-[13px] text-ink-faint uppercase">{s.ability}</span>
              </span>
              <RollButton
                label={skillName(s.skill)}
                bonus={s.modifier}
                request={{ skill: s.skill }}
                onRoll={roll}
              />
            </li>
          ))}
        </ul>
      </Section>

      <Section title={t("sheet.proficiencies")} className="xl:col-span-2">
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          <Row label={t("sheet.armorTraining")} items={sheet.armor_training.map(titleCase)} />
          <Row label={t("sheet.weapons")} items={sheet.weapon_proficiencies.map(titleCase)} />
          <Row label={t("sheet.tools")} items={Object.keys(sheet.tools).map(toolName)} />
          <Row
            label={t("sheet.languages")}
            items={Object.keys(sheet.languages).map(languageName)}
          />
          <Row label={t("sheet.resistances")} items={sheet.resistances.map(titleCase)} />
          <Row
            label={t("sheet.size")}
            items={[
              ...(sheet.size ? [titleCase(sheet.size)] : []),
              ...(sheet.darkvision ? [t("sheet.darkvision", { feet: sheet.darkvision })] : []),
            ]}
          />
        </dl>
      </Section>
    </div>
  );
}

function Row({ label, items }: { label: string; items: readonly string[] }) {
  if (!items.length) return null;
  return (
    <div>
      <dt className="text-ink-muted">{label}</dt>
      <dd>{items.join(", ")}</dd>
    </div>
  );
}
