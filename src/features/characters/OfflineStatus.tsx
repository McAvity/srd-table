/**
 * kenli F-007 T04: a character's offline readiness in a few words (on its sheet), linking to
 * Settings → Offline play, where it is prepared. Only a check: nothing is prepared or downloaded.
 */

import { Link } from "@tanstack/react-router";
import { t } from "@/i18n";
import { useReadiness } from "@/offline/readiness";

export function OfflineStatus({ id }: { id: string }) {
  const { status } = useReadiness({ kind: "character", id });
  if (!status) return null;
  return (
    <Link
      to="/settings"
      className="text-[13px] text-ink-muted underline"
      data-testid="offline-short"
      data-status={status}
    >
      {t("offline.short", { status: t(`offline.status.${status}`) })}
    </Link>
  );
}
