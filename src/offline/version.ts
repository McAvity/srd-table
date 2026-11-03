/**
 * kenli F-014 T01: the readable app version (docs/deployment.md §1). A release may carry one in
 * `inputs.app_version`: `MAJOR.MINOR.PATCH` or `MAJOR.MINOR.PATCH-rc.N`, the Git tag is the same
 * with a `v` in front. A deliberately small SemVer subset: numbers without leading zeros and within
 * safe integers, N >= 1, no `+build` metadata and no other prerelease label. Pure (Node, Bun,
 * browser).
 */

export interface AppVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  /** The release candidate number; `null` for a final version. */
  readonly rc: number | null;
}

/** Longest accepted text (three safe integers, `-rc.` and a fourth one). */
const MAX_LENGTH = 70;
const NUM = "(0|[1-9][0-9]*)";
const VERSION = new RegExp(`^${NUM}\\.${NUM}\\.${NUM}(?:-rc\\.([1-9][0-9]*))?$`);

/** The parsed version, or `null` for anything outside the supported subset. */
export function parseAppVersion(text: unknown): AppVersion | null {
  if (typeof text !== "string" || text.length > MAX_LENGTH) return null;
  const m = VERSION.exec(text);
  if (!m) return null;
  const nums = [m[1], m[2], m[3], m[4]].map((s) => (s === undefined ? null : Number(s)));
  if (nums.some((n) => n !== null && !Number.isSafeInteger(n))) return null;
  const [major, minor, patch, rc] = nums as [number, number, number, number | null];
  return { major, minor, patch, rc };
}

export const isAppVersion = (text: unknown): text is string => parseAppVersion(text) !== null;

/** SemVer order of two supported versions: rc.N < rc.N+1 < the final version. Throws on others. */
export function compareAppVersions(a: string, b: string): -1 | 0 | 1 {
  const x = parseAppVersion(a);
  const y = parseAppVersion(b);
  if (!x || !y) throw new Error(`unsupported app version: ${!x ? a : b}`);
  const order = (p: number, q: number) => (p < q ? -1 : p > q ? 1 : 0);
  return (order(x.major, y.major) ||
    order(x.minor, y.minor) ||
    order(x.patch, y.patch) ||
    // a final version (no rc) comes after all of its release candidates
    order(x.rc ?? Number.POSITIVE_INFINITY, y.rc ?? Number.POSITIVE_INFINITY)) as -1 | 0 | 1;
}

/** The Git tag of a version: `v0.2.0-rc.1`. */
export const tagOfVersion = (version: string): string => {
  if (!isAppVersion(version)) throw new Error(`unsupported app version: ${version}`);
  return `v${version}`;
};

/** The version a release tag names (`v0.2.0` → `0.2.0`), or `null` for any other ref. */
export function versionOfTag(tag: unknown): string | null {
  if (typeof tag !== "string" || !tag.startsWith("v")) return null;
  const version = tag.slice(1);
  return isAppVersion(version) ? version : null;
}
