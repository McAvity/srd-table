/**
 * kenli F-011 T04 (contracts/changes.md §8) in the app: the three import entrances. A character
 * transfer (the old character import) is refused at each — "Import character", Settings' "Import
 * pack…" and Encounters' "Import…" — before any preview, with nothing written; a pack still imports
 * in Settings and an encounter with its party in Encounters. "Import character" by URL stops on
 * Stop with nothing written. The portrait picker asks only for PNG, JPEG or WebP and says why an
 * image was refused.
 */

import "../helpers/node-blob";
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setImageDecoder } from "../../src/lib/image";
import { db } from "../../src/persistence/db";
import { useDocuments } from "../../src/store/documents";
import { wizard } from "../fixtures/characters";
import { installTestEngine, renderApp, resetStores } from "../helpers/app";
import { gif, headerDecoder } from "../helpers/images";
import { fileOf, LIB, libraryFetch } from "../helpers/transfer";

const engine = installTestEngine(3);
beforeEach(async () => {
  cleanup();
  await resetStores();
  vi.stubGlobal("fetch", libraryFetch());
});
afterEach(() => {
  vi.unstubAllGlobals();
  setImageDecoder(null);
});

const asFile = (rel: string) => {
  const f = fileOf(rel);
  return new File([f.bytes], f.name, { type: "application/json" });
};
const docs = () => useDocuments.getState();
/** What storage holds (records, packs, portraits): "nothing written" is this unchanged. */
async function stored() {
  const d = await db();
  return JSON.stringify({
    characters: await d.getAllKeys("characters"),
    encounters: await d.getAllKeys("encounters"),
    packs: await d.getAllKeys("packs"),
    portraits: await d.getAllKeys("portraits"),
    history: await d.count("history"),
  });
}
const ROOT_REFUSED = /This entrance doesn't import that/;

describe("a character transfer is refused at every entrance, nothing written", () => {
  it("Import character (file and URL)", async () => {
    const before = await stored();
    const user = userEvent.setup();
    await renderApp("/characters");
    await user.click(await screen.findByRole("button", { name: "Import character" }));
    await user.upload(
      screen.getByTestId("local-copy-file"),
      asFile("characters/wren.r2.transfer.json"),
    );
    expect((await screen.findByTestId("local-copy-problem")).textContent).toMatch(
      /Not a character copy: this entrance imports only a full character copy/,
    );
    // The old library link of a character (pointer → transfer): refused the same way.
    await user.type(screen.getByTestId("local-copy-url"), `${LIB}d/character/wren.json`);
    await user.click(screen.getByTestId("local-copy-fetch"));
    expect((await screen.findByTestId("local-copy-problem")).textContent).toMatch(
      /Not a character copy/,
    );
    expect(screen.queryByTestId("local-copy-preview")).toBeNull();
    expect(Object.keys(docs().characters)).toHaveLength(0);
    expect(await stored()).toBe(before);
  });

  it("Settings → Import pack…", async () => {
    const before = await stored();
    const user = userEvent.setup();
    await renderApp("/settings");
    await user.click(await screen.findByRole("button", { name: "Import pack…" }));
    await user.upload(screen.getByLabelText("Choose files"), [
      asFile("characters/wren.r1.transfer.json"),
      asFile("packs/synthetic-a-1.0.0.transfer.json"),
    ]);
    expect(await screen.findByText(ROOT_REFUSED)).toBeInTheDocument();
    expect(await stored()).toBe(before);
  });

  it("Encounters → Import…", async () => {
    const before = await stored();
    const user = userEvent.setup();
    await renderApp("/encounters");
    await user.click(await screen.findByRole("button", { name: "Import…" }));
    await user.upload(screen.getByLabelText("Choose files"), [
      asFile("characters/wren.r1.transfer.json"),
      asFile("packs/synthetic-a-1.0.0.transfer.json"),
    ]);
    expect(await screen.findByText(ROOT_REFUSED)).toBeInTheDocument();
    expect(await stored()).toBe(before);
  });
});

describe("what each entrance still imports", () => {
  it("Settings imports a pack (file): installed, listed", async () => {
    const user = userEvent.setup();
    await renderApp("/settings");
    await user.click(await screen.findByRole("button", { name: "Import pack…" }));
    await user.upload(screen.getByLabelText("Choose files"), [
      asFile("packs/synthetic-a-1.0.0.transfer.json"),
    ]);
    const confirm = await screen.findByRole("button", { name: "Import" });
    await waitFor(() => expect(confirm).toBeEnabled(), { timeout: 15_000 }); // after the preview
    await user.click(confirm);
    await waitFor(async () =>
      expect(
        (await (await db()).getAll("packs")).map((p) => `${p.ref.id}@${p.ref.version}`),
      ).toContain("synthetic-a@1.0.0"),
    );
  });

  it("Encounters imports an encounter with its party (files): the encounter and both party characters", async () => {
    const user = userEvent.setup();
    await renderApp("/encounters");
    await user.click(await screen.findByRole("button", { name: "Import…" }));
    await user.upload(screen.getByLabelText("Choose files"), [
      asFile("encounters/mixed-duel.transfer.json"),
      asFile("characters/sable.r1.transfer.json"),
      asFile("characters/wren.r2.transfer.json"),
      asFile("packs/synthetic-a-2.0.0.transfer.json"),
      asFile("packs/synthetic-a-1.0.0.transfer.json"),
    ]);
    const confirm = await screen.findByRole("button", { name: "Import" });
    await waitFor(() => expect(confirm).toBeEnabled(), { timeout: 15_000 }); // after the preview
    await user.click(confirm);
    await waitFor(() => expect(Object.keys(docs().encounters)).toHaveLength(1), {
      timeout: 15_000,
    });
    expect(
      Object.values(docs().characters)
        .map((c) => c.build.name)
        .sort(),
    ).toEqual(["Sable", "Wren"]);
  });
});

describe("Import character by URL: Stop", () => {
  it("a fetch that hangs is stopped: the request aborted, the refusal said, nothing written", async () => {
    const before = await stored();
    let aborted = false;
    vi.stubGlobal(
      "fetch",
      libraryFetch({
        [`${LIB}slow.json`]: (init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              aborted = true;
              reject(new DOMException("aborted", "AbortError"));
            });
          }),
      }),
    );
    const user = userEvent.setup();
    await renderApp("/characters");
    await user.click(await screen.findByRole("button", { name: "Import character" }));
    await user.type(screen.getByTestId("local-copy-url"), `${LIB}slow.json`);
    await user.click(screen.getByTestId("local-copy-fetch"));
    await user.click(await screen.findByTestId("local-copy-stop"));
    expect((await screen.findByTestId("local-copy-problem")).textContent).toMatch(
      /Stopped: nothing was written/,
    );
    await waitFor(() => expect(aborted).toBe(true));
    expect(await stored()).toBe(before);
  });
});

describe("the portrait picker", () => {
  it("asks for PNG, JPEG or WebP; a GIF is refused with its reason, nothing stored", async () => {
    setImageDecoder(headerDecoder);
    const r = await docs().importCharacter(await wizard(engine, 1));
    if (!r.ok) throw new Error("no character");
    const user = userEvent.setup({ applyAccept: false }); // the file still reaches the app
    await renderApp(`/characters/${r.id}/sheet`);
    const input = (await screen.findAllByLabelText("Choose a portrait")).find(
      (e) => e.tagName === "INPUT",
    ) as HTMLInputElement;
    expect(input.accept).toBe("image/jpeg,image/png,image/webp");
    await user.upload(input, new File([gif()], "old.gif", { type: "image/png" }));
    expect((await screen.findByTestId("portrait-problem")).textContent).toBe(
      "Choose a PNG, JPEG or WebP image.",
    );
    expect(await (await db()).get("portraits", r.id)).toBeUndefined();
  });
});
