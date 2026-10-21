/**
 * Every builder edit goes through the engine's `previewChange` first: when the change would
 * remove other picks (or, for a past level, ask new questions), the player sees exactly what and
 * confirms before anything is applied. Refusals come back as reasons to show where they acted.
 */

import { useEffect, useState } from "react";
import { Button, Dialog, Reasons } from "@/components/ui";
import type { BuildEdit, ChangePreview } from "@/engine/facade";
import { t } from "@/i18n";
import { admission } from "@/offline/admission";
import { useDocuments } from "@/store/documents";

export interface PreviewedEdit {
  /** Apply an edit (after a preview); resolves to the refusal reasons, or `null` when applied. */
  request(edit: BuildEdit, options?: { past?: boolean }): Promise<readonly string[] | null>;
  dialog: React.ReactNode;
}

export function usePreviewedEdit(characterId: string): PreviewedEdit {
  const previewEdit = useDocuments((s) => s.previewEdit);
  const editBuild = useDocuments((s) => s.editBuild);
  const [pending, setPending] = useState<{
    edit: BuildEdit;
    preview: ChangePreview;
    resolve: (reasons: readonly string[] | null) => void;
  } | null>(null);
  const [reasons, setReasons] = useState<readonly string[] | null>(null);
  // kenli F-007 T05: a build change waiting for confirmation blocks an update (offline.md §7.3).
  const asking = pending !== null;
  useEffect(() => (asking ? admission.hold("build_preview_open") : undefined), [asking]);

  async function apply(edit: BuildEdit): Promise<readonly string[] | null> {
    const result = await editBuild(characterId, edit);
    return result.ok ? null : result.reasons;
  }

  async function request(edit: BuildEdit, options: { past?: boolean } = {}) {
    const preview = await previewEdit(characterId, edit);
    if (!preview.ok) return preview.reasons;
    const asks =
      preview.removed.length > 0 || (options.past === true && preview.pending.length > 0);
    if (!asks) return apply(edit);
    setReasons(null);
    return new Promise<readonly string[] | null>((resolve) =>
      setPending({ edit, preview, resolve }),
    );
  }

  const close = (result: readonly string[] | null) => {
    pending?.resolve(result);
    setPending(null);
  };

  const dialog = (
    <Dialog
      open={pending !== null}
      onOpenChange={(open) => {
        if (!open) close(null);
      }}
      title={t("builder.previewTitle")}
      footer={
        <>
          <Button onClick={() => close(null)}>{t("common.cancel")}</Button>
          <Button
            variant="primary"
            icon="check"
            onClick={async () => {
              if (!pending) return;
              const result = await apply(pending.edit);
              if (result) setReasons(result);
              else close(null);
            }}
          >
            {t("common.apply")}
          </Button>
        </>
      }
    >
      {pending && <PreviewBody preview={pending.preview} />}
      <Reasons reasons={reasons} className="mt-3" />
    </Dialog>
  );

  return { request, dialog };
}

function PreviewBody({ preview }: { preview: ChangePreview }) {
  if (!preview.removed.length && !preview.pending.length)
    return <p>{t("builder.previewNothing")}</p>;
  return (
    <div className="space-y-3 text-sm">
      {preview.removed.length > 0 && (
        <div>
          <p className="mb-1 font-semibold">{t("builder.previewRemoved")}</p>
          <ul className="space-y-1">
            {preview.removed.map((r) => (
              <li key={r.key} className="rounded border border-red/50 bg-red-dim/30 px-2 py-1">
                <span className="text-ink-muted">
                  {t("builder.levelOf", { level: r.level })} ·{" "}
                </span>
                {r.label}: <strong>{r.values.join(", ")}</strong>
              </li>
            ))}
          </ul>
        </div>
      )}
      {preview.pending.length > 0 && (
        <div>
          <p className="mb-1 font-semibold">{t("builder.previewPending")}</p>
          <ul className="list-disc space-y-0.5 pl-5">
            {preview.pending.map((p) => (
              <li key={`${p.level}|${p.message}`}>
                {p.level > 1 && (
                  <span className="text-ink-muted">
                    {t("builder.levelOf", { level: p.level })} ·{" "}
                  </span>
                )}
                {p.message}
              </li>
            ))}
          </ul>
        </div>
      )}
      {preview.notes.length > 0 && (
        <ul className="space-y-0.5 text-ink-muted">
          {preview.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
