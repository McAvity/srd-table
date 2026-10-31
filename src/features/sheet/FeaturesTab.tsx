/** Features and traits with their SRD text (always shown), feats, class options, class resources. */

import type { PlaySheet } from "srd-rules-engine";
import { SrdText } from "@/components/SrdText";
import { Section } from "@/components/ui";
import { t } from "@/i18n";
import { useNames } from "@/queries";
import { RestChoices } from "./RestChoices";

export function FeaturesTab({ id, sheet }: { id: string; sheet: PlaySheet }) {
  const featName = useNames("feats", { character: id });
  const featureName = useNames("features", { character: id });
  const masteryName = useNames("weapons", { character: id });
  return (
    <div className="space-y-4">
      <RestChoices id={id} />
      {(sheet.resources.length > 0 || sheet.weapon_masteries.length > 0) && (
        <Section title={t("sheet.resources")}>
          <dl className="grid gap-2 @min-[600px]:grid-cols-3">
            {sheet.resources.map((r) => (
              <div
                key={`${r.class_id}|${r.name}`}
                className="rounded border border-edge bg-card-2 px-3 py-1.5"
              >
                <dt className="text-[13px] text-ink-muted">{r.name}</dt>
                <dd className="font-display text-xl font-bold">{r.value}</dd>
              </div>
            ))}
            {sheet.weapon_masteries.length > 0 && (
              <div className="rounded border border-edge bg-card-2 px-3 py-1.5 @min-[600px]:col-span-3">
                <dt className="text-[13px] text-ink-muted">{t("compendium.table.masteries")}</dt>
                <dd>{sheet.weapon_masteries.map(masteryName).join(", ")}</dd>
              </div>
            )}
          </dl>
        </Section>
      )}
      {(sheet.feats.length > 0 || sheet.features.length > 0) && (
        <Section title={t("sheet.feats")}>
          <p>{[...sheet.feats.map(featName), ...sheet.features.map(featureName)].join(" · ")}</p>
        </Section>
      )}
      <Section title={t("sheet.features")}>
        <ul className="space-y-2">
          {sheet.traits.map((trait) => (
            // kenli F-011 T06 (AC-19): every description always shown — plain blocks, nothing to
            // fold (no details/summary, no toggle).
            <li
              key={`${trait.source}|${trait.name}`}
              className="rounded border border-edge px-3 py-2"
              data-testid="feature-block"
            >
              <h3 className="font-semibold">
                {trait.name}
                <span className="ml-2 text-[13px] font-normal text-ink-muted">
                  {trait.source} · {t("common.level", { level: trait.level })}
                </span>
              </h3>
              <SrdText text={trait.text} className="mt-1 text-sm" />
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}
