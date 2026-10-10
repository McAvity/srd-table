/**
 * GM only: actions played by hand, waiting for their outcome. The engine has spent their costs;
 * the GM applies what happened to the targets with the encounter's `effects` (damage with its
 * type, healing: Resistance, Concentration saves and HP limits stay the engine's), then marks the
 * action done. Conditions go through the selection panel's effects, as for anyone.
 */

import { useState } from "react";
import { Button, Reasons, Section } from "@/components/ui";
import { damageTypes } from "@/engine/constants";
import type { EncounterView } from "@/engine/facade";
import { t } from "@/i18n";
import { titleCase } from "@/lib/format";
import { type DeclaredEntry, type EncounterRecord, useDocuments } from "@/store/documents";

/** A stable empty list: a store selector must not return a new array each time. */
const NONE: readonly DeclaredEntry[] = [];

export function DeclaredPanel({ record, view }: { record: EncounterRecord; view: EncounterView }) {
  const declared = record.declared ?? NONE;
  if (!declared.length) return null;
  return (
    <Section title={<span className="text-orange">{t("table.declared")}</span>}>
      <p className="mb-2 text-sm text-ink-muted">{t("table.declaredHint")}</p>
      <ul className="space-y-3">
        {declared.map((entry) => (
          <Declared key={entry.id} encounterId={record.id} entry={entry} view={view} />
        ))}
      </ul>
    </Section>
  );
}

function Declared({
  encounterId,
  entry,
  view,
}: {
  encounterId: string;
  entry: DeclaredEntry;
  view: EncounterView;
}) {
  const send = useDocuments((s) => s.encounterAction);
  const dismiss = useDocuments((s) => s.dismissDeclared);
  const { result } = entry;
  const name = (id: string) => view.combatants.find((c) => c.id === id)?.name ?? id;
  // A target listed twice (two beams at one creature) takes the outcome once.
  const targets = [...new Set(result.targets)].filter((id) =>
    view.combatants.some((c) => c.id === id),
  );
  const [picked, setPicked] = useState<readonly string[]>(targets);
  const [amount, setAmount] = useState("");
  const [damageType, setDamageType] = useState("");
  const [reasons, setReasons] = useState<readonly string[] | null>(null);
  const n = Number.parseInt(amount, 10);
  const ready = amount !== "" && n >= 0 && picked.length > 0;
  const params = { name: name(result.by), what: result.name };

  async function apply(kind: "damage" | "heal") {
    const result = await send(
      encounterId,
      picked.map((id) => ({
        type: "effects" as const,
        id,
        actions: [
          kind === "damage"
            ? {
                type: "damage" as const,
                amount: n,
                ...(damageType ? { damage_type: damageType } : {}),
              }
            : { type: "heal" as const, amount: n },
        ],
      })),
    );
    setReasons(result.ok ? null : result.reasons);
    if (result.ok) setAmount("");
  }

  return (
    <li className="space-y-1.5 border-t border-edge pt-2 first:border-t-0 first:pt-0">
      <div className="flex items-center gap-2">
        <span className="flex-1 text-sm font-semibold">
          {result.slot_level !== null
            ? t("table.declaredLevel", { ...params, level: result.slot_level })
            : t("table.declaredWhat", params)}
        </span>
        <span className="text-[13px] text-ink-faint">
          {t("encounters.round", { round: entry.round })}
        </span>
      </div>
      {targets.length ? (
        <div className="flex flex-wrap gap-1.5">
          {targets.map((id) => (
            <Button
              key={id}
              size="sm"
              on={picked.includes(id)}
              aria-pressed={picked.includes(id)}
              onClick={() =>
                setPicked(picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id])
              }
            >
              {name(id)}
            </Button>
          ))}
        </div>
      ) : (
        <p className="text-sm text-ink-muted">{t("table.declaredNoTargets")}</p>
      )}
      {targets.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          <input
            className="field w-20"
            inputMode="numeric"
            aria-label={t("sheet.amount")}
            placeholder={t("sheet.amount")}
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^0-9]/g, ""))}
          />
          <select
            className="field w-auto"
            aria-label={t("sheet.damageType")}
            value={damageType}
            onChange={(e) => setDamageType(e.target.value)}
          >
            <option value="">{t("sheet.untyped")}</option>
            {damageTypes().map((d) => (
              <option key={d} value={d}>
                {titleCase(d)}
              </option>
            ))}
          </select>
          <Button size="sm" variant="danger" disabled={!ready} onClick={() => void apply("damage")}>
            {t("table.effectDamage")}
          </Button>
          <Button size="sm" disabled={!ready} onClick={() => void apply("heal")}>
            {t("table.effectHeal")}
          </Button>
        </div>
      )}
      <Reasons reasons={reasons} />
      <div className="flex justify-end">
        <Button size="sm" icon="check" onClick={() => dismiss(encounterId, entry.id)}>
          {t("table.declaredDone")}
        </Button>
      </div>
    </li>
  );
}
