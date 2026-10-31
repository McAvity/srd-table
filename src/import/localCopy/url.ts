/**
 * kenli F-011 T04 (contracts/changes.md §8): a full copy by URL — the copy itself, or the library's
 * pointer (`srd-table.library-pointer/1`, `kind: "character"`) whose current target is one. The same
 * policy and budget as F-008 (`checkUrl`, `fetchBounded`): HTTPS, no credentials or redirects, the
 * target on the pointer's origin, bytes counted as they arrive, one cancel. Only the bytes come
 * back; the caller validates them whole (and checks `expect` against the copy's `payload_sha256`).
 * Anything that isn't a copy is refused here, before any preview or write.
 */

import { sha256Hex } from "@/lib/canonical";
import { Budget, checkUrl, fetchBounded, LIMITS } from "../fetch";
import { ImportError, POINTER_FORMAT, TRANSFER_FORMAT } from "../transfer";
import { LOCAL_COPY_LIMITS } from "./codec";

export interface FetchedCopy {
  readonly bytes: Uint8Array;
  /** The name a file would have (the URL's last segment). */
  readonly name: string;
  readonly url: string;
  /** From a pointer: the copy's `payload_sha256` it names (else `null`). */
  readonly expect: string | null;
}

const formatOf = (bytes: Uint8Array): { format: unknown; value: Record<string, unknown> } => {
  // F-011 R03-08: the copy's 20 MiB bound before the first decode or parse of the bytes.
  if (bytes.byteLength > LOCAL_COPY_LIMITS.copyBytes)
    throw new ImportError(
      "limit_copy_bytes",
      `${bytes.byteLength} > ${LOCAL_COPY_LIMITS.copyBytes}`,
    );
  let value: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (/^\s*</.test(text)) throw new ImportError("content_html");
    value = JSON.parse(text);
  } catch (error) {
    if (error instanceof ImportError) throw error;
    throw new ImportError("not_json");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ImportError("root_kind_not_allowed", "character-copy ← not an object");
  const v = value as Record<string, unknown>;
  return { format: Object.hasOwn(v, "format") ? v.format : undefined, value: v };
};

const COPY = /^srd-table\.local-copy\//;

/**
 * §8 for "Import character": the root is a local copy (any `srd-table.local-copy/N`: the codec
 * then reads `/2` and refuses `/1` and `/3+` by their own codes); a transfer (a character one
 * too), a raw document or anything else is refused here, before validation, preview or a write.
 * A library pointer is followed only from a URL (`pointer_needs_url` in a file).
 */
export function checkCopyRoot(bytes: Uint8Array): void {
  const { format } = formatOf(bytes);
  if (typeof format === "string" && COPY.test(format)) return;
  if (format === POINTER_FORMAT) throw new ImportError("pointer_needs_url");
  if (format === "kenli.bundle/1") throw new ImportError("format_adapter_required", format);
  throw new ImportError(
    "root_kind_not_allowed",
    `character-copy ← ${format === TRANSFER_FORMAT ? "transfer" : typeof format === "string" ? format : "raw document"}`,
  );
}

/** A copy's bytes from a URL (or its pointer), within the budget; `ImportError` on any refusal. */
export async function fetchCopy(
  raw: string,
  signal: AbortSignal,
  fetchFn: typeof fetch = fetch,
): Promise<FetchedCopy> {
  const budget = new Budget(signal, { ...LIMITS, resourceBytes: LOCAL_COPY_LIMITS.copyBytes });
  const first = await fetchBounded(checkUrl(raw), budget, fetchFn);
  if (first.contentType && /^\s*text\/html\b/i.test(first.contentType))
    throw new ImportError("content_html", first.url.href);
  const { format, value } = formatOf(first.bytes);
  let got = first;
  let expect: string | null = null;
  if (format === POINTER_FORMAT) {
    const current = value.current as Record<string, unknown> | undefined;
    if (
      !current ||
      typeof current.href !== "string" ||
      typeof current.bytes_sha256 !== "string" ||
      typeof current.sha256 !== "string"
    )
      throw new ImportError("pointer_invalid", first.url.href);
    got = await fetchBounded(checkUrl(current.href, first.url), budget, fetchFn);
    if ((await sha256Hex(got.bytes)) !== current.bytes_sha256)
      throw new ImportError("bytes_mismatch", got.url.href);
    expect = current.sha256;
    // The pointer's kind must be its target's (a copy is a character); then the entrance's.
    const target = formatOf(got.bytes);
    const kind =
      typeof target.format === "string" && COPY.test(target.format)
        ? "character"
        : target.format === TRANSFER_FORMAT
          ? target.value.kind
          : null;
    if (kind !== value.kind)
      throw new ImportError("pointer_target_mismatch", `${String(value.kind)} → ${String(kind)}`);
  }
  checkCopyRoot(got.bytes);
  const name = decodeURIComponent(got.url.pathname.split("/").pop() || "copy.json");
  return { bytes: got.bytes, name, url: got.url.href, expect };
}
