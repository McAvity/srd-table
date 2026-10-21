/**
 * kenli F-007 T03 in the app: the Characters page's "Local copy with state and history" (preview,
 * then the file), "Load local copy" (whole-file check, preview, Create; the same copy again only as
 * an explicit separate copy; a refusal shown as text, nothing written), the session's Undo of the
 * import, the History panel on a copy (messages as plain text, references outside the copy named
 * and marked, a historical pending decision), and F-008's import pointing a local copy to its own.
 */

import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exportLocalCopy } from "../../src/import/localCopy/export";
import { flushNow } from "../../src/persistence/sync";
import { useDocuments } from "../../src/store/documents";
import type { HistoryEntry } from "../../src/store/history";
import { useUi } from "../../src/store/ui";
import { rogue } from "../fixtures/characters";
import { testContext } from "../fixtures/player-actions";
import { installTestEngine, renderApp } from "../helpers/app";
import {
  addCharacter,
  bytesOf,
  dumpDb,
  exampleJournal,
  Installations,
  ok,
  rowsOf,
  storeTestPack,
  writeJournal,
} from "./helpers";

installTestEngine(3);
const inst = new Installations();
const docs = () => useDocuments.getState();
let downloads: { name: string; blob: Blob }[] = [];

beforeEach(() => {
  cleanup();
  downloads = [];
  // jsdom has no object URLs: record the blobs the app asks to download.
  URL.createObjectURL = (blob: Blob) => {
    downloads.push({ name: "", blob });
    return `blob:${downloads.length}`;
  };
  URL.revokeObjectURL = () => {};
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    const last = downloads.at(-1);
    if (last) last.name = this.download;
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
afterAll(() => inst.close());

const HTML_TEXT = "<b>bold</b> <img src=x onerror=alert(1)> ‮evil";

/** A source with the contract journal; its last entry carries an HTML-looking message and waited for a decision. */
async function source(name: string) {
  const installation = await inst.open(name);
  await storeTestPack();
  const ctx = await testContext(inst.fx.engine);
  const build = await rogue(inst.fx.engine, 5);
  const id = await addCharacter(build, ctx, inst.fx.engine);
  const j = exampleJournal(id);
  const last = j.entries[594] as HistoryEntry;
  j.entries[594] = {
    ...last,
    messages: [
      {
        code: "test.nested",
        params: {
          inner: { code: "test.inner", params: { n: 2 }, text: "inner" },
          list: ["a", 1, true],
        },
        text: HTML_TEXT,
      },
    ],
    pending_decision: true,
    context: { ...last.context, encounter_id: "e-src77" },
  };
  await writeJournal(j.entries, j.meta);
  await inst.reload();
  const enc = await inst.fx.engine.newEncounter();
  useDocuments.setState((s) => ({
    encounters: {
      ...s.encounters,
      "e-src77": {
        id: "e-src77",
        name: "Cragmaw ambush",
        encounter: enc,
        log: [],
        created: 1,
        updated: 1,
        rev: 1,
        gen: 0,
      },
    },
  }));
  await flushNow();
  return { installation, id, name: docs().characters[id]?.build.name || "" };
}

describe("Characters page: local copy", () => {
  it("export: preview of the copy, then the file; the source unchanged", async () => {
    const src = await source("UI1");
    const before = await dumpDb();
    const user = userEvent.setup();
    await renderApp("/characters");
    await user.click(
      await screen.findByRole("button", { name: "Local copy with state and history" }),
    );
    const summary = await screen.findByTestId("local-copy-export-summary", {}, { timeout: 20_000 });
    expect(summary.textContent).toMatch(/595 history entries \(4 undone\), 6 days/);
    expect(screen.getByText(/A copy of this moment, not a sync/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save the file" }));
    expect(downloads).toHaveLength(1);
    expect(downloads[0]?.name).toMatch(/\.local-copy\.json$/);
    expect(await dumpDb()).toBe(before);
    void src;
  }, 60_000);

  it("load: preview, Create → a new character; the same file again needs an explicit separate copy; Undo removes it", async () => {
    const src = await source("UI2");
    const x = ok(await exportLocalCopy(src.id));
    const file = new File([await bytesOf(x.blob)], x.fileName, { type: "application/json" });
    await inst.open("UI3");
    const user = userEvent.setup();
    await renderApp("/characters");
    await user.click(await screen.findByRole("button", { name: "Load local copy" }));
    await user.upload(screen.getByTestId("local-copy-file"), file);
    const preview = await screen.findByTestId("local-copy-preview", {}, { timeout: 20_000 });
    expect(within(preview).getByTestId("local-copy-entries").textContent).toBe(
      "595 history entries: 591 done, 4 undone",
    );
    expect(within(preview).getByText(/A separate new character is created/)).toBeInTheDocument();
    expect(Object.keys(docs().characters)).toHaveLength(0); // nothing before Create
    await user.click(screen.getByRole("button", { name: "Create the copy" }));
    await waitFor(() => expect(Object.keys(docs().characters)).toHaveLength(1), {
      timeout: 10_000,
    });
    const [id] = Object.keys(docs().characters);
    expect(await rowsOf(id as string)).toHaveLength(595);

    // after Create the app opens the copy's sheet; back to the list, the same file again
    cleanup();
    await renderApp("/characters");
    await user.click(await screen.findByRole("button", { name: "Load local copy" }));
    await user.upload(screen.getByTestId("local-copy-file"), file);
    expect(
      await screen.findByTestId("local-copy-already", {}, { timeout: 20_000 }),
    ).toBeInTheDocument();
    const another = () =>
      screen.getAllByRole("button", { name: "Create another separate copy" })[0] as HTMLElement;
    expect(another()).toBeDisabled();
    await user.click(screen.getByTestId("local-copy-another"));
    expect(another()).toBeEnabled();
    await user.click(another());
    await waitFor(() => expect(Object.keys(docs().characters)).toHaveLength(2), {
      timeout: 10_000,
    });

    // Undo the last import (the session's), from the list
    cleanup();
    await renderApp("/characters");
    const bar = await screen.findAllByTestId("local-copy-last");
    await user.click(
      within(bar[0] as HTMLElement).getByRole("button", { name: "Undo the import" }),
    );
    await waitFor(() => expect(Object.keys(docs().characters)).toHaveLength(1), {
      timeout: 10_000,
    });
    expect(Object.keys(docs().characters)).toEqual([id]);
  }, 90_000);

  it("a malformed file: the refusal as text, nothing written; F-008's import points a local copy to its own", async () => {
    await inst.open("UI4");
    const before = await dumpDb();
    const user = userEvent.setup();
    await renderApp("/characters");
    await user.click(await screen.findByRole("button", { name: "Load local copy" }));
    const bad = new File(
      ['{"format":"srd-table.local-copy/1","payload_sha256":"<b>x</b>","payload":{}}'],
      "bad.json",
    );
    await user.upload(screen.getByTestId("local-copy-file"), bad);
    const problem = await screen.findByTestId("local-copy-problem");
    expect(problem.textContent).toMatch(/malformed \(envelope_sha256\)/);
    expect(problem.querySelector("b")).toBeNull();
    expect(await dumpDb()).toBe(before);
    cleanup();
    await renderApp("/characters");
    await user.click(await screen.findByRole("button", { name: "Import…" }));
    await user.upload(
      screen.getByLabelText("Choose files"),
      new File(['{"format":"srd-table.local-copy/1"}'], "copy.local-copy.json"),
    );
    expect(
      await screen.findByText(/A local copy with history: open it with “Load local copy”/),
    ).toBeInTheDocument();
    expect(await dumpDb()).toBe(before);
  }, 30_000);
});

describe("History panel on a copy", () => {
  it("messages as plain text; outside references named and marked; a waiting decision shown as historical", async () => {
    const src = await source("H1");
    const x = ok(await exportLocalCopy(src.id));
    const bytes = await bytesOf(x.blob);
    await inst.open("H2");
    const { validateLocalCopy } = await import("../../src/import/localCopy/format");
    const { planLocalCopy } = await import("../../src/import/localCopy/plan");
    const { commitLocalCopy } = await import("../../src/import/localCopy/commit");
    const v = await validateLocalCopy(bytes);
    if (!v.ok) throw new Error(v.code);
    const id = ok(
      await commitLocalCopy(await planLocalCopy(v.copy, v.bytes_sha256, "h.local-copy.json")),
    ).recordId;
    useUi.setState({ history: { open: true, character: id } });
    await renderApp(`/characters/${id}/sheet`);
    const msg = await screen.findAllByTestId("history-message", {}, { timeout: 20_000 });
    const html = msg.find((m) => m.textContent?.includes("bold"));
    expect(html?.textContent).toBe(HTML_TEXT);
    expect(html?.querySelector("b, img")).toBeNull();
    expect(document.querySelector("img[src=x]")).toBeNull();
    const badges = screen.getAllByTestId("history-badge").map((b) => b.textContent);
    expect(badges).toContain("Waited for a decision (historical)");
    expect(badges).not.toContain("Waiting for a decision");
    expect(badges).toContain("outside this copy");
    expect(screen.getAllByText(/Cragmaw ambush/).length).toBeGreaterThan(0);
  }, 60_000);
});
