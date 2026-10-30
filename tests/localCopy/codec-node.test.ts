// @vitest-environment node
/**
 * kenli F-011 T04 (contracts/changes.md §2.5): the copy codec is pure — no DOM, no worker, no store —
 * and validates with whatever engine and image decoder it is given. Here: Node, no `window`, the
 * in-process `nodeFacade` and the copy's own packs; the portrait's step 8 by an injected decoder,
 * refused when none is given, skipped only when a tool says `"header-only"` (T09's CLI). The copy is
 * a real export (SRD + test pack) made by the app's own stores on fake IndexedDB, in Node.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { nodeFacade } from "../../src/engine/node";
import {
  checkWithEngine,
  type LocalCopy,
  validateLocalCopyWith,
} from "../../src/import/localCopy/codec";
import { exportLocalCopy } from "../../src/import/localCopy/export";
import { contentSha } from "../../src/lib/canonical";
import { toBase64 } from "../../src/lib/image";
import { rogue } from "../fixtures/characters";
import { testContext } from "../fixtures/player-actions";
import { png, spyDecoder } from "../helpers/images";
import { addCharacter, bytesOf, Installations, ok, storeTestPack } from "./helpers";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../../src");

/** The modules a file loads at run time (type-only imports left out), transitively within `src/`. */
function runtimeGraph(entry: string): Set<string> {
  const seen = new Set<string>();
  const external = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/^import\s+(type\s+)?([\s\S]*?)\s+from\s+"([^"]+)";/gm)) {
      const [, typeOnly, what, spec] = m as unknown as [string, string | undefined, string, string];
      if (typeOnly) continue;
      const names = what
        .replace(/[{}]/g, "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (names.length && names.every((n) => n.startsWith("type "))) continue;
      const local = spec.startsWith("@/")
        ? join(SRC, spec.slice(2))
        : spec.startsWith(".")
          ? resolve(dirname(file), spec)
          : null;
      if (!local) {
        external.add(spec);
        continue;
      }
      visit(local.endsWith(".ts") ? local : `${local}.ts`);
    }
    for (const m of text.matchAll(/^import\s+"([^"]+)";/gm)) external.add(m[1] as string);
  };
  visit(entry);
  return new Set([...[...seen].map((f) => f.slice(SRC.length + 1)), ...external]);
}

describe("the codec runs outside the app", () => {
  it("no DOM here; its run-time imports reach no worker client, store, persistence, React or Comlink", () => {
    expect(typeof window).toBe("undefined");
    expect(typeof document).toBe("undefined");
    const graph = [...runtimeGraph(join(SRC, "import/localCopy/codec.ts"))];
    for (const bad of [
      /^engine\/client/,
      /^engine\/worker/,
      /^store\//,
      /^persistence\//,
      /^features\//,
      /^offline\//,
      /^react/,
      /^comlink/,
      /^zustand/,
      /^idb/,
    ])
      expect(
        graph.filter((m) => bad.test(m)),
        String(bad),
      ).toEqual([]);
    expect(graph).toContain("lib/image.ts");
    expect(graph).toContain("import/checkCharacter.ts");
  });

  it("with Node's engine (nodeFacade): a real installation's copy is valid; changed documents are refused", async () => {
    // A real export (the app's stores and IndexedDB run in Node too), validated by the codec alone.
    // The app's persistence listens for page events: a no-op listener only while it makes the
    // fixture; removed before the codec runs (still no window or document at any point).
    const g = globalThis as { addEventListener?: unknown; removeEventListener?: unknown };
    g.addEventListener = () => undefined;
    g.removeEventListener = () => undefined;
    const inst = new Installations();
    await inst.open("N1");
    await storeTestPack();
    const ctx = await testContext(inst.fx.engine);
    const id = await addCharacter(await rogue(inst.fx.engine, 3), ctx, inst.fx.engine);
    const x = ok(await exportLocalCopy(id));
    const copy = JSON.parse(new TextDecoder().decode(await bytesOf(x.blob)));
    await inst.close();
    delete g.addEventListener;
    delete g.removeEventListener;
    expect(typeof window).toBe("undefined");
    const f = nodeFacade({ seed: 1 });
    const r = await validateLocalCopyWith(new TextEncoder().encode(JSON.stringify(copy)), {
      engine: f,
    });
    expect(r.ok ? "ok" : `${r.code}: ${r.detail}`).toBe("ok");
    // The engine reads the copy exactly: a state it would read otherwise is refused.
    const changed = structuredClone(copy);
    changed.payload.character.state.hp = { ...changed.payload.character.state.hp, current: "x" };
    await expect(checkWithEngine(changed as LocalCopy, f)).rejects.toMatchObject({
      code: expect.stringMatching(/^(state_invalid|state_would_change)$/),
    });

    // A portrait: refused without a decoder, decoded by the one given, skipped only on "header-only".
    const image = png(24, 24);
    const withPortrait = structuredClone(copy);
    withPortrait.payload.character.portrait = {
      mime: "image/png",
      bytes: image.length,
      base64: toBase64(image),
    };
    withPortrait.payload_sha256 = await contentSha(withPortrait.payload);
    const pb = new TextEncoder().encode(JSON.stringify(withPortrait));
    expect(await validateLocalCopyWith(pb, { engine: false })).toMatchObject({
      ok: false,
      code: "portrait_decoder_unavailable",
    });
    const spy = spyDecoder();
    expect((await validateLocalCopyWith(pb, { engine: f, portraitDecode: spy.decode })).ok).toBe(
      true,
    );
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]?.type).toBe("image/png");
    expect(
      (await validateLocalCopyWith(pb, { engine: false, portraitDecode: "header-only" })).ok,
    ).toBe(true);
  }, 60_000);
});
