/**
 * kenli F-011 T09: the library staging (dnd5 tools/migration/library) imported through the app's
 * own entrances, each test in a clean browser profile: every character pointer by URL in
 * "Import character" (a full copy `/2`), the pack by URL in Settings → "Import pack…" (then a copy
 * that reuses it: "Already here"), a pack of the same id and version with other content (then the
 * copy is in conflict and nothing is created), and the rehearsal encounter by URL in Encounters
 * (its party an internal character). The library is served at `F011_LIBRARY` (same origin as the
 * app; a private /tmp staging, never a public asset). What the app stored is read from IndexedDB
 * (read only) into `F011_T09_OUT/<project>/<case>.json` for dnd5's comparison.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";

const LIB = process.env.F011_LIBRARY ?? "/library/";
const OUT = process.env.F011_T09_OUT ?? "/tmp/f011-t09-out";
const CONFLICT = process.env.F011_CONFLICT_PACK ?? "";
const button = (scope: Page | ReturnType<Page["locator"]>, name: string | RegExp) =>
  scope.getByRole("button", { name, exact: typeof name === "string" });
test.use({ actionTimeout: 30_000, navigationTimeout: 60_000 });

async function storeDump(page: Page): Promise<unknown> {
  await page.waitForTimeout(800); // the autosave's debounce
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open("srd-table");
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction(["characters", "encounters", "packs", "history"], "readonly");
          const out: Record<string, unknown> = {};
          let left = 4;
          for (const name of ["characters", "encounters", "packs", "history"]) {
            const req = tx.objectStore(name).getAll();
            req.onsuccess = () => {
              out[name] =
                name === "packs"
                  ? (req.result as { key: string; origin: unknown }[]).map((p) => ({
                      key: p.key,
                      origin: p.origin,
                    }))
                  : req.result;
              if (--left === 0) {
                db.close();
                resolve(out);
              }
            };
          }
        };
      }),
  );
}
function save(name: string, value: unknown) {
  const dir = join(OUT, test.info().project.name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`);
}

async function openCopy(page: Page, slug: string) {
  await page.goto("/#/characters");
  await button(page, "Import character").click();
  await page
    .getByTestId("local-copy-url")
    .fill(new URL(`${LIB}d/character/${slug}.json`, page.url()).href);
  await page.getByTestId("local-copy-fetch").click();
  await expect(
    page.getByTestId("local-copy-preview").or(page.getByTestId("local-copy-problem")),
  ).toBeVisible({ timeout: 60_000 });
}

for (const [slug, name, origin] of [
  ["fighter7", "Fighter7", /new session/i],
  ["cleric7", "Cleric7", /new session/i],
  ["wizard7", "Wizard7", /new session/i],
  ["kenli7-r1", "Kenli7", /new session/i],
  ["kenli7-r1-fx-spent", "Kenli7", /a test fixture/i],
  ["kenli7-r1-f005", "Kenli7", /a test fixture/i],
] as const) {
  test(`library copy ${slug}: Import character by its pointer URL, a clean profile`, async ({
    page,
  }) => {
    await openCopy(page, slug);
    const preview = page.getByTestId("local-copy-preview");
    await expect(preview).toBeVisible();
    await expect(preview).toContainText(name);
    await expect(page.getByTestId("local-copy-state-origin")).toHaveText(origin);
    await expect(page.getByTestId("local-copy-entries")).toContainText("0 history entries");
    // The SRD is served with the app ("Already here"); a Kenli copy brings its own pack ("New packs").
    await expect(preview).toContainText(
      slug.startsWith("kenli") ? "New packs: kenli-pack" : "Already here: srd-5.2.1",
    );
    const shown = (await preview.innerText()).replace(/\s+/g, " ");
    await button(page, /^Create (the|another separate) copy$/).click();
    await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
    save(slug, { preview: shown, store: await storeDump(page) });
  });
}

test("the pack by URL in Settings, then a copy reusing it (Already here)", async ({ page }) => {
  await page.goto("/#/settings");
  await button(page, "Import pack…").click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByRole("textbox")
    .first()
    .fill(new URL(`${LIB}d/pack/kenli-pack.json`, page.url()).href);
  await button(dialog, "Fetch").click();
  await expect(dialog.getByTestId("import-plan")).toBeVisible({ timeout: 60_000 });
  await button(dialog, "Import").click();
  await expect(page.getByRole("region", { name: "Packs on this device" })).toContainText(
    "kenli-pack 0.4.0",
  );
  await openCopy(page, "kenli7-r1");
  const preview = page.getByTestId("local-copy-preview");
  await expect(preview).toContainText(/Already here: srd-5\.2\.1 5\.2\.1, kenli-pack 0\.4\.0/);
  await expect(preview).not.toContainText("New packs");
  await expect(preview).not.toContainText("In conflict");
  await button(page, /^Create (the|another separate) copy$/).click();
  await expect(page.getByRole("heading", { level: 1, name: "Kenli7" })).toBeVisible();
  save("pack-then-copy", { store: await storeDump(page) });
});

test("a pack of the same id and version with other content: the copy is in conflict, nothing created", async ({
  page,
}) => {
  test.skip(!CONFLICT, "F011_CONFLICT_PACK not given");
  await page.goto("/#/settings");
  await button(page, "Import pack…").click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Choose files").setInputFiles(CONFLICT);
  await expect(dialog.getByTestId("import-plan")).toBeVisible({ timeout: 60_000 });
  await button(dialog, "Import").click();
  await expect(page.getByRole("region", { name: "Packs on this device" })).toContainText(
    "kenli-pack 0.4.0",
  );
  await openCopy(page, "kenli7-r1");
  const shown = page.getByTestId("local-copy-preview").or(page.getByTestId("local-copy-problem"));
  await expect(shown).toContainText(/conflict|other content/i);
  const create = page.getByRole("button", { name: /^Create (the|another separate) copy$/ });
  if ((await create.count()) && (await create.isEnabled())) {
    await create.click();
    await expect(page.getByTestId("local-copy-problem")).toContainText(
      /conflict|other content|same version/i,
    );
  }
  const store = (await storeDump(page)) as { characters: unknown[] };
  expect(store.characters).toHaveLength(0);
  save("pack-conflict", { shown: (await shown.innerText()).replace(/\s+/g, " "), store });
});

test("the rehearsal encounter by URL in Encounters: the encounter and its party character", async ({
  page,
}) => {
  await page.goto("/#/encounters");
  await button(page, "Import…").click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByRole("textbox")
    .first()
    .fill(new URL(`${LIB}d/encounter/kenli7-r1-rehearsal.json`, page.url()).href);
  await button(dialog, "Fetch").click();
  await expect(dialog.getByTestId("import-plan")).toBeVisible({ timeout: 60_000 });
  await button(dialog, "Import").click();
  await expect(page).toHaveURL(/#\/encounters\/e-/, { timeout: 60_000 });
  await expect(page.getByRole("navigation", { name: "Initiative" })).toContainText(/Kenli/);
  save("rehearsal", { store: await storeDump(page) });
});
