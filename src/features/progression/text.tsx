/**
 * kenli F-002 T05: shared pieces of the plan screens — a refusal or problem in the app's words (its
 * code translated, then the detail), the checkpoint summary and a planned step's preview (choices,
 * HP, AC, resources, new actions, warnings) — and the Markdown download (T06).
 */

import { engine } from "@/engine/client";
import type { ReadableOp } from "@/engine/plans";
import { type MessageKey, t } from "@/i18n";
import { en } from "@/i18n/en";
import type { PlayedStats, StepPreview } from "@/progression/advance";
import type { PlanFile } from "@/progression/codec";
import { markdownFileName, planMarkdown } from "@/progression/markdown";

/** A refusal code (T03/T04 codes, the fetch's) in the app's words, then its detail. */
export function progressionText(code: string, detail = ""): string {
  const key = `progression.code.${code}`;
  const text = Object.hasOwn(en, key)
    ? t(key as MessageKey)
    : t("progression.code.other", { code });
  return detail ? `${text} (${detail})` : text;
}

/** One choice as a line: its label, then the names chosen (a replacement: old → new). */
export function choiceText(op: ReadableOp): string {
  const names = op.names ?? op.values ?? [];
  const value =
    op.key?.includes("#replace:") && names.length === 2
      ? t("progression.replaced", { old: names[0] ?? "", new: names[1] ?? "" })
      : names.join(", ");
  return `${op.label ?? op.key}: ${value}`;
}

export function ChoiceList({ ops }: { ops: readonly ReadableOp[] }) {
  const choices = ops.filter((o) => o.op === "choice");
  if (!choices.length)
    return <p className="text-sm text-ink-muted">{t("progression.noChoices")}</p>;
  return (
    <ul className="space-y-0.5 text-sm" data-testid="plan-choices">
      {choices.map((o) => (
        <li key={`${o.index}:${o.key}`}>{choiceText(o)}</li>
      ))}
    </ul>
  );
}

function Row({
  label,
  before,
  after,
}: {
  label: string;
  before: string | number;
  after: string | number;
}) {
  return (
    <tr>
      <th scope="row" className="pr-3 text-left font-normal text-ink-muted">
        {label}
      </th>
      <td className="tabular-nums">{before}</td>
      <td className="px-1 text-ink-muted">→</td>
      <td className="tabular-nums font-bold">{after}</td>
    </tr>
  );
}

const slots = (s: PlayedStats) =>
  s.spell_slots.map((x) => `${x.total - x.spent}/${x.total}`).join(" ") || "—";

/** What a planned step or a bind would change (nothing applied yet). */
export function StepPreviewView({ preview }: { preview: StepPreview }) {
  const { before, after } = preview;
  const uses = after.uses.filter((u) => {
    const b = before.uses.find((x) => x.key === u.key);
    return !b || b.max !== u.max;
  });
  return (
    <div className="space-y-3" data-testid="step-preview">
      <p className="font-bold">
        {preview.kind === "advance"
          ? t("progression.previewAdvance", {
              from: preview.from_level,
              to: preview.to_level,
              class: preview.class_id,
              classLevel: preview.class_level,
            })
          : t("progression.previewBind", { level: preview.to_level })}
      </p>
      <table className="text-sm">
        <tbody>
          <Row label={t("progression.stat.level")} before={before.level} after={after.level} />
          <Row label={t("progression.stat.hpMax")} before={before.hp_max} after={after.hp_max} />
          <Row
            label={t("progression.stat.hp")}
            before={before.hp_current}
            after={after.hp_current}
          />
          <Row
            label={t("progression.stat.ac")}
            before={before.armor_class}
            after={after.armor_class}
          />
          <Row
            label={t("progression.stat.pb")}
            before={before.proficiency_bonus}
            after={after.proficiency_bonus}
          />
          <Row label={t("progression.stat.slots")} before={slots(before)} after={slots(after)} />
        </tbody>
      </table>
      {preview.choices.length > 0 && (
        <div>
          <h3 className="section-title">{t("progression.choices")}</h3>
          <ChoiceList ops={preview.choices} />
        </div>
      )}
      {uses.length > 0 && (
        <div>
          <h3 className="section-title">{t("progression.resources")}</h3>
          <ul className="text-sm">
            {uses.map((u) => (
              <li key={u.key}>
                {u.name}: {before.uses.find((x) => x.key === u.key)?.max ?? 0} → {u.max}
              </li>
            ))}
          </ul>
        </div>
      )}
      {preview.new_actions.length > 0 && (
        <p className="text-sm">
          {t("progression.newActions")}: {preview.new_actions.join(", ")}
        </p>
      )}
      {preview.packs_added.length > 0 && (
        <p className="text-sm" data-testid="packs-added">
          {t("progression.packsAdded")}:{" "}
          {preview.packs_added.map((p) => `${p.id} ${p.version ?? ""}`).join(", ")}
        </p>
      )}
      {preview.warnings.map((w) => (
        <p key={w.code} role="status" className="text-sm text-orange">
          {progressionText(w.code)}
        </p>
      ))}
    </div>
  );
}

/** Download a plan's whole Markdown (compiled in the worker in the plan's own context). */
export async function downloadPlanMarkdown(
  file: Omit<PlanFile, "packs"> | unknown,
): Promise<string | null> {
  const compiled = await engine().compilePlan(file);
  if (!compiled.ok) return progressionText(compiled.problem.code, compiled.problem.detail);
  const plan = file as Omit<PlanFile, "packs">;
  const text = planMarkdown(plan, compiled.checkpoints, compiled.guide_items ?? []);
  const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = markdownFileName(plan);
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return null;
}
