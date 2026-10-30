/**
 * kenli F-011 T04: small images built byte by byte — a PNG (IHDR with its CRC, IDAT, IEND), a
 * baseline JPEG (SOI, APP0, SOF0, SOS, EOI), WebP in its three headers (VP8, VP8L, VP8X), a GIF, an
 * SVG and a HEIC `ftyp` — so the header checks see real layouts. jsdom has no image decoder: tests
 * that need step 8 install `headerDecoder` (a test's stand-in, reading the header back) or a spy;
 * the real decoders run in the browser e2e (`e2e/portrait.spec.ts`).
 */

import { deflateSync } from "node:zlib";
import { headerSize, type ImageDecoder, sniff } from "../../src/lib/image";

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc = (b: Uint8Array) => {
  let c = 0xffffffff;
  for (const x of b) c = (crcTable[(c ^ x) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const le32 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
const le24 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255];
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

function chunk(type: string, data: number[]): number[] {
  const body = new Uint8Array([...ascii(type), ...data]);
  return [...be32(data.length), ...body, ...be32(crc(body))];
}

/** A PNG `width`×`height` (8-bit grey); `fill` varies the IDAT bytes (same size, other content). */
export function png(width: number, height: number, fill = 0): Uint8Array<ArrayBuffer> {
  const ihdr = [...be32(width), ...be32(height), 8, 0, 0, 0, 0];
  const idat = [0x78, 0x9c, fill & 255, 0, 0, 0, 0, 0];
  return new Uint8Array([
    0x89,
    ...ascii("PNG\r\n\x1a\n"),
    ...chunk("IHDR", ihdr),
    ...chunk("IDAT", idat),
    ...chunk("IEND", []),
  ]);
}

/**
 * A real, decodable PNG (8-bit RGB, deflated scanlines): a diagonal gradient. `broken`: the same
 * header (valid IHDR and CRCs) over image data that doesn't inflate — only a full decode notices.
 */
export function realPng(width: number, height: number, broken = false): Uint8Array<ArrayBuffer> {
  const raw = new Uint8Array((width * 3 + 1) * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = y * (width * 3 + 1) + 1 + x * 3;
      raw[i] = (x * 255) / width;
      raw[i + 1] = (y * 255) / height;
      raw[i + 2] = 128;
    }
  const data = broken ? new Uint8Array(64).fill(0xab) : new Uint8Array(deflateSync(raw));
  const ihdr = [...be32(width), ...be32(height), 8, 2, 0, 0, 0];
  return new Uint8Array([
    0x89,
    ...ascii("PNG\r\n\x1a\n"),
    ...chunk("IHDR", ihdr),
    ...chunk("IDAT", [...data]),
    ...chunk("IEND", []),
  ]);
}

/** A baseline JPEG `width`×`height` (SOF0 before SOS). */
export function jpeg(width: number, height: number, fill = 0): Uint8Array<ArrayBuffer> {
  const app0 = [0xff, 0xe0, 0, 16, ...ascii("JFIF\0"), 1, 1, 0, 0, 1, 0, 1, 0, 0];
  const sof0 = [
    0xff,
    0xc0,
    0,
    11,
    8,
    height >> 8,
    height & 255,
    width >> 8,
    width & 255,
    1,
    1,
    0x11,
    0,
  ];
  const sos = [0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0, fill & 255, 0];
  return new Uint8Array([0xff, 0xd8, ...app0, ...sof0, ...sos, 0xff, 0xd9]);
}

function riff(chunkType: string, data: number[]): Uint8Array<ArrayBuffer> {
  const body = [...ascii("WEBP"), ...ascii(chunkType), ...le32(data.length), ...data];
  return new Uint8Array([...ascii("RIFF"), ...le32(body.length), ...body]);
}
/** WebP, lossy (`VP8 `), lossless (`VP8L`) or extended (`VP8X`) header. */
export function webp(
  width: number,
  height: number,
  kind: "VP8 " | "VP8L" | "VP8X" = "VP8X",
): Uint8Array<ArrayBuffer> {
  if (kind === "VP8 ")
    return riff("VP8 ", [
      0, // the frame tag (3 bytes), then the start code
      0,
      0,
      0x9d,
      0x01,
      0x2a,
      width & 255,
      width >> 8,
      height & 255,
      height >> 8,
      0,
      0,
      0,
      0,
      0,
    ]);
  if (kind === "VP8L") {
    const v = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14);
    return riff("VP8L", [0x2f, ...le32(v >>> 0), 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  }
  return riff("VP8X", [0, 0, 0, 0, ...le24(width - 1), ...le24(height - 1), 0, 0, 0, 0, 0, 0]);
}

export const gif = (): Uint8Array<ArrayBuffer> =>
  new Uint8Array([...ascii("GIF89a"), 1, 0, 1, 0, 0, 0, 0, 0x3b]);
export const svg = (): Uint8Array<ArrayBuffer> =>
  new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');
export const heic = (): Uint8Array<ArrayBuffer> =>
  new Uint8Array([0, 0, 0, 24, ...ascii("ftypheic"), 0, 0, 0, 0, ...ascii("mif1heic")]);

/**
 * A test's decoder: the header's size back, as if fully decoded (jsdom has none). Never the app's:
 * the product refuses without a real decoder (`portrait_decoder_unavailable`).
 */
export const headerDecoder: ImageDecoder = async (blob) => {
  const b = new Uint8Array(await blob.arrayBuffer());
  const kind = sniff(b);
  if (kind !== "png" && kind !== "jpeg" && kind !== "webp")
    throw new Error(`not an image: ${kind}`);
  return headerSize(kind, b);
};

/** A spy decoder: counts calls; answers like `headerDecoder` (or with `answer`). */
export function spyDecoder(answer?: { width: number; height: number }) {
  const calls: Blob[] = [];
  const decode: ImageDecoder = async (blob) => {
    calls.push(blob);
    return answer ?? headerDecoder(blob);
  };
  return { decode, calls };
}

export const bytesOfBlob = async (b: Blob) => new Uint8Array(await b.arrayBuffer());
