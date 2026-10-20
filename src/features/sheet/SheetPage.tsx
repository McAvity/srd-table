/**
 * The character sheet for the table: `computePlaySheet` with an explanation on every number, and
 * every play action as a control (HP, rests, slots, uses, toggles, conditions, Concentration,
 * inventory, attunement, coins, today's picks).
 */

import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import type { PlaySheet } from "srd-rules-engine";
import { BackLink } from "@/components/BackLink";
import { Explain } from "@/components/Explain";
import { Icon } from "@/components/Icon";
import { PortraitPicker } from "@/components/Portrait";
import { Button, Empty, Spinner, StatBox, Tabs } from "@/components/ui";
import { UndoButton } from "@/features/history/UndoButton";
import { signed, t } from "@/i18n";
import { usePlayView } from "@/queries";
import { CharacterScope } from "@/queries/scope";
import { type CharacterRecord, canRedo, useDocuments } from "@/store/documents";
import { useUi } from "@/store/ui";
import { CombatTab } from "./CombatTab";
import { FeaturesTab } from "./FeaturesTab";
import { HitPointsPanel, RestButtons } from "./HitPoints";
import { InventoryTab, StartingEquipment } from "./InventoryTab";
import { OverviewTab } from "./OverviewTab";
import { RollFollowUps } from "./RollFollowUps";
import { RollOptions } from "./RollOptions";
import { SpellsTab } from "./SpellsTab";
import type { SheetTab } from "./tabs";

export function SheetPage({ id, tab }: { id: string; tab: SheetTab }) {
  const record = useDocuments((s) => s.characters[id]);
  const { data, error } = usePlayView(id);
  if (!record) {
    return (
      <Empty icon="sheet">
        {t("errors.documentGone")}{" "}
        <Link to="/characters" className="text-blue underline">
          {t("nav.characters")}
        </Link>
      </Empty>
    );
  }
  if (error)
    return <div className="p-6 text-red">{t("errors.engine", { message: error.message })}</div>;
  if (!data) {
    return (
      <div className="p-6">
        <Spinner />
      </div>
    );
  }
  return (
    <CharacterScope id={id}>
      <Sheet
        record={record}
        sheet={data.sheet}
        issues={data.issues.map((i) => i.message)}
        tab={tab}
      />
    </CharacterScope>
  );
}

function Sheet({
  record,
  sheet,
  issues,
  tab,
}: {
  record: CharacterRecord;
  sheet: PlaySheet;
  issues: readonly string[];
  tab: SheetTab;
}) {
  const id = record.id;
  const navigate = useNavigate();
  const redo = useDocuments((s) => s.redo);
  const redoable = useDocuments((s) => canRedo(s, id));
  const name = record.build.name || t("common.unnamed");
  const classes = sheet.classes
    .map((c) => `${c.name} ${c.level}${c.subclass ? ` (${c.subclass})` : ""}`)
    .join(" / ");
  const hasSpells = sheet.spells.length > 0 || sheet.spellcasting.length > 0;
  useEffect(() => useUi.getState().opened("character", id), [id]);

  return (
    <div className="mx-auto max-w-[1400px] p-3 sm:p-5">
      <div className="mb-1">
        <BackLink to="/characters" />
      </div>
      <header className="panel mb-4 flex flex-wrap items-center gap-4 p-3">
        <PortraitPicker id={id} name={name} />
        <div className="min-w-[12rem] flex-1">
          <h1 className="font-display text-3xl text-ink">{name}</h1>
          <p className="text-ink-muted">
            {t("common.level", { level: sheet.level })}
            {classes && ` · ${classes}`}
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Link to="/characters/$id/build" params={{ id }} search={{}} className="btn btn-sm">
              <Icon name="edit" size={16} />
              {t("characters.build")}
            </Link>
            <UndoButton id={id} />
            <Button
              size="sm"
              icon="redo"
              iconOnly
              label={t("common.redo")}
              disabled={!redoable}
              onClick={() => redo(id)}
            />
            <RestButtons id={id} sheet={sheet} />
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <StatBox label={t("summary.ac")}>
            <Explain
              label={t("summary.ac")}
              total={sheet.armor_class.total}
              parts={sheet.armor_class.parts}
            />
          </StatBox>
          <StatBox label={t("summary.initiative")}>
            <Explain
              label={t("summary.initiative")}
              total={sheet.initiative.total}
              parts={sheet.initiative.parts}
              sign
            />
          </StatBox>
          <StatBox label={t("summary.speed")}>
            <Explain
              label={t("summary.speed")}
              total={sheet.speed.total}
              parts={sheet.speed.parts}
            />
          </StatBox>
          <StatBox label={t("summary.prof")}>{signed(sheet.proficiency_bonus)}</StatBox>
          <StatBox label={t("summary.passive")}>{sheet.passive_perception}</StatBox>
        </div>
      </header>

      {issues.length > 0 && (
        <ul aria-label={t("sheet.issues")} className="mb-3 space-y-0.5 text-sm text-orange">
          {issues.map((i) => (
            <li key={i} className="flex gap-2">
              <Icon name="warning" size={16} className="mt-0.5 flex-none" />
              {i}
            </li>
          ))}
        </ul>
      )}

      {!sheet.play.starting_equipment_taken && (
        <div className="mb-3">
          <StartingEquipment id={id} />
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
        <aside className="space-y-4">
          <HitPointsPanel id={id} sheet={sheet} />
          <RollFollowUps id={id} sheet={sheet} />
          <RollOptions id={id} sheet={sheet} />
        </aside>
        <Tabs<SheetTab>
          label={t("sheet.tabs")}
          value={tab}
          onValueChange={(next) =>
            void navigate({
              to: "/characters/$id/sheet",
              params: { id },
              search: { tab: next },
              replace: true,
            })
          }
          items={[
            {
              value: "overview",
              label: t("sheet.tab.overview"),
              icon: "sheet",
              content: <OverviewTab id={id} sheet={sheet} />,
            },
            {
              value: "combat",
              label: t("sheet.tab.combat"),
              icon: "swords",
              content: <CombatTab id={id} sheet={sheet} />,
            },
            ...(hasSpells
              ? [
                  {
                    value: "spells" as const,
                    label: t("sheet.tab.spells"),
                    icon: "sparkle" as const,
                    content: <SpellsTab id={id} sheet={sheet} />,
                  },
                ]
              : []),
            {
              value: "inventory",
              label: t("sheet.tab.inventory"),
              icon: "bag",
              content: <InventoryTab id={id} sheet={sheet} />,
            },
            {
              value: "features",
              label: t("sheet.tab.features"),
              icon: "book",
              content: <FeaturesTab id={id} sheet={sheet} />,
            },
          ]}
        />
      </div>
    </div>
  );
}
