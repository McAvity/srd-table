/**
 * kenli F-011 T05 (AC-07, AC-08) in real browsers on a production build (Chromium, WebKit; the iPad
 * project is an emulation — a physical iPad is T10): History is a column left of the game at
 * 768×1024 and 1024×768 (iPad portrait/landscape sizes) and 1440×900. Its bounds and the game's never
 * overlap, the page never scrolls sideways or past the window, the game area doesn't either; with
 * the panel open a check, a cast (cantrip and slot), an attack and its follow-up damage, a dialog
 * (Short Rest) work on the sheet, and an encounter's cast through the composer and its Add dialog;
 * closing it keeps the game where it was. Reading older entries never jumps when new ones arrive;
 * at the top the newest are followed. Screenshots (synthetic characters only) go to F011_SHOTS.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { FIXTURES } from "./global-setup";

const SHOTS = process.env.F011_SHOTS ?? "/tmp/f011-t05-shots";
const VIEWPORTS = [
  { name: "768x1024", width: 768, height: 1024 },
  { name: "1024x768", width: 1024, height: 768 },
  { name: "1440x900", width: 1440, height: 900 },
] as const;
const TOGGLE = "History: what this character played";
const button = (page: Page, name: string | RegExp) =>
  page.getByRole("button", { name, exact: typeof name === "string" });

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
async function openHistory(page: Page) {
  if (!(await page.getByTestId("history-panel").count())) await button(page, TOGGLE).click();
  const panel = page.getByRole("dialog", { name: "History" });
  await expect(panel).toBeVisible();
  return panel;
}
const count = async (page: Page) =>
  Number(/of (\d+)/.exec((await page.getByTestId("history-count").textContent()) ?? "")?.[1] ?? 0);

/** The geometry that must hold with History open: disjoint columns, nothing past the window. */
async function checkLayout(page: Page, where: string) {
  const g = await page.evaluate(() => {
    const p = document.querySelector('[data-testid="history-panel"]')?.getBoundingClientRect();
    const main = document.getElementById("main") as HTMLElement;
    const m = main.getBoundingClientRect();
    const doc = document.documentElement;
    return {
      panel: p ? { left: p.left, right: p.right, top: p.top, bottom: p.bottom } : null,
      main: { left: m.left, right: m.right, top: m.top, bottom: m.bottom },
      pageX: doc.scrollWidth - window.innerWidth,
      pageY: doc.scrollHeight - window.innerHeight,
      mainX: main.scrollWidth - main.clientWidth,
      vw: window.innerWidth,
    };
  });
  expect(g.panel, `${where}: panel`).not.toBeNull();
  const panel = g.panel as NonNullable<typeof g.panel>;
  expect(panel.right, `${where}: panel left of main`).toBeLessThanOrEqual(g.main.left + 0.5);
  expect(panel.left, `${where}: panel inside the window`).toBeGreaterThanOrEqual(0);
  expect(g.main.right, `${where}: main inside the window`).toBeLessThanOrEqual(g.vw + 0.5);
  expect(g.main.right - g.main.left, `${where}: a usable game width`).toBeGreaterThan(400);
  expect(g.pageX, `${where}: no sideways page scroll`).toBeLessThanOrEqual(0);
  expect(g.pageY, `${where}: no page scroll past the window`).toBeLessThanOrEqual(0);
  expect(g.mainX, `${where}: the game area doesn't scroll sideways`).toBeLessThanOrEqual(1);
  return g;
}
async function shot(page: Page, name: string) {
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${test.info().project.name}-${name}.png`) });
}
/** A dialog fully in the window, its buttons reachable. */
async function inWindow(page: Page, dialog: ReturnType<Page["getByRole"]>) {
  const box = await dialog.boundingBox();
  const vp = page.viewportSize() as { width: number; height: number };
  expect(box).not.toBeNull();
  const b = box as NonNullable<typeof box>;
  expect(b.x).toBeGreaterThanOrEqual(0);
  expect(b.y).toBeGreaterThanOrEqual(0);
  expect(b.x + b.width).toBeLessThanOrEqual(vp.width + 0.5);
  expect(b.y + b.height).toBeLessThanOrEqual(vp.height + 0.5);
}

for (const vp of VIEWPORTS) {
  test(`@touch sheet ${vp.name}: History beside the game; check, cast, attack + follow-up, a dialog; closing keeps the game`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await importCopy(page, "Lirael");
    await openHistory(page);
    await checkLayout(page, `${vp.name} overview`);
    await shot(page, `sheet-${vp.name}`);

    // A check from the sheet: one more entry, the panel still beside it.
    let n = await count(page);
    await page.getByRole("button", { name: /^Arcana .*: Roll$/ }).click();
    await expect.poll(() => count(page)).toBe(n + 1);

    // Casts: a cantrip at once, a level 1 spell with its slot.
    await page.getByRole("tab", { name: "Spells" }).click();
    await checkLayout(page, `${vp.name} spells`);
    for (const spell of ["Fire Bolt", "Burning Hands"]) {
      n = await count(page);
      await page
        .locator("#main li")
        .filter({ hasText: spell })
        .getByRole("button", { name: "Roll", exact: true })
        .click();
      await expect.poll(() => count(page)).toBe(n + 1);
    }
    await shot(page, `spells-${vp.name}`);

    // An attack and its follow-up damage (the Combat tab).
    await page.getByRole("tab", { name: "Combat" }).click();
    await checkLayout(page, `${vp.name} combat`);
    n = await count(page);
    await page
      .getByRole("button", { name: /: attack$/ })
      .first()
      .click();
    await page
      .getByRole("button", { name: /: Damage$/ })
      .first()
      .click();
    await expect.poll(() => count(page)).toBe(n + 2);
    await expect(
      page.locator('[data-testid="history-entry"][data-kind="damage"]').first(),
    ).toBeVisible();

    // A dialog with History open: whole in the window, its buttons work.
    await button(page, "Short Rest").click();
    const rest = page.getByRole("dialog", { name: "Short Rest" });
    await expect(rest).toBeVisible();
    await inWindow(page, rest);
    await shot(page, `dialog-${vp.name}`);
    await button(rest, "Cancel").click();
    await expect(rest).toBeHidden();

    // Closing History gives the game its width back, where it was (the Combat tab still open).
    await button(page, TOGGLE).click();
    await expect(page.getByTestId("history-panel")).toHaveCount(0);
    await expect(page.getByRole("tab", { name: "Combat" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    const full = await page.evaluate(
      () => (document.getElementById("main") as HTMLElement).getBoundingClientRect().left,
    );
    expect(full).toBe(0);
  });

  test(`encounter ${vp.name}: History beside the table; a cast through the composer and the Add dialog`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await importCopy(page, "Lirael");
    await page.getByRole("link", { name: "Table", exact: true }).click();
    await button(page, "New encounter").click();
    await button(page, "Add a character").click();
    await button(page.getByRole("dialog"), "Lirael").click();
    await page.keyboard.press("Escape");
    await openHistory(page);
    await button(page, "Add a monster").click();
    const add = page.getByRole("dialog").filter({ has: page.getByPlaceholder("Search monsters") });
    await inWindow(page, add);
    await add.getByPlaceholder("Search monsters").fill("Goblin Boss");
    await add
      .getByRole("button", { name: /^Goblin Boss/ })
      .first()
      .click();
    await button(add, "Add").click();
    await expect(add).toBeHidden();
    const rail = page.getByRole("navigation", { name: "Initiative" });
    for (const [who, value] of [
      ["Lirael", "20"],
      ["Goblin Boss", "5"],
    ] as const) {
      await rail.getByRole("button", { name: new RegExp(who) }).click();
      await page.getByRole("textbox", { name: "Initiative" }).fill(value);
      await button(page, "Set Initiative").click();
    }
    await button(page, "Start the fight").click();
    await rail.getByRole("button", { name: /Lirael/ }).click();
    await checkLayout(page, `${vp.name} encounter`);
    await page
      .getByRole("tabpanel")
      .getByRole("button", { name: /^Fire Bolt/ })
      .first()
      .click();
    const composer = page.locator("section[data-composer]");
    await composer.getByRole("button", { name: /Goblin Boss/ }).click();
    await button(composer, "Do it").click();
    await expect(page.getByRole("region", { name: "Log" })).toContainText("Lirael casts Fire Bolt");
    await expect(page.locator('[data-testid="history-entry"][data-kind="encounter"]')).toHaveCount(
      1,
    );
    await checkLayout(page, `${vp.name} encounter after the cast`);
    await shot(page, `encounter-${vp.name}`);
  });
}

test("@touch reading older entries never jumps; at the top the newest are followed", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await importCopy(page, "Aerin");
  const roll = page.getByRole("button", { name: /^Athletics .*: Roll$/ });
  for (let i = 0; i < 40; i++) await roll.click();
  await openHistory(page);
  await expect.poll(() => count(page), { timeout: 30_000 }).toBe(40);
  const box = page.getByTestId("history-scroll");
  // Down into the archive: the first entry in view and its place.
  await box.evaluate((el) => {
    el.scrollTop = 900;
  });
  await page.waitForTimeout(200);
  const anchor = () =>
    box.evaluate((el) => {
      const top = el.getBoundingClientRect().top;
      const first = [...el.querySelectorAll<HTMLElement>("[data-anchor]")].find(
        (x) => x.getBoundingClientRect().bottom > top,
      ) as HTMLElement;
      return {
        key: first.dataset.anchor as string,
        top: first.getBoundingClientRect().top - top,
        scroll: el.scrollTop,
      };
    });
  const before = await anchor();
  expect(before.scroll).toBeGreaterThan(800);
  const offsetOf = (key: string) =>
    box.evaluate((el, k) => {
      const x = [...el.querySelectorAll<HTMLElement>("[data-anchor]")].find(
        (e) => e.dataset.anchor === k,
      ) as HTMLElement;
      return x.getBoundingClientRect().top - el.getBoundingClientRect().top;
    }, key);
  for (let i = 0; i < 3; i++) await roll.click();
  await expect.poll(() => count(page)).toBe(43);
  await page.waitForTimeout(300);
  expect(Math.abs((await offsetOf(before.key)) - before.top)).toBeLessThanOrEqual(2);
  // Back to the top: the newest is followed.
  await box.evaluate((el) => {
    el.scrollTop = 0;
  });
  await page.waitForTimeout(200);
  await roll.click();
  await expect.poll(() => count(page)).toBe(44);
  await page.waitForTimeout(300);
  expect(await box.evaluate((el) => el.scrollTop)).toBeLessThanOrEqual(4);
  const firstKey = await box.evaluate(
    (el) => el.querySelector<HTMLElement>("[data-anchor]")?.dataset.anchor,
  );
  expect(firstKey).not.toBe(before.key);
  await expect(page.getByTestId("history-entry").first()).toBeInViewport();
});
