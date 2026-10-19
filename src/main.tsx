import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { App } from "./App";
import { engine } from "./engine/client";
import { loadConstants } from "./engine/constants";
import { t } from "./i18n";
import { loadAll, persistBundled, startAutosave } from "./persistence/sync";
import { createQueryClient } from "./queries";
import { createAppRouter } from "./routes/router";
import { applyLocale, startLocaleSync } from "./store/locale";
import { useSettings } from "./store/settings";

const root = createRoot(document.getElementById("root") as HTMLElement);
root.render(
  <div
    className="flex h-full items-center justify-center font-display text-2xl text-ink"
    role="status"
  >
    {t("app.loading")}
  </div>,
);

// The theme follows the settings document; the language too, through `startLocaleSync`.
useSettings.subscribe((s) => {
  document.documentElement.dataset.theme = s.settings.theme;
});

async function start() {
  await loadConstants(engine());
  await loadAll();
  await applyLocale(useSettings.getState().settings.locale);
  startLocaleSync();
  startAutosave();
  // The served SRD into storage (kenli F-008 §9.5), after the start: never in the way of the app.
  void persistBundled();
  const router = createAppRouter();
  const queryClient = createQueryClient();
  root.render(
    <StrictMode>
      <App router={router} queryClient={queryClient} />
    </StrictMode>,
  );
}

start().catch((error: unknown) => {
  root.render(
    <div className="p-6 text-red" role="alert">
      {t("errors.engine", { message: error instanceof Error ? error.message : String(error) })}
    </div>,
  );
});
