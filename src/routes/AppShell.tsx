/**
 * The frame around every screen: the top bar (logo, Table / Characters / Compendium, the view
 * switch, settings), toasts and the dice tray. Table and Characters open a table and a character
 * (`paneTargets.ts`), else their list.
 */

import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import { DropdownMenu, Tooltip } from "radix-ui";
import { Suspense } from "react";
import { DiceTray } from "@/components/DiceTray";
import { Icon, type IconName } from "@/components/Icon";
import { Toasts } from "@/components/Toasts";
import { Spinner } from "@/components/ui";
import { HistoryControl } from "@/features/history/HistoryPanel";
import { UpdateBanner } from "@/features/settings/UpdatePanel";
import { t } from "@/i18n";
import { useDocuments } from "@/store/documents";
import { useUi } from "@/store/ui";
import { useCharacterTarget, useTableTarget } from "./paneTargets";

const NAV: readonly {
  to: "/encounters" | "/characters" | "/compendium";
  label: () => string;
  icon: IconName;
}[] = [
  { to: "/encounters", label: () => t("nav.table"), icon: "table" },
  { to: "/characters", label: () => t("nav.characters"), icon: "sheet" },
  { to: "/compendium", label: () => t("nav.compendium"), icon: "book" },
];

export function AppShell() {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const table = useTableTarget();
  const character = useCharacterTarget();
  return (
    <Tooltip.Provider>
      <div className="flex h-full flex-col">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded focus:bg-card focus:px-3 focus:py-2"
        >
          {t("nav.skip")}
        </a>
        <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-edge bg-mat/95 px-4 py-2 backdrop-blur">
          <Link to="/" className="flex items-baseline gap-2">
            <span className="font-display text-2xl font-bold text-ink">{t("app.name")}</span>
            <span className="hidden text-[13px] text-ink-muted lg:inline">SRD 5.2.1</span>
          </Link>
          <nav
            aria-label={t("nav.main")}
            className="order-3 flex w-full justify-center gap-2 md:order-none md:w-auto md:flex-1"
          >
            {NAV.map((item) => {
              const active = path.startsWith(item.to);
              const on = {
                "data-on": active ? "true" : undefined,
                "aria-current": active ? ("page" as const) : undefined,
                className: "btn",
              };
              const body = (
                <>
                  <Icon name={item.icon} size={20} />
                  <span className="sr-only text-[15px] sm:not-sr-only">{item.label()}</span>
                </>
              );
              if (item.to === "/encounters" && table)
                return (
                  <Link key={item.to} to="/encounters/$id" params={{ id: table }} {...on}>
                    {body}
                  </Link>
                );
              if (item.to === "/characters" && character)
                return (
                  <Link
                    key={item.to}
                    to="/characters/$id/sheet"
                    params={{ id: character }}
                    search={{}}
                    {...on}
                  >
                    {body}
                  </Link>
                );
              return (
                <Link key={item.to} to={item.to} {...on}>
                  {body}
                </Link>
              );
            })}
          </nav>
          <div className="ml-auto flex items-center gap-2 md:ml-0">
            <HistoryControl />
            <ViewSwitch />
            <Link
              to="/settings"
              className="btn !px-2"
              data-on={path.startsWith("/settings") ? "true" : undefined}
              aria-label={t("nav.settings")}
              title={t("nav.settings")}
            >
              <Icon name="gear" />
            </Link>
          </div>
        </header>
        <UpdateBanner />
        <main id="main" className="min-h-0 flex-1 overflow-auto">
          <Suspense
            fallback={
              <div className="p-6">
                <Spinner />
              </div>
            }
          >
            <Outlet />
          </Suspense>
        </main>
        <footer className="border-t border-edge px-4 py-1 text-center text-[13px] text-ink-faint">
          SRD 5.2.1 © Wizards of the Coast LLC · CC-BY-4.0 ·{" "}
          <Link to="/about" className="underline hover:text-ink">
            {t("nav.about")}
          </Link>
        </footer>
        <Toasts />
        <DiceTray />
      </div>
    </Tooltip.Provider>
  );
}

/** GM or a player: the player view shows that character's controls only. */
function ViewSwitch() {
  const role = useUi((s) => s.role);
  const setRole = useUi((s) => s.setRole);
  const characters = useDocuments((s) => s.characters);
  const current =
    role.kind === "gm"
      ? t("nav.viewGm")
      : role.character && characters[role.character]
        ? t("nav.viewPlayer", {
            name: characters[role.character]?.build.name || t("common.unnamed"),
          })
        : t("nav.viewPlayerNone");
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button type="button" className="btn" aria-label={`${t("nav.view")}: ${current}`}>
          <Icon name="eye" />
          <span className="hidden text-[13px] text-ink-muted sm:inline">{t("nav.view")}</span>
          <span className="max-w-[10rem] truncate">{current}</span>
          <Icon name="chevronDown" size={16} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={6}
          className="z-50 min-w-[14rem] rounded-md border border-edge-strong bg-card-2 p-1 shadow-panel"
        >
          <DropdownMenu.RadioGroup
            value={role.kind === "gm" ? "gm" : (role.character ?? "")}
            onValueChange={(v) =>
              setRole(v === "gm" ? { kind: "gm" } : { kind: "player", character: v })
            }
          >
            <MenuRadio value="gm">{t("nav.viewGm")}</MenuRadio>
            {Object.values(characters).map((c) => (
              <MenuRadio key={c.id} value={c.id}>
                {t("nav.viewPlayer", { name: c.build.name || t("common.unnamed") })}
              </MenuRadio>
            ))}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function MenuRadio({ value, children }: { value: string; children: React.ReactNode }) {
  return (
    <DropdownMenu.RadioItem
      value={value}
      className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 outline-none data-[highlighted]:bg-card-3 data-[state=checked]:font-bold"
    >
      <DropdownMenu.ItemIndicator>
        <Icon name="check" size={16} />
      </DropdownMenu.ItemIndicator>
      <span className="pl-1">{children}</span>
    </DropdownMenu.RadioItem>
  );
}
