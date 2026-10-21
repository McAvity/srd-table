/**
 * The transfer format (kenli F-008 contract `srd-table.transfer/1`): a small envelope over the
 * engine's unchanged documents, with exact content identities, and the library pointer
 * (`srd-table.library-pointer/1`). Recognition and structural checks only: the documents inside
 * are parsed and validated by the engine (plan.ts), never here.
 */

import { type ContentContext, canonicalJson, contentSha, type PackRef } from "@/lib/canonical";

export const TRANSFER_FORMAT = "srd-table.transfer/1";
export const POINTER_FORMAT = "srd-table.library-pointer/1";

export type Kind = "pack" | "character" | "encounter";
export type Revision = { readonly seq: number; readonly label?: string } | null;

export interface DependencyRef {
  readonly kind: "pack" | "character";
  readonly id: string;
  readonly version?: string | null;
  readonly revision?: Revision;
  readonly sha256: string;
  readonly href: string | null;
  readonly bytes_sha256: string | null;
}

export interface Envelope {
  readonly format: typeof TRANSFER_FORMAT;
  readonly kind: Kind;
  readonly id: string;
  readonly revision: Revision;
  readonly title: string;
  readonly sha256: string;
  readonly content: Readonly<Record<string, unknown>>;
  readonly requires: readonly DependencyRef[];
  readonly provenance: Readonly<Record<string, unknown>>;
  readonly extensions: Readonly<Record<string, unknown>>;
}

export interface PartyRef {
  readonly key: string;
  readonly character: { readonly id: string; readonly revision: Revision; readonly sha256: string };
}

export interface PointerTarget {
  readonly href: string;
  readonly bytes_sha256: string;
  readonly sha256: string;
  readonly version: string | null;
  readonly revision: Revision;
}

/** A refusal with the contract's code; `detail` is technical (shown under the translated code). */
export class ImportError extends Error {
  override name = "ImportError";
  constructor(
    readonly code: string,
    readonly detail = "",
  ) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export type Recognized =
  | { readonly kind: "envelope"; readonly value: Envelope }
  | {
      readonly kind: "pointer";
      readonly value: { current: PointerTarget } & Record<string, unknown>;
    }
  | { readonly kind: "raw"; readonly value: unknown };

/** What a resource is, from its bytes (contract §4.1); throws `ImportError`. */
export function recognize(bytes: Uint8Array, contentType: string | null = null): Recognized {
  if (contentType && /^\s*text\/html\b/i.test(contentType))
    throw new ImportError("content_html", "the server answered with an HTML page");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ImportError("not_utf8");
  }
  if (/^\s*</.test(text)) throw new ImportError("content_html", "the resource looks like HTML");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ImportError("not_json");
  }
  if (!isRecord(value)) throw new ImportError("format_unknown", "not a JSON object");
  const format = value.format;
  if (format === TRANSFER_FORMAT) return { kind: "envelope", value: value as unknown as Envelope };
  if (format === POINTER_FORMAT)
    return {
      kind: "pointer",
      value: value as { current: PointerTarget } & Record<string, unknown>,
    };
  if (typeof format === "string") {
    // kenli F-007 T03: a local copy with history is its own format with its own import.
    if (format.startsWith("srd-table.local-copy/"))
      throw new ImportError("format_local_copy", format);
    const m = /^srd-table\.(transfer|library-pointer)\/(\d+)$/.exec(format);
    if (m && Number(m[2]) > 1) throw new ImportError("format_newer", format);
    if (format === "kenli.bundle/1") throw new ImportError("format_adapter_required", format);
    throw new ImportError("format_unknown", format);
  }
  if ("bundle_id" in value && "pack" in value) throw new ImportError("format_adapter_required");
  return { kind: "raw", value };
}

const ENVELOPE_KEYS = [
  "format",
  "kind",
  "id",
  "revision",
  "title",
  "sha256",
  "content",
  "requires",
  "provenance",
  "extensions",
];
const CONTENT_KEYS: Record<Kind, readonly string[]> = {
  pack: ["files"],
  character: ["build", "state", "state_origin", "context"],
  encounter: ["name", "encounter", "world", "party"],
};
const HEX64 = /^[0-9a-f]{64}$/;
const SOURCE_ID = /^[a-z0-9][a-z0-9.-]*(\/[a-z0-9][a-z0-9.-]*)*$/;

export const depKey = (d: { kind: string; id: string; version?: string | null; sha256: string }) =>
  `${d.kind}:${d.id}${d.kind === "pack" ? `@${d.version ?? ""}` : ""}#${d.sha256}`;

export const packOfEnvelope = (env: Envelope): PackRef => {
  const m = (
    env.content.files as Record<string, { manifest?: { id?: string; version?: string | null } }>
  )["manifest.json"]?.manifest;
  return { id: String(m?.id), version: m?.version ?? null, sha256: env.sha256 };
};

/**
 * Structural checks (contract §2, §3): exact keys, kind, ids, the identity hash, `requires`
 * equal to what the content implies, Q-01's party. Throws the first `ImportError`.
 */
export async function checkEnvelope(env: Envelope): Promise<void> {
  for (const k of Object.keys(env))
    if (!ENVELOPE_KEYS.includes(k)) throw new ImportError("envelope_unknown_field", k);
  for (const k of ENVELOPE_KEYS)
    if (!(k in env)) throw new ImportError("envelope_missing_field", k);
  const kind = env.kind;
  if (!(kind in CONTENT_KEYS)) throw new ImportError("envelope_kind", String(kind));
  if (typeof env.id !== "string" || !SOURCE_ID.test(env.id))
    throw new ImportError("envelope_id", String(env.id));
  if (!isRecord(env.extensions)) throw new ImportError("envelope_extensions");
  const rev = env.revision;
  if (rev !== null && !(isRecord(rev) && Number.isInteger(rev.seq) && (rev.seq as number) >= 1))
    throw new ImportError("envelope_revision", JSON.stringify(rev));
  if (kind === "pack" && rev !== null)
    throw new ImportError("envelope_revision", "packs use version");
  if (!isRecord(env.content)) throw new ImportError("envelope_content");
  const keys = CONTENT_KEYS[kind];
  for (const k of Object.keys(env.content))
    if (!keys.includes(k)) throw new ImportError("envelope_unknown_field", `content.${k}`);
  for (const k of keys)
    if (!(k in env.content)) throw new ImportError("envelope_missing_field", `content.${k}`);
  if (typeof env.sha256 !== "string" || !HEX64.test(env.sha256))
    throw new ImportError("envelope_sha256");
  if ((await contentSha(env.content)) !== env.sha256)
    throw new ImportError("hash_mismatch", env.id);
  if (!Array.isArray(env.requires)) throw new ImportError("requires_invalid");
  for (const r of env.requires) {
    if (!isRecord(r)) throw new ImportError("requires_invalid");
    if (r.href !== null && typeof r.href !== "string")
      throw new ImportError("requires_invalid", "href");
    if ((r.href === null) !== (r.bytes_sha256 === null))
      throw new ImportError("requires_invalid", "href and bytes_sha256 go together");
    if (typeof r.sha256 !== "string" || !HEX64.test(r.sha256))
      throw new ImportError("requires_invalid", "sha256");
  }
  const declared = env.requires.map(depKey).sort();
  let implied: string[];
  if (kind === "pack") {
    const manifest = (
      env.content.files as Record<string, { manifest?: { id?: string; requires?: string[] } }>
    )["manifest.json"]?.manifest;
    if (typeof manifest?.id !== "string") throw new ImportError("pack_manifest_missing");
    if (manifest.id !== env.id)
      throw new ImportError("pack_id_mismatch", `${manifest.id} ≠ ${env.id}`);
    const ids = manifest.requires ?? [];
    const packs = env.requires.filter((r) => r.kind === "pack");
    if (packs.length !== ids.length || !ids.every((id) => packs.some((p) => p.id === id)))
      throw new ImportError("requires_mismatch", env.id);
    implied = declared;
  } else if (kind === "character") {
    const content = env.content as {
      state: unknown;
      state_origin: unknown;
      context: ContentContext;
    };
    const origin = content.state_origin as { kind?: unknown } | null;
    if (!isRecord(origin) || !["exported", "synthetic", "none"].includes(String(origin.kind)))
      throw new ImportError("state_origin_invalid");
    if ((origin.kind === "none") !== (content.state === null))
      throw new ImportError("state_origin_mismatch");
    implied = content.context.packs.map((p) => depKey({ kind: "pack", ...p }));
  } else {
    const content = env.content as { world: ContentContext; party: PartyRef[]; encounter: unknown };
    checkParty(content.encounter, content.party);
    implied = [
      ...content.world.packs.map((p) => depKey({ kind: "pack", ...p })),
      ...content.party.map((p) => depKey({ kind: "character", ...p.character })),
    ];
  }
  if (canonicalJson([...new Set(implied)].sort()) !== canonicalJson(declared))
    throw new ImportError("requires_mismatch", env.id);
}

/**
 * Every character key an encounter refers to (contract §2.3): its combatants' and a stopped
 * `add_character`. Works on the raw JSON, before the engine parses it.
 */
export function characterKeys(encounter: unknown): string[] {
  const enc = encounter as {
    combatants?: { character?: string | null }[];
    pending?: { action?: { type?: string; character?: string } } | null;
  };
  const keys = (enc.combatants ?? []).map((c) => c.character).filter((k): k is string => !!k);
  const p = enc.pending?.action;
  if (p?.type === "add_character" && typeof p.character === "string") keys.push(p.character);
  return [...new Set(keys)];
}

/** Q-01: the party covers exactly the encounter's character keys. */
export function checkParty(encounter: unknown, party: readonly { key: string }[]): void {
  const used = characterKeys(encounter);
  const keys = party.map((p) => p.key);
  if (new Set(keys).size !== keys.length) throw new ImportError("party_duplicate_key");
  for (const k of used) if (!keys.includes(k)) throw new ImportError("party_unmapped_key", k);
  for (const k of keys) if (!used.includes(k)) throw new ImportError("party_extra_entry", k);
}

/** Q-01 remap: every character key the engine reads (combatants, a pending `add_character`). */
export function remapEncounter<E>(encounter: E, map: Readonly<Record<string, string>>): E {
  const copy = structuredClone(encounter) as unknown as {
    combatants: { character: string | null }[];
    pending: { action: { type: string; character?: string } } | null;
  };
  const to = (k: string) => {
    const v = map[k];
    if (v === undefined) throw new ImportError("party_unmapped_key", k);
    return v;
  };
  for (const c of copy.combatants ?? []) if (c.character !== null) c.character = to(c.character);
  if (copy.pending?.action.type === "add_character" && copy.pending.action.character)
    copy.pending.action.character = to(copy.pending.action.character);
  return copy as unknown as E;
}
