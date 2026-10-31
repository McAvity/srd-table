/**
 * kenli F-011 T09 (dnd5 contracts/changes.md §9): the library's character tool, on this Table's
 * pinned engine (`nodeFacade`, the `-main` worktree at `ENGINE_COMMIT`) — no worker, DOM or IDB.
 *
 *   bun scripts/export-library-character.ts character-copy     --input /abs/request.json --out /abs/copy.json
 *   bun scripts/export-library-character.ts encounter-transfer --input /abs/request.json --out /abs/result.json
 *
 * Reads only the request and the files it names (absolute paths, no `.`/`..`); never the network.
 * Exit 0 written; 2 `request_invalid`/`mode_unknown`/`path_not_absolute` (usage); 3 a refusal
 * (stderr `{"code","detail"}`); 1 an internal error. Limits: request ≤ 64 MiB, copy ≤ 20 MiB,
 * encounter result ≤ 100 MiB. The copy is written as the app writes its export (`JSON.stringify`).
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { nodeFacade } from "../src/engine/node";
import { asRefused, Refusal, refuse } from "../src/import/localCopy/codec";
import {
  CLI_LIMITS,
  checkPackTransfer,
  checkPath,
  checkRequest,
  MODES,
  makeCharacterCopy,
  makeEncounterTransfer,
  portraitOfBytes,
} from "../src/import/localCopy/library";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const USAGE = new Set(["request_invalid", "mode_unknown", "path_not_absolute"]);

/** This Table's commit and its engine pin, stamped into the copy (§9.3). */
export function producerIdentity(): { table_commit: string; engine_commit: string } {
  const table = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const pin = /ENGINE_COMMIT = "([0-9a-f]{40})"/.exec(
    readFileSync(join(root, "scripts/engine-pin.ts"), "utf8"),
  )?.[1];
  if (!/^[0-9a-f]{40}$/.test(table) || !pin) throw new Error("no Table commit or engine pin");
  return { table_commit: table, engine_commit: pin };
}

function readLimited(path: string, limit: number, code: string): Uint8Array {
  if (!existsSync(path) || !statSync(path).isFile())
    refuse("request_invalid", `${path} is not a file`);
  if (statSync(path).size > limit) refuse(code, `${path}: ${statSync(path).size} > ${limit}`);
  return new Uint8Array(readFileSync(path));
}
const parseJson = (bytes: Uint8Array, where: string): unknown => {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return refuse("request_invalid", `${where} is not UTF-8 JSON`);
  }
};

export async function main(argv: readonly string[]): Promise<number> {
  try {
    const [mode, ...rest] = argv;
    if (!mode || !(MODES as readonly string[]).includes(mode))
      refuse("mode_unknown", String(mode ?? ""));
    const opts = new Map<string, string>();
    for (let i = 0; i < rest.length; i += 2) {
      const k = rest[i];
      const v = rest[i + 1];
      if ((k !== "--input" && k !== "--out") || v === undefined || opts.has(k))
        refuse(
          "request_invalid",
          `usage: ${mode} --input /abs/request.json --out /abs/output.json`,
        );
      opts.set(k as string, v as string);
    }
    const input = checkPath(opts.get("--input"), "--input");
    const out = checkPath(opts.get("--out"), "--out");
    const req = checkRequest(
      parseJson(readLimited(input, CLI_LIMITS.requestBytes, "request_invalid"), "the request"),
    );
    if (req.mode !== mode)
      refuse("request_invalid", `the request is ${req.mode}, the command ${mode}`);
    const f = nodeFacade({ seed: 1 });
    const given = [];
    for (const [i, p] of req.packs.entries())
      given.push(
        await checkPackTransfer(
          parseJson(readLimited(p.file, CLI_LIMITS.requestBytes, "request_invalid"), p.file),
          `packs.${i}`,
        ),
      );
    let text: string;
    let limit: number;
    if (req.mode === "character-copy") {
      const file = req.character?.portrait_file ?? null;
      const portrait = file
        ? portraitOfBytes(readLimited(file, 5 * 2 ** 20, "limit_portrait_bytes"))
        : null;
      ({ text } = await makeCharacterCopy(f, req, given, producerIdentity(), portrait));
      limit = CLI_LIMITS.copyBytes;
    } else {
      text = JSON.stringify(await makeEncounterTransfer(f, req, given));
      limit = CLI_LIMITS.resultBytes;
    }
    const bytes = new TextEncoder().encode(text);
    if (bytes.byteLength > limit)
      refuse(
        req.mode === "character-copy" ? "limit_copy_bytes" : "limit_result_bytes",
        `${bytes.byteLength}`,
      );
    writeFileSync(out, bytes);
    return 0;
  } catch (error) {
    if (!(error instanceof Refusal)) {
      console.error(
        JSON.stringify({
          code: "internal",
          detail: error instanceof Error ? error.message : String(error),
        }),
      );
      return 1;
    }
    const r = asRefused(error);
    console.error(JSON.stringify({ code: r.code, detail: r.detail }));
    return USAGE.has(r.code) ? 2 : 3;
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
