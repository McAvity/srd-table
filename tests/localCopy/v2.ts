/**
 * kenli F-011 T04: the F-007 contract fixtures (`/1`, kept byte-for-byte) as the copy `/2` reads
 * them — the same payload with the fields `/2` adds (`source.producer: null`, `portrait: null`),
 * the history container `kenli.history/2` (its entries stay `/1`), the payload hash recomputed.
 * Nothing else changes, so every F-007 expectation still applies to the same data.
 */

import { contentSha } from "../../src/lib/canonical";

// biome-ignore lint/suspicious/noExplicitAny: a fixture reached field by field.
type Loose = any;

export async function asCopyV2(copy1: Loose): Promise<Loose> {
  const c = structuredClone(copy1);
  c.format = "srd-table.local-copy/2";
  const p = c.payload;
  p.source = { ...p.source, producer: null };
  p.character = { ...p.character, portrait: null };
  p.history = { ...p.history, schema: "kenli.history/2" };
  c.payload_sha256 = await contentSha(p);
  return c;
}

/** The fixture's text as `/2` (serialized as `JSON.stringify` writes it). */
export const asCopyV2Text = async (text: string): Promise<string> =>
  JSON.stringify(await asCopyV2(JSON.parse(text)));
