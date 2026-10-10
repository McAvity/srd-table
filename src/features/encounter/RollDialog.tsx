/**
 * A roll waiting for the table's dice (`encounter.pending` with `kind: "roll"`): a combatant whose
 * dice are rolled at the table. The question says what to roll and why; each die is entered as it
 * landed (both d20s for Advantage: the engine keeps one) and sent as `enter_roll`. A wrong count
 * or a value a die can't show is refused by the engine, with its reason. Whoever controls that
 * combatant enters it; everyone else sees that the table is waiting.
 */

import { useState } from "react";
import type { Pending } from "srd-rules-engine";
import { Icon } from "@/components/Icon";
import { Button, Dialog, Reasons } from "@/components/ui";
import { t } from "@/i18n";
import { useRenderedMessages } from "@/queries";
import { useDocuments } from "@/store/documents";

type Roll = NonNullable<Pending["roll"]>;

export function RollDialog({
  encounterId,
  pending,
  roll,
  who,
  canAnswer,
}: {
  encounterId: string;
  pending: Pending;
  roll: Roll;
  who: string;
  canAnswer: boolean;
}) {
  const send = useDocuments((s) => s.encounterAction);
  const [values, setValues] = useState<string[]>(() => Array(roll.count).fill(""));
  const [reasons, setReasons] = useState<readonly string[] | null>(null);
  const [busy, setBusy] = useState(false);

  const { data: rendered } = useRenderedMessages(
    `question:${JSON.stringify(pending.question_message ?? null)}`,
    pending.question_message ? [[pending.question_message]] : [],
  );
  const question = rendered?.[0]?.[0] ?? pending.question;
  const filled = values.every((v) => v !== "");

  async function enter() {
    setBusy(true);
    try {
      const result = await send(encounterId, {
        type: "enter_roll",
        values: values.map((v) => Number.parseInt(v, 10)),
      });
      if (result.ok) setValues(Array(roll.count).fill(""));
      setReasons(result.ok ? null : result.reasons);
    } finally {
      setBusy(false);
    }
  }

  if (!canAnswer) {
    return (
      <div role="status" className="panel flex items-center gap-2 border-l-4 border-l-orange p-3">
        <Icon name="d20" className="text-orange" />
        <span>
          {t("table.pendingRoll")} · {t("table.rollFor", { name: who })}
        </span>
      </div>
    );
  }

  return (
    <Dialog
      open
      onOpenChange={() => undefined}
      title={t("table.rollFor", { name: who })}
      footer={
        <Button
          variant="primary"
          icon="check"
          disabled={busy || !filled}
          onClick={() => void enter()}
        >
          {t("table.rollEnter")}
        </Button>
      }
    >
      <p className="font-display text-lg">{question}</p>
      <p className="mt-1 text-sm text-ink-muted">{t("table.rollHint")}</p>
      <form
        className="mt-3 flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (filled && !busy) void enter();
        }}
      >
        {values.map((v, i) => (
          <input
            key={i}
            className="field w-16 text-center text-lg font-bold"
            inputMode="numeric"
            autoFocus={i === 0}
            aria-label={t("table.rollDie", { n: i + 1, sides: roll.sides })}
            placeholder={`d${roll.sides}`}
            value={v}
            onChange={(e) =>
              setValues(values.map((x, j) => (j === i ? e.target.value.replace(/[^0-9]/g, "") : x)))
            }
          />
        ))}
        <button type="submit" hidden />
      </form>
      <Reasons reasons={reasons} className="mt-2" />
    </Dialog>
  );
}
