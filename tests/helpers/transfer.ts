/**
 * Transfer fixtures (synthetic, `tests/fixtures/transfer/`) served as a library under a fake
 * HTTPS origin, files read as the import dialog reads them, and an engine whose dice the test
 * sets before each action.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setEngine } from "../../src/engine/client";
import type { EngineFacade } from "../../src/engine/facade";
import { nodeFacade } from "../../src/engine/node";

export const FIX = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/transfer");
export const LIB = "https://host.test/dnd/library/";
export const refs = JSON.parse(readFileSync(join(FIX, "refs.json"), "utf8"));

export const fixtureBytes = (rel: string) => new Uint8Array(readFileSync(join(FIX, rel)));
export const fixtureJson = (rel: string) => JSON.parse(readFileSync(join(FIX, rel), "utf8"));
export const fileOf = (rel: string) => ({
  name: rel.split("/").pop() as string,
  bytes: fixtureBytes(rel),
});

/** The library's snapshot URL of a fixture envelope (its bytes' hash). */
export const snapshot = (name: "a1" | "a2" | "wren" | "sable" | "encounter") =>
  `${LIB}s/${refs.bytes[name]}.json`;

export interface FakeFetch {
  (input: string | URL | Request, init?: RequestInit): Promise<Response>;
  readonly calls: string[];
}

/** `fetch` over the fixture library; `routes` override URLs (a function gets the request's init). */
export function libraryFetch(
  routes: Record<string, (init?: RequestInit) => Response | Promise<Response>> = {},
): FakeFetch {
  const calls: string[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    const route = routes[url];
    if (route) return route(init);
    if (!url.startsWith(LIB)) throw new TypeError("Failed to fetch");
    try {
      const bytes = readFileSync(join(FIX, "library", url.slice(LIB.length)));
      return new Response(bytes, { status: 200, headers: { "content-type": "application/json" } });
    } catch {
      return new Response("not found", { status: 404 });
    }
  }) as FakeFetch;
  Object.defineProperty(fn, "calls", { value: calls });
  return fn;
}

/** The in-process engine with dice the test queues (`dice.push(15, 3)` before an action). */
export function engineWithDice(): { engine: EngineFacade; dice: number[] } {
  const dice: number[] = [];
  const engine = nodeFacade({ rng: { int: (min: number) => dice.shift() ?? min } });
  setEngine(engine);
  return { engine, dice };
}
