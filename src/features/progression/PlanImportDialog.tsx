/**
 * kenli F-002 T05: start a NEW character from a progression plan — a file or a URL (the import's
 * safe fetch), checked whole by the plan codec and compiled in the worker, then shown: title,
 * authorship, the levels it covers, its packs, and the chosen level's class, HP, AC and choices.
 * The level is chosen only here (an existing character only ever takes the next one). Start makes
 * one new character (`startFromPlan`); Cancel or closing changes nothing. A plan never overwrites
 * a played character. kenli F-002 T13: a guided plan (`/2`) offers its starting kit for the chosen
 * level, ticked by default — what is bought (owned units, bundles, units received, the catalog
 * cost), what is worn, the coins before and after, as the engine stages them; unticked, the start
 * is the plain one. The confirm stages the kit again and writes it with the character, or nothing.
 */

import { useNavigate } from "@tanstack/react-router";
import { useEffect, useId, useRef, useState } from "react";
import { Button, Dialog, Reasons, Spinner } from "@/components/ui";
import { engine } from "@/engine/client";
import type { PlanCompileResult } from "@/engine/plans";
import { t } from "@/i18n";
import { admission } from "@/offline/admission";
import { previewStart, startFromPlan } from "@/progression/advance";
import { type ParsedPlan, parsePlanFile } from "@/progression/codec";
import { planFromFile, planFromUrl } from "./source";
import { ChoiceList, downloadPlanMarkdown, progressionText } from "./text";

type Compiled = Extract<PlanCompileResult, { ok: true }>;
type Stage = Awaited<ReturnType<typeof previewStart>>;

export function PlanImportDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  useEffect(() => (open ? admission.hold("import_open") : undefined), [open]);
  const navigate = useNavigate();
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState<"loading" | "starting" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<{
    bytes: Uint8Array;
    parsed: ParsedPlan;
    compiled: Compiled;
    label: string;
  } | null>(null);
  const [level, setLevelNumber] = useState(1);
  // The field's own text, so it can be cleared and retyped; the level follows it when it's valid.
  const [levelText, setLevelText] = useState("1");
  const setLevel = (n: number) => {
    setLevelNumber(n);
    setLevelText(String(n));
  };
  // kenli F-002 T13: the guided kit (ticked by default) and its staged preview for this level.
  const [kit, setKit] = useState(true);
  const [stage, setStage] = useState<Stage | null>(null);
  const startingNow = useRef(false);
  const abort = useRef<AbortController | null>(null);
  const files = useRef<HTMLInputElement>(null);
  const levelId = useId();

  function reset() {
    abort.current?.abort();
    setLoaded(null);
    setProblem(null);
    setBusy(null);
    setLevel(1);
    setKit(true);
    setStage(null);
  }

  const guided = !!loaded?.parsed.file.plan.guide;
  useEffect(() => {
    let live = true;
    setStage(null);
    if (!loaded || !guided || !kit) return;
    void previewStart(loaded.bytes, level, true).then((r) => {
      if (live) setStage(r);
    });
    return () => {
      live = false;
    };
  }, [loaded, guided, kit, level]);

  async function take(source: Promise<Awaited<ReturnType<typeof planFromFile>>>) {
    setBusy("loading");
    setProblem(null);
    setLoaded(null);
    const got = await source;
    if (!got.ok) {
      setBusy(null);
      return setProblem(progressionText(got.code, got.detail));
    }
    const parsed = await parsePlanFile(got.bytes);
    if (!parsed.ok) {
      setBusy(null);
      return setProblem(progressionText(parsed.problem.code, parsed.problem.detail));
    }
    const compiled = await engine().compilePlan(got.bytes);
    setBusy(null);
    if (!compiled.ok)
      return setProblem(
        progressionText(compiled.problem.code, compiled.problem.detail) +
          (compiled.problem.level
            ? ` — ${t("progression.atLevel", { level: compiled.problem.level })}`
            : ""),
      );
    setLoaded({ bytes: got.bytes, parsed, compiled, label: got.label });
    setLevel(1);
  }

  function fromUrl() {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    void take(planFromUrl(url, controller.signal));
  }

  async function start() {
    if (!loaded || startingNow.current) return;
    startingNow.current = true;
    setBusy("starting");
    const withKit = guided && kit;
    const k = stage?.ok ? stage.kit : null;
    const r = await startFromPlan(loaded.bytes, level, {
      kit: withKit,
      ...(withKit && k ? { expect: { spent_cp: k.spent_cp, after_cp: k.after_cp } } : {}),
    });
    startingNow.current = false;
    setBusy(null);
    if (!r.ok) return setProblem(progressionText(r.code, r.detail));
    onOpenChange(false);
    reset();
    await navigate({ to: "/characters/$id/sheet", params: { id: r.id }, search: {} });
  }

  const plan = loaded?.parsed.file.plan;
  const to = loaded?.parsed.range.to ?? 1;
  const cp = loaded?.compiled.checkpoints[level - 1];
  const quick = [1, 7, 20].filter((l) => l <= to);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
      wide
      title={t("progression.importTitle")}
      description={t("progression.importHint")}
      footer={
        <>
          <Button
            onClick={() => {
              reset();
              onOpenChange(false);
            }}
            data-testid="plan-cancel"
          >
            {t("common.cancel")}
          </Button>
          {loaded && (
            <Button
              icon="download"
              onClick={() =>
                void downloadPlanMarkdown(loaded.parsed.file).then((p) => p && setProblem(p))
              }
              data-testid="plan-markdown"
            >
              {t("progression.markdown")}
            </Button>
          )}
          <Button
            variant="primary"
            icon="plus"
            disabled={
              !loaded ||
              busy !== null ||
              !levelText.trim() ||
              Number(levelText) !== level ||
              (guided && kit && !stage?.ok)
            }
            onClick={() => void start()}
            data-testid="plan-start"
          >
            {t("progression.start", { level })}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="flex flex-wrap items-end gap-2">
          <input
            ref={files}
            type="file"
            accept=".json,application/json"
            className="sr-only"
            data-testid="plan-file"
            onChange={(ev) => {
              const f = ev.currentTarget.files?.[0];
              ev.currentTarget.value = "";
              if (f) void take(planFromFile(f));
            }}
          />
          <Button icon="upload" onClick={() => files.current?.click()} disabled={busy !== null}>
            {t("progression.fromFile")}
          </Button>
          <form
            className="flex min-w-[16rem] flex-1 gap-2"
            onSubmit={(ev) => {
              ev.preventDefault();
              fromUrl();
            }}
          >
            <label className="sr-only" htmlFor={`${levelId}-url`}>
              {t("progression.url")}
            </label>
            <input
              id={`${levelId}-url`}
              className="input flex-1"
              type="url"
              placeholder="https://…"
              value={url}
              onChange={(ev) => setUrl(ev.currentTarget.value)}
              data-testid="plan-url"
            />
            <Button
              type="submit"
              disabled={!url.trim() || busy !== null}
              data-testid="plan-url-load"
            >
              {t("progression.fromUrl")}
            </Button>
          </form>
        </div>
        {busy === "loading" && <Spinner label={t("progression.loading")} />}
        <Reasons reasons={problem ? [problem] : null} />
        {plan && loaded && (
          <div className="space-y-3" data-testid="plan-preview">
            <div>
              <h3 className="font-display text-xl text-ink">{plan.title}</h3>
              <p className="text-sm text-ink-muted">
                {t("progression.range", { from: 1, to })}
                {to < 20 ? ` · ${t("progression.partial", { level: to })}` : ""}
              </p>
              <p className="text-sm text-ink-muted">
                {t("progression.authorship", {
                  source: plan.authorship.source,
                  author: plan.authorship.author,
                })}
              </p>
              <p className="text-sm text-ink-muted">
                {t("progression.packs")}:{" "}
                {plan.packs.map((p) => `${p.id} ${p.version ?? ""}`).join(", ")}
              </p>
            </div>
            <fieldset>
              <legend className="section-title">{t("progression.chooseLevel")}</legend>
              <div className="flex flex-wrap items-center gap-2">
                {quick.map((l) => (
                  <Button
                    key={l}
                    size="sm"
                    on={level === l}
                    aria-pressed={level === l}
                    onClick={() => setLevel(l)}
                    data-testid={`plan-level-${l}`}
                  >
                    {t("common.level", { level: l })}
                  </Button>
                ))}
                <label htmlFor={levelId} className="text-sm">
                  {t("progression.levelInput", { to })}
                </label>
                <input
                  id={levelId}
                  className="input w-20"
                  type="number"
                  min={1}
                  max={to}
                  value={levelText}
                  onChange={(ev) => {
                    const text = ev.currentTarget.value;
                    setLevelText(text);
                    const n = Number(text);
                    if (text.trim() && Number.isInteger(n) && n >= 1 && n <= to) setLevelNumber(n);
                  }}
                  onBlur={() => setLevelText(String(level))}
                  data-testid="plan-level"
                />
              </div>
            </fieldset>
            {cp && (
              <div className="rounded border border-edge p-2" data-testid="plan-checkpoint">
                <p className="font-bold">
                  {t("progression.checkpoint", {
                    level: cp.level,
                    classes: cp.stats.classes.map((c) => `${c.class_id} ${c.level}`).join(" / "),
                  })}
                </p>
                <p className="text-sm">
                  {t("progression.checkpointStats", {
                    hp: String(cp.stats.max_hp ?? "—"),
                    ac: cp.stats.armor_class,
                    pb: cp.stats.proficiency_bonus,
                  })}
                </p>
                <p className="text-sm text-ink-muted">{t("progression.checkpointNote")}</p>
                <h4 className="section-title mt-2">
                  {t("progression.choicesAt", { level: cp.level })}
                </h4>
                <ChoiceList ops={cp.ops} />
              </div>
            )}
            {guided && (
              <div className="rounded border border-edge p-2" data-testid="plan-kit">
                <label className="flex items-center gap-2 font-bold">
                  <input
                    type="checkbox"
                    checked={kit}
                    onChange={(ev) => setKit(ev.currentTarget.checked)}
                    data-testid="plan-kit-toggle"
                  />
                  {t("progression.kit.toggle")}
                </label>
                {!kit && <p className="text-sm text-ink-muted">{t("progression.kit.off")}</p>}
                {kit && !stage && <Spinner label={t("progression.loading")} />}
                {kit && stage && !stage.ok && (
                  <p role="alert" className="text-sm text-red" data-testid="plan-kit-refused">
                    {progressionText(stage.code, stage.detail)}
                  </p>
                )}
                {kit && stage?.ok && stage.kit && (
                  <>
                    <p className="text-sm">
                      {t("progression.kit.title", {
                        title: stage.kit.title,
                        from: stage.kit.from_level,
                      })}
                    </p>
                    <table className="mt-1 w-full text-sm" data-testid="plan-kit-lines">
                      <thead>
                        <tr className="text-left text-ink-muted">
                          <th>{t("progression.kit.item")}</th>
                          <th>{t("progression.kit.units")}</th>
                          <th>{t("progression.kit.owned")}</th>
                          <th>{t("progression.kit.received")}</th>
                          <th>{t("progression.kit.cost")}</th>
                          <th>{t("progression.kit.equip")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {stage.kit.lines.map((l) => (
                          <tr key={l.item} data-testid="plan-kit-line" data-item={l.item}>
                            <td>{l.name}</td>
                            <td>{l.units}</td>
                            <td>{l.owned}</td>
                            <td>
                              {l.received}
                              {l.bundle > 1
                                ? ` (${t("progression.kit.bundles", { bundles: l.bundles, bundle: l.bundle })})`
                                : ""}
                            </td>
                            <td>{l.cost_text}</td>
                            <td>{l.equip ? t("progression.kit.worn") : ""}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <p className="mt-1 text-sm" data-testid="plan-kit-coins">
                      {t("progression.kit.coins", {
                        before: stage.kit.text.before,
                        spent: stage.kit.text.spent,
                        after: stage.kit.text.after,
                      })}
                    </p>
                    <p className="text-[13px] text-ink-muted">{t("progression.kit.budget")}</p>
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </Dialog>
  );
}
