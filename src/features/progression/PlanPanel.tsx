/**
 * kenli F-002 T05: the plan on a character's sheet. A character following a plan shows it and its
 * only planned move — the NEXT level — previewed (choices, HP, AC, resources, warnings) before one
 * confirm (`previewAdvance` / `confirmStep`); at the plan's end there is no next. A character
 * without a plan can be bound to one whose prefix it already is (`previewBind`, file or URL). Every
 * refusal is said where it happened and leaves the character as it is; a busy character says what
 * to finish first and offers it: the open roll ends here (`useRolls.forget`, nothing paid or
 * changed), a pending decision is answered in its encounter (never chosen for the player).
 * Detaching drops only the association, after an explicit warning (one Undo restores it).
 *
 * Isolation (review07 R07-01/R07-02): the panel is keyed by the character (`SheetPage`), and each
 * request carries a ticket of `useTickets`: a result that arrives after its dialog was cancelled or
 * closed, after another request, after the panel unmounted, or for another character is dropped,
 * so an old preview can never reappear or be confirmed on another character's screen. A bind keeps
 * only the file it just verified for this character, so "Finish current roll" can preview it again
 * (never confirm it); closing the dialog forgets it.
 */

import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Button, Dialog, Reasons, Section, Spinner } from "@/components/ui";
import { t } from "@/i18n";
import { admission } from "@/offline/admission";
import {
  confirmStep,
  detachProgression,
  type ProgressionRefusal,
  previewAdvance,
  previewBind,
  type StepPreview,
} from "@/progression/advance";
import { type ProgressionMeta, readProgression } from "@/progression/record";
import type { CharacterRecord } from "@/store/documents";
import { useDocuments } from "@/store/documents";
import { useRolls } from "@/store/rolls";
import { planFromFile, planFromUrl } from "./source";
import { downloadPlanMarkdown, progressionText, StepPreviewView } from "./text";

type Read =
  | { kind: "none" }
  | { kind: "plan"; meta: ProgressionMeta }
  | { kind: "unsupported"; detail: string };

function usePlanOf(record: CharacterRecord): Read | null {
  const [read, setRead] = useState<Read | null>(null);
  useEffect(() => {
    let live = true;
    void readProgression(record.progression).then((r) => {
      if (!live) return;
      setRead(
        !r.ok
          ? { kind: "unsupported", detail: r.detail }
          : r.progression
            ? { kind: "plan", meta: r.progression }
            : { kind: "none" },
      );
    });
    return () => {
      live = false;
    };
  }, [record.progression]);
  return read;
}

/**
 * Tickets for async requests: `take()` starts one (dropping any earlier), `drop()` cancels the
 * current one, `live(ticket)` says whether its result may still be shown. Unmount drops all.
 */
function useTickets() {
  const current = useRef(0);
  useEffect(() => {
    // (Re)mounted: tickets work (StrictMode mounts twice); unmounted: every result is dropped.
    if (current.current < 0) current.current = 0;
    return () => {
      current.current = -1;
    };
  }, []);
  const take = useCallback(() => {
    if (current.current < 0) return -1;
    current.current += 1;
    return current.current;
  }, []);
  const drop = useCallback(() => {
    if (current.current >= 0) current.current += 1;
  }, []);
  const live = useCallback((ticket: number) => ticket >= 0 && ticket === current.current, []);
  return { take, drop, live };
}

export function PlanPanel({ record }: { record: CharacterRecord }) {
  const read = usePlanOf(record);
  const tickets = useTickets();
  const [preview, setPreview] = useState<StepPreview | null>(null);
  const [refusal, setRefusal] = useState<ProgressionRefusal | null>(null);
  const [busy, setBusy] = useState(false);
  const [binding, setBinding] = useState(false);
  const [detaching, setDetaching] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const id = record.id;

  /** A preview is shown only on its own character's panel. */
  const showPreview = (p: StepPreview) => {
    if (p.record_id === id) setPreview(p);
  };
  const closePreview = () => {
    tickets.drop();
    setBusy(false);
    setPreview(null);
  };

  async function next() {
    const ticket = tickets.take();
    setBusy(true);
    setNote(null);
    setRefusal(null);
    setPreview(null);
    const r = await previewAdvance(id);
    if (!tickets.live(ticket)) return;
    setBusy(false);
    if (r.ok) showPreview(r);
    else setRefusal(r);
  }

  async function confirm() {
    if (!preview || preview.record_id !== id) return;
    const ticket = tickets.take();
    setBusy(true);
    const r = await confirmStep(preview);
    // The step is the API's (atomic, its own token); only what this panel shows depends on it.
    if (!tickets.live(ticket)) return;
    setBusy(false);
    setPreview(null);
    if (r.ok)
      setNote(
        preview.kind === "advance"
          ? t("progression.advanced", { level: preview.to_level })
          : t("progression.bound", { level: preview.to_level }),
      );
    else setRefusal(r);
  }

  async function finishRoll() {
    // Ends the window of the last roll only: nothing is paid, rolled or written.
    useRolls.getState().forget(id);
    await next();
  }

  if (!read) return null;
  const meta = read.kind === "plan" ? read.meta : null;
  const to = meta ? 1 + meta.plan.plan.levels.length : 0;
  const level = record.build.class_id ? 1 + record.build.levels.length : 0;

  return (
    <Section title={t("progression.panel")} id="plan" bodyClassName="space-y-2">
      <div data-testid="plan-panel" className="space-y-2">
        {read.kind === "unsupported" && (
          <p className="text-sm text-orange">
            {progressionText("progression_unsupported", read.detail)}
          </p>
        )}
        {meta && (
          <>
            <p className="font-bold" data-testid="plan-title">
              {meta.plan.plan.title}
            </p>
            <p className="text-sm text-ink-muted" data-testid="plan-level-status">
              {t("progression.status", { level: meta.applied_level, to })}
            </p>
            <div className="flex flex-wrap gap-1.5">
              {meta.applied_level < to ? (
                <Button
                  variant="primary"
                  size="sm"
                  icon="plus"
                  disabled={busy}
                  onClick={() => void next()}
                  data-testid="plan-next"
                >
                  {t("progression.next", { level: meta.applied_level + 1 })}
                </Button>
              ) : (
                <p className="text-sm" data-testid="plan-end">
                  {t("progression.end", { level: to })}
                </p>
              )}
              <Button
                size="sm"
                icon="download"
                onClick={() => void downloadPlanMarkdown(meta.plan).then((p) => p && setNote(p))}
                data-testid="plan-markdown"
              >
                {t("progression.markdown")}
              </Button>
              <Button
                size="sm"
                variant="danger"
                icon="x"
                onClick={() => setDetaching(true)}
                data-testid="plan-detach"
              >
                {t("progression.detach")}
              </Button>
            </div>
          </>
        )}
        {read.kind === "none" && (
          <>
            <p className="text-sm text-ink-muted">{t("progression.nonePlan", { level })}</p>
            <Button
              size="sm"
              icon="upload"
              onClick={() => setBinding(true)}
              data-testid="plan-bind-open"
            >
              {t("progression.bindOpen")}
            </Button>
          </>
        )}
        {busy && <Spinner label={t("progression.loading")} />}
        {note && (
          <p role="status" className="text-sm text-green" data-testid="plan-note">
            {note}
          </p>
        )}
        {refusal && (
          <RefusalView
            refusal={refusal}
            onFinishRoll={() => void finishRoll()}
            onDetach={() => setDetaching(true)}
          />
        )}
      </div>
      <Dialog
        open={preview !== null && preview.record_id === id}
        onOpenChange={(open) => !open && closePreview()}
        wide
        title={
          preview?.kind === "bind" ? t("progression.bindTitle") : t("progression.advanceTitle")
        }
        footer={
          <>
            <Button onClick={closePreview} data-testid="plan-preview-cancel">
              {t("common.cancel")}
            </Button>
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => void confirm()}
              data-testid="plan-confirm"
            >
              {preview?.kind === "bind"
                ? t("progression.bindConfirm")
                : t("progression.advanceConfirm", { level: preview?.to_level ?? 0 })}
            </Button>
          </>
        }
      >
        {preview && preview.record_id === id && <StepPreviewView preview={preview} />}
      </Dialog>
      <BindDialog
        id={id}
        open={binding}
        onOpenChange={setBinding}
        onPreview={(p) => {
          setBinding(false);
          setRefusal(null);
          showPreview(p);
        }}
      />
      <Dialog
        open={detaching}
        onOpenChange={setDetaching}
        title={t("progression.detachTitle")}
        description={t("progression.detachWarning")}
        footer={
          <>
            <Button onClick={() => setDetaching(false)}>{t("common.cancel")}</Button>
            <Button
              variant="danger"
              data-testid="plan-detach-confirm"
              onClick={() => {
                const ticket = tickets.take();
                void detachProgression(id).then((r) => {
                  if (!tickets.live(ticket)) return;
                  setDetaching(false);
                  setRefusal(r.ok ? null : r);
                  setNote(r.ok ? t("progression.detached") : null);
                });
              }}
            >
              {t("progression.detachConfirm")}
            </Button>
          </>
        }
      />
    </Section>
  );
}

function RefusalView({
  refusal,
  onFinishRoll,
  onDetach,
}: {
  refusal: ProgressionRefusal;
  onFinishRoll: () => void;
  onDetach: () => void;
}) {
  const encounters = useDocuments((s) => s.encounters);
  return (
    <div className="space-y-2" data-testid="plan-refusal" data-code={refusal.code}>
      <Reasons reasons={[progressionText(refusal.code, refusal.busy ? "" : refusal.detail)]} />
      {refusal.busy?.kind === "roll" && (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm">{t("progression.busyRoll")}</p>
          <Button size="sm" variant="primary" onClick={onFinishRoll} data-testid="plan-finish-roll">
            {t("progression.finishRoll")}
          </Button>
        </div>
      )}
      {refusal.busy?.kind === "decision" && (
        <div className="space-y-1">
          <p className="text-sm">{t("progression.busyDecision")}</p>
          <ul className="flex flex-wrap gap-1.5">
            {refusal.busy.encounters.map((eid) => (
              <li key={eid}>
                <Link
                  to="/encounters/$id"
                  params={{ id: eid }}
                  className="btn btn-sm"
                  data-testid="plan-open-decision"
                >
                  {t("progression.openDecision", { name: encounters[eid]?.name ?? eid })}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
      {refusal.differences && refusal.differences.length > 0 && (
        <details open>
          <summary className="cursor-pointer text-sm">
            {t("progression.differences", { count: refusal.differences.length })}
          </summary>
          <ul className="text-sm" data-testid="plan-differences">
            {refusal.differences.slice(0, 20).map((d) => (
              <li key={d.path}>
                <code>{d.path}</code>: {JSON.stringify(d.record)} ≠ {JSON.stringify(d.plan)}
              </li>
            ))}
          </ul>
        </details>
      )}
      {refusal.state && refusal.state.length > 0 && (
        <ul className="text-sm" data-testid="plan-state-loss">
          {refusal.state.map((d) => (
            <li key={d.path}>
              <code>{d.path}</code>: {JSON.stringify(d.before)} → {JSON.stringify(d.after)}
            </li>
          ))}
        </ul>
      )}
      {refusal.code === "advance_diverged" && (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm">{t("progression.divergedHelp")}</p>
          <Button size="sm" variant="danger" onClick={onDetach}>
            {t("progression.detach")}
          </Button>
        </div>
      )}
    </div>
  );
}

/** Bind: a plan file or URL for this character (its current level, never another). */
function BindDialog({
  id,
  open,
  onOpenChange,
  onPreview,
}: {
  id: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPreview: (p: StepPreview) => void;
}) {
  useEffect(() => (open ? admission.hold("import_open") : undefined), [open]);
  const tickets = useTickets();
  /** The plan file this dialog last read, for this character only; forgotten on close. */
  const input = useRef<Uint8Array | null>(null);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<ProgressionRefusal | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const files = useRef<HTMLInputElement>(null);
  const abort = useRef<AbortController | null>(null);
  const urlId = useId();

  async function bind(bytes: Uint8Array, ticket: number) {
    const r = await previewBind(id, bytes);
    if (!tickets.live(ticket)) return;
    setBusy(false);
    if (r.ok) {
      input.current = null;
      onPreview(r);
    } else setRefusal(r);
  }

  async function take(source: ReturnType<typeof planFromFile>) {
    const ticket = tickets.take();
    input.current = null;
    setBusy(true);
    setProblem(null);
    setRefusal(null);
    const got = await source;
    if (!tickets.live(ticket)) return;
    if (!got.ok) {
      setBusy(false);
      return setProblem(progressionText(got.code, got.detail));
    }
    input.current = got.bytes;
    await bind(got.bytes, ticket);
  }

  /** The open roll ends (nothing paid or written), then the same file is previewed again. */
  async function finishRoll() {
    useRolls.getState().forget(id);
    const bytes = input.current;
    if (!bytes) return setRefusal(null);
    const ticket = tickets.take();
    setBusy(true);
    setRefusal(null);
    await bind(bytes, ticket);
  }

  function close() {
    tickets.drop();
    abort.current?.abort();
    input.current = null;
    setBusy(false);
    setProblem(null);
    setRefusal(null);
    onOpenChange(false);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => (next ? onOpenChange(true) : close())}
      wide
      title={t("progression.bindTitle")}
      description={t("progression.bindHint")}
      footer={
        <Button onClick={close} data-testid="plan-bind-cancel">
          {t("common.cancel")}
        </Button>
      }
    >
      <div className="space-y-2">
        <div className="flex flex-wrap items-end gap-2">
          <input
            ref={files}
            type="file"
            accept=".json,application/json"
            className="sr-only"
            data-testid="plan-bind-file"
            onChange={(ev) => {
              const f = ev.currentTarget.files?.[0];
              ev.currentTarget.value = "";
              if (f) void take(planFromFile(f));
            }}
          />
          <Button icon="upload" onClick={() => files.current?.click()} disabled={busy}>
            {t("progression.fromFile")}
          </Button>
          <form
            className="flex min-w-[16rem] flex-1 gap-2"
            onSubmit={(ev) => {
              ev.preventDefault();
              abort.current?.abort();
              const c = new AbortController();
              abort.current = c;
              void take(planFromUrl(url, c.signal));
            }}
          >
            <label className="sr-only" htmlFor={urlId}>
              {t("progression.url")}
            </label>
            <input
              id={urlId}
              className="input flex-1"
              type="url"
              value={url}
              onChange={(ev) => setUrl(ev.currentTarget.value)}
              placeholder="https://…"
            />
            <Button type="submit" disabled={!url.trim() || busy}>
              {t("progression.fromUrl")}
            </Button>
          </form>
        </div>
        {busy && <Spinner label={t("progression.loading")} />}
        <Reasons reasons={problem ? [problem] : null} />
        {refusal && (
          <RefusalView
            refusal={refusal}
            onFinishRoll={() => void finishRoll()}
            onDetach={() => undefined}
          />
        )}
      </div>
    </Dialog>
  );
}
