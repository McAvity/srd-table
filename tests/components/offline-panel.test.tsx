/**
 * kenli F-007 T04: Settings → Offline play and the sheet's short status, on the real app, store,
 * engine and fake IndexedDB; the app release is a labeled fake of the T02 API (no service worker
 * in jsdom). Unprepared → "missing", Prepare → ready with every item listed, storage shown apart;
 * uncontrolled after the first registration → "Reload to finish".
 */

import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { type ReleaseApi, setReleaseApi } from "@/offline/readiness";
import type { Inspection } from "@/offline/release";
import { rogue } from "../fixtures/characters";
import { installTestEngine, renderApp } from "../helpers/app";
import { addCharacter, Installations } from "../localCopy/helpers";

installTestEngine(3);
const inst = new Installations();
const RID = "r-0123456789abcdef";
afterEach(() => {
  cleanup();
  setReleaseApi(null);
});
afterAll(() => inst.close());

function fake(controller: string | null): ReleaseApi {
  const ins = (): Inspection => ({ release_id: RID, complete: true, missing: [] });
  const api: ReleaseApi = {
    releaseId: RID,
    isRelease: true,
    inspect: async () => ins(),
    prepare: async () => ins(),
    controller: () => controller,
  };
  setReleaseApi(api);
  return api;
}

describe("Settings → Offline play", () => {
  it("unprepared → incomplete; Prepare → ready, each item ok, storage shown apart; the sheet says it too", async () => {
    await inst.open("UI1");
    fake(RID);
    const id = await addCharacter(await rogue(inst.fx.engine, 3), null, inst.fx.engine);
    const user = userEvent.setup();
    await renderApp("/settings");
    const panel = await screen.findByTestId("offline-readiness", {}, { timeout: 20_000 });
    await waitFor(() =>
      expect(within(panel).getByTestId("offline-status").dataset.status).toBe("incomplete"),
    );
    expect(
      within(panel).getByText(/The campaign's packs: missing — not prepared/),
    ).toBeInTheDocument();
    expect(within(panel).getByTestId("offline-storage").textContent).toMatch(/not asked yet/);
    await user.click(within(panel).getByRole("button", { name: "Prepare offline" }));
    await waitFor(
      () => expect(within(panel).getByTestId("offline-status").dataset.status).toBe("ready"),
      { timeout: 20_000 },
    );
    const items = within(panel).getAllByTestId("offline-item");
    expect(items.every((li) => li.dataset.state === "ok")).toBe(true);
    expect(items.map((li) => li.dataset.kind)).toEqual([
      "app",
      "record",
      "pack",
      "history",
      "save",
    ]);
    expect(within(panel).getByTestId("offline-storage").dataset.persisted).toMatch(
      /^(granted|denied|unsupported|unknown)$/,
    );
    cleanup();
    await renderApp(`/characters/${id}/sheet`);
    const short = await screen.findByTestId("offline-short", {}, { timeout: 20_000 });
    await waitFor(() => expect(short.dataset.status).toBe("ready"));
  }, 60_000);

  it("prepared but not yet in control of the page: 'Reload to finish', not ready", async () => {
    await inst.open("UI2");
    fake(null);
    await addCharacter(await rogue(inst.fx.engine, 3), null, inst.fx.engine);
    const user = userEvent.setup();
    await renderApp("/settings");
    const panel = await screen.findByTestId("offline-readiness", {}, { timeout: 20_000 });
    await user.click(within(panel).getByRole("button", { name: "Prepare offline" }));
    await waitFor(
      () => expect(within(panel).getByTestId("offline-status").dataset.status).toBe("checking"),
      { timeout: 20_000 },
    );
    expect(within(panel).getByRole("button", { name: "Reload to finish" })).toBeInTheDocument();
    expect(within(panel).getByText(/prepared — reload the app to finish/)).toBeInTheDocument();
  }, 60_000);
});
