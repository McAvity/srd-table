/**
 * kenli F-007 T05: the update UI (contract offline.md §6–§7). A new version is only offered:
 * Download (checked, not installed), then "Update now" after a confirmation that warns Undo won't
 * cover earlier actions, or "Later" (no consent; nothing changes at any restart). A refused update
 * lists exactly what to finish or close first, with a retry. While another window updates, this
 * one says changes are paused; after another release took control it asks for a reload.
 */

import { useState } from "react";
import { Button, Dialog, Section } from "@/components/ui";
import { type MessageKey, t } from "@/i18n";
import { en } from "@/i18n/en";
import type { Reason } from "@/offline/admission";
import { RELEASE_ID } from "@/offline/release";
import { useUpdate } from "@/offline/update";
import { useRolls } from "@/store/rolls";

export function reasonText(r: Reason): string {
  const key = `update.reason.${r.code}`;
  const text = Object.hasOwn(en, key) ? t(key as MessageKey) : r.code;
  return r.detail ? `${text} (${r.detail})` : text;
}

/** Offer, download, Now/Later, reasons and retry (Settings and the banner share it). */
export function UpdateControls({ compact = false }: { compact?: boolean }) {
  const u = useUpdate();
  const [confirm, setConfirm] = useState(false);
  const c = u.state?.candidate ?? null;
  const phase = u.state?.phase ?? "idle";
  const rolls = useRolls((s) => s.last);
  if (!c) return null;
  const busy = u.busy !== null;
  return (
    <div className="space-y-2 text-sm" data-testid="update-offer" data-phase={phase}>
      {!c.compatible ? (
        <p>{t("update.incompatible", { id: c.release_id })}</p>
      ) : phase === "offered" ? (
        <p>{t("update.offered", { id: c.release_id })}</p>
      ) : (
        <p>{t("update.downloaded", { id: c.release_id })}</p>
      )}
      {u.state?.deferred_at && !u.state.consent ? (
        <p className="text-ink-muted">{t("update.deferred")}</p>
      ) : null}
      {u.reasons.length > 0 && (
        <div className="text-red" role="alert" data-testid="update-reasons">
          <p>{t("update.failed")}</p>
          <ul className="list-disc pl-5">
            {u.reasons.map((r) => (
              <li key={`${r.code}-${r.detail}`} data-code={r.code}>
                {reasonText(r)}
              </li>
            ))}
          </ul>
        </div>
      )}
      {!compact && u.reasons.length === 0 && u.state?.last_error ? (
        <p className="text-ink-muted" data-testid="update-last-error">
          {t("update.lastError", { reason: reasonText(u.state.last_error) })}
        </p>
      ) : null}
      {c.compatible && (
        <div className="flex flex-wrap gap-2">
          {phase === "offered" ? (
            <Button icon="download" disabled={busy} onClick={() => void u.download()}>
              {u.busy === "downloading" ? t("update.downloading") : t("update.download")}
            </Button>
          ) : (
            <>
              <Button variant="primary" disabled={busy} onClick={() => setConfirm(true)}>
                {u.busy === "updating"
                  ? t("update.updating")
                  : u.reasons.length
                    ? t("update.retry")
                    : t("update.now")}
              </Button>
              <Button disabled={busy} onClick={() => void u.later()}>
                {t("update.later")}
              </Button>
            </>
          )}
          {u.reasons.some((r) => r.code === "reroll_window_open") &&
            Object.keys(rolls).length > 0 && (
              <Button
                onClick={() => {
                  for (const id of Object.keys(useRolls.getState().last))
                    useRolls.getState().forget(id);
                }}
              >
                {t("update.dismissRolls")}
              </Button>
            )}
        </div>
      )}
      <Dialog
        open={confirm}
        onOpenChange={setConfirm}
        title={t("update.confirm", { id: c.release_id })}
        description={t("update.confirmBody")}
        footer={
          <>
            <Button onClick={() => setConfirm(false)}>{t("common.cancel")}</Button>
            <Button
              variant="primary"
              onClick={() => {
                setConfirm(false);
                void u.now();
              }}
            >
              {t("update.now")}
            </Button>
          </>
        }
      />
    </div>
  );
}

/** Settings → App updates. */
export function UpdatePanel() {
  const u = useUpdate();
  return (
    <Section title={t("update.title")}>
      <p className="mb-2 text-sm text-ink-muted" data-testid="update-current">
        {t("update.current", { id: RELEASE_ID })}
      </p>
      <UpdateControls />
      <div className="mt-2">
        <Button size="sm" disabled={u.busy !== null} onClick={() => void u.check()}>
          {u.busy === "checking" ? t("update.checking") : t("update.check")}
        </Button>
      </div>
    </Section>
  );
}

/** A thin banner on every screen: paused, reload needed, read only, or an offer. */
export function UpdateBanner() {
  const u = useUpdate();
  const message = u.readOnly
    ? t("update.readOnly")
    : u.needsReload
      ? t("update.needsReload")
      : u.frozen
        ? t("update.frozen")
        : null;
  if (message)
    return (
      <div
        className="border-b border-edge bg-card-2 px-3 py-2 text-sm"
        role="alert"
        data-testid="update-banner"
      >
        {message}{" "}
        {(u.needsReload || u.readOnly) && (
          <Button size="sm" onClick={() => location.reload()}>
            {t("update.reload")}
          </Button>
        )}
      </div>
    );
  if (!u.state?.candidate?.compatible) return null;
  return (
    <div className="border-b border-edge bg-card-2 px-3 py-2" data-testid="update-banner">
      <UpdateControls compact />
    </div>
  );
}
