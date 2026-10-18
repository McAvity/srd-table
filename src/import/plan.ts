/**
 * The import preview (kenli F-008 contract §5.4, §6): every node of the graph validated by the
 * engine on its own content (the F-004 checks: nothing dropped, the build valid, the state valid
 * and unchanged by `reconcileState`), what's already here (identical, changed, older, unknown
 * order), the decisions to make and what blocks the import. Nothing is written.
 */

import type { CharacterBuild, CharacterState, Encounter } from "srd-rules-engine";
import { engine } from "@/engine/client";
import { type ContentContext, canonicalJson, contextKey, type PackRef } from "@/lib/canonical";
import { changedFields, droppedFields, isStateFile, pairCharacterFiles } from "@/lib/files";
import type { RecordOrigin } from "@/persistence/db";
import { type CharacterRecord, characterKeysOf, type EncounterRecord } from "@/store/documents";
import type { Graph, GraphNode, LocalMatch } from "./resolve";
import { type Envelope, type PartyRef, packOfEnvelope, type Revision } from "./transfer";

/** A problem of one document: the contract's code and the engine's or app's words. */
export interface Problem {
  readonly code: string;
  readonly detail: string;
}

/** How a local record relates to an imported character (contract §6.4). */
export type Relation =
  | "unchanged" // same import, nothing changed since
  | "changed-locally" // same import, played or edited since
  | "older" // the import is an older revision of the same source id
  | "newer"
  | "unknown-order";

export interface Candidate {
  readonly recordId: string;
  readonly name: string;
  readonly rev: number;
  readonly relation: Relation;
}

export interface PlanCharacter {
  readonly key: string;
  readonly title: string;
  readonly sourceId: string | null;
  readonly revision: Revision;
  readonly sha256: string | null;
  readonly bytes_sha256: string | null;
  readonly source:
    | { readonly url: string }
    | { readonly file: string }
    | { readonly local: string };
  /** Parsed documents (null when they didn't pass). */
  readonly build: CharacterBuild | null;
  readonly state: CharacterState | null;
  /** `null` content: the campaign's packs (a raw file the user put on them). */
  readonly content: ContentContext | null;
  readonly stateOrigin: string;
  readonly buildOnly: boolean;
  /** The encounter party key, when it's a party member. */
  readonly partyKey: string | null;
  readonly candidates: readonly Candidate[];
  readonly local: LocalMatch | null;
  readonly extensions: Readonly<Record<string, unknown>>;
  readonly problems: readonly Problem[];
}

export interface PlanEncounter {
  readonly key: string;
  readonly title: string;
  readonly sourceId: string | null;
  readonly revision: Revision;
  readonly sha256: string | null;
  readonly bytes_sha256: string | null;
  readonly source: { readonly url: string } | { readonly file: string };
  readonly encounter: Encounter | null;
  /** `null` world: the campaign's packs. */
  readonly world: ContentContext | null;
  readonly partyKeys: readonly string[];
  readonly extensions: Readonly<Record<string, unknown>>;
  readonly problems: readonly Problem[];
}

export interface PlanPack {
  readonly key: string;
  readonly ref: PackRef;
  readonly envelope: Envelope;
  readonly bytes_sha256: string | null;
  readonly source: { readonly url: string } | { readonly file: string };
  readonly problems: readonly Problem[];
}

export interface Plan {
  readonly raw: boolean;
  readonly packs: readonly PlanPack[];
  readonly characters: readonly PlanCharacter[];
  readonly encounter: PlanEncounter | null;
  /** Packs already here (served with the app, or installed). */
  readonly present: readonly { readonly ref: PackRef; readonly by: "served" | "installed" }[];
  /** Every record's revision when the preview was made (compare-and-set at commit). */
  readonly revs: Readonly<Record<string, number>>;
  readonly problems: readonly Problem[];
}

export type CharacterChoice =
  | { readonly kind: "new"; readonly initialize?: boolean }
  /** `confirmed`: the second confirmation after the field-by-field preview (§6.4). */
  | { readonly kind: "replace"; readonly target: string; readonly confirmed?: boolean }
  | { readonly kind: "use"; readonly target: string }
  | { readonly kind: "skip" };
export type EncounterChoice =
  | { readonly kind: "new" }
  | { readonly kind: "replace"; readonly target: string; readonly confirmed?: boolean };

export interface Decisions {
  readonly characters: Readonly<Record<string, CharacterChoice>>;
  readonly encounter?: EncounterChoice;
  /** Raw files: the content they play with (`campaign`: the Settings' packs, as before). */
  readonly rawContent?: "campaign" | ContentContext;
}

export interface Records {
  readonly characters: Readonly<Record<string, CharacterRecord>>;
  readonly encounters: Readonly<Record<string, EncounterRecord>>;
}

const problem = (code: string, detail = ""): Problem => ({ code, detail });

/** The F-004 checks on a character's documents, on its own content (contract §5.4). */
export async function checkCharacter(
  rawBuild: unknown,
  rawState: unknown | null,
  content: ContentContext | null,
): Promise<{ build: CharacterBuild | null; state: CharacterState | null; problems: Problem[] }> {
  const ctx = content ?? undefined;
  const problems: Problem[] = [];
  if (content) {
    const ok = await engine().checkContent(content);
    if (!ok.ok)
      return {
        build: null,
        state: null,
        problems: [problem(contextCode(ok.reasons), ok.reasons.join("; "))],
      };
  }
  const parsed = await engine().parseBuild(rawBuild);
  if (!parsed.ok)
    return {
      build: null,
      state: null,
      problems: [problem("build_invalid", parsed.reasons.join("; "))],
    };
  const lostBuild = droppedFields(rawBuild, parsed.build);
  if (lostBuild.length) problems.push(problem("fields_dropped", lostBuild.join(", ")));
  const view = await engine().evaluate(parsed.build, ctx);
  const buildErrors = view.report.issues.filter((i) => i.severity === "error");
  if (buildErrors.length)
    problems.push(problem("build_invalid", buildErrors.map((i) => i.message).join("; ")));
  if (rawState === null || problems.length) return { build: parsed.build, state: null, problems };
  const ps = await engine().parseState(rawState);
  if (!ps.ok)
    return {
      build: parsed.build,
      state: null,
      problems: [problem("state_invalid", ps.reasons.join("; "))],
    };
  const lostState = droppedFields(rawState, ps.state);
  if (lostState.length) problems.push(problem("fields_dropped", lostState.join(", ")));
  const stateErrors = (await engine().validateState(parsed.build, ps.state, ctx)).filter(
    (i) => i.severity === "error",
  );
  if (stateErrors.length)
    problems.push(problem("state_invalid", stateErrors.map((i) => i.message).join("; ")));
  if (!problems.length) {
    const fitted = await engine().reconcileState(parsed.build, ps.state, ctx);
    const changed = changedFields(ps.state, fitted.state);
    if (changed.length) problems.push(problem("state_would_change", changed.join(", ")));
  }
  return { build: parsed.build, state: ps.state, problems };
}

const contextCode = (reasons: readonly string[]) =>
  reasons.some((r) => r.includes("context_unavailable"))
    ? "context_unavailable"
    : "context_invalid";

/** Local records that came from the same source id, and how they relate (§6.4). */
function candidatesFor(
  sourceId: string | null,
  revision: Revision,
  sha256: string | null,
  docs: { build: unknown; state: unknown } | null,
  records: Records,
): Candidate[] {
  if (!sourceId) return [];
  const out: Candidate[] = [];
  for (const r of Object.values(records.characters)) {
    const o = r.origin;
    if (o?.kind !== "import" || o.id !== sourceId) continue;
    let relation: Relation;
    if (o.sha256 === sha256) {
      relation =
        docs && canonicalJson([r.build, r.state]) === canonicalJson([docs.build, docs.state])
          ? "unchanged"
          : "changed-locally";
    } else if (o.revision && revision) {
      relation =
        revision.seq < o.revision.seq
          ? "older"
          : revision.seq > o.revision.seq
            ? "newer"
            : "unknown-order";
    } else relation = "unknown-order";
    out.push({ recordId: r.id, name: r.build.name || r.id, rev: r.rev ?? 0, relation });
  }
  return out;
}

const revsOf = (records: Records) =>
  Object.fromEntries([
    ...Object.values(records.characters).map((r) => [r.id, r.rev ?? 0] as const),
    ...Object.values(records.encounters).map((r) => [r.id, r.rev ?? 0] as const),
  ]);

/** The preview of a transfer graph. Packs of the graph are registered in the worker (memory only). */
export async function planTransfer(
  graph: Extract<Graph, { kind: "transfer" }>,
  records: Records,
): Promise<Plan> {
  const problems: Problem[] = [];
  const packNodes = graph.nodes.filter((n) => n.envelope.kind === "pack");
  // In memory, by hash, for validation: not installed, no document uses them yet.
  if (packNodes.length)
    await engine().registerPacks(packNodes.map((n) => n.envelope.content.files as never));
  const packs: PlanPack[] = [];
  for (const n of packNodes) {
    const ref = packOfEnvelope(n.envelope);
    const deps = n.envelope.requires.map((d) => ({
      id: d.id,
      version: d.version ?? null,
      sha256: d.sha256,
    }));
    const ok = await engine().checkContent({ packs: [...deps, ref], sources: null });
    packs.push({
      key: n.key,
      ref,
      envelope: n.envelope,
      bytes_sha256: n.bytes_sha256,
      source: n.source,
      problems: ok.ok ? [] : [problem("pack_invalid", ok.reasons.join("; "))],
    });
  }
  const encNode = graph.nodes.find((n) => n.envelope.kind === "encounter") ?? null;
  const party = encNode ? ((encNode.envelope.content.party as PartyRef[]) ?? []) : [];
  const partyKeyOf = (sha: string) => party.find((p) => p.character.sha256 === sha)?.key ?? null;

  const characters: PlanCharacter[] = [];
  for (const n of graph.nodes.filter((x) => x.envelope.kind === "character")) {
    characters.push(await planCharacterNode(n, partyKeyOf(n.envelope.sha256), records));
  }
  for (const m of graph.local) {
    const record = records.characters[m.recordId];
    characters.push({
      key: m.key,
      title: record?.build.name || m.recordId,
      sourceId: m.ref.id,
      revision: m.ref.revision ?? null,
      sha256: m.ref.sha256,
      bytes_sha256: null,
      source: { local: m.recordId },
      build: record?.build ?? null,
      state: record?.state ?? null,
      content: record?.content ?? null,
      stateOrigin: "local",
      buildOnly: false,
      partyKey: partyKeyOf(m.ref.sha256),
      candidates: [],
      local: m,
      extensions: {},
      problems: [],
    });
  }
  let encounter: PlanEncounter | null = null;
  if (encNode)
    encounter = await planEncounterNode(
      encNode,
      party.map((p) => p.key),
    );
  return {
    raw: false,
    packs,
    characters,
    encounter,
    present: graph.satisfied,
    revs: revsOf(records),
    problems,
  };
}

async function planCharacterNode(
  n: GraphNode,
  partyKey: string | null,
  records: Records,
): Promise<PlanCharacter> {
  const c = n.envelope.content as {
    build: unknown;
    state: unknown | null;
    state_origin: { kind: string; fixture?: string };
    context: ContentContext;
  };
  const checked = await checkCharacter(c.build, c.state, c.context);
  const origin =
    c.state_origin.kind === "synthetic"
      ? `synthetic${c.state_origin.fixture ? `:${c.state_origin.fixture}` : ""}`
      : c.state_origin.kind;
  return {
    key: n.key,
    title: n.envelope.title,
    sourceId: n.envelope.id,
    revision: n.envelope.revision,
    sha256: n.envelope.sha256,
    bytes_sha256: n.bytes_sha256,
    source: n.source,
    build: checked.build,
    state: checked.state,
    content: c.context,
    stateOrigin: origin,
    buildOnly: c.state === null,
    partyKey,
    candidates: candidatesFor(
      n.envelope.id,
      n.envelope.revision,
      n.envelope.sha256,
      checked.build ? { build: checked.build, state: checked.state } : null,
      records,
    ),
    local: null,
    extensions: n.envelope.extensions,
    problems: checked.problems,
  };
}

async function planEncounterNode(n: GraphNode, partyKeys: string[]): Promise<PlanEncounter> {
  const c = n.envelope.content as { name: string; encounter: unknown; world: ContentContext };
  const problems: Problem[] = [];
  let encounter: Encounter | null = null;
  const world = await engine().checkContent(c.world);
  if (!world.ok) problems.push(problem(contextCode(world.reasons), world.reasons.join("; ")));
  const parsed = await engine().parseEncounter(c.encounter);
  if (!parsed.ok) problems.push(problem("encounter_invalid", parsed.reasons.join("; ")));
  else {
    const lost = droppedFields(c.encounter, parsed.encounter);
    if (lost.length) problems.push(problem("fields_dropped", lost.join(", ")));
    encounter = parsed.encounter;
  }
  return {
    key: n.key,
    title: c.name || n.envelope.title,
    sourceId: n.envelope.id,
    revision: n.envelope.revision,
    sha256: n.envelope.sha256,
    bytes_sha256: n.bytes_sha256,
    source: n.source,
    encounter,
    world: c.world,
    partyKeys,
    extensions: n.envelope.extensions,
    problems,
  };
}

/** What a raw file is (contract §4.2): the one engine kind that keeps every field. */
export async function rawKind(value: unknown): Promise<"build" | "state" | "encounter" | Problem> {
  if (typeof value !== "object" || value === null || Object.keys(value).length === 0)
    return problem("format_ambiguous");
  const fits: ("build" | "state" | "encounter")[] = [];
  const b = await engine().parseBuild(value);
  if (b.ok && droppedFields(value, b.build).length === 0) fits.push("build");
  const s = await engine().parseState(value);
  if (s.ok && droppedFields(value, s.state).length === 0) fits.push("state");
  const e = await engine().parseEncounter(value);
  if (e.ok && droppedFields(value, e.encounter).length === 0) fits.push("encounter");
  if (fits.length === 1) return fits[0] as "build" | "state" | "encounter";
  return problem(fits.length ? "format_ambiguous" : "format_unknown");
}

/**
 * Raw files (no envelope, no identity): builds paired with `.state.json` by name (as before), or
 * one encounter. They need an explicit content (`Decisions.rawContent`) and, for an encounter, an
 * explicit local character for every key; nothing is matched by name.
 */
export async function planRaw(
  graph: Extract<Graph, { kind: "raw" }>,
  records: Records,
  content: "campaign" | ContentContext | null,
): Promise<Plan> {
  const problems: Problem[] = [];
  const characters: PlanCharacter[] = [];
  let encounter: PlanEncounter | null = null;
  const kinds = await Promise.all(graph.files.map((f) => rawKind(f.value)));
  for (const [i, k] of kinds.entries())
    if (typeof k !== "string") problems.push(problem(k.code, graph.files[i]?.name ?? ""));
  const ctx = content === "campaign" || content === null ? null : content;
  const encounters = graph.files.filter((_, i) => kinds[i] === "encounter");
  const docs = graph.files.filter((_, i) => kinds[i] === "build" || kinds[i] === "state");
  if (encounters.length > 1 || (encounters.length && docs.length))
    problems.push(problem("several_roots"));
  for (const [i, f] of docs.entries()) {
    const kind = kinds[graph.files.indexOf(f)];
    if (kind === "state" && !isStateFile(f.name))
      problems.push(problem("format_ambiguous", `${f.name}: a play state needs its build`));
    void i;
  }
  for (const { build, state } of pairCharacterFiles(
    docs.map((f) => ({ name: f.name, data: f.value })),
  )) {
    const checked =
      content === null
        ? { build: null, state: null, problems: [problem("context_choice_required")] }
        : await checkCharacter(build.data, state?.data ?? null, ctx);
    characters.push({
      key: `raw:${build.name}`,
      title: checked.build?.name || build.name,
      sourceId: null,
      revision: null,
      sha256: null,
      bytes_sha256: null,
      source: { file: build.name },
      build: checked.build,
      state: checked.state,
      content: ctx,
      stateOrigin: state ? "file" : "none",
      buildOnly: !state,
      partyKey: null,
      candidates: [],
      local: null,
      extensions: {},
      problems: checked.problems,
    });
  }
  const enc = encounters[0];
  if (enc) {
    const parsed = await engine().parseEncounter(enc.value);
    const ps: Problem[] = [];
    if (content === null) ps.push(problem("context_choice_required"));
    if (ctx) {
      const w = await engine().checkContent(ctx);
      if (!w.ok) ps.push(problem(contextCode(w.reasons), w.reasons.join("; ")));
    }
    if (!parsed.ok) ps.push(problem("encounter_invalid", parsed.reasons.join("; ")));
    encounter = {
      key: `raw:${enc.name}`,
      title: enc.name.replace(/\.json$/i, ""),
      sourceId: null,
      revision: null,
      sha256: null,
      bytes_sha256: null,
      source: { file: enc.name },
      encounter: parsed.ok ? parsed.encounter : null,
      world: ctx,
      partyKeys: parsed.ok ? characterKeysOf(parsed.encounter) : [],
      extensions: {},
      problems: ps,
    };
  }
  return {
    raw: true,
    packs: [],
    characters,
    encounter,
    present: [],
    revs: revsOf(records),
    problems,
  };
}

/** What still blocks the commit with these decisions (empty: it may be confirmed). */
export function blockers(plan: Plan, decisions: Decisions, records: Records): Problem[] {
  const out: Problem[] = [...plan.problems];
  for (const p of plan.packs) out.push(...p.problems);
  for (const c of plan.characters) {
    out.push(...c.problems);
    const choice = decisions.characters[c.key] ?? defaultChoice(c);
    if (!choice) {
      out.push(
        problem(c.local?.changed ? "dependency_changed_locally" : "decision_required", c.title),
      );
      continue;
    }
    if (choice.kind === "new" && c.buildOnly && !choice.initialize)
      out.push(problem("initialize_required", c.title));
    if (choice.kind === "replace") {
      const target = records.characters[choice.target];
      if (!target) out.push(problem("target_missing", choice.target));
      if (c.buildOnly) out.push(problem("build_only_replace", c.title));
      if (!choice.confirmed) out.push(problem("replace_confirm_required", c.title));
    }
    if (choice.kind === "use" && !records.characters[choice.target])
      out.push(problem("target_missing", choice.target));
    if (
      choice.kind === "skip" &&
      (c.partyKey || !c.candidates.some((x) => x.relation === "unchanged"))
    )
      out.push(problem("decision_required", c.title));
    if (choice.kind === "use" && !c.partyKey) out.push(problem("decision_required", c.title));
  }
  if (plan.encounter) {
    out.push(...plan.encounter.problems);
    const choice = decisions.encounter ?? { kind: "new" };
    if (choice.kind === "replace" && !records.encounters[choice.target])
      out.push(problem("target_missing", choice.target));
    if (choice.kind === "replace" && !choice.confirmed)
      out.push(problem("replace_confirm_required", plan.encounter.title));
    if (plan.raw)
      for (const key of plan.encounter.partyKeys) {
        const choice = decisions.characters[`raw-key:${key}`];
        if (choice?.kind !== "use" || !records.characters[choice.target])
          out.push(problem("party_unmapped_key", key));
      }
  }
  return out;
}

/** The default choice of a character, or `null` when the user must decide. */
export function defaultChoice(c: PlanCharacter): CharacterChoice | null {
  if (c.local) return c.local.changed ? null : { kind: "use", target: c.local.recordId };
  if (c.buildOnly) return null; // Q-03: a new character only after an explicit initialization
  if (!c.partyKey && c.candidates.some((x) => x.relation === "unchanged")) return { kind: "skip" };
  return { kind: "new" };
}

/** Other encounters that refer to a record (a replacement warns about them). */
export function referencedBy(recordId: string, records: Records): string[] {
  return Object.values(records.encounters)
    .filter((e) => characterKeysOf(e.encounter).includes(recordId))
    .map((e) => e.name);
}

/** A record's import origin for a plan node. */
export function originOf(
  node: {
    sourceId: string | null;
    revision: Revision;
    sha256: string | null;
    bytes_sha256: string | null;
    source: PlanCharacter["source"] | PlanEncounter["source"];
    extensions: Readonly<Record<string, unknown>>;
  },
  stateOrigin?: string,
): RecordOrigin {
  const source =
    "url" in node.source
      ? { url: node.source.url }
      : { file: "file" in node.source ? node.source.file : node.source.local };
  return {
    kind: "import",
    id: node.sourceId,
    revision: node.revision,
    sha256: node.sha256,
    bytes_sha256: node.bytes_sha256,
    source,
    imported_at: Date.now(),
    ...(stateOrigin ? { state_origin: stateOrigin } : {}),
    ...(Object.keys(node.extensions).length ? { extensions: node.extensions } : {}),
  };
}

export const contentLabel = (content: ContentContext | null) =>
  content ? content.packs.map((p) => `${p.id} ${p.version ?? ""}`.trim()).join(" + ") : null;
export const sameContent = (
  a: ContentContext | null | undefined,
  b: ContentContext | null | undefined,
) => (a ? contextKey(a) : null) === (b ? contextKey(b) : null);
