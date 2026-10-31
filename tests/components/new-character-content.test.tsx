/**
 * kenli F-011 T08: a new character on a pack imported in Settings. "Import pack…" lists the pack
 * at once under "Packs on this device" (the list is refreshed after the import). "New character"
 * then asks for the content: the campaign's (Settings) or the installed pack's exact context — its
 * required packs and the pack itself, by hash — which the new record is pinned to, as an imported
 * record is; its builder reads that content. Without an imported pack nothing is asked (as before).
 */

import "../helpers/node-blob";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../../src/persistence/db";
import { useDocuments } from "../../src/store/documents";
import { installTestEngine, renderApp, resetStores } from "../helpers/app";
import { fileOf, fixtureJson, libraryFetch } from "../helpers/transfer";

const engine = installTestEngine(5);
beforeEach(async () => {
  cleanup();
  await resetStores();
  vi.stubGlobal("fetch", libraryFetch());
});
afterEach(() => vi.unstubAllGlobals());

const PACK = "packs/synthetic-a-1.0.0.transfer.json";
const asFile = (rel: string) => {
  const f = fileOf(rel);
  return new File([f.bytes], f.name, { type: "application/json" });
};
const docs = () => useDocuments.getState();

async function importPack() {
  const user = userEvent.setup();
  await renderApp("/settings");
  await user.click(await screen.findByRole("button", { name: "Import pack…" }));
  await user.upload(screen.getByLabelText("Choose files"), [asFile(PACK)]);
  const confirm = await screen.findByRole("button", { name: "Import" });
  await waitFor(() => expect(confirm).toBeEnabled(), { timeout: 15_000 });
  await user.click(confirm);
  return user;
}

describe("a pack imported in Settings, then New character", () => {
  it("is listed under Packs on this device right after the import", async () => {
    await importPack();
    const list = await screen.findByRole("region", { name: "Packs on this device" });
    await waitFor(() => expect(list).toHaveTextContent(/synthetic-a 1\.0\.0/), { timeout: 15_000 });
  });

  it("New character asks for the content; the pack's choice pins the record to its exact context", async () => {
    await importPack();
    await waitFor(async () =>
      expect((await (await db()).getAll("packs")).some((p) => p.ref.id === "synthetic-a")).toBe(
        true,
      ),
    );
    cleanup();
    const user = userEvent.setup();
    await renderApp("/characters");
    await user.click(await screen.findByRole("button", { name: "New character" }));
    const dialog = await screen.findByRole("dialog", { name: "New character: content" });
    expect(
      within(dialog).getByRole("button", { name: /The campaign’s content \(Settings\)/ }),
    ).toBeInTheDocument();
    await user.click(
      await within(dialog).findByRole("button", {
        name: /^synthetic-a 1\.0\.0 and the packs it needs/,
      }),
    );
    await waitFor(() => expect(Object.keys(docs().characters)).toHaveLength(1));
    const record = Object.values(docs().characters)[0];
    const pack = fixtureJson(PACK);
    expect(record?.content?.packs.map((p) => `${p.id}@${p.version}#${p.sha256}`)).toEqual([
      `srd-5.2.1@5.2.1#${pack.requires[0].sha256}`,
      `synthetic-a@1.0.0#${pack.sha256}`,
    ]);
    expect(record?.content?.sources).toBeNull();
    // The record's own content has the pack's spell; the campaign's (the SRD alone) doesn't.
    const ids = async (content?: unknown) =>
      ((await engine.entries("spells", content as never)) as { id: string }[]).map((s) => s.id);
    expect(await ids(record?.content)).toContain("synthetic-spark");
    expect(await ids()).not.toContain("synthetic-spark");
  });

  it("the campaign's content in that dialog makes a record without its own content", async () => {
    await importPack();
    await waitFor(async () =>
      expect((await (await db()).getAll("packs")).some((p) => p.ref.id === "synthetic-a")).toBe(
        true,
      ),
    );
    cleanup();
    const user = userEvent.setup();
    await renderApp("/characters");
    await user.click(await screen.findByRole("button", { name: "New character" }));
    const dialog = await screen.findByRole("dialog", { name: "New character: content" });
    await user.click(within(dialog).getByRole("button", { name: /The campaign’s content/ }));
    await waitFor(() => expect(Object.keys(docs().characters)).toHaveLength(1));
    expect(Object.values(docs().characters)[0]?.content).toBeUndefined();
  });
});

it("without an imported pack, New character asks nothing (the campaign's content)", async () => {
  const user = userEvent.setup();
  await renderApp("/characters");
  await user.click(await screen.findByRole("button", { name: "New character" }));
  await waitFor(() => expect(Object.keys(docs().characters)).toHaveLength(1));
  expect(screen.queryByRole("dialog", { name: "New character: content" })).toBeNull();
  expect(Object.values(docs().characters)[0]?.content).toBeUndefined();
});
