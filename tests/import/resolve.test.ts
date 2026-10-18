/**
 * The import graph (kenli F-008 contract §5): the same graph from a library URL and from files,
 * deduplicated, with the SRD served by the app; every refusal before anything is written —
 * limits (with and without Content-Length), redirects, HTML, other origins, cycles, conflicting
 * bytes for one pack version, a changed snapshot, a cancel and a timeout.
 */

import { describe, expect, it } from "vitest";
import { checkUrl } from "../../src/import/fetch";
import { type Environment, type Graph, resolveGraph, type Source } from "../../src/import/resolve";
import {
  characterKeys,
  checkEnvelope,
  type Envelope,
  ImportError,
  recognize,
  remapEncounter,
} from "../../src/import/transfer";
import { contentSha, packRefOf } from "../../src/lib/canonical";
import {
  fileOf,
  fixtureBytes,
  fixtureJson,
  LIB,
  libraryFetch,
  refs,
  snapshot,
} from "../helpers/transfer";

const env = (over: Partial<Environment> = {}): Environment => ({
  installed: [],
  served: [refs.srd],
  installation: null,
  localCharacter: async () => null,
  signal: new AbortController().signal,
  fetch: libraryFetch(),
  ...over,
});
const code = async (source: Source, e: Environment = env()) => {
  try {
    await resolveGraph(source, e);
    return "ok";
  } catch (error) {
    return error instanceof ImportError ? error.code : `other: ${String(error)}`;
  }
};
const keys = (g: Graph) => (g.kind === "transfer" ? g.nodes.map((n) => n.key.split("#")[0]) : []);

describe("transfer format", () => {
  it("canonical identities match the contract fixtures", async () => {
    const a1 = fixtureJson("packs/synthetic-a-1.0.0.transfer.json") as Envelope;
    expect(await packRefOf(a1.content.files as never)).toEqual(refs["synthetic-a@1.0.0"]);
    expect(await contentSha(a1.content)).toBe(a1.sha256);
  });

  it("recognizes envelopes, pointers, raw documents and refuses the rest", () => {
    expect(recognize(fixtureBytes("packs/synthetic-a-1.0.0.transfer.json")).kind).toBe("envelope");
    expect(recognize(fixtureBytes("library/d/pack/synthetic-a.json")).kind).toBe("pointer");
    const refused = (rel: string, type: string | null = null) => {
      try {
        recognize(fixtureBytes(rel), type);
        return "ok";
      } catch (e) {
        return (e as ImportError).code;
      }
    };
    expect(refused("negative/format-newer.json")).toBe("format_newer");
    expect(refused("negative/kenli-bundle.json")).toBe("format_adapter_required");
    expect(refused("negative/login-page.html")).toBe("content_html");
    expect(refused("packs/synthetic-a-1.0.0.transfer.json", "text/html")).toBe("content_html");
    expect(refused("negative/not-json.json")).toBe("not_json");
  });

  it("checks envelopes strictly (contract negatives)", async () => {
    const check = async (rel: string) => {
      try {
        await checkEnvelope(fixtureJson(rel));
        return "ok";
      } catch (e) {
        return (e as ImportError).code;
      }
    };
    expect(await check("characters/wren.r2.transfer.json")).toBe("ok");
    expect(await check("encounters/pending-join.transfer.json")).toBe("ok");
    expect(await check("negative/unknown-envelope-field.transfer.json")).toBe(
      "envelope_unknown_field",
    );
    expect(await check("negative/hash-mismatch.transfer.json")).toBe("hash_mismatch");
    expect(await check("negative/state-origin-mismatch.transfer.json")).toBe(
      "state_origin_mismatch",
    );
    expect(await check("negative/requires-missing.transfer.json")).toBe("requires_mismatch");
    expect(await check("negative/encounter-party-unmapped.transfer.json")).toBe(
      "party_unmapped_key",
    );
    expect(await check("negative/pending-party-unmapped.transfer.json")).toBe("party_unmapped_key");
  });

  it("remaps every character key, a pending add_character too", () => {
    const enc = fixtureJson("encounters/pending-join.transfer.json").content.encounter;
    expect(characterKeys(enc).sort()).toEqual(["sable", "wren"]);
    const r = remapEncounter(enc, { wren: "c-1", sable: "c-2" });
    expect(r.combatants.map((c: { character: string | null }) => c.character)).toEqual([
      "c-1",
      null,
    ]);
    expect(r.pending.action.character).toBe("c-2");
    expect(() => remapEncounter(enc, { wren: "c-1" })).toThrow(/party_unmapped_key/);
  });

  it("URL policy: https, loopback http, no credentials, dependencies on the root's origin", () => {
    expect(checkUrl(`${LIB}d/pack/x.json`).href).toBe(`${LIB}d/pack/x.json`);
    expect(checkUrl("http://127.0.0.1:5173/x.json#frag").href).toBe("http://127.0.0.1:5173/x.json");
    const refused = (u: string, base?: string) => {
      try {
        checkUrl(u, base ? new URL(base) : undefined);
        return "ok";
      } catch (e) {
        return (e as ImportError).code;
      }
    };
    expect(refused("http://host.test/x.json")).toBe("url_scheme");
    expect(refused("https://u:p@host.test/x.json")).toBe("url_credentials");
    expect(refused("file:///etc/passwd")).toBe("url_scheme");
    expect(refused("https://other.test/x.json", `${LIB}s/a.json`)).toBe("dependency_cross_origin");
    expect(refused("//other.test/x.json", `${LIB}s/a.json`)).toBe("dependency_cross_origin");
  });
});

describe("resolving the graph", () => {
  it("a library pointer: the whole graph, each node once, the SRD served by the app", async () => {
    const fetch = libraryFetch();
    const g = await resolveGraph({ url: `${LIB}d/encounter/mixed-duel.json` }, env({ fetch }));
    if (g.kind !== "transfer") throw new Error("raw");
    expect(keys(g).sort()).toEqual(
      [
        "character:synthetic/sable",
        "character:synthetic/wren",
        "encounter:synthetic/mixed-duel",
        "pack:synthetic-a@1.0.0",
        "pack:synthetic-a@2.0.0",
      ].sort(),
    );
    expect(g.nodes.at(-1)?.envelope.kind).toBe("encounter");
    expect(g.satisfied.map((s) => s.by)).toEqual(["served"]);
    expect(fetch.calls).toHaveLength(6); // pointer + 5 snapshots: synthetic-a 1.0.0 fetched once
    expect(new Set(fetch.calls).size).toBe(6);
  });

  it("files give the same graph as the URL (parity), matched by hash, not by name", async () => {
    const files = [
      "encounters/mixed-duel.transfer.json",
      "characters/sable.r1.transfer.json",
      "characters/wren.r2.transfer.json",
      "packs/synthetic-a-2.0.0.transfer.json",
      "packs/synthetic-a-1.0.0.transfer.json",
    ].map((rel, i) => ({ ...fileOf(rel), name: `renamed-${i}.json` }));
    const byFile = await resolveGraph({ files }, env());
    const byUrl = await resolveGraph({ url: snapshot("encounter") }, env());
    expect(keys(byFile).sort()).toEqual(keys(byUrl).sort());
    expect(await code({ files: [fileOf("encounters/mixed-duel.transfer.json")] })).toBe(
      "dependency_missing",
    );
  });

  it("installed packs satisfy dependencies; another version coexists; other bytes conflict", async () => {
    const a1 = refs["synthetic-a@1.0.0"];
    const g = await resolveGraph({ url: snapshot("wren") }, env({ installed: [a1] }));
    if (g.kind !== "transfer") throw new Error("raw");
    expect(g.satisfied.map((s) => s.by).sort()).toEqual(["installed", "served"]);
    expect(await code({ url: snapshot("sable") }, env({ installed: [a1] }))).toBe("ok");
    expect(
      await code(
        { files: [fileOf("negative/pack-same-version-other-bytes.transfer.json")] },
        env({ installed: [a1] }),
      ),
    ).toBe("pack_identity_conflict");
  });

  it("refuses cycles, changed snapshots, other origins, redirects, HTML and HTTP errors", async () => {
    expect(
      await code({
        files: [fileOf("negative/cycle-x.transfer.json"), fileOf("negative/cycle-y.transfer.json")],
      }),
    ).toBe("dependency_cycle");
    expect(await code({ files: [fileOf("negative/cycle-x.transfer.json")] })).toBe(
      "dependency_missing",
    );
    const changed = { ...fixtureJson(`library/s/${refs.bytes.sable}.json`), title: "changed" };
    const tampered = libraryFetch({
      [snapshot("sable")]: () => new Response(JSON.stringify(changed), { status: 200 }),
    });
    expect(await code({ url: `${LIB}d/encounter/mixed-duel.json` }, env({ fetch: tampered }))).toBe(
      "bytes_mismatch",
    );
    const redirect = libraryFetch({
      [`${LIB}d/x.json`]: () =>
        new Response(null, { status: 302, headers: { location: "https://other.test/" } }),
    });
    expect(await code({ url: `${LIB}d/x.json` }, env({ fetch: redirect }))).toBe(
      "redirect_refused",
    );
    const html = libraryFetch({
      [`${LIB}d/x.json`]: () =>
        new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } }),
    });
    expect(await code({ url: `${LIB}d/x.json` }, env({ fetch: html }))).toBe("content_html");
    expect(await code({ url: `${LIB}d/missing.json` })).toBe("http_status");
    expect(await code({ url: "https://offline.test/x.json" })).toBe("fetch_failed");
    expect(await code({ url: "http://host.test/x.json" })).toBe("url_scheme");
  });

  it("limits: resources, depth, bytes with a false or missing Content-Length", async () => {
    const url = `${LIB}d/encounter/mixed-duel.json`;
    expect(await code({ url }, env({ limits: { resources: 3 } }))).toBe("limit_resources");
    expect(await code({ url }, env({ limits: { depth: 1 } }))).toBe("limit_depth");
    expect(await code({ url }, env({ limits: { resourceBytes: 4096 } }))).toBe(
      "limit_resource_bytes",
    );
    expect(await code({ url }, env({ limits: { totalBytes: 20_000 } }))).toBe("limit_total_bytes");
    // A stream with no Content-Length (and one that lies) is counted as it arrives.
    const big = new Uint8Array(5000).fill(32);
    const stream = (len?: string) => () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(big);
            c.enqueue(big);
            c.close();
          },
        }),
        { status: 200, headers: len ? { "content-length": len } : {} },
      );
    for (const len of [undefined, "10"]) {
      const f = libraryFetch({ [`${LIB}d/big.json`]: stream(len) });
      expect(
        await code({ url: `${LIB}d/big.json` }, env({ fetch: f, limits: { resourceBytes: 8000 } })),
      ).toBe("limit_resource_bytes");
    }
    const declared = libraryFetch({
      [`${LIB}d/big.json`]: () =>
        new Response("{}", { status: 200, headers: { "content-length": "99999999999" } }),
    });
    expect(await code({ url: `${LIB}d/big.json` }, env({ fetch: declared }))).toBe(
      "limit_resource_bytes",
    );
  });

  it("cancel and timeout stop everything", async () => {
    const hanging = libraryFetch({
      [`${LIB}d/slow.json`]: (init) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    });
    const controller = new AbortController();
    const pending = code(
      { url: `${LIB}d/slow.json` },
      env({ fetch: hanging, signal: controller.signal }),
    );
    controller.abort();
    expect(await pending).toBe("cancelled");
    expect(
      await code({ url: `${LIB}d/slow.json` }, env({ fetch: hanging, limits: { resourceMs: 20 } })),
    ).toBe("timeout");
  });
});
