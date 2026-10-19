/**
 * Spellcasting: the features' DCs and attack bonuses, spell slots (and Pact Magic), the spells
 * that can be cast with their catalog details, and today's picks for choices that change after a
 * rest (prepared spells…), set in the play state. "Roll" casts a spell by hand (`rollByHand`): its
 * dice rolled, with one of the slots the engine lists for it (`slots`) spent, nothing else
 * applied.
 */

import { useState } from "react";
import type {
  PlaySheet,
  PlaySpellLine,
  RollWhat,
  SpellDef,
  SpellSlotChoice,
} from "srd-rules-engine";
import { Button, Empty, Gems, Reasons, Section } from "@/components/ui";
import { abilityName } from "@/engine/constants";
import { signed, t } from "@/i18n";
import { titleCase } from "@/lib/format";
import { useTable } from "@/queries";
import { attackDm, declaredLucky, useRollAdditions } from "@/store/rolls";
import { MoreText } from "../builder/ChoiceCard";
import { usePlay } from "./usePlay";

export function SpellsTab({ id, sheet }: { id: string; sheet: PlaySheet }) {
  const { act, roll, reasons, busy } = usePlay(id);
  const additions = useRollAdditions((st) => st.by[id]);
  const { data: spells } = useTable<SpellDef>("spells", { character: id });
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
                        busy={busy}
                        onRoll={(pay, spellcasting) =>
                          void roll(
                            {
                              type: "cast",
                              spell: s.id,
                              ...(pay?.kind === "slot" ? { slot_level: pay.slot.level } : {}),
                              ...(pay?.kind === "slot" && pay.slot.pact ? { pact: true } : {}),
                              ...(pay?.kind === "free"
                                ? { payment: { type: "free", use: pay.use } }
                                : {}),
                              ...(pay?.kind === "ritual" ? { payment: { type: "ritual" } } : {}),
                              ...(spellcasting && pay?.kind !== "free" ? { spellcasting } : {}),
                              ...attackDm(additions),
                            } as RollWhat,
                            declaredLucky(additions, sheet),
                          )
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
 * Cast by hand: a cantrip at once; a spell with one of the slots the engine lists for it
 * (`slots`: those with none left disabled, with the engine's reason), starting on the first one
 * left. With none left, Roll is disabled and the reason shown next to it. The spellcasting
 * feature it's cast with is the one the engine lists for it (`spellcasting`), sent with the roll;
 * when it lists several (the same spell given twice), the player picks one first: nothing is
 * chosen for them.
 */
export type SpellPay =
  | { readonly kind: "slot"; readonly slot: SpellSlotChoice }
  | { readonly kind: "free"; readonly use: string }
  | { readonly kind: "ritual" };

function RollSpell({
  spell,
  busy,
  onRoll,
}: {
  spell: PlaySpellLine;
  busy: boolean;
  onRoll: (pay: SpellPay | null, spellcasting: string | null) => void;
}) {
  const key = (slot: SpellSlotChoice) => `${slot.pact ? "pact" : "slot"}:${slot.level}`;
  const first = spell.slots.find((slot) => slot.available);
  const free = spell.free.find((f) => f.available);
  const [picked, setPicked] = useState(() =>
    first ? key(first) : free ? `free:${free.use}` : spell.ritual ? "ritual" : "",
  );
  const slot = spell.slots.find((x) => key(x) === picked) ?? null;
  const pay: SpellPay | null = picked.startsWith("free:")
    ? { kind: "free", use: picked.slice(5) }
    : picked === "ritual"
      ? { kind: "ritual" }
      : slot
        ? { kind: "slot", slot }
        : null;
  const leveled = spell.slots.length > 0;
  const sources = spell.spellcasting;
  const [castWith, setCastWith] = useState<string | null>(null);
  const spellcasting = sources.length === 1 ? (sources[0] ?? null) : castWith;
  // Nothing to cast it with: the first slot's reason (they all say the same thing), unless a free
  // cast or a ritual still can.
  const otherWay = Boolean(free) || spell.ritual;
  const slotReason = leveled && !first && !otherWay ? (spell.slots[0]?.reason?.text ?? null) : null;
  const pickSource = sources.length > 1 && spellcasting === null && pay?.kind !== "free";
  let reason: string | null = null;
  if (spell.blocked) reason = spell.blocked.text;
  else if (slotReason) reason = slotReason;
  else if (leveled && pay === null) reason = spell.slots[0]?.reason?.text ?? null;
  else if (pickSource) reason = t("sheet.chooseSpellcasting");
  const reasonId = `cast-${spell.id}-${spell.source}`;
  return (
    <>
      {sources.length > 1 && (
        <select
          className="field w-auto py-1 text-sm"
          aria-label={t("sheet.castWith", { spell: spell.name })}
          value={castWith ?? ""}
          onChange={(e) => setCastWith(e.target.value || null)}
        >
          <option value="">{t("sheet.castWithPick")}</option>
          {sources.map((source) => (
            <option key={source} value={source}>
              {source}
            </option>
          ))}
        </select>
      )}
      {leveled && (first || otherWay) && (
        <select
          className="field w-auto py-1 text-sm"
          aria-label={t("sheet.castAt", { spell: spell.name })}
          value={picked}
          onChange={(e) => setPicked(e.target.value)}
        >
          {spell.slots.map((x) => (
            <option key={key(x)} value={key(x)} disabled={!x.available}>
              {x.pact
                ? t("sheet.pact", { level: x.level })
                : t("sheet.slotLevel", { level: x.level })}
              {x.reason ? ` · ${x.reason.text}` : ""}
            </option>
          ))}
          {spell.free.map((f) => (
            <option key={f.use} value={`free:${f.use}`} disabled={!f.available}>
              {t("sheet.castFree", { use: f.name })}
              {f.reason
                ? ` · ${f.reason.text}`
                : ` · ${t("common.left", { left: f.left, total: f.left })}`}
            </option>
          ))}
          {spell.ritual && <option value="ritual">{t("sheet.castRitual")}</option>}
        </select>
      )}
      {reason && (
        <span id={reasonId} className="text-[13px] text-ink-muted italic">
          {reason}
        </span>
      )}
      <Button
        size="sm"
        icon="d20"
        title={t("sheet.rollSpellHint")}
        disabled={busy || reason !== null}
        aria-describedby={reason ? reasonId : undefined}
        onClick={() => onRoll(leveled ? pay : null, spellcasting)}
      >
        {t("sheet.rollByHand")}
      </Button>
    </>
  );
}
