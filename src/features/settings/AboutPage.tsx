/** About: what the app is, and the SRD's CC-BY-4.0 attribution (kept with any SRD text shown). */

import { useState } from "react";
import { Button, PageTitle, Section } from "@/components/ui";
import { t } from "@/i18n";
import { BUILD_INFO, type BuildInfo, buildInfoText } from "@/offline/build-info";

/** The release this code was built as (kenli F-007 T05: a marker of each release's own lazy view). */
const RELEASE: string = __RELEASE_ID__;

export function AboutPage() {
  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4 sm:p-6">
      <PageTitle sub={t("app.tagline")}>{t("about.title")}</PageTitle>
      <Section title={t("app.name")}>
        <p>{t("about.body")}</p>
        <p className="mt-2 text-sm text-ink-muted" data-testid="about-version">
          {t("about.version", { id: RELEASE })}
        </p>
      </Section>
      <BuildDetails info={BUILD_INFO} />
      <Section title="SRD 5.2.1 · CC-BY-4.0">
        <p className="mb-2">{t("about.attribution")}</p>
        <p className="text-ink-muted">{t("about.notAffiliated")}</p>
      </Section>
    </div>
  );
}

type CopyState = "idle" | "copied" | "failed";

/**
 * kenli F-014 T01: which build this is, from the metadata embedded in this JS (offline-safe: no
 * fetch). The plain text is always on screen, selectable, so copying never depends on the
 * Clipboard API (absent outside a secure context, refused by some browsers).
 */
export function BuildDetails({ info }: { info: BuildInfo }) {
  const [copy, setCopy] = useState<CopyState>("idle");
  const text = buildInfoText(info);
  const dev = info.release_id === "r-dev";
  const version = info.version ?? (dev ? t("about.build.dev") : t("about.build.noVersion"));
  const doCopy = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("no clipboard");
      await navigator.clipboard.writeText(text);
      setCopy("copied");
    } catch {
      setCopy("failed");
    }
  };
  return (
    <Section title={t("about.build.title")}>
      <dl
        className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm"
        data-testid="about-build"
        data-version={info.version ?? ""}
      >
        <dt className="text-ink-muted">{t("about.build.version")}</dt>
        <dd className="font-bold" data-testid="about-build-version">
          {version}
        </dd>
        <dt className="text-ink-muted">{t("about.build.release")}</dt>
        <dd className="break-all">{info.release_id}</dd>
        <dt className="text-ink-muted">{t("about.build.table")}</dt>
        <dd className="break-all font-mono">{info.table_commit ?? t("about.build.unknown")}</dd>
        <dt className="text-ink-muted">{t("about.build.engine")}</dt>
        <dd className="break-all font-mono">{info.engine_commit ?? t("about.build.unknown")}</dd>
        {info.dirty ? (
          <>
            <dt className="text-ink-muted">{t("about.build.dirtyLabel")}</dt>
            <dd className="text-orange">{t("about.build.dirty")}</dd>
          </>
        ) : null}
      </dl>
      <pre
        className="mt-3 select-all overflow-x-auto whitespace-pre-wrap break-all rounded border border-edge bg-card-2 p-2 text-[13px]"
        data-testid="about-build-text"
      >
        {text}
      </pre>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={doCopy} data-testid="about-build-copy">
          {t("about.build.copy")}
        </Button>
        <span
          role="status"
          className="text-sm text-ink-muted"
          data-testid="about-build-copy-status"
        >
          {copy === "copied"
            ? t("about.build.copied")
            : copy === "failed"
              ? t("about.build.copyFailed")
              : ""}
        </span>
      </div>
    </Section>
  );
}
