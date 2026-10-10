/**
 * The way back to a list from one of its documents: the top bar's Table and Characters open a
 * document, so its page links back to all of them.
 */

import { Link } from "@tanstack/react-router";
import { t } from "@/i18n";
import { Icon } from "./Icon";

export function BackLink({ to }: { to: "/encounters" | "/characters" }) {
  return (
    <Link
      to={to}
      className="inline-flex items-center gap-1 text-sm text-ink-muted hover:text-ink hover:underline"
    >
      <Icon name="chevronLeft" size={16} />
      {to === "/encounters" ? t("nav.allEncounters") : t("nav.allCharacters")}
    </Link>
  );
}
