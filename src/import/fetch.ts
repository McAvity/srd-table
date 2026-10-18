/**
 * Fetching transfer resources within the contract's limits (kenli F-008 §5.1–5.2): HTTPS only
 * (HTTP on loopback for development), no credentials, no redirects, dependencies on the root's
 * origin; bytes counted as they arrive (a missing or false `Content-Length` changes nothing),
 * one deadline per resource and one for the whole set, a single cancel for everything. Resources
 * are fetched one at a time (the contract allows up to four in parallel).
 */

import { ImportError } from "./transfer";

export const LIMITS = {
  resourceBytes: 20 * 2 ** 20,
  totalBytes: 100 * 2 ** 20,
  resources: 64,
  depth: 8,
  resourceMs: 30_000,
  totalMs: 120_000,
} as const;
export type Limits = { -readonly [K in keyof typeof LIMITS]: number };

const LOOPBACK = (host: string) =>
  host === "localhost" || host === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(host);

/** Check a URL against the policy; `base` is the referring resource (its origin is required). */
export function checkUrl(raw: string, base?: URL): URL {
  let url: URL;
  try {
    url = base ? new URL(raw, base) : new URL(raw);
  } catch {
    throw new ImportError("url_invalid", raw);
  }
  if (url.username || url.password) throw new ImportError("url_credentials", url.host);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK(url.hostname)))
    throw new ImportError("url_scheme", url.protocol);
  if (base && url.origin !== base.origin)
    throw new ImportError("dependency_cross_origin", url.href);
  url.hash = "";
  return url;
}

/** What one import may still spend: resources, bytes, time; and its cancel. */
export class Budget {
  private resources = 0;
  private bytes = 0;
  private readonly deadline: number;
  constructor(
    readonly signal: AbortSignal,
    readonly limits: Limits = { ...LIMITS },
    private readonly now: () => number = Date.now,
  ) {
    this.deadline = now() + limits.totalMs;
  }
  resource(): void {
    if (++this.resources > this.limits.resources)
      throw new ImportError("limit_resources", String(this.limits.resources));
  }
  add(n: number): void {
    this.bytes += n;
    if (this.bytes > this.limits.totalBytes)
      throw new ImportError("limit_total_bytes", String(this.limits.totalBytes));
  }
  remaining(): number {
    const left = this.deadline - this.now();
    if (left <= 0) throw new ImportError("timeout", "the whole import");
    return left;
  }
  get spent() {
    return { resources: this.resources, bytes: this.bytes };
  }
}

export interface Fetched {
  readonly url: URL;
  readonly bytes: Uint8Array;
  readonly contentType: string | null;
}

/** Fetch one resource within the budget (`fetchFn` is the browser's `fetch`; tests pass their own). */
export async function fetchBounded(
  url: URL,
  budget: Budget,
  fetchFn: typeof fetch = fetch,
): Promise<Fetched> {
  budget.resource();
  if (budget.signal.aborted) throw new ImportError("cancelled");
  const controller = new AbortController();
  const stop = () => controller.abort();
  budget.signal.addEventListener("abort", stop, { once: true });
  const ms = Math.min(budget.limits.resourceMs, budget.remaining());
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, ms);
  try {
    let response: Response;
    try {
      response = await fetchFn(url.href, {
        credentials: "omit",
        mode: "cors",
        redirect: "manual",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        signal: controller.signal,
      });
    } catch (error) {
      throw (
        aborted(budget, timedOut) ??
        new ImportError("fetch_failed", `${url.href} (network or CORS): ${String(error)}`)
      );
    }
    if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400))
      throw new ImportError("redirect_refused", url.href);
    if (response.status !== 200)
      throw new ImportError("http_status", `${response.status} ${url.href}`);
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > budget.limits.resourceBytes)
      throw new ImportError("limit_resource_bytes", url.href);
    const chunks: Uint8Array[] = [];
    let size = 0;
    const take = (chunk: Uint8Array) => {
      size += chunk.byteLength;
      if (size > budget.limits.resourceBytes) {
        controller.abort();
        throw new ImportError("limit_resource_bytes", url.href);
      }
      budget.add(chunk.byteLength);
      chunks.push(chunk);
    };
    try {
      const reader = response.body?.getReader();
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          take(value);
        }
      } else {
        take(new Uint8Array(await response.arrayBuffer()));
      }
    } catch (error) {
      if (error instanceof ImportError) throw error;
      throw aborted(budget, timedOut) ?? new ImportError("fetch_failed", String(error));
    }
    const bytes = new Uint8Array(size);
    let at = 0;
    for (const c of chunks) {
      bytes.set(c, at);
      at += c.byteLength;
    }
    return { url, bytes, contentType: response.headers.get("content-type") };
  } finally {
    clearTimeout(timer);
    budget.signal.removeEventListener("abort", stop);
  }
}

function aborted(budget: Budget, timedOut: boolean): ImportError | null {
  if (budget.signal.aborted) return new ImportError("cancelled");
  if (timedOut) return new ImportError("timeout");
  return null;
}
