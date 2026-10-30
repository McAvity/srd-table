/**
 * kenli F-011 T04 (contracts/changes.md §2.2, §3.5): portrait images — the allowed types, their
 * limits, the type from the bytes (never a declared MIME), the size from the header (never a full
 * decode, so a decompression bomb stops here) and the full decode, which only a real decoder does.
 * Pure but for `browserDecoder`, which touches no DOM until called. Never throws an unexpected
 * error: every refusal is a `PortraitError` with the contract's code.
 */

export const PORTRAIT_MIMES = ["image/jpeg", "image/png", "image/webp"] as const;
export type PortraitMime = (typeof PORTRAIT_MIMES)[number];
export const PORTRAIT_LIMITS = {
  bytes: 5 * 2 ** 20,
  pixels: 16_000_000,
  side: 16_384,
  /** The longest side of a stored portrait after shrinking (unchanged from before). */
  shrinkTo: 512,
} as const;

export class PortraitError extends Error {
  override name = "PortraitError";
  constructor(
    readonly code: string,
    readonly detail = "",
  ) {
    super(detail ? `${code}: ${detail}` : code);
  }
}
const fail = (code: string, detail = ""): never => {
  throw new PortraitError(code, detail);
};

export type Sniffed = "png" | "jpeg" | "webp" | "gif" | "svg" | "avif" | "heic" | "unknown";
const ascii = (b: Uint8Array, at: number, n: number) =>
  String.fromCharCode(...b.subarray(at, Math.min(b.length, at + n)));
const u16be = (b: Uint8Array, at: number) => ((b[at] ?? 0) << 8) | (b[at + 1] ?? 0);
const u32be = (b: Uint8Array, at: number) => u16be(b, at) * 65536 + u16be(b, at + 2);
const u24le = (b: Uint8Array, at: number) =>
  (b[at] ?? 0) | ((b[at + 1] ?? 0) << 8) | ((b[at + 2] ?? 0) << 16);
const u32le = (b: Uint8Array, at: number) => u24le(b, at) + (b[at + 3] ?? 0) * 2 ** 24;

/** The image type from its magic numbers only. */
export function sniff(b: Uint8Array): Sniffed {
  if (b.length >= 8 && ascii(b, 0, 8) === "\x89PNG\r\n\x1a\n") return "png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b.length >= 12 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") return "webp";
  if (b.length >= 6 && /^GIF8[79]a$/.test(ascii(b, 0, 6))) return "gif";
  if (b.length >= 12 && ascii(b, 4, 4) === "ftyp") {
    const brand = ascii(b, 8, 4);
    if (brand === "avif" || brand === "avis") return "avif";
    if (["heic", "heix", "hevc", "mif1", "msf1"].includes(brand)) return "heic";
  }
  const head = new TextDecoder().decode(b.subarray(0, 256)).trimStart().toLowerCase();
  if (head.startsWith("<svg") || head.startsWith("<?xml")) return "svg";
  return "unknown";
}
export const mimeOf = (kind: Sniffed): PortraitMime | null =>
  kind === "png" || kind === "jpeg" || kind === "webp" ? `image/${kind}` : null;

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return (b: Uint8Array) => {
    let c = 0xffffffff;
    for (const x of b) c = (t[(c ^ x) & 0xff] as number) ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
})();

/** Width and height from the header only (PNG IHDR with CRC, JPEG SOFn before SOS, WebP). */
export function headerSize(
  kind: "png" | "jpeg" | "webp",
  b: Uint8Array,
): { width: number; height: number } {
  const M = "portrait_malformed";
  if (kind === "png") {
    if (b.length < 33 || u32be(b, 8) !== 13 || ascii(b, 12, 4) !== "IHDR") fail(M, "png IHDR");
    if (CRC(b.subarray(12, 29)) !== u32be(b, 29)) fail(M, "png IHDR crc");
    return { width: u32be(b, 16), height: u32be(b, 20) };
  }
  if (kind === "jpeg") {
    let i = 2;
    while (i + 4 <= b.length) {
      if (b[i] !== 0xff) fail(M, `jpeg marker at ${i}`);
      const m = b[i + 1] as number;
      if (m === 0xff) {
        i += 1;
        continue;
      }
      if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
        i += 2;
        continue;
      }
      if (m === 0xda || m === 0xd9) fail(M, "jpeg scan or end before a frame header");
      const len = u16be(b, i + 2);
      if (len < 2 || i + 2 + len > b.length) fail(M, "jpeg segment length");
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        if (len < 8) fail(M, "jpeg SOF length");
        return { height: u16be(b, i + 5), width: u16be(b, i + 7) };
      }
      i += 2 + len;
    }
    return fail(M, "jpeg without a frame header");
  }
  if (b.length < 30 || u32le(b, 4) + 8 !== b.length) fail(M, "webp RIFF size");
  const chunk = ascii(b, 12, 4);
  if (chunk === "VP8 ") {
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) fail(M, "webp VP8 start code");
    return {
      width: ((b[26] ?? 0) | ((b[27] ?? 0) << 8)) & 0x3fff,
      height: ((b[28] ?? 0) | ((b[29] ?? 0) << 8)) & 0x3fff,
    };
  }
  if (chunk === "VP8L") {
    if (b[20] !== 0x2f) fail(M, "webp VP8L signature");
    const v = u32le(b, 21);
    return { width: (v & 0x3fff) + 1, height: ((v >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8X") return { width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 };
  return fail(M, `webp chunk ${JSON.stringify(chunk)}`);
}

/**
 * §2.2 steps 3, 6, 7 (and §3.5 step 1) on bytes: the byte limit, the type from the bytes, the size
 * from the header and its limits. `declared`: the MIME the bytes must be (a copy's `mime`).
 */
export function checkImageBytes(
  bytes: Uint8Array,
  declared?: string,
): { mime: PortraitMime; width: number; height: number } {
  if (bytes.length < 1) fail("portrait_invalid", "empty");
  if (bytes.length > PORTRAIT_LIMITS.bytes) fail("limit_portrait_bytes", String(bytes.length));
  const kind = sniff(bytes);
  const mime = mimeOf(kind);
  if (!mime) return fail("portrait_unsupported", kind);
  if (declared !== undefined && declared !== mime)
    fail("portrait_mime_mismatch", `${declared} ≠ ${mime}`);
  const { width, height } = headerSize(kind as "png" | "jpeg" | "webp", bytes);
  if (width < 1 || height < 1) fail("portrait_malformed", `${width}×${height}`);
  if (
    width > PORTRAIT_LIMITS.side ||
    height > PORTRAIT_LIMITS.side ||
    width * height > PORTRAIT_LIMITS.pixels
  )
    fail("limit_portrait_pixels", `${width}×${height}`);
  return { mime, width, height };
}

// ───────────────────────── base64 (RFC 4648 §4, padded) ─────────────────────────

const B64 = /^[A-Za-z0-9+/]*={0,2}$/;
export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
/** Strict: exactly `4·ceil(n/3)` characters of the alphabet, padded, decoding to `n` bytes. */
export function fromBase64(text: string, n: number): Uint8Array {
  if (text.length !== 4 * Math.ceil(n / 3) || !B64.test(text))
    fail("portrait_invalid", "base64: padded RFC 4648 §4, no whitespace or prefix");
  let raw: string;
  try {
    raw = atob(text);
  } catch {
    return fail("portrait_invalid", "base64");
  }
  if (raw.length !== n) fail("portrait_invalid", "decoded length ≠ bytes");
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = raw.charCodeAt(i);
  if (toBase64(out) !== text) fail("portrait_invalid", "base64 not canonical");
  return out;
}

// ───────────────────────── the full decode ─────────────────────────

/** A real decoder: the image's size once decoded; throws when it can't decode it. */
export type ImageDecoder = (blob: Blob) => Promise<{ width: number; height: number }>;

/**
 * The browser's decoders — both where both exist, as neither is a full decode everywhere (measured
 * in T04's e2e: WebKit's `createImageBitmap` accepts a PNG whose data doesn't inflate, decoding
 * lazily, while its `img.decode()` rejects it; Chromium the other way round). Each must succeed
 * with the same size; one alone is used where the other is missing; neither →
 * `portrait_decoder_unavailable` (a header is never taken for a decoded image).
 */
export const browserDecoder: ImageDecoder = async (blob) => {
  const sizes: { width: number; height: number }[] = [];
  if (typeof createImageBitmap === "function") {
    let bitmap: ImageBitmap;
    try {
      bitmap = await createImageBitmap(blob);
    } catch {
      return fail("portrait_decode_failed", "createImageBitmap");
    }
    sizes.push({ width: bitmap.width, height: bitmap.height });
    bitmap.close?.();
  }
  if (
    typeof Image === "function" &&
    typeof URL?.createObjectURL === "function" &&
    typeof HTMLImageElement !== "undefined" &&
    typeof HTMLImageElement.prototype.decode === "function"
  ) {
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      sizes.push({ width: img.naturalWidth, height: img.naturalHeight });
    } catch {
      return fail("portrait_decode_failed", "img.decode");
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  const [first, second] = sizes;
  if (!first) return fail("portrait_decoder_unavailable", "no image decoder here");
  if (second && (second.width !== first.width || second.height !== first.height))
    fail("portrait_decode_failed", "the decoders disagree on the size");
  return first;
};

let current: ImageDecoder = browserDecoder;
/** The decoder the app uses (tests install another: a stub is a test's decoder, never the app's). */
export const imageDecoder = (): ImageDecoder => current;
export function setImageDecoder(d: ImageDecoder | null): void {
  current = d ?? browserDecoder;
}

/** §2.2 step 8: a full decode whose size matches the header; any failure is a refusal. */
export async function decodeChecked(
  bytes: Uint8Array,
  mime: PortraitMime,
  header: { width: number; height: number },
  decode: ImageDecoder = imageDecoder(),
): Promise<void> {
  let got: { width: number; height: number };
  try {
    got = await decode(new Blob([bytes as BlobPart], { type: mime }));
  } catch (error) {
    if (error instanceof PortraitError) throw error;
    return fail("portrait_decode_failed", error instanceof Error ? error.message : String(error));
  }
  if (got.width !== header.width || got.height !== header.height)
    fail("portrait_decode_failed", `decoded ${got.width}×${got.height} ≠ header`);
}

// ───────────────────────── shrinking (§3.5 step 3) ─────────────────────────

/** Re-encodes an image at `width`×`height`, asking for WebP; the Blob it really returns counts. */
export type ImageShrinker = (blob: Blob, width: number, height: number) => Promise<Blob>;

/** The browser's: `createImageBitmap` + `OffscreenCanvas`; `null` when this browser has neither. */
export const browserShrinker: ImageShrinker | null =
  typeof createImageBitmap === "function" && typeof OffscreenCanvas === "function"
    ? async (blob, width, height) => {
        const bitmap = await createImageBitmap(blob);
        const canvas = new OffscreenCanvas(width, height);
        canvas.getContext("2d")?.drawImage(bitmap, 0, 0, width, height);
        bitmap.close?.();
        return canvas.convertToBlob({ type: "image/webp", quality: 0.85 });
      }
    : null;

let shrinker: ImageShrinker | null = browserShrinker;
export const imageShrinker = (): ImageShrinker | null => shrinker;
export function setImageShrinker(s: ImageShrinker | null | "browser"): void {
  shrinker = s === "browser" ? browserShrinker : s;
}

/**
 * §3.5: a new portrait. (1) The raw file: its size before it is read, its type from its bytes and
 * its header's size — before any decoder or encoder sees it; (2) one full decode matching the
 * header (no decoder: refused); (3) shrunk only when larger than 512 px, else the raw bytes kept;
 * (4) the bytes really produced (never the asked type) checked and decoded again. Any refusal: a
 * `PortraitError`, nothing stored.
 */
export async function prepareUpload(
  file: Blob,
  decode: ImageDecoder = imageDecoder(),
  shrink: ImageShrinker | null = imageShrinker(),
): Promise<{ blob: Blob; mime: PortraitMime; width: number; height: number }> {
  if (file.size < 1) fail("portrait_invalid", "empty");
  if (file.size > PORTRAIT_LIMITS.bytes) fail("limit_portrait_bytes", String(file.size));
  const raw = new Uint8Array(await file.arrayBuffer());
  const head = checkImageBytes(raw);
  await decodeChecked(raw, head.mime, head, decode);
  const scale = Math.min(1, PORTRAIT_LIMITS.shrinkTo / Math.max(head.width, head.height));
  if (scale === 1 || !shrink)
    return { blob: new Blob([raw as BlobPart], { type: head.mime }), ...head };
  let made: Blob;
  try {
    made = await shrink(
      new Blob([raw as BlobPart], { type: head.mime }),
      Math.max(1, Math.round(head.width * scale)),
      Math.max(1, Math.round(head.height * scale)),
    );
  } catch (error) {
    return fail("portrait_decode_failed", error instanceof Error ? error.message : String(error));
  }
  const out = new Uint8Array(await made.arrayBuffer());
  const got = checkImageBytes(out);
  await decodeChecked(out, got.mime, got, decode);
  return { blob: new Blob([out as BlobPart], { type: got.mime }), ...got };
}
