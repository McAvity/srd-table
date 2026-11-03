// @vitest-environment node
// kenli F-014 T02: the site publisher ported from dnd5 tools/migration/app (pointers.test.ts cases
// kept: legacy/current/bridge, database downgrade, foreign pointer), plus the SRD pack, the closed
// allowlist, conflicts and an interruption at every write.

import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CURRENT_POINTER, LEGACY_POINTER, MANIFEST } from "../../scripts/publish/lib";
import {
  publishRelease,
  readSrd,
  readStaging,
  siteManifest,
  siteProblems,
} from "../../scripts/publish/site";
import { BASE, DATA4, DATA5, makeRelease, makeSrd, put, refused, tmp, tree } from "./helpers";

const SRD = makeSrd();
const pub = (
  site: string,
  rel: ReturnType<typeof makeRelease>,
  o: { bridge?: boolean; srd?: string } = {},
) =>
  publishRelease(site, readStaging(rel.dir), readSrd(o.srd ?? SRD), {
    base: BASE,
    version: rel.version as string,
    bridge: o.bridge,
  });
const pointer = (site: string, p: string) =>
  existsSync(join(site, p))
    ? (JSON.parse(readFileSync(join(site, p), "utf8")).release_id as string)
    : null;

describe("pointers (dnd5 F-002 T07 protocol, unchanged)", () => {
  const A = makeRelease("a", { version: "0.1.0", data: DATA4 });
  const B0 = makeRelease("b0", { version: "0.1.1", data: DATA4 });
  const B1 = makeRelease("b1", { version: "0.2.0", data: DATA5 });

  it("one pointer, then the bridge, then the current pointer only; everything kept", async () => {
    const site = tmp("site");
    pub(site, A);
    expect(pointer(site, LEGACY_POINTER)).toBe(A.id);
    expect(pointer(site, CURRENT_POINTER)).toBeNull();
    expect(existsSync(join(site, "content/srd-5.2.1/manifest.json"))).toBe(true);
    const afterA = tree(site);
    // a newer database without a bridge: its legacy clients could never take it
    await refused(() => pub(site, B1), "bridge_required");
    expect(tree(site)).toEqual(afterA);
    pub(site, B0, { bridge: true });
    expect(pointer(site, LEGACY_POINTER)).toBe(B0.id);
    expect(pointer(site, CURRENT_POINTER)).toBe(B0.id);
    pub(site, B1);
    expect(pointer(site, LEGACY_POINTER)).toBe(B0.id);
    expect(pointer(site, CURRENT_POINTER)).toBe(B1.id);
    const now = tree(site);
    for (const [p, h] of Object.entries(afterA))
      if (!["index.html", LEGACY_POINTER, ".srd-table-deploy.json", MANIFEST].includes(p))
        expect(now[p], p).toBe(h);
    expect(readFileSync(join(site, "index.html"))).toEqual(
      readFileSync(join(B1.dir, `releases/${B1.id}/index.html`)),
    );
    expect(siteProblems(site)).toEqual([]);
    // an older database again is refused, as is a second bridge
    const A2 = makeRelease("a2", { version: "0.3.0", data: DATA4 });
    await refused(() => pub(site, A2), "release_downgrade");
    const B2 = makeRelease("b2", { version: "0.3.0", data: DATA5 });
    await refused(() => pub(site, B2, { bridge: true }), "bridge_exists");
  });

  it("a lower version than the site's newest is refused, even with the same database", async () => {
    const site = tmp("site");
    pub(site, makeRelease("n2", { version: "0.2.0" }));
    await refused(() => pub(site, makeRelease("n1", { version: "0.1.9" })), "version_not_newer");
    await refused(
      () => pub(site, makeRelease("n3", { version: "0.2.0-rc.3" })),
      "version_not_newer",
    );
  });

  it("a pointer nobody can vouch for is refused", async () => {
    const site = tmp("site");
    put(site, CURRENT_POINTER, "{}");
    await refused(() => pub(site, A), "site_unmarked");
  });
});

describe("refusals before any write", () => {
  const R = makeRelease("r", { version: "0.2.0" });

  it("the release: the version asked, its base, a clean build, every byte", async () => {
    await refused(
      () =>
        publishRelease(tmp("s"), readStaging(R.dir), readSrd(SRD), {
          base: BASE,
          version: "0.2.1",
        }),
      "version_mismatch",
    );
    await refused(
      () =>
        publishRelease(tmp("s"), readStaging(R.dir), readSrd(SRD), {
          base: "/dnd/",
          version: "0.2.0",
        }),
      "release_base",
    );
    const bad = tmp("bad");
    cpSync(R.dir, bad, { recursive: true });
    writeFileSync(join(bad, `assets/worker-r.js`), "tampered");
    await refused(() => readStaging(bad), "staging_invalid");
    const priv = tmp("priv");
    cpSync(R.dir, priv, { recursive: true });
    put(priv, "library/kenli.json", "{}");
    await refused(() => readStaging(priv), "staging_invalid");
    const link = tmp("link");
    cpSync(R.dir, link, { recursive: true });
    symlinkSync("/etc/hostname", join(link, "assets/extra.js"));
    await refused(() => readStaging(link), "staging_invalid");
    const desc = tmp("desc");
    cpSync(R.dir, desc, { recursive: true });
    writeFileSync(join(desc, `releases/${R.id}/release.json`), "{not json");
    await refused(() => readStaging(desc), "staging_invalid");
  });

  it("the SRD: present, flat JSON, the right pack", async () => {
    await refused(() => readSrd(tmp("empty")), "srd_missing");
    await refused(() => readSrd(makeSrd("x", { "notes.txt": "x" })), "srd_invalid");
    const sub = makeSrd("sub");
    mkdirSync(join(sub, "private"));
    await refused(() => readSrd(sub), "srd_invalid");
    const other = tmp("other");
    put(other, "manifest.json", JSON.stringify({ name: "kenli-private" }));
    await refused(() => readSrd(other), "srd_invalid");
    await refused(() => readSrd(SRD, "kenli-private"), "srd_invalid");
  });

  it("the site: allowlist, links, retained bytes, immutable and SRD paths", async () => {
    const site = tmp("site");
    pub(site, R);
    const before = tree(site);
    for (const foreign of [
      "library/x.json",
      "content/kenli-private/x.json",
      "f005/a.json",
      "notes.txt",
    ]) {
      const s = tmp("s");
      cpSync(site, s, { recursive: true });
      put(s, foreign, "{}");
      await refused(() => pub(s, makeRelease("r2", { version: "0.2.1" })), "site_foreign_file");
    }
    const linked = tmp("s");
    cpSync(site, linked, { recursive: true });
    symlinkSync("/etc/hostname", join(linked, "assets/x.js"));
    await refused(() => pub(linked, makeRelease("r3", { version: "0.2.1" })), "site_symlink");
    // SRD of the same path with other bytes: never overwritten
    await refused(
      () => pub(site, makeRelease("r4", { version: "0.2.1" }), { srd: makeSrd("changed") }),
      "content_conflict",
    );
    // a retained release file changed on disk
    const changed = tmp("s");
    cpSync(site, changed, { recursive: true });
    writeFileSync(join(changed, "assets/icon-r.png"), "other");
    await refused(() => pub(changed, makeRelease("r5", { version: "0.2.1" })), "site_invalid");
    expect(tree(site)).toEqual(before);
    // a newer engine's pack with another table changes the pack's manifest.json: refused too
    await refused(
      () =>
        pub(site, makeRelease("r6", { version: "0.2.1" }), {
          srd: makeSrd("a", { "feats.json": "[]" }),
        }),
      "content_conflict",
    );
    expect(tree(site)).toEqual(before);
    // the same pack again (byte-identical) is kept, not rewritten
    pub(site, makeRelease("r7", { version: "0.2.1" }));
    expect(siteProblems(site)).toEqual([]);
  });

  it("only srd-table's own files reach the site: a parent-workspace or private file is refused", async () => {
    // in the SRD directory, not named by the pack's manifest (even with an allowed-looking name)
    for (const [name, bytes] of [
      ["kenli-character.json", '{"name":"Kenli"}'],
      ["library.json", "[]"],
      ["notes.txt", "x"],
    ] as [string, string][])
      await refused(() => readSrd(makeSrd("p", {}, { [name]: bytes })), "srd_unlisted");
    // a manifest naming a file outside the pack's flat JSON layout
    const odd = tmp("odd");
    put(
      odd,
      "manifest.json",
      JSON.stringify({ name: "srd-5.2.1", tables: { x: { file: "../x.json" } } }),
    );
    await refused(() => readSrd(odd), "srd_invalid");
    // in the release staging directory (what scripts/release.ts did not write)
    for (const extra of [
      "docs/features/F-014/brief.md",
      "private/kenli.json",
      "content/srd-5.2.1/x.json",
      ".env",
    ]) {
      const d = tmp("stg");
      cpSync(R.dir, d, { recursive: true });
      put(d, extra, "x");
      await refused(() => readStaging(d), "staging_invalid");
    }
  });

  it("the publisher imports nothing outside this repository's scripts/publish (no parent runtime)", () => {
    const dir = join(process.cwd(), "scripts/publish");
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".ts"))) {
      const src = readFileSync(join(dir, f), "utf8");
      const specs = [
        ...src.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+"([^"]+)"/gm),
        ...src.matchAll(/\bimport\(\s*"([^"]+)"\s*\)/g),
      ].map((m) => m[1] as string);
      expect(specs.length, f).toBeGreaterThan(0);
      for (const spec of specs)
        expect(spec.startsWith("node:") || spec.startsWith("./"), `${f}: ${spec}`).toBe(true);
    }
  });

  it("the full manifest lists every file, the marker too", () => {
    const site = tmp("site");
    pub(site, R);
    const m = siteManifest(site);
    expect(m.files.map((f) => f.path)).toContain(".srd-table-deploy.json");
    expect(m.files.map((f) => f.path)).toContain("content/srd-5.2.1/spells.json");
    expect(m.total_bytes).toBe(m.files.reduce((s, f) => s + f.size, 0));
  });
});

describe("interrupted at every write", () => {
  it("every instant is readable and a rerun ends in the same site", () => {
    const A = makeRelease("ia", { version: "0.1.0" });
    const B = makeRelease("ib", { version: "0.2.0" });
    const reference = tmp("ref");
    pub(reference, A);
    pub(reference, B);
    const expected = tree(reference);
    let total = 0;
    for (let k = 0; ; k++) {
      const site = tmp("int");
      pub(site, A);
      let n = 0;
      let stopped = false;
      try {
        publishRelease(site, readStaging(B.dir), readSrd(SRD), {
          base: BASE,
          version: "0.2.0",
          hooks: {
            fault: ({ stage }) => {
              if (n++ === k) throw new Error(`killed at ${stage}`);
            },
          },
        });
      } catch {
        stopped = true;
      }
      if (!stopped) break;
      total++;
      expect(siteProblems(site), `instant ${k}`).toEqual([]);
      pub(site, B);
      const got = tree(site);
      expect(Object.keys(got).filter((p) => p.endsWith(".tmp"))).toEqual([]);
      expect(got).toEqual(expected);
    }
    expect(total).toBeGreaterThan(10);
  });
});
