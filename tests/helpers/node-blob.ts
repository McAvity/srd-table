/**
 * kenli F-011 T04: jsdom's `Blob` doesn't survive fake-indexeddb's structured clone (it comes back
 * as a plain object), while a browser's does. Node's `Blob` clones like a browser's, so tests that
 * store portraits install it (import this first), with object URLs to match (Vitest's jsdom
 * `createObjectURL` reads only jsdom Blobs): unique `blob:` strings, released ones remembered.
 * Product code is unchanged: it only uses `Blob` and `URL.createObjectURL`/`revokeObjectURL`.
 */

import { Blob as NodeBlob } from "node:buffer";

globalThis.Blob = NodeBlob as unknown as typeof Blob;
let n = 0;
export const revokedUrls = new Set<string>();
URL.createObjectURL = () => `blob:test/${++n}`;
URL.revokeObjectURL = (url: string) => {
  revokedUrls.add(url);
};
