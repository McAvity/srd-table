/**
 * The GM's additions to this character's next rolls on the sheet (a mode, a modifier, a bonus
 * die, damage additions) and a luck-style use declared for the next D20 Test. Values only: the
 * engine applies and lists them on the result (`DmOptions`).
 */

import type { PlaySheet } from "srd-rules-engine";
import { Section } from "@/components/ui";
import { damageTypes } from "@/engine/constants";
import { t } from "@/i18n";
import { type RollAdditions, useRollAdditions } from "@/store/rolls";

const DICE = /^[1-9]\d*d[1-9]\d*$/;

export function RollOptions({ id, sheet }: { id: string; sheet: PlaySheet }) {
  const value = useRollAdditions((s) => s.by[id]) ?? {};
  const setAll = useRollAdditions((s) => s.set);
  const change = (patch: Partial<RollAdditions>) => {
    const next: Record<string, unknown> = { ...value, ...patch };
    for (const [k, v] of Object.entries(next))
      if (v === undefined || v === "" || v === 0) delete next[k];
    setAll(id, next as RollAdditions);
  };
  const lucky = sheet.play.uses.filter((u) => u.spend_for?.includes("d20_advantage"));
  const number = (raw: string) => {
    const n = Number.parseInt(raw, 10);
    return Number.isInteger(n) ? n : undefined;
  };
  const dice = (raw: string) => (DICE.test(raw.trim()) ? raw.trim() : undefined);
  const active = Object.keys(value).length > 0;
  return (
    <Section title={active ? t("rollopts.titleActive") : t("rollopts.title")}>
      <div className="flex flex-wrap items-end gap-3 text-sm">
        <label className="flex flex-col gap-1">
          <span className="text-ink-muted">{t("rollopts.mode")}</span>
          <select
            className="field w-auto py-1"
            value={value.mode_override ?? ""}
            onChange={(e) =>
              change({
                mode_override: (e.target.value || undefined) as RollAdditions["mode_override"],
              })
            }
          >
            <option value="">{t("rollopts.modeComputed")}</option>
            <option value="advantage">{t("dice.advantage")}</option>
            <option value="disadvantage">{t("dice.disadvantage")}</option>
            <option value="normal">{t("rollopts.modeNormal")}</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-ink-muted">{t("rollopts.modifier")}</span>
          <input
            className="field w-20 py-1"
            inputMode="numeric"
            defaultValue={value.modifier ?? ""}
            onBlur={(e) => change({ modifier: number(e.target.value) })}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-ink-muted">{t("rollopts.bonusDie")}</span>
          <input
            className="field w-20 py-1"
            placeholder="1d4"
            defaultValue={value.bonus_die ?? ""}
            onBlur={(e) => change({ bonus_die: dice(e.target.value) })}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-ink-muted">{t("rollopts.damageModifier")}</span>
          <input
            className="field w-20 py-1"
            inputMode="numeric"
            defaultValue={value.damage_modifier ?? ""}
            onBlur={(e) => change({ damage_modifier: number(e.target.value) })}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-ink-muted">{t("rollopts.damageDie")}</span>
          <span className="flex gap-1">
            <input
              className="field w-20 py-1"
              placeholder="1d6"
              defaultValue={value.damage_die ?? ""}
              onBlur={(e) => change({ damage_die: dice(e.target.value) })}
            />
            <select
              className="field w-auto py-1"
              aria-label={t("rollopts.damageType")}
              value={value.damage_type ?? ""}
              onChange={(e) => change({ damage_type: e.target.value || undefined })}
            >
              <option value="">{t("rollopts.damageType")}</option>
              {damageTypes().map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </span>
        </label>
        {lucky.length > 0 && (
          <label className="flex flex-col gap-1">
            <span className="text-ink-muted">{t("rollopts.lucky")}</span>
            <select
              className="field w-auto py-1"
              value={value.lucky ?? ""}
              onChange={(e) => change({ lucky: e.target.value || undefined })}
            >
              <option value="">{t("rollopts.luckyNone")}</option>
              {lucky.map((u) => (
                <option key={u.key} value={u.key} disabled={u.spent >= u.max}>
                  {u.name} ({t("common.left", { left: u.max - u.spent, total: u.max })})
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
    </Section>
  );
}
