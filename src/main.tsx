import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { App } from "./App";
import { engine } from "./engine/client";
import { loadConstants } from "./engine/constants";
import { t } from "./i18n";
import { startGameData } from "./offline/boot";
import { onDbBlocked } from "./persistence/db";
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
  // Another tab holding an older database (kenli F-006: v4) keeps the upgrade waiting: say so on
  // the loading screen, until it lets go (the start then goes on by itself).
  const stopBlocked = onDbBlocked((why) => {
    if (why === "blocked")
      root.render(
        <div
          className="flex h-full items-center justify-center p-6 text-center text-xl"
          role="alert"
        >
          {t("persistence.closeOtherTabs")}
        </div>,
      );
  });
  // kenli F-007 T04: the update boot gate first (T05; a fail-closed stub until then), then — only
  // when it opens — the data: loadAll (migrations, installation id, verified packs, the campaign
  // catalog), the autosave and the served SRD in the background (`offline/boot.ts`).
  let gate: Awaited<ReturnType<typeof startGameData>>;
  try {
    gate = await startGameData({
      afterLoad: async () => {
        await applyLocale(useSettings.getState().settings.locale);
        startLocaleSync();
      },
    });
  } finally {
    stopBlocked();
  }
  if (gate === "reload") {
    location.reload();
    return;
  }
  if (gate !== "open") {
    root.render(
      <div className="flex h-full items-center justify-center p-6 text-center text-xl" role="alert">
        {t(gate === "waiting" ? "offline.boot.waiting" : "offline.boot.readOnly")}
      </div>,
    );
    return;
  }
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
