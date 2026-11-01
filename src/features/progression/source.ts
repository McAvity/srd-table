/**
 * kenli F-002 T05: a plan file from the user's files or a URL, read with the import's own safe
 * fetch (kenli F-008: HTTPS or loopback, no credentials, no redirects, bounded bytes and time, one
 * cancel). Only bytes come back; the plan codec and the worker judge them. Nothing is written.
 */

import { Budget, checkUrl, fetchBounded, LIMITS } from "@/import/fetch";
import { ImportError } from "@/import/transfer";
import { PLAN_LIMITS } from "@/progression/codec";

export type Loaded =
  | { readonly ok: true; readonly bytes: Uint8Array; readonly label: string }
  | { readonly ok: false; readonly code: string; readonly detail: string };

export async function planFromFile(file: File): Promise<Loaded> {
  if (file.size > PLAN_LIMITS.fileBytes)
    return {
      ok: false,
      code: "plan_limit_bytes",
      detail: `${file.size} > ${PLAN_LIMITS.fileBytes}`,
    };
  try {
    return { ok: true, bytes: new Uint8Array(await file.arrayBuffer()), label: file.name };
  } catch (error) {
    return {
      ok: false,
      code: "file_read_failed",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function planFromUrl(
  raw: string,
  signal: AbortSignal,
  fetchFn: typeof fetch = fetch,
): Promise<Loaded> {
  try {
    const url = checkUrl(raw.trim());
    const budget = new Budget(signal, {
      ...LIMITS,
      resources: 1,
      resourceBytes: PLAN_LIMITS.fileBytes,
    });
    const got = await fetchBounded(url, budget, fetchFn);
    if (got.contentType && /^\s*text\/html\b/i.test(got.contentType))
      return { ok: false, code: "content_html", detail: url.href };
    return { ok: true, bytes: got.bytes, label: url.href };
  } catch (error) {
    if (error instanceof ImportError) return { ok: false, code: error.code, detail: error.detail };
    return {
      ok: false,
      code: "fetch_failed",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}
