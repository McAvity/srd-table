/**
 * kenli F-011 T04, review03 R03-08: the copy's 20 MiB bound comes first. "Import character" refuses
 * a file larger than that from its size, before reading it; bytes (a file read, a URL's body) are
 * refused by their length before the first decode or JSON parse; a file of exactly 20 MiB is still
 * read. A read that fails, or a dialog closed while the file is read, leaves no busy state, no stale
 * result and nothing written.
 */

import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOCAL_COPY_LIMITS } from "../../src/import/localCopy/format";
import { checkCopyRoot } from "../../src/import/localCopy/url";
import { ImportError } from "../../src/import/transfer";
import { db } from "../../src/persistence/db";
import { installTestEngine, renderApp, resetStores } from "../helpers/app";

installTestEngine(3);
beforeEach(async () => {
  cleanup();
  await resetStores();
});
afterEach(() => vi.restoreAllMocks());

const LIMIT = LOCAL_COPY_LIMITS.copyBytes;
async function stored() {
  const d = await db();
  return JSON.stringify({
    characters: await d.getAllKeys("characters"),
    packs: await d.getAllKeys("packs"),
    portraits: await d.getAllKeys("portraits"),
    history: await d.count("history"),
  });
}
/** A small file that says it has `size` bytes, its read under the test's control. */
function fileOf(size: number, read: () => Promise<ArrayBuffer>) {
  const f = new File(['{"format":"srd-table.local-copy/2"}'], "copy.local-copy.json", {
    type: "application/json",
  });
  Object.defineProperty(f, "size", { value: size });
  const spy = vi.fn(read);
  Object.defineProperty(f, "arrayBuffer", { value: spy });
  return { f, spy };
}
async function openImport() {
  const user = userEvent.setup();
  await renderApp("/characters");
  await user.click(await screen.findByRole("button", { name: "Import character" }));
  return user;
}

describe("Import character: the file's size before it is read", () => {
  it("over 20 MiB: refused from its size, never read; nothing written", async () => {
    const before = await stored();
    const user = await openImport();
    const { f, spy } = fileOf(LIMIT + 1, async () => new ArrayBuffer(0));
    await user.upload(screen.getByTestId("local-copy-file"), f);
    expect((await screen.findByTestId("local-copy-problem")).textContent).toMatch(
      /The copy is larger than 20 MiB/,
    );
    expect(spy).not.toHaveBeenCalled();
    expect(screen.queryByText("Checking the whole file…")).toBeNull();
    expect(await stored()).toBe(before);
  });

  it("exactly 20 MiB: read (then checked as any file)", async () => {
    const user = await openImport();
    const { f, spy } = fileOf(LIMIT, async () => new TextEncoder().encode("{}").buffer);
    await user.upload(screen.getByTestId("local-copy-file"), f);
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(await screen.findByTestId("local-copy-problem")).not.toHaveTextContent(/20 MiB/);
  });

  it("a read that fails: said, not busy, nothing written", async () => {
    const before = await stored();
    const user = await openImport();
    const { f } = fileOf(100, async () => {
      throw new DOMException("gone", "NotReadableError");
    });
    await user.upload(screen.getByTestId("local-copy-file"), f);
    expect((await screen.findByTestId("local-copy-problem")).textContent).toMatch(
      /The file couldn't be read: nothing was written/,
    );
    expect(screen.queryByText("Checking the whole file…")).toBeNull();
    expect(screen.queryByTestId("local-copy-preview")).toBeNull();
    expect(await stored()).toBe(before);
  });

  it("closed while the file is read: the late bytes are dropped, the dialog opens clean, nothing written", async () => {
    const before = await stored();
    const user = await openImport();
    let finish!: (b: ArrayBuffer) => void;
    const { f, spy } = fileOf(100, () => new Promise<ArrayBuffer>((r) => (finish = r)));
    await user.upload(screen.getByTestId("local-copy-file"), f);
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(screen.getByText("Checking the whole file…")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    finish(new TextEncoder().encode('{"format":"srd-table.transfer/1"}').buffer);
    await new Promise((r) => setTimeout(r, 50));
    await user.click(await screen.findByRole("button", { name: "Import character" }));
    expect(screen.queryByTestId("local-copy-problem")).toBeNull();
    expect(screen.queryByTestId("local-copy-preview")).toBeNull();
    expect(screen.queryByText("Checking the whole file…")).toBeNull();
    expect(await stored()).toBe(before);
  });
});

describe("bytes: the bound before the first decode or parse", () => {
  it("over 20 MiB refused before TextDecoder or JSON.parse; exactly 20 MiB parsed", () => {
    const parse = vi.spyOn(JSON, "parse");
    const decode = vi.spyOn(TextDecoder.prototype, "decode");
    const big = new Uint8Array(LIMIT + 1).fill(0x20);
    let code = "ok";
    try {
      checkCopyRoot(big);
    } catch (e) {
      code = (e as ImportError).code;
    }
    expect(code).toBe("limit_copy_bytes");
    expect(parse).not.toHaveBeenCalled();
    expect(decode).not.toHaveBeenCalled();
    const head = new TextEncoder().encode('{"format":"srd-table.local-copy/2","pad":"');
    const exact = new Uint8Array(LIMIT).fill(0x78);
    exact.set(head);
    exact.set(new TextEncoder().encode('"}'), LIMIT - 2);
    expect(() => checkCopyRoot(exact)).not.toThrow();
    expect(parse).toHaveBeenCalledTimes(1);
    expect(ImportError).toBeDefined();
  });
});
