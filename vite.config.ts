import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// The engine as the app builds against it: a detached worktree of the engine's main
// (`../srd-rules-engine-main`), so the engine session's branches never reach the app.
const engineDir = fileURLToPath(new URL("../srd-rules-engine-main", import.meta.url));

// kenli F-007 T02: the release id, computed by scripts/release.ts from inputs known before the build
// (contracts/offline.md §2.2); `r-dev` in dev, tests and plain `vite build` (never registrable).
const releaseId = process.env.F007_RELEASE_ID ?? "r-dev";
// kenli F-014 T01: the build metadata (version, commits; docs/deployment.md §3), checked by
// scripts/release.ts (src/offline/build-info.ts) before it starts this build. Without it: no version.
const buildInfo = process.env.F014_BUILD_INFO
  ? (JSON.parse(process.env.F014_BUILD_INFO) as { release_id?: unknown })
  : { version: null, release_id: releaseId, table_commit: null, engine_commit: null };
if (buildInfo.release_id !== releaseId)
  throw new Error(`F014_BUILD_INFO is not release ${releaseId}'s metadata`);

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    __RELEASE_ID__: JSON.stringify(releaseId),
    __BUILD_INFO__: JSON.stringify(buildInfo),
  },
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
    // The app and the engine share one Zod.
    dedupe: ["zod"],
  },
  server: {
    // The engine is a symlink to that worktree.
    fs: { allow: [".", engineDir] },
  },
  worker: { format: "es" },
  test: {
    include: ["tests/**/*.test.{ts,tsx}"],
    environment: "jsdom",
    setupFiles: ["tests/setup.ts"],
    // The real SRD is loaded once per file; component tests render whole screens.
    testTimeout: 30_000,
  },
});
