/**
 * kenli F-011 T04: the browser's side of the full copy (contracts/changes.md §2.5). Everything is
 * the pure codec's (`codec.ts`); here the app's engine (the worker) and image decoder (the browser's,
 * `lib/image.ts`) are given to it. T09's CLI uses the codec with Node's `nodeFacade` instead.
 */

import { engine } from "@/engine/client";
import { imageDecoder } from "@/lib/image";
import * as codec from "./codec";

export * from "./codec";

/** Step 8 on the app's engine. */
export function checkWithEngine(
  copy: codec.LocalCopy,
  f: codec.CopyEngine = engine(),
): Promise<void> {
  return codec.checkWithEngine(copy, f);
}

/**
 * The whole file on the app's engine and image decoder; `engine: false` skips the engine step
 * (structure only); `portraitDecode` replaces the decoder (tests).
 */
export function validateLocalCopy(
  bytes: Uint8Array,
  options: { readonly engine?: boolean; readonly portraitDecode?: codec.PortraitDecode } = {},
): ReturnType<typeof codec.validateLocalCopyWith> {
  return codec.validateLocalCopyWith(bytes, {
    engine: options.engine === false ? false : engine(),
    portraitDecode: options.portraitDecode ?? imageDecoder(),
  });
}
