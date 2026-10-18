/**
 * Transfers made by this Table (kenli F-008 contract §7.4): a character, an encounter or an
 * imported pack as `srd-table.transfer/1`. A local export has this installation's identity
 * (`table/<installation>/<record>`, revision = the record's `rev`); the import it came from is
 * kept as `extensions.derived_from`. A record on the campaign's packs is exported with their
 * exact refs. The same function computes a record's current identity for a later re-import.
 */

import type { CharacterState } from "srd-rules-engine";
import { engine } from "@/engine/client";
import { type ContentContext, contentSha, type PackRef } from "@/lib/canonical";
import { db, type StoredPack } from "@/persistence/db";
import { type CharacterRecord, characterKeysOf, type EncounterRecord } from "@/store/documents";
import { useSettings } from "@/store/settings";
import { type DependencyRef, type Envelope, TRANSFER_FORMAT } from "./transfer";

/** The campaign's packs as exact refs (each served pack read whole and hashed). */
export async function campaignContext(): Promise<ContentContext> {
  const { packs, sources } = useSettings.getState().settings;
  return { packs: await Promise.all(packs.map((id) => engine().servedPack(id))), sources };
}

const packDep = (p: PackRef): DependencyRef => ({
  kind: "pack",
  id: p.id,
  version: p.version,
  sha256: p.sha256,
  href: null,
  bytes_sha256: null,
});

const provenance = (installation: string) => ({
  publisher: `table/${installation}`,
  generator: { name: "srd-table", version: "1" },
  notes: [],
});

/** The content of a character's export now, and its context. */
export async function characterContent(
  record: CharacterRecord,
  campaign?: ContentContext,
): Promise<{
  build: unknown;
  state: CharacterState;
  state_origin: { kind: "exported" };
  context: ContentContext;
}> {
  const context = record.content ?? campaign ?? (await campaignContext());
  return {
    build: record.build,
    state: record.state,
    state_origin: { kind: "exported" },
    context,
  };
}

export async function exportCharacter(
  record: CharacterRecord,
  installation: string,
  campaign?: ContentContext,
): Promise<Envelope> {
  const content = await characterContent(record, campaign);
  const derived = record.origin?.kind === "import" ? { derived_from: record.origin } : {};
  return {
    format: TRANSFER_FORMAT,
    kind: "character",
    id: `table/${installation}/${record.id}`,
    revision: { seq: Math.max(1, record.rev ?? 1) },
    title: record.build.name || record.id,
    sha256: await contentSha(content),
    content,
    requires: content.context.packs.map(packDep),
    provenance: provenance(installation),
    extensions: derived,
  };
}

/** An encounter with its party's identities as of now (each character exported separately). */
export async function exportEncounter(
  record: EncounterRecord,
  characters: Readonly<Record<string, CharacterRecord>>,
  installation: string,
): Promise<{ encounter: Envelope; party: Envelope[] }> {
  const campaign = await campaignContext();
  const world = record.content ?? campaign;
  const party: Envelope[] = [];
  const refs = [];
  for (const key of characterKeysOf(record.encounter)) {
    const c = characters[key];
    if (!c) throw new Error(`party_unmapped_key: ${key}`);
    const env = await exportCharacter(c, installation, campaign);
    party.push(env);
    refs.push({ key, character: { id: env.id, revision: env.revision, sha256: env.sha256 } });
  }
  const content = { name: record.name, encounter: record.encounter, world, party: refs };
  const requires: DependencyRef[] = [
    ...world.packs.map(packDep),
    ...party.map((p) => ({
      kind: "character" as const,
      id: p.id,
      revision: p.revision,
      sha256: p.sha256,
      href: null,
      bytes_sha256: null,
    })),
  ];
  return {
    encounter: {
      format: TRANSFER_FORMAT,
      kind: "encounter",
      id: `table/${installation}/${record.id}`,
      revision: { seq: Math.max(1, record.rev ?? 1) },
      title: record.name,
      sha256: await contentSha(content),
      content,
      requires,
      provenance: provenance(installation),
      extensions: record.origin?.kind === "import" ? { derived_from: record.origin } : {},
    },
    party,
  };
}

/** An installed pack as a transfer; `deps`: the refs of the packs it requires, in order. */
export function exportPack(
  pack: StoredPack,
  deps: readonly PackRef[],
  installation: string,
): Envelope {
  return {
    format: TRANSFER_FORMAT,
    kind: "pack",
    id: pack.ref.id,
    revision: null,
    title: `${pack.ref.id} ${pack.ref.version ?? ""}`.trim(),
    sha256: pack.ref.sha256,
    content: { files: pack.files },
    requires: deps.map(packDep),
    provenance: provenance(installation),
    extensions: {},
  };
}

/**
 * An installed pack as a transfer, its required packs resolved to exact refs (the served SRD, or
 * the one installed version of each); `{ ambiguous }` when an id has several versions here.
 */
export async function exportInstalledPack(
  key: string,
  installation: string,
): Promise<Envelope | { readonly ambiguous: string } | null> {
  const all = await (await db()).getAll("packs");
  const pack = all.find((p) => p.key === key);
  if (!pack) return null;
  const manifest = (pack.files["manifest.json"] as { manifest?: { requires?: string[] } }).manifest;
  const deps: PackRef[] = [];
  for (const id of manifest?.requires ?? []) {
    const installed = all.filter((p) => p.ref.id === id).map((p) => p.ref);
    if (installed.length === 1 && installed[0]) deps.push(installed[0]);
    else if (installed.length === 0) deps.push(await engine().servedPack(id));
    else return { ambiguous: id };
  }
  return exportPack(pack, deps, installation);
}
