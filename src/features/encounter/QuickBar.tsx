/**
 * What the acting combatant can do now (`combatantOptions`), as tiles grouped by what they cost:
 * Action, Bonus Action, Reaction, Free, Legendary, plus favourites. Every option the engine lists
 * is shown; one it wouldn't take now is outlined dashed with its reason. A tile with nothing to fill in
 * is sent at once; the others open the composer. Attacks that follow an earlier one (Cleave after a
 * hit, the Light extra attack, attacks a feature granted) show in the Action tab too, where the
 * attack that opened them was. On the combatant's turn, End turn sends `next_turn`. The Play switch
 * says how the actions are played (automatic or by hand).
 */

import { useState } from "react";
import type { CombatantOptions, EncounterAction, OptionCost, OptionEntry } from "srd-rules-engine";
import type { IconName } from "@/components/Icon";
import { OptionButton } from "@/components/OptionButton";
import { Button, cx, Reasons } from "@/components/ui";
import { t, tn } from "@/i18n";
import { useDocuments } from "@/store/documents";
import { type PlayWay, useSettings } from "@/store/settings";
import { oddsText } from "./ActionComposer";
import { canPlayByHand, playedAs } from "./manual";

/** A stable empty list: a store selector must not return a new array each time. */
const NO_FAVORITES: readonly string[] = [];

type Group = "favorites" | "action" | "bonus_action" | "reaction" | "free" | "legendary";

const GROUP_OF: Readonly<Record<OptionCost, Group>> = {
  action: "action",
  attack: "action",
  bonus_action: "bonus_action",
  reaction: "reaction",
  free: "free",
  movement: "free",
  legendary: "legendary",
};

type Kind = keyof Omit<CombatantOptions, "id" | "name" | "turn" | "economy">;
const KINDS: readonly Kind[] = [
  "attacks",
  "spells",
  "features",
  "save_actions",
  "legendary",
  "standard",
  "zones",
];
const ICON: Readonly<Record<Kind, IconName>> = {
  attacks: "swords",
  spells: "sparkle",
  features: "bolt",
  save_actions: "flame",
  legendary: "star",
  standard: "move",
  zones: "area",
};

export interface Tile {
  readonly entry: OptionEntry;
  readonly kind: Kind;
  readonly key: string;
}

/** A stable key for a favourite: the action's type and what it uses (not its changing label). */
export function favoriteKey(action: EncounterAction): string {
  const a = action as Record<string, unknown>;
  const what =
    a.attack ?? a.spell ?? a.feature ?? a.ability ?? a.action ?? a.option ?? a.zone ?? "";
  const variant = [
    "light_extra",
    "cleave",
    "granted",
    "thrown",
    "opportunity",
    "reaction",
    "bonus_action",
  ]
    .filter((k) => a[k] === true)
    .join("+");
  return `${action.type}:${String(what)}${variant ? `:${variant}` : ""}`;
}

/** An attack another one opened this turn: shown with the Action tab's attacks too. */
function followsUp(tile: Tile): boolean {
  const a = tile.entry.action as Record<string, unknown>;
  return a.cleave === true || a.light_extra === true || a.granted === true;
}

function inGroup(tile: Tile, group: Group): boolean {
  return GROUP_OF[tile.entry.cost] === group || (group === "action" && followsUp(tile));
}

export function tilesOf(options: CombatantOptions): Tile[] {
  return KINDS.flatMap((kind) =>
    options[kind].map((entry, i) => ({
      entry,
      kind,
      key: `${kind}:${i}:${favoriteKey(entry.action)}`,
    })),
  );
}

export function QuickBar({
  encounterId,
  options,
  favoriteOwner,
  way,
  onWay,
  onCompose,
  needsComposer,
}: {
  encounterId: string;
  options: CombatantOptions;
  /** Whose favourites (a character id, or the monster's catalog id). */
  favoriteOwner: string;
  /** How the actions are played (the Play switch). */
  way: PlayWay;
  onWay: (way: PlayWay) => void;
  onCompose: (entry: OptionEntry, way: PlayWay) => void;
  needsComposer: (entry: OptionEntry) => boolean;
}) {
  const send = useDocuments((s) => s.encounterAction);
  const favorites = useSettings((s) => s.settings.favorites[favoriteOwner] ?? NO_FAVORITES);
  const toggleFavorite = useSettings((s) => s.toggleFavorite);
  const tiles = tilesOf(options);
  const groups: Group[] = ["favorites", "action", "bonus_action", "reaction", "free", "legendary"];
  const present = groups.filter((g) =>
    g === "favorites" ? favorites.length > 0 : tiles.some((tile) => inGroup(tile, g)),
  );
  const [group, setGroup] = useState<Group>(present[0] ?? "action");
  const active = present.includes(group) ? group : (present[0] ?? "action");
  const [reasons, setReasons] = useState<readonly string[] | null>(null);
  const shown = tiles.filter((tile) =>
    active === "favorites"
      ? favorites.includes(favoriteKey(tile.entry.action))
      : inGroup(tile, active),
  );

  async function use(tile: Tile) {
    setReasons(null);
    if (needsComposer(tile.entry)) return onCompose(tile.entry, way);
    const result = await send(encounterId, playedAs(tile.entry.action, way));
    if (!result.ok) setReasons(result.reasons);
  }

  async function endTurn() {
    setReasons(null);
    const result = await send(encounterId, { type: "next_turn" });
    if (!result.ok) setReasons(result.reasons);
  }

  const { economy } = options;
  return (
    <section aria-label={t("table.options")} className="panel p-2">
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        <div role="tablist" aria-label={t("table.options")} className="flex flex-wrap gap-1">
          {present.map((g) => (
            <button
              key={g}
              type="button"
              role="tab"
              aria-selected={active === g}
              data-on={active === g ? "true" : undefined}
              onClick={() => setGroup(g)}
              className="btn btn-sm"
            >
              <span className="pip" data-cost={g} aria-hidden="true" />
              {t(`table.group.${g}`)}
            </button>
          ))}
        </div>
        <section
          className="ml-auto flex flex-wrap items-center gap-2 text-[13px] text-ink-muted"
          aria-label={t("table.economy")}
        >
          <Economy cost="action" label={t("table.action")} on={economy.action} />
          <Economy cost="bonus_action" label={t("table.bonusAction")} on={economy.bonus_action} />
          <Economy cost="reaction" label={t("table.reaction")} on={economy.reaction} />
          <span>{t("table.movement", { feet: economy.movement })}</span>
          {economy.attacks_left > 0 && <span>{tn("table.attacksLeft", economy.attacks_left)}</span>}
          {economy.legendary && <span>{t("table.legendaryLeft", economy.legendary)}</span>}
        </section>
        {tiles.some((tile) => canPlayByHand(tile.entry.action)) && (
          <fieldset className="flex items-center gap-1" title={t("table.wayHint")}>
            <legend className="sr-only">{t("table.playWay")}</legend>
            {(["auto", "manual"] as const).map((w) => (
              <Button
                key={w}
                size="sm"
                variant="ghost"
                on={way === w}
                aria-pressed={way === w}
                onClick={() => onWay(w)}
              >
                {w === "auto" ? t("table.wayAuto") : t("table.wayManual")}
              </Button>
            ))}
          </fieldset>
        )}
        {options.turn && (
          <Button size="sm" variant="primary" icon="next" onClick={() => void endTurn()}>
            {t("table.endTurn")}
          </Button>
        )}
      </div>
      <Reasons reasons={reasons} className="mb-2" />
      <ul role="tabpanel" className="flex items-start gap-1.5 overflow-x-auto pb-1">
        {shown.map((tile) => {
          const fav = favorites.includes(favoriteKey(tile.entry.action));
          return (
            <li key={tile.key} className="relative flex-none">
              <OptionButton
                variant="tile"
                icon={ICON[tile.kind]}
                reason={tile.entry.available ? null : (tile.entry.reason ?? "")}
                onClick={() => void use(tile)}
                detail={[
                  t(`table.cost.${tile.entry.cost}`),
                  tile.entry.uses ? t("table.uses", tile.entry.uses) : null,
                  oddsText(tile.entry),
                  tile.entry.note,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              >
                {tile.entry.label}
              </OptionButton>
              <Button
                variant="ghost"
                className={cx(
                  "!absolute top-0 right-0 !p-0.5 text-[13px]",
                  fav ? "text-ink" : "text-ink-faint",
                )}
                aria-pressed={fav}
                label={fav ? t("table.removeFavorite") : t("table.addFavorite")}
                iconOnly
                icon="star"
                onClick={() => toggleFavorite(favoriteOwner, favoriteKey(tile.entry.action))}
              />
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Economy({ cost, label, on }: { cost: Group; label: string; on: boolean }) {
  return (
    <span
      className={cx("flex items-center gap-1", on ? "text-ink" : "text-ink-faint line-through")}
    >
      <span className="pip" data-cost={cost} aria-hidden="true" />
      {label}
    </span>
  );
}
