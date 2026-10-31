/**
 * kenli F-011 T06 in real browsers (Chromium, WebKit; iPad emulation for `@touch` — no physical
 * iPad) with History open, at 768×1024 and 1024×768: every spell's controls (the long cast-with and
 * cost selectors, Roll) sit in its header beside the name and inside the line, its metadata on a
 * full row below, nothing pushes the game sideways; one description open in the whole tab, from
 * the name by tap/click and keyboard, apart from the selectors; a use's (i) read without spending;
 * Features always shown; a custom item added (unknown weight said, not 0). Synthetic characters only.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { FIXTURES } from "./global-setup";

const SHOTS = process.env.F011_SHOTS ?? "/tmp/f011-t06-shots";
const button = (page: Page, name: string | RegExp) =>
  page.getByRole("button", { name, exact: typeof name === "string" });

async function lirael(page: Page) {
  await page.goto("/#/characters");
  await button(page, "Import character").click();
  await page.getByTestId("local-copy-file").setInputFiles(join(FIXTURES, "lirael.local-copy.json"));
  await expect(page.getByTestId("local-copy-preview")).toBeVisible({ timeout: 60_000 });
  await button(page, /^Create (the|another separate) copy$/).click();
  await expect(page.getByRole("heading", { level: 1, name: "Lirael" })).toBeVisible();
  await button(page, "History: what this character played").click();
  await expect(page.getByTestId("history-panel")).toBeVisible();
}
async function shot(page: Page, name: string) {
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({
    path: join(SHOTS, `${test.info().project.name}-${name}.jpg`),
    type: "jpeg",
    quality: 75,
    scale: "css",
  });
}
async function noSideways(page: Page, where: string) {
  const g = await page.evaluate(() => {
    const main = document.getElementById("main") as HTMLElement;
    return {
      page: document.documentElement.scrollWidth - window.innerWidth,
      main: main.scrollWidth - main.clientWidth,
    };
  });
  expect(g.page, `${where}: page`).toBeLessThanOrEqual(0);
  expect(g.main, `${where}: game area`).toBeLessThanOrEqual(1);
}

for (const vp of [
  { name: "768x1024", width: 768, height: 1024 },
  { name: "1024x768", width: 1024, height: 768 },
] as const) {
  test(`@touch spells ${vp.name} with History: controls in the header, metadata on its own row, one description at a time`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await lirael(page);
    await page.getByRole("tab", { name: "Spells" }).click();
    const lines = page.getByTestId("spell-line");
    await expect(lines.first()).toBeVisible();
    await noSideways(page, `${vp.name} spells`);
    const geometry = await lines.evaluateAll((els) =>
      els.map((li) => {
        const line = li.getBoundingClientRect();
        const name = (
          li.querySelector("button[aria-expanded]") as HTMLElement
        ).getBoundingClientRect();
        const controls = (
          li.querySelector('[data-testid="spell-controls"]') as HTMLElement
        ).getBoundingClientRect();
        const meta = (
          li.querySelector('[data-testid="spell-meta"]') as HTMLElement
        ).getBoundingClientRect();
        const selects = [...li.querySelectorAll("select")].map(
          (s) => s.getBoundingClientRect().right,
        );
        return { line, name, controls, meta, selects };
      }),
    );
    for (const g of geometry) {
      expect(g.controls.right).toBeLessThanOrEqual(g.line.right + 0.5); // nothing past its line
      for (const r of g.selects) expect(r).toBeLessThanOrEqual(g.line.right + 0.5);
      expect(g.meta.top).toBeGreaterThanOrEqual(g.name.bottom - 1); // metadata below the header
      expect(g.meta.width).toBeGreaterThan((g.line.width - 24) * 0.6); // a full row, not a column
    }
    // The longest selector (the cost with its reasons) is in a header beside a name.
    const withSelect = lines.filter({ has: page.locator("select") }).first();
    await expect(withSelect.getByTestId("spell-controls").locator("select").first()).toBeVisible();
    await withSelect.scrollIntoViewIfNeeded();
    await shot(page, `spells-${vp.name}`);

    // One description open in the whole tab: tap/click one, then another (another level group).
    const names = page.locator('[data-testid="spell-line"] button[aria-expanded]');
    const open = () => page.locator('[data-testid="spell-line"] button[aria-expanded="true"]');
    if (test.info().project.use.hasTouch) await names.first().tap();
    else await names.first().click();
    await expect(open()).toHaveCount(1);
    await names.last().click();
    await expect(open()).toHaveCount(1);
    await expect(names.last()).toHaveAttribute("aria-expanded", "true");
    // Keyboard: focus a name and Enter; Space closes it.
    await names.nth(1).focus();
    await page.keyboard.press("Enter");
    await expect(names.nth(1)).toHaveAttribute("aria-expanded", "true");
    await expect(open()).toHaveCount(1);
    await page.keyboard.press(" ");
    await expect(open()).toHaveCount(0);
    // A selector changed doesn't open or close anything.
    const select = withSelect.locator("select").last();
    const options = await select
      .locator("option")
      .evaluateAll((os) => (os as HTMLOptionElement[]).map((o) => o.value));
    await select.selectOption(options.at(-1) as string);
    await expect(open()).toHaveCount(0);
    await noSideways(page, `${vp.name} spells after opening`);
  });
}

test("@touch a use's (i) read without spending; Features always shown; a custom item with unknown weight", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await lirael(page);
  await page.getByRole("tab", { name: "Combat" }).click();
  const info = button(page, "About Arcane Recovery");
  await info.click();
  await expect(page.getByTestId("use-info")).toContainText("1 uses. All come back on a Long Rest.");
  await expect(page.getByRole("img", { name: "Arcane Recovery: 1 of 1 left" })).toBeVisible();
  await shot(page, "use-info-1024x768");
  await page.getByRole("tab", { name: "Features" }).click();
  await expect(page.getByTestId("feature-block").first()).toBeVisible();
  expect(await page.getByRole("tabpanel").locator("details, summary").count()).toBe(0);
  await page.getByRole("tab", { name: "Inventory" }).click();
  await button(page, "Add a custom item").click();
  const dialog = page.getByRole("dialog", { name: "A custom item (not in the catalog)" });
  await dialog.getByRole("textbox", { name: "Name" }).fill("Sealed letter");
  await dialog.getByRole("textbox", { name: /Description/ }).fill("For the abbess.");
  await button(dialog, "Add it").click();
  await expect(dialog).toBeHidden();
  const item = page.locator("#main li").filter({ hasText: "Sealed letter" });
  await expect(item).toContainText("weight unknown");
  await expect(item.getByTestId("custom-description")).toHaveText("For the abbess.");
  await expect(page.getByTestId("weight-incomplete")).toBeVisible();
  await expect(page.getByTestId("history-entry").first()).toBeVisible();
  await shot(page, "custom-item-1024x768");
});
