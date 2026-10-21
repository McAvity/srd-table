// kenli F-007 T02: the release API, the SW's pure parts and the release graph (dnd5
// docs/features/F-007-offline-packs/contracts/offline.md §2, §7.1, §8). Unit level: fake
// ServiceWorkerContainer and synthetic graphs; the real browser behaviour is
// scripts/f007-release-probe.mjs.

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  descriptorProblems,
  RELEASE_INPUTS_FORMAT,
  type ReleaseDescriptor,
  type ReleaseInputs,
  releaseIdOf,
  safePath,
  swReleaseOf,
} from "@/offline/descriptor";
import {
  inspectRelease,
  isReleaseBuild,
  RELEASE_ID,
  ReleaseError,
  registerCurrentRelease,
  releaseOfScriptUrl,
} from "@/offline/release";
import {
  bytesMatch,
  cacheNameOf,
  completeKeyOf,
  routeOf,
  stamp,
  UPDATE_PROTO,
} from "@/offline/sw-core";
import { buildGraph } from "../../scripts/release/graph";

const sha = (s: string | Uint8Array) => createHash("sha256").update(s).digest("hex");
const ID = "r-0123456789abcdef";
const OTHER = "r-fedcba9876543210";
const BASE = "/dnd/";

// ───────────── a fake ServiceWorkerContainer ─────────────
type State = "installing" | "installed" | "activating" | "activated" | "redundant";
class FakeWorker extends EventTarget {
  posted: { msg: unknown; ports: MessagePort[] }[] = [];
  constructor(
    public scriptURL: string,
    public state: State,
    private onMessage?: (msg: unknown, ports: MessagePort[]) => void,
  ) {
    super();
  }
  postMessage(msg: unknown, ports: MessagePort[] = []) {
    this.posted.push({ msg, ports });
    this.onMessage?.(msg, ports);
  }
  set(state: State) {
    this.state = state;
    this.dispatchEvent(new Event("statechange"));
  }
}
function fakeContainer(
  opts: {
    existing?: FakeWorker;
    installEnds?: "activated" | "redundant";
    reply?: (port: MessagePort) => void;
  } = {},
) {
  const calls: { url: string; options: RegistrationOptions }[] = [];
  let reg:
    | { active: FakeWorker | null; waiting: FakeWorker | null; installing: FakeWorker | null }
    | undefined = opts.existing
    ? { active: opts.existing, waiting: null, installing: null }
    : undefined;
  const container = {
    async getRegistration(scope: string) {
      return scope === BASE ? reg : undefined;
    },
    async register(url: string, options: RegistrationOptions) {
      calls.push({ url, options });
      const w = new FakeWorker(`http://h${url}`, "installing", (_m, ports) =>
        opts.reply?.(ports[0] as MessagePort),
      );
      reg = { active: null, waiting: null, installing: w };
      const r = reg;
      setTimeout(() => {
        if (opts.installEnds === "redundant") w.set("redundant");
        else {
          r.installing = null;
          r.active = w;
          w.set("activated");
        }
      }, 5);
      return reg;
    },
  };
  return { container: container as unknown as ServiceWorkerContainer, calls, reg: () => reg };
}

describe("release API (offline.md §8)", () => {
  it("a test/dev build is not a release and can't be registered", async () => {
    expect(RELEASE_ID).toBe("r-dev");
    expect(isReleaseBuild()).toBe(false);
    const f = fakeContainer();
    await expect(registerCurrentRelease({ container: f.container })).rejects.toMatchObject({
      code: "release_dev_build",
    });
    expect(f.calls).toHaveLength(0);
  });

  it("registers only its own immutable root SW, scope = base, no HTTP cache for updates", async () => {
    const f = fakeContainer();
    await registerCurrentRelease({ container: f.container, releaseId: ID, base: BASE });
    expect(f.calls).toEqual([
      { url: `/dnd/sw-${ID}.js`, options: { scope: BASE, updateViaCache: "none" } },
    ]);
    expect(releaseOfScriptUrl(f.reg()?.active?.scriptURL, BASE)).toBe(ID);
  });

  it("never registers over another release (that is an update: consent and gates, T05)", async () => {
    const f = fakeContainer({
      existing: new FakeWorker(`http://h/dnd/sw-${OTHER}.js`, "activated"),
    });
    await expect(
      registerCurrentRelease({ container: f.container, releaseId: ID, base: BASE }),
    ).rejects.toMatchObject({
      code: "release_other_registered",
      detail: OTHER,
    });
    expect(f.calls).toHaveLength(0);
  });

  it("a failed install (bytes/quota/interruption) is reported, never treated as prepared", async () => {
    const f = fakeContainer({ installEnds: "redundant" });
    const err = await registerCurrentRelease({
      container: f.container,
      releaseId: ID,
      base: BASE,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ReleaseError);
    expect(err.code).toBe("release_install_failed");
  });

  it("inspection asks the active worker of THIS release; anything else is not complete", async () => {
    const none = fakeContainer();
    expect(await inspectRelease({ container: none.container, releaseId: ID, base: BASE })).toEqual({
      release_id: ID,
      complete: false,
      missing: ["service_worker"],
    });
    const other = fakeContainer({
      existing: new FakeWorker(`http://h/dnd/sw-${OTHER}.js`, "activated"),
    });
    expect(
      (await inspectRelease({ container: other.container, releaseId: ID, base: BASE })).complete,
    ).toBe(false);
    const w = new FakeWorker(`http://h/dnd/sw-${ID}.js`, "activated", (_m, ports) =>
      (ports[0] as MessagePort).postMessage({ release_id: ID, complete: true, missing: [] }),
    );
    const mine = fakeContainer({ existing: w });
    expect(await inspectRelease({ container: mine.container, releaseId: ID, base: BASE })).toEqual({
      release_id: ID,
      complete: true,
      missing: [],
    });
    expect(w.posted[0]?.msg).toEqual({ proto: "srd-table.release/1", type: "inspect" });
    const silent = fakeContainer({
      existing: new FakeWorker(`http://h/dnd/sw-${ID}.js`, "activated"),
    });
    expect(
      await inspectRelease({
        container: silent.container,
        releaseId: ID,
        base: BASE,
        timeoutMs: 20,
      }),
    ).toEqual({ release_id: ID, complete: false, missing: ["service_worker_unresponsive"] });
  });

  it("script URL → release only for sw-<id>.js directly under the base", () => {
    expect(releaseOfScriptUrl(`https://o/dnd/sw-${ID}.js`, BASE)).toBe(ID);
    for (const u of [
      `https://o/dnd/sw.js`,
      `https://o/other/sw-${ID}.js`,
      `https://o/dnd/x/sw-${ID}.js`,
      `https://o/dnd/sw-${ID}.js.map`,
      null,
      "",
    ])
      expect(releaseOfScriptUrl(u, BASE)).toBeNull();
  });
});

// ───────────── SW pure parts ─────────────
const R = {
  release_id: ID,
  base: BASE,
  html: `releases/${ID}/index.html`,
  files: [
    { path: `releases/${ID}/index.html`, sha256: "a".repeat(64), size: 1 },
    { path: `releases/${ID}/manifest.webmanifest`, sha256: "b".repeat(64), size: 1 },
    { path: "assets/index-AAAA.js", sha256: "c".repeat(64), size: 1 },
    { path: "assets/worker-BBBB.js", sha256: "d".repeat(64), size: 1 },
  ],
};
const O = "https://ubuntu.example";

describe("SW routing: own coherent release only, no SPA/stale fallback (offline.md §2.6)", () => {
  const cases: [string, string, string][] = [
    [`${O}/dnd/`, "navigate", "html"],
    [`${O}/dnd/index.html`, "navigate", "html"],
    [`${O}/dnd/?x=1#/characters`, "navigate", "html"],
    [`${O}/dnd/assets/index-AAAA.js`, "cors", "asset"],
    [`${O}/dnd/assets/worker-BBBB.js`, "same-origin", "asset"],
    [`${O}/dnd/releases/${ID}/manifest.webmanifest`, "cors", "asset"],
    [`${O}/dnd/assets/index-OTHER.js`, "cors", "network"],
    [`${O}/dnd/release.json`, "cors", "network"],
    [`${O}/dnd/releases/${ID}/release.json`, "cors", "network"],
    [`${O}/dnd/releases/${OTHER}/index.html`, "navigate", "network"],
    [`${O}/dnd/library/d/character/kenli.json`, "cors", "network"],
    [`${O}/dnd/library/manifest.json`, "navigate", "network"],
    [`${O}/dnd/content/srd-5.2.1/manifest.json`, "cors", "network"],
    [`${O}/dnd/f005/kenli7-r1-f005.transfer.json`, "navigate", "network"],
    [`${O}/dnd/characters`, "navigate", "network"],
    [`${O}/dnd5/`, "navigate", "network"],
    [`${O}/srd-table/assets/index-AAAA.js`, "cors", "network"],
    [`https://elsewhere.example/dnd/assets/index-AAAA.js`, "cors", "network"],
  ];
  it.each(cases)("%s (%s) → %s", (url, mode, kind) => {
    expect(routeOf({ url, mode }, O, R).kind).toBe(kind);
  });

  it("cache name and completeness marker are per base and release", () => {
    expect(cacheNameOf(R)).toBe(`srd-table:/dnd/:${ID}`);
    expect(completeKeyOf(R)).toBe(`/dnd/__release/${ID}/complete`);
  });

  it("bytes are accepted only with the listed size and SHA-256", async () => {
    const bytes = new TextEncoder().encode("hello").buffer;
    expect(await bytesMatch(bytes, { size: 5, sha256: sha("hello") })).toBe(true);
    expect(await bytesMatch(bytes, { size: 5, sha256: sha("hellO") })).toBe(false);
    expect(await bytesMatch(bytes, { size: 6, sha256: sha("hello") })).toBe(false);
  });
});

describe("relay stamp (offline.md §7.1)", () => {
  const src = { id: "client-uuid-b", url: `${O}/dnd/` };
  it("the SW stamps the real sender over any claim in the body", () => {
    const s = stamp(
      {
        proto: UPDATE_PROTO,
        type: "frozen",
        request_id: "u-1",
        source_client_id: "forged",
        source_url: "/x",
      },
      src,
      BASE,
    );
    expect(s).toMatchObject({ source_client_id: "client-uuid-b", source_url: "/dnd/" });
  });
  it("not a protocol message, no source, or a page outside the base: nothing relayed", () => {
    expect(stamp({ proto: "other", type: "frozen" }, src, BASE)).toBeNull();
    expect(stamp({ proto: UPDATE_PROTO }, src, BASE)).toBeNull();
    expect(stamp({ proto: UPDATE_PROTO, type: "freeze" }, null, BASE)).toBeNull();
    expect(
      stamp({ proto: UPDATE_PROTO, type: "freeze" }, { id: "f", url: `${O}/other/` }, BASE),
    ).toBeNull();
    expect(
      stamp({ proto: UPDATE_PROTO, type: "freeze" }, { id: "f", url: `${O}/dnd5/` }, BASE),
    ).toBeNull();
  });
});

// ───────────── release graph and descriptor ─────────────
const enc = (s: string) => new TextEncoder().encode(s);
function graphInput(
  over: { assets?: Record<string, string>; html?: string; manifest?: Record<string, object> } = {},
) {
  const assets = over.assets ?? {
    "assets/index-AAAA.js":
      'import("./Lazy-CCCC.js");new Worker(new URL(`/dnd/assets/worker-BBBB.js`,``+import.meta.url))',
    "assets/Lazy-CCCC.js": "export const x=1",
    "assets/worker-BBBB.js": "self.onmessage=()=>{}",
    "assets/index-DDDD.css": "@font-face{src:url(/dnd/assets/font-EEEE.woff2)}",
    "assets/font-EEEE.woff2": "font",
    "assets/icon-192-FFFF.png": "png",
  };
  return {
    assets: new Map(Object.entries(assets).map(([k, v]) => [k, enc(v)])),
    html: {
      path: `releases/${ID}/index.html`,
      text:
        over.html ??
        '<script src="/dnd/assets/index-AAAA.js"></script><link href="/dnd/assets/index-DDDD.css">',
    },
    webmanifest: {
      path: `releases/${ID}/manifest.webmanifest`,
      text: '{"icons":[{"src":"/dnd/assets/icon-192-FFFF.png"}]}',
    },
    viteManifest: (over.manifest ?? {
      "index.html": {
        file: "assets/index-AAAA.js",
        isEntry: true,
        dynamicImports: ["src/Lazy.tsx"],
        css: ["assets/index-DDDD.css"],
        assets: ["assets/font-EEEE.woff2"],
      },
      "src/Lazy.tsx": { file: "assets/Lazy-CCCC.js", isDynamicEntry: true },
    }) as never,
    base: BASE,
  };
}

describe("release graph (offline.md §2.3)", () => {
  it("closed graph: lazy chunks, the scanned engine worker, CSS fonts and manifest icons; roles", () => {
    const g = buildGraph(graphInput());
    expect(g.problems).toEqual([]);
    expect(Object.fromEntries(g.roles)).toEqual({
      "assets/index-AAAA.js": "entry",
      "assets/Lazy-CCCC.js": "chunk",
      "assets/worker-BBBB.js": "worker",
      "assets/index-DDDD.css": "css",
      "assets/font-EEEE.woff2": "font",
      "assets/icon-192-FFFF.png": "icon",
    });
    expect(g.edges).toContainEqual(["assets/index-AAAA.js", "assets/worker-BBBB.js"]);
  });
  it("a reference to a missing file, an orphan file, no worker and no single entry fail", () => {
    expect(
      buildGraph(
        graphInput({
          html: '<script src="/dnd/assets/index-AAAA.js"></script><script src="/dnd/assets/gone-0000.js"></script><link href="/dnd/assets/index-DDDD.css">',
        }),
      ).problems,
    ).toContain(`release_graph_missing: releases/${ID}/index.html → assets/gone-0000.js`);
    const orphan = graphInput();
    orphan.assets.set("assets/stray-1111.js", enc("x"));
    expect(buildGraph(orphan).problems).toContain("release_graph_orphan: assets/stray-1111.js");
    const noWorker = graphInput({
      assets: {
        "assets/index-AAAA.js": 'import("./Lazy-CCCC.js")',
        "assets/Lazy-CCCC.js": "",
        "assets/index-DDDD.css": "",
        "assets/font-EEEE.woff2": "",
        "assets/icon-192-FFFF.png": "",
      },
    });
    expect(buildGraph(noWorker).problems.some((p) => p.startsWith("release_worker"))).toBe(true);
    const two = graphInput({
      manifest: {
        "index.html": { file: "assets/index-AAAA.js", isEntry: true },
        "x.html": { file: "assets/Lazy-CCCC.js", isEntry: true },
      },
    });
    expect(buildGraph(two).problems.some((p) => p.startsWith("release_entry"))).toBe(true);
    const viteGone = graphInput({
      manifest: {
        "index.html": {
          file: "assets/index-AAAA.js",
          isEntry: true,
          dynamicImports: ["src/Gone.tsx"],
        },
      },
    });
    expect(buildGraph(viteGone).problems).toContain(
      "release_graph_missing: vite manifest index.html imports src/Gone.tsx",
    );
  });
});

describe("release id and descriptor (offline.md §2.2, §2.4)", () => {
  const inputs: ReleaseInputs = {
    format: RELEASE_INPUTS_FORMAT,
    base: BASE,
    table_commit: "4".repeat(40),
    engine_commit: "f".repeat(40),
    protocol: 1,
    data: {
      db_version: 4,
      history_schema: "kenli.history/1",
      history_meta_schema: "kenli.history-meta/1",
      transfer_formats: ["srd-table.transfer/1"],
      local_copy_formats: ["srd-table.local-copy/1"],
    },
    toolchain: { bun: "1.3.10", vite: "8.3.2" },
  };
  it("the id comes from inputs only: same inputs same id; a variant, another base or commit differ", () => {
    const id = releaseIdOf(inputs, sha);
    expect(id).toMatch(/^r-[0-9a-f]{16}$/);
    expect(releaseIdOf({ ...inputs }, sha)).toBe(id);
    for (const o of [
      { variant: "b" },
      { base: "/x/" },
      { table_commit: "5".repeat(40) },
      { dirty: true as const },
    ])
      expect(releaseIdOf({ ...inputs, ...o }, sha)).not.toBe(id);
  });
  it("paths: traversal, absolute, encoded, hidden and query are unsafe", () => {
    for (const p of ["assets/a.js", "releases/r-0/index.html"]) expect(safePath(p)).toBe(true);
    for (const p of [
      "../x",
      "assets/../library/x",
      "/assets/x",
      "assets/%2e%2e/x",
      "assets/.env",
      "assets/x?y",
      "a\\b",
      "",
    ])
      expect(safePath(p)).toBe(false);
  });
  it("a descriptor from the graph validates; excluded paths and identity changes are refused", () => {
    const id = releaseIdOf(inputs, sha);
    const g = buildGraph(graphInput());
    const f = (path: string, size = 10) => ({ path, sha256: sha(path), size });
    const d: ReleaseDescriptor = {
      format: "srd-table.release/1",
      release_id: id,
      base: BASE,
      inputs,
      sw: f(`sw-${id}.js`),
      html: f(`releases/${id}/index.html`),
      webmanifest: {
        ...f(`releases/${id}/manifest.webmanifest`),
        id: BASE,
        start_url: BASE,
        scope: BASE,
      },
      assets: [...g.roles]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([path, role]) => ({ ...f(path), role })),
      graph: {
        roots: [`releases/${id}/index.html`, `releases/${id}/manifest.webmanifest`],
        edges: g.edges.map(([a, b]) => [a.replace(ID, id), b.replace(ID, id)] as [string, string]),
      },
      total_bytes: 80,
    };
    expect(descriptorProblems(d, sha)).toEqual([]);
    expect(swReleaseOf(d).files.map((x) => x.path)).not.toContain(d.sw.path);
    const bad = (o: Partial<ReleaseDescriptor>) => descriptorProblems({ ...d, ...o }, sha);
    expect(
      bad({ release_id: "r-0000000000000000" }).some((e) => e.startsWith("release_id_mismatch")),
    ).toBe(true);
    expect(
      bad({
        assets: [
          ...d.assets,
          {
            path: "content/kenli-pack/manifest.json",
            sha256: "a".repeat(64),
            size: 1,
            role: "static",
          },
        ],
      }).some((e) => e.startsWith("release_excluded_path")),
    ).toBe(true);
    expect(
      bad({ webmanifest: { ...d.webmanifest, scope: "/srd-table/" } }).some((e) =>
        e.startsWith("release_manifest_identity"),
      ),
    ).toBe(true);
    expect(
      bad({ sw: f(`releases/${id}/sw.js`) }).some((e) => e.startsWith("release_sw_path")),
    ).toBe(true);
  });
});
