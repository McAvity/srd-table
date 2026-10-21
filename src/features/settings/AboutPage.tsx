/** About: what the app is, and the SRD's CC-BY-4.0 attribution (kept with any SRD text shown). */

import { PageTitle, Section } from "@/components/ui";
import { t } from "@/i18n";

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
      <Section title="SRD 5.2.1 · CC-BY-4.0">
        <p className="mb-2">{t("about.attribution")}</p>
        <p className="text-ink-muted">{t("about.notAffiliated")}</p>
      </Section>
    </div>
  );
}
