/**
 * A decision after a roll (`encounter.pending`): Bardic Inspiration, Legendary Resistance, Uncanny
 * Dodge, a forced zone save. The question shows the roll; the engine's recommendation is
 * pre-selected, never applied on its own. Whoever controls that combatant answers (`decide`);
 * everyone else sees that the table is waiting. kenli F-002 T12 B2b: a choice of dice (Empowered
 * Spell, `pending.dice`) ticks up to `max_dice` of them, or keeps the roll; the engine checks it.
 */

import { useState } from "react";
import type { Pending } from "srd-rules-engine";
import { Icon } from "@/components/Icon";
import { Button, Dialog, Reasons } from "@/components/ui";
import { t } from "@/i18n";
import { useRenderedMessages } from "@/queries";
import { useDocuments } from "@/store/documents";

export function DecisionDialog({
  encounterId,
  pending,
  who,
  canAnswer,
}: {
  encounterId: string;
  pending: Pending;
  who: string;
  canAnswer: boolean;
}) {
  const send = useDocuments((s) => s.encounterAction);
  const [reasons, setReasons] = useState<readonly string[] | null>(null);
  const [busy, setBusy] = useState(false);

  // The question in the current language (the stored document keeps the engine's English).
  const { data: rendered } = useRenderedMessages(
    `question:${JSON.stringify(pending.question_message ?? null)}`,
    pending.question_message ? [[pending.question_message]] : [],
  );
  const question = rendered?.[0]?.[0] ?? pending.question;

  const [picked, setPicked] = useState<number[]>([]);
  async function decide(use: boolean, dice?: readonly number[]) {
    setBusy(true);
    try {
      const result = await send(
        encounterId,
        dice ? { type: "decide", use, dice: [...dice] } : { type: "decide", use },
      );
      setReasons(result.ok ? null : result.reasons);
    } finally {
      setBusy(false);
    }
  }

  if (!canAnswer) {
    return (
      <div role="status" className="panel flex items-center gap-2 border-l-4 border-l-orange p-3">
        <Icon name="hourglass" className="text-orange" />
        <span>
          {t("table.pending")} · {t("table.decisionFor", { name: who })}
        </span>
      </div>
    );
  }

  if (pending.dice) {
    const dice = pending.dice;
    return (
      <Dialog
        open
        onOpenChange={() => undefined}
        title={t("table.decisionFor", { name: who })}
        footer={
          <>
            <Button autoFocus disabled={busy} onClick={() => void decide(false)}>
              {t("table.empoweredKeep")}
            </Button>
            <Button
              variant="primary"
              icon="check"
              disabled={busy || picked.length === 0}
              onClick={() => void decide(true, picked)}
            >
              {t("table.empoweredDo", { count: picked.length })}
            </Button>
          </>
        }
      >
        <p className="font-display text-lg">{question}</p>
        <fieldset className="mt-2 flex flex-wrap gap-2" data-testid="decision-dice">
          {dice.map((d, i) => (
            <label key={`${d.part}-${d.die}`} className="flex items-center gap-1 text-sm">
              <input
                type="checkbox"
                checked={picked.includes(i)}
                disabled={busy}
                onChange={(e) =>
                  setPicked(e.target.checked ? [...picked, i] : picked.filter((x) => x !== i))
                }
              />
              {t("table.empoweredDie", { value: d.value, sides: d.sides, type: d.type })}
            </label>
          ))}
        </fieldset>
        <Reasons reasons={reasons} className="mt-2" />
      </Dialog>
    );
  }

  return (
    <Dialog
      open
      onOpenChange={() => undefined}
      title={t("table.decisionFor", { name: who })}
      footer={
        <>
          <Button
            autoFocus={!pending.recommended}
            on={!pending.recommended}
            disabled={busy}
            onClick={() => void decide(false)}
          >
            {t("table.decisionSkip")}
            {!pending.recommended && (
              <span className="text-[13px] text-ink-muted">· {t("table.recommended")}</span>
            )}
          </Button>
          <Button
            variant="primary"
            icon="check"
            autoFocus={pending.recommended}
            disabled={busy}
            onClick={() => void decide(true)}
          >
            {t("table.decisionUse")}
            {pending.recommended && <span className="text-[13px]">· {t("table.recommended")}</span>}
          </Button>
        </>
      }
    >
      <p className="font-display text-lg">{question}</p>
      <Reasons reasons={reasons} className="mt-2" />
    </Dialog>
  );
}
