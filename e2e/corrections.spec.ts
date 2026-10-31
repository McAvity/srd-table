/**
 * kenli F-011 review03 R03-09..R03-11 in real browsers (Chromium, WebKit; iPad emulation for
 * `@touch` — not a physical iPad), synthetic characters only:
 * - R03-11: with History open at 768×1024 and 1024×768 the day's name field is a readable full row
 *   (a long name fits), its buttons below; renaming and starting a day work; nothing overflows.
 * - R03-10: the History footer says what's true now — saved here, carried by "Export character",
 *   imported as a separate character, never synced — in English and Italian.
 * - R03-09: spell rows from the engine's grant provenance — Mira's two Magic Initiates of one name
 *   apart (labels, colours, their own free casts and independent cost choices), Nell's Mage Hand
 *   from Elf and from Sage as two rows; the same rows after a reload.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { FIXTURES } from "./global-setup";

const SHOTS = process.env.F011_SHOTS ?? "/tmp/f011-r10-shots";
const button = (scope: Page | Locator, name: string | RegExp) =>
  scope.getByRole("button", { name, exact: typeof name === "string" });

async function importCopy(page: Page, name: string) {
  await page.goto("/#/characters");
  await button(page, "Import character").click();
  await page
    .getByTestId("local-copy-file")
    .setInputFiles(join(FIXTURES, `${name.toLowerCase()}.local-copy.json`));
  await expect(page.getByTestId("local-copy-preview")).toBeVisible({ timeout: 60_000 });
  await button(page, /^Create (the|another separate) copy$/).click();
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
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

for (const vp of [
  { name: "768x1024", width: 768, height: 1024 },
  { name: "1024x768", width: 1024, height: 768 },
] as const) {
  test(`@touch R03-11/R03-10 ${vp.name}: a readable day name, its buttons below; a truthful footer`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await importCopy(page, "Lirael");
    await button(page, "History: what this character played").click();
    const panel = page.getByRole("dialog", { name: "History" });
    await expect(panel).toBeVisible();
    const field = panel.getByRole("textbox", { name: "Day label (optional)" });
    const name = "Camp by the old river";
    await field.fill(name);
    const g = await page.evaluate(() => {
      const input = document.querySelector<HTMLInputElement>(
        '[data-testid="history-day-edit"] input',
      ) as HTMLInputElement;
      const p = (
        document.querySelector('[data-testid="history-panel"]') as HTMLElement
      ).getBoundingClientRect();
      const i = input.getBoundingClientRect();
      const buttons = [...document.querySelectorAll('[data-testid="history-day-edit"] button')].map(
        (b) => b.getBoundingClientRect(),
      );
      return {
        width: i.width,
        fits: input.scrollWidth <= input.clientWidth,
        inside: i.left >= p.left && i.right <= p.right + 0.5,
        buttonsBelow: buttons.every((b) => b.top >= i.bottom - 1 && b.right <= p.right + 0.5),
        pageX: document.documentElement.scrollWidth - window.innerWidth,
        pageY: document.documentElement.scrollHeight - window.innerHeight,
      };
    });
    expect(g.width).toBeGreaterThanOrEqual(200);
    expect(g.fits).toBe(true); // the whole name is readable
    expect(g.inside).toBe(true);
    expect(g.buttonsBelow).toBe(true);
    expect(g.pageX).toBeLessThanOrEqual(0);
    expect(g.pageY).toBeLessThanOrEqual(0);
    await button(panel, "Rename today").click();
    await expect(panel.getByTestId("history-day")).toContainText(`Today: ${name}`);
    await field.fill("Second dawn");
    await button(panel, "Next day").click();
    await expect(panel.getByTestId("history-day")).toContainText("Today: Second dawn");
    await expect(panel.getByTestId("history-local")).toContainText(
      "History is saved on this device and goes with the character in “Export character”",
    );
    await expect(panel).toContainText("Nothing syncs between devices");
    await expect(panel).not.toContainText("isn't exported or imported");
    await shot(page, `history-day-${vp.name}`);
  });
}

test("R03-10 in Italian: the footer names “Esporta personaggio” and says nothing syncs", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await importCopy(page, "Lirael");
  await page.goto("/#/settings");
  await button(page, "Italiano").click();
  await expect(page.getByRole("heading", { name: "Impostazioni" })).toBeVisible();
  await page.getByRole("link", { name: "Personaggi" }).click();
  await page.getByRole("button", { name: /^Cronologia/ }).click();
  const footer = page.getByTestId("history-local");
  await expect(footer).toContainText("“Esporta personaggio”");
  await expect(page.getByTestId("history-panel")).toContainText(
    "Niente si sincronizza tra dispositivi",
  );
});

test("@touch R03-09: two Magic Initiates of one name, each its own; Mage Hand from Elf and Sage; the same after a reload", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await importCopy(page, "Mira");
  await page.getByRole("tab", { name: "Spells" }).click();
  const chips = page.getByTestId("spell-source");
  await expect(chips.first()).toBeVisible();
  const lines = page.getByTestId("spell-line");
  const lineOf = (label: string) =>
    lines.filter({ has: page.getByTestId("spell-source").getByText(label, { exact: true }) });
  const human = lineOf("Magic Initiate · Human");
  const sage = lineOf("Magic Initiate · Sage");
  await expect(human.first()).toBeVisible();
  await expect(sage.first()).toBeVisible();
  const colour = (l: Locator) => l.first().evaluate((el) => getComputedStyle(el).borderLeftColor);
  expect(await colour(human)).not.toBe(await colour(sage));
  // Each one's level 1 spell offers its own free cast only; the choices are independent.
  const freeRow = (l: Locator) => l.filter({ has: page.locator('option[value^="free:"]') }).first();
  const h = freeRow(human);
  const s = freeRow(sage);
  const freeValues = (row: Locator) =>
    row
      .locator('option[value^="free:"]')
      .evaluateAll((os) => (os as HTMLOptionElement[]).map((o) => o.value));
  expect(await freeValues(h)).toEqual([
    "free:feat:magic-initiate@species:human#versatile:free-cast",
  ]);
  expect(await freeValues(s)).toEqual(["free:feat:magic-initiate@background:sage:free-cast"]);
  const sBefore = await s.locator("select").last().inputValue();
  await h
    .locator("select")
    .last()
    .selectOption("free:feat:magic-initiate@species:human#versatile:free-cast");
  expect(await s.locator("select").last().inputValue()).toBe(sBefore);
  await button(h, "Roll").click();
  // Only the Human one's free use is spent: its option now says why not, the Sage one's is left.
  const option = (row: Locator) => row.locator('option[value^="free:"]');
  await expect.poll(() => option(h).textContent()).not.toContain("1 of 1 left");
  expect(await option(s).textContent()).toContain("1 of 1 left");
  await shot(page, "mira-spells-1024x768");
  const keys = await lines.evaluateAll((els) =>
    els.map((e) => (e as HTMLElement).dataset.spellKey),
  );
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "Mira" })).toBeVisible();
  await page.getByRole("tab", { name: "Spells" }).click();
  await expect(lines.first()).toBeVisible();
  expect(
    await lines.evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.spellKey)),
  ).toEqual(keys);

  await importCopy(page, "Nell");
  await page.getByRole("tab", { name: "Spells" }).click();
  const hand = lines.filter({ has: page.getByRole("button", { name: "Mage Hand", exact: true }) });
  await expect(hand).toHaveCount(2);
  expect(await hand.getByTestId("spell-source").allTextContents()).toEqual(["Elf", "Sage"]);
  expect(await colour(hand.nth(0))).not.toBe(await colour(hand.nth(1)));
  // One description at a time across both rows.
  await hand.nth(1).getByRole("button", { name: "Mage Hand", exact: true }).click();
  await hand.nth(0).getByRole("button", { name: "Mage Hand", exact: true }).click();
  await expect(page.locator('[data-testid="spell-line"] button[aria-expanded="true"]')).toHaveCount(
    1,
  );
  await shot(page, "nell-spells-1024x768");
});
