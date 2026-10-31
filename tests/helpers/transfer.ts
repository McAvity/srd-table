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
import type { AllowedRootKind, Source } from "../../src/import/resolve";
import { contentSha } from "../../src/lib/canonical";

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

/**
 * kenli F-011 §8: the entrance a test's source goes through — Settings for packs only, else
 * Encounters (where a character root is refused: `root_kind_not_allowed`).
 */
export function entranceFor(source: Source): AllowedRootKind {
  const isPack = (bytes: Uint8Array) => {
    try {
      return JSON.parse(new TextDecoder().decode(bytes)).kind === "pack";
    } catch {
      return false;
    }
  };
  if ("files" in source) return source.files.every((f) => isPack(f.bytes)) ? "pack" : "encounter";
  const packs = [snapshot("a1"), snapshot("a2"), `${LIB}d/pack/synthetic-a.json`];
  return packs.includes(source.url) ? "pack" : "encounter";
}

/**
 * kenli F-011 T04 R03-07: a character file as the internal party of a one-combatant encounter —
 * the only root a character transfer may come with now (changes.md §8). The encounter is
 * mixed-duel's first party combatant renamed to the character, its world the character's own
 * context, `requires` = those packs + the character (as files: no href), its hash recomputed.
 * Returns the files for `{ files }`: the encounter, the character and the packs it needs (the
 * served SRD excepted), so a replacement of a party member runs through the Encounters entrance.
 */
export async function asParty(rel: string): Promise<{ name: string; bytes: Uint8Array }[]> {
  const ch = fixtureJson(rel);
  const key = String(ch.title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-");
  const base = fixtureJson("encounters/mixed-duel.transfer.json");
  const template = base.content.encounter.combatants.find(
    (c: { character: string | null }) => c.character,
  );
  const encounter = {
    ...base.content.encounter,
    order: [],
    combatants: [{ ...template, id: key, name: ch.title, character: key }],
  };
  const world = ch.content.context;
  const character = { id: ch.id, revision: ch.revision, sha256: ch.sha256 };
  const content = {
    name: `${ch.title}'s party`,
    encounter,
    world,
    party: [{ key, character }],
  };
  const requires = [
    ...world.packs.map((p: { id: string; version: string | null; sha256: string }) => ({
      kind: "pack",
      id: p.id,
      version: p.version,
      sha256: p.sha256,
      href: null,
      bytes_sha256: null,
    })),
    { kind: "character", ...character, href: null, bytes_sha256: null },
  ];
  const env = {
    format: "srd-table.transfer/1",
    kind: "encounter",
    id: `synthetic/party-${key}`,
    revision: { seq: 1 },
    title: content.name,
    sha256: await contentSha(content),
    content,
    requires,
    provenance: base.provenance,
    extensions: {},
  };
  const packs = world.packs
    .filter((p: { id: string }) => p.id !== "srd-5.2.1")
    .map((p: { id: string; version: string }) =>
      fileOf(`packs/${p.id}-${p.version}.transfer.json`),
    );
  return [
    { name: `party-${key}.transfer.json`, bytes: new TextEncoder().encode(JSON.stringify(env)) },
    { name: rel.split("/").pop() as string, bytes: fixtureBytes(rel) },
    ...packs,
  ];
}
