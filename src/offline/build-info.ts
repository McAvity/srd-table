/**
 * kenli F-014 T01: what this code was built as (docs/deployment.md §3). scripts/release.ts computes
 * the release id first, then passes `{version, release_id, table_commit, engine_commit}` to Vite
 * (`F014_BUILD_INFO`), which embeds it in the JS (`__BUILD_INFO__`). Nothing is fetched or read from
 * Git while the app runs, and no file hashes itself. Outside a release (dev, tests, a plain
 * `vite build`) it is the development build: no version, no commits, `r-dev`.
 *
 * Pure apart from reading the define. scripts/release.ts checks the metadata with
 * `buildInfoProblems` before the build; vite.config.ts only passes it on.
 */

import { RELEASE_ID } from "./descriptor";
import { isAppVersion } from "./version";

export interface BuildInfo {
  /** The app version (`0.2.0`, `0.2.0-rc.1`); `null` for a release without one or a dev build. */
  readonly version: string | null;
  /** The release id, or `r-dev` outside a release build. */
  readonly release_id: string;
  readonly table_commit: string | null;
  readonly engine_commit: string | null;
  /** Built from a tree with uncommitted changes (never published). */
  readonly dirty?: true;
}

export const DEV_RELEASE_ID = "r-dev";
export const DEV_BUILD_INFO: BuildInfo = Object.freeze({
  version: null,
  release_id: DEV_RELEASE_ID,
  table_commit: null,
  engine_commit: null,
});

const COMMIT = /^[0-9a-f]{40}$/;
const KEYS = ["version", "release_id", "table_commit", "engine_commit", "dirty"];

/** Contract checks of build metadata (`[]` when valid). */
export function buildInfoProblems(info: unknown): string[] {
  if (typeof info !== "object" || info === null || Array.isArray(info)) return ["not an object"];
  const o = info as Record<string, unknown>;
  const out: string[] = [];
  for (const k of Object.keys(o)) if (!KEYS.includes(k)) out.push(`unknown field ${k}`);
  const dev = o.release_id === DEV_RELEASE_ID;
  if (!dev && !(typeof o.release_id === "string" && RELEASE_ID.test(o.release_id)))
    out.push("release_id");
  if (o.version !== null && !isAppVersion(o.version)) out.push("version");
  for (const k of ["table_commit", "engine_commit"])
    if (o[k] !== null && !(typeof o[k] === "string" && COMMIT.test(o[k] as string))) out.push(k);
  if (o.dirty !== undefined && o.dirty !== true) out.push("dirty");
  if (dev && (o.version !== null || o.table_commit !== null || o.engine_commit !== null))
    out.push("a dev build has no version or commits");
  if (
    o.version !== null &&
    (o.dirty === true || o.table_commit === null || o.engine_commit === null)
  )
    out.push("a version needs a clean build of known commits");
  return out;
}

declare const __BUILD_INFO__: BuildInfo | undefined;
/** The metadata of the code running here (Node scripts and vite.config have no define). */
export const BUILD_INFO: BuildInfo =
  typeof __BUILD_INFO__ === "object" && __BUILD_INFO__ !== null ? __BUILD_INFO__ : DEV_BUILD_INFO;

/** What the footer shows: the version, else the release id; `null` for the development build. */
export function versionLabel(info: BuildInfo): string | null {
  if (info.version) return info.version;
  return info.release_id === DEV_RELEASE_ID ? null : info.release_id;
}

/** Plain text for a bug report (copied or selected by hand): fixed English keys, one per line. */
export function buildInfoText(info: BuildInfo): string {
  return [
    `SRD Table ${info.version ?? (info.release_id === DEV_RELEASE_ID ? "development build" : "(no version)")}`,
    `release: ${info.release_id}`,
    `table: ${info.table_commit ?? "unknown"}`,
    `engine: ${info.engine_commit ?? "unknown"}`,
    ...(info.dirty ? ["uncommitted changes: yes"] : []),
  ].join("\n");
}
