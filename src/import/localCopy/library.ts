/**
 * kenli F-011 T09 (dnd5 contracts/changes.md §9): what the library CLI makes — a full copy
 * (`srd-table.local-copy/3`, kenli F-002 T07; F-011 wrote `/2`) of a library character, or an encounter transfer with its party as
 * internal `transfer/1` characters — from a `dnd5.library-export-request/1`, on any engine facade
 * (the CLI's is Node's `nodeFacade`, the Table's pinned engine). Pure: no worker, DOM, IndexedDB,
 * file system or network here; the CLI (`scripts/export-library-character.ts`) reads the files and
 * passes their parsed values. Every copy made here is checked by the same codec as an import.
 */

import type { CharacterBuild, CharacterState, Encounter, EncounterAction } from "srd-rules-engine";
import type { EngineFacade } from "@/engine/facade";
import {
  type ContentContext,
  canonicalJson,
  contentSha,
  type PackRef,
  sha256Hex,
} from "@/lib/canonical";
import { checkCharacterWith } from "../checkCharacter";
import { type DependencyRef, type Envelope, TRANSFER_FORMAT } from "../transfer";
import {
  type CopyHistory,
  type CopyPortrait,
  type CopyStateOrigin,
  checkPortrait,
  externalOf,
  HISTORY_CONTAINER,
  LIBRARY_TOOL,
  LOCAL_COPY_FORMAT,
  LOCAL_COPY_LIMITS,
  type LocalCopy,
  type Payload,
  Refusal,
  refuse,
  validateLocalCopyWith,
} from "./codec";

export const REQUEST_FORMAT = "dnd5.library-export-request/1";
export const RESULT_FORMAT = "dnd5.library-export-result/1";
export const MODES = ["character-copy", "encounter-transfer"] as const;
export type Mode = (typeof MODES)[number];
export const CLI_LIMITS = {
  requestBytes: 64 * 2 ** 20,
  copyBytes: LOCAL_COPY_LIMITS.copyBytes,
  resultBytes: 100 * 2 ** 20,
} as const;
const SRD_ID = "srd-5.2.1";

export type Revision = { readonly seq: number; readonly label?: string } | null;
export interface CharacterInput {
  readonly slug: string;
  readonly id: string;
  readonly title: string;
  readonly revision: Revision;
  readonly exported_at: number;
  readonly build: Record<string, unknown>;
  readonly state: Record<string, unknown> | null;
  readonly state_origin:
    | { readonly kind: "new_session" }
    | { readonly kind: "synthetic"; readonly fixture: string }
    | { readonly kind: "exported"; readonly note?: string };
  readonly context: ContentContext;
  readonly label?: string | null;
  readonly history?: CopyHistory | null;
  readonly portrait_file?: string | null;
}
export interface EncounterInput {
  readonly slug: string;
  readonly id: string;
  readonly title: string;
  readonly revision: Revision;
  readonly name: string;
  readonly world: ContentContext;
  readonly from:
    | {
        readonly kind: "setup";
        readonly decisions: "ask" | "auto";
        readonly actions: readonly Record<string, unknown>[];
      }
    | { readonly kind: "document"; readonly document: Record<string, unknown> };
  readonly party: readonly { readonly key: string; readonly character: CharacterInput }[];
}
export interface Request {
  readonly format: typeof REQUEST_FORMAT;
  readonly mode: Mode;
  readonly packs: readonly { readonly file: string }[];
  readonly character?: CharacterInput;
  readonly encounter?: EncounterInput;
}

/** The tool's own identity, stamped into what it makes (§9.3). */
export interface Producer {
  readonly table_commit: string;
  readonly engine_commit: string;
}

const SLUG = /^[a-z0-9][a-z0-9.-]{0,60}$/;
const SOURCE_ID = /^[a-z0-9][a-z0-9.-]*(\/[a-z0-9][a-z0-9.-]*)*$/;
const HEX64 = /^[0-9a-f]{64}$/;
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const own = (o: Record<string, unknown>, k: string) => (Object.hasOwn(o, k) ? o[k] : undefined);
const json = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** An absolute path without `.`/`..` segments (§9.2); `null` is allowed where the field is optional. */
export function checkPath(p: unknown, where: string): string {
  if (typeof p !== "string" || !p) return refuse("request_invalid", `${where}: a path`);
  const segments = p.split("/");
  if (
    !p.startsWith("/") ||
    p.includes("\\") ||
    segments.slice(1).some((s) => s === "." || s === ".." || s === "")
  )
    refuse("path_not_absolute", `${where}: ${p}`);
  return p;
}

function keys(
  o: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  where: string,
) {
  for (const k of required)
    if (!Object.hasOwn(o, k)) refuse("request_invalid", `${where}.${k} missing`);
  for (const k of Object.keys(o))
    if (!required.includes(k) && !optional.includes(k))
      refuse("request_invalid", `${where}.${k} unknown`);
}

function checkRevision(v: unknown, where: string): Revision {
  if (v === null) return null;
  if (!isObj(v)) return refuse("request_invalid", `${where}: a revision or null`);
  keys(v, ["seq"], ["label"], where);
  if (!Number.isSafeInteger(v.seq) || (v.seq as number) < 1)
    refuse("request_invalid", `${where}.seq`);
  if (v.label !== undefined && typeof v.label !== "string")
    refuse("request_invalid", `${where}.label`);
  return v as Revision;
}

function checkContext(v: unknown, where: string): ContentContext {
  if (!isObj(v)) return refuse("request_invalid", `${where}: a context`);
  keys(v, ["packs", "sources"], [], where);
  const packs = v.packs;
  if (!Array.isArray(packs) || packs.length === 0) refuse("request_invalid", `${where}.packs`);
  for (const [i, p] of (packs as unknown[]).entries()) {
    if (!isObj(p)) refuse("request_invalid", `${where}.packs.${i}`);
    keys(p as Record<string, unknown>, ["id", "version", "sha256"], [], `${where}.packs.${i}`);
    const r = p as Record<string, unknown>;
    if (
      typeof r.id !== "string" ||
      !(r.version === null || typeof r.version === "string") ||
      typeof r.sha256 !== "string" ||
      !HEX64.test(r.sha256)
    )
      refuse("request_invalid", `${where}.packs.${i}`);
  }
  if ((packs as PackRef[])[0]?.id !== SRD_ID)
    refuse("request_invalid", `${where}: the SRD comes first`);
  if (
    !(
      v.sources === null ||
      (Array.isArray(v.sources) && v.sources.every((s) => typeof s === "string"))
    )
  )
    refuse("request_invalid", `${where}.sources`);
  return v as unknown as ContentContext;
}

const ORIGINS = ["new_session", "synthetic", "exported"];
function checkCharacterInput(v: unknown, where: string, party: boolean): CharacterInput {
  if (!isObj(v)) return refuse("request_invalid", `${where}: a character`);
  keys(
    v,
    ["slug", "id", "title", "revision", "exported_at", "build", "state", "state_origin", "context"],
    party ? [] : ["label", "history", "portrait_file"],
    where,
  );
  if (typeof v.slug !== "string" || !SLUG.test(v.slug)) refuse("request_invalid", `${where}.slug`);
  if (typeof v.id !== "string" || !SOURCE_ID.test(v.id)) refuse("request_invalid", `${where}.id`);
  if (typeof v.title !== "string") refuse("request_invalid", `${where}.title`);
  checkRevision(v.revision, `${where}.revision`);
  // §9.2: an explicit, deterministic time in ms — never "now".
  if (!Number.isSafeInteger(v.exported_at) || (v.exported_at as number) < 0)
    refuse("provenance_invalid", `${where}.exported_at: explicit milliseconds`);
  if (!isObj(v.build)) refuse("request_invalid", `${where}.build`);
  if (!(v.state === null || isObj(v.state))) refuse("request_invalid", `${where}.state`);
  const so = v.state_origin;
  if (!isObj(so) || typeof so.kind !== "string")
    return refuse("request_invalid", `${where}.state_origin`);
  if (!ORIGINS.includes(so.kind))
    refuse("provenance_invalid", `${where}.state_origin.kind ${so.kind}`);
  if (so.kind === "synthetic") {
    keys(so, ["kind", "fixture"], [], `${where}.state_origin`);
    if (typeof so.fixture !== "string" || !so.fixture)
      refuse("request_invalid", `${where}.state_origin.fixture`);
  } else keys(so, ["kind"], so.kind === "exported" ? ["note"] : [], `${where}.state_origin`);
  if (v.state === null && so.kind !== "new_session")
    refuse("provenance_invalid", `${where}: only a new session is made from the build alone`);
  if (v.history !== undefined && v.history !== null && so.kind !== "exported")
    refuse("history_not_allowed", `${where}: no invented play for a ${so.kind} state`);
  if (v.label !== undefined && v.label !== null && typeof v.label !== "string")
    refuse("request_invalid", `${where}.label`);
  if (v.portrait_file !== undefined && v.portrait_file !== null)
    checkPath(v.portrait_file, `${where}.portrait_file`);
  checkContext(v.context, `${where}.context`);
  return v as unknown as CharacterInput;
}

/** §9.2: the request's shape and paths, first refusal wins (`request_invalid`, `mode_unknown`…). */
export function checkRequest(v: unknown): Request {
  if (!isObj(v)) return refuse("request_invalid", "not an object");
  if (own(v, "format") !== REQUEST_FORMAT)
    refuse("request_invalid", `format ${String(own(v, "format"))}`);
  const mode = own(v, "mode");
  if (typeof mode !== "string") return refuse("request_invalid", "mode");
  if (!(MODES as readonly string[]).includes(mode)) refuse("mode_unknown", mode);
  const root = mode === "character-copy" ? "character" : "encounter";
  keys(v, ["format", "mode", "packs", root], [], "request");
  if (!Array.isArray(v.packs)) refuse("request_invalid", "packs");
  for (const [i, p] of (v.packs as unknown[]).entries()) {
    if (!isObj(p)) refuse("request_invalid", `packs.${i}`);
    keys(p as Record<string, unknown>, ["file"], [], `packs.${i}`);
    checkPath((p as Record<string, unknown>).file, `packs.${i}.file`);
  }
  if (mode === "character-copy") checkCharacterInput(v.character, "character", false);
  else {
    const e = v.encounter;
    if (!isObj(e)) return refuse("request_invalid", "encounter");
    keys(e, ["slug", "id", "title", "revision", "name", "world", "from", "party"], [], "encounter");
    if (typeof e.slug !== "string" || !SLUG.test(e.slug))
      refuse("request_invalid", "encounter.slug");
    if (typeof e.id !== "string" || !SOURCE_ID.test(e.id))
      refuse("request_invalid", "encounter.id");
    if (typeof e.title !== "string" || typeof e.name !== "string" || !e.name)
      refuse("request_invalid", "encounter.title/name");
    checkRevision(e.revision, "encounter.revision");
    checkContext(e.world, "encounter.world");
    const from = e.from;
    if (!isObj(from)) return refuse("request_invalid", "encounter.from");
    if (from.kind === "setup") {
      keys(from, ["kind", "decisions", "actions"], [], "encounter.from");
      if (from.decisions !== "ask" && from.decisions !== "auto")
        refuse("request_invalid", "encounter.from.decisions");
      if (!Array.isArray(from.actions) || !from.actions.length || !from.actions.every(isObj))
        refuse("request_invalid", "encounter.from.actions");
    } else if (from.kind === "document") {
      keys(from, ["kind", "document"], [], "encounter.from");
      if (!isObj(from.document)) refuse("request_invalid", "encounter.from.document");
    } else refuse("request_invalid", "encounter.from.kind");
    if (!Array.isArray(e.party) || e.party.length === 0)
      refuse("request_invalid", "encounter.party: at least one");
    const seen = new Set<string>();
    for (const [i, m] of (e.party as unknown[]).entries()) {
      if (!isObj(m)) return refuse("request_invalid", `encounter.party.${i}`);
      keys(m, ["key", "character"], [], `encounter.party.${i}`);
      if (typeof m.key !== "string" || !m.key)
        refuse("request_invalid", `encounter.party.${i}.key`);
      if (seen.has(m.key as string))
        refuse("request_invalid", `encounter.party: key ${String(m.key)} twice`);
      seen.add(m.key as string);
      checkCharacterInput(m.character, `encounter.party.${i}.character`, true);
    }
  }
  return v as unknown as Request;
}

/** A pack transfer as given (`transfer/1:pack`), checked: shape, identity hash. */
export async function checkPackTransfer(
  v: unknown,
  where: string,
): Promise<{ env: Envelope; ref: PackRef; files: Record<string, unknown> }> {
  if (
    !isObj(v) ||
    v.format !== TRANSFER_FORMAT ||
    v.kind !== "pack" ||
    !isObj(v.content) ||
    !isObj((v.content as Record<string, unknown>).files)
  )
    return refuse("request_invalid", `${where}: not a ${TRANSFER_FORMAT} pack`);
  const files = (v.content as { files: Record<string, unknown> }).files;
  const m = (
    files["manifest.json"] as { manifest?: { id?: unknown; version?: unknown } } | undefined
  )?.manifest;
  if (typeof m?.id !== "string") return refuse("request_invalid", `${where}: no manifest`);
  const sha = await contentSha({ files });
  if (sha !== v.sha256) refuse("hash_mismatch", where);
  const ref: PackRef = {
    id: m.id,
    version: typeof m.version === "string" ? m.version : null,
    sha256: sha,
  };
  return { env: v as unknown as Envelope, ref, files };
}

/** A pack as a copy carries it: its own identity, its requirements as exact refs without links. */
function copyPackEnvelope(env: Envelope, deps: readonly PackRef[]): Envelope {
  return {
    format: TRANSFER_FORMAT,
    kind: "pack",
    id: env.id,
    revision: null,
    title: env.title,
    sha256: env.sha256,
    content: { files: (env.content as { files: Record<string, unknown> }).files },
    requires: deps.map(packDep),
    provenance: json(env.provenance),
    extensions: json(env.extensions),
  };
}
const packDep = (p: PackRef): DependencyRef => ({
  kind: "pack",
  id: p.id,
  version: p.version,
  sha256: p.sha256,
  href: null,
  bytes_sha256: null,
});
/** The internal party transfer's note for a new session (no play, made or checked by the engine). */
export const NEW_SESSION_NOTE = "new session: full resources, no play (dnd5 library)";
export const LIBRARY_PROVENANCE = {
  publisher: "dnd5",
  generator: { name: LIBRARY_TOOL, version: "1" },
  notes: [] as string[],
};

/**
 * The packs of a context, in its order, as envelopes: the SRD the Table's engine serves, the others
 * from the request's pack transfers (exact id, version and hash). Unused or missing packs refuse.
 */
export async function contextPacks(
  f: Pick<EngineFacade, "servedPackFiles" | "registerPacks">,
  ctx: ContentContext,
  given: readonly { env: Envelope; ref: PackRef; files: Record<string, unknown> }[],
  where: string,
): Promise<Envelope[]> {
  const served = await f.servedPackFiles(SRD_ID);
  const srdRef = ctx.packs[0] as PackRef;
  if (srdRef.sha256 !== served.ref.sha256 || srdRef.version !== served.ref.version)
    refuse(
      "context_invalid",
      `${where}: the SRD ${srdRef.sha256.slice(0, 12)} isn't the Table's ${served.ref.sha256.slice(0, 12)}`,
    );
  const srdEnv: Envelope = {
    format: TRANSFER_FORMAT,
    kind: "pack",
    id: SRD_ID,
    revision: null,
    title: `${SRD_ID} ${served.ref.version ?? ""}`.trim(),
    sha256: served.ref.sha256,
    content: { files: served.files },
    requires: [],
    provenance: LIBRARY_PROVENANCE,
    extensions: {},
  };
  const out: Envelope[] = [];
  const byId = new Map(ctx.packs.map((p) => [p.id, p]));
  for (const ref of ctx.packs) {
    if (ref.id === SRD_ID) {
      out.push(srdEnv);
      continue;
    }
    const g = given.find(
      (x) => x.ref.id === ref.id && x.ref.sha256 === ref.sha256 && x.ref.version === ref.version,
    );
    if (!g)
      return refuse(
        "pack_missing",
        `${where}: ${ref.id}@${ref.version ?? ""} (${ref.sha256.slice(0, 12)})`,
      );
    const req = (
      (g.files["manifest.json"] as { manifest?: { requires?: string[] } }).manifest?.requires ?? []
    ).map(
      (id) => byId.get(id) ?? refuse("dependency_missing", `${where}: ${ref.id} requires ${id}`),
    );
    out.push(copyPackEnvelope(g.env, req));
  }
  await f.registerPacks(
    out
      .filter((e) => e.id !== SRD_ID)
      .map((e) => (e.content as { files: Record<string, unknown> }).files),
  );
  return out;
}

/**
 * §9.2 `new_session` with a state: as a new session starts — HP at its maximum (`null`, or exactly
 * the engine's derived maximum `hpMax`; kept as supplied), no temporary HP, nothing spent, used or
 * going on. kenli F-011 T09 correction (review R03-13): an explicit full HP is fresh too.
 */
export function checkFresh(state: CharacterState, where: string, hpMax: number): void {
  const s = state as unknown as Record<string, unknown>;
  const zeroValues = (v: unknown) => !isObj(v) || Object.values(v).every((x) => x === 0);
  const hp = s.hp as { current: number | null; temp: number } | undefined;
  const problems: string[] = [];
  if (hp && hp.current !== null && hp.current !== hpMax)
    problems.push(`hp.current ${hp.current} (a new session has full HP: null or ${hpMax})`);
  if (hp && hp.temp !== 0) problems.push("temporary HP");
  if (Array.isArray(s.spell_slots_spent) && s.spell_slots_spent.some((x) => x !== 0))
    problems.push("spent slots");
  if (typeof s.pact_slots_spent === "number" && s.pact_slots_spent !== 0)
    problems.push("spent pact slots");
  if (!zeroValues(s.uses_spent)) problems.push("spent uses");
  if (!zeroValues(s.hit_dice_spent)) problems.push("spent Hit Dice");
  if (Array.isArray(s.conditions) && s.conditions.length) problems.push("conditions");
  if (typeof s.exhaustion === "number" && s.exhaustion !== 0) problems.push("exhaustion");
  if (s.concentration !== null && s.concentration !== undefined) problems.push("concentration");
  if (Array.isArray(s.active) && s.active.length) problems.push("active effects");
  const ds = s.death_saves as { successes: number; failures: number } | undefined;
  if (ds && (ds.successes || ds.failures)) problems.push("death saves");
  if (s.dead === true || s.stable === true) problems.push("dead or stable");
  if (problems.length) refuse("state_not_fresh", `${where}: ${problems.join(", ")}`);
}

/** The build and state as the Table's engine reads them (nothing dropped), the state made or checked. */
async function characterDocs(
  f: EngineFacade,
  c: CharacterInput,
  where: string,
): Promise<{ build: CharacterBuild; state: CharacterState }> {
  const checked = await checkCharacterWith(f, c.build, c.state, c.context);
  const first = checked.problems[0];
  if (first) refuse(first.code, `${where}: ${first.detail}`);
  const build = checked.build ?? refuse("build_invalid", `${where}: the engine read nothing`);
  let state: CharacterState;
  if (c.state === null) state = await f.createState(build, c.context);
  else {
    state = checked.state ?? refuse("state_invalid", `${where}: the engine read nothing`);
    if (c.state_origin.kind === "new_session")
      checkFresh(state, where, (await f.playSheet(build, state, c.context)).sheet.play.hp.max);
  }
  return { build: json(build), state: json(state) };
}

const libraryInstallation = async (slug: string) =>
  `i${(await sha256Hex(new TextEncoder().encode(`dnd5-library:${slug}`))).slice(0, 16)}`;

/**
 * §9.1 `character-copy`: the full copy, as the app's export writes it (`JSON.stringify`), checked
 * by the same codec as an import (structure, provenance, the portrait's header, the engine).
 */
export async function makeCharacterCopy(
  f: EngineFacade,
  req: Request,
  given: readonly { env: Envelope; ref: PackRef; files: Record<string, unknown> }[],
  producer: Producer,
  portrait: CopyPortrait | null,
): Promise<{ copy: LocalCopy; text: string }> {
  const c = req.character as CharacterInput;
  const packs = await contextPacks(f, c.context, given, "character");
  const { build, state } = await characterDocs(f, c, "character");
  const exported = c.state_origin.kind === "exported";
  const history: CopyHistory =
    exported && c.history
      ? json(c.history)
      : { schema: HISTORY_CONTAINER, entry_count: 0, meta: null, entries: [] };
  const recordId = `c-${c.slug}`;
  const stateOrigin: CopyStateOrigin =
    c.state_origin.kind === "synthetic"
      ? { kind: "synthetic", fixture: c.state_origin.fixture }
      : { kind: c.state_origin.kind };
  const payload: Payload = {
    source: {
      installation_id: await libraryInstallation(c.slug),
      record_id: recordId,
      record_rev: c.revision?.seq ?? 1,
      record_gen: 0,
      history_rev: history.meta?.rev ?? 0,
      exported_at: c.exported_at,
      release_id: null,
      legacy_context: null,
      producer: {
        kind: "library",
        tool: LIBRARY_TOOL,
        slug: c.slug,
        id: c.id,
        revision: c.revision === null ? null : json(c.revision),
        label: c.label ?? null,
        table_commit: producer.table_commit,
        engine_commit: producer.engine_commit,
      },
    },
    character: {
      name:
        typeof (build as { name?: unknown }).name === "string"
          ? (build as { name: string }).name
          : "",
      build: build as unknown as Record<string, unknown>,
      state: state as unknown as Record<string, unknown>,
      state_origin: stateOrigin,
      context: json(c.context),
      origin: null,
      portrait,
      // kenli F-002 T07: a library character follows no plan (`/3`, `null`).
      progression: null,
    },
    history,
    external: externalOf(history, recordId),
    packs,
  };
  const copy: LocalCopy = {
    format: LOCAL_COPY_FORMAT,
    payload_sha256: await contentSha(payload),
    payload,
  };
  const text = JSON.stringify(copy);
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength > CLI_LIMITS.copyBytes) refuse("limit_copy_bytes", `${bytes.byteLength}`);
  // The same checks as an import (no image decoder here: the portrait's header, §2.2 steps 1–7).
  const checked = await validateLocalCopyWith(bytes, { engine: f, portraitDecode: "header-only" });
  if (!checked.ok) refuse(checked.code, checked.detail);
  return { copy, text };
}

/** A portrait file's bytes as a copy carries them (§2.2 steps 1–7 through the codec). */
export function portraitOfBytes(bytes: Uint8Array): CopyPortrait {
  const b64 = Buffer.from(bytes).toString("base64");
  const mime = sniff(bytes);
  const p: CopyPortrait = { mime, bytes: bytes.byteLength, base64: b64 };
  checkPortrait(p);
  return p;
}
function sniff(b: Uint8Array): CopyPortrait["mime"] {
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8) return "image/jpeg";
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57)
    return "image/webp";
  return refuse("portrait_unsupported", "not JPEG, PNG or WebP");
}

/** §9.1 `encounter-transfer`: the encounter and its party as internal `transfer/1` characters. */
export async function makeEncounterTransfer(
  f: EngineFacade,
  req: Request,
  given: readonly { env: Envelope; ref: PackRef; files: Record<string, unknown> }[],
): Promise<{
  format: typeof RESULT_FORMAT;
  mode: "encounter-transfer";
  root: Envelope;
  characters: Envelope[];
}> {
  const e = req.encounter as EncounterInput;
  await contextPacks(f, e.world, given, "encounter.world");
  const characters: Envelope[] = [];
  const party: Record<
    string,
    { build: CharacterBuild; state: CharacterState; content: ContentContext }
  > = {};
  const refs: { key: string; character: { id: string; revision: Revision; sha256: string } }[] = [];
  for (const [i, m] of e.party.entries()) {
    const c = m.character;
    const where = `encounter.party.${i}`;
    await contextPacks(f, c.context, given, where);
    const { build, state } = await characterDocs(f, c, where);
    const content = {
      build,
      state,
      // A transfer/1 character's origin (F-008): `synthetic`, `exported` (with a note) or `none`
      // (no state at all). A new session's state is the engine's own, with no play: said so in an
      // `exported` note, never as a played session (R03-13).
      state_origin:
        c.state_origin.kind === "synthetic"
          ? { kind: "synthetic", fixture: c.state_origin.fixture }
          : c.state_origin.kind === "new_session"
            ? { kind: "exported", note: NEW_SESSION_NOTE }
            : json(c.state_origin),
      context: json(c.context),
    };
    const env: Envelope = {
      format: TRANSFER_FORMAT,
      kind: "character",
      id: c.id,
      revision: c.revision === null ? null : json(c.revision),
      title: c.title,
      sha256: await contentSha(content),
      content,
      requires: c.context.packs.map(packDep),
      provenance: LIBRARY_PROVENANCE,
      extensions: {},
    };
    characters.push(env);
    party[m.key] = { build, state, content: c.context };
    refs.push({
      key: m.key,
      character: { id: env.id, revision: env.revision, sha256: env.sha256 },
    });
  }
  let encounter: Encounter;
  if (e.from.kind === "setup") {
    encounter = await f.newEncounter({ decisions: e.from.decisions });
    const done = await f.applyEncounterAction(
      encounter,
      party,
      e.from.actions as unknown as EncounterAction[],
      e.world,
    );
    if (!done.ok) refuse("encounter_invalid", `setup: ${done.reasons.join("; ")}`);
    encounter = (done as { encounter: Encounter }).encounter;
  } else {
    const parsed = await f.parseEncounter(e.from.document);
    if (!parsed.ok) refuse("encounter_invalid", parsed.reasons.join("; "));
    encounter = (parsed as { encounter: Encounter }).encounter;
    if (canonicalJson(encounter) !== canonicalJson(e.from.document))
      refuse("encounter_invalid", "the engine would read the encounter differently");
  }
  const enc = json(encounter);
  const used = characterKeysOf(enc);
  for (const k of used) if (!Object.hasOwn(party, k)) refuse("party_unmapped_key", k);
  for (const k of Object.keys(party)) if (!used.includes(k)) refuse("party_extra_entry", k);
  const content = { name: e.name, encounter: enc, world: json(e.world), party: refs };
  const root: Envelope = {
    format: TRANSFER_FORMAT,
    kind: "encounter",
    id: e.id,
    revision: e.revision === null ? null : json(e.revision),
    title: e.title,
    sha256: await contentSha(content),
    content,
    requires: [
      ...e.world.packs.map(packDep),
      ...characters.map((c) => ({
        kind: "character" as const,
        id: c.id,
        revision: c.revision,
        sha256: c.sha256,
        href: null,
        bytes_sha256: null,
      })),
    ],
    provenance: LIBRARY_PROVENANCE,
    extensions: {},
  };
  return { format: RESULT_FORMAT, mode: "encounter-transfer", root, characters };
}

/** Combatants' character keys plus a pending `add_character` (F-008 contract §2.3). */
function characterKeysOf(encounter: unknown): string[] {
  const enc = encounter as {
    combatants?: { character?: string | null }[];
    pending?: { action?: { type?: string; character?: string } } | null;
  };
  const out = (enc.combatants ?? []).map((c) => c.character).filter((k): k is string => !!k);
  const p = enc.pending?.action;
  if (p?.type === "add_character" && typeof p.character === "string") out.push(p.character);
  return [...new Set(out)];
}

export { Refusal };
