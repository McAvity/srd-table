/**
 * The import dialog (kenli F-008): a library URL shows everything before anything is saved and
 * imports on Import; files go the same way; a build without a state needs its initialization
 * ticked (Q-03), and Import stays disabled with the reason shown until then.
 */

import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDocuments } from "../../src/store/documents";
import { installTestEngine, renderApp, resetStores } from "../helpers/app";
import { fileOf, LIB, libraryFetch } from "../helpers/transfer";

installTestEngine(3);
beforeEach(async () => {
  cleanup();
  await resetStores();
  vi.stubGlobal("fetch", libraryFetch());
});
afterEach(() => vi.unstubAllGlobals());

const asFile = (rel: string) => {
  const f = fileOf(rel);
  return new File([f.bytes], f.name, { type: "application/json" });
};

describe("import dialog", () => {
  it("a library URL: preview, then Import writes the character with its content", async () => {
    const user = userEvent.setup();
    await renderApp("/characters");
    await user.click(await screen.findByRole("button", { name: "Import…" }));
    await user.type(screen.getByRole("textbox", { name: "URL" }), `${LIB}d/character/wren.json`);
    await user.click(screen.getByRole("button", { name: "Fetch" }));
    expect(await screen.findByTestId("import-character-Wren")).toBeInTheDocument();
    expect(screen.getByText(/synthetic-a 1.0.0.*will be installed/)).toBeInTheDocument();
    expect(Object.keys(useDocuments.getState().characters)).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Import" }));
    await waitFor(() => expect(Object.keys(useDocuments.getState().characters)).toHaveLength(1));
    const wren = Object.values(useDocuments.getState().characters)[0];
    expect(wren?.content?.packs.map((p) => p.id)).toEqual(["srd-5.2.1", "synthetic-a"]);
    expect(wren?.state.hp.current).toBe(5);
  });

  it("files: a build without a state waits for its initialization to be ticked", async () => {
    const user = userEvent.setup();
    await renderApp("/characters");
    await user.click(await screen.findByRole("button", { name: "Import…" }));
    await user.upload(screen.getByLabelText("Choose files"), [
      asFile("characters/wren-build-only.transfer.json"),
      asFile("packs/synthetic-a-1.0.0.transfer.json"),
    ]);
    const confirm = () => screen.getByRole("button", { name: "Import" });
    expect(await screen.findByTestId("import-character-Wren")).toBeInTheDocument();
    expect(confirm()).toBeDisabled();
    await user.selectOptions(screen.getByRole("combobox", { name: "Import Wren as" }), "new");
    expect(screen.getByText(/tick “Start this build with a new play state”/)).toBeInTheDocument();
    expect(confirm()).toBeDisabled();
    await user.click(screen.getByRole("checkbox"));
    expect(confirm()).toBeEnabled();
    await user.click(confirm());
    await waitFor(() => expect(Object.keys(useDocuments.getState().characters)).toHaveLength(1));
    expect(Object.values(useDocuments.getState().characters)[0]?.origin).toMatchObject({
      state_origin: "initialized-on-import",
    });
  });

  it("a refusal is shown and nothing is written", async () => {
    const user = userEvent.setup();
    await renderApp("/encounters");
    await user.click(await screen.findByRole("button", { name: "Import…" }));
    await user.upload(screen.getByLabelText("Choose files"), [
      asFile("encounters/mixed-duel.transfer.json"),
    ]);
    expect(await screen.findByText(/Something it needs isn't here/)).toBeInTheDocument();
    expect(Object.keys(useDocuments.getState().encounters)).toHaveLength(0);
  });
});
