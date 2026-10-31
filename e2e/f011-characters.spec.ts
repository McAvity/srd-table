/**
 * kenli F-011 T08: the four T07 characters built in a real browser, through the app's own controls
 * only — each in a fresh browser context (an empty profile): for Kenli7, its rules pack first through
 * Settings → "Import pack…" (rules content, not a character); then "New character", every level 1
 * pick, and six "Level up"s with their picks, a reload after level 4, and for Kenli7 its R1
 * equipment on the sheet (Inventory: add, wear, coins). The picks come from the T07 click plan
 * (`F011_PLAN`, docs/…/evidence/characters/ui-plan.json); nothing here imports a build, writes
 * IndexedDB or calls the engine.
 *
 * Read-only observation for the comparison (tools/f011/characters/compare.ts): after every stage the
 * stored record is read from IndexedDB into `F011_T08_OUT/<id>/stage-<n>.json`; at the end the app's
 * own "Export character" file is saved as `<id>.local-copy.json`. Screenshots per stage when
 * `F011_SHOTS` is set. Run against a production build (playwright.config.ts staging mode).
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";

const PLAN_FILE = process.env.F011_PLAN ?? "";
const OUT = process.env.F011_T08_OUT ?? "/tmp/f011-t08-out";
const SHOTS = process.env.F011_SHOTS;
const KENLI_PACK = process.env.F011_KENLI_PACK ?? "";
const ONLY = (process.env.F011_CHARACTERS ?? "").split(",").filter(Boolean);

interface Choice {
  kind: "choice";
  key: string;
  label: string;
  level: number;
  step: string;
  step_title: string;
  mode: "single" | "multi" | "repeat" | "replace";
  names: string[];
  ids: string[];
  old?: string;
}
type Action =
  | { kind: "entity"; step: string; step_title: string; name: string; id: string }
  | { kind: "point_buy"; scores: Record<string, number>; abilities: Record<string, string> }
  | { kind: "background_bonus"; bonus: Record<string, number>; abilities: Record<string, string> }
  | { kind: "name"; name: string }
  | { kind: "alignment"; alignment: string; label: string }
  | { kind: "level_up"; class_id: string; class_name: string; level: number }
  | Choice;
interface Plan {
  characters: {
    id: string;
    name: string;
    context: "srd" | "kenli-0.5";
    stages: { label: string; actions: Action[] }[];
    play: {
      source: string;
      steps: { type: string; item?: string; changes?: Record<string, number> }[];
    };
  }[];
}

test.use({ actionTimeout: 30_000, navigationTimeout: 60_000 });

const plan: Plan = PLAN_FILE ? JSON.parse(readFileSync(PLAN_FILE, "utf8")) : { characters: [] };
const button = (scope: Page | Locator, name: string | RegExp) =>
  scope.getByRole("button", { name, exact: typeof name === "string" });
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Wait for the app to settle: no busy card, no spinner, the worker's last answer in. */
async function settle(page: Page) {
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0, { timeout: 30_000 });
  await page.waitForTimeout(150);
}

/**
 * After a pick: the builder may ask first (a change at a past level that leaves picks open shows
 * "Before you change this"); confirm it only when nothing is removed. Then wait until it settles.
 */
async function afterPick(page: Page, asked?: (text: string) => void) {
  const dialog = page.getByRole("dialog", { name: "Before you change this" });
  for (let i = 0; i < 150; i++) {
    if (await dialog.isVisible().catch(() => false)) {
      const text = (await dialog.innerText()).replace(/\s+/g, " ");
      await expect(dialog).not.toContainText("will be removed");
      asked?.(text);
      await button(dialog, "Apply").click();
      await expect(dialog).toBeHidden();
    }
    if ((await page.locator('[aria-busy="true"]').count()) === 0) {
      await page.waitForTimeout(150);
      if (
        !(await dialog.isVisible().catch(() => false)) &&
        (await page.locator('[aria-busy="true"]').count()) === 0
      )
        return;
    }
    await page.waitForTimeout(200);
  }
  throw new Error("the builder didn't settle after a pick");
}

async function openLevel1Step(page: Page, title: string) {
  const levels = page.getByRole("navigation", { name: "Levels" });
  const creation = button(levels, "Character creation");
  if ((await creation.getAttribute("data-on")) !== "true") await creation.click();
  await page
    .getByRole("navigation", { name: "Steps" })
    .getByRole("button", { name: new RegExp(`^(\\d+\\s*)?${esc(title)}( Still to do)?$`) })
    .click();
  await expect(page.getByRole("heading", { level: 2, name: title, exact: true })).toBeVisible();
}

async function openLevel(page: Page, level: number) {
  await page
    .getByRole("navigation", { name: "Levels" })
    .getByRole("button", { name: new RegExp(`^${level}(\\s|$)`) })
    .click();
  await expect(
    page.getByRole("heading", { name: `Level ${level}`, exact: true }).first(),
  ).toBeVisible();
}

function card(page: Page, label: string): Locator {
  return page.locator("main").locator(`section[aria-label="${label.replace(/"/g, '\\"')}"]`);
}

/** The option button whose own name (not its detail line) is exactly `name`. */
function optionIn(scope: Locator, page: Page, name: string): Locator {
  return scope
    .locator("button[aria-pressed]")
    .filter({ has: page.getByText(name, { exact: true }) });
}

async function pickChoice(page: Page, c: Choice, asked?: (text: string) => void) {
  if (c.level === 1) await openLevel1Step(page, c.step_title);
  else await openLevel(page, c.level);
  const box = card(page, c.label);
  await expect(box).toHaveCount(1);
  if (c.mode === "repeat") {
    const counts = new Map<string, number>();
    for (const n of c.names) counts.set(n, (counts.get(n) ?? 0) + 1);
    for (const [name, n] of counts) {
      for (let i = 0; i < n; i++) {
        await button(box, `Add: ${name}`).click();
        await afterPick(page, asked);
      }
      await expect(box.getByLabel(`${name}: +${n}`, { exact: true })).toBeVisible();
    }
    return;
  }
  if (c.mode === "replace") {
    // The card's two selects: "Replace" (the old pick) and "with" (the new one).
    const [oldPick, newPick] = [box.locator("select").nth(0), box.locator("select").nth(1)];
    await expect(box.locator("label").nth(0)).toContainText("Replace");
    await expect(box.locator("label").nth(1)).toContainText("with");
    await oldPick.selectOption({ label: c.old as string });
    await newPick.selectOption({ label: c.names[0] as string });
    await button(box, "Apply").click();
    await afterPick(page, asked);
    return;
  }
  const search = box.getByRole("searchbox");
  for (const name of c.names) {
    if (await search.count()) await search.fill(name);
    const option = optionIn(box, page, name);
    await expect(option).toHaveCount(1);
    if ((await option.getAttribute("aria-pressed")) !== "true") {
      await option.click();
      await afterPick(page, asked);
    }
    await expect(optionIn(box, page, name)).toHaveAttribute("aria-pressed", "true");
  }
  if (await search.count()) await search.fill("");
  await expect(box.locator("header")).toContainText(`${c.names.length} of`);
}

async function pointBuy(page: Page, a: Extract<Action, { kind: "point_buy" }>) {
  await openLevel1Step(page, "Ability Scores");
  await button(page, "Point buy").click();
  await settle(page);
  for (const [ability, target] of Object.entries(a.scores)) {
    const label = `${a.abilities[ability]}: Base`;
    for (let i = 0; i < 10; i++) {
      const out = page.locator(`output[aria-label^="${label} "]`);
      const now = Number(await out.textContent());
      if (now === target) break;
      await button(page, `${label} ${now < target ? "+1" : "−1"}`).click();
      await settle(page);
    }
    await expect(page.locator(`output[aria-label="${label} ${target}"]`)).toBeVisible();
  }
}

async function backgroundBonus(page: Page, a: Extract<Action, { kind: "background_bonus" }>) {
  await openLevel1Step(page, "Ability Scores");
  for (const [ability, value] of Object.entries(a.bonus))
    await page
      .getByLabel(`${a.abilities[ability]}: Background ability bonuses`)
      .selectOption(String(value));
  await button(page, "Apply bonuses").click();
  await settle(page);
}

/** The stored record, read only (the autosave is debounced: read until two reads agree). */
async function stored(page: Page, id: string): Promise<unknown> {
  let last = "";
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(400);
    const now = await page.evaluate(
      (key) =>
        new Promise<string>((resolve, reject) => {
          const open = indexedDB.open("srd-table");
          open.onerror = () => reject(open.error);
          open.onsuccess = () => {
            const tx = open.result.transaction("characters", "readonly");
            const get = tx.objectStore("characters").get(key);
            get.onsuccess = () => {
              resolve(JSON.stringify(get.result ?? null));
              open.result.close();
            };
            get.onerror = () => reject(get.error);
          };
        }),
      id,
    );
    if (now === last && now !== "null") return JSON.parse(now);
    last = now;
  }
  throw new Error(`no stable stored record for ${id}`);
}

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({
    path: join(SHOTS, `${test.info().project.name}-${name}.jpg`),
    type: "jpeg",
    quality: 70,
    fullPage: true,
  });
}

/** Nothing still to do in the builder: no step, no level marked missing. */
async function expectComplete(page: Page) {
  const levels = page.getByRole("navigation", { name: "Levels" });
  await button(levels, "Character creation").click();
  await expect(
    page.getByRole("navigation", { name: "Steps" }).getByText("Still to do"),
  ).toHaveCount(0);
  await expect(levels.getByText("Still to do")).toHaveCount(0);
}

for (const character of plan.characters.filter((c) => !ONLY.length || ONLY.includes(c.id))) {
  test(`T08 ${character.name}: New character, level 1 and six Level ups, real controls`, async ({
    page,
  }, info) => {
    test.setTimeout(30 * 60_000);
    const dir = join(OUT, info.project.name, character.id);
    mkdirSync(dir, { recursive: true });
    const log: string[] = [];
    const note = (s: string) => {
      log.push(`${new Date().toISOString()} ${s}`);
      writeFileSync(join(dir, "steps.log"), `${log.join("\n")}\n`);
    };

    // Preparation: Kenli7's rules pack through Settings → Import pack… (not a character).
    if (character.context === "kenli-0.5") {
      await page.goto("/#/settings");
      await button(page, "Import pack…").click();
      const dialog = page.getByRole("dialog");
      await dialog.getByLabel("Choose files").setInputFiles(KENLI_PACK);
      await expect(dialog.getByTestId("import-plan")).toBeVisible({ timeout: 60_000 });
      await button(dialog, "Import").click();
      await expect(page.getByText(/Imported: 0 characters, 0 encounters, 1 packs\./)).toBeVisible({
        timeout: 60_000,
      });
      await page.keyboard.press("Escape");
      await expect(page.getByRole("region", { name: "Packs on this device" })).toContainText(
        "kenli-pack 0.5.0",
      );
      note("settings: imported kenli-pack 0.5.0 through Import pack…");
      await shot(page, `${character.id}-0-pack`);
    }

    await page.goto("/#/characters");
    await button(page, "New character").click();
    if (character.context === "kenli-0.5") {
      const dialog = page.getByRole("dialog", { name: "New character: content" });
      await expect(dialog).toBeVisible();
      await dialog
        .getByRole("button", { name: /^kenli-pack 0\.5\.0 and the packs it needs/ })
        .click();
      note("new character: content kenli-pack 0.5.0 and the packs it needs");
    }
    await expect(page).toHaveURL(/#\/characters\/c-[^/]+\/build/);
    const id = /characters\/(c-[^/?]+)\/build/.exec(page.url())?.[1] as string;
    note(`new character ${id}`);

    for (const [index, stage] of character.stages.entries()) {
      const n = index + 1;
      note(`stage ${n}: ${stage.label}`);
      const deferred: Action[] = [];
      for (const action of stage.actions) {
        switch (action.kind) {
          case "entity":
            await openLevel1Step(page, action.step_title);
            await page
              .locator("main")
              .getByRole("button", { name: new RegExp(`^${esc(action.name)}(\\s|$)`) })
              .first()
              .click();
            await settle(page);
            await expect(
              page
                .locator("main")
                .getByRole("button", { name: new RegExp(`^${esc(action.name)}(\\s|$)`) })
                .first(),
            ).toHaveAttribute("aria-pressed", "true");
            note(`  ${action.step_title}: ${action.name}`);
            break;
          case "point_buy":
            await pointBuy(page, action);
            note(`  point buy ${JSON.stringify(action.scores)}`);
            break;
          case "background_bonus":
            await backgroundBonus(page, action);
            note(`  background bonus ${JSON.stringify(action.bonus)}`);
            break;
          case "name":
          case "alignment":
            deferred.push(action); // Name & Alignment: the builder's last step
            break;
          case "level_up": {
            await button(page.getByRole("navigation", { name: "Levels" }), "Level up").click();
            const dialog = page.getByRole("dialog", { name: "Level up" });
            await dialog
              .getByRole("button", { name: new RegExp(`^${esc(action.class_name)}\\b`) })
              .click();
            await button(dialog, /^Fixed \(/).click();
            await expect(dialog).toBeHidden();
            await expect(
              page
                .getByRole("navigation", { name: "Levels" })
                .getByRole("button", { name: new RegExp(`^${action.level}(\\s|$)`) }),
            ).toBeVisible();
            await settle(page);
            note(`  Level up: ${action.class_name}, fixed HP → level ${action.level}`);
            break;
          }
          case "choice":
            await pickChoice(page, action, (text) =>
              note(`  (the builder asked: ${text.slice(0, 300)} → Apply)`),
            );
            note(
              `  ${action.level === 1 ? `Character creation › ${action.step_title}` : `Level ${action.level}`} › ${action.label}: ${
                action.mode === "replace"
                  ? `replace ${action.old} with ${action.names[0]}`
                  : action.names.join(", ")
              }`,
            );
            break;
        }
      }
      for (const action of deferred) {
        await openLevel1Step(page, "Name & Alignment");
        if (action.kind === "name") {
          const field = page.getByRole("textbox", { name: "Name" });
          await field.fill(action.name);
          await field.press("Enter");
          await settle(page);
          note(`  Name: ${action.name}`);
        } else if (action.kind === "alignment") {
          await page.getByRole("combobox", { name: "Alignment" }).selectOption(action.alignment);
          await settle(page);
          note(`  Alignment: ${action.label}`);
        }
      }
      await expectComplete(page);
      const record = await stored(page, id);
      writeFileSync(join(dir, `stage-${n}.json`), `${JSON.stringify(record, null, 2)}\n`);
      const summary = await page.getByRole("region", { name: "Summary" }).innerText();
      writeFileSync(join(dir, `stage-${n}.summary.txt`), `${summary}\n`);
      note(`  checkpoint ${n}: nothing still to do; stored record saved`);
      await shot(page, `${character.id}-${n}`);
      if (n === 4) {
        await page.reload();
        await expect(page.getByRole("heading", { level: 1 })).toContainText(character.name);
        await expectComplete(page);
        note("  reload after level 4: the builder reopened complete");
      }
    }

    // After level 7, in play (the sheet's Inventory tab). The state was made with the empty new
    // build, so the starting equipment is taken there ("Take starting equipment", the app's own
    // control); then the spec's play steps: Kenli7's R1 equipment (Inventory: add, wear; Coins).
    await page.goto(`/#/characters/${id}/sheet?tab=inventory`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(character.name);
    const kit = page.locator(`section[aria-label="Starting equipment"]`);
    await expect(kit).toBeVisible();
    writeFileSync(
      join(dir, "before-take.json"),
      `${JSON.stringify(await stored(page, id), null, 2)}\n`,
    );
    note(
      `sheet › Inventory: “Your starting equipment isn't in the inventory yet”: ${(await kit.innerText()).replace(/\s+/g, " ")}`,
    );
    await button(kit, "Take starting equipment").click();
    await expect(kit).toBeHidden();
    await settle(page);
    note("sheet › Inventory: Take starting equipment");
    writeFileSync(
      join(dir, "after-take.json"),
      `${JSON.stringify(await stored(page, id), null, 2)}\n`,
    );
    for (const step of character.play.steps) {
      if (step.type === "add_item") {
        await button(page, "Add an item").click();
        const dialog = page.getByRole("dialog", { name: "Add an item" });
        await dialog.getByPlaceholder("Search items").fill("Studded Leather");
        await dialog
          .getByRole("button", { name: /^Studded Leather Armor/ })
          .first()
          .click();
        await button(dialog, "Add").click();
        await expect(dialog).toBeHidden();
        note("sheet › Inventory › Add an item: Studded Leather Armor, Add");
      } else if (step.type === "equip") {
        const row = page.locator("main li").filter({ hasText: "Studded Leather Armor" }).first();
        await button(row, "Equip").click();
        await expect(button(row, "Unequip")).toBeVisible();
        note("sheet › Inventory › Studded Leather Armor: Equip");
      } else if (step.type === "adjust_currency") {
        const coins = page.getByRole("region", { name: "Coins" });
        const gp = String(step.changes?.gp ?? 0);
        await coins.getByRole("textbox", { name: "Amount" }).fill(gp);
        await coins.getByRole("combobox", { name: "Coins" }).selectOption("gp");
        await button(coins, "Add").click();
        await settle(page);
        note(`sheet › Inventory › Coins: ${gp} gp, Add`);
      }
    }
    await shot(page, `${character.id}-inventory`);
    writeFileSync(join(dir, "final.json"), `${JSON.stringify(await stored(page, id), null, 2)}\n`);

    // A character on the campaign's packs is exported with their exact refs: they are prepared
    // first (Settings → Offline play → this character → Prepare offline), as the export asks.
    if (character.context === "srd") {
      await page.goto("/#/settings");
      await page.getByTestId("offline-target").selectOption({ label: character.name });
      await button(page, "Prepare offline").click();
      const reload = button(page, "Reload to finish");
      await expect(
        reload.or(page.locator('[data-testid="offline-status"][data-status="ready"]')),
      ).toBeVisible({
        timeout: 120_000,
      });
      if (await reload.isVisible()) {
        await reload.click();
        await expect(page.getByTestId("offline-target")).toBeVisible({ timeout: 60_000 });
        await page.getByTestId("offline-target").selectOption({ label: character.name });
        note("settings › Offline play: Prepare offline → Reload to finish");
      }
      await expect(page.getByTestId("offline-status")).toHaveAttribute("data-status", "ready", {
        timeout: 120_000,
      });
      note("settings › Offline play: Ready offline");
    }

    // The app's own full copy ("Export character" on the Characters page).
    await page.goto("/#/characters");
    const article = page.getByRole("article").filter({ hasText: character.name });
    await button(article, "Export character").click();
    const exportDialog = page.getByRole("dialog");
    await expect(exportDialog.getByTestId("local-copy-export-summary")).toBeVisible({
      timeout: 60_000,
    });
    const download = page.waitForEvent("download");
    await button(exportDialog, "Save the file").click();
    const file = await download;
    await file.saveAs(join(dir, `${character.id}.local-copy.json`));
    note(`export: ${file.suggestedFilename()} saved`);

    // After the export (it stays a clean new session): the sheet, read and used as a player would.
    // 1. Every Limited Use's "About" text: the feature's or feat's own text with its source, or the
    //    honest "no description" line (only whether there is one is logged: packs may be private).
    await page.goto(`/#/characters/${id}/sheet?tab=combat`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(character.name);
    const uses = page.getByRole("region", { name: "Limited Uses" });
    const infoButtons = uses.getByRole("button", { name: /^About / });
    const useInfos: Record<string, string> = {};
    for (let i = 0; i < (await infoButtons.count()); i++) {
      const b = infoButtons.nth(i);
      const useName = ((await b.getAttribute("aria-label")) ?? "").replace(/^About /, "");
      await b.click();
      const box = uses.getByTestId("use-info");
      await expect(box).toBeVisible();
      const text = await box.innerText();
      useInfos[useName] = /packs give no description for this use/.test(text)
        ? "no description (said so)"
        : `description shown${/From: (.+)/.exec(text)?.[1] ? `, from ${/From: (.+)/.exec(text)?.[1]}` : ""}`;
      await b.click();
    }
    writeFileSync(join(dir, "use-info.json"), `${JSON.stringify(useInfos, null, 2)}\n`);
    note(`sheet › Combat › Limited Uses › About: ${JSON.stringify(useInfos)}`);

    // 2. A roll each: an attack (Fighter7), a cantrip (the casters); journaled in History.
    const journal = async () =>
      page.evaluate(
        () =>
          new Promise<number>((resolve, reject) => {
            const open = indexedDB.open("srd-table");
            open.onerror = () => reject(open.error);
            open.onsuccess = () => {
              const c = open.result
                .transaction("history", "readonly")
                .objectStore("history")
                .count();
              c.onsuccess = () => {
                resolve(c.result);
                open.result.close();
              };
            };
          }),
      );
    const before = await journal();
    if (character.id === "fighter7") {
      const row = page.locator("tr").filter({ hasText: "Longbow" }).first();
      await button(row, "Roll").click();
    } else {
      await page.goto(`/#/characters/${id}/sheet?tab=spells`);
      const cantrip = character.id === "cleric7" ? "Sacred Flame" : "Fire Bolt";
      const line = page
        .getByTestId("spell-line")
        .filter({ has: page.getByRole("button", { name: cantrip, exact: true }) })
        .first();
      await button(line, "Roll").click();
    }
    await expect.poll(journal, { timeout: 15_000 }).toBeGreaterThan(before);
    note(
      `sheet: a roll (${character.id === "fighter7" ? "Longbow attack" : "a cantrip"}) → History +${(await journal()) - before}`,
    );

    // 3. R03-12 — Magic Initiate's free level 1 spell. The SRD feat gives the use but no free cast
    //    (Cleric7, Wizard7): the spell's cost choice has no "Free:" entry, so its Roll would pay a
    //    slot. Played by hand: spend the use on Limited Uses (slots untouched), resolve the spell at
    //    the table, and the use comes back with "Restore one" (or a Long Rest). Kenli7's pack gives
    //    the free cast: "Free: Magic Initiate…" is offered on Bless.
    const mi = { cleric7: "Sanctuary", wizard7: "Find Familiar", kenli7: "Bless" }[character.id];
    if (mi) {
      await page.goto(`/#/characters/${id}/sheet?tab=spells`);
      const line = page
        .getByTestId("spell-line")
        .filter({ has: page.getByRole("button", { name: mi, exact: true }) })
        .first();
      const select = line.getByRole("combobox", { name: `${mi}: slot level` });
      await expect(select.locator("option").first()).toBeAttached();
      const costs = await select.locator("option").allTextContents();
      const free = costs.filter((o) => o.startsWith("Free: "));
      note(`sheet › Spells › ${mi}: cost choices ${JSON.stringify(costs)}`);
      if (character.id === "kenli7") expect(free.length).toBe(1);
      else expect(free).toEqual([]);
      if (character.id !== "kenli7") {
        await page.goto(`/#/characters/${id}/sheet?tab=combat`);
        const slots = async () =>
          ((await stored(page, id)) as { state: { spell_slots_spent: number[] } }).state
            .spell_slots_spent;
        const slotsBefore = await slots();
        const useName = "Magic Initiate (free level 1 spell)";
        await button(page, `Spend one: ${useName}`).click();
        await expect(page.getByRole("img", { name: `${useName}: 0 of 1 left` })).toBeVisible();
        expect(await slots()).toEqual(slotsBefore);
        note(
          `sheet › Combat › Limited Uses: Spend one: ${useName} → 0 of 1 left; spell slots unchanged ${JSON.stringify(slotsBefore)}`,
        );
        await button(page, `Restore one: ${useName}`).click();
        await expect(page.getByRole("img", { name: `${useName}: 1 of 1 left` })).toBeVisible();
        note(`sheet › Combat › Limited Uses: Restore one: ${useName} → 1 of 1 left`);
      }
      await shot(page, `${character.id}-mi`);
    }
  });
}
