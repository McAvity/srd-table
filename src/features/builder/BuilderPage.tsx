/**
 * The builder: the engine's step order with free navigation, each step's missing picks
 * (`issuesForStep`), options greyed out with their reason, a live summary; level-ups, each
 * level's choices, and editing the past with a preview of what changes.
 */

import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import type { Step } from "srd-rules-engine";
import { BackLink } from "@/components/BackLink";
import { Icon } from "@/components/Icon";
import { Button, cx, Empty, Spinner } from "@/components/ui";
import type { BuildEdit, BuildView } from "@/engine/facade";
import { t } from "@/i18n";
import { useBuildView } from "@/queries";
import type { BuilderSearch } from "@/routes/router";
import { canRedo, canUndo, useDocuments } from "@/store/documents";
import { useUi } from "@/store/ui";
import { AbilitiesStep } from "./AbilitiesStep";
import { ChoiceCard } from "./ChoiceCard";
import { DetailsStep } from "./DetailsStep";
import { EntityStep } from "./EntityStep";
import { LevelPanel, LevelUpDialog, RemoveLevelButton } from "./Levels";
import { Summary } from "./Summary";
import { usePreviewedEdit } from "./usePreviewedEdit";

export function BuilderPage({ id, search }: { id: string; search: BuilderSearch }) {
  const exists = useDocuments((s) => Boolean(s.characters[id]));
  const { data: view, error } = useBuildView(id);
  if (!exists) {
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
  if (!view)
    return (
      <div className="p-6">
        <Spinner />
      </div>
    );
  return <Builder id={id} view={view} search={search} />;
}

function Builder({ id, view, search }: { id: string; view: BuildView; search: BuilderSearch }) {
  const navigate = useNavigate();
  const { request, dialog } = usePreviewedEdit(id);
  const undo = useDocuments((s) => s.undo);
  const redo = useDocuments((s) => s.redo);
  const undoable = useDocuments((s) => canUndo(s, id));
  const redoable = useDocuments((s) => canRedo(s, id));
  const [levelUpOpen, setLevelUpOpen] = useState(false);

  const level = search.level && search.level <= view.level ? search.level : null;
  const step: Step = search.step ?? view.next_step ?? "class";
  const goStep = (s: Step) =>
    navigate({ to: "/characters/$id/build", params: { id }, search: { step: s } });
  const goLevel = (l: number) =>
    navigate({ to: "/characters/$id/build", params: { id }, search: { level: l } });
  const edit = (e: BuildEdit) => request(e, { past: view.level > 1 });
  const name = view.build.name || t("common.unnamed");
  useEffect(() => useUi.getState().opened("character", id), [id]);

  return (
    <div className="mx-auto max-w-[1500px] p-3 sm:p-5">
      <div className="mb-1">
        <BackLink to="/characters" />
      </div>
      <header className="mb-3 flex flex-wrap items-center gap-2">
        <h1 className="mr-2 font-display text-3xl text-ink">
          {name}
          <span className="ml-3 align-middle text-base font-normal text-ink-muted [font-variant:normal]">
            {t("builder.title")} · {t("common.level", { level: view.level })}
          </span>
        </h1>
        <div className="ml-auto flex flex-wrap gap-1.5">
          <Button
            size="sm"
            icon="undo"
            iconOnly
            label={t("common.undo")}
            disabled={!undoable}
            onClick={() => undo(id)}
          />
          <Button
            size="sm"
            icon="redo"
            iconOnly
            label={t("common.redo")}
            disabled={!redoable}
            onClick={() => redo(id)}
          />
          <Link to="/characters/$id/sheet" params={{ id }} search={{}} className="btn btn-sm">
            <Icon name="sheet" size={16} />
            {t("builder.goSheet")}
          </Link>
        </div>
      </header>

      <nav aria-label={t("builder.levels")} className="mb-4 flex flex-wrap items-center gap-1.5">
        <Button size="sm" on={level === null} onClick={() => void goStep(step)}>
          {t("builder.level1")}
        </Button>
        {view.levels
          .filter((l) => l.level > 1)
          .map((l) => (
            <Button
              key={l.level}
              size="sm"
              on={level === l.level}
              onClick={() => void goLevel(l.level)}
            >
              {l.level}
              {!l.complete && (
                <>
                  <span className="h-1.5 w-1.5 rounded-full bg-orange" aria-hidden="true" />
                  <span className="sr-only">{t("builder.missing")}</span>
                </>
              )}
            </Button>
          ))}
        <Button size="sm" variant="primary" icon="levelUp" onClick={() => setLevelUpOpen(true)}>
          {t("builder.levelUp")}
        </Button>
        <RemoveLevelButton view={view} request={(e) => request(e)} />
      </nav>

      <div className="grid gap-4 lg:grid-cols-[230px_minmax(0,1fr)_300px]">
        {level === null ? (
          <StepNav view={view} step={step} onStep={(s) => void goStep(s)} />
        ) : (
          <div className="hidden lg:block" />
        )}
        <div className="min-w-0 space-y-4">
          {level === null ? (
            <StepContent id={id} view={view} step={step} name={name} edit={edit} />
          ) : (
            <LevelPanel
              id={id}
              view={view}
              level={
                view.levels.find((l) => l.level === level) as NonNullable<
                  (typeof view.levels)[number]
                >
              }
              request={request}
            />
          )}
          {level === null && <StepFooter view={view} step={step} onStep={(s) => void goStep(s)} />}
        </div>
        <aside className="space-y-4 lg:sticky lg:top-3 lg:self-start">
          <Summary view={view} />
        </aside>
      </div>
      {dialog}
      {levelUpOpen && (
        <LevelUpDialog
          id={id}
          view={view}
          open={levelUpOpen}
          onOpenChange={setLevelUpOpen}
          onDone={(l) => void goLevel(l)}
        />
      )}
    </div>
  );
}

function StepNav({
  view,
  step,
  onStep,
}: {
  view: BuildView;
  step: Step;
  onStep: (s: Step) => void;
}) {
  return (
    <nav aria-label={t("builder.steps")} className="panel h-fit p-2">
      <ol className="flex gap-1 overflow-x-auto lg:flex-col">
        {view.steps.map((s, i) => {
          const errors = s.issues.some((x) => x.severity === "error");
          return (
            <li key={s.step} className="flex-none">
              <button
                type="button"
                onClick={() => onStep(s.step)}
                aria-current={s.step === step ? "step" : undefined}
                className={cx(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-card-2",
                  s.step === step && "bg-hl text-hl-ink",
                )}
              >
                <span className="w-5 text-right text-[13px] text-ink-faint tabular-nums">
                  {i + 1}
                </span>
                <span className="flex-1 whitespace-nowrap">{s.title}</span>
                {s.complete ? (
                  <Icon name="check" size={16} className="text-green" />
                ) : errors ? (
                  <Icon name="warning" size={16} className="text-red" />
                ) : (
                  <>
                    <span
                      className="h-2.5 w-2.5 rounded-full border-2 border-orange"
                      aria-hidden="true"
                    />
                    <span className="sr-only">{t("builder.missing")}</span>
                  </>
                )}
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function StepContent({
  id,
  view,
  step,
  name,
  edit,
}: {
  id: string;
  view: BuildView;
  step: Step;
  name: string;
  edit: (e: BuildEdit) => Promise<readonly string[] | null>;
}) {
  const info = view.steps.find((s) => s.step === step);
  const choices = view.choices.filter((c) => c.step === step && c.level === 1);
  const { build } = view;
  return (
    <>
      <h2 className="font-display text-2xl text-ink">{info?.title}</h2>
      {info && info.issues.length > 0 && (
        <ul aria-label={t("builder.missing")} className="space-y-0.5 text-sm">
          {info.issues.map((i) => (
            <li
              key={`${i.choice_key}|${i.message}`}
              className={cx(
                "flex gap-2",
                i.severity === "error"
                  ? "text-red"
                  : i.severity === "note"
                    ? "text-ink-muted"
                    : "text-orange",
              )}
            >
              <Icon
                name={i.severity === "note" ? "info" : "warning"}
                size={16}
                className="mt-0.5 flex-none"
              />
              {i.message}
            </li>
          ))}
        </ul>
      )}
      {step === "class" && (
        <EntityStep
          table="classes"
          label={info?.title ?? ""}
          selected={build.class_id}
          onPick={(cid) => edit({ type: "class", id: cid })}
        />
      )}
      {step === "species" && (
        <EntityStep
          table="species"
          label={info?.title ?? ""}
          selected={build.species_id}
          onPick={(sid) => edit({ type: "species", id: sid })}
        />
      )}
      {step === "background" && (
        <EntityStep
          table="backgrounds"
          label={info?.title ?? ""}
          selected={build.background_id}
          onPick={(bid) => edit({ type: "background", id: bid })}
        />
      )}
      {step === "abilities" && <AbilitiesStep view={view} name={name} edit={edit} />}
      {step === "details" && <DetailsStep view={view} edit={edit} />}
      {choices.map((c) => (
        <ChoiceCard
          key={c.key}
          choice={c}
          characterId={id}
          onPick={(values) => edit({ type: "choice", key: c.key, values })}
        />
      ))}
      {choices.length === 0 &&
        !["class", "species", "background", "abilities", "details"].includes(step) && (
          <p className="text-ink-muted">{t("builder.noChoices")}</p>
        )}
    </>
  );
}

function StepFooter({
  view,
  step,
  onStep,
}: {
  view: BuildView;
  step: Step;
  onStep: (s: Step) => void;
}) {
  const index = view.steps.findIndex((s) => s.step === step);
  const prev = view.steps[index - 1];
  const next = view.steps[index + 1];
  return (
    <div className="flex justify-between gap-2 pt-2">
      {prev ? (
        <Button icon="chevronLeft" onClick={() => onStep(prev.step)}>
          {prev.title}
        </Button>
      ) : (
        <span />
      )}
      {next && (
        <Button variant="primary" onClick={() => onStep(next.step)}>
          {next.title}
          <span aria-hidden="true">›</span>
        </Button>
      )}
    </div>
  );
}
