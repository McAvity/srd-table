/**
 * kenli F-014 T03: the HTTP smoke after a deployment (docs/deployment.md §9.5): every file of the
 * archived site that a host serves (not the hidden marker, which the live checks never rely on) is
 * fetched past caches and compared with its manifest hash. Bounded rounds for propagation; a
 * finished deployment job is not a passed smoke.
 */
import type { FileRef } from "./lib";
import { sha256 } from "./lib";
import { httpLive } from "./witness";

export interface SmokeResult {
  readonly ok: boolean;
  readonly rounds: number;
  readonly checked: number;
  readonly problems: readonly string[];
}

export async function smokeSite(
  siteUrl: string,
  files: readonly FileRef[],
  opts: { rounds?: number; delayMs?: number; fetcher?: typeof fetch } = {},
): Promise<SmokeResult> {
  const live = httpLive(siteUrl, opts.fetcher);
  const served = files.filter((f) => !f.path.split("/").some((s) => s.startsWith(".")));
  const rounds = opts.rounds ?? 10;
  let problems: string[] = [];
  for (let round = 1; round <= rounds; round++) {
    problems = [];
    for (const f of served) {
      const l = await live(f.path);
      if (l.status !== "ok")
        problems.push(`${f.path}: ${l.status === "error" ? l.detail : "absent"}`);
      else if (sha256(l.bytes) !== f.sha256) problems.push(`${f.path}: other bytes`);
    }
    if (problems.length === 0) return { ok: true, rounds: round, checked: served.length, problems };
    if (round < rounds) await new Promise((r) => setTimeout(r, opts.delayMs ?? 15_000));
  }
  return { ok: false, rounds, checked: served.length, problems: problems.slice(0, 20) };
}
