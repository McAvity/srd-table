/**
 * kenli F-007 T03: "Load local copy" (contract local-copy.md §5–§7). A file is checked whole (with
 * the engine) and previewed — who, from where, the state, the history (done/undone, days, Long
 * Rests, decisions that were waiting), the packs (new, already here, in conflict), its size, and
 * that a separate new character is made. Nothing is written before Create; the same copy loaded
 * before needs the explicit "another separate copy". Saved but not shown (the publication failed):
 * said, with a retry that never makes a second copy, or a reload. The last import can be undone
 * and redone in this session (`LocalCopyLast`).
 */

import { useNavigate } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { Button, Dialog, Spinner } from "@/components/ui";
import { dayName } from "@/features/history/format";
import { t } from "@/i18n";
import { en } from "@/i18n/en";
import {
  type CommitResult,
  commitLocalCopy,
  redoLocalCopyImport,
  undoLocalCopyImport,
  useLocalCopySession,
} from "@/import/localCopy/commit";
import { validateLocalCopy } from "@/import/localCopy/format";
import { type LocalCopyPlan, planLocalCopy } from "@/import/localCopy/plan";
import { useDocuments } from "@/store/documents";
import { useUi } from "@/store/ui";
import { formatSize } from "./LocalCopyExport";

/** A local-copy refusal in the app's words, then its technical detail (plain text). */
export function localCopyProblemText(code: string, detail = ""): string {
  const key = `localCopy.problem.${code}` as keyof typeof en;
  const malformed =
    /^(history_|external_|envelope_|source_invalid|character_invalid|context_|pack_)/.test(code);
  const text = Object.hasOwn(en, key)
    ? t(key)
    : malformed
      ? t("localCopy.problem.malformed", { code })
      : t("localCopy.problem.other", { code });
  return detail ? `${text} (${detail})` : text;
}

const refs = (list: readonly { id: string; version: string | null }[]) =>
  list.map((p) => `${p.id} ${p.version ?? ""}`.trim()).join(", ");

export function LocalCopyImport({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const characters = useDocuments((s) => s.characters);
  const navigate = useNavigate();
  const [busy, setBusy] = useState<"checking" | "committing" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [plan, setPlan] = useState<LocalCopyPlan | null>(null);
  const [another, setAnother] = useState(false);
  const [unpublished, setUnpublished] = useState<Extract<
    CommitResult,
    { ok: "saved_unpublished" }
  > | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const run = useRef(0);

  function reset() {
    run.current += 1;
    setBusy(null);
    setProblem(null);
    setPlan(null);
    setAnother(false);
    setUnpublished(null);
  }

  async function onFile(list: FileList | null) {
    const f = list?.[0];
    if (!f) return;
    reset();
    const mine = run.current;
    setBusy("checking");
    const bytes = new Uint8Array(await f.arrayBuffer());
    if (file.current) file.current.value = "";
    const v = await validateLocalCopy(bytes);
    if (run.current !== mine) return; // cancelled meanwhile: nothing was written
    if (!v.ok) {
      setBusy(null);
      setProblem(localCopyProblemText(v.code, v.detail));
      return;
    }
    const p = await planLocalCopy(v.copy, v.bytes_sha256, f.name, { size: bytes.byteLength });
    if (run.current !== mine) return;
    setBusy(null);
    setPlan(p);
  }

  async function onCreate() {
    if (!plan) return;
    setBusy("committing");
    setProblem(null);
    const r = await commitLocalCopy(plan, { confirmNewCopy: another });
    setBusy(null);
    if (r.ok === true) {
      const name = plan.summary.name || t("common.unnamed");
      useUi.getState().toast([t("localCopy.created", { name })], "info");
      reset();
      onOpenChange(false);
      await navigate({ to: "/characters/$id/sheet", params: { id: r.recordId }, search: {} });
      return;
    }
    if (r.ok === "saved_unpublished") {
      setUnpublished(r);
      return;
    }
    setProblem(localCopyProblemText(r.code, r.detail));
  }

  const already = plan?.already_imported ?? [];
  const blocked = !plan || plan.packs.conflict.length > 0 || (already.length > 0 && !another);
  const s = plan?.summary;
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
      title={t("localCopy.importTitle")}
      wide
      footer={
        <>
          <Button
            disabled={busy === "committing"}
            onClick={() => {
              reset();
              onOpenChange(false);
            }}
          >
            {t("common.cancel")}
          </Button>
          {unpublished ? (
            <>
              <Button onClick={() => void onCreate()} disabled={busy !== null}>
                {t("localCopy.retry")}
              </Button>
              <Button variant="primary" onClick={() => location.reload()}>
                {t("localCopy.reload")}
              </Button>
            </>
          ) : (
            <Button
              variant="primary"
              icon="check"
              disabled={blocked || busy !== null}
              onClick={() => void onCreate()}
            >
              {already.length ? t("localCopy.confirmAnother") : t("localCopy.confirm")}
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-3 text-sm" data-testid="local-copy-import">
        <label className="flex flex-col gap-1">
          <span className="text-ink-muted">{t("localCopy.importPick")}</span>
          <input
            ref={file}
            type="file"
            accept=".json,application/json"
            data-testid="local-copy-file"
            onChange={(e) => void onFile(e.target.files)}
          />
        </label>
        {busy === "checking" && <Spinner label={t("localCopy.checking")} />}
        {busy === "committing" && <Spinner />}
        {problem && (
          <p className="text-red" role="alert" data-testid="local-copy-problem">
            {problem}
          </p>
        )}
        {unpublished && (
          <p className="text-orange" role="alert" data-testid="local-copy-unpublished">
            {t("localCopy.unpublished", {
              name: s?.name || t("common.unnamed"),
              importId: unpublished.import_id,
            })}
          </p>
        )}
        {plan && s && (
          <div className="space-y-2" data-testid="local-copy-preview">
            <p className="font-display text-xl text-ink">{s.name || t("common.unnamed")}</p>
            <p className="text-ink-muted">
              {t("localCopy.from", {
                installation: s.installation_id,
                at: new Date(s.exported_at).toLocaleString(),
              })}
              {s.release_id ? ` · ${t("localCopy.fromRelease", { release: s.release_id })}` : ""}
            </p>
            {s.hp && <p>{t("localCopy.hp", { current: s.hp.current, max: s.hp.max })}</p>}
            <p data-testid="local-copy-entries">
              {t("localCopy.entries", {
                total: s.entries.total,
                done: s.entries.done,
                undone: s.entries.undone,
              })}
            </p>
            <p>{t("localCopy.longRests", { count: s.long_rests })}</p>
            {s.pending_historical > 0 && (
              <p>{t("localCopy.pendingHistorical", { count: s.pending_historical })}</p>
            )}
            {s.days.length > 0 && (
              <details>
                <summary className="cursor-pointer">{t("localCopy.days")}</summary>
                <ul>
                  {s.days.map((d) => (
                    <li key={d.id}>
                      {t("localCopy.dayRests", { name: dayName(d as never), rests: d.long_rests })}
                    </li>
                  ))}
                </ul>
              </details>
            )}
            {plan.packs.new.length > 0 && (
              <p>{t("localCopy.packsNew", { list: refs(plan.packs.new) })}</p>
            )}
            {plan.packs.present.length > 0 && (
              <p>{t("localCopy.packsPresent", { list: refs(plan.packs.present) })}</p>
            )}
            {plan.packs.conflict.length > 0 && (
              <p className="text-red">
                {t("localCopy.packsConflict", { list: refs(plan.packs.conflict) })}
              </p>
            )}
            {plan.size !== null && <p>{t("localCopy.size", { size: formatSize(plan.size) })}</p>}
            {s.legacy && <p>{t("localCopy.legacy")}</p>}
            <p className="font-semibold">{t("localCopy.separate")}</p>
            {already.length > 0 && (
              <div className="rounded border border-orange p-2" data-testid="local-copy-already">
                <p>
                  {t("localCopy.already", {
                    names: already
                      .map((id) => characters[id]?.build.name || t("common.unnamed"))
                      .join(", "),
                  })}
                </p>
                <label className="mt-1 flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={another}
                    onChange={(e) => setAnother(e.target.checked)}
                    data-testid="local-copy-another"
                  />
                  {t("localCopy.confirmAnother")}
                </label>
              </div>
            )}
          </div>
        )}
      </div>
    </Dialog>
  );
}

/** The session's last local-copy import, with its Undo/Redo (gone after a reload). */
export function LocalCopyLast() {
  const last = useLocalCopySession((s) => s.last);
  const [busy, setBusy] = useState(false);
  if (!last) return null;
  const name = last.record.build.name || t("common.unnamed");
  async function act(kind: "undo" | "redo") {
    setBusy(true);
    const r = kind === "undo" ? await undoLocalCopyImport() : await redoLocalCopyImport();
    setBusy(false);
    if (r.ok) {
      if (kind === "undo") useUi.getState().toast([t("localCopy.undone", { name })], "info");
    } else useUi.getState().toast([localCopyProblemText(r.code, r.detail)], "error");
  }
  return (
    <div
      className="panel mb-3 flex flex-wrap items-center gap-2 p-2 text-sm"
      data-testid="local-copy-last"
    >
      <span className="flex-1">{t("localCopy.last", { name })}</span>
      {last.state === "done" ? (
        <Button size="sm" icon="undo" disabled={busy} onClick={() => void act("undo")}>
          {t("localCopy.undo")}
        </Button>
      ) : (
        <Button size="sm" icon="redo" disabled={busy} onClick={() => void act("redo")}>
          {t("localCopy.redo")}
        </Button>
      )}
    </div>
  );
}
