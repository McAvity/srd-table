/**
 * kenli F-002 T05/T06 in a real browser (production build under /dnd/, own server): a plan from a
 * file and from a URL, its preview and Cancel (nothing created), a NEW character at levels 1, 7 and
 * 20, the played character's next level only (its HP kept), the end of the plan, a busy roll
 * finished from the panel, a bind (refused for another plan, cancelled, confirmed), a manual edit
 * that leaves the plan and the explicit detach, a missing pack, and the Markdown download — the
 * same file whatever level the character is at, equal to the renderer's output for that plan. All
 * through the app's own controls; IndexedDB is only read. Synthetic/SRD plans only.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { nodeFacade } from "../src/engine/node";
import { planMarkdown } from "../src/progression/markdown";

const FIX = join(dirname(fileURLToPath(import.meta.url)), "fixtures/progression");
const plan = (name: string) => JSON.parse(readFileSync(join(FIX, name), "utf8"));

async function characters(page: Page) {
  await page.goto("./#/characters");
  await expect(page.getByTestId("plan-import-open")).toBeVisible({ timeout: 60_000 });
}
/** Characters in the app's database (read only). */
async function dbCharacters(
  page: Page,
): Promise<{ id: string; rev: number; level: number; hp: number | null; progression: unknown }[]> {
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open("srd-table");
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains("characters")) return resolve([]);
          const req = db.transaction("characters", "readonly").objectStore("characters").getAll();
          req.onsuccess = () => {
            resolve(
              (
                req.result as {
                  id: string;
                  rev?: number;
                  build: { levels: unknown[] };
                  state: { hp: { current: number | null } };
                  progression?: unknown;
                }[]
              ).map((r) => ({
                id: r.id,
                rev: r.rev ?? 0,
                level: 1 + r.build.levels.length,
                hp: r.state.hp.current,
                progression: r.progression ?? null,
              })),
            );
            db.close();
          };
        };
      }),
  );
}
async function loadFile(page: Page, name: string) {
  await page.getByTestId("plan-import-open").click();
  await page.getByTestId("plan-file").setInputFiles(join(FIX, name));
  await expect(page.getByTestId("plan-preview")).toBeVisible({ timeout: 60_000 });
}
async function startAt(page: Page, name: string, level: number): Promise<string> {
  await characters(page);
  await loadFile(page, name);
  // The quick button when there is one, else typed in the field (select all, type: as a person does).
  const quick = page.getByTestId(`plan-level-${level}`);
  if (await quick.count()) await quick.click();
  else {
    await page.getByTestId("plan-level").click();
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.type(String(level));
  }
  await expect(page.getByTestId("plan-checkpoint")).toContainText(`Level ${level}:`);
  await page.getByTestId("plan-start").click();
  await page.waitForURL(/#\/characters\/c-[^/]+\/sheet/);
  await expect(page.getByTestId("plan-level-status")).toContainText(`At level ${level} of`);
  return /#\/characters\/(c-[^/]+)\/sheet/.exec(page.url())?.[1] as string;
}
async function downloadMarkdown(page: Page): Promise<string> {
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId("plan-markdown").first().click(),
  ]);
  const path = await download.path();
  expect(download.suggestedFilename()).toMatch(/\.md$/);
  return readFileSync(path, "utf8");
}

test("a plan file: preview, Cancel creates nothing; NEW characters at 1, 7 and 20; the end of the plan", async ({
  page,
}) => {
  await characters(page);
  await loadFile(page, "fighter-1-20.plan.json");
  await expect(page.getByTestId("plan-preview")).toContainText("Levels 1–20");
  await expect(page.getByTestId("plan-preview")).toContainText("Wojownik 1–20");
  await page.getByTestId("plan-level-7").click();
  await expect(page.getByTestId("plan-checkpoint")).toContainText("Level 7:");
  await page.getByTestId("plan-cancel").click();
  await expect(page.getByTestId("plan-preview")).toHaveCount(0);
  expect(await dbCharacters(page)).toEqual([]);
  for (const level of [1, 7, 20]) await startAt(page, "fighter-1-20.plan.json", level);
  await expect(page.getByTestId("plan-end")).toBeVisible();
  await expect(page.getByTestId("plan-next")).toHaveCount(0);
  const rows = await dbCharacters(page);
  expect(rows.map((r) => r.level).sort((a, b) => a - b)).toEqual([1, 7, 20]);
  expect(new Set(rows.map((r) => r.id)).size).toBe(3);
});

test("keyboard only: open, load by URL, choose a level and start", async ({ page, baseURL }) => {
  await characters(page);
  await page.getByTestId("plan-import-open").focus();
  await page.keyboard.press("Enter");
  await page.getByTestId("plan-url").focus();
  await page.keyboard.type(`${baseURL}plans/fighter-1-20.plan.json`);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("plan-preview")).toBeVisible({ timeout: 60_000 });
  await page.getByTestId("plan-level").focus();
  await page.keyboard.press("Control+A");
  await page.keyboard.type("7");
  await page.getByTestId("plan-start").focus();
  await page.keyboard.press("Enter");
  await page.waitForURL(/#\/characters\/c-[^/]+\/sheet/);
  await expect(page.getByTestId("plan-level-status")).toContainText("At level 7 of 20");
});

test("the played character: HP kept through the next level; a busy roll finished from the panel; only the next level", async ({
  page,
}) => {
  await startAt(page, "fighter-1-20.plan.json", 7);
  // Played at the table: damage through the HP panel.
  await page.getByPlaceholder("Amount").fill("9");
  await page.getByRole("button", { name: "Damage", exact: true }).click();
  // An open roll: the panel says so and offers to finish it.
  await page
    .getByRole("button", { name: /: Roll$/ })
    .first()
    .click();
  await page.getByTestId("plan-next").click();
  await expect(page.getByTestId("plan-refusal")).toHaveAttribute("data-code", "advance_busy");
  await page.getByTestId("plan-finish-roll").click();
  await expect(page.getByTestId("step-preview")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("step-preview")).toContainText("Level 7 → 8");
  // Cancel: nothing changes.
  const before = await dbCharacters(page);
  await page.getByTestId("plan-preview-cancel").click();
  expect(await dbCharacters(page)).toEqual(before);
  await page.getByTestId("plan-next").click();
  await page.getByTestId("plan-confirm").click();
  await expect(page.getByTestId("plan-note")).toContainText("Level 8 gained from the plan.");
  await expect(page.getByTestId("plan-level-status")).toContainText("At level 8 of 20");
  const after = await dbCharacters(page);
  expect(after[0]?.level).toBe(8);
  expect(after[0]?.rev).toBe((before[0]?.rev ?? 0) + 1);
  // The current HP is the played one (60 − 9), not reset; the maximum grew (60 → 68).
  expect(before[0]?.hp).toBe(51);
  expect(after[0]?.hp).toBe(51);
  await expect(page.locator("body")).toContainText("51/68");
  // The History panel: the level gained from the plan, in its words.
  await page.getByRole("button", { name: "History" }).first().click();
  await expect(page.getByTestId("history-scroll")).toContainText(
    "Level 8 from the plan (Fighter 8)",
  );
});

test("bind: another plan refused, Cancel changes nothing, the right one bound; a manual edit leaves the plan; explicit detach", async ({
  page,
}) => {
  await startAt(page, "fighter-1-6.plan.json", 3);
  await page.getByTestId("plan-detach").click();
  await page.getByTestId("plan-detach-confirm").click();
  await expect(page.getByTestId("plan-bind-open")).toBeVisible();
  // Another plan: refused with the reason, nothing changed.
  await page.getByTestId("plan-bind-open").click();
  await page.getByTestId("plan-bind-file").setInputFiles(join(FIX, "wizard-1-5.plan.json"));
  await expect(page.getByTestId("plan-refusal")).toHaveAttribute(
    "data-code",
    "bind_prefix_mismatch",
  );
  await expect(page.getByTestId("plan-differences")).toBeVisible();
  // The right plan: previewed, cancelled (nothing), then bound.
  await page.getByTestId("plan-bind-file").setInputFiles(join(FIX, "fighter-1-6.plan.json"));
  await expect(page.getByTestId("step-preview")).toContainText("Follow this plan from level 3");
  const before = await dbCharacters(page);
  await page.getByTestId("plan-preview-cancel").click();
  expect(await dbCharacters(page)).toEqual(before);
  await page.getByTestId("plan-bind-open").click();
  await page.getByTestId("plan-bind-file").setInputFiles(join(FIX, "fighter-1-6.plan.json"));
  await page.getByTestId("plan-confirm").click();
  await expect(page.getByTestId("plan-note")).toContainText("Now following the plan at level 3.");
  await page.getByRole("button", { name: "History" }).first().click();
  await expect(page.getByTestId("history-scroll")).toContainText("Follows a plan from level 3");
  await page.keyboard.press("Escape");
  // A manual edit in the builder (with its warning): the plan then refuses, data kept; detach on purpose.
  await page.getByRole("link", { name: "Build" }).first().click();
  await expect(page.getByTestId("plan-builder-notice")).toBeVisible();
  await page.getByRole("button", { name: "Remove level 3" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Remove", exact: true }).click();
  // The builder's own preview of what the edit removes, then Apply.
  await page
    .getByRole("dialog", { name: "Before you change this" })
    .getByRole("button", { name: "Apply" })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("link", { name: "Sheet" }).first().click();
  await page.getByTestId("plan-next").click();
  await expect(page.getByTestId("plan-refusal")).toHaveAttribute("data-code", "advance_diverged");
  const kept = await dbCharacters(page);
  expect(kept[0]?.level).toBe(2);
  expect(kept[0]?.progression).not.toBeNull();
  await page
    .getByTestId("plan-refusal")
    .getByRole("button", { name: "Stop following the plan" })
    .click();
  await page.getByTestId("plan-detach-confirm").click();
  await expect(page.getByTestId("plan-note")).toContainText("no longer follows a plan");
  // Saved by the ordinary autosave (debounced), like any edit.
  await expect.poll(async () => (await dbCharacters(page))[0]?.progression ?? null).toBeNull();
  expect((await dbCharacters(page))[0]?.level).toBe(2);
});

test("a plan whose pack isn't here: refused in the preview, nothing created", async ({
  page,
  baseURL,
}) => {
  await characters(page);
  await page.getByTestId("plan-import-open").click();
  await page.getByTestId("plan-url").fill(`${baseURL}plans/pool-feat-no-envelope.plan.json`);
  await page.getByTestId("plan-url-load").click();
  await expect(page.getByRole("alert")).toContainText("needs content that isn't here", {
    timeout: 60_000,
  });
  await expect(page.getByTestId("plan-start")).toBeDisabled();
  expect(await dbCharacters(page)).toEqual([]);
});

test("Markdown @capability: the same file at levels 1, 7 and 20, equal to the renderer's, nothing changed", async ({
  page,
}) => {
  const texts: string[] = [];
  for (const level of [1, 7, 20]) {
    await startAt(page, "fighter-1-20.plan.json", level);
    const before = await dbCharacters(page);
    texts.push(await downloadMarkdown(page));
    expect(await dbCharacters(page)).toEqual(before);
  }
  expect(texts[1]).toBe(texts[0]);
  expect(texts[2]).toBe(texts[0]);
  const file = plan("fighter-1-20.plan.json");
  const compiled = await nodeFacade({ seed: 1 }).compilePlan(file);
  if (!compiled.ok) throw new Error(compiled.problem.detail);
  const { progression: _p, ...rest } = { progression: null, ...file };
  void rest;
  const { packs: _packs, ...withoutPacks } = file;
  expect(texts[0]).toBe(planMarkdown(withoutPacks, compiled.checkpoints));
  expect(texts[0]).toContain("# Wojownik 1–20 — „próba” \\*pełna\\*");
  expect(texts[0]).toContain("## Level 20 — Fighter 20");
});

test.describe("touch", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 820, height: 1180 } });
  test("taps only: a plan by URL, start at 7, the next level confirmed", async ({
    page,
    baseURL,
  }) => {
    await characters(page);
    await page.getByTestId("plan-import-open").tap();
    await page.getByTestId("plan-url").fill(`${baseURL}plans/fighter-1-20.plan.json`);
    await page.getByTestId("plan-url-load").tap();
    await expect(page.getByTestId("plan-preview")).toBeVisible({ timeout: 60_000 });
    await page.getByTestId("plan-level-7").tap();
    await page.getByTestId("plan-start").tap();
    await page.waitForURL(/#\/characters\/c-[^/]+\/sheet/);
    await page.getByTestId("plan-next").tap();
    await expect(page.getByTestId("step-preview")).toContainText("Level 7 → 8", {
      timeout: 60_000,
    });
    await page.getByTestId("plan-confirm").tap();
    await expect(page.getByTestId("plan-level-status")).toContainText("At level 8 of 20");
  });
});
