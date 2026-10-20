import { defineConfig, devices } from "@playwright/test";

/**
 * kenli F-006 T04: with `F006_STAGING_URL` set, the browser tests in `e2e/` run against a
 * production build served elsewhere (a /tmp build on loopback), in Chromium and WebKit (desktop and
 * iPad emulation, which is not a physical iPad); `F006_WEBKIT` may point at an installed WebKit
 * build. Without it, the existing flows in `tests/e2e/` run as before.
 */
const staging = process.env.F006_STAGING_URL;
const webkitPath = process.env.F006_WEBKIT;
const webkitLaunch = webkitPath ? { launchOptions: { executablePath: webkitPath } } : {};

export default staging
  ? defineConfig({
      testDir: "e2e",
      globalSetup: "./e2e/global-setup.ts",
      timeout: Number(process.env.F006_TIMEOUT ?? 240_000),
      fullyParallel: false,
      workers: 1,
      reporter: "list",
      outputDir: process.env.F006_OUTPUT ?? "/tmp/f006-e2e-results",
      use: { baseURL: staging, trace: "off" },
      projects: [
        {
          name: "chromium",
          use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
        },
        { name: "webkit", use: { ...devices["Desktop Safari"], ...webkitLaunch } },
        {
          name: "webkit-ipad-emulation",
          use: { ...devices["iPad Pro 11"], ...webkitLaunch },
          grep: /@touch/,
        },
      ],
    })
  : defineConfig({
      testDir: "tests/e2e",
      globalSetup: "./tests/e2e/global-setup.ts",
      timeout: 120_000,
      fullyParallel: false,
      reporter: "list",
      use: {
        baseURL: "http://localhost:4173",
        trace: "retain-on-failure",
      },
      projects: [
        {
          name: "chromium",
          use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
        },
      ],
      webServer: {
        command: "npm run build && npx vite preview --port 4173 --strictPort",
        url: "http://localhost:4173",
        reuseExistingServer: true,
        timeout: 180_000,
      },
    });
