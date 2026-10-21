/**
 * kenli F-007 T03: "Local copy with state and history" of one character (contract local-copy.md
 * §3): the copy is made (the character saved first, read in one transaction), then shown — how
 * much history, days, Long Rests, packs, its size, and that it's a copy of this moment, not a sync —
 * and saved as a file only when asked. A refusal says why; nothing of the character changes.
 */

import { useEffect, useState } from "react";
import { Button, Dialog, Spinner } from "@/components/ui";
import { t } from "@/i18n";
import { type ExportResult, exportLocalCopy } from "@/import/localCopy/export";
import { localCopyProblemText } from "./LocalCopyImport";

export const formatSize = (bytes: number) =>
  bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(2)} MiB`
    : `${Math.max(1, Math.round(bytes / 1024))} KiB`;

function downloadBlob(fileName: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function LocalCopyExport({
  recordId,
  name,
  open,
  onOpenChange,
}: {
  recordId: string;
  name: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [result, setResult] = useState<ExportResult | null>(null);
  useEffect(() => {
    if (!open) return;
    let live = true;
    setResult(null);
    void exportLocalCopy(recordId).then((r) => {
      if (live) setResult(r);
    });
    return () => {
      live = false;
    };
  }, [open, recordId]);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("localCopy.exportTitle", { name })}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button>
          <Button
            variant="primary"
            icon="download"
            disabled={!result?.ok}
            onClick={() => {
              if (!result?.ok) return;
              downloadBlob(result.fileName, result.blob);
              onOpenChange(false);
            }}
          >
            {t("localCopy.download")}
          </Button>
        </>
      }
    >
      <div className="space-y-2 text-sm" data-testid="local-copy-export">
        {!result ? (
          <Spinner label={t("localCopy.exportWorking")} />
        ) : result.ok ? (
          <>
            <p data-testid="local-copy-export-summary">
              {t("localCopy.exportSummary", {
                entries: result.summary.entries,
                undone: result.summary.undone,
                days: result.summary.days,
                rests: result.summary.long_rests,
                packs: result.summary.packs.length,
                size: formatSize(result.summary.bytes),
              })}
            </p>
            <p className="text-ink-muted">
              {result.summary.packs.map((p) => `${p.id} ${p.version ?? ""}`.trim()).join(", ")}
            </p>
            <p className="font-semibold">{t("localCopy.exportNotSync")}</p>
            <p className="text-[13px] text-ink-faint">{result.fileName}</p>
          </>
        ) : (
          <p className="text-red" role="alert" data-testid="local-copy-problem">
            {localCopyProblemText(result.code, result.detail)}
          </p>
        )}
      </div>
    </Dialog>
  );
}
