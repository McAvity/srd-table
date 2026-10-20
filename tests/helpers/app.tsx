/**
 * Render the whole app on the in-process facade (the real SRD, seeded dice) at a route, with
 * fresh stores and an empty IndexedDB.
 */

import { createMemoryHistory } from "@tanstack/react-router";
import { render } from "@testing-library/react";
import { beforeAll } from "vitest";
import { App } from "../../src/App";
import { setEngine } from "../../src/engine/client";
import { loadConstants } from "../../src/engine/constants";
import type { EngineFacade } from "../../src/engine/facade";
import { nodeFacade } from "../../src/engine/node";
import { closeDb, DB_NAME } from "../../src/persistence/db";
import { createQueryClient } from "../../src/queries";
import { createAppRouter } from "../../src/routes/router";
import { useDocuments } from "../../src/store/documents";
import { useHistory } from "../../src/store/history";
import { applyLocale, startLocaleSync, useLocale } from "../../src/store/locale";
import { DEFAULT_SETTINGS, useSettings } from "../../src/store/settings";
import { useUi } from "../../src/store/ui";

export function installTestEngine(seed = 7): EngineFacade {
  const engine = nodeFacade({ seed });
  setEngine(engine);
  beforeAll(() => loadConstants(engine));
  return engine;
}

export async function resetStores(): Promise<void> {
  await closeDb();
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
  useDocuments.setState({ hydrated: true, characters: {}, encounters: {}, revs: {}, history: {} });
  useHistory.getState().hydrate([]);
  useSettings.setState({ settings: DEFAULT_SETTINGS });
  useUi.setState({
    toasts: [],
    dice: [],
    role: { kind: "gm" },
    lastOpened: { encounter: null, character: null },
  });
  localStorage.clear();
  if (useLocale.getState().applied !== "en") await applyLocale("en");
}

let stopLocaleSync: (() => void) | null = null;

export async function renderApp(path: string) {
  stopLocaleSync?.();
  stopLocaleSync = startLocaleSync();
  const router = createAppRouter(createMemoryHistory({ initialEntries: [path] }));
  const queryClient = createQueryClient();
  const result = render(<App router={router} queryClient={queryClient} />);
  await router.load();
  return { ...result, router, queryClient };
}
