/**
 * The table: the Initiative order on the left; the map, then what the acting combatant can do, in
 * the middle; the GM's controls, the selection and the combat log on the right. The GM acts for
 * anyone; a player acts for their own character (reactions included, on others' turns).
 */

import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import type { OptionEntry } from "srd-rules-engine";
import { BackLink } from "@/components/BackLink";
import { Button, Empty, Spinner } from "@/components/ui";
import type { CombatantView } from "@/engine/facade";
import { t } from "@/i18n";
import { useCombatantOptions, useEncounterView, usePlayView } from "@/queries";
import { canRedo, canUndo, type EncounterRecord, useDocuments } from "@/store/documents";
import { type PlayWay, useSettings } from "@/store/settings";
import { useUi } from "@/store/ui";
import { BattleMap } from "../map/BattleMap";
import { ActionComposer, needsComposer } from "./ActionComposer";
import { CombatLog } from "./CombatLog";
import { CombatPanel } from "./CombatPanel";
import { DecisionDialog } from "./DecisionDialog";
import { ExplorationPanel } from "./ExplorationPanel";
import { InitiativeRail } from "./InitiativeRail";
import { needsComposerByHand, wayOf } from "./manual";
import { OffMapNotice } from "./OffMapNotice";
import { PointDialog, PointPanel } from "./PointPanel";
import { QuickBar } from "./QuickBar";
import { SelectionPanel } from "./SelectionPanel";
import { useTableUi } from "./tableUi";

export function EncounterPage({ id }: { id: string }) {
  const record = useDocuments((s) => s.encounters[id]);
  if (!record) {
    return (
      <Empty icon="table">
        {t("errors.documentGone")}{" "}
        <Link to="/encounters" className="text-blue underline">
          {t("encounters.title")}
        </Link>
      </Empty>
    );
  }
  return <Table record={record} />;
}

function Table({ record }: { record: EncounterRecord }) {
  const { data: view, error } = useEncounterView(record.id);
  const role = useUi((s) => s.role);
  const gm = role.kind === "gm";
  const rename = useDocuments((s) => s.renameEncounter);
  const clearLog = useDocuments((s) => s.clearLog);
  const undo = useDocuments((s) => s.undo);
  const redo = useDocuments((s) => s.redo);
  const undoable = useDocuments((s) => canUndo(s, record.id));
  const redoable = useDocuments((s) => canRedo(s, record.id));
  const selected = useTableUi((s) => s.selected);
  const pinned = useTableUi((s) => s.pinned);
  const select = useTableUi((s) => s.select);
  const newPoint = useTableUi((s) => s.newPoint);
  const placePoint = useTableUi((s) => s.placePoint);
  const [composing, setComposing] = useState<{ entry: OptionEntry; way: PlayWay } | null>(null);
  const settings = useSettings((s) => s.settings);
  /** The Play switch moved off the acting combatant's default, until the turn changes. */
  const [switched, setSwitched] = useState<{ id: string; way: PlayWay } | null>(null);
  const [name, setName] = useState(record.name);
  useEffect(() => setName(record.name), [record.name]);
  useEffect(() => useUi.getState().opened("encounter", record.id), [record.id]);

  const mine = (c: CombatantView) =>
    role.kind === "player" && c.character !== null && c.character === role.character;
  const canControl = (c: CombatantView) => gm || mine(c);
  const own = view?.combatants.find(mine) ?? null;

  // The selection follows whose turn it is, unless picked by hand; a player starts on their own.
  const current = view?.current ?? null;
  useEffect(() => {
    if (!view) return;
    if (!gm && own && !pinned) select(own.id, false);
    else if (gm && !pinned && current) select(current, false);
  }, [view, gm, own, pinned, current, select]);
  // A target clicked in a dice result: selected as if its token were, and pinged on the map.
  const focus = useUi((s) => s.focus);
  useEffect(() => {
    if (!focus || !view) return;
    useUi.getState().focusCombatant(null);
    const target = view.combatants.find((c) => c.id === focus);
    if (!target) return;
    select(target.id);
    if (target.position) useTableUi.getState().setPing(target.position);
  }, [focus, view, select]);
  // A new turn releases a pinned selection.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only when the turn changes
  useEffect(() => {
    useTableUi.setState({ pinned: false });
    setComposing(null);
    setSwitched(null);
  }, [current, record.encounter.round]);

  const selectedView = view?.combatants.find((c) => c.id === selected) ?? null;
  const actor = selectedView && canControl(selectedView) ? selectedView : !gm ? own : null;
  const options = useCombatantOptions(record.id, actor?.id ?? null);
  // A character's attack lines (riders, Versatile): by hand, the composer opens only for those.
  const actorSheet = usePlayView(actor?.character ?? undefined).data?.sheet ?? null;
  const way: PlayWay | null = actor
    ? switched?.id === actor.id
      ? switched.way
      : wayOf(record, actor, settings)
    : null;
  const pending = record.encounter.pending;
  const pendingWho = pending ? view?.combatants.find((c) => c.id === pending.combatant) : undefined;

  if (error)
    return <div className="p-6 text-red">{t("errors.engine", { message: error.message })}</div>;
  if (!view) {
    return (
      <div className="p-6">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="grid gap-3 p-3 lg:h-full lg:min-h-0 lg:grid-cols-[250px_minmax(0,1fr)_340px]">
      <aside className="flex max-h-[45vh] min-h-0 flex-col gap-2 lg:max-h-none">
        <div className="panel p-2">
          <BackLink to="/encounters" />
          <label className="sr-only" htmlFor="encounter-name">
            {t("encounters.name")}
          </label>
          <input
            id="encounter-name"
            className="w-full bg-transparent font-display text-xl text-ink outline-none focus:border-b focus:border-focus"
            value={name}
            readOnly={!gm}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => name.trim() && name !== record.name && rename(record.id, name.trim())}
          />
          <div className="flex items-center gap-1 text-sm text-ink-muted">
            <span className="flex-1">
              {view.round > 0
                ? t("encounters.round", { round: view.round })
                : t("encounters.notStarted")}
            </span>
            {gm && (
              <>
                <Button
                  size="sm"
                  variant="ghost"
                  icon="undo"
                  iconOnly
                  label={t("common.undo")}
                  disabled={!undoable}
                  onClick={() => undo(record.id)}
                />
                <Button
                  size="sm"
                  variant="ghost"
                  icon="redo"
                  iconOnly
                  label={t("common.redo")}
                  disabled={!redoable}
                  onClick={() => redo(record.id)}
                />
              </>
            )}
          </div>
        </div>
        <InitiativeRail view={view} gm={gm} />
      </aside>

      <div className="flex min-h-[28rem] min-w-0 flex-col gap-2">
        <div className="min-h-0 flex-1">
          <BattleMap
            encounterId={record.id}
            encounter={record.encounter}
            view={view}
            gm={gm}
            controllable={canControl}
          />
        </div>
        {pending && (
          <DecisionDialog
            encounterId={record.id}
            pending={pending}
            who={pendingWho?.name ?? pending.combatant}
            canAnswer={gm || (pendingWho ? mine(pendingWho) : false)}
          />
        )}
        {actor && (
          <OffMapNotice
            view={view}
            actor={actor}
            gm={gm}
            required={record.encounter.positions === "required"}
          />
        )}
        {!pending && actor && options.data && composing && (
          <ActionComposer
            key={composing.entry.label}
            encounterId={record.id}
            view={view}
            options={options.data}
            entry={composing.entry}
            way={composing.way}
            gm={gm}
            onClose={() => setComposing(null)}
          />
        )}
        {view.round === 0 && (
          <ExplorationPanel
            encounterId={record.id}
            encounter={record.encounter}
            view={view}
            actor={actor}
            gm={gm}
          />
        )}
        {newPoint && gm && (
          <PointDialog encounterId={record.id} at={newPoint} onClose={() => placePoint(null)} />
        )}
        {view.round > 0 && !pending && actor && options.data && !composing && (
          <>
            {!options.data.turn && !gm && (
              <p className="text-sm text-ink-muted">{t("table.playerWaiting")}</p>
            )}
            <QuickBar
              encounterId={record.id}
              options={options.data}
              favoriteOwner={actor.character ?? actor.monster ?? actor.id}
              way={way ?? "auto"}
              onWay={(w) => setSwitched({ id: actor.id, way: w })}
              gm={gm}
              onCompose={(entry, way) => setComposing({ entry, way })}
              needsComposer={(entry: OptionEntry, w: PlayWay) =>
                w === "manual" && entry.rollable
                  ? needsComposerByHand(entry, actorSheet)
                  : needsComposer(entry)
              }
            />
          </>
        )}
        {!pending && actor && !options.data && options.isFetching && <Spinner />}
      </div>

      <aside className="flex min-h-0 flex-col gap-3 lg:overflow-y-auto">
        <PointPanel encounterId={record.id} encounter={record.encounter} view={view} gm={gm} />
        {gm && <CombatPanel record={record} view={view} />}
        <SelectionPanel
          encounterId={record.id}
          mode={selectedView ? (record.modes?.[selectedView.id] ?? null) : null}
          encounter={record.encounter}
          combatant={selectedView}
          gm={gm}
          canAct={selectedView ? canControl(selectedView) : false}
        />
        <CombatLog
          log={record.log}
          onClear={gm ? () => clearLog(record.id) : undefined}
          className="min-h-[14rem] flex-1"
        />
      </aside>
    </div>
  );
}
