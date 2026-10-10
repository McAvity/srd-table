/**
 * End-to-end flows on the production build: a character through every builder step, level-ups
 * with a subclass, play (damage and rests), an encounter with a decision to ask, and a reload
 * that restores everything from IndexedDB.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";

const FIXTURES = join(import.meta.dirname, "..", "..", "test-results", "e2e-fixtures");
const fixture = (name: string) => join(FIXTURES, name);

const button = (page: Page | Locator, name: string | RegExp) =>
  page.getByRole("button", { name, exact: typeof name === "string" });

/** Answer every open choice on screen with the first options the engine allows. */
async function fillOpenChoices(page: Page) {
  // Let the engine's view of the last pick arrive (its new choices appear with it).
  await page.waitForTimeout(600);
  for (let round = 0; round < 80; round++) {
    const cards = await page
      .locator("main section[aria-label]")
      .filter({ hasText: /\d+ of \d+ chosen/ })
      .all();
    let acted = false;
    for (const card of cards) {
      const header = (await card.locator("header").innerText()).replace(/\s+/g, " ");
      const m = header.match(/(\d+) of (\d+) chosen/);
      if (!m || Number(m[1]) >= Number(m[2])) continue;
      const add = card.getByRole("button", { name: /^Add: / });
      const option = (await add.count())
        ? add.first()
        : card.locator('button[aria-pressed="false"]:not([aria-disabled="true"])').first();
      if (!(await option.count())) continue;
      await option.click();
      await page.waitForTimeout(250);
      acted = true;
      break;
    }
    if (!acted) return;
  }
}

async function nextStep(page: Page, title: string) {
  await page
    .getByRole("navigation", { name: "Steps" })
    .getByRole("button", { name: new RegExp(title) })
    .click();
  await expect(page.getByRole("heading", { level: 2, name: title })).toBeVisible();
}

test("a level 1 character through every builder step, then levels 2 and 3 with a subclass", async ({
  page,
}) => {
  await page.goto("/");
  await button(page, "New character").click();

  await page.getByRole("button", { name: /^Fighter/ }).click();
  await nextStep(page, "Species");
  await page.getByRole("button", { name: /^Human/ }).click();
  await fillOpenChoices(page);
  await nextStep(page, "Background");
  await page.getByRole("button", { name: /^Soldier/ }).click();

  await nextStep(page, "Ability Scores");
  await button(page, "Standard array").click();
  const scores = {
    Strength: "15",
    Dexterity: "14",
    Constitution: "13",
    Intelligence: "8",
    Wisdom: "10",
    Charisma: "12",
  };
  for (const [ability, value] of Object.entries(scores)) {
    await page.getByLabel(`${ability}: Base`).selectOption(value);
    await expect(page.getByLabel(`${ability}: Base`)).toHaveValue(value);
  }
  await page.getByLabel("Strength: Background ability bonuses").selectOption("2");
  await page.getByLabel("Constitution: Background ability bonuses").selectOption("1");
  await button(page, "Apply bonuses").click();
  await expect(
    page.getByRole("region", { name: "Summary" }).getByRole("button", { name: /^HP 12 = / }),
  ).toBeVisible();

  for (const step of [
    "Equipment",
    "Class & Feat Features",
    "Spells",
    "Skills & Tools",
    "Languages",
  ]) {
    await nextStep(page, step);
    await fillOpenChoices(page);
  }
  await nextStep(page, "Name & Alignment");
  await page.getByRole("textbox", { name: "Name" }).fill("Brakka");
  await page.getByRole("textbox", { name: "Name" }).press("Enter");
  await page.getByRole("combobox", { name: "Alignment" }).selectOption("NG");

  // Every step is complete: nothing is left to do.
  const steps = page.getByRole("navigation", { name: "Steps" });
  await expect(steps.getByText("Still to do")).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Brakka");

  for (const level of [2, 3]) {
    await button(page, "Level up").click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: /^Fighter/ }).click();
    await dialog.getByRole("button", { name: /^Fixed/ }).click();
    await expect(
      page
        .getByRole("navigation", { name: "Levels" })
        .getByRole("button", { name: new RegExp(`^${level}\\b`) }),
    ).toBeVisible();
    await fillOpenChoices(page);
  }
  await expect(page.getByText(/Fighter 3 \(Champion\)/)).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "Levels" }).getByText("Still to do"),
  ).toHaveCount(0);
});

test("play: damage, a Short Rest with Hit Point Dice, a Long Rest", async ({ page }) => {
  await page.goto("/");
  await page.locator('input[type="file"]').setInputFiles(fixture("aerin.json"));
  await page
    .getByRole("article")
    .filter({ hasText: "Aerin" })
    .getByRole("link", { name: "Sheet" })
    .click();

  const hp = page.getByRole("region", { name: "Hit Points" });
  await expect(hp).toContainText("28");
  await hp.getByPlaceholder("Amount").fill("12");
  await button(hp, "Damage").click();
  await expect(hp.getByText("16", { exact: true })).toBeVisible();

  await button(page, "Short Rest").click();
  const rest = page.getByRole("dialog");
  await button(rest, "Spend a d10").click();
  await button(rest, "Confirm").click();
  await expect(rest).toBeHidden();
  await expect(hp.getByText("16", { exact: true })).toBeHidden();

  await button(page, "Long Rest").click();
  await button(page.getByRole("dialog"), "Confirm").click();
  await expect(hp.locator("span.font-display").first()).toHaveText("28");
});

test("an encounter where a decision after a roll is asked, then answered", async ({ page }) => {
  const seed = JSON.parse(readFileSync(fixture("decision-seed.json"), "utf8")) as number;
  await page.goto("/#/settings");
  await page.getByLabel("Fixed dice seed").fill(String(seed));
  await page
    .getByRole("region", { name: "Development" })
    .getByRole("button", { name: "Apply" })
    .click();

  await page.getByRole("link", { name: "Table", exact: true }).click();
  await button(page, "New encounter").click();
  for (const monster of ["Adult Red Dragon", "Adult Blue Dragon"]) {
    await button(page, "Add a monster").click();
    const dialog = page.getByRole("dialog");
    await dialog.getByPlaceholder("Search monsters").fill(monster);
    await dialog.getByRole("button", { name: new RegExp(`^${monster}`) }).click();
    await button(dialog, "Add").click();
    await expect(dialog).toBeHidden();
  }
  const rail = page.getByRole("navigation", { name: "Initiative" });
  for (const [name, value] of [
    ["Adult Red Dragon", "20"],
    ["Adult Blue Dragon", "5"],
  ] as const) {
    await rail.getByRole("button", { name: new RegExp(name) }).click();
    await page.getByRole("textbox", { name: "Initiative" }).fill(value);
    await button(page, "Set Initiative").click();
  }
  await button(page, "Start the fight").click();
  await expect(page.getByRole("region", { name: "Log" })).toContainText("Adult Red Dragon's turn");

  await page
    .getByRole("tabpanel")
    .getByRole("button", { name: /^Fire Breath/ })
    .click();
  const composer = page.locator("section[data-composer]");
  await composer.getByRole("button", { name: /Adult Blue Dragon/ }).click();
  await button(composer, "Do it").click();

  const decision = page.getByRole("dialog");
  await expect(decision).toContainText("Adult Blue Dragon");
  await button(decision, /Yes, use it/).click();
  await expect(decision).toBeHidden();
  await expect(page.getByRole("region", { name: "Log" })).toContainText(/Legendary Resistance/);
});

test("a reload restores characters, play states and encounters from IndexedDB", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .locator('input[type="file"]')
    .setInputFiles([fixture("aerin.json"), fixture("lirael.json")]);
  await page
    .getByRole("article")
    .filter({ hasText: "Aerin" })
    .getByRole("link", { name: "Sheet" })
    .click();
  const hp = page.getByRole("region", { name: "Hit Points" });
  await hp.getByPlaceholder("Amount").fill("5");
  await button(hp, "Damage").click();
  await expect(hp.getByText("23", { exact: true })).toBeVisible();

  await page.getByRole("link", { name: "Table", exact: true }).click();
  await button(page, "New encounter").click();
  await button(page, "Add a character").click();
  await button(page.getByRole("dialog"), "Lirael").click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("navigation", { name: "Initiative" })).toContainText("Lirael");
  await page.waitForTimeout(600); // the autosave's debounce

  await page.reload();
  await expect(page.getByRole("navigation", { name: "Initiative" })).toContainText("Lirael");
  // Characters opens the character opened last (remembered across the reload), then its list.
  await page.getByRole("link", { name: "Characters", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "Hit Points" }).getByText("23", { exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "All characters" }).click();
  await expect(page.getByRole("article").filter({ hasText: "Aerin" })).toContainText("23 / 28");
  await expect(page.getByRole("article")).toHaveCount(2);
});

test("the app and the engine speak Italian, chosen in Settings", async ({ page }) => {
  await page.goto("/#/settings");
  await button(page, "Italiano").click();
  await expect(page.getByRole("heading", { name: "Impostazioni" })).toBeVisible();

  // The engine's names and reasons come from the worker, in Italian.
  await page.getByRole("link", { name: "Personaggi" }).click();
  await button(page, "Nuovo personaggio").click();
  await page.getByRole("button", { name: /^Fighter/ }).click();
  const steps = page.getByRole("navigation", { name: "Passi" });
  await expect(steps.getByRole("button", { name: /Punteggi di caratteristica/ })).toBeVisible();
  await steps.getByRole("button", { name: /Background/ }).click();
  await page.getByRole("button", { name: /^Soldier/ }).click();
  await steps.getByRole("button", { name: /Abilità e strumenti/ }).click();
  await expect(page.getByText("hai già competenza da Soldier").first()).toBeVisible();

  // Back to English for the other flows' browser state.
  await page.goto("/#/settings");
  await button(page, "English").click();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
});
