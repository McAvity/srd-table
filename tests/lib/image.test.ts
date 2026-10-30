/**
 * kenli F-011 T04 (contracts/changes.md §2.2, §3.5): portrait bytes — the type from the bytes, the
 * size from the header, the limits, strict base64, the full decode (a refusal without a decoder),
 * and a new upload: raw checks before any decoder or encoder, shrink only above 512 px, the bytes
 * really produced (a WebKit PNG for a WebP asked) checked and decoded again.
 */

import { describe, expect, it } from "vitest";
import {
  browserDecoder,
  checkImageBytes,
  decodeChecked,
  fromBase64,
  headerSize,
  type ImageShrinker,
  PORTRAIT_LIMITS,
  PortraitError,
  prepareUpload,
  sniff,
  toBase64,
} from "../../src/lib/image";
import {
  bytesOfBlob,
  gif,
  headerDecoder,
  heic,
  jpeg,
  png,
  spyDecoder,
  svg,
  webp,
} from "../helpers/images";

const code = async (f: () => unknown) => {
  try {
    await f();
    return "ok";
  } catch (e) {
    if (e instanceof PortraitError) return e.code;
    throw e;
  }
};

describe("bytes and headers (§2.2 steps 3–7)", () => {
  it("PNG, JPEG and WebP (VP8, VP8L, VP8X): the type from the bytes, the size from the header", () => {
    expect(checkImageBytes(png(40, 30))).toEqual({ mime: "image/png", width: 40, height: 30 });
    expect(checkImageBytes(jpeg(640, 480))).toEqual({
      mime: "image/jpeg",
      width: 640,
      height: 480,
    });
    for (const k of ["VP8 ", "VP8L", "VP8X"] as const)
      expect(checkImageBytes(webp(300, 200, k))).toEqual({
        mime: "image/webp",
        width: 300,
        height: 200,
      });
  });

  it("GIF, SVG, HEIC and unknown bytes are unsupported; a declared type other than the bytes' is refused", async () => {
    for (const b of [gif(), svg(), heic(), new Uint8Array([1, 2, 3, 4])])
      expect(await code(() => checkImageBytes(b))).toBe("portrait_unsupported");
    expect(sniff(svg())).toBe("svg");
    expect(sniff(heic())).toBe("heic");
    expect(await code(() => checkImageBytes(png(4, 4), "image/jpeg"))).toBe(
      "portrait_mime_mismatch",
    );
  });

  it("limits: 5 MiB, 16 Mpx and a side over 16384 refused from the header alone (a pixel bomb never decoded)", async () => {
    expect(await code(() => checkImageBytes(png(20_000, 20_000)))).toBe("limit_portrait_pixels");
    expect(await code(() => checkImageBytes(png(16_385, 10)))).toBe("limit_portrait_pixels");
    expect(await code(() => checkImageBytes(jpeg(4001, 4000)))).toBe("limit_portrait_pixels");
    expect(await code(() => checkImageBytes(png(4000, 4000)))).toBe("ok");
    const big = new Uint8Array(PORTRAIT_LIMITS.bytes + 1);
    big.set(png(10, 10));
    expect(await code(() => checkImageBytes(big))).toBe("limit_portrait_bytes");
  });

  it("damaged headers: a PNG CRC, a truncated file, a JPEG scan before its frame, a WebP RIFF size", async () => {
    const p = png(10, 10);
    p[20] = (p[20] as number) ^ 1; // inside IHDR: the CRC no longer matches
    expect(await code(() => checkImageBytes(p))).toBe("portrait_malformed");
    expect(await code(() => checkImageBytes(png(10, 10).subarray(0, 20)))).toBe(
      "portrait_malformed",
    );
    const j = jpeg(10, 10);
    const sos = j.indexOf(0xda) - 1;
    expect(
      await code(() => checkImageBytes(new Uint8Array([0xff, 0xd8, ...j.subarray(sos)]))),
    ).toBe("portrait_malformed");
    const w = webp(10, 10);
    expect(await code(() => checkImageBytes(w.subarray(0, w.length - 1)))).toBe(
      "portrait_malformed",
    );
    expect(() => headerSize("png", new Uint8Array(8))).toThrow(PortraitError);
  });

  it("base64: strict, padded, canonical; whitespace, a data: prefix, a wrong length refused", async () => {
    const b = png(3, 3);
    const text = toBase64(b);
    expect(fromBase64(text, b.length)).toEqual(b);
    for (const bad of [` ${text}`, `data:image/png;base64,${text}`, text.slice(0, -4), `${text}\n`])
      expect(await code(() => fromBase64(bad, b.length))).toBe("portrait_invalid");
    expect(await code(() => fromBase64(text, b.length + 1))).toBe("portrait_invalid");
  });
});

describe("the full decode (§2.2 step 8)", () => {
  it("no decoder in this environment: refused, never taken from the header", async () => {
    // jsdom has neither createImageBitmap nor HTMLImageElement.decode: the browser decoder refuses.
    expect(typeof createImageBitmap).toBe("undefined");
    expect(await code(() => browserDecoder(new Blob([png(4, 4)])))).toBe(
      "portrait_decoder_unavailable",
    );
    expect(await code(() => decodeChecked(png(4, 4), "image/png", { width: 4, height: 4 }))).toBe(
      "portrait_decoder_unavailable",
    );
  });

  it("a decode that fails, or gives another size than the header, is refused", async () => {
    const failing = async () => {
      throw new Error("bad data");
    };
    expect(
      await code(() => decodeChecked(png(4, 4), "image/png", { width: 4, height: 4 }, failing)),
    ).toBe("portrait_decode_failed");
    const other = spyDecoder({ width: 5, height: 4 });
    expect(
      await code(() =>
        decodeChecked(png(4, 4), "image/png", { width: 4, height: 4 }, other.decode),
      ),
    ).toBe("portrait_decode_failed");
  });
});

describe("a new portrait (§3.5)", () => {
  it("unsupported, too big and pixel bombs are refused before any decoder or encoder sees them", async () => {
    const spy = spyDecoder();
    let shrinks = 0;
    const shrink: ImageShrinker = async (b) => {
      shrinks += 1;
      return b;
    };
    const big = new Blob([new Uint8Array(PORTRAIT_LIMITS.bytes + 1)]);
    for (const [file, want] of [
      [new Blob([gif()]), "portrait_unsupported"],
      [new Blob([svg()], { type: "image/png" }), "portrait_unsupported"],
      [new Blob([heic()]), "portrait_unsupported"],
      [big, "limit_portrait_bytes"],
      [new Blob([png(20_000, 20_000)]), "limit_portrait_pixels"],
      [new Blob([]), "portrait_invalid"],
    ] as const)
      expect(await code(() => prepareUpload(file, spy.decode, shrink))).toBe(want);
    expect(spy.calls).toHaveLength(0);
    expect(shrinks).toBe(0);
  });

  it("no decoder: refused (nothing stored), never the raw bytes on the header's word", async () => {
    expect(await code(() => prepareUpload(new Blob([png(64, 64)]), browserDecoder, null))).toBe(
      "portrait_decoder_unavailable",
    );
  });

  it("up to 512 px: the raw bytes kept exactly; above, shrunk and the real output checked", async () => {
    const small = jpeg(512, 300, 7);
    const kept = await prepareUpload(new Blob([small]), headerDecoder, null);
    expect(kept.mime).toBe("image/jpeg");
    expect(await bytesOfBlob(kept.blob)).toEqual(small);
    // No encoder in this browser: a larger image is kept raw (within the limits), not refused.
    const raw = png(2000, 1000);
    expect(
      await bytesOfBlob((await prepareUpload(new Blob([raw]), headerDecoder, null)).blob),
    ).toEqual(raw);
    // The encoder asked for WebP: whatever it really returns is what's checked and stored.
    const asked: [number, number][] = [];
    const webkit: ImageShrinker = async (_b, w, h) => {
      asked.push([w, h]);
      return new Blob([png(w, h)], { type: "image/webp" }); // WebKit: PNG bytes despite the ask
    };
    const out = await prepareUpload(new Blob([raw]), headerDecoder, webkit);
    expect(asked).toEqual([[512, 256]]);
    expect(out).toMatchObject({ mime: "image/png", width: 512, height: 256 });
    expect(out.blob.type).toBe("image/png");
    const chrome: ImageShrinker = async (_b, w, h) =>
      new Blob([webp(w, h)], { type: "image/webp" });
    expect(await prepareUpload(new Blob([raw]), headerDecoder, chrome)).toMatchObject({
      mime: "image/webp",
      width: 512,
      height: 256,
    });
  });

  it("an encoder output that isn't a supported, sane, decodable image is refused", async () => {
    const raw = new Blob([png(1024, 1024)]);
    const garbage: ImageShrinker = async () => new Blob([gif()]);
    expect(await code(() => prepareUpload(raw, headerDecoder, garbage))).toBe(
      "portrait_unsupported",
    );
    const throwing: ImageShrinker = async () => {
      throw new Error("encoder gone");
    };
    expect(await code(() => prepareUpload(raw, headerDecoder, throwing))).toBe(
      "portrait_decode_failed",
    );
    // The output is decoded too: a decoder disagreeing with the output's header refuses it.
    let n = 0;
    const second = async (b: Blob) => {
      n += 1;
      return n === 1 ? headerDecoder(b) : { width: 1, height: 1 };
    };
    const ok: ImageShrinker = async (_b, w, h) => new Blob([png(w, h)]);
    expect(await code(() => prepareUpload(raw, second, ok))).toBe("portrait_decode_failed");
  });
});
