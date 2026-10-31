// @vitest-environment node
/**
 * kenli F-011 T09 (dnd5 contracts/changes.md §9): the library CLI, run as dnd5's generator runs it
 * (`bun scripts/export-library-character.ts <mode> --input <abs> --out <abs>`, cwd = Table) on the
 * Table's pinned engine. Its two modes, the request rules and exit codes (Q05–Q17 of
 * examples/cli-modes.json on real documents), deterministic output, a portrait, a custom item
 * (state v3), and — the same bytes read by the codec on Node's engine (the CLI's adapter) and by the
 * browser wrapper's adapter (an in-process app engine and an image decoder) — identical results,
 * valid and tampered alike.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { nodeFacade } from "../../src/engine/node";
import { validateLocalCopyWith } from "../../src/import/localCopy/codec";
import { fighter } from "../fixtures/characters";
import { gif, png, spyDecoder } from "../helpers/images";

const TABLE = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = join(TABLE, "scripts/export-library-character.ts");
const AT = 1_793_404_800_000;
// biome-ignore lint/suspicious/noExplicitAny: requests are edited freely here
type Loose = any;

function cli(
  mode: string,
  request: unknown,
  files: Record<string, Uint8Array | string> = {},
  args?: string[],
) {
  const dir = mkdtempSync(join(tmpdir(), "f011-cli-"));
  for (const [name, bytes] of Object.entries(files)) writeFileSync(join(dir, name), bytes);
  const input = join(dir, "request.json");
  writeFileSync(
    input,
    JSON.stringify(request, (_k, v) => (typeof v === "string" ? v.replaceAll("$DIR", dir) : v)),
  );
  const out = join(dir, "out.json");
  const r = spawnSync("bun", [SCRIPT, mode, ...(args ?? ["--input", input, "--out", out])], {
    cwd: TABLE,
    encoding: "utf8",
    timeout: 120_000,
  });
  let refusal: { code?: string } = {};
  try {
    refusal = JSON.parse(r.stderr.trim().split("\n").pop() || "{}");
  } catch {}
  const bytes = r.status === 0 ? new Uint8Array(readFileSync(out)) : null;
  return { status: r.status, code: refusal.code, bytes, dir };
}

let build: Loose;
let srd: Loose;
const context = () => ({ packs: [srd], sources: null });
const character = (over: Record<string, unknown> = {}) => ({
  slug: "lib-fighter",
  id: "dnd5/lib-fighter",
  title: "Library fighter",
  revision: null,
  exported_at: AT,
  build,
  state: null,
  state_origin: { kind: "new_session" },
  context: context(),
  ...over,
});
const copyRequest = (over: Record<string, unknown> = {}) => ({
  format: "dnd5.library-export-request/1",
  mode: "character-copy",
  packs: [],
  character: character(over),
});
let spent: Loose;
let fresh: Loose;
let maxHp: number;

beforeAll(async () => {
  const f = nodeFacade({ seed: 1 });
  build = await fighter(f, 3);
  srd = (await f.servedPackFiles("srd-5.2.1")).ref;
  fresh = await f.createState(build);
  const hurt = await f.applyPlayAction(build, fresh, [
    { type: "damage", amount: 5 },
    { type: "add_custom_item", name: "Lucky coin", description: "A coin.", weight_lb: null },
  ] as never);
  if (!hurt.ok) throw new Error(hurt.reasons.join("; "));
  spent = hurt.state;
  maxHp = (await f.playSheet(build, fresh)).sheet.play.hp.max;
}, 120_000);

/** The CLI's adapter (Node's engine, header-only portrait) and the browser's (an app engine, a decoder). */
async function bothRead(bytes: Uint8Array) {
  const cliSide = await validateLocalCopyWith(bytes, {
    engine: nodeFacade({ seed: 3 }),
    portraitDecode: "header-only",
  });
  const browserSide = await validateLocalCopyWith(bytes, {
    engine: nodeFacade({ seed: 9 }),
    portraitDecode: spyDecoder().decode,
  });
  const view = (r: Loose) =>
    r.ok ? { ok: true, sha: r.copy.payload_sha256 } : { ok: false, code: r.code };
  return { cli: view(cliSide), browser: view(browserSide) };
}

describe("character-copy", () => {
  it("a new session from the build: a library copy, valid alike for the CLI and the browser; deterministic", async () => {
    const a = cli("character-copy", copyRequest());
    const b = cli("character-copy", copyRequest());
    expect(a.status).toBe(0);
    expect(Buffer.from(a.bytes as Uint8Array).equals(Buffer.from(b.bytes as Uint8Array))).toBe(
      true,
    );
    const copy = JSON.parse(new TextDecoder().decode(a.bytes as Uint8Array));
    const p = copy.payload;
    expect(p.source.producer).toMatchObject({
      kind: "library",
      tool: "srd-table/export-library-character/1",
      slug: "lib-fighter",
      id: "dnd5/lib-fighter",
      revision: null,
      label: null,
    });
    expect(p.source.record_rev).toBe(1); // a null revision stays null; the record's rev falls back to 1
    expect(p.source.exported_at).toBe(AT);
    expect(p.character.state_origin).toEqual({ kind: "new_session" });
    expect(p.character.state.hp).toEqual({ current: null, temp: 0 });
    expect(p.history).toEqual({
      schema: "kenli.history/2",
      entry_count: 0,
      meta: null,
      entries: [],
    });
    expect(p.packs.map((x: Loose) => x.id)).toEqual(["srd-5.2.1"]);
    const read = await bothRead(a.bytes as Uint8Array);
    expect(read.cli).toEqual({ ok: true, sha: copy.payload_sha256 });
    expect(read.browser).toEqual(read.cli);
  }, 120_000);

  it("a synthetic spent state with a custom item (state v3) is kept as it is, its label and revision stamped", async () => {
    const r = cli(
      "character-copy",
      copyRequest({
        state: spent,
        state_origin: { kind: "synthetic", fixture: "FX-TEST" },
        label: "rehearsal",
        revision: { seq: 4 },
      }),
    );
    expect(r.status).toBe(0);
    const p = JSON.parse(new TextDecoder().decode(r.bytes as Uint8Array)).payload;
    expect(p.character.state).toEqual(spent);
    expect(p.character.state.version).toBe(3);
    expect(p.source.producer.label).toBe("rehearsal");
    expect(p.source.record_rev).toBe(4);
    const read = await bothRead(r.bytes as Uint8Array);
    expect(read.cli.ok).toBe(true);
    expect(read.browser).toEqual(read.cli);
  }, 120_000);

  it("a portrait file: carried (header-checked); a GIF is refused with exit 3", async () => {
    const ok = cli("character-copy", copyRequest({ portrait_file: "$DIR/face.png" }), {
      "face.png": png(64, 48),
    });
    expect(ok.status).toBe(0);
    const p = JSON.parse(new TextDecoder().decode(ok.bytes as Uint8Array)).payload;
    expect(p.character.portrait).toMatchObject({ mime: "image/png" });
    expect((await bothRead(ok.bytes as Uint8Array)).browser.ok).toBe(true);
    const bad = cli("character-copy", copyRequest({ portrait_file: "$DIR/face.gif" }), {
      "face.gif": gif(),
    });
    expect([bad.status, bad.code]).toEqual([3, "portrait_unsupported"]);
  }, 120_000);

  it("a tampered copy is refused alike by both sides (hash_mismatch)", async () => {
    const r = cli("character-copy", copyRequest());
    const copy = JSON.parse(new TextDecoder().decode(r.bytes as Uint8Array));
    copy.payload.character.name = "Changed";
    const read = await bothRead(new TextEncoder().encode(JSON.stringify(copy)));
    expect(read.cli).toEqual({ ok: false, code: "hash_mismatch" });
    expect(read.browser).toEqual(read.cli);
  }, 120_000);
});

describe("a new session: full HP as null or as the engine's maximum (review R03-13)", () => {
  const withHp = (current: number | null, temp = 0) => ({ ...fresh, hp: { current, temp } });
  it("an explicit full HP (the engine's maximum) is a new session, kept as supplied", () => {
    const r = cli("character-copy", copyRequest({ state: withHp(maxHp) }));
    expect(r.status).toBe(0);
    const p = JSON.parse(new TextDecoder().decode(r.bytes as Uint8Array)).payload;
    expect(p.character.state.hp).toEqual({ current: maxHp, temp: 0 });
    expect(p.character.state_origin).toEqual({ kind: "new_session" });
  }, 120_000);
  it("wounded, temporary HP or spent: not a new session (state_not_fresh); above the maximum is refused too", () => {
    expect(cli("character-copy", copyRequest({ state: withHp(maxHp - 1) })).code).toBe(
      "state_not_fresh",
    );
    expect(cli("character-copy", copyRequest({ state: withHp(null, 3) })).code).toBe(
      "state_not_fresh",
    );
    expect(
      cli(
        "character-copy",
        copyRequest({ state: { ...fresh, uses_spent: { "fighter:second-wind": 1 } } }),
      ).code,
    ).toBe("state_not_fresh");
    const above = cli("character-copy", copyRequest({ state: withHp(maxHp + 1) }));
    expect(above.status).toBe(3);
    expect(["state_not_fresh", "state_invalid"]).toContain(above.code);
  }, 120_000);
  it("a fresh SRD character can be a party member: made by the engine (state null) or as given with full HP", () => {
    for (const state of [null, withHp(maxHp)]) {
      const request = {
        format: "dnd5.library-export-request/1",
        mode: "encounter-transfer",
        packs: [],
        encounter: {
          slug: "fresh-duel",
          id: "dnd5/fresh-duel",
          title: "Fresh duel",
          revision: null,
          name: "Fresh duel",
          world: context(),
          from: {
            kind: "setup",
            decisions: "auto",
            actions: [{ type: "add_character", character: "hero", side: "party" }],
          },
          party: [{ key: "hero", character: character({ state }) }],
        },
      };
      const r = cli("encounter-transfer", request);
      expect(r.status).toBe(0);
      const out = JSON.parse(new TextDecoder().decode(r.bytes as Uint8Array));
      const member = out.characters[0].content;
      // transfer/1 has no "new_session": an exported state with a note saying it is one, no history.
      expect(member.state_origin).toEqual({
        kind: "exported",
        note: "new session: full resources, no play (dnd5 library)",
      });
      expect(member.state).toEqual(state ?? fresh);
    }
  }, 120_000);
});

describe("encounter-transfer", () => {
  it("setup on the Table's engine; the party an internal transfer/1 character with the same state and packs", async () => {
    const request = {
      format: "dnd5.library-export-request/1",
      mode: "encounter-transfer",
      packs: [],
      encounter: {
        slug: "lib-duel",
        id: "dnd5/lib-duel",
        title: "Duel",
        revision: null,
        name: "Duel",
        world: context(),
        from: {
          kind: "setup",
          decisions: "auto",
          actions: [
            { type: "add_character", character: "hero", side: "party" },
            { type: "add_monster", monster: "goblin-warrior", side: "foes" },
          ],
        },
        party: [
          {
            key: "hero",
            character: character({
              state: spent,
              state_origin: { kind: "synthetic", fixture: "FX-TEST" },
            }),
          },
        ],
      },
    };
    const r = cli("encounter-transfer", request);
    expect(r.status).toBe(0);
    const out = JSON.parse(new TextDecoder().decode(r.bytes as Uint8Array));
    expect(out.format).toBe("dnd5.library-export-result/1");
    expect(out.root).toMatchObject({
      format: "srd-table.transfer/1",
      kind: "encounter",
      id: "dnd5/lib-duel",
    });
    expect(
      out.root.content.encounter.combatants.map((c: Loose) => c.character ?? c.monster),
    ).toContain("hero");
    expect(out.characters).toHaveLength(1);
    expect(out.characters[0].content.state).toEqual(spent);
    expect(out.characters[0].content.context).toEqual(context());
    expect(out.root.requires.every((d: Loose) => d.href === null && d.bytes_sha256 === null)).toBe(
      true,
    );
    expect(out.root.content.party).toEqual([
      {
        key: "hero",
        character: { id: "dnd5/lib-fighter", revision: null, sha256: out.characters[0].sha256 },
      },
    ]);
  }, 120_000);
});

describe("request rules and exit codes (cli-modes.json Q05–Q17 on real documents)", () => {
  const encounter = () => ({
    format: "dnd5.library-export-request/1",
    mode: "encounter-transfer",
    packs: [],
    encounter: {
      slug: "e",
      id: "dnd5/e",
      title: "E",
      revision: null,
      name: "E",
      world: context(),
      from: {
        kind: "setup",
        decisions: "auto",
        actions: [{ type: "add_character", character: "k", side: "party" }],
      },
      party: [
        {
          key: "k",
          character: character({ state: spent, state_origin: { kind: "synthetic", fixture: "F" } }),
        },
      ],
    },
  });
  const cases: [string, () => [string, Loose], number, string][] = [
    [
      "Q05 unknown mode",
      () => ["character-copy", { ...copyRequest(), mode: "character-transfer" }],
      2,
      "mode_unknown",
    ],
    [
      "Q06 both roots",
      () => ["character-copy", { ...copyRequest(), encounter: {} }],
      2,
      "request_invalid",
    ],
    [
      "Q07 relative pack path",
      () => [
        "character-copy",
        { ...copyRequest(), packs: [{ file: "private/kenli7-r1/bundle.json" }] },
      ],
      2,
      "path_not_absolute",
    ],
    [
      "Q08 .. in the portrait path",
      () => ["character-copy", copyRequest({ portrait_file: "/tmp/f011-req/../etc/passwd" })],
      2,
      "path_not_absolute",
    ],
    [
      "Q09 synthetic without a state",
      () => ["character-copy", copyRequest({ state_origin: { kind: "synthetic", fixture: "F" } })],
      3,
      "provenance_invalid",
    ],
    [
      "Q10 new session not fresh",
      () => ["character-copy", copyRequest({ state: spent })],
      3,
      "state_not_fresh",
    ],
    [
      "Q11 history on a new session",
      () => [
        "character-copy",
        copyRequest({
          history: { schema: "kenli.history/2", entry_count: 0, meta: null, entries: [] },
        }),
      ],
      3,
      "history_not_allowed",
    ],
    [
      "Q12 no exported_at",
      () => {
        const r = copyRequest();
        delete (r.character as Loose).exported_at;
        return ["character-copy", r];
      },
      2,
      "request_invalid",
    ],
    [
      "Q13 implicit time",
      () => ["character-copy", copyRequest({ exported_at: "now" })],
      3,
      "provenance_invalid",
    ],
    [
      "Q14 party member with history",
      () => {
        const r = encounter();
        (r.encounter.party[0] as Loose).character.history = null;
        return ["encounter-transfer", r];
      },
      2,
      "request_invalid",
    ],
    [
      "Q15 a party key twice",
      () => {
        const r = encounter();
        r.encounter.party.push(structuredClone(r.encounter.party[0] as Loose));
        return ["encounter-transfer", r];
      },
      2,
      "request_invalid",
    ],
    [
      "Q16 no party",
      () => {
        const r = encounter();
        r.encounter.party = [];
        return ["encounter-transfer", r];
      },
      2,
      "request_invalid",
    ],
    [
      "Q17 unknown state origin",
      () => ["character-copy", copyRequest({ state_origin: { kind: "played" } })],
      3,
      "provenance_invalid",
    ],
  ];
  for (const [name, make, status, code] of cases)
    it(name, () => {
      const [mode, request] = make();
      const r = cli(mode, request);
      expect([r.status, r.code]).toEqual([status, code]);
    }, 60_000);

  it("a relative --out and a request of the other mode are usage errors (exit 2)", () => {
    expect(
      cli("character-copy", copyRequest(), {}, ["--input", "/tmp/x.json", "--out", "out.json"])
        .status,
    ).toBe(2);
    expect([
      cli("encounter-transfer", copyRequest()).status,
      cli("encounter-transfer", copyRequest()).code,
    ]).toEqual([2, "request_invalid"]);
  }, 60_000);
});
