import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

/**
 * kenli F-002 T03: the progression-plan compiler in a real browser Web Worker against the Node
 * facade, on the same fixtures (`e2e/fixtures/progression/`). A worker-level parity probe, not UI
 * or gameplay coverage: its own Vite dev server on an isolated loopback port, nothing else touched.
 *
 *   node node_modules/@playwright/test/cli.js test -c e2e/progression-codec.config.ts
 */
const port = Number(process.env.F002_T03_PORT ?? 4391);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export default defineConfig({
  testDir: ".",
  testMatch: /progression-codec\.spec\.ts$/,
  timeout: 180_000,
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  outputDir: process.env.F002_T03_OUTPUT ?? "/tmp/f002-t03-e2e-results",
  use: { baseURL: `http://127.0.0.1:${port}`, trace: "off" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `node node_modules/vite/bin/vite.js --host 127.0.0.1 --port ${port} --strictPort`,
    cwd: root,
    url: `http://127.0.0.1:${port}/content/srd-5.2.1/manifest.json`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
