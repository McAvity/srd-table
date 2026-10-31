/**
 * kenli F-002 T03: `compilePlan` in the browser's engine Web Worker (the app's own `client.ts` →
 * `worker.ts`, over Comlink) gives exactly the Node facade's result on every progression fixture —
 * positive and negative. Worker-level parity only: no UI, no gameplay, no storage is exercised.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { nodeFacade } from "../src/engine/node";
import { canonicalJson } from "../src/lib/canonical";
import { EXPECTED_STATS } from "../tests/progression/expected-stats";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures/progression");
const index = JSON.parse(readFileSync(join(DIR, "index.json"), "utf8")) as {
  cases: { file: string; expect: string }[];
};
const fixtures = index.cases.map((c) => ({
  ...c,
  plan: JSON.parse(readFileSync(join(DIR, c.file), "utf8")),
}));

test("browser worker and Node facade compile every fixture identically", async ({ page }) => {
  const node = nodeFacade({ seed: 1 });
  const expected = [];
  for (const f of fixtures) expected.push(await node.compilePlan(f.plan));
  const srd = await node.servedPack("srd-5.2.1");

  // A page of the dev server that isn't the app: only the engine worker is started.
  await page.goto("/content/srd-5.2.1/manifest.json");
  // The app's own client module (Comlink over `worker.ts`), loaded as the browser loads it.
  await page.addScriptTag({
    type: "module",
    content: 'import { engine } from "/src/engine/client.ts"; window.__f002Engine = engine();',
  });
  await page.waitForFunction(() => "__f002Engine" in window);
  const browser = await page.evaluate(
    async (plans) => {
      type Facade = {
        compilePlan(p: unknown): Promise<unknown>;
        servedPack(id: string): Promise<unknown>;
      };
      const e = (window as unknown as { __f002Engine: Facade }).__f002Engine;
      const results: unknown[] = [];
      for (const p of plans) results.push(await e.compilePlan(p));
      return {
        results,
        srd: await e.servedPack("srd-5.2.1"),
        ua: navigator.userAgent,
        worker: typeof Worker === "function",
      };
    },
    fixtures.map((f) => f.plan),
  );

  console.log(`browser: ${browser.ua}`);
  expect(browser.srd).toEqual(srd);
  expect(browser.results).toHaveLength(fixtures.length);
  for (const [i, f] of fixtures.entries()) {
    const b = browser.results[i] as { ok: boolean; problem?: { code: string } };
    expect(b.ok ? "ok" : b.problem?.code, f.file).toBe(f.expect);
    expect(canonicalJson(b), f.file).toBe(canonicalJson(expected[i]));
  }
  // Independent numbers too (worked out by hand), so a mapping wrong in both places still fails.
  let checked = 0;
  for (const [i, f] of fixtures.entries()) {
    const want = EXPECTED_STATS[f.file];
    if (!want) continue;
    const b = browser.results[i] as {
      checkpoints: { stats: { max_hp: number; armor_class: number; initiative: number } }[];
    };
    expect(
      b.checkpoints.map((c) => [c.stats.max_hp, c.stats.armor_class, c.stats.initiative]),
      f.file,
    ).toEqual(want.map((x) => [x.hp, x.ac, x.initiative]));
    checked += want.length;
  }
  console.log(
    `independent stats: ${checked} checkpoints in ${Object.keys(EXPECTED_STATS).length} fixtures`,
  );
  console.log(
    `parity: ${fixtures.length} fixtures (${fixtures.filter((f) => f.expect === "ok").length} positive) identical`,
  );
});
