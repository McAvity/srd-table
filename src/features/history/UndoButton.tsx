/**
 * kenli F-006 F-T01-01: a character's Undo restores its whole state, so after a later encounter
 * action on that character it also takes that action's effect back (the existing Undo, unchanged).
 * When the store says so (`undoWarning`), ask before undoing; the history keeps the encounter entry.
 */

import { useState } from "react";
import { Button, Dialog } from "@/components/ui";
import { t } from "@/i18n";
import { canUndo, useDocuments } from "@/store/documents";

export function UndoButton({ id }: { id: string }) {
  const undo = useDocuments((s) => s.undo);
  const undoable = useDocuments((s) => canUndo(s, id));
  const [warning, setWarning] = useState<string | null>(null);
  return (
    <>
      <Button
        size="sm"
        icon="undo"
        iconOnly
        label={t("common.undo")}
        disabled={!undoable}
        onClick={() => {
          const w = useDocuments.getState().undoWarning(id);
          if (w) setWarning(w);
          else void undo(id);
        }}
      />
      <Dialog
        open={warning !== null}
        onOpenChange={(o) => {
          if (!o) setWarning(null);
        }}
        title={t("history.undoWarningTitle")}
        description={warning ?? ""}
        footer={
          <>
            <Button onClick={() => setWarning(null)}>{t("common.cancel")}</Button>
            <Button
              variant="danger"
              icon="undo"
              onClick={() => {
                setWarning(null);
                void undo(id);
              }}
            >
              {t("history.undoAnyway")}
            </Button>
          </>
        }
      />
    </>
  );
}
