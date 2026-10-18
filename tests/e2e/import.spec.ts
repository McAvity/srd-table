/**
 * kenli F-008 in a real browser (the production build: worker, IndexedDB): an encounter and its
 * party imported from a library URL (the HTTPS origin is routed to the synthetic fixtures, with
 * CORS), still there after a reload, each character on its own pack version; then the library
 * and the app's content cut off, and a character's sheet and a never-opened table still load.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";

const FIX = join(import.meta.dirname, "..", "fixtures", "transfer");
const LIB = "https://host.test/dnd/library/";

async function serveLibrary(page: Page) {
  await page.route(`${LIB}**`, async (route) => {
    const rel = route.request().url().slice(LIB.length);
    try {
      await route.fulfill({
        status: 200,
        body: readFileSync(join(FIX, "library", rel)),
        headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
      });
    } catch {
      await route.fulfill({
        status: 404,
        body: "",
        headers: { "access-control-allow-origin": "*" },
      });
    }
  });
}

const packsInDb = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<string[]>((resolve, reject) => {
        const req = indexedDB.open("srd-table");
        req.onsuccess = () => {
          const tx = req.result.transaction("packs", "readonly");
          const all = tx.objectStore("packs").getAll();
          all.onsuccess = () => resolve((all.result as { key: string }[]).map((p) => p.key).sort());
          all.onerror = () => reject(all.error);
        };
        req.onerror = () => reject(req.error);
      }),
  );

test("import an encounter with its party by URL, reload, then play on with the host gone", async ({
  page,
}) => {
  await serveLibrary(page);
  await page.goto("/#/encounters");
  await page.getByRole("button", { name: "Import…" }).click();
  await page.getByRole("textbox", { name: "URL" }).fill(`${LIB}d/encounter/mixed-duel.json`);
  await page.getByRole("button", { name: "Fetch", exact: true }).click();
  await expect(page.getByTestId("import-character-Wren")).toBeVisible();
  await expect(page.getByTestId("import-character-Sable")).toBeVisible();
  await expect(page.getByText(/synthetic-a 2\.0\.0.*will be installed/)).toBeVisible();
  await page.getByRole("button", { name: "Import", exact: true }).click();
  await expect(page).toHaveURL(/#\/encounters\/e-/);
  await expect(page.getByText("Synthetic Dummy").first()).toBeVisible();
  expect((await packsInDb(page)).map((k) => k.split("#")[0])).toEqual([
    "synthetic-a@1.0.0",
    "synthetic-a@2.0.0",
  ]);

  await page.reload();
  await expect(page.getByText("Synthetic Dummy").first()).toBeVisible();
  await page.goto("/#/characters");
  await expect(page.getByRole("heading", { name: "Wren" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Sable" })).toBeVisible();

  // The library and the app's content are gone: what was imported and loaded still plays.
  await page.route(`${LIB}**`, (route) => route.abort());
  await page.route("**/content/**", (route) => route.abort());
  await page.locator("article", { hasText: "Sable" }).getByRole("link", { name: "Sheet" }).click();
  await page.getByRole("tab", { name: "Spells" }).click();
  await expect(page.getByText("Synthetic Spark").first()).toBeVisible();
  // Back to the table without the network: the world's monster and both characters still load.
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Table" }).click();
  await expect(page.getByRole("button", { name: /Synthetic Dummy 30\/30/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Sable 8\/8/ })).toBeVisible();
});
