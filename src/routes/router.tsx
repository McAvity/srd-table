/**
 * The route tree (code-based TanStack Router, fully typed). Hash history, so the static build
 * works on any host without rewrite rules.
 */

import {
  createHashHistory,
  createRootRoute,
  createRoute,
  createRouter,
  type RouterHistory,
  redirect,
} from "@tanstack/react-router";
import { lazy } from "react";
import type { Step, TableName } from "srd-rules-engine";
import { steps } from "@/engine/constants";
import { COMPENDIUM_TABLES } from "@/features/compendium/tables";
import { SHEET_TABS, type SheetTab } from "@/features/sheet/tabs";
import { AppShell } from "./AppShell";
import { homeTarget } from "./paneTargets";

// Screens load on first visit (each its own chunk).
const CharactersPage = lazy(() =>
  import("@/features/characters/CharactersPage").then((m) => ({ default: m.CharactersPage })),
);
const BuilderPage = lazy(() =>
  import("@/features/builder/BuilderPage").then((m) => ({ default: m.BuilderPage })),
);
const SheetPage = lazy(() =>
  import("@/features/sheet/SheetPage").then((m) => ({ default: m.SheetPage })),
);
const EncountersPage = lazy(() =>
  import("@/features/encounter/EncountersPage").then((m) => ({ default: m.EncountersPage })),
);
const EncounterPage = lazy(() =>
  import("@/features/encounter/EncounterPage").then((m) => ({ default: m.EncounterPage })),
);
const CompendiumPage = lazy(() =>
  import("@/features/compendium/CompendiumPage").then((m) => ({ default: m.CompendiumPage })),
);
const SettingsPage = lazy(() =>
  import("@/features/settings/SettingsPage").then((m) => ({ default: m.SettingsPage })),
);
const AboutPage = lazy(() =>
  import("@/features/settings/AboutPage").then((m) => ({ default: m.AboutPage })),
);

const rootRoute = createRootRoute({ component: AppShell });

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  // The documents are loaded before the router exists (`main.tsx`): the table or the character
  // to open is known here.
  beforeLoad: () => {
    throw redirect(homeTarget());
  },
});

const charactersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/characters",
  component: () => <CharactersPage />,
});

export interface BuilderSearch {
  /** A creation step, or a level (2+) to review. */
  step?: Step;
  level?: number;
}

const builderRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/characters/$id/build",
  validateSearch: (search: Record<string, unknown>): BuilderSearch => {
    const step = (steps() as readonly string[]).includes(String(search.step))
      ? (search.step as Step)
      : undefined;
    const level = Number(search.level);
    return {
      ...(step ? { step } : {}),
      ...(Number.isInteger(level) && level >= 2 ? { level } : {}),
    };
  },
  component: function Builder() {
    const { id } = builderRoute.useParams();
    const search = builderRoute.useSearch();
    return <BuilderPage id={id} search={search} />;
  },
});

const sheetRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/characters/$id/sheet",
  validateSearch: (search: Record<string, unknown>): { tab?: SheetTab } => {
    const tab = (SHEET_TABS as readonly string[]).includes(String(search.tab))
      ? (search.tab as SheetTab)
      : undefined;
    return tab ? { tab } : {};
  },
  component: function Sheet() {
    const { id } = sheetRoute.useParams();
    const { tab } = sheetRoute.useSearch();
    return <SheetPage id={id} tab={tab ?? "overview"} />;
  },
});

const encountersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/encounters",
  component: () => <EncountersPage />,
});

const encounterRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/encounters/$id",
  component: function Encounter() {
    const { id } = encounterRoute.useParams();
    return <EncounterPage id={id} />;
  },
});

export interface CompendiumSearch {
  table?: TableName;
  id?: string;
  q?: string;
}

const compendiumRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/compendium",
  validateSearch: (search: Record<string, unknown>): CompendiumSearch => {
    const table = (COMPENDIUM_TABLES as readonly string[]).includes(String(search.table))
      ? (search.table as TableName)
      : undefined;
    return {
      ...(table ? { table } : {}),
      ...(typeof search.id === "string" && search.id ? { id: search.id } : {}),
      ...(typeof search.q === "string" && search.q ? { q: search.q } : {}),
    };
  },
  component: function Compendium() {
    const search = compendiumRoute.useSearch();
    return <CompendiumPage search={search} />;
  },
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: SettingsPage,
});
const aboutRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/about",
  component: AboutPage,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  charactersRoute,
  builderRoute,
  sheetRoute,
  encountersRoute,
  encounterRoute,
  compendiumRoute,
  settingsRoute,
  aboutRoute,
]);

export function createAppRouter(history: RouterHistory = createHashHistory()) {
  return createRouter({ routeTree, history, defaultPreload: false, scrollRestoration: true });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
