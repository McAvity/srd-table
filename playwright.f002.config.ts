import { defineConfig, devices } from "@playwright/test";

/**
 * kenli F-002 T05/T06: the progression-plan screens in a real browser, on a production build of
 * this checkout (Bun, `--base /dnd/`) in /tmp, served by its own `vite preview` on an isolated
 * loopback port — never the running app, never a deployment. The fixtures' plan files are copied
 * next to the build so the URL import reads them over HTTP (loopback is allowed by the fetch rules).
 *
 *   node node_modules/@playwright/test/cli.js test -c playwright.f002.config.ts [--project chromium]
 *
 * Firefox (system, Snap) only as a capability probe: `F002_FIREFOX=1` with TMPDIR under the task's
 * scratch (Snap can't see /tmp profiles).
 */
const port = Number(process.env.F002_PORT ?? 4393);
const out = process.env.F002_APP_DIR ?? "/tmp/f002-t05-app";
const firefox = process.env.F002_FIREFOX === "1";

export default defineConfig({
  testDir: "e2e",
  testMatch: /f002-.*\.spec\.ts$/,
  timeout: 240_000,
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  outputDir: process.env.F002_OUTPUT ?? "/tmp/f002-t05-e2e-results",
  use: { baseURL: `http://127.0.0.1:${port}/dnd/`, trace: "off", acceptDownloads: true },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 900 } },
    },
    ...(firefox
      ? [
          {
            name: "firefox-capability",
            grep: /@capability/,
            use: {
              browserName: "firefox" as const,
              channel: "moz-firefox",
              launchOptions: { executablePath: "/usr/bin/firefox", headless: true },
            },
          },
        ]
      : []),
  ],
  webServer: {
    command: [
      `bun --bun node_modules/vite/bin/vite.js build --base /dnd/ --outDir ${out} --emptyOutDir`,
      `mkdir -p ${out}/plans`,
      `cp e2e/fixtures/progression/*.plan.json ${out}/plans/`,
      `node node_modules/vite/bin/vite.js preview --base /dnd/ --outDir ${out} --host 127.0.0.1 --port ${port} --strictPort`,
    ].join(" && "),
    url: `http://127.0.0.1:${port}/dnd/`,
    reuseExistingServer: false,
    timeout: 240_000,
  },
});
