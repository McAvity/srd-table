/**
 * kenli F-002 T05: the manual builder stays open for a character that follows a plan, with a plain
 * warning: an edit here takes the build off the plan (planned steps then refuse, nothing is
 * repaired). The association is dropped only on purpose, after a second warning (one Undo restores
 * it) — never silently, never with a respec.
 */

import { useEffect, useState } from "react";
import { Button, Dialog } from "@/components/ui";
import { t } from "@/i18n";
import { detachProgression } from "@/progression/advance";
import { readProgression } from "@/progression/record";
import type { CharacterRecord } from "@/store/documents";

export function PlanBuilderNotice({ record }: { record: CharacterRecord }) {
  const [title, setTitle] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    let live = true;
    void readProgression(record.progression).then((r) => {
      if (live) setTitle(r.ok && r.progression ? r.progression.plan.plan.title : null);
    });
    return () => {
      live = false;
    };
  }, [record.progression]);
  if (!title) return null;
  return (
    <div
      role="note"
      className="mb-3 rounded-md border border-orange/60 bg-orange/10 px-3 py-2 text-sm"
      data-testid="plan-builder-notice"
    >
      <p>{t("progression.builderWarning", { title })}</p>
      <Button
        size="sm"
        variant="danger"
        className="mt-1"
        onClick={() => setConfirm(true)}
        data-testid="plan-builder-detach"
      >
        {t("progression.detach")}
      </Button>
      <Dialog
        open={confirm}
        onOpenChange={setConfirm}
        title={t("progression.detachTitle")}
        description={t("progression.detachWarning")}
        footer={
          <>
            <Button onClick={() => setConfirm(false)}>{t("common.cancel")}</Button>
            <Button
              variant="danger"
              data-testid="plan-builder-detach-confirm"
              onClick={() => void detachProgression(record.id).then(() => setConfirm(false))}
            >
              {t("progression.detachConfirm")}
            </Button>
          </>
        }
      />
    </div>
  );
}
