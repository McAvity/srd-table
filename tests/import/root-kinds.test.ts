/**
 * kenli F-011 T04 (contracts/changes.md §8, examples/root-kinds.json): what each entrance imports.
 * "Import character" takes one full copy `/2` (file, URL, or a library pointer `kind: "character"`
 * to one); Settings' "Import pack" a pack transfer and its pack dependencies; Encounters an
 * encounter transfer with its packs and party characters as its dependencies only. Every other
 * root — a character transfer, a raw build/state/encounter, a local copy elsewhere — is refused
 * before the preview, any dependency fetch or a write. Plus the copy URL's bounds: no
 * Content-Length (counted as it streams), redirects, another origin, cancel.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LOCAL_COPY_LIMITS, validateLocalCopy } from "../../src/import/localCopy/format";
import { checkCopyRoot, fetchCopy } from "../../src/import/localCopy/url";
import {
  type AllowedRootKind,
  type Environment,
  resolveGraph,
  type Source,
} from "../../src/import/resolve";
import { ImportError } from "../../src/import/transfer";
import { sha256Hex } from "../../src/lib/canonical";
import {
  fileOf,
  fixtureBytes,
  fixtureJson,
  LIB,
  libraryFetch,
  refs,
  snapshot,
} from "../helpers/transfer";
import { FIX as LC_FIX } from "../localCopy/helpers";
import { asCopyV2 } from "../localCopy/v2";

const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
const long1 = JSON.parse(readFileSync(join(LC_FIX, "long-pinned.local-copy.fixture"), "utf8"));
const copy2 = await asCopyV2(long1);
const copy3 = { ...copy2, format: "srd-table.local-copy/3" };

const INPUTS: Record<string, Uint8Array> = {
  copy2: enc(copy2),
  copy1: enc(long1),
  copy3: enc(copy3),
  "t-character": fixtureBytes("characters/wren.r2.transfer.json"),
  "t-pack": fixtureBytes("packs/synthetic-a-1.0.0.transfer.json"),
  "t-encounter": fixtureBytes("encounters/mixed-duel.transfer.json"),
  "raw-build": enc({ version: 4, name: "Raw", classes: [] }),
  "raw-state": enc({ version: 3, hp: { current: null, temp: 0 } }),
  "raw-encounter": enc({ version: 1, round: 0, combatants: [] }),
  bundle: fixtureBytes("negative/kenli-bundle.json"),
};

const env = (allowed: AllowedRootKind, over: Partial<Environment> = {}): Environment => ({
  allowed,
  installed: [],
  served: [refs.srd],
  installation: null,
  localCharacter: async () => null,
  signal: new AbortController().signal,
  fetch: libraryFetch(),
  ...over,
});
const graphCode = async (source: Source, e: Environment) => {
  try {
    await resolveGraph(source, e);
    return "ok";
  } catch (error) {
    if (error instanceof ImportError) return error.code;
    throw error;
  }
};
/** "Import character" on a file: the §8 root check, then the whole validation (no engine here). */
const copyFileCode = async (bytes: Uint8Array) => {
  try {
    checkCopyRoot(bytes);
  } catch (error) {
    if (error instanceof ImportError) return error.code;
    throw error;
  }
  const v = await validateLocalCopy(bytes, { engine: false });
  return v.ok ? "copy" : v.code;
};
const fetchCode = async (
  url: string,
  fetchFn: typeof fetch,
  signal = new AbortController().signal,
) => {
  try {
    await fetchCopy(url, signal, fetchFn);
    return "copy";
  } catch (error) {
    if (error instanceof ImportError) return error.code;
    throw error;
  }
};
const json = (bytes: Uint8Array) => () =>
  new Response(bytes as BlobPart, { status: 200, headers: { "content-type": "application/json" } });

describe("§8 matrix by file: the three entrances", () => {
  const MATRIX: [string, string, string, string][] = [
    // input, character-copy, pack, encounter
    ["copy2", "copy", "root_kind_not_allowed", "root_kind_not_allowed"],
    ["copy1", "format_unsupported", "root_kind_not_allowed", "root_kind_not_allowed"],
    ["copy3", "format_newer", "root_kind_not_allowed", "root_kind_not_allowed"],
    ["t-character", "root_kind_not_allowed", "root_kind_not_allowed", "root_kind_not_allowed"],
    ["raw-build", "root_kind_not_allowed", "root_kind_not_allowed", "root_kind_not_allowed"],
    ["raw-state", "root_kind_not_allowed", "root_kind_not_allowed", "root_kind_not_allowed"],
    ["raw-encounter", "root_kind_not_allowed", "root_kind_not_allowed", "root_kind_not_allowed"],
    ["bundle", "format_adapter_required", "format_adapter_required", "format_adapter_required"],
    ["t-pack", "root_kind_not_allowed", "ok", "root_kind_not_allowed"],
  ];
  it.each(MATRIX)(
    "%s: character-copy %s, pack %s, encounter %s",
    async (input, copy, pack, encounter) => {
      const bytes = INPUTS[input] as Uint8Array;
      expect(await copyFileCode(bytes)).toBe(copy);
      const files = { files: [{ name: `${input}.json`, bytes }] };
      expect(await graphCode(files, env("pack"))).toBe(pack);
      expect(await graphCode(files, env("encounter"))).toBe(encounter);
    },
  );

  it("t-encounter: only Encounters takes it, with its packs and party as files", async () => {
    const files = [
      "encounters/mixed-duel.transfer.json",
      "characters/sable.r1.transfer.json",
      "characters/wren.r2.transfer.json",
      "packs/synthetic-a-2.0.0.transfer.json",
      "packs/synthetic-a-1.0.0.transfer.json",
    ].map(fileOf);
    expect(await graphCode({ files }, env("encounter"))).toBe("ok");
    expect(await graphCode({ files }, env("pack"))).toBe("root_kind_not_allowed");
    expect(await copyFileCode(INPUTS["t-encounter"] as Uint8Array)).toBe("root_kind_not_allowed");
  });

  it("file sets: a character alone in Encounters, a character file in a pack's set, two copies, an unrelated character", async () => {
    // F02: a character (with its pack) is no encounter.
    expect(
      await graphCode(
        {
          files: [
            fileOf("characters/wren.r1.transfer.json"),
            fileOf("packs/synthetic-a-1.0.0.transfer.json"),
          ],
        },
        env("encounter"),
      ),
    ).toBe("root_kind_not_allowed");
    // F04: a pack whose set brings a character: not something a pack import may bring in.
    const ext = fixtureJson("packs/synthetic-a-1.0.0.transfer.json");
    const wren = fixtureJson("characters/wren.r1.transfer.json");
    ext.requires = [
      ...ext.requires,
      {
        kind: "character",
        id: wren.id,
        revision: wren.revision,
        sha256: wren.sha256,
        href: null,
        bytes_sha256: null,
      },
    ];
    expect(
      await graphCode(
        {
          files: [
            { name: "ext.json", bytes: enc(ext) },
            { name: "wren.json", bytes: enc(wren) },
          ],
        },
        env("pack"),
      ),
    ).toBe("dependency_not_allowed");
    // F06: an encounter and an unrelated character: two roots.
    expect(
      await graphCode(
        {
          files: [
            fileOf("encounters/mixed-duel.transfer.json"),
            fileOf("characters/sable.r1.transfer.json"),
            fileOf("characters/wren.r1.transfer.json"),
            fileOf("packs/synthetic-a-2.0.0.transfer.json"),
            fileOf("packs/synthetic-a-1.0.0.transfer.json"),
          ],
        },
        env("encounter"),
      ),
    ).toBe("several_roots");
  });
});

describe("§8 by URL and pointer", () => {
  const ptr = (kind: string, href: string, sha: string) =>
    enc({
      format: "srd-table.library-pointer/1",
      kind,
      id: "x/y",
      title: "Y",
      current: {
        href,
        bytes_sha256: null as unknown as string,
        sha256: sha,
        version: null,
        revision: null,
      },
      history: [],
    });
  async function pointerTo(kind: string, target: Uint8Array, sha = copy2.payload_sha256) {
    const bytesSha = await sha256Hex(target);
    const p = JSON.parse(new TextDecoder().decode(ptr(kind, `../s/${bytesSha}.json`, sha)));
    p.current.bytes_sha256 = bytesSha;
    return {
      fetch: libraryFetch({
        [`${LIB}d/p.json`]: json(enc(p)),
        [`${LIB}s/${bytesSha}.json`]: json(target),
      }),
      url: `${LIB}d/p.json`,
    };
  }

  it("Import character: a copy by URL, or a character pointer to one (its payload hash checked)", async () => {
    const direct = libraryFetch({ [`${LIB}c.json`]: json(INPUTS.copy2 as Uint8Array) });
    const got = await fetchCopy(`${LIB}c.json`, new AbortController().signal, direct);
    expect(got).toMatchObject({ name: "c.json", expect: null });
    expect(await sha256Hex(got.bytes)).toBe(await sha256Hex(INPUTS.copy2 as Uint8Array));
    const p = await pointerTo("character", INPUTS.copy2 as Uint8Array);
    const viaPointer = await fetchCopy(p.url, new AbortController().signal, p.fetch);
    expect(viaPointer.expect).toBe(copy2.payload_sha256);
    expect(await sha256Hex(viaPointer.bytes)).toBe(await sha256Hex(INPUTS.copy2 as Uint8Array));
  });

  it("pointer kinds: pack → copy is a mismatch everywhere; character → transfer character is no root", async () => {
    const packToCopy = await pointerTo("pack", INPUTS.copy2 as Uint8Array);
    expect(await fetchCode(packToCopy.url, packToCopy.fetch)).toBe("pointer_target_mismatch");
    for (const allowed of ["pack", "encounter"] as const)
      expect(
        await graphCode({ url: packToCopy.url }, env(allowed, { fetch: packToCopy.fetch })),
      ).toBe("pointer_target_mismatch");
    // An old library snapshot (character pointer → character transfer): not a character import.
    expect(await fetchCode(`${LIB}d/character/wren.json`, libraryFetch())).toBe(
      "root_kind_not_allowed",
    );
    for (const allowed of ["pack", "encounter"] as const)
      expect(await graphCode({ url: `${LIB}d/character/wren.json` }, env(allowed))).toBe(
        "root_kind_not_allowed",
      );
    // A character pointer to a copy, at the other entrances.
    const charToCopy = await pointerTo("character", INPUTS.copy2 as Uint8Array);
    for (const allowed of ["pack", "encounter"] as const)
      expect(
        await graphCode({ url: charToCopy.url }, env(allowed, { fetch: charToCopy.fetch })),
      ).toBe("root_kind_not_allowed");
    // Pack and encounter pointers keep working at their own entrance.
    expect(await graphCode({ url: `${LIB}d/pack/synthetic-a.json` }, env("pack"))).toBe("ok");
    expect(await graphCode({ url: `${LIB}d/encounter/mixed-duel.json` }, env("encounter"))).toBe(
      "ok",
    );
    expect(await fetchCode(`${LIB}d/pack/synthetic-a.json`, libraryFetch())).toBe(
      "root_kind_not_allowed",
    );
    expect(await fetchCode(snapshot("a1"), libraryFetch())).toBe("root_kind_not_allowed");
  });

  it("the copy URL's bounds: a stream with no Content-Length counted to 20 MiB, redirects, another origin, changed bytes, cancel", async () => {
    // 21 MiB in 1 MiB chunks, no Content-Length: refused while it streams.
    let pulled = 0;
    const chunk = new Uint8Array(2 ** 20).fill(32);
    const endless = libraryFetch({
      [`${LIB}big.json`]: () =>
        new Response(
          new ReadableStream({
            pull(c) {
              pulled += 1;
              if (pulled > 21) c.close();
              else c.enqueue(chunk);
            },
          }),
          { status: 200 },
        ),
    });
    expect(await fetchCode(`${LIB}big.json`, endless)).toBe("limit_resource_bytes");
    expect(pulled).toBeLessThanOrEqual(22);
    expect(LOCAL_COPY_LIMITS.copyBytes).toBe(20 * 2 ** 20);
    const redirect = libraryFetch({
      [`${LIB}r.json`]: () =>
        new Response(null, { status: 302, headers: { location: "https://other.test/c.json" } }),
    });
    expect(await fetchCode(`${LIB}r.json`, redirect)).toBe("redirect_refused");
    // A pointer whose target is on another origin.
    const bytesSha = await sha256Hex(INPUTS.copy2 as Uint8Array);
    const cross = JSON.parse(
      new TextDecoder().decode(ptr("character", "https://other.test/c.json", copy2.payload_sha256)),
    );
    cross.current.bytes_sha256 = bytesSha;
    const crossFetch = libraryFetch({
      [`${LIB}x.json`]: json(enc(cross)),
      "https://other.test/c.json": json(INPUTS.copy2 as Uint8Array),
    });
    expect(await fetchCode(`${LIB}x.json`, crossFetch)).toBe("dependency_cross_origin");
    expect(crossFetch.calls).not.toContain("https://other.test/c.json");
    // The pointer's bytes hash no longer matches what is served.
    const changed = await pointerTo("character", INPUTS.copy2 as Uint8Array);
    const tampered = libraryFetch({
      [changed.url]: async () => (await changed.fetch(changed.url)).clone(),
      [`${LIB}s/${bytesSha}.json`]: json(INPUTS.copy1 as Uint8Array),
    });
    expect(await fetchCode(changed.url, tampered)).toBe("bytes_mismatch");
    // Cancel: an aborted signal stops before anything is fetched.
    const aborted = new AbortController();
    aborted.abort();
    const calls = libraryFetch({ [`${LIB}c.json`]: json(INPUTS.copy2 as Uint8Array) });
    expect(await fetchCode(`${LIB}c.json`, calls, aborted.signal)).toBe("cancelled");
    expect(calls.calls).toHaveLength(0);
    // Schemes and credentials, as F-008.
    expect(await fetchCode("http://host.test/c.json", libraryFetch())).toBe("url_scheme");
    expect(await fetchCode("https://u:p@host.test/c.json", libraryFetch())).toBe("url_credentials");
  });
});
