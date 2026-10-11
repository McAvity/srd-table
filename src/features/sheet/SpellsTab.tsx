/**
 * Spellcasting: the features' DCs and attack bonuses, spell slots (and Pact Magic), the spells
 * that can be cast with their catalog details, and today's picks for choices that change after a
 * rest (prepared spells…), set in the play state. "Roll" casts a spell by hand (`rollByHand`): its
 * dice rolled, its slot spent, nothing else applied. The slot levels offered are the sheet's own
 * (the engine refuses one the spell can't use: engine gap R23).
 */

import { useState } from "react";
import type { PlaySheet, SpellDef, SpellLine } from "srd-rules-engine";
import { Button, Empty, Gems, Reasons, Section } from "@/components/ui";
import { abilityName } from "@/engine/constants";
import { signed, t } from "@/i18n";
import { titleCase } from "@/lib/format";
import { useTable } from "@/queries";
import { MoreText } from "../builder/ChoiceCard";
import { usePlay } from "./usePlay";

export function SpellsTab({ id, sheet }: { id: string; sheet: PlaySheet }) {
  const { act, roll, reasons, busy } = usePlay(id);
  const { data: spells } = useTable<SpellDef>("spells");
  const byId = new Map((spells ?? []).map((s) => [s.id, s]));
  const levels = [...new Set(sheet.spells.map((s) => s.level))].sort((a, b) => a - b);
  const { play } = sheet;

  return (
    <div className="space-y-4">
      <Reasons reasons={reasons} />
      {sheet.spellcasting.length > 0 && (
        <Section title={t("sheet.spellcasting")}>
          <ul className="grid gap-2 sm:grid-cols-2">
            {sheet.spellcasting.map((sc) => (
              <li key={sc.source} className="rounded border border-edge px-3 py-2">
                <div className="font-semibold">{sc.source}</div>
                <div className="text-sm text-ink-muted">
                  {sc.ability ? abilityName(sc.ability) : "—"}
                  {sc.save_dc !== null && ` · ${t("sheet.saveDc")} ${sc.save_dc}`}
                  {sc.attack_bonus !== null &&
                    ` · ${t("sheet.spellAttack")} ${signed(sc.attack_bonus)}`}
                </div>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {(play.spell_slots.length > 0 || play.pact_magic) && (
        <Section title={t("sheet.slots")}>
          <ul className="space-y-2">
            {play.spell_slots.map((slot) => (
              <li key={slot.level} className="flex items-center gap-3">
                <span className="w-20 text-sm text-ink-muted">
                  {t("sheet.slotLevel", { level: slot.level })}
                </span>
                <div className="flex-1">
                  <Gems
                    total={slot.total}
                    spent={slot.spent}
                    label={t("sheet.slotLevel", { level: slot.level })}
                    onSpend={() => void act({ type: "spend_slot", level: slot.level })}
                    onRestore={() => void act({ type: "restore_slot", level: slot.level })}
                  />
                </div>
              </li>
            ))}
            {play.pact_magic && (
              <li className="flex items-center gap-3">
                <span className="w-20 text-sm text-ink-muted">
                  {t("sheet.pact", { level: play.pact_magic.slot_level })}
                </span>
                <div className="flex-1">
                  <Gems
                    total={play.pact_magic.slots}
                    spent={play.pact_magic.spent}
                    label={t("sheet.pact", { level: play.pact_magic.slot_level })}
                    onSpend={() => void act({ type: "spend_pact_slot" })}
                    onRestore={() => void act({ type: "restore_pact_slot" })}
                  />
                </div>
              </li>
            )}
          </ul>
        </Section>
      )}

      {sheet.spells.length === 0 ? (
        <Empty icon="sparkle">{t("sheet.noSpells")}</Empty>
      ) : (
        levels.map((level) => (
          <Section
            key={level}
            title={level === 0 ? t("sheet.cantrips") : t("sheet.spellLevel", { level })}
          >
            <ul className="space-y-1.5">
              {sheet.spells
                .filter((s) => s.level === level)
                .map((s) => {
                  const def = byId.get(s.id);
                  return (
                    <li
                      key={`${s.id}|${s.source}`}
                      className="flex items-center gap-2 rounded border border-edge px-2 py-1.5"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-baseline gap-x-2">
                          <span className="font-semibold">{s.name}</span>
                          {def?.concentration && (
                            <span className="text-[13px] text-purple">
                              {t("sheet.concentrationTag")}
                            </span>
                          )}
                          {def?.ritual && (
                            <span className="text-[13px] text-purple">{t("sheet.ritual")}</span>
                          )}
                        </div>
                        <div className="text-[13px] text-ink-muted">
                          {def
                            ? `${titleCase(def.school)} · ${def.casting_time} · ${def.range} · ${def.duration}`
                            : ""}
                          {` · ${s.source}`}
                        </div>
                      </div>
                      {def?.concentration && (
                        <Button
                          size="sm"
                          icon="concentration"
                          iconOnly
                          label={`${t("sheet.concentration")}: ${s.name}`}
                          on={play.concentration === s.name}
                          onClick={() => void act({ type: "set_concentration", spell: s.name })}
                        />
                      )}
                      <RollSpell
                        spell={s}
                        sheet={sheet}
                        busy={busy}
                        onRoll={(slot) =>
                          void roll({
                            type: "cast",
                            spell: s.id,
                            ...(slot === "pact"
                              ? { pact: true }
                              : slot
                                ? { slot_level: Number(slot) }
                                : {}),
                          })
                        }
                      />
                      {def?.description && <MoreText title={s.name} text={def.description} />}
                    </li>
                  );
                })}
            </ul>
          </Section>
        ))
      )}
    </div>
  );
}

/**
 * Cast by hand: a cantrip at once; a spell with a slot level picked from the sheet's slots
 * (starting on the spell's own level when the sheet has it, else the first) and its Pact Magic
 * slot.
 */
function RollSpell({
  spell,
  sheet,
  busy,
  onRoll,
}: {
  spell: SpellLine;
  sheet: PlaySheet;
  busy: boolean;
  onRoll: (slot: string) => void;
}) {
  const { play } = sheet;
  const levels = play.spell_slots.map((slot) => String(slot.level));
  const [slot, setSlot] = useState(() =>
    levels.includes(String(spell.level))
      ? String(spell.level)
      : (levels[0] ?? (play.pact_magic ? "pact" : "")),
  );
  const leveled = spell.level > 0 && (levels.length > 0 || play.pact_magic !== null);
  return (
    <>
      {leveled && (
        <select
          className="field w-auto py-1 text-sm"
          aria-label={t("sheet.castAt", { spell: spell.name })}
          value={slot}
          onChange={(e) => setSlot(e.target.value)}
        >
          {play.spell_slots.map((s) => (
            <option key={s.level} value={String(s.level)}>
              {t("sheet.slotLevel", { level: s.level })}
            </option>
          ))}
          {play.pact_magic && (
            <option value="pact">{t("sheet.pact", { level: play.pact_magic.slot_level })}</option>
          )}
        </select>
      )}
      <Button
        size="sm"
        icon="d20"
        title={t("sheet.rollSpellHint")}
        disabled={busy}
        onClick={() => onRoll(leveled ? slot : "")}
      >
        {t("sheet.rollByHand")}
      </Button>
    </>
  );
}
