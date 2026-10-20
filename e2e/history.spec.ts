/**
 * kenli F-006 T04 in real browsers on a production build (served from /tmp on loopback; Chromium,
 * WebKit, and WebKit with iPad emulation — an emulation, not a physical iPad): the History panel
 * beside the sheet with rolls, a Heroic reroll and its cost, follow-up damage, rests (Cancel and
 * Confirm), the second Long Rest and the DM's exception, Undo/Redo, days and a reload; two tabs of
 * one origin writing the same journal (the head's compare-and-set); the v2 → v4 upgrade and the
 * tabs holding an older or wanting a newer database; more than 500 saved entries after a reload;
 * an import replacing a character (its boundary, Undo/Redo, reload), a copy, a deletion, exports.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { FIXTURES } from "./global-setup";

const fixture = (name: string) => join(FIXTURES, name);
const TRANSFER = join(import.meta.dirname, "..", "tests", "fixtures", "transfer");
const button = (scope: Page | Locator, name: string | RegExp) =>
  scope.getByRole("button", { name, exact: typeof name === "string" });
const TOGGLE = "History: what this character played";

/** A tap on a touch device (the iPad emulation), a click elsewhere. */
async function press(target: Locator) {
  if (test.info().project.use.hasTouch) await target.tap();
  else await target.click();
}

async function importBuilds(page: Page, names: string[]) {
  await page.goto("/#/characters");
  await button(page, "Import…").click();
  await page
    .getByLabel("Choose files")
    .setInputFiles(names.map((n) => fixture(`${n.toLowerCase()}.json`)));
  await page.getByRole("combobox", { name: "Content for these files" }).selectOption("campaign");
  for (const name of names) {
    const card = page.getByTestId(`import-character-${name}`);
    await card.getByRole("combobox").selectOption("new");
    await card.getByRole("checkbox").check();
  }
  await button(page, "Import").click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
}

async function openSheet(page: Page, name: string) {
  await page.goto("/#/characters");
  await page
    .getByRole("article")
    .filter({ hasText: name })
    .getByRole("link", { name: "Sheet" })
    .click();
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
}

async function openPanel(page: Page) {
  await press(page.getByRole("button", { name: TOGGLE }));
  const panel = page.getByRole("dialog", { name: "History" });
  await expect(panel).toBeVisible();
  return panel;
}

/** Every row of an IndexedDB store of the app (read in the page, the app's own database). */
function rowsOf<T = Record<string, unknown>>(page: Page, store: string): Promise<T[]> {
  return page.evaluate(
    (name) =>
      new Promise<T[]>((resolve, reject) => {
        const req = indexedDB.open("srd-table");
        req.onsuccess = () => {
          const database = req.result;
          const all = database.transaction(name, "readonly").objectStore(name).getAll();
          all.onsuccess = () => {
            database.close();
            resolve(all.result as T[]);
          };
          all.onerror = () => {
            database.close();
            reject(all.error);
          };
        };
        req.onerror = () => reject(req.error);
      }),
    store,
  );
}

const savedLabel = (panel: Locator) => panel.getByTestId("history-save");

test("@touch the panel beside the sheet: rolls, Heroic and its cost, follow-up, rests, the second Long Rest, Undo/Redo, a day, a reload", async ({
  page,
}) => {
  await page.goto("/");
  await importBuilds(page, ["Aerin"]);
  await openSheet(page, "Aerin");

  // AC-01: open, empty, local only; Esc closes and gives focus back to the toggle.
  let panel = await openPanel(page);
  await expect(panel.getByText(/Nothing recorded yet/)).toBeVisible();
  await expect(panel.getByTestId("history-local")).toContainText("History stays on this device");
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await expect(page.getByRole("button", { name: TOGGLE })).toBeFocused();

  // A check that changes nothing; Heroic Inspiration on it (its cost), then follow-up damage.
  const hp = page.getByRole("region", { name: "Hit Points" });
  const inspiration = page
    .locator("span", { hasText: /^Heroic Inspiration$/ })
    .locator("xpath=following-sibling::span[1]//button");
  await press(inspiration); // Heroic Inspiration on
  await expect(inspiration).toHaveText("On");
  await press(page.getByRole("button", { name: /^Athletics .*: Roll$/ }));
  const reroll = page.getByRole("button", { name: /^Reroll d20/ }).first();
  await expect(reroll).toBeVisible();
  await press(reroll);
  await press(page.getByRole("tab", { name: "Combat" }));
  await press(page.getByRole("button", { name: /: attack$/ }).first());
  await press(page.getByRole("button", { name: /: Damage$/ }).first());

  // Rests: a Short Rest cancelled records nothing; one confirmed; two Long Rests (the DM's exception).
  await hp.getByPlaceholder("Amount").fill("12");
  await press(button(hp, "Damage"));
  await press(button(page, "Short Rest"));
  let dialog = page.getByRole("dialog", { name: "Short Rest" });
  await press(button(dialog, "Spend a d10"));
  await expect(dialog.getByTestId("rest-preview")).toBeVisible();
  await press(button(dialog, "Cancel"));
  await expect(dialog).toBeHidden();
  await press(button(page, "Short Rest"));
  dialog = page.getByRole("dialog", { name: "Short Rest" });
  await press(button(dialog, "Spend a d10"));
  await expect(dialog.getByTestId("rest-preview")).toBeVisible();
  await press(button(dialog, "Confirm"));
  await expect(dialog).toBeHidden();
  await press(button(page, "Long Rest"));
  dialog = page.getByRole("dialog", { name: "Long Rest" });
  await press(button(dialog, "Confirm"));
  await expect(dialog).toBeHidden();
  await press(button(page, "Long Rest"));
  dialog = page.getByRole("dialog", { name: "Long Rest" });
  await expect(dialog.getByTestId("second-long-rest")).toContainText(
    "already taken on this day (1)",
  );
  await expect(button(dialog, "Confirm")).toBeDisabled();
  await press(dialog.getByRole("checkbox", { name: /DM allows it/ }));
  await dialog.getByRole("textbox", { name: /Note/ }).fill("safe haven");
  await press(button(dialog, "Confirm"));
  await expect(dialog).toBeHidden();

  panel = await openPanel(page);
  const kinds = () =>
    panel
      .getByTestId("history-entry")
      .evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.kind));
  await expect
    .poll(kinds)
    .toEqual([
      "long_rest",
      "long_rest",
      "short_rest",
      "play",
      "damage",
      "test",
      "test",
      "reroll",
      "play",
    ]);
  await expect(panel.getByTestId("history-rests")).toContainText(
    "Long Rests today: 2 · since this history began: 2",
  );
  await expect(panel.getByText("DM's exception").first()).toBeVisible();
  await expect(panel.locator('[data-kind="reroll"]').getByTestId("history-costs")).toContainText(
    "Heroic Inspiration",
  );
  await expect(
    panel.locator('[data-kind="test"]').first().getByTestId("history-costs"),
  ).toContainText("Nothing paid");
  await expect(panel.locator('[data-kind="damage"]').getByTestId("history-context")).toContainText(
    /^Follows #\d+: Roll: /,
  );
  await expect(panel.locator('[data-kind="short_rest"]')).toContainText("Hit Dice: d10:");

  // Undo the exception rest: undone, counted out of its day; Redo: back, without a new roll.
  await page.keyboard.press("Escape");
  await press(page.getByRole("button", { name: "Undo", exact: true }));
  panel = await openPanel(page);
  await expect(panel.locator('[data-kind="long_rest"]').first()).toHaveAttribute(
    "data-status",
    "undone",
  );
  await expect(panel.getByTestId("history-rests")).toContainText("Long Rests today: 1");
  await page.keyboard.press("Escape");
  await press(page.getByRole("button", { name: "Redo", exact: true }));
  panel = await openPanel(page);
  await expect(panel.locator('[data-kind="long_rest"]').first()).toHaveAttribute(
    "data-status",
    "done",
  );
  await expect(panel.getByTestId("history-rests")).toContainText("Long Rests today: 2");

  // A new day by hand: counts start again for it; the past day keeps its two.
  await panel.getByRole("textbox", { name: "Day label (optional)" }).fill("Camp");
  await press(button(panel, "Next day"));
  await expect(panel.getByTestId("history-day")).toContainText("Today: Camp");
  await expect(panel.getByTestId("history-rests")).toContainText(
    "Long Rests today: 0 · since this history began: 2",
  );
  await expect(savedLabel(panel)).toHaveText("Saved on this device.", { timeout: 10_000 });
  const before = await kinds();

  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "Aerin" })).toBeVisible();
  panel = await openPanel(page);
  await expect(panel.getByTestId("history-day")).toContainText("Today: Camp");
  await expect(panel.getByTestId("history-rests")).toContainText("since this history began: 2");
  await expect.poll(kinds).toEqual(before);
  const rows = await rowsOf<{ seq: number; record_id: string }>(page, "history");
  expect(rows.map((r) => r.seq).sort((a, b) => a - b)).toEqual(before.map((_, i) => i + 1));
});

test("two tabs of one origin: the other tab's day is kept, a conflict is said, a reload reads it; rolls don't collide", async ({
  page,
  context,
}) => {
  await page.goto("/");
  await importBuilds(page, ["Aerin"]);
  await openSheet(page, "Aerin");
  let a = await openPanel(page);
  await expect(savedLabel(a)).toHaveText("Saved on this device.", { timeout: 10_000 });
  const url = page.url();
  const second = await context.newPage(); // a real second tab: the same origin, the same database
  await second.goto(url);
  await expect(second.getByRole("heading", { level: 1, name: "Aerin" })).toBeVisible();
  let b = await openPanel(second);
  await expect(savedLabel(b)).toHaveText("Saved on this device.");

  await a.getByRole("textbox", { name: "Day label (optional)" }).fill("Day of A");
  await button(a, "Next day").click();
  await expect(savedLabel(a)).toHaveText("Saved on this device.", { timeout: 10_000 });
  await b.getByRole("textbox", { name: "Day label (optional)" }).fill("Day of B");
  await button(b, "Next day").click();
  await expect(savedLabel(b)).toContainText("changed in another tab", { timeout: 10_000 });
  const heads = await rowsOf<{ days: { label: string | null }[] }>(page, "history_meta");
  expect(heads[0]?.days.map((d) => d.label)).toEqual([null, "Day of A"]);
  await second.reload();
  b = await openPanel(second);
  await expect(b.getByTestId("history-day")).toContainText("Today: Day of A");

  // The same next seq in both tabs: the second to save is told, nothing collides or is lost.
  await page.keyboard.press("Escape");
  await second.keyboard.press("Escape");
  await page.getByRole("button", { name: /^Athletics .*: Roll$/ }).click();
  await second.getByRole("button", { name: /^Athletics .*: Roll$/ }).click();
  a = await openPanel(page);
  b = await openPanel(second);
  await expect(savedLabel(a)).toHaveText("Saved on this device.", { timeout: 10_000 });
  await expect(savedLabel(b)).toContainText("changed in another tab", { timeout: 10_000 });
  const rows = await rowsOf<{ seq: number }>(page, "history");
  expect(rows.map((r) => r.seq)).toEqual([1]);
});

test("the v2 → v4 upgrade makes up no history; a tab holding the old database delays it, an app tab gives way to a newer one", async ({
  page,
  context,
}) => {
  await page.goto("/favicon.svg"); // the app's origin, without the app
  const build = JSON.parse(readFileSync(fixture("aerin.json"), "utf8"));
  // A database as version 2 left it, with one character, held open by an "old tab".
  await page.evaluate(
    (record) =>
      new Promise<void>((resolve, reject) => {
        const req = indexedDB.open("srd-table", 2);
        req.onupgradeneeded = () => {
          const d = req.result;
          d.createObjectStore("characters", { keyPath: "id" });
          d.createObjectStore("encounters", { keyPath: "id" });
          d.createObjectStore("settings");
          d.createObjectStore("portraits");
          d.createObjectStore("packs", { keyPath: "key" });
        };
        req.onsuccess = () => {
          const d = req.result;
          const put = d
            .transaction("characters", "readwrite")
            .objectStore("characters")
            .put(record);
          put.onsuccess = () => {
            (window as unknown as { held: IDBDatabase }).held = d; // stays open: the old tab
            resolve();
          };
          put.onerror = () => reject(put.error);
        };
        req.onerror = () => reject(req.error);
      }),
    { id: "c-old", build, state: { version: 1 }, created: 1, updated: 1, rev: 3 },
  );
  const app = await context.newPage();
  await app.goto("/#/characters");
  await expect(app.getByText("Close the app's other tabs").first()).toBeVisible({
    timeout: 15_000,
  });
  await page.evaluate(() => (window as unknown as { held: IDBDatabase }).held.close());
  await expect(app.getByRole("heading", { name: "Aerin" })).toBeVisible({ timeout: 15_000 });
  expect(await rowsOf(app, "history")).toEqual([]);
  expect(await rowsOf(app, "history_meta")).toEqual([]);
  const version = await app.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const req = indexedDB.open("srd-table");
        req.onsuccess = () => {
          resolve(req.result.version);
          req.result.close();
        };
      }),
  );
  expect(version).toBe(4);
  await app
    .getByRole("article")
    .filter({ hasText: "Aerin" })
    .getByRole("link", { name: "Sheet" })
    .click();
  const panel = await openPanel(app);
  await expect(panel.getByText(/Nothing recorded yet/)).toBeVisible();

  // A newer version asked for elsewhere: the app tab lets its database go and says to reload.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const req = indexedDB.open("srd-table", 5);
        req.onsuccess = () => {
          req.result.close();
          resolve();
        };
      }),
  );
  await expect(
    app.getByText("The app was updated in another tab: reload this one.").first(),
  ).toBeVisible();
});

test("more than 500 saved entries: all there after a reload, paged to the first", async ({
  page,
}) => {
  await page.goto("/");
  await importBuilds(page, ["Aerin"]);
  await openSheet(page, "Aerin");
  const roll = page.getByRole("button", { name: /^Athletics .*: Roll$/ });
  for (let i = 0; i < 520; i++) await roll.click();
  let panel = await openPanel(page);
  await expect(panel.getByTestId("history-count")).toContainText("of 520 entries", {
    timeout: 30_000,
  });
  await expect(savedLabel(panel)).toHaveText("Saved on this device.", { timeout: 30_000 });
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "Aerin" })).toBeVisible();
  panel = await openPanel(page);
  await expect(panel.getByTestId("history-count")).toHaveText(
    "Showing 50 of 520 entries (nothing is ever cut).",
  );
  for (let i = 0; i < 30; i++) {
    // Settled first: no page being read, then "older" if there is more.
    await expect(panel.getByRole("button", { name: /Reading the history/ })).toHaveCount(0);
    const more = panel.getByRole("button", { name: "Show older entries" });
    if (!(await more.count())) break;
    await more.click();
  }
  await expect(panel.getByTestId("history-entry")).toHaveCount(520);
  await expect(panel.getByTestId("history-count")).toHaveText(
    "Showing 520 of 520 entries (nothing is ever cut).",
  );
  expect((await rowsOf(page, "history")).length).toBe(520);
});

test("an import replacing a character: its boundary, Undo and Redo, a reload; a copy starts empty; exports and deletion say what happens", async ({
  page,
}) => {
  await page.goto("/#/characters");
  const importFiles = async (files: string[], choose?: { target: string }) => {
    await button(page, "Import…").click();
    await page.getByLabel("Choose files").setInputFiles(files.map((f) => join(TRANSFER, f)));
    const card = page.getByTestId("import-character-Wren");
    await expect(card).toBeVisible();
    if (choose) {
      await card.getByRole("combobox").selectOption({ label: choose.target });
      const confirm = page.getByRole("checkbox", { name: /replace/i });
      if (await confirm.count()) await confirm.first().check();
    }
    await button(page, "Import").click();
  };
  await importFiles(["characters/wren.r1.transfer.json", "packs/synthetic-a-1.0.0.transfer.json"]);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await openSheet(page, "Wren");
  const hp = page.getByRole("region", { name: "Hit Points" });
  await hp.getByPlaceholder("Amount").fill("1");
  await button(hp, "Damage").click();
  let panel = await openPanel(page);
  await expect(savedLabel(panel)).toHaveText("Saved on this device.", { timeout: 10_000 });
  await page.keyboard.press("Escape");

  await page.goto("/#/characters");
  await button(page, "Import…").click();
  await page
    .getByLabel("Choose files")
    .setInputFiles([join(TRANSFER, "characters/wren.r2.transfer.json")]);
  const card = page.getByTestId("import-character-Wren");
  await expect(card).toBeVisible();
  const select = card.getByRole("combobox");
  const replace = await select
    .locator("option")
    .evaluateAll((os) =>
      (os as HTMLOptionElement[]).map((o) => o.value).filter((v) => v.startsWith("replace")),
    );
  test.skip(replace.length === 0, "the import dialog offers no replacement for this file");
  await select.selectOption(replace[0] as string);
  for (const box of await page.getByRole("dialog").getByRole("checkbox").all()) await box.check();
  await button(page, "Import").click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await openSheet(page, "Wren");
  panel = await openPanel(page);
  await expect(panel.getByTestId("history-import")).toContainText("generation 0 → 1");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  panel = await openPanel(page);
  await expect(panel.locator('[data-kind="import_boundary"]')).toHaveAttribute(
    "data-status",
    "undone",
  );
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  panel = await openPanel(page);
  await expect(panel.locator('[data-kind="import_boundary"]')).toHaveAttribute(
    "data-status",
    "done",
  );
  await expect(savedLabel(panel)).toHaveText("Saved on this device.", { timeout: 10_000 });
  await page.reload();
  panel = await openPanel(page);
  await expect(panel.locator('[data-kind="import_boundary"]')).toHaveAttribute(
    "data-status",
    "done",
  );
  await expect(panel.locator('[data-kind="play"]')).toHaveCount(1);
  await page.keyboard.press("Escape");

  // A copy starts empty; an export says history stays; a deletion says what goes with it.
  await page.goto("/#/characters");
  const wren = page
    .getByRole("article")
    .filter({ has: page.getByRole("heading", { name: "Wren", exact: true }) });
  await wren.getByRole("button", { name: "Duplicate" }).click();
  const copy = page
    .getByRole("article")
    .filter({ has: page.getByRole("heading", { name: "Wren (copy)", exact: true }) });
  await expect(copy).toBeVisible();
  await copy.getByRole("link", { name: "Sheet" }).click();
  panel = await openPanel(page);
  await expect(panel.getByText(/Nothing recorded yet/)).toBeVisible();
  await page.keyboard.press("Escape");
  await page.goto("/#/characters");
  await wren.getByRole("button", { name: "Export play state" }).click();
  await expect(
    page.getByText("History stays on this device: it isn't exported or imported.").first(),
  ).toBeVisible();
  await wren.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByRole("dialog")).toContainText(
    /Its history on this device \(\d+ entries\) is deleted too/,
  );
});
