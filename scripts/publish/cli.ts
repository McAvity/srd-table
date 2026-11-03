/**
 * kenli F-014 T02: the publisher's command line (docs/deployment.md §7). Runs with Node (tsx) or Bun.
 *
 *   tsx scripts/publish/cli.ts <command> --remote <repo> --work <new dir> --facts <facts.json>
 *        [--anchor <sha>] [--live-dir <dir>] [options]
 *
 *   initialize --base /srd-table/ --site-url https://…/srd-table/       → {"anchor": …}
 *   verify                                                              → state summary (no write)
 *   publish    --version V --tag-commit SHA --release DIR --srd DIR --site-out DIR [--bridge]
 *   retry      --version V [--site-out DIR]                             (never builds)
 *   receipt    --version V --run-id N --page-url URL --artifact-digest D
 *   resolve    --version V
 *
 * Witnesses: `--facts` is a JSON file `{rulesets, deployments}` (RulesetFacts, DeploymentFacts in
 * witness.ts) that the caller fills — in GitHub Actions from the API (T03), in tests by hand. The
 * live site is read over HTTP from the state's site URL (no cache), or from `--live-dir` for a local
 * rehearsal. Exit 0 with a JSON result; exit 1 with `publish refused: <code>: <detail>`.
 */
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { parseArgs } from "node:util";
import { Archive, initialize, receipt, resolve, retry, stage } from "./archive";
import { fail, PublishError } from "./lib";
import { dirLive, httpLive, type Witnesses } from "./witness";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    remote: { type: "string" },
    work: { type: "string" },
    anchor: { type: "string" },
    facts: { type: "string" },
    "live-dir": { type: "string" },
    base: { type: "string" },
    "site-url": { type: "string" },
    version: { type: "string" },
    "tag-commit": { type: "string" },
    release: { type: "string" },
    srd: { type: "string" },
    "site-out": { type: "string" },
    bridge: { type: "boolean", default: false },
    "run-id": { type: "string" },
    "page-url": { type: "string" },
    "artifact-digest": { type: "string" },
  },
});

function witnesses(siteUrl: string | null): Witnesses {
  const factsPath = values.facts ?? fail("usage", "--facts <file> is required");
  const facts = JSON.parse(readFileSync(factsPath, "utf8"));
  if (!facts.rulesets || !facts.deployments) fail("usage", "--facts needs {rulesets, deployments}");
  const live = values["live-dir"]
    ? dirLive(resolvePath(values["live-dir"]))
    : httpLive(siteUrl ?? fail("usage", "the site URL is unknown"));
  return {
    rulesets: async () => facts.rulesets,
    deployments: async () => facts.deployments,
    live,
  };
}

const need = (k: keyof typeof values): string =>
  (values[k] as string | undefined) ?? fail("usage", `--${k} is required`);

async function main(): Promise<unknown> {
  const command = positionals[0];
  const base = { remote: need("remote"), workDir: resolvePath(need("work")) };
  if (command === "initialize") {
    const siteUrl = need("site-url");
    return initialize({ ...base, witnesses: witnesses(siteUrl) }, { base: need("base"), siteUrl });
  }
  // the site URL comes from the archive's own state (read after the clone)
  let siteUrl: string | null = null;
  const w = witnesses(null);
  const lazy: Witnesses = {
    rulesets: w.rulesets,
    deployments: w.deployments,
    live: values["live-dir"] ? w.live : (p) => httpLive(siteUrl as string)(p),
  };
  const a = await Archive.open({ ...base, anchor: need("anchor"), witnesses: lazy });
  siteUrl = a.state.site_url;
  switch (command) {
    case "verify": {
      await a.witness();
      return { head: a.head, state: a.state };
    }
    case "publish": {
      const r = await stage(a, {
        version: need("version"),
        tagCommit: need("tag-commit"),
        releaseDir: resolvePath(need("release")),
        srdDir: resolvePath(need("srd")),
        bridge: values.bridge,
      });
      const files = a.exportSite(resolvePath(need("site-out")));
      return { ...r, exported: files.length };
    }
    case "retry": {
      const r = await retry(a, need("version"));
      const exported =
        values["site-out"] && r.action !== "historical-verified"
          ? a.exportSite(resolvePath(values["site-out"])).length
          : 0;
      return { ...r, exported };
    }
    case "receipt":
      return receipt(a, need("version"), {
        run_id: need("run-id"),
        page_url: need("page-url"),
        artifact_digest: need("artifact-digest"),
      });
    case "resolve":
      return resolve(a, need("version"));
    default:
      return fail("usage", `unknown command ${String(command)}`);
  }
}

main().then(
  (r) => console.log(JSON.stringify(r)),
  (e) => {
    if (e instanceof PublishError) {
      console.error(`publish refused: ${e.message}`);
      process.exit(1);
    }
    console.error(e);
    process.exit(2);
  },
);
