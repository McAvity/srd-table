/**
 * kenli F-011 T04: "Import character" — the only character entrance (changes.md §8): one full copy
 * `srd-table.local-copy/2`, from a file or by URL (the copy, or a library pointer to one; bounded,
 * with Stop). Any other root is refused before the check. Built on F-007 T03 (local-copy.md §5–§7):
 * the copy is checked whole (with the engine and the portrait's full decode) and previewed — who,
 * from where, the state and its origin, the portrait, the history (done/undone/refused, days, Long
 * Rests, decisions that were waiting), the packs (new, already here, in conflict), its size, and
 * that a separate new character is made. Nothing is written before Create; the same copy loaded
 * before needs the explicit "another separate copy". Saved but not shown (the publication failed):
 * said, with a retry that never makes a second copy, or a reload. The last import can be undone
 * and redone in this session (`LocalCopyLast`).
 */

import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
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
import { LOCAL_COPY_LIMITS, validateLocalCopy } from "@/import/localCopy/format";
import { type LocalCopyPlan, planLocalCopy } from "@/import/localCopy/plan";
import { checkCopyRoot, fetchCopy } from "@/import/localCopy/url";
import { ImportError } from "@/import/transfer";
import { admission } from "@/offline/admission";
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
  // kenli F-007 T05: an open local-copy import blocks an update until it closes (offline.md §7.3).
  useEffect(() => (open ? admission.hold("import_open") : undefined), [open]);
  const characters = useDocuments((s) => s.characters);
  const navigate = useNavigate();
  const [busy, setBusy] = useState<"fetching" | "checking" | "committing" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [plan, setPlan] = useState<LocalCopyPlan | null>(null);
  const [another, setAnother] = useState(false);
  const [unpublished, setUnpublished] = useState<Extract<
    CommitResult,
    { ok: "saved_unpublished" }
  > | null>(null);
  const [url, setUrl] = useState("");
  const file = useRef<HTMLInputElement>(null);
  const run = useRef(0);
  const abort = useRef<AbortController | null>(null);

  function reset() {
    run.current += 1;
    abort.current?.abort();
    abort.current = null;
    setBusy(null);
    setProblem(null);
    setPlan(null);
    setAnother(false);
    setUnpublished(null);
  }

  /** The whole check (§8 root, then §2 validation), then the preview; nothing is written. */
  async function check(mine: number, bytes: Uint8Array, name: string, expect: string | null) {
    try {
      checkCopyRoot(bytes);
    } catch (error) {
      if (!(error instanceof ImportError)) throw error;
      setBusy(null);
      setProblem(localCopyProblemText(error.code, error.detail));
      return;
    }
    const v = await validateLocalCopy(bytes);
    if (run.current !== mine) return; // cancelled meanwhile: nothing was written
    if (!v.ok || (expect !== null && v.copy.payload_sha256 !== expect)) {
      setBusy(null);
      setProblem(
        v.ok
          ? localCopyProblemText("hash_mismatch", "the library link names another copy")
          : localCopyProblemText(v.code, v.detail),
      );
      return;
    }
    const p = await planLocalCopy(v.copy, v.bytes_sha256, name, { size: bytes.byteLength });
    if (run.current !== mine) return;
    setBusy(null);
    setPlan(p);
  }

  async function onFile(list: FileList | null) {
    const f = list?.[0];
    if (!f) return;
    reset();
    if (file.current) file.current.value = "";
    // F-011 R03-08: the copy's 20 MiB bound from the file's size, before it is read at all.
    if (f.size > LOCAL_COPY_LIMITS.copyBytes) {
      setProblem(
        localCopyProblemText("limit_copy_bytes", `${f.size} > ${LOCAL_COPY_LIMITS.copyBytes}`),
      );
      return;
    }
    const mine = run.current;
    setBusy("checking");
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await f.arrayBuffer());
    } catch (error) {
      if (run.current !== mine) return; // closed or replaced meanwhile: nothing to say
      setBusy(null);
      setProblem(
        localCopyProblemText("file_read_failed", error instanceof Error ? error.message : ""),
      );
      return;
    }
    if (run.current !== mine) return; // closed or replaced while reading: nothing was written
    await check(mine, bytes, f.name, null);
  }

  /** A copy (or a library link to one) by URL: bounded, cancellable (Stop), then the same check. */
  async function onUrl() {
    if (!url.trim()) return;
    reset();
    const mine = run.current;
    const controller = new AbortController();
    abort.current = controller;
    setBusy("fetching");
    try {
      const got = await fetchCopy(url.trim(), controller.signal);
      if (run.current !== mine) return;
      setBusy("checking");
      await check(mine, got.bytes, got.name, got.expect);
    } catch (error) {
      if (run.current !== mine) return;
      setBusy(null);
      const e =
        error instanceof ImportError
          ? error
          : new ImportError(controller.signal.aborted ? "cancelled" : "fetch_failed");
      setProblem(localCopyProblemText(e.code, e.detail));
    } finally {
      if (abort.current === controller) abort.current = null;
    }
  }

  function onStop() {
    reset(); // aborts the fetch; the run's late answers are dropped
    setProblem(localCopyProblemText("cancelled"));
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
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void onUrl();
          }}
        >
          <label className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="text-ink-muted">{t("localCopy.importUrl")}</span>
            <input
              type="url"
              className="field"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              data-testid="local-copy-url"
            />
          </label>
          {busy === "fetching" ? (
            <Button type="button" onClick={onStop} data-testid="local-copy-stop">
              {t("localCopy.stop")}
            </Button>
          ) : (
            <Button
              type="submit"
              disabled={!url.trim() || busy !== null}
              data-testid="local-copy-fetch"
            >
              {t("localCopy.fetch")}
            </Button>
          )}
        </form>
        {busy === "fetching" && <Spinner label={t("localCopy.fetching")} />}
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
            {s.library && (
              <p>
                {t("localCopy.library", {
                  label: s.library.label ?? s.library.slug,
                  slug: s.library.slug,
                })}
              </p>
            )}
            <p data-testid="local-copy-state-origin">
              {s.state_origin === "synthetic"
                ? t("localCopy.stateOrigin.synthetic")
                : s.state_origin === "new_session"
                  ? t("localCopy.stateOrigin.new_session")
                  : t("localCopy.stateOrigin.exported")}
            </p>
            <p data-testid="local-copy-portrait">
              {s.portrait
                ? t("localCopy.portrait", {
                    mime: s.portrait.mime,
                    size: formatSize(s.portrait.bytes),
                  })
                : t("localCopy.noPortrait")}
            </p>
            {s.hp && <p>{t("localCopy.hp", { current: s.hp.current, max: s.hp.max })}</p>}
            <p data-testid="local-copy-entries">
              {t("localCopy.entries", {
                total: s.entries.total,
                done: s.entries.done,
                undone: s.entries.undone,
              })}
            </p>
            {s.entries.refused > 0 && <p>{t("localCopy.refused", { count: s.entries.refused })}</p>}
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
