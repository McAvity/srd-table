/**
 * Completes an option before sending it: targets (from its `TargetSpec`, also pickable on the
 * map), a slot level, an area's point or direction (the engine's `previewArea` shows its squares
 * and the creatures in it), a wall's ends, Advantage, riders, cover, a skill for a check. It
 * starts from the engine's ready-to-send action and only fills in fields; whether the result is
 * legal is the engine's dry run (`checkAction`), shown before sending, with the option's odds.
 * It's sent the way the quick bar's Play switch says (automatic or by hand); the other way is the
 * second button ("By hand" sends at once, "Automatic" shows the targets to pick). By hand it asks
 * only what the engine still reads: a slot level, Advantage, riders, strike effects, a damage
 * type; it's rolled and paid (`rollAndPay`). In the GM's view a refused action the engine can
 * override (its dry run with `force`), or a roll by hand whose costs can't be paid, gets "Do it
 * anyway", sent with `force: true`; the log notes the override.
 */

import { useEffect, useMemo, useState } from "react";
import type {
  AreaRequest,
  CombatantOptions,
  DamageType,
  EncounterAction,
  OptionEntry,
  PlaySheet,
  Skill,
  SpellDef,
  StrikeOption,
} from "srd-rules-engine";
import { Icon } from "@/components/Icon";
import { Button, cx, Reasons } from "@/components/ui";
import { constants, skillName, skills } from "@/engine/constants";
import type { EncounterView } from "@/engine/facade";
import { formatNumber, t } from "@/i18n";
import { titleCase } from "@/lib/format";
import { useActionCheck, useAreaPreview, useEntry, usePlayView, useSquaresWithin } from "@/queries";
import { useDocuments } from "@/store/documents";
import type { PlayWay } from "@/store/settings";
import { byHandReasons, incompleteRefusal, playedAs } from "./manual";
import { useTableUi } from "./tableUi";

type Mode = "normal" | "advantage" | "disadvantage";
type Cover = "half" | "three_quarters" | "total";
type Square = { x: number; y: number };
const NONE: readonly string[] = [];

const COMPOSED: ReadonlySet<EncounterAction["type"]> = new Set([
  "attack",
  "cast",
  "help",
  "unarmed",
  "search",
  "study",
  "influence",
  "utilize",
  "ready",
  "move_mark",
]);

/** Does this option need anything filled in before it can be sent? */
export function needsComposer(entry: OptionEntry, sheet?: PlaySheet | null): boolean {
  if (entry.targets && entry.targets.kind !== "self") return true;
  // kenli F-002 T12 B1: a feature paid with a spell slot (Wild Resurgence) or taking a form.
  const a = entry.action;
  if (a.type === "feature" && sheet) {
    const line = sheet.actions.find((x) => x.key === a.feature);
    if (line?.slot_payment || line?.shape) return true;
  }
  if (entry.slot_levels.length > 1 || entry.pact_slot !== null) return true;
  // kenli F-002 T12 (review14 R14-02): a free cast or a slot is the player's choice.
  if (entry.free_casts?.length && (entry.slot_levels.length || entry.free_casts.length > 1))
    return true;
  // kenli F-011 (review03 R03-02): a leveled spell's slot is the player's choice — every legal level,
  // spent ones included — so it's picked in the form, never assumed.
  if (entry.action.type === "cast" && (entry.action.slot_level ?? 0) > 0) return true;
  return COMPOSED.has(entry.action.type);
}

/** `65%` for a probability. */
function percent(p: number): string {
  return `${Math.round(p * 100)}%`;
}

/** The option's odds against its first target, as the engine works them out. */
export function oddsText(entry: OptionEntry): string | null {
  const odds = entry.odds;
  if (!odds) return null;
  const parts = [
    odds.hit !== null ? t("table.oddsHit", { p: percent(odds.hit) }) : null,
    odds.critical !== null && odds.critical > 0
      ? t("table.oddsCrit", { p: percent(odds.critical) })
      : null,
    odds.fail_save !== null ? t("table.oddsFail", { p: percent(odds.fail_save) }) : null,
    odds.average_damage !== null
      ? t("table.oddsDamage", { n: formatNumber(Math.round(odds.average_damage * 10) / 10) })
      : null,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

export function ActionComposer({
  encounterId,
  view,
  options,
  entry,
  way,
  gm,
  onClose,
}: {
  encounterId: string;
  view: EncounterView;
  options: CombatantOptions;
  entry: OptionEntry;
  way: PlayWay;
  gm: boolean;
  onClose: () => void;
}) {
  const send = useDocuments((s) => s.encounterAction);
  const rollAndPay = useDocuments((s) => s.rollAndPay);
  const setHighlight = useTableUi((s) => s.setHighlight);
  const aim = useTableUi((s) => s.aim);
  const base = entry.action;
  const spec = entry.targets;
  const actor = view.combatants.find((c) => c.id === options.id);
  const name = (id: string) => view.combatants.find((c) => c.id === id)?.name ?? id;

  const [targets, setTargets] = useState<string[]>(() => initialTargets(base));
  const [slot, setSlot] = useState<string>(() => defaultSlot(entry));
  const [mode, setMode] = useState<Mode>("normal");
  const [cover, setCover] = useState<Cover | "">("");
  const [riders, setRiders] = useState<string[]>([]);
  /** Riders picked in their once-per-turn alternative form (Relentless's die, no use spent). */
  const [alternatives, setAlternatives] = useState<string[]>([]);
  /** Tactical Master: a mastery property instead of the weapon's own (the engine's list). */
  const [masteryAs, setMasteryAs] = useState("");
  /** Cunning / Brutal Strike effects picked, as `send:id` keys. */
  const [strikes, setStrikes] = useState<string[]>([]);
  const [twoHanded, setTwoHanded] = useState(false);
  const [damageType, setDamageType] = useState("");
  const [featurePay, setFeaturePay] = useState("");
  const [featureForm, setFeatureForm] = useState("");
  const [skill, setSkill] = useState(() =>
    "skill" in base && typeof base.skill === "string" ? base.skill : "",
  );
  const [dc, setDc] = useState("");
  const [text, setText] = useState("");
  const [readied, setReadied] = useState(0);
  const [placement, setPlacement] = useState<Square | null>(null);
  const [wall, setWall] = useState<{
    from: Square | null;
    to: Square | null;
    side: "" | "left" | "right";
  }>({
    from: null,
    to: null,
    side: "",
  });
  const [unaffected, setUnaffected] = useState<string[]>([]);
  /** kenli F-002 T12 (D016): what this cast does to a tracked pool (Arcane Ward), by trigger key. */
  const [castModes, setCastModes] = useState<Record<string, "" | "create" | "restore">>({});
  /** kenli F-002 T12 B2a: Metamagic picked (sheet keys), Heightened's target, Careful's targets. */
  const [castOptions, setCastOptions] = useState<string[]>([]);
  const [heightened, setHeightened] = useState("");
  const [careful, setCareful] = useState<string[]>([]);
  const [reasons, setReasons] = useState<readonly string[] | null>(null);
  const [busy, setBusy] = useState(false);
  /** The way it's played: by hand there are no targets, areas or cover to pick. */
  const [as, setAs] = useState<PlayWay>(way);
  const byHand = as === "manual" && entry.rollable;

  // Riders and Versatile damage come from the character's attack line.
  const play = usePlayView(actor?.character ?? undefined);
  // kenli F-011 §5.3 (review03 R03-02): every slot level the spell can legally use, those with none
  // left included (the engine's play sheet lists them with their reason); casting with one is the
  // player's attempt, refused and journaled. A monster has no sheet: the option's own levels.
  const slotChoices =
    base.type === "cast"
      ? (play.data?.sheet.spells.find((s) => s.id === base.spell)?.slots ?? null)
      : null;
  const freeCasts = entry.free_casts ?? [];
  const line =
    base.type === "attack"
      ? play.data?.sheet.attacks.find((a) => a.name === base.attack)
      : undefined;
  const spell = useEntry<SpellDef>("spells", base.type === "cast" ? base.spell : null).data ?? null;
  // kenli F-002 T12 (D016): the character's cast triggers of this spell's school (the engine checks
  // the slot and the pool and refuses what can't be).
  const castTriggers =
    base.type === "cast" && spell && spell.level > 0
      ? (play.data?.sheet.cast_triggers ?? []).filter((tr) => tr.school === spell.school)
      : [];
  const triggered = castTriggers.flatMap((tr) => {
    const mode = castModes[tr.key] ?? "";
    return mode ? [{ key: tr.key, mode }] : [];
  });
  // kenli F-002 T12 B1: an attack line's other damage types (Lunar Radiance, Exceptional Training).
  const damageTypes =
    base.type === "attack"
      ? (line?.damage_types?.length ?? 0) > 1
        ? (line?.damage_types ?? [])
        : []
      : (spell?.mechanics?.damage_types ?? []);
  // kenli F-002 T12 B1: a feature paid with a spell slot (Wild Resurgence) or taking a form.
  const featureLine =
    base.type === "feature"
      ? play.data?.sheet.actions.find((a) => a.key === base.feature)
      : undefined;
  const featureSlots = featureLine?.slot_payment
    ? [
        ...(play.data?.sheet.play.spell_slots ?? []).map((x) => ({
          value: `slot:${x.level}`,
          label: t("sheet.slotLevel", { level: x.level }),
          left: x.total - x.spent,
          total: x.total,
        })),
        ...(play.data?.sheet.play.pact_magic
          ? [
              {
                value: "pact",
                label: t("table.pactSlot", { level: play.data.sheet.play.pact_magic.slot_level }),
                left: play.data.sheet.play.pact_magic.slots - play.data.sheet.play.pact_magic.spent,
                total: play.data.sheet.play.pact_magic.slots,
              },
            ]
          : []),
      ]
    : [];
  const featureForms = featureLine?.shape?.forms ?? [];
  const designate = spell?.mechanics?.zone?.designate === true;
  const wallDef = spell?.mechanics?.wall ?? null;
  // Without positions an area can't be aimed: the caller names who's in it (`targets`).
  const area = !byHand && spec?.kind === "area" && actor?.position ? spec.area : null;
  const pickCreatures =
    !byHand &&
    !wallDef &&
    (spec?.kind === "creature" || (spec?.kind === "area" && !actor?.position));
  const areaMode: "point" | "toward" | null = area
    ? area.shape === "cone" || area.shape === "line"
      ? "toward"
      : area.shape === "emanation"
        ? null
        : "point"
    : null;
  const checkSkills = constants().check_skills[base.type];
  // Ready: the action taken later is one of the combatant's own options of those kinds.
  const readyChoices = useMemo(
    () =>
      base.type === "ready"
        ? [...options.attacks, ...options.spells, ...options.standard].filter((o) =>
            ["attack", "unarmed", "cast", "move", "help"].includes(o.action.type),
          )
        : [],
    [base.type, options],
  );

  // What an aimed area would cover, from the engine.
  const areaRequest: AreaRequest | null =
    areaMode && placement ? areaRequestFor(base, options.id, { [areaMode]: placement }) : null;
  const preview = useAreaPreview(encounterId, areaRequest);
  const within = useSquaresWithin(
    encounterId,
    actor?.position ? options.id : null,
    spec?.range ?? null,
  );
  const previewSquares = useMemo(
    () => (preview.data?.ok ? preview.data.squares.map((p) => `${p.x},${p.y}`) : null),
    [preview.data],
  );
  const squares = previewSquares ?? within.data ?? NONE;
  useEffect(() => {
    setHighlight(
      squares,
      preview.data?.ok ? preview.data.targets.map((x) => x.id) : (spec?.ids ?? NONE),
    );
  }, [squares, preview.data, spec?.ids, setHighlight]);
  useEffect(
    () => () => {
      setHighlight([], []);
      aim(null);
    },
    [setHighlight, aim],
  );

  const action = useMemo(
    () =>
      compose(base, {
        targets,
        slot,
        mode,
        cover,
        riders,
        alternatives,
        masteryAs,
        strikes: entry.strikes.filter((x) => strikes.includes(`${x.send}:${x.id}`)),
        twoHanded,
        damageType,
        skill,
        dc,
        text,
        readied: readyChoices[readied]?.action ?? null,
        area: areaMode && placement ? { [areaMode]: placement } : null,
        point: spec?.kind === "point" ? placement : null,
        wall:
          wall.from && wall.to
            ? { from: wall.from, to: wall.to, ...(wall.side ? { side: wall.side } : {}) }
            : null,
        unaffected,
        triggers: triggered,
        castOptions,
        heightened,
        careful,
        featurePay,
        featureForm,
      }),
    [
      base,
      targets,
      slot,
      mode,
      cover,
      riders,
      alternatives,
      masteryAs,
      strikes,
      entry.strikes,
      twoHanded,
      damageType,
      skill,
      dc,
      text,
      readyChoices,
      readied,
      areaMode,
      placement,
      spec?.kind,
      wall,
      unaffected,
      triggered,
      castOptions,
      heightened,
      careful,
      featurePay,
      featureForm,
    ],
  );
  const played = playedAs(action, as, entry.rollable);
  const check = useActionCheck(encounterId, played);
  const refused = check.data?.ok === false;
  // kenli F-011 §5.3 (review03 R03-02): Send waits only for what the player still has to say (a
  // target, a missing choice); a complete command the rules refuse is sent as the player's attempt.
  const incomplete = refused && incompleteRefusal(check.data?.codes ?? []);
  // A roll by hand is free; its costs are paid with `spend`, which `force` overrides instead.
  const forced = useActionCheck(
    encounterId,
    gm && refused && played.type !== "roll"
      ? ({ ...played, force: true } as EncounterAction)
      : null,
  );
  /** The action whose roll by hand was refused for costs it can't pay (the GM can force it). */
  const [unpaidFor, setUnpaidFor] = useState<EncounterAction | null>(null);
  const forceable = gm && ((refused && forced.data?.ok === true) || unpaidFor === action);
  const otherWay: PlayWay | null = entry.rollable ? (as === "auto" ? "manual" : "auto") : null;

  const startAiming = () => {
    if (!area || !areaMode) return;
    aim({ actor: options.id, area, mode: areaMode, onPick: (square) => setPlacement(square) });
  };
  const aimWall = () => {
    if (!wallDef) return;
    aim({
      actor: options.id,
      area: { shape: "line", size: wallDef.length, width: 5 },
      mode: "toward",
      corner: wallDef.between,
      onPick: (square) =>
        setWall((w) => (!w.from || w.to ? { ...w, from: square, to: null } : { ...w, to: square })),
    });
  };
  const aimPoint = () => {
    aim({
      actor: options.id,
      area: { shape: "cube", size: 5, width: 5 },
      mode: "point",
      onPick: (square) => setPlacement(square),
    });
  };

  const toggleTarget = (id: string) => {
    const max = spec?.count ?? Number.POSITIVE_INFINITY;
    setTargets((current) => {
      if (max === 1) return [id];
      if (current.includes(id) && max === Number.POSITIVE_INFINITY)
        return current.filter((x) => x !== id);
      // Beams and darts can go at the same target more than once: add until the count is reached.
      if (current.length >= max) return [...current.slice(1), id];
      return [...current, id];
    });
  };

  // A target picked on the map while composing.
  useEffect(() => {
    useTableUi.setState({ onToken: pickCreatures ? toggleTarget : null });
    return () => useTableUi.setState({ onToken: null });
  });

  async function go(as: PlayWay, force = false) {
    setBusy(true);
    try {
      const played = playedAs(action, as, entry.rollable);
      // kenli F-011: the player's explicit command (forced by the GM: not a refusal to journal).
      const attempt = force
        ? null
        : {
            command:
              played.type === "roll" ? ("encounter_roll" as const) : ("encounter_action" as const),
            label: entry.label,
          };
      const result = await (played.type === "roll"
        ? rollAndPay(encounterId, played, force, attempt)
        : send(
            encounterId,
            force ? ({ ...played, force: true } as EncounterAction) : played,
            attempt,
          ));
      if (result.ok) onClose();
      else {
        setAs(as);
        setReasons(result.reasons);
        setUnpaidFor("unpaid" in result ? action : null);
      }
    } finally {
      setBusy(false);
    }
  }

  const allIds = pickCreatures && spec ? orderedCandidates(spec.ids, view) : [];
  const odds = byHand ? null : oddsText(entry);

  return (
    <section
      data-composer
      aria-label={entry.label}
      className="panel rise-in max-h-[60vh] overflow-y-auto border-ink p-3 shadow-panel"
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <header className="mb-3 flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="font-display text-xl text-ink">{entry.label}</h3>
          <p className="text-sm text-ink-muted">
            {entry.note ?? `${actor?.name ?? ""} · ${t(`table.cost.${entry.cost}`)}`}
          </p>
          {odds && (
            <p className="text-sm font-bold text-ink">
              {entry.odds && `${name(entry.odds.target)}: `}
              {odds}
            </p>
          )}
        </div>
        <Button variant="ghost" icon="x" iconOnly label={t("common.cancel")} onClick={onClose} />
      </header>
      <div className="space-y-4">
        {pickCreatures && spec && (
          <fieldset>
            <legend className="mb-1 text-sm text-ink-muted">
              {spec.count === 1
                ? t("table.chooseTarget")
                : spec.count
                  ? t("table.chooseTargets", { count: spec.count })
                  : t("table.chooseTargetsAny")}
              {spec.range !== null && ` · ${spec.range} ft`}
            </legend>
            {allIds.length === 0 ? (
              <p className="text-sm text-ink-muted">{t("table.noTargets")}</p>
            ) : (
              <ul className="grid gap-1.5 @min-[600px]:grid-cols-2">
                {allIds.map(({ id, inRange }) => {
                  const c = view.combatants.find((x) => x.id === id);
                  const times = targets.filter((x) => x === id).length;
                  return (
                    <li key={id}>
                      <button
                        type="button"
                        aria-pressed={times > 0}
                        onClick={() => toggleTarget(id)}
                        className={cx("btn w-full !justify-start", !inRange && "opacity-60")}
                        data-on={times > 0 ? "true" : undefined}
                      >
                        <Icon name={times > 0 ? "target" : "user"} size={16} />
                        <span className="flex-1 text-left">
                          {c?.name ?? id}
                          {c && (gm || c.character) && (
                            <span className="ml-2 text-[13px] text-ink-muted">
                              {c.hp}/{c.max_hp} · AC {c.armor_class}
                            </span>
                          )}
                        </span>
                        {times > 1 && <span className="font-bold">×{times}</span>}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </fieldset>
        )}

        {area && !wallDef && (
          <div className="space-y-2">
            <p className="text-sm text-ink-muted">
              {titleCase(area.shape)} · {area.size} ft{areaMode ? ` · ${t("table.areaPick")}` : ""}
            </p>
            {areaMode && (
              <div className="flex flex-wrap items-end gap-2">
                <Button icon="target" onClick={startAiming}>
                  {areaMode === "point" ? t("table.areaPoint") : t("table.areaToward")}
                </Button>
                <SquareInput value={placement} onChange={setPlacement} />
              </div>
            )}
            {preview.data && !preview.data.ok && <Reasons reasons={preview.data.reasons} />}
            {preview.data?.ok && (
              <p className="text-sm">
                <span className="text-ink-muted">{t("table.areaCovers")}: </span>
                {preview.data.targets.length
                  ? preview.data.targets
                      .map((x) =>
                        x.cover === "none"
                          ? name(x.id)
                          : `${name(x.id)} (${t(`table.cover.${x.cover}`)})`,
                      )
                      .join(", ")
                  : t("common.none")}
                {preview.data.total_cover.length > 0 &&
                  ` · ${t("table.cover.total")}: ${preview.data.total_cover.map(name).join(", ")}`}
              </p>
            )}
          </div>
        )}

        {wallDef && !byHand && (
          <div className="space-y-2">
            <p className="text-sm text-ink-muted">
              {t("table.wallHint", { feet: wallDef.length })}
              {wallDef.between ? ` ${t("table.wallCorners")}` : ""}
            </p>
            <div className="flex flex-wrap items-end gap-2">
              <Button icon="wall" onClick={aimWall}>
                {t("table.wallPlace")}
              </Button>
              <span className="text-sm">
                {wall.from ? `(${wall.from.x}, ${wall.from.y})` : "—"} →{" "}
                {wall.to ? `(${wall.to.x}, ${wall.to.y})` : "—"}
              </span>
              {wallDef.side !== null && (
                <label className="flex flex-col text-[13px] text-ink-muted">
                  {t("table.wallSide")}
                  <select
                    className="field w-auto"
                    value={wall.side}
                    onChange={(e) =>
                      setWall({ ...wall, side: e.target.value as "" | "left" | "right" })
                    }
                  >
                    <option value="">—</option>
                    <option value="left">{t("table.left")}</option>
                    <option value="right">{t("table.right")}</option>
                  </select>
                </label>
              )}
            </div>
          </div>
        )}

        {spec?.kind === "point" && !byHand && (
          <div className="flex flex-wrap items-end gap-2">
            <Button icon="target" onClick={aimPoint}>
              {t("table.areaPoint")}
            </Button>
            <SquareInput value={placement} onChange={setPlacement} />
          </div>
        )}

        {(slotChoices?.length ||
          entry.slot_levels.length > 0 ||
          entry.pact_slot !== null ||
          freeCasts.length > 0) && (
          <label className="flex flex-col gap-1 text-sm">
            {t("table.slotLevel")}
            <select
              className="field max-w-xs"
              value={slot}
              onChange={(e) => setSlot(e.target.value)}
            >
              {/* kenli F-002 T12 (review14 R14-02): a free cast (Mystic Arcanum, Spell Mastery, a
                  feature's spell) pays no slot; the engine charges its use or refuses it. */}
              {freeCasts.map((f) => (
                <option key={`free:${f.use}`} value={`free:${f.use}`} data-testid="cast-free">
                  {f.at_will
                    ? t("table.freeCastAtWill", { name: f.name })
                    : t("table.freeCast", { name: f.name, left: f.left })}
                </option>
              ))}
              {slotChoices?.length ? (
                slotChoices.map((x) => (
                  <option key={`${x.pact}:${x.level}`} value={x.pact ? "pact" : String(x.level)}>
                    {x.pact
                      ? t("table.pactSlot", { level: x.level })
                      : t("sheet.slotLevel", { level: x.level })}
                    {x.reason ? ` · ${x.reason.text}` : ""}
                  </option>
                ))
              ) : (
                <>
                  {entry.slot_levels.map((l) => (
                    <option key={l} value={String(l)}>
                      {t("sheet.slotLevel", { level: l })}
                    </option>
                  ))}
                  {entry.pact_slot !== null && (
                    <option value="pact">{t("table.pactSlot", { level: entry.pact_slot })}</option>
                  )}
                </>
              )}
            </select>
          </label>
        )}

        {base.type === "cast" && (play.data?.sheet.cast_options.length ?? 0) > 0 && (
          <fieldset className="flex flex-col gap-1 text-sm" data-testid="composer-cast-options">
            <legend>{t("table.castOptions")}</legend>
            {(play.data?.sheet.cast_options ?? []).map((o) => (
              <label key={o.key} className="inline-flex items-center gap-1">
                <input
                  type="checkbox"
                  data-testid="composer-cast-option"
                  checked={castOptions.includes(o.key)}
                  onChange={(e) =>
                    setCastOptions(
                      e.target.checked
                        ? [...castOptions, o.key]
                        : castOptions.filter((k) => k !== o.key),
                    )
                  }
                />
                {t("sheet.castOption", { option: o.name, cost: o.cost })}
              </label>
            ))}
            {castOptions.some(
              (k) =>
                play.data?.sheet.cast_options.find((o) => o.key === k)?.effect === "heightened",
            ) && (
              <label className="flex flex-col gap-1">
                {t("table.heightenedTarget")}
                <select
                  className="field max-w-xs"
                  value={heightened}
                  data-testid="heightened-target"
                  onChange={(e) => setHeightened(e.target.value)}
                >
                  <option value="">—</option>
                  {targets.map((id) => (
                    <option key={id} value={id}>
                      {name(id)}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {castOptions.some(
              (k) => play.data?.sheet.cast_options.find((o) => o.key === k)?.effect === "careful",
            ) && (
              <fieldset className="flex flex-col gap-1" data-testid="careful-targets">
                <legend>{t("table.carefulTargets")}</legend>
                {targets.map((id) => (
                  <label key={id} className="inline-flex items-center gap-1">
                    <input
                      type="checkbox"
                      data-testid="careful-target"
                      checked={careful.includes(id)}
                      onChange={(e) =>
                        setCareful(
                          e.target.checked ? [...careful, id] : careful.filter((x) => x !== id),
                        )
                      }
                    />
                    {name(id)}
                  </label>
                ))}
              </fieldset>
            )}
          </fieldset>
        )}

        {castTriggers.map((tr) => (
          <label key={tr.key} className="flex flex-col gap-1 text-sm">
            {t("sheet.castTrigger", { trigger: tr.name })}
            <select
              className="field max-w-xs"
              data-testid="cast-trigger"
              value={castModes[tr.key] ?? ""}
              onChange={(e) =>
                setCastModes({
                  ...castModes,
                  [tr.key]: e.target.value as "" | "create" | "restore",
                })
              }
            >
              <option value="">{t("sheet.castTriggerNone", { trigger: tr.name })}</option>
              {tr.create && (
                <option value="create">{t("sheet.castTriggerCreate", { trigger: tr.name })}</option>
              )}
              {tr.restore_per_slot_level > 0 && (
                <option value="restore">
                  {t("sheet.castTriggerRestore", { trigger: tr.name })}
                </option>
              )}
            </select>
          </label>
        ))}

        {(base.type === "attack" || base.type === "cast" || base.type === "legendary") && (
          <div className="flex flex-wrap gap-4">
            <fieldset>
              <legend className="mb-1 text-sm text-ink-muted">{t("table.mode")}</legend>
              <div className="flex gap-1">
                {(["normal", "advantage", "disadvantage"] as const).map((m) => (
                  <Button key={m} size="sm" on={mode === m} onClick={() => setMode(m)}>
                    {t(`table.mode.${m}`)}
                  </Button>
                ))}
              </div>
            </fieldset>
            {base.type !== "legendary" && !byHand && (
              <label className="flex flex-col gap-1 text-sm text-ink-muted">
                {t("table.cover")}
                <select
                  className="field"
                  value={cover}
                  onChange={(e) => setCover(e.target.value as Cover | "")}
                >
                  <option value="">{t("table.cover.none")}</option>
                  <option value="half">{t("table.cover.half")}</option>
                  <option value="three_quarters">{t("table.cover.three_quarters")}</option>
                  <option value="total">{t("table.cover.total")}</option>
                </select>
              </label>
            )}
          </div>
        )}

        {line && (line.riders.length > 0 || line.two_handed_damage_parts) && (
          <fieldset className="space-y-1">
            <legend className="mb-1 text-sm text-ink-muted">{t("table.riders")}</legend>
            {line.riders.map((r) => (
              <label key={r.id} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  className="accent-[var(--blue)]"
                  checked={riders.includes(r.id)}
                  onChange={(e) => {
                    setRiders(
                      e.target.checked ? [...riders, r.id] : riders.filter((x) => x !== r.id),
                    );
                    if (e.target.checked) setAlternatives(alternatives.filter((x) => x !== r.id));
                  }}
                />
                {r.name}
                {r.dice && <span className="text-sm text-ink-muted">{r.dice}</span>}
              </label>
            ))}
            {line.riders.flatMap((r) =>
              r.alternative
                ? [
                    // kenli F-002 T08: the rider's alternative form (Relentless), its own die; the
                    // engine checks the shared once-per-turn budget. One form per rider.
                    <label key={`${r.id}#alt`} className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        className="accent-[var(--blue)]"
                        checked={alternatives.includes(r.id)}
                        onChange={(e) => {
                          setAlternatives(
                            e.target.checked
                              ? [...alternatives, r.id]
                              : alternatives.filter((x) => x !== r.id),
                          );
                          if (e.target.checked) setRiders(riders.filter((x) => x !== r.id));
                        }}
                      />
                      {t("table.riderAlternative", { rider: r.name, label: r.alternative.label })}
                      <span className="text-sm text-ink-muted">{r.alternative.dice}</span>
                    </label>,
                  ]
                : [],
            )}
            {line.two_handed_damage_parts && (
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  className="accent-[var(--blue)]"
                  checked={twoHanded}
                  onChange={(e) => setTwoHanded(e.target.checked)}
                />
                {t("table.twoHanded")}
              </label>
            )}
          </fieldset>
        )}

        {(entry.mastery_as ?? []).length > 0 && (
          // kenli F-002 T08: Tactical Master's choice, from the engine's option.
          <label className="flex flex-col gap-1 text-sm text-ink-muted">
            {t("table.masteryAs")}
            <select
              className="field"
              value={masteryAs}
              onChange={(e) => setMasteryAs(e.target.value)}
            >
              <option value="">{t("table.masteryOwn")}</option>
              {(entry.mastery_as ?? []).map((m) => (
                <option key={m} value={m}>
                  {t(`table.mastery.${m}`)}
                </option>
              ))}
            </select>
          </label>
        )}

        {entry.strikes.length > 0 && (
          <fieldset className="space-y-1">
            <legend className="mb-1 text-sm text-ink-muted">{t("table.strikes")}</legend>
            {entry.strikes.map((x) => {
              const key = `${x.send}:${x.id}`;
              const reasonId = `strike-${key}`;
              // By hand only the reasons that still count by hand (the economy doesn't).
              const reason = byHand
                ? (byHandReasons(x)[0]?.text ?? null)
                : x.available
                  ? null
                  : x.reason;
              const available = reason === null;
              return (
                <div key={key}>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      className="accent-[var(--blue)]"
                      disabled={!available}
                      aria-describedby={available ? undefined : reasonId}
                      checked={strikes.includes(key)}
                      onChange={(e) =>
                        setStrikes(
                          e.target.checked ? [...strikes, key] : strikes.filter((k) => k !== key),
                        )
                      }
                    />
                    <span className={available ? "" : "text-ink-muted"}>{x.name}</span>
                    <span className="text-sm text-ink-muted">{x.cost}</span>
                  </label>
                  {reason && (
                    <p id={reasonId} className="ml-6 text-[13px] text-ink-muted italic">
                      {reason}
                    </p>
                  )}
                </div>
              );
            })}
          </fieldset>
        )}

        {featureSlots.length > 0 && (
          <label className="flex flex-col gap-1 text-sm">
            {t("table.featureSlot")}
            <select
              className="field max-w-xs"
              value={featurePay}
              data-testid="feature-slot"
              onChange={(e) => setFeaturePay(e.target.value)}
            >
              <option value="">—</option>
              {featureSlots.map((x) => (
                <option key={x.value} value={x.value}>
                  {x.label} · {t("common.left", { left: x.left, total: x.total })}
                </option>
              ))}
            </select>
          </label>
        )}

        {featureForms.length > 0 && (
          <label className="flex flex-col gap-1 text-sm">
            {t("table.featureForm")}
            <select
              className="field max-w-xs"
              value={featureForm}
              data-testid="feature-form"
              onChange={(e) => setFeatureForm(e.target.value)}
            >
              <option value="">—</option>
              {featureForms.map((x) => (
                <option key={x.id} value={x.id} disabled={!!x.unavailable}>
                  {x.name}
                  {x.unavailable ? ` · ${x.unavailable}` : ""}
                </option>
              ))}
            </select>
          </label>
        )}

        {damageTypes.length > 0 && (
          <label className="flex flex-col gap-1 text-sm text-ink-muted">
            {t("table.damageType")}
            <select
              className="field max-w-xs"
              value={damageType}
              onChange={(e) => setDamageType(e.target.value)}
            >
              <option value="">—</option>
              {damageTypes.map((d) => (
                <option key={d} value={d}>
                  {titleCase(d)}
                </option>
              ))}
            </select>
          </label>
        )}

        {base.type === "help" && (
          <label className="flex flex-col gap-1 text-sm text-ink-muted">
            {t("table.checkSkill")}
            <select
              className="field max-w-xs"
              value={skill}
              onChange={(e) => setSkill(e.target.value)}
            >
              <option value="">{t("dice.attack")}</option>
              {skills().map((s) => (
                <option key={s} value={s}>
                  {skillName(s)}
                </option>
              ))}
            </select>
          </label>
        )}

        {checkSkills && (
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1 text-sm text-ink-muted">
              {t("table.checkSkill")}
              <select
                className="field w-auto"
                value={skill}
                onChange={(e) => setSkill(e.target.value)}
              >
                {base.type !== "influence" && <option value="">—</option>}
                {checkSkills.map((s) => (
                  <option key={s} value={s}>
                    {skillName(s)}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm text-ink-muted">
              {t("table.dc")}
              <input
                className="field w-20"
                inputMode="numeric"
                value={dc}
                onChange={(e) => setDc(e.target.value.replace(/[^0-9]/g, ""))}
              />
            </label>
          </div>
        )}

        {(base.type === "utilize" || base.type === "ready") && (
          <label className="flex flex-col gap-1 text-sm text-ink-muted">
            {base.type === "ready" ? t("table.readyTrigger") : t("table.utilizeWhat")}
            <input className="field" value={text} onChange={(e) => setText(e.target.value)} />
          </label>
        )}

        {base.type === "ready" && (
          <label className="flex flex-col gap-1 text-sm text-ink-muted">
            {t("table.readyAction")}
            <select
              className="field"
              value={readied}
              onChange={(e) => setReadied(Number(e.target.value))}
            >
              {readyChoices.map((o, i) => (
                <option key={`${o.label}|${i}`} value={i}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        )}

        {designate && !byHand && (
          <fieldset className="space-y-1">
            <legend className="mb-1 text-sm text-ink-muted">{t("table.unaffected")}</legend>
            <div className="flex flex-wrap gap-1.5">
              {view.combatants
                .filter((c) => c.id !== options.id && !c.defeated)
                .map((c) => (
                  <Button
                    key={c.id}
                    size="sm"
                    on={unaffected.includes(c.id)}
                    aria-pressed={unaffected.includes(c.id)}
                    onClick={() =>
                      setUnaffected(
                        unaffected.includes(c.id)
                          ? unaffected.filter((x) => x !== c.id)
                          : [...unaffected, c.id],
                      )
                    }
                  >
                    {name(c.id)}
                  </Button>
                ))}
            </div>
          </fieldset>
        )}

        <Reasons reasons={reasons ?? (check.data && !check.data.ok ? check.data.reasons : null)} />
        {entry.uses && <p className="text-sm text-ink-muted">{t("table.uses", entry.uses)}</p>}
      </div>
      <footer className="mt-3 flex justify-end gap-2">
        <Button onClick={onClose}>{t("common.cancel")}</Button>
        {forceable && (
          <Button variant="danger" disabled={busy} onClick={() => void go(as, true)}>
            {t("table.forceAction")}
          </Button>
        )}
        {otherWay === "manual" && (
          <Button disabled={busy} onClick={() => void go("manual")}>
            {t("table.wayManual")}
          </Button>
        )}
        {otherWay === "auto" && (
          <Button disabled={busy} onClick={() => setAs("auto")}>
            {t("table.wayAuto")}
          </Button>
        )}
        <Button
          variant="primary"
          icon="d20"
          disabled={busy || incomplete}
          onClick={() => void go(as)}
        >
          {byHand ? t("table.sendManual") : t("table.send")}
        </Button>
      </footer>
    </section>
  );
}

/** The engine's candidates (enemies first, nearest first), else everyone who's still in it. */
function orderedCandidates(ids: readonly string[], view: EncounterView) {
  const listed = ids.map((id) => ({ id, inRange: true }));
  return listed.length
    ? listed
    : view.combatants.filter((c) => !c.defeated).map((c) => ({ id: c.id, inRange: false }));
}

function initialTargets(action: EncounterAction): string[] {
  if ("target" in action && typeof action.target === "string" && action.target)
    return [action.target];
  if ("targets" in action && Array.isArray(action.targets)) return [...action.targets];
  return [];
}

function defaultSlot(entry: OptionEntry): string {
  const a = entry.action;
  if (a.type === "cast" && a.payment) return `free:${a.payment.use}`;
  if (a.type === "cast" && a.pact) return "pact";
  if (a.type === "cast" && a.slot_level) return String(a.slot_level);
  return entry.slot_levels[0] !== undefined
    ? String(entry.slot_levels[0])
    : entry.pact_slot !== null
      ? "pact"
      : "";
}

/** `previewArea`'s request for an option's area: its spell, saving throw effect or legendary action. */
function areaRequestFor(
  base: EncounterAction,
  id: string,
  area: { point?: Square; toward?: Square },
): AreaRequest | null {
  if (base.type === "cast") return { id, area, spell: base.spell };
  if (base.type === "save_action") return { id, area, ability: base.ability };
  if (base.type === "legendary") return { id, area, legendary: base.action };
  return null;
}

interface Fields {
  targets: readonly string[];
  slot: string;
  mode: Mode;
  cover: Cover | "";
  riders: readonly string[];
  /** Riders picked in their alternative form (`{ rider, alternative: true }`). */
  alternatives: readonly string[];
  /** Tactical Master's `mastery_as` (empty: the weapon's own property). */
  masteryAs: string;
  /** Strike effects picked: each carries the engine's attack with that effect. */
  strikes: readonly StrikeOption[];
  twoHanded: boolean;
  damageType: string;
  skill: string;
  dc: string;
  text: string;
  readied: EncounterAction | null;
  area: { point?: Square; toward?: Square } | null;
  point: Square | null;
  wall: { from: Square; to: Square; side?: "left" | "right" } | null;
  unaffected: readonly string[];
  /** kenli F-002 T12 (D016): cast triggers paid with a cast. */
  triggers: readonly { key: string; mode: "create" | "restore" }[];
  /** kenli F-002 T12 B2a: cast options (Metamagic) and the targets Heightened/Careful choose. */
  castOptions: readonly string[];
  heightened: string;
  careful: readonly string[];
  /** kenli F-002 T12 B1: a feature's slot payment (`slot:N` / `pact`) and form. */
  featurePay: string;
  featureForm: string;
}

/**
 * The riders and Strike effects for an attack: the riders picked, and for each Strike effect
 * what the engine's own action for it adds (its `cunning` / `brutal` entry, and the Sneak Attack
 * rider a Cunning Strike needs), merged without duplicates.
 */
function withStrikes(
  f: Fields,
): Pick<Extract<EncounterAction, { type: "attack" }>, "riders" | "cunning" | "brutal"> {
  const riders = new Map<string, { rider: string; alternative?: boolean }>([
    ...f.riders.map((rider) => [rider, { rider }] as const),
    ...f.alternatives.map((rider) => [rider, { rider, alternative: true }] as const),
  ]);
  const cunning = new Set<
    NonNullable<Extract<EncounterAction, { type: "attack" }>["cunning"]>[number]
  >();
  const brutal = new Set<
    NonNullable<Extract<EncounterAction, { type: "attack" }>["brutal"]>[number]
  >();
  for (const x of f.strikes) {
    if (x.action.type !== "attack") continue;
    for (const r of x.action.riders ?? []) riders.set(r.rider, r);
    for (const c of x.action.cunning ?? []) cunning.add(c);
    for (const b of x.action.brutal ?? []) brutal.add(b);
  }
  return {
    ...(riders.size ? { riders: [...riders.values()] } : {}),
    ...(cunning.size ? { cunning: [...cunning] } : {}),
    ...(brutal.size ? { brutal: [...brutal] } : {}),
  };
}

/** Fill the engine's action with what was chosen (fields the action type has, only). */
function compose(base: EncounterAction, f: Fields): EncounterAction {
  const firstTarget = f.targets[0] ?? "";
  const dc = Number.parseInt(f.dc, 10);
  const withDc = Number.isInteger(dc) ? { dc } : {};
  switch (base.type) {
    case "attack":
      return {
        ...base,
        target: firstTarget,
        ...(f.mode !== "normal" ? { mode: f.mode } : {}),
        ...(f.cover ? { cover: f.cover } : {}),
        ...withStrikes(f),
        ...(f.twoHanded ? { two_handed: true } : {}),
        ...(f.masteryAs ? { mastery_as: f.masteryAs as "push" | "sap" | "slow" } : {}),
        ...(f.damageType ? { damage_type: f.damageType as DamageType } : {}),
      };
    case "cast": {
      const { slot_level: _s, pact: _p, payment: _f, ...rest } = base;
      return {
        ...rest,
        ...(f.wall
          ? { wall: f.wall, targets: [] }
          : f.area
            ? { area: f.area, targets: [] }
            : { targets: [...f.targets] }),
        ...(f.slot.startsWith("free:")
          ? { payment: { type: "free" as const, use: f.slot.slice(5) } }
          : f.slot === "pact"
            ? { pact: true }
            : f.slot
              ? { slot_level: Number(f.slot) }
              : {}),
        ...(f.mode !== "normal" ? { mode: f.mode } : {}),
        ...(f.damageType ? { damage_type: f.damageType as DamageType } : {}),
        ...(f.unaffected.length ? { unaffected: [...f.unaffected] } : {}),
        ...(f.triggers.length ? { triggers: f.triggers.map((x) => ({ ...x })) } : {}),
        ...(f.castOptions.length ? { options: [...f.castOptions] } : {}),
        ...(f.castOptions.length && f.heightened ? { heightened: f.heightened } : {}),
        ...(f.castOptions.length && f.careful.length ? { careful: [...f.careful] } : {}),
        ...(f.cover
          ? { cover: Object.fromEntries(f.targets.map((id) => [id, f.cover as Cover])) }
          : {}),
      };
    }
    case "save_action":
      return {
        ...base,
        ...(f.area ? { area: f.area, targets: [] } : { targets: [...f.targets] }),
        ...(f.cover
          ? { cover: Object.fromEntries(f.targets.map((id) => [id, f.cover as Cover])) }
          : {}),
      };
    case "legendary":
      return {
        ...base,
        ...(f.area ? { area: f.area } : {}),
        ...(f.targets.length > 1 || "targets" in base ? { targets: [...f.targets] } : {}),
        ...(f.targets.length && !("targets" in base) ? { target: firstTarget } : {}),
        ...(f.mode !== "normal" ? { mode: f.mode } : {}),
      };
    case "feature": {
      const paid = {
        ...base,
        ...(f.featurePay === "pact"
          ? { payment: { type: "pact" as const } }
          : f.featurePay.startsWith("slot:")
            ? { payment: { type: "slot" as const, level: Number(f.featurePay.slice(5)) } }
            : {}),
        ...(f.featureForm ? { form: f.featureForm } : {}),
      };
      return f.targets.length > 1 || ("targets" in base && base.targets)
        ? { ...paid, targets: [...f.targets] }
        : firstTarget
          ? { ...paid, target: firstTarget }
          : paid;
    }
    case "help":
      return { ...base, target: firstTarget, ...(f.skill ? { skill: f.skill as Skill } : {}) };
    case "unarmed":
    case "move_mark":
      return { ...base, target: firstTarget };
    case "search":
      return {
        ...base,
        ...(f.skill ? { skill: f.skill as NonNullable<typeof base.skill> } : {}),
        ...(firstTarget ? { target: firstTarget } : {}),
        ...withDc,
      };
    case "study":
      return {
        ...base,
        ...(f.skill ? { skill: f.skill as NonNullable<typeof base.skill> } : {}),
        ...withDc,
      };
    case "influence":
      return {
        ...base,
        ...(f.skill ? { skill: f.skill as typeof base.skill } : {}),
        ...(firstTarget ? { target: firstTarget } : {}),
        ...withDc,
      };
    case "utilize":
      return f.text ? { ...base, what: f.text } : base;
    case "ready":
      return {
        ...base,
        trigger: f.text,
        ...(f.readied && ["attack", "unarmed", "cast", "move", "help"].includes(f.readied.type)
          ? { action: f.readied as typeof base.action }
          : {}),
      };
    case "move":
      return f.point ? { type: "move", id: base.id, to: f.point } : base;
    case "move_zone":
      return f.point ? { ...base, point: f.point } : base;
    default:
      return base;
  }
}

function SquareInput({
  value,
  onChange,
}: {
  value: Square | null;
  onChange: (v: Square | null) => void;
}) {
  const [x, setX] = useState(value ? String(value.x) : "");
  const [y, setY] = useState(value ? String(value.y) : "");
  useEffect(() => {
    if (value) {
      setX(String(value.x));
      setY(String(value.y));
    }
  }, [value]);
  const commit = (nx: string, ny: string) => {
    const px = Number.parseInt(nx, 10);
    const py = Number.parseInt(ny, 10);
    onChange(Number.isInteger(px) && Number.isInteger(py) ? { x: px, y: py } : null);
  };
  return (
    <span className="flex items-end gap-1">
      <label className="flex flex-col text-[13px] text-ink-muted">
        x
        <input
          className="field w-16"
          inputMode="numeric"
          value={x}
          onChange={(e) => {
            setX(e.target.value);
            commit(e.target.value, y);
          }}
        />
      </label>
      <label className="flex flex-col text-[13px] text-ink-muted">
        y
        <input
          className="field w-16"
          inputMode="numeric"
          value={y}
          onChange={(e) => {
            setY(e.target.value);
            commit(x, e.target.value);
          }}
        />
      </label>
    </span>
  );
}
