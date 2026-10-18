/**
 * The engine commit the app builds against, and the check that `../srd-rules-engine-main` is it.
 *
 *   npm run engine:verify   # the worktree is at ENGINE_COMMIT, clean, built; prints a hash of dist/
 *   npm run engine:update   # move it to ENGINE_COMMIT, npm ci, build dist/, verify (then content)
 *
 * A branch name isn't a version: the engine's `main` moves, so the app pins one commit and changes
 * it here, on purpose, with the engine's CHANGELOG read. The dist hash is the sha256 of
 * `<sha256>  <path>\n` lines for every file under dist/, paths relative and sorted by code point.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const ENGINE_COMMIT = "e7f4302117484ea73548a2a1354dced8b246facb";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const engineDir = join(root, "..", "srd-rules-engine-main");

const git = (...args: string[]) =>
  execFileSync("git", ["-C", engineDir, ...args], { encoding: "utf8" }).trim();
const run = (cmd: string, args: string[]) =>
  execFileSync(cmd, args, { cwd: engineDir, stdio: "inherit" });
const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

function distHash(): { count: number; hash: string } {
  const dist = join(engineDir, "dist");
  const paths = files(dist)
    .map((p) => relative(dist, p))
    .sort();
  const lines = paths.map((p) => `${sha256(readFileSync(join(dist, p)))}  ${p}\n`).join("");
  return { count: paths.length, hash: sha256(lines) };
}

function verify(): void {
  if (!existsSync(engineDir)) throw new Error(`No engine worktree at ${engineDir}`);
  const head = git("rev-parse", "HEAD");
  if (head !== ENGINE_COMMIT)
    throw new Error(`Engine at ${head}, expected ${ENGINE_COMMIT}: run npm run engine:update`);
  const dirty = git("status", "--porcelain", "--untracked-files=all");
  if (dirty) throw new Error(`Engine worktree has local changes:\n${dirty}`);
  if (!existsSync(join(engineDir, "dist", "index.js")))
    throw new Error("Engine dist/ isn't built: run npm run engine:update");
  const { count, hash } = distHash();
  console.log(`engine ${ENGINE_COMMIT} clean; dist ${count} files sha256 ${hash}`);
}

const command = process.argv[2];
if (command === "update") {
  git("checkout", "-q", "--detach", ENGINE_COMMIT);
  run("npm", ["ci", "--no-audit", "--no-fund"]);
  run("npx", ["tsdown", "--config-loader", "tsx"]);
  verify();
} else if (command === "verify") {
  verify();
} else {
  console.error("Usage: tsx scripts/engine-pin.ts verify|update");
  process.exit(1);
}
