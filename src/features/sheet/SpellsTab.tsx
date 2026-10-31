/**
 * Spellcasting: the features' DCs and attack bonuses, spell slots (and Pact Magic), the spells
 * that can be cast with their catalog details, and today's picks for choices that change after a
 * rest (prepared spells…), set in the play state. "Roll" casts a spell by hand (`rollByHand`): its
 * dice rolled, with one of the slots the engine lists for it (`slots`) spent, nothing else
 * applied.
 */

import { useMemo, useState } from "react";
import type {
  PlaySheet,
  PlaySpellLine,
  RollWhat,
  SpellDef,
  SpellSlotChoice,
} from "srd-rules-engine";
import { SrdText } from "@/components/SrdText";
import { Button, cx, Empty, Gems, Reasons, Section } from "@/components/ui";
import { abilityName } from "@/engine/constants";
import { signed, t } from "@/i18n";
import { titleCase } from "@/lib/format";
import { useTable } from "@/queries";
import { attackDm, declaredLucky, useRollAdditions } from "@/store/rolls";
import { usePlay } from "./usePlay";

export function SpellsTab({ id, sheet }: { id: string; sheet: PlaySheet }) {
  const { act, roll, reasons, busy } = usePlay(id);
  const additions = useRollAdditions((st) => st.by[id]);
  const { data: spells } = useTable<SpellDef>("spells", { character: id });
  const byId = new Map((spells ?? []).map((s) => [s.id, s]));
  const levels = [...new Set(sheet.spells.map((s) => s.level))].sort((a, b) => a - b);
  const { play } = sheet;
  // kenli F-011 T06 (AC-17): at most one description open in the whole tab.
  const [expanded, setExpanded] = useState<string | null>(null);
  const looks = useMemo(() => sourceLooks(sheet), [sheet]);
  const rows = useMemo(() => grantRows(sheet.spells), [sheet.spells]);

  return (
    <div className="space-y-4">
      <Reasons reasons={reasons} />
      {sheet.spellcasting.length > 0 && (
        <Section title={t("sheet.spellcasting")}>
          <ul className="grid gap-2 @min-[600px]:grid-cols-2">
            {sheet.spellcasting.map((sc) => (
              <li key={sc.key ?? sc.source} className="rounded border border-edge px-3 py-2">
                <div className="font-semibold">{grantLabel(sc)}</div>
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
              {rows
                .filter((r) => r.spell.level === level)
                .map(({ key, spell: s, grant, cast }) => {
                  const def = byId.get(s.id);
                  const look = looks.get(identityOf(grant)) ?? FALLBACK_LOOK;
                  const open = expanded === key;
                  const descId = `spell-desc-${key.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
                  return (
                    <li
                      key={key}
                      className={cx("rounded border border-l-4 border-edge px-2 py-1.5", look.edge)}
                      data-testid="spell-line"
                      data-spell-key={key}
                    >
                      {/* The header: the name (opens its description) and its controls beside it,
                          limited in width; the metadata on a full row below (AC-16). */}
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="flex min-w-0 flex-[1_1_9rem] flex-wrap items-baseline gap-x-2">
                          <button
                            type="button"
                            className="text-left font-semibold underline decoration-dotted underline-offset-4 hover:text-blue"
                            aria-expanded={open}
                            aria-controls={descId}
                            onClick={() => setExpanded(open ? null : key)}
                          >
                            {s.name}
                          </button>
                          {def?.concentration && (
                            <span className="text-[13px] text-purple">
                              {t("sheet.concentrationTag")}
                            </span>
                          )}
                          {def?.ritual && (
                            <span className="text-[13px] text-purple">{t("sheet.ritual")}</span>
                          )}
                        </span>
                        <span
                          className="flex max-w-full min-w-0 flex-wrap items-center justify-end gap-1"
                          data-testid="spell-controls"
                        >
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
                            spell={cast}
                            rowKey={key}
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
                                  ...(pay?.kind === "ritual"
                                    ? { payment: { type: "ritual" } }
                                    : {}),
                                  ...(spellcasting && pay?.kind !== "free" ? { spellcasting } : {}),
                                  ...attackDm(additions),
                                } as RollWhat,
                                declaredLucky(additions, sheet),
                                { command: "sheet_cast", label: s.name },
                              )
                            }
                          />
                        </span>
                      </div>
                      <div
                        className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[13px] text-ink-muted"
                        data-testid="spell-meta"
                      >
                        <span
                          className={cx("rounded border px-1.5 font-semibold", look.chip)}
                          data-testid="spell-source"
                          data-look={look.index}
                        >
                          {grantLabel(grant)}
                        </span>
                        {def && (
                          <span>
                            {`${titleCase(def.school)} · ${def.casting_time} · ${def.range} · ${def.duration}`}
                          </span>
                        )}
                      </div>
                      {open && (
                        <div id={descId} className="mt-1 border-t border-edge pt-1 text-sm">
                          {def?.description ? (
                            <SrdText text={def.description} />
                          ) : (
                            <p className="text-ink-muted italic">{t("sheet.spellNoText")}</p>
                          )}
                        </div>
                      )}
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
 * (`slots`, those with none left included and marked with the engine's reason), starting on the
 * first one left — or, when none is left, on the lowest level it can use (kenli F-011 §5.3: Cast is
 * the player's attempt; the engine refuses it and the refusal is journaled, nothing spent or
 * rolled). The spellcasting feature it's cast with is the one the engine lists for it
 * (`spellcasting`), sent with the roll; when it lists several (the same spell given twice), the
 * player picks one first: nothing is chosen for them, and Cast waits for it.
 */
export type SpellPay =
  | { readonly kind: "slot"; readonly slot: SpellSlotChoice }
  | { readonly kind: "free"; readonly use: string }
  | { readonly kind: "ritual" };

function RollSpell({
  spell,
  rowKey,
  busy,
  onRoll,
}: {
  spell: PlaySpellLine;
  /** The row's grant key (several rows can show one spell). */
  rowKey: string;
  busy: boolean;
  onRoll: (pay: SpellPay | null, spellcasting: string | null) => void;
}) {
  const key = (slot: SpellSlotChoice) => `${slot.pact ? "pact" : "slot"}:${slot.level}`;
  const first = spell.slots.find((slot) => slot.available);
  const free = spell.free.find((f) => f.available);
  // None left: the lowest slot level it can be cast with (an attempt the rules will refuse).
  const lowest = [...spell.slots].sort(
    (a, b) => a.level - b.level || Number(a.pact) - Number(b.pact),
  )[0];
  const [picked, setPicked] = useState(() =>
    first
      ? key(first)
      : free
        ? `free:${free.use}`
        : spell.ritual
          ? "ritual"
          : lowest
            ? key(lowest)
            : "",
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
  // Blocking: the spell can't be cast at all now (`blocked`), or something only the player can say
  // is missing (which spellcasting, a way to pay). A slot or free use with none left is a warning
  // next to Cast, not a lock: Cast sends the attempt (kenli F-011 §5.3).
  // review03 R03-02: `blocked` (untrained armor, Rage…) is a rule, not a missing choice: a warning
  // next to Cast, and Cast sends the attempt the engine refuses.
  let blocking: string | null = null;
  if (leveled && pay === null) blocking = spell.slots[0]?.reason?.text ?? t("sheet.chooseSlot");
  else if (pickSource) blocking = t("sheet.chooseSpellcasting");
  const picked0 =
    pay?.kind === "slot"
      ? pay.slot
      : pay?.kind === "free"
        ? spell.free.find((f) => f.use === pay.use)
        : null;
  const warning =
    blocking !== null
      ? null
      : spell.blocked
        ? spell.blocked.text
        : picked0 && !picked0.available
          ? (picked0.reason?.text ?? slotReason)
          : null;
  const reason = blocking ?? warning;
  const reasonId = `cast-${rowKey.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  return (
    <>
      {sources.length > 1 && (
        <select
          className="field w-auto max-w-[min(15rem,100%)] min-w-0 py-1 text-sm"
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
      {leveled && (
        <select
          className="field w-auto max-w-[min(15rem,100%)] min-w-0 py-1 text-sm"
          aria-label={t("sheet.castAt", { spell: spell.name })}
          value={picked}
          onChange={(e) => setPicked(e.target.value)}
        >
          {spell.slots.map((x) => (
            <option key={key(x)} value={key(x)}>
              {x.pact
                ? t("sheet.pact", { level: x.level })
                : t("sheet.slotLevel", { level: x.level })}
              {x.reason ? ` · ${x.reason.text}` : ""}
            </option>
          ))}
          {spell.free.map((f) => (
            <option key={f.use} value={`free:${f.use}`}>
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
        disabled={busy || blocking !== null}
        aria-describedby={reason ? reasonId : undefined}
        onClick={() => onRoll(leveled ? pay : null, spellcasting)}
      >
        {t("sheet.rollByHand")}
      </Button>
    </>
  );
}

/**
 * kenli F-011 T06 (AC-18), review03 R03-09: rows and looks from the engine's provenance
 * (`SpellLine.grants`, `SpellcastingLine.key`), never from display names. A row is one actual grant
 * of a spell: the same spell from Elf and from Sage is two rows; two Magic Initiates of one name
 * are two identities. A row's identity (its colour) is the spellcasting feature it's cast with
 * through that grant (`spellcasting_key`), else the grant itself; its label the source's name and,
 * when known, what granted it ("Magic Initiate · Human"). Looks follow the character's own
 * spellcasting order, then other grants in their first order; the palette, then dashed/dotted edges
 * past it; the label always shown. The same identity keeps its look in every group and render.
 */
export interface SourceLook {
  readonly index: number;
  readonly edge: string;
  readonly chip: string;
}
type Grant = PlaySpellLine["grants"][number];
const PALETTE = [
  { edge: "border-l-blue", chip: "border-blue text-blue" },
  { edge: "border-l-green", chip: "border-green text-green" },
  { edge: "border-l-purple", chip: "border-purple text-purple" },
  { edge: "border-l-orange", chip: "border-orange text-orange" },
  { edge: "border-l-red", chip: "border-red text-red" },
  { edge: "border-l-ink", chip: "border-ink text-ink" },
] as const;
const ROUNDS = ["", "[border-left-style:dashed]", "[border-left-style:dotted]"] as const;
const FALLBACK_LOOK: SourceLook = { index: -1, edge: "border-l-edge", chip: "border-edge" };

/** A spell line from an engine without grants (older): its one source as a grant. */
const grantsOf = (s: PlaySpellLine): readonly Grant[] =>
  s.grants?.length
    ? s.grants
    : [
        {
          key: s.source,
          source: s.source,
          granted_by: "",
          spellcasting: s.spellcasting?.[0] ?? null,
          spellcasting_key: null,
          always_prepared: s.always_prepared ?? false,
        },
      ];
export const identityOf = (g: Pick<Grant, "key" | "spellcasting_key">): string =>
  g.spellcasting_key ?? g.key;
export const grantLabel = (g: { source: string; granted_by?: string }): string =>
  g.granted_by ? `${g.source} · ${g.granted_by}` : g.source;

export function sourceLooks(
  sheet: Pick<PlaySheet, "spellcasting" | "spells">,
): Map<string, SourceLook> {
  const order: string[] = [];
  for (const sc of sheet.spellcasting) {
    const id = sc.key ?? sc.source;
    if (!order.includes(id)) order.push(id);
  }
  for (const sp of sheet.spells)
    for (const g of grantsOf(sp)) if (!order.includes(identityOf(g))) order.push(identityOf(g));
  const out = new Map<string, SourceLook>();
  order.forEach((id, index) => {
    const colour = PALETTE[index % PALETTE.length] as (typeof PALETTE)[number];
    const round = ROUNDS[Math.floor(index / PALETTE.length) % ROUNDS.length] as string;
    out.set(id, { index, edge: cx(colour.edge, round), chip: colour.chip });
  });
  return out;
}

/**
 * One row per grant of each spell, keyed by the grant's key and the spell (stable across renders
 * and reloads). `cast` is the line as that row casts it: through its grant's spellcasting feature
 * (none named: the engine's default), with the free casts that grant gives — or any free cast no
 * grant of the line gives, on every row. Slots stay the character's one pool. No rule is decided
 * here: these are the engine's fields, filtered by its own keys.
 */
export function grantRows(spells: readonly PlaySpellLine[]): {
  key: string;
  spell: PlaySpellLine;
  grant: Grant;
  cast: PlaySpellLine;
}[] {
  return spells.flatMap((spell) => {
    const grants = grantsOf(spell);
    const keys = new Set(grants.map((g) => g.key));
    return grants.map((grant) => ({
      key: `${grant.key}|${spell.id}`,
      spell,
      grant,
      cast: {
        ...spell,
        spellcasting: grant.spellcasting === null ? [] : [grant.spellcasting],
        free: spell.free.filter(
          (f) =>
            f.source_key === undefined || f.source_key === grant.key || !keys.has(f.source_key),
        ),
      },
    }));
  });
}
