/**
 * Settings: the campaign's content (packs in load order, allowed sources), who answers decisions
 * after a roll for new combatants, the theme, and a fixed dice seed for replaying a bug.
 */

import { useState } from "react";
import { Button, PageTitle, Reasons, Section } from "@/components/ui";
import { LOCALES, t } from "@/i18n";
import { exportInstalledPack } from "@/import/export";
import { downloadJson } from "@/lib/files";
import { installationId } from "@/persistence/sync";
import { useInstalledPacks, usePacks } from "@/queries";
import { type DecisionMode, PLAY_WAYS, type Theme, useSettings } from "@/store/settings";

const lines = (text: string) =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

export function SettingsPage() {
  const settings = useSettings((s) => s.settings);
  const update = useSettings((s) => s.update);
  const setContent = useSettings((s) => s.setContent);
  const setDevSeed = useSettings((s) => s.setDevSeed);
  const packs = usePacks();
  const [packText, setPackText] = useState(settings.packs.join("\n"));
  const [sourceText, setSourceText] = useState(settings.sources?.join("\n") ?? "");
  const [seed, setSeed] = useState(settings.dev_seed === null ? "" : String(settings.dev_seed));
  const [error, setError] = useState<string[] | null>(null);

  async function applyContent() {
    const nextPacks = lines(packText);
    const nextSources = lines(sourceText);
    try {
      await setContent(
        nextPacks.length ? nextPacks : ["srd-5.2.1"],
        nextSources.length ? nextSources : null,
      );
      setError(null);
    } catch (e) {
      setError([e instanceof Error ? e.message : String(e)]);
    }
  }

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-4 sm:p-6">
      <PageTitle>{t("settings.title")}</PageTitle>

      <Section title={t("settings.content")}>
        <div className="grid gap-4 md:grid-cols-2">
          <label className="flex flex-col gap-1">
            <span className="font-semibold">{t("settings.packs")}</span>
            <textarea
              className="field min-h-24 font-mono text-sm"
              value={packText}
              onChange={(e) => setPackText(e.target.value)}
            />
            <span className="text-[13px] text-ink-muted">{t("settings.packsHint")}</span>
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-semibold">{t("settings.sources")}</span>
            <textarea
              className="field min-h-24 font-mono text-sm"
              value={sourceText}
              onChange={(e) => setSourceText(e.target.value)}
            />
            <span className="text-[13px] text-ink-muted">{t("settings.sourcesHint")}</span>
          </label>
        </div>
        <Reasons reasons={error} className="mt-2" />
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Button variant="primary" icon="check" onClick={() => void applyContent()}>
            {t("settings.applyContent")}
          </Button>
          <span className="text-sm text-ink-muted">
            {t("settings.loadedPacks")}:{" "}
            {packs.error ? (
              <span className="text-red">{packs.error.message}</span>
            ) : (
              (packs.data ?? []).map((p) => `${p.id}${p.version ? ` ${p.version}` : ""}`).join(", ")
            )}
          </span>
        </div>
      </Section>

      <Section title={t("settings.decisions")}>
        <p className="mb-3 text-sm text-ink-muted">{t("settings.decisionsHint")}</p>
        <div className="flex flex-wrap gap-6">
          {(["character_decisions", "monster_decisions"] as const).map((key) => (
            <fieldset key={key}>
              <legend className="mb-1 font-semibold">
                {key === "character_decisions"
                  ? t("settings.characterDecisions")
                  : t("settings.monsterDecisions")}
              </legend>
              <div className="flex gap-1">
                {(["ask", "auto"] as const satisfies readonly DecisionMode[]).map((mode) => (
                  <Button
                    key={mode}
                    size="sm"
                    on={settings[key] === mode}
                    aria-pressed={settings[key] === mode}
                    onClick={() => update({ [key]: mode })}
                  >
                    {mode === "ask" ? t("table.decisionsAsk") : t("table.decisionsAuto")}
                  </Button>
                ))}
              </div>
            </fieldset>
          ))}
        </div>
      </Section>

      <Section title={t("settings.play")}>
        <p className="mb-3 text-sm text-ink-muted">{t("settings.playHint")}</p>
        <div className="flex flex-wrap gap-6">
          {(["character_play", "monster_play"] as const).map((key) => (
            <fieldset key={key}>
              <legend className="mb-1 font-semibold">
                {key === "character_play" ? t("settings.characterPlay") : t("settings.monsterPlay")}
              </legend>
              <div className="flex gap-1">
                {PLAY_WAYS.map((way) => (
                  <Button
                    key={way}
                    size="sm"
                    on={settings[key] === way}
                    aria-pressed={settings[key] === way}
                    onClick={() => update({ [key]: way })}
                  >
                    {way === "auto" ? t("table.wayAuto") : t("table.wayManual")}
                  </Button>
                ))}
              </div>
            </fieldset>
          ))}
        </div>
      </Section>

      <Section title={t("settings.language")}>
        <p className="mb-2 text-sm text-ink-muted">{t("settings.languageHint")}</p>
        <div className="flex gap-1">
          {LOCALES.map((l) => (
            <Button
              key={l.id}
              lang={l.id}
              on={settings.locale === l.id}
              aria-pressed={settings.locale === l.id}
              onClick={() => update({ locale: l.id })}
            >
              {l.name}
            </Button>
          ))}
        </div>
      </Section>

      <Section title={t("settings.theme")}>
        <div className="flex gap-1">
          {(["system", "mat", "felt"] as const satisfies readonly Theme[]).map((theme) => (
            <Button
              key={theme}
              on={settings.theme === theme}
              aria-pressed={settings.theme === theme}
              onClick={() => update({ theme })}
            >
              {t(`settings.theme.${theme}`)}
            </Button>
          ))}
        </div>
      </Section>

      <Section title={t("settings.dev")}>
        <label className="flex flex-wrap items-end gap-2">
          <span className="flex flex-col gap-1">
            <span className="font-semibold">{t("settings.seed")}</span>
            <input
              className="field w-40"
              inputMode="numeric"
              value={seed}
              onChange={(e) => setSeed(e.target.value.replace(/[^0-9]/g, ""))}
            />
          </span>
          <Button onClick={() => void setDevSeed(seed === "" ? null : Number(seed))}>
            {t("common.apply")}
          </Button>
        </label>
        <p className="mt-1 text-[13px] text-ink-muted">{t("settings.seedHint")}</p>
      </Section>

      <InstalledPacks />

      <Section title={t("settings.data")}>
        <p className="text-sm text-ink-muted">{t("settings.dataHint")}</p>
      </Section>
    </div>
  );
}

/**
 * Packs imported with documents (kenli F-008): each version kept apart, by its exact hash, used by
 * the documents pinned to it (not by the campaign's packs above). Exported as a transfer.
 */
function InstalledPacks() {
  const { data } = useInstalledPacks();
  const [error, setError] = useState<string[] | null>(null);
  async function onExport(key: string) {
    const env = await exportInstalledPack(key, installationId());
    if (!env) return;
    if ("ambiguous" in env) return setError([t("settings.packAmbiguous", { id: env.ambiguous })]);
    setError(null);
    downloadJson(`${env.id}-${key.split("@")[1]?.split("#")[0] || "x"}.transfer.json`, env);
  }
  return (
    <Section title={t("settings.installedPacks")}>
      <p className="text-sm text-ink-muted">{t("settings.installedPacksHint")}</p>
      {data?.length ? (
        <ul className="mt-2 space-y-1 text-sm">
          {data.map((p) => (
            <li key={p.key} className="flex items-center gap-2">
              <span className="flex-1">
                {p.ref.id} {p.ref.version ?? ""}{" "}
                <span className="text-ink-muted">({p.ref.sha256.slice(0, 12)})</span>
                {p.bundled ? (
                  <span className="text-ink-muted"> · {t("settings.packBundled")}</span>
                ) : null}
              </span>
              <Button size="sm" icon="download" onClick={() => void onExport(p.key)}>
                {t("common.export")}
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-sm text-ink-muted">{t("settings.noInstalledPacks")}</p>
      )}
      <Reasons reasons={error} className="mt-2" />
    </Section>
  );
}
